/**
 * brain-client — the only thing in eval/ that touches the network.
 *
 * Every request is a GET. The eval must never be able to change a brain it is
 * measuring, because the moment it can, a bad run stops being a bad number and
 * starts being an incident in a client's account.
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

  async #get(path) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(this.base + path, {
          headers: { "X-Admin-Key": this.key, "User-Agent": BROWSER_UA },
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
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
        }
      } catch (e) {
        lastErr = e;
        if (e.name === "AbortError") lastErr = new Error(`timed out after ${this.timeoutMs}ms`);
        if (attempt === this.retries) break;
        await sleep(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /**
   * Ordered retrieval results for one question.
   *
   * `variant` names the retrieval configuration under test. It is recorded in
   * the run output so a saved baseline can never be compared against a run made
   * with different settings without it being obvious.
   */
  async retrieve(question, { limit = 10, rerank = false, graphBoost = false } = {}) {
    const qs = new URLSearchParams({
      q: question,
      limit: String(limit),
      rerank: rerank ? "1" : "0",
      graph_boost: graphBoost ? "1" : "0",
      // Bust the edge cache on every request.
      //
      // Both brains cache this endpoint for 120 seconds, keyed by URL. Without
      // this, --repeat re-read ONE cached response N times and reported a noise
      // floor of 0.0, which is what a cache looks like and not what the system
      // does. Verified 2026-08-22: with the cache busted and the reranker on,
      // 3 of 4 identical requests returned a different ranking. The reranker is
      // an LLM and is not deterministic; the cache was hiding that completely.
      _cb: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    const body = await this.#get(`/api/rag/unified?${qs}`);
    return Array.isArray(body?.results) ? body.results : [];
  }

  /** Cited answer plus the gap list. Used only for the unanswerable questions. */
  async think(question, { limit = 8 } = {}) {
    const qs = new URLSearchParams({
      q: question,
      limit: String(limit),
      _cb: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    return this.#get(`/api/rag/think?${qs}`);
  }

  async health() {
    const res = await this.fetch(`${this.base}/health`, { headers: { "User-Agent": BROWSER_UA } });
    return { status: res.status, ok: res.ok };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
