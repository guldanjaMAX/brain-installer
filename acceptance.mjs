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
 *   2 data       is anything in it, and is EVERY source that should be
 *                refreshing still refreshing
 *   3 retrieval  does a real question return real sources
 *   4 safety     does the credential gate actually refuse
 *   5 operations schema version, migrations, spend cap
 *
 * Every check is READ-ONLY except the credential-gate probe, which attempts an
 * ingest that MUST be refused. If that probe ever succeeds, the test fails
 * loudly and the content it wrote is reported for removal.
 */

import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";
import { describeFailures, responseIncomplete } from "./worker/src/lib/failure.js";

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

/**
 * States the Worker reports for a source that WAS expected to keep itself
 * current and has not. Each one is a FAILURE, not a warning: a client reading
 * a green acceptance report is being told their brain is current, and a source
 * in one of these states makes that sentence false.
 */
const FRESHNESS_DEAD = new Set(["stale", "broken", "never_synced"]);

/** One sentence a person can act on at 9pm, per dead state. */
const FRESHNESS_SENTENCE = {
  stale: (s) =>
    `last read ${s.days_since_ingest ?? "?"} day(s) ago but expected to refresh about every ` +
    `${s.expected_every_days ?? "?"} day(s); anything added since is not in the brain`,
  broken: (s) => s.reason || "the last sync failed",
  never_synced: () =>
    "expected to refresh but has never completed a sync, so its contents may be missing entirely",
};

const shortLabel = (s) =>
  s.state === "stale" && Number.isFinite(Number(s.days_since_ingest))
    ? `${s.name} (${s.days_since_ingest}d)`
    : s.name;

/**
 * Judge freshness PER SOURCE, against what each source was actually expected
 * to do.
 *
 * This replaces a check that took the newest ingest timestamp across every
 * source and called the whole corpus fresh if that single value was recent. On
 * any install with one fast source — message capture runs every minute — that
 * check passed forever, including while the client's most important corpus had
 * been dead for months. It was a corpus-wide claim supported by one source.
 *
 * The expectation itself is NOT reinvented here. `/api/admin/brain/freshness`
 * already owns it: a schedule is recorded when a connector's scheduler is
 * installed, a source with no expectation is never called stale because it was
 * never going to update, and a source we cannot reach on our own reads
 * "manual" rather than being blamed for a limit of the architecture. Deriving a
 * second notion of staleness in the test would let the acceptance report and
 * `brain sources` disagree about the same install, and the client would have no
 * way to tell which one was lying.
 *
 * Returns records rather than recording them, so the judgement is testable
 * without a Worker.
 */
