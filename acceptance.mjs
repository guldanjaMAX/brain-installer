/**
 * acceptance — prove a live brain install actually works.
 *
 * Run against ANY install, at any time, by anyone holding the admin key:
 *
 *   brain test <manifest>
 *
 * This is deliberately two things at once.
 *
 * As a TEST it is the gate on an install and on every upgrade: it is what
 * turns "deployed" into "working", and an upgrade that has not passed it is a
 * belief rather than a release.
 *
 * As a PRODUCT FEATURE it is the artifact a client can run themselves, on
 * their own infrastructure, without asking us anything. That matters more than
 * it sounds: the whole promise is that they own this. An install they cannot
 * independently verify is one they have to trust us about, which is exactly
 * the dependency the custody model exists to remove.
 *
 * TIERS, in dependency order. A failure in an early tier makes later tiers
 * meaningless, so the run reports which tier broke rather than dumping a wall
 * of consequential failures.
 *
 *   1 reach      is it up, is auth enforced
 *   2 data       is anything in it, is it fresh
 *   3 retrieval  does a real question return real sources
 *   4 safety     does the credential gate actually refuse
 *   5 operations schema version, migrations, spend cap
 *
 * Every check is READ-ONLY except the credential-gate probe, which attempts an
 * ingest that MUST be refused. If that probe ever succeeds, the test fails
 * loudly and the content it wrote is reported for removal.
 */

import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";

const PASS = "pass";
const FAIL = "fail";
const WARN = "warn";
const SKIP = "skip";

const CREDENTIAL_GATE_ERROR = "refused: content carries live credential(s)";
const CREDENTIAL_GATE_DETAIL =
  "Rotate them, strip them from the source, then re-ingest. Nothing was written.";

/**
 * Accept only the credential scanner's production refusal contract.
 *
 * A bare 422 can be a validation error, and a response that merely contains
 * the word "refused" can come from a proxy or an unrelated guard. Neither is
 * proof that credential-shaped content was recognized before storage.
 */
export function credentialGateRefusalVerdict({ status, text }) {
  if (status !== 422) return { accepted: false, reason: `expected HTTP 422, received ${status}` };
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    return { accepted: false, reason: "HTTP 422 did not carry JSON" };
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return { accepted: false, reason: "HTTP 422 did not carry an error object" };
  }
  if (payload.error !== CREDENTIAL_GATE_ERROR) {
    return { accepted: false, reason: "HTTP 422 was not the credential-gate error" };
  }
  if (!Array.isArray(payload.labels) || !payload.labels.includes("cloudflare_token_new")) {
    return { accepted: false, reason: "credential-gate response did not name the canary provider" };
  }
  if (payload.detail !== CREDENTIAL_GATE_DETAIL) {
    return { accepted: false, reason: "credential-gate response did not confirm that nothing was written" };
  }
  return { accepted: true, reason: "structured credential refusal confirmed" };
}

export class Acceptance {
  constructor({ base, adminKey, manifest, expectVersion = null, fetchImpl = fetch }) {
    this.base = String(base).replace(/\/+$/, "");
    this.key = adminKey;
    this.m = manifest || {};
    this.fetch = fetchImpl;
    this.expectVersion = expectVersion;
    this.results = [];
    this.tierFailed = null;
  }

  record(tier, name, status, detail) {
    this.results.push({ tier, name, status, detail });
    if (status === FAIL && this.tierFailed === null) this.tierFailed = tier;
    return status;
  }

  async request(path, { auth = true, method = "GET", body } = {}) {
    const init = {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = auth
      ? await fetchBrainWithAdminKey(this.fetch, this.base + path, init, () => this.key)
      : await this.fetch(this.base + path, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON is itself a finding */
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  async get(path, options = {}) {
    return this.request(path, options);
  }

  async post(path, body, options = {}) {
    return this.request(path, { ...options, method: "POST", body });
  }

  /* ------------------------------------------------------- tier 1: reach */

  async tierReach() {
    const t = 1;
    try {
      const h = await this.get("/health", { auth: false });
      if (!h.ok) return this.record(t, "health responds", FAIL, `HTTP ${h.status}`);
      const observedVersion = h.json?.version ?? null;
      if (this.expectVersion && observedVersion !== this.expectVersion) {
        return this.record(
          t,
          "health responds",
          FAIL,
          `expected version ${this.expectVersion}, received ${observedVersion || "none"}`,
        );
      }
      this.record(t, "health responds", PASS, `version ${observedVersion ?? "?"}`);
    } catch (e) {
      return this.record(t, "health responds", FAIL, e.message);
    }

    // Auth must actually be enforced. An install that answers without a key is
    // a public copy of the client's private records, which is the single worst
    // outcome this system can produce.
    const noKey = await this.post("/api/rag/unified", { q: "test" }, { auth: false });
    this.record(
      t,
      "unauthenticated request is refused",
      noKey.status === 401 ? PASS : FAIL,
      `HTTP ${noKey.status}${noKey.status !== 401 ? " — THE BRAIN IS ANSWERING WITHOUT A KEY" : ""}`
    );

    const badKey = await fetchBrainWithAdminKey(this.fetch, `${this.base}/api/rag/unified`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "test" }),
    }, () => "definitely-not-the-key");
    this.record(
      t,
      "wrong key is refused",
      badKey.status === 401 ? PASS : FAIL,
      `HTTP ${badKey.status}`
    );

    const good = await this.get("/api/admin/brain/documents");
    this.record(t, "correct key is accepted", good.ok ? PASS : FAIL, `HTTP ${good.status}`);
  }

