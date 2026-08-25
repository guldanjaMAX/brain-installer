/**
 * brain-client — the only thing in eval/ that touches the network.
 *
 * Every endpoint is read-only. Private questions use POST bodies so they never
 * enter URLs, while corpus inventory remains GET. The eval must never be able
 * to change a brain it is measuring.
 *
 * Two details that are load bearing rather than decorative:
 *
 *   A browser User-Agent is sent on every call. Cloudflare bot protection in
 *   front of a brain returns 403 error code 1010 to library default agents, and
 *   the failure presents as a broken install rather than as a blocked client.
 *
 *   Retrieval parameters are PINNED rather than defaulted. A brain whose
 *   reranker or graph boost is on by default gives a different ranking on every
 *   call, and an eval that cannot reproduce its own number cannot prove that a
 *   change helped. Variants are opted into explicitly so the difference between
 *   two configurations is the thing being measured.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class BrainClient {
  constructor({ base, adminKey, timeoutMs = 30000, retries = 2, fetchImpl = fetch }) {
    this.base = String(base).replace(/\/+$/, "");
    this.key = adminKey;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
  }

  async #request(path, { method = "GET", body } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(this.base + path, {
          method,
          headers: {
            "X-Admin-Key": this.key,
            "User-Agent": BROWSER_UA,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          // A 5xx or a rate limit is worth another try; a 401 or a 404 will
          // never become a 200 and retrying only makes the run slower.
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(`HTTP ${res.status}`);
            await sleep(400 * (attempt + 1));
            continue;
          }
          const error = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          error.retryable = false;
          throw error;
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
        }
      } catch (e) {
        lastErr = e;
        if (e.name === "AbortError") lastErr = new Error(`timed out after ${this.timeoutMs}ms`);
        if (e.retryable === false) throw e;
        if (attempt === this.retries) break;
        await sleep(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async #get(path) {
    return this.#request(path);
  }

  async #post(path, body) {
    return this.#request(path, { method: "POST", body });
  }

  /**
   * Ordered retrieval results for one question.
   *
   * `variant` names the retrieval configuration under test. It is recorded in
   * the run output so a saved baseline can never be compared against a run made
   * with different settings without it being obvious.
   */
  async retrieve(question, { limit = 10, rerank = false, graphBoost = false } = {}) {
    const body = {
      q: question,
      limit,
      rerank: rerank ? 1 : 0,
      graph_boost: graphBoost ? 1 : 0,
    };
    const response = await this.#post("/api/rag/unified", body);
    return Array.isArray(response?.results) ? response.results : [];
  }

  /** Cited answer plus the gap list. Used only for the unanswerable questions. */
  async think(question, { limit = 8 } = {}) {
    return this.#post("/api/rag/think", { q: question, limit });
  }

  /** Authenticated corpus inventory used to make saved baselines reproducible. */
  async documents() {
    return this.#get(`/api/admin/brain/documents?_cb=${Date.now()}`);
  }

  async health() {
    const res = await this.fetch(`${this.base}/health?_cb=${Date.now()}`, {
      headers: { "User-Agent": BROWSER_UA },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Reachability is still useful when an older Worker does not return JSON.
    }
    return {
      status: res.status,
      ok: res.ok,
      version: body?.version ?? null,
      brain: body?.brain ?? null,
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