export function freshnessVerdicts({ ok, status, payload, expectedBackend = "d1" } = {}) {
  const HEADLINE = "every source expected to refresh is current";

  // A check that cannot run says so. It never passes.
  if (String(expectedBackend || "").toLowerCase() !== "d1") {
    return [{
      name: HEADLINE,
      status: SKIP,
      detail:
        `per-source freshness is implemented for the d1 backend and this install declares ` +
        `${expectedBackend || "no"} storage, so no freshness claim is made either way`,
    }];
  }
  if (!ok) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail:
        `the freshness endpoint did not answer (HTTP ${status ?? "?"}). Freshness is UNVERIFIED: ` +
        `this install cannot tell you whether any source has stopped updating. Upgrade the ` +
        `Worker, then re-run.`,
    }];
  }
  if (payload?.unavailable) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail: "the Worker could not read its sources table, so no source's freshness could be checked",
    }];
  }
  const sources = Array.isArray(payload?.sources) ? payload.sources : null;
  if (!sources) {
    return [{
      name: HEADLINE,
      status: FAIL,
      detail: "the freshness endpoint returned no per-source list, so freshness is unverified",
    }];
  }
  if (!sources.length) {
    return [{
      name: HEADLINE,
      status: WARN,
      detail:
        "no sources are registered in this install, so nothing here can be judged fresh or stale. " +
        "Register the corpora with `brain sources <manifest> --add <name>`.",
    }];
  }

  const dead = sources.filter((s) => FRESHNESS_DEAD.has(s.state));
  const unscheduled = sources.filter((s) => s.state === "unscheduled");
  const manual = sources.filter((s) => s.state === "manual");
  const indexing = sources.filter((s) => s.state === "indexing");
  const current = sources.filter((s) => s.state === "ok");
  const judged = dead.length + current.length + indexing.length;

  const aside = [
    unscheduled.length ? `${unscheduled.length} unscheduled` : null,
    manual.length ? `${manual.length} loaded by hand and never judged stale` : null,
    indexing.length ? `${indexing.length} mid-sync` : null,
  ].filter(Boolean);

  // "0 of 0 current" is a vacuous green, and a vacuous green is the same lie
  // in a smaller font. When nothing in the install is expected to refresh, say
  // that instead of reporting a perfect score over an empty set.
  const headline = judged === 0
    ? {
        name: HEADLINE,
        status: WARN,
        detail:
          `no source in this install is expected to refresh, so nothing here is being kept ` +
          `current${aside.length ? ` (${aside.join("; ")})` : ""}`,
      }
    : {
        name: HEADLINE,
        status: dead.length ? FAIL : PASS,
        detail: dead.length
          ? `${dead.length} of ${judged} scheduled source(s) have stopped updating: ` +
            `${dead.map(shortLabel).join(", ")}` +
            (aside.length ? ` (${aside.join("; ")})` : "")
          : `${current.length + indexing.length} of ${judged} scheduled source(s) current` +
            (aside.length ? ` (${aside.join("; ")})` : ""),
      };
  const out = [headline];

  // One line per source that is not current, because "something is stale" is
  // not something anyone can act on.
  for (const s of dead) {
    out.push({
      name: `freshness: ${s.name}`,
      status: FAIL,
      detail: `${String(s.state).toUpperCase().replace(/_/g, " ")} — ` +
        `${(FRESHNESS_SENTENCE[s.state] || (() => s.state))(s)}`,
    });
  }
  // Not a failure and not a pass. Nothing on this machine refreshes this
  // source, which is the honest state on a platform where the product installs
  // no scheduler at all, and it must be visible rather than quietly green.
  for (const s of unscheduled) {
    out.push({
      name: `freshness: ${s.name}`,
      status: WARN,
      detail:
        "NO REFRESH IS SCHEDULED. It can be refreshed automatically but nothing on this " +
        "install does, so it will not update until a schedule is set, and no staleness " +
        "claim is made about it either way.",
    });
  }
  return out;
}

/**
 * The owner-facing sentence for "how much of this corpus is fully searchable".
 *
 * One function, used by `brain refit`, the acceptance suite and the monthly
 * report, so those three can never quietly disagree about the same install.
 *
 * The wording is doing real work. It says "estimated" where the number is
 * estimated, it says "not yet measured" instead of folding an unknown into the
 * good half, and it names the consequence rather than the metric: an owner
 * cannot act on "N chunks exceed the token budget", but they can act on "part
 * of these documents cannot be found by meaning".
 */