  /* -------------------------------------------------------- tier 2: data */

  async tierData() {
    const t = 2;
    const docs = await this.get("/api/admin/brain/documents");
    if (!docs.ok) return this.record(t, "corpus summary", FAIL, `HTTP ${docs.status}`);

    const rows = docs.json?.rows || [];
    const total = rows.reduce((a, r) => a + Number(r.total || 0), 0);
    this.record(
      t,
      "corpus is not empty",
      total > 0 ? PASS : FAIL,
      `${total} document(s) across ${rows.length} source type(s)`
    );

    const unembedded = rows.reduce(
      (a, r) => a + (Number(r.total || 0) - Number(r.embedded || 0)),
      0
    );
    // A backlog is normal mid-ingest; a large one means the embedder is stuck,
    // and the symptom a user sees is simply "search does not find my document".
    this.record(
      t,
      "embedding backlog is small",
      unembedded === 0 ? PASS : unembedded < 1000 ? WARN : FAIL,
      `${unembedded} document(s) awaiting embedding`
    );

    const freshest = rows
      .map((r) => (r.last_ingested ? Date.parse(r.last_ingested) : NaN))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (!freshest) {
      this.record(t, "corpus freshness", WARN, "no ingest timestamps reported");
    } else {
      const days = Math.floor((Date.now() - freshest) / 864e5);
      this.record(
        t,
        "corpus is fresh",
        days <= 2 ? PASS : days <= 14 ? WARN : FAIL,
        `newest ingest ${days} day(s) ago`
      );
    }
  }

  /* --------------------------------------------------- tier 3: retrieval */

  async tierRetrieval(probes) {
    const t = 3;
    // Retrieval is proven with the CLIENT's own probe questions, not generic
    // ones. A brain that returns results for "test" but nothing for "what did
    // we agree with our biggest customer" has passed a meaningless check.
    if (!probes || !probes.length) {
      return this.record(
        t,
        "retrieval probes",
        SKIP,
        "no probe questions in the manifest (testing.probe_questions)"
      );
    }

    let answered = 0;
    for (const q of probes) {
      const r = await this.post("/api/rag/unified", { q, limit: 5, rerank: 0 });
      const n = r.json?.results?.length || 0;
      if (n > 0) answered++;
      this.record(
        t,
        `probe: ${q.slice(0, 48)}`,
        n > 0 ? PASS : FAIL,
        `${n} result(s)`
      );
    }
    this.record(
      t,
      "probe coverage",
      answered === probes.length ? PASS : answered > 0 ? WARN : FAIL,
      `${answered}/${probes.length} probes returned sources`
    );

    // `think` must degrade rather than 500. This is the path most likely to
    // break quietly, because it only fails when the LLM key, the spend cap or
    // the model name is wrong, none of which show up until someone asks a
    // question.
    const think = await this.post("/api/rag/think", { q: probes[0], limit: 5 });
    if (!think.ok) {
      this.record(t, "think endpoint", FAIL, `HTTP ${think.status}`);
    } else if (think.json?.answer) {
      const answer = think.json.answer;
      this.record(t, "think returns an answer", PASS, `${answer.length} chars`);
      // A refusal ("the documents do not answer this") correctly carries no
      // citations, because it makes no factual claim to cite. Requiring
      // markers unconditionally fails the brain for behaving honestly, which
      // is the opposite of what this check is for.
      const isRefusal =
        /\b(do(es)? not (contain|answer|address)|no (information|record|mention)|nothing (recorded|found))\b/i.test(
          answer
        );
      const cited = /\[\d+\]/.test(answer);
      if (isRefusal && !cited) {
        this.record(t, "answer citation discipline", PASS, "honest refusal, nothing to cite");
      } else {
        this.record(
          t,
          "answer carries inline citations",
          cited ? PASS : FAIL,
          cited ? "found [n] markers" : "the answer makes claims but cites nothing"
        );
      }
    } else {
      // Degradation is a pass for the endpoint and a warning for the install.
      this.record(
        t,
        "think degrades cleanly",
        PASS,
        `no answer, reason: ${think.json?.answer_error || "unknown"}`
      );
      this.record(
        t,
        "answer generation configured",
        WARN,
        think.json?.answer_error || "no answer produced"
      );
    }
    this.record(
      t,
      "gap analysis present",
      Array.isArray(think.json?.gaps) ? PASS : FAIL,
      `${think.json?.gaps?.length ?? 0} gap(s) reported`
    );
  }

  /* ------------------------------------------------------ tier 4: safety */

  async tierSafety() {
    const t = 4;
    // Synthetic, never a live key. Shaped like a real Cloudflare token so the
    // CONFIRMED tier fires.
    const canary = "cfut_" + "Kd9Xm2Pq7Rv4Tz8Ly6Wn3Bc5Hj1Gs0Ae4Uf7Yx2Mq";
    const sourceId = "acceptance/credential-gate-probe";
    const res = await fetchBrainWithAdminKey(this.fetch, `${this.base}/api/admin/brain/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "curated",
        source_id: sourceId,
        title: "acceptance probe",
        content: `Acceptance probe. Deploy with CLOUDFLARE_API_TOKEN=${canary} and it works.`,
      }),
    }, () => this.key);
    const text = await res.text();

    const gate = credentialGateRefusalVerdict({ status: res.status, text });

    if (gate.accepted) {
      this.record(t, "credential gate refuses a token", PASS, `HTTP ${res.status}, ${gate.reason}`);
    } else if (res.ok) {
      // The probe just wrote a synthetic credential into a live brain, because
      // the gate that should have stopped it is not running. There is no
      // delete endpoint to undo it with, so the only honest thing is to shout
      // the exact identifier needed to remove it by hand. A test that
      // pollutes a corpus and stays quiet about it is worse than no test.
      this.record(
        t,
        "credential gate refuses a token",
        FAIL,
        `THE GATE IS NOT ACTIVE — this probe was STORED. Remove it now:\n` +
          `        delete from brain.documents where source_type='curated' and source_id='${sourceId}';\n` +
          `        delete from public.notes_rag_documents where source_id='${sourceId}';\n` +
          `        Then deploy a build with the credential scanner enabled.`
      );
    } else {
      this.record(
        t,
        "credential gate refuses a token",
        FAIL,
        `the exact refusal contract was not observed: ${gate.reason}`,
      );
    }

    // The refusal must name the provider without quoting the secret, or the
    // error message becomes its own leak.
    if (text.includes(canary)) {
      this.record(
        t,
        "refusal does not echo the secret",
        FAIL,
        "the error response contained the credential value"
      );
    } else {
      this.record(t, "refusal does not echo the secret", PASS, "value not present in the response");
    }
  }

  /* -------------------------------------------------- tier 5: operations */

  async tierOperations(installState) {
    const t = 5;
    if (!installState) {
      return this.record(t, "install_state", SKIP, "not readable from here");
    }
    this.record(
      t,
      "schema is migrated",
      Number(installState.schema_version) > 0 ? PASS : FAIL,
      `schema version ${installState.schema_version}`
    );
    this.record(
      t,
      "credential gate version recorded",
      Number(installState.gate_version) >= 2 ? PASS : WARN,
      `gate version ${installState.gate_version}`
    );
    const declared = this.m.brain?.version;
    if (declared) {
      this.record(
        t,
        "deployed version matches the manifest",
        installState.product_version === declared ? PASS : WARN,
        `install ${installState.product_version}, manifest ${declared}`
      );
    }
    const cap = this.m.safety?.daily_llm_spend_cap_usd;
    this.record(
      t,
      "daily spend cap configured",
      cap ? PASS : WARN,
      cap ? `$${cap}/day` : "no cap set, a runaway loop is a billing incident"
    );
  }

  /* ---------------------------------------------------------------- run */

  async run({ probes, installState } = {}) {
    await this.tierReach();
    // Everything downstream reads the brain, so a broken tier 1 makes the rest
    // noise rather than signal.
    if (this.tierFailed === 1) return this.summary();
    await this.tierData();
    await this.tierRetrieval(probes);
    await this.tierSafety();
    await this.tierOperations(installState);
    return this.summary();
  }

  summary() {
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const r of this.results) counts[r.status]++;
    return {
      results: this.results,
      counts,
      passed: counts.fail === 0,
      stoppedAtTier: this.tierFailed,
    };
  }
}