export function renderSearchability(coverage) {
  if (!coverage || !Number.isSafeInteger(coverage.chunks)) {
    return "how much of this corpus is fully searchable could NOT be measured";
  }
  if (!coverage.chunks) return "there is nothing stored yet, so there is nothing to measure";
  const parts = [];
  if (coverage.unmeasured === coverage.chunks) {
    return "how much of this corpus is fully searchable is UNKNOWN: it was loaded before this " +
      "brain could measure it. Unknown is not the same as fine.";
  }
  parts.push(
    `at least ${coverage.fully_searchable_pct}% of this corpus is fully searchable ` +
    `(${coverage.fitting} of ${coverage.chunks} pieces, estimated)`);
  if (coverage.over_budget) {
    parts.push(
      `${coverage.over_budget} piece(s) are longer than the embedding window, so part of what ` +
      `they say can be found by keyword and never by meaning` +
      (coverage.proven_truncated
        ? `; ${coverage.proven_truncated} of the ${coverage.proof_sample} longest were checked and every one of those is definitely cut`
        : ""));
  }
  if (coverage.unmeasured) {
    parts.push(`${coverage.unmeasured_pct}% has never been measured, so it could be either`);
  }
  return parts.join(". ") + ".";
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
      // Deliberately unauthenticated: this tier proves the worker is REACHABLE,
      // and a probe that carried a key could not tell a live brain apart from
      // one that only answers its owner.
      const h = await this.get("/health", { auth: false });
      if (!h.ok) return this.record(t, "health responds", FAIL, `HTTP ${h.status}`);

      // The version is no longer public, and that is the point of issue 13: the
      // slug and the exact version are the pair an unauthenticated prober wants
      // first. So the version assertion moves to an authenticated read. This
      // suite already holds the admin key, so nothing is lost by asking properly.
      // `identified: false` is how a current worker says it is withholding;
      // a worker older than that split still puts the version in the open body,
      // and reading it there keeps this check working against both.
      let observedVersion = h.json?.version ?? null;
      let versionSource = "the public probe";
      if (h.json?.identified === false) {
        const detail = await this.get("/health");
        observedVersion = detail.json?.version ?? null;
        versionSource = "the authenticated probe";
      }
      if (this.expectVersion && observedVersion !== this.expectVersion) {
        return this.record(
          t,
          "health responds",
          FAIL,
          `expected version ${this.expectVersion}, ${versionSource} reported ${observedVersion || "none"}`,
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
    // This check is about the CREDENTIAL, so it judges the credential and
    // nothing else. `/documents` now answers 503 when a subsystem it reads
    // could not be queried, and scoring that as "correct key is rejected" would
    // point whoever is reading this report at the wrong problem entirely. The
    // subsystem failure is a real finding, and tier 2 below is where it lands.
    const keyRejected = good.status === 401 || good.status === 403;
    this.record(t, "correct key is accepted", keyRejected ? FAIL : PASS, `HTTP ${good.status}`);
  }

  /* -------------------------------------------------------- tier 2: data */

  async tierData() {
    const t = 2;
    const docs = await this.get("/api/admin/brain/documents");
    // Name the subsystem rather than the status code. On a half-migrated brain
    // the named failure is the missing column, which is the single most useful
    // sentence this suite can print. `responseIncomplete` also catches a worker
    // older than the envelope, where the same failure arrives as a 200 with the
    // error nested in the body and `docs.ok` is true.
    if (!docs.ok || responseIncomplete(docs.json)) {
      const named = describeFailures(docs.json);
      return this.record(
        t, "corpus summary", FAIL,
        named ? `HTTP ${docs.status}; ${named}` : `HTTP ${docs.status}`,
      );
    }

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

    // D1 is the product default everywhere else (setup, update, and health).
    // Do not let an endpoint choose its own expected backend here: a misbound
    // Supabase Worker could otherwise make a manifest with omitted storage
    // silently skip every exact Vectorize readiness check.
    const expectedBackend = String(
      this.m.infrastructure?.cloudflare?.storage || "d1",
    ).trim().toLowerCase();
    const actualBackend = String(docs.json?.backend || "").trim().toLowerCase();
    this.record(
      t,
      "storage backend matches manifest",
      actualBackend === expectedBackend ? PASS : FAIL,
      `expected ${expectedBackend || "an explicit backend"}, received ${actualBackend || "none"}`,
    );
    if (expectedBackend === "d1") {
      const readiness = docs.json?.vector_readiness;
      const valid = readiness && typeof readiness === "object" && !Array.isArray(readiness) &&
        !Object.hasOwn(readiness, "error") && typeof readiness.ready === "boolean" &&
        Number.isSafeInteger(readiness.expected_vectors) && readiness.expected_vectors >= 0 &&
        Number.isSafeInteger(readiness.actual_vectors) && readiness.actual_vectors >= 0 &&
        Number.isSafeInteger(readiness.pending) && readiness.pending >= 0 &&
        Number.isSafeInteger(readiness.submitted) && readiness.submitted >= 0 &&
        readiness.submitted <= readiness.pending;
      const ready = valid && readiness.ready === true && readiness.pending === 0 &&
        readiness.submitted === 0 && readiness.actual_vectors === readiness.expected_vectors;
      this.record(
        t,
        "semantic index is query-ready",
        ready ? PASS : FAIL,
        valid
          ? `${readiness.actual_vectors}/${readiness.expected_vectors} vector(s), ${readiness.pending} operation(s) pending` +
            (ready ? "" : `; ${readiness.action || "run brain drain, then brain diagnose"}`)
          : "the Worker did not provide a valid Vectorize visibility receipt",
      );
    }

    // How much of the corpus the embedder can actually READ.
    //
    // Every other check here counts documents and vectors, and all of them pass
    // on a corpus whose chunks were cut before embedding: the documents are
    // there, the vectors are there, and the answers are plausible because the
    // HEAD of each chunk embedded fine. This is the only check that can tell a
    // partly-searchable corpus from a complete one.
    if (expectedBackend === "d1") {
      const searchable = await this.get("/api/admin/brain/searchability");
      const c = searchable.json;
      if (!searchable.ok || !c || !Number.isSafeInteger(c.chunks)) {
        this.record(t, "the whole of each document is searchable", FAIL,
          `the Worker could not measure it (HTTP ${searchable.status}). This install cannot tell you ` +
          "how much of its own corpus meaning-based search can reach.");
      } else if (!c.chunks) {
        this.record(t, "the whole of each document is searchable", SKIP,
          "nothing is stored yet, so there is nothing to measure");
      } else {
        // Unmeasured is neither a pass nor a failure. It is the honest state of
        // a corpus loaded before this could be counted, and reporting it as a
        // pass would be the same defect the finding exists to end.
        const status = c.over_budget ? FAIL : c.unmeasured ? WARN : PASS;
        this.record(t, "the whole of each document is searchable", status,
          renderSearchability(c) +
          (status === PASS ? "" : " Repair it with `brain refit <manifest> --yes`."));
      }
    }

    // Freshness is a PER-SOURCE claim and never a corpus-wide one. Ask the
    // Worker's expectation-aware surface rather than re-deriving staleness
    // here, so this check and `brain sources` can never disagree about which
    // source is dead.
    const freshness = await this.get("/api/admin/brain/freshness");
    for (const verdict of freshnessVerdicts({
      ok: freshness.ok,
      status: freshness.status,
      payload: freshness.json,
      expectedBackend,
    })) {
      this.record(t, verdict.name, verdict.status, verdict.detail);
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
    let vectorDegraded = 0;
    for (const q of probes) {
      const r = await this.post("/api/rag/unified", { q, limit: 5, rerank: 0 });
      const n = r.json?.results?.length || 0;
      if (n > 0) answered++;
      if (r.json?.degraded === "vector") vectorDegraded++;
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
    this.record(
      t,
      "semantic retrieval is active",
      vectorDegraded === 0 ? PASS : FAIL,
      vectorDegraded === 0
        ? "no probe degraded to keyword-only retrieval"
        : `${vectorDegraded}/${probes.length} probe(s) were keyword-only because Vectorize returned no candidates`,
    );

    // `think` must degrade rather than 500. This is the path most likely to
    // break quietly, because it only fails when the LLM key, the spend cap or
    // the model name is wrong, none of which show up until someone asks a
    // question.
    const think = await this.post("/api/rag/think", { q: probes[0], limit: 5 });
    if (think.json?.degraded === "vector") {
      this.record(
        t,
        "think uses semantic retrieval",
        FAIL,
        "the answer path degraded to keyword-only retrieval",
      );
    }
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
