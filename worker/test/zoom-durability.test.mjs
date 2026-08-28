// worker/test/zoom-durability.test.mjs
//
// The defect this file guards: a Zoom transcript that fails AFTER the webhook
// has been acknowledged used to be a `console.warn` and a return. Zoom considers
// an acknowledged delivery finished and never sends it again, so the call was
// simply not in the brain, nothing counted it, nothing reported it, and the
// owner found out weeks later or never.
//
// Everything here runs against a REAL SQLite database with the real migrations
// applied, and drives the real route through `worker.fetch`. The store is the
// real D1 store, so "the retry completed the delivery" means a `documents` row
// exists, not that a stub was called. The owner-visible half is proven through
// `freshnessReport` and `coverageGaps` — the same two functions `brain sources`,
// `brain health`, `acceptance.mjs` and every `/api/rag/think` answer read — not
// through a bespoke assertion invented for this test.
//
// WHAT THIS FILE CANNOT PROVE, stated rather than implied by silence: no test
// in this repo has ever spoken to Zoom. There is no paid (Licensed) Zoom
// account in this environment, so no real webhook, no real signature, no real
// recording and no real retry has ever happened. The Zoom API is scripted here.
// What is proven is this brain's behaviour given those responses.

import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { coverageGaps, freshnessReport } from "../src/lib/store-d1.js";
import {
  ZOOM_DELIVERY_MAX_ATTEMPTS,
  ZOOM_NEVER_DELIVERED_IS_NOT_DETECTABLE,
  ZOOM_OWED_GRACE_MS,
  ZOOM_TRANSCRIPT_EVENT,
  claimZoomDelivery,
  deferZoomDelivery,
  describeZoomBacklog,
  reconcileZoomSourceState,
  sweepZoomDeliveries,
  zoomDeliveryBacklog,
} from "../src/lib/zoom.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "..", "..", "migrations", "d1");
const FIXTURES = join(HERE, "fixtures", "zoom");
const TRANSCRIPT_VTT = readFileSync(resolve(FIXTURES, "cue-numbers.vtt"), "utf-8");

/* Deliberately fake. A fixture secret, not a Zoom one. */
const SECRET = "zoom-secret-token-for-tests-only";
const sign = (secret, message) => createHmac("sha256", secret).update(message).digest("hex");

const UUID = "aB3/xY9z+Qw==";
const MEETING_ID = 81234567890;
const TOPIC = "Quarterly review with the partnership team";
const START_TIME = "2026-08-20T17:00:00Z";
const NOW = Date.UTC(2026, 7, 20, 18, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* --------------------------------------------------- a real D1 on sqlite */

function mkEnv({ dbFailsOn = null, skipMigration = null } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (skipMigration && file.startsWith(skipMigration)) continue;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 20, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();

  const prepare = (sql) => {
    const shape = (params = []) => ({
      _sql: sql,
      _params: params,
      bind: (...next) => shape(next),
      all: async () => {
        if (dbFailsOn && dbFailsOn.test(sql)) throw new Error("D1_ERROR: network connection lost");
        return { results: db.prepare(sql).all(...params) };
      },
      first: async () => {
        if (dbFailsOn && dbFailsOn.test(sql)) throw new Error("D1_ERROR: network connection lost");
        return db.prepare(sql).get(...params) ?? null;
      },
      run: async () => {
        if (dbFailsOn && dbFailsOn.test(sql)) throw new Error("D1_ERROR: network connection lost");
        const r = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(r.changes || 0) } };
      },
    });
    return shape();
  };

  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "admin-key-fixture",
    ZOOM_ACCOUNT_ID: "zoom-account-fixture",
    ZOOM_CLIENT_ID: "zoom-client-fixture",
    ZOOM_CLIENT_SECRET: "zoom-client-secret-fixture",
    ZOOM_WEBHOOK_SECRET_TOKEN: SECRET,
    _db: db,
    DB: {
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const out = statements.map((s) => {
            const r = db.prepare(s._sql).run(...s._params);
            return { success: true, results: [], meta: { changes: Number(r.changes || 0) } };
          });
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    // The D1 store enqueues chunks into vector_outbox and never calls Vectorize
    // on the ingest path, so an empty binding is enough to make backendOf() read
    // d1 without pretending a vector index answered.
    VECTORIZE: {},
  };
  return env;
}

const ledgerRows = (env) => env._db.prepare("SELECT * FROM zoom_deliveries ORDER BY received_at").all();
const ledgerRow = (env, uuid = UUID) =>
  env._db.prepare("SELECT * FROM zoom_deliveries WHERE uuid = ?").get(uuid) ?? null;
const sourceRow = (env) => env._db.prepare("SELECT * FROM sources WHERE name = 'zoom'").get() ?? null;
const zoomDocuments = (env) =>
  env._db.prepare("SELECT doc_uid, title FROM documents WHERE source = 'zoom'").all();

/* ------------------------------------------------------ a scripted Zoom */

const DOWNLOAD_URL = "https://download.zoom.us.example/rec/transcript/fixture";

/**
 * `script` is mutable so one env can fail, then succeed on the retry, which is
 * the whole point of the exercise.
 */
function mkZoom(script = {}) {
  const state = {
    tokenStatus: 200,
    recordingStatus: 200,
    downloadStatus: 200,
    transcript: TRANSCRIPT_VTT,
    includeTranscriptFile: true,
    calls: [],
    ...script,
  };
  state.fetchImpl = async (url, init = {}) => {
    const href = String(url);
    state.calls.push(href);
    if (href.startsWith("https://zoom.us/oauth/token")) {
      return state.tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: "zoom-access-token-fixture" }), { status: 200 })
        : new Response("token refused", { status: state.tokenStatus });
    }
    if (href.includes("/v2/meetings/")) {
      if (state.recordingStatus !== 200) return new Response("refused", { status: state.recordingStatus });
      return new Response(JSON.stringify({
        topic: TOPIC,
        start_time: START_TIME,
        duration: 42,
        host_email: "owner@example.test",
        recording_files: [
          { file_type: "MP4", download_url: "https://download.zoom.us.example/rec/video/fixture" },
          ...(state.includeTranscriptFile
            ? [{ file_type: "TRANSCRIPT", download_url: DOWNLOAD_URL }]
            : []),
        ],
      }), { status: 200 });
    }
    if (href.startsWith(DOWNLOAD_URL)) {
      return state.downloadStatus === 200
        ? new Response(state.transcript, { status: 200 })
        : new Response("", { status: state.downloadStatus });
    }
    return new Response("unexpected call", { status: 599 });
  };
  return state;
}

const transcriptEvent = () => ({
  event: ZOOM_TRANSCRIPT_EVENT,
  event_ts: NOW,
  payload: {
    account_id: "acct-fixture",
    object: {
      uuid: UUID, id: MEETING_ID, topic: TOPIC,
      start_time: START_TIME, duration: 42, host_email: "owner@example.test",
    },
  },
});

function signedRequest(body, { timestamp = NOW } = {}) {
  const payload = JSON.stringify(body);
  return new Request("https://brain.example/api/webhooks/zoom", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zm-signature": `v0=${sign(SECRET, `v0:${timestamp}:${payload}`)}`,
      "x-zm-request-timestamp": String(timestamp),
    },
    body: payload,
  });
}

/** Drive the REAL route, with the global fetch scripted for the duration. */
async function postThroughTheRoute(env, zoom, { timestamp = NOW } = {}) {
  const pending = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = zoom.fetchImpl;
  const realNow = Date.now;
  Date.now = () => timestamp;
  try {
    const response = await worker.fetch(
      signedRequest(transcriptEvent(), { timestamp }), env,
      { waitUntil: (p) => pending.push(p) },
    );
    await Promise.all(pending);
    return { response, body: await response.json() };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

const quiet = async (fn) => {
  const warn = console.warn, error = console.error, log = console.log;
  const lines = [];
  console.warn = (...a) => lines.push(a.map(String).join(" "));
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try { return { value: await fn(), lines }; }
  finally { console.warn = warn; console.error = error; console.log = log; }
};

/* ==================================================================== */
/* 1. A failure AFTER the acknowledgement is recorded as owed            */
/* ==================================================================== */

{
  const env = mkEnv();
  // 403 on the recording lookup: the missing-scope case, and one of the four
  // failures that live entirely on the far side of the 200.
  const zoom = mkZoom({ recordingStatus: 403 });
  const { value, lines } = await quiet(() => postThroughTheRoute(env, zoom));
  const { response, body } = value;

  check("the webhook still acknowledges Zoom fast, with a 200",
    response.status === 200 && body.ok === true, `${response.status} ${JSON.stringify(body)}`);
  check("and states that the delivery was written down as durable",
    body.durable === true, JSON.stringify(body));

  const row = ledgerRow(env);
  check("a post-acknowledgement failure leaves a ledger row, not just a log line",
    row !== null, JSON.stringify(ledgerRows(env)));
  check("the row says the transcript is still OWED",
    row?.state === "owed", JSON.stringify(row));
  check("it counts the attempt that just failed",
    Number(row?.attempts) === 1, JSON.stringify(row?.attempts));
  check("it records WHY, naming the Zoom scope rather than a bare status",
    /cloud_recording:read:admin/.test(String(row?.last_error || "")), String(row?.last_error));
  check("it names the meeting, so the debt can be looked up later",
    row?.topic === TOPIC && row?.start_time === START_TIME, JSON.stringify(row));
  check("and it schedules the next attempt in the future",
    Number(row?.next_attempt_at) > NOW, JSON.stringify({ next: row?.next_attempt_at, now: NOW }));
  check("no document was written for a transcript that was never fetched",
    zoomDocuments(env).length === 0, JSON.stringify(zoomDocuments(env)));
  check("the failure is still logged at full volume as well as recorded",
    lines.join(" ").includes("cloud_recording:read:admin"), lines.join(" "));

  /* ============================================================== */
  /* 2. The owner-visible surface reports it, without being asked    */
  /* ============================================================== */

  const before = await freshnessReport(env, { now: NOW + MINUTE });
  const zoomBefore = before.sources.find((s) => s.name === "zoom");
  check("inside the grace window the source is NOT called broken (a retry in flight is not a fault)",
    !zoomBefore || zoomBefore.state !== "broken", JSON.stringify(zoomBefore));

  const overdue = NOW + ZOOM_OWED_GRACE_MS + MINUTE;
  await reconcileZoomSourceState(env, { now: overdue });

  const report = await freshnessReport(env, { now: overdue });
  const zoomSource = report.sources.find((s) => s.name === "zoom");
  check("past the grace window the zoom source reads BROKEN in `brain sources` and `brain health`",
    zoomSource?.state === "broken", JSON.stringify(zoomSource));
  check("and the reason names the meeting the owner is missing",
    /Quarterly review/.test(String(zoomSource?.reason || "")), String(zoomSource?.reason));
  check("the reason says how many transcripts are missing",
    /^1 Zoom transcript\(s\)/.test(String(zoomSource?.reason || "")), String(zoomSource?.reason));

  const gaps = await coverageGaps(env, { now: overdue });
  const gap = gaps.find((g) => g.source === "zoom");
  check("the SAME condition becomes a coverage gap, which rides on every answer the brain gives",
    gap?.type === "sync_broken", JSON.stringify(gaps));
  check("so the owner learns a call is missing while asking about something else entirely",
    /Quarterly review/.test(String(gap?.detail || "")) && /not in the brain/.test(String(gap?.detail || "")),
    String(gap?.detail));

  /* ============================================================== */
  /* 3. A retry actually COMPLETES the delivery                      */
  /* ============================================================== */

  // Zoom recovers: the scope is granted, or whatever it was is fixed.
  zoom.recordingStatus = 200;
  const swept = await sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => overdue });

  check("the sweep found the owed delivery and attempted it",
    swept.available === true && swept.due === 1 && swept.attempted === 1, JSON.stringify(swept));
  check("the retry stored the transcript", swept.stored === 1, JSON.stringify(swept));

  const docs = zoomDocuments(env);
  check("a real document now exists under the recording's own uuid",
    docs.length === 1 && docs[0].doc_uid === `zoom:${UUID}`, JSON.stringify(docs));
  check("with the meeting topic as its title", docs[0]?.title === TOPIC, JSON.stringify(docs));
  const chunk = env._db.prepare("SELECT text FROM chunks WHERE source = 'zoom' LIMIT 1").get();
  check("and the parsed transcript text really landed in a chunk",
    /Alex Rivera: Thanks for making time/.test(String(chunk?.text || "")), String(chunk?.text).slice(0, 120));

  const settled = ledgerRow(env);
  check("the ledger row is settled as stored, so it is never retried again",
    settled?.state === "stored" && settled?.settled_at !== null && settled?.next_attempt_at === null,
    JSON.stringify(settled));

  const after = await freshnessReport(env, { now: overdue });
  const zoomAfter = after.sources.find((s) => s.name === "zoom");
  check("the source stops reading broken once the debt is paid",
    zoomAfter && zoomAfter.state !== "broken", JSON.stringify(zoomAfter));
  check("the stale reason is cleared rather than left to nag",
    sourceRow(env)?.stale_reason === null && sourceRow(env)?.status === "ready", JSON.stringify(sourceRow(env)));
  check("and the coverage gap disappears from answers",
    (await coverageGaps(env, { now: overdue })).filter((g) => g.source === "zoom").length === 0);
}

/* ==================================================================== */
/* 4. A delivery that works records nothing owed                        */
/* ==================================================================== */

{
  const env = mkEnv();
  const zoom = mkZoom();
  const { value } = await quiet(() => postThroughTheRoute(env, zoom));
  check("a healthy delivery is acknowledged and marked durable",
    value.response.status === 200 && value.body.durable === true, JSON.stringify(value.body));

  const row = ledgerRow(env);
  check("the delivery settles as stored on the first attempt",
    row?.state === "stored" && Number(row?.attempts) === 0, JSON.stringify(row));

  const backlog = await zoomDeliveryBacklog(env, { now: NOW + 2 * HOUR });
  check("nothing is owed", backlog.owed === 0 && backlog.overdue === 0, JSON.stringify(backlog));
  check("nothing was abandoned or refused",
    backlog.abandoned === 0 && backlog.refused === 0, JSON.stringify(backlog));

  await reconcileZoomSourceState(env, { now: NOW + 2 * HOUR });
  const report = await freshnessReport(env, { now: NOW + 2 * HOUR });
  const zoomSource = report.sources.find((s) => s.name === "zoom");
  check("a working connector never reports itself broken",
    zoomSource && zoomSource.state !== "broken" && zoomSource.reason === null, JSON.stringify(zoomSource));
  check("and adds no gap to any answer",
    (await coverageGaps(env, { now: NOW + 2 * HOUR })).filter((g) => g.source === "zoom").length === 0);
  check("the document is in the brain",
    zoomDocuments(env).length === 1, JSON.stringify(zoomDocuments(env)));

  // A redelivery of something already stored must not reopen the debt: Zoom
  // resends on its own schedule, and treating that as a new obligation would
  // make a healthy connector look like it was constantly failing.
  const again = await quiet(() => postThroughTheRoute(env, zoom, { timestamp: NOW + MINUTE }));
  const reRow = ledgerRow(env);
  check("a redelivered webhook does not reopen a settled delivery",
    again.value.response.status === 200 && reRow?.state === "stored" && Number(reRow?.attempts) === 0,
    JSON.stringify(reRow));
  check("and does not write a second document",
    zoomDocuments(env).length === 1, JSON.stringify(zoomDocuments(env)));
}

/* ==================================================================== */
/* 5. An obligation that cannot be recorded is not acknowledged          */
/* ==================================================================== */

{
  // D1 is up enough to route but the ledger INSERT fails. Acknowledging here
  // would recreate the exact defect: Zoom would consider the delivery done and
  // this brain would hold no record that it owed anything.
  const env = mkEnv({ dbFailsOn: /INSERT INTO zoom_deliveries/ });
  const zoom = mkZoom();
  const { value, lines } = await quiet(() => postThroughTheRoute(env, zoom));
  check("a delivery this brain cannot write down is refused with 503, so Zoom retries it",
    value.response.status === 503, `${value.response.status} ${JSON.stringify(value.body)}`);
  check("the refusal says plainly that the delivery was not recorded",
    /could not record the delivery/.test(String(value.body?.error || "")), JSON.stringify(value.body));
  check("and no Zoom API call was made for a delivery that was refused",
    zoom.calls.length === 0, JSON.stringify(zoom.calls));
  check("nothing is logged as a silent drop", !/silently/.test(lines.join(" ")));
}

{
  // The real window between `brain deploy` and `brain migrate`: new code, old
  // schema. This must degrade to the pre-existing behaviour loudly, not 503
  // every delivery until someone runs a migration.
  const env = mkEnv({ skipMigration: "0020" });
  const zoom = mkZoom();
  const { value, lines } = await quiet(() => postThroughTheRoute(env, zoom));
  check("with the ledger table missing the delivery is still processed",
    value.response.status === 200 && zoomDocuments(env).length === 1,
    `${value.response.status} ${JSON.stringify(zoomDocuments(env))}`);
  check("but the acknowledgement does NOT claim durability it does not have",
    value.body.durable === false, JSON.stringify(value.body));
  check("and the operator is told exactly which command closes the hole",
    /brain migrate/.test(lines.join(" ")), lines.join(" "));

  const swept = await sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => NOW });
  check("the sweep reports the missing table rather than throwing on every tick",
    swept.available === false && /brain migrate/.test(String(swept.reason)), JSON.stringify(swept));
}

/* ==================================================================== */
/* 6. Retries are finite, and running out is itself reported             */
/* ==================================================================== */

{
  const env = mkEnv();
  // Audio Transcript is off in the Zoom account, so this recording will never
  // have a transcript file. The old code warned once and returned.
  const zoom = mkZoom({ includeTranscriptFile: false });
  await quiet(() => postThroughTheRoute(env, zoom));
  check("a recording with no transcript file is owed rather than dropped",
    ledgerRow(env)?.state === "owed", JSON.stringify(ledgerRow(env)));

  let at = NOW;
  for (let i = 1; i < ZOOM_DELIVERY_MAX_ATTEMPTS; i++) {
    at += 24 * HOUR; // well past any backoff
    await quiet(() => sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => at }));
  }
  const row = ledgerRow(env);
  check(`after ${ZOOM_DELIVERY_MAX_ATTEMPTS} attempts the delivery is written off, not retried forever`,
    row?.state === "abandoned" && Number(row?.attempts) === ZOOM_DELIVERY_MAX_ATTEMPTS, JSON.stringify(row));
  check("and the write-off keeps the reason, which names the Zoom setting to fix",
    /Audio Transcript/.test(String(row?.last_error || "")), String(row?.last_error));

  await reconcileZoomSourceState(env, { now: at });
  const zoomSource = (await freshnessReport(env, { now: at })).sources.find((s) => s.name === "zoom");
  check("a written-off transcript still reports the source as broken",
    zoomSource?.state === "broken", JSON.stringify(zoomSource));
  check("and the sentence tells the owner retries are exhausted",
    /Retries are exhausted/.test(String(zoomSource?.reason || "")), String(zoomSource?.reason));

  // Two weeks later the alarm stops, because nobody can act on it any more and
  // a permanent warning is one people learn to ignore. The row itself stays.
  const later = at + 15 * 24 * HOUR;
  await reconcileZoomSourceState(env, { now: later });
  const settled = (await freshnessReport(env, { now: later })).sources.find((s) => s.name === "zoom");
  check("after the alert window the alarm clears but the ledger row is kept as the record",
    settled?.state !== "broken" && ledgerRow(env)?.state === "abandoned",
    JSON.stringify({ state: settled?.state, row: ledgerRow(env)?.state }));
}

/* ==================================================================== */
/* 7. A disconnected brain does not burn a recording's retry budget      */
/* ==================================================================== */

{
  const env = mkEnv();
  const zoom = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(env, zoom));
  check("a 500 from Zoom burns one attempt", Number(ledgerRow(env)?.attempts) === 1);

  // `brain disconnect zoom` deletes the four secrets. A transcript that was
  // already owed cannot be fetched now, but reconnecting would recover it, so
  // writing it off would be a lie about what happened.
  delete env.ZOOM_ACCOUNT_ID;
  delete env.ZOOM_CLIENT_ID;
  delete env.ZOOM_CLIENT_SECRET;
  const at = NOW + 24 * HOUR;
  await quiet(() => sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => at }));
  const row = ledgerRow(env);
  check("with Zoom unconfigured the attempt is recorded but the budget is not spent",
    row?.state === "owed" && Number(row?.attempts) === 1, JSON.stringify(row));
  check("and the reason says Zoom is not configured on this brain",
    /not configured on this brain/.test(String(row?.last_error || "")), String(row?.last_error));

  delete env.ZOOM_WEBHOOK_SECRET_TOKEN;
  const state = await reconcileZoomSourceState(env, { now: at });
  check("a disconnected brain says the owed transcripts cannot be fetched until it is reconnected",
    /reconnected/.test(String(state.reason || "")), String(state.reason));
}

/* ==================================================================== */
/* 8. Two sweeps cannot attempt the same delivery at once                */
/* ==================================================================== */

{
  const env = mkEnv();
  const zoom = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(env, zoom));
  const at = NOW + 24 * HOUR;
  check("the first claim on a due delivery succeeds",
    (await claimZoomDelivery(env, UUID, { now: at })) === true);
  check("a second claim inside the lease is refused, so the retry runs once",
    (await claimZoomDelivery(env, UUID, { now: at + MINUTE })) === false);
  check("a claim that is never settled becomes available again after the lease expires",
    (await claimZoomDelivery(env, UUID, { now: at + 20 * MINUTE })) === true);

  // A crashed attempt must not spend the budget either.
  const row = ledgerRow(env);
  check("and an unfinished claim leaves the attempt count untouched",
    Number(row?.attempts) === 1, JSON.stringify(row));
}

/* ==================================================================== */
/* 9. What this design still cannot see, asserted rather than assumed    */
/* ==================================================================== */

{
  const env = mkEnv();
  // A recording that Zoom never announced to this brain — the worker was down
  // past Zoom's own retries, or the subscription was never saved, or the call
  // predates the connection. Nothing arrives, so nothing is written.
  check("a recording whose webhook never arrived leaves NO ledger row",
    ledgerRows(env).length === 0);
  const backlog = await zoomDeliveryBacklog(env, { now: NOW });
  check("and the backlog therefore reports nothing missing, because it cannot know",
    backlog.owed === 0 && backlog.overdue === 0, JSON.stringify(backlog));
  check("a delivery that was never made is indistinguishable from a week with no meetings",
    (await coverageGaps(env, { now: NOW })).filter((g) => g.source === "zoom").length === 0);
  check("which the module states in its own words rather than leaving to be discovered",
    /never reached this brain leaves no trace/.test(ZOOM_NEVER_DELIVERED_IS_NOT_DETECTABLE) &&
      /listing scope this connector does not request/.test(ZOOM_NEVER_DELIVERED_IS_NOT_DETECTABLE),
    ZOOM_NEVER_DELIVERED_IS_NOT_DETECTABLE);
}

/* ==================================================================== */
/* 10. The inline path and the retry path are the SAME code              */
/* ==================================================================== */

{
  // Not a style point. A separate retry implementation is the one nobody
  // watches run, so it is the one that drifts. Both callers are driven here
  // against the same scripted Zoom and must produce the same document.
  const inline = mkEnv();
  const zoomA = mkZoom();
  await quiet(() => postThroughTheRoute(inline, zoomA));

  const retried = mkEnv();
  const zoomB = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(retried, zoomB));
  zoomB.recordingStatus = 200;
  await quiet(() => sweepZoomDeliveries(retried, { fetchImpl: zoomB.fetchImpl, now: () => NOW + 24 * HOUR }));

  const a = inline._db.prepare("SELECT doc_uid, title, content_hash, document_date FROM documents WHERE source='zoom'").get();
  const b = retried._db.prepare("SELECT doc_uid, title, content_hash, document_date FROM documents WHERE source='zoom'").get();
  check("a transcript stored by the retry is byte-identical to one stored inline",
    a && b && a.doc_uid === b.doc_uid && a.title === b.title &&
      a.content_hash === b.content_hash && a.document_date === b.document_date,
    JSON.stringify({ a, b }));
  check("both record a source receipt, so `brain sources` sees either path",
    inline._db.prepare("SELECT COUNT(*) n FROM source_events WHERE source_name='zoom'").get().n > 0 &&
      retried._db.prepare("SELECT COUNT(*) n FROM source_events WHERE source_name='zoom'").get().n > 0);
}

/* ==================================================================== */
/* 11. The scheduled tick is what runs the retry                         */
/* ==================================================================== */

{
  const env = mkEnv();
  const zoom = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(env, zoom));
  check("a delivery is owed before the tick", ledgerRow(env)?.state === "owed");

  zoom.recordingStatus = 200;
  const pending = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = zoom.fetchImpl;
  Date.now = () => NOW + 24 * HOUR;
  // allSettled, not all: this env has no embedding binding, so the vector drain
  // half of the tick genuinely fails here. That is the point of the next
  // assertion — the two queues share a schedule, not a fate.
  let drainOutcome = [];
  try {
    await quiet(async () => {
      await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (p) => pending.push(p) });
      drainOutcome = await Promise.allSettled(pending);
    });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
  check("the cron tick that already drains the vector outbox also settles the Zoom debt",
    ledgerRow(env)?.state === "stored" && zoomDocuments(env).length === 1,
    JSON.stringify({ row: ledgerRow(env)?.state, docs: zoomDocuments(env).length }));
  check("and the Zoom sweep still ran even though the vector drain on the same tick failed",
    drainOutcome.some((r) => r.status === "rejected") && ledgerRow(env)?.state === "stored",
    JSON.stringify(drainOutcome.map((r) => r.status)));

  // A paused install must not write behind the pause, the same rule the webhook
  // itself already follows.
  const paused = mkEnv();
  const zoomP = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(paused, zoomP));
  paused.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  zoomP.recordingStatus = 200;
  const pending2 = [];
  globalThis.fetch = zoomP.fetchImpl;
  Date.now = () => NOW + 24 * HOUR;
  try {
    await quiet(async () => {
      await worker.scheduled({ cron: "*/5 * * * *" }, paused, { waitUntil: (p) => pending2.push(p) });
      await Promise.allSettled(pending2);
    });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
  check("a paused install leaves the debt owed rather than writing behind the pause",
    ledgerRow(paused)?.state === "owed" && zoomDocuments(paused).length === 0,
    JSON.stringify({ row: ledgerRow(paused)?.state, docs: zoomDocuments(paused).length }));
}

/* ==================================================================== */
/* 12. Backoff is real, so a failing recording does not hammer Zoom      */
/* ==================================================================== */

{
  const env = mkEnv();
  const zoom = mkZoom({ recordingStatus: 500 });
  await quiet(() => postThroughTheRoute(env, zoom));
  const first = Number(ledgerRow(env)?.next_attempt_at);
  const swept = await quiet(() => sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => NOW + MINUTE }));
  check("a delivery that is not due yet is not attempted by the sweep",
    swept.value.due === 0 && swept.value.attempted === 0, JSON.stringify(swept.value));
  check("and its schedule is untouched", Number(ledgerRow(env)?.next_attempt_at) === first);

  const at = first + MINUTE;
  await quiet(() => sweepZoomDeliveries(env, { fetchImpl: zoom.fetchImpl, now: () => at }));
  const second = Number(ledgerRow(env)?.next_attempt_at);
  check("after a second failure the next attempt is further out than the first was",
    second - at > first - NOW, JSON.stringify({ firstDelay: first - NOW, secondDelay: second - at }));
  check("the attempt count advanced with it", Number(ledgerRow(env)?.attempts) === 2);
}

/* ==================================================================== */
/* 13. A refusal is terminal and visible, not a retry loop               */
/* ==================================================================== */

{
  const env = mkEnv();
  const leaked = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nSam Osei: the deploy key is AKIAZXMPLE4TESTKEY01 if you need it\n";
  const zoom = mkZoom({ transcript: leaked });
  const { lines } = await quiet(() => postThroughTheRoute(env, zoom));
  const row = ledgerRow(env);
  check("a transcript refused by the credential gate is settled as refused, not retried",
    row?.state === "refused" && row?.next_attempt_at === null, JSON.stringify(row));
  check("the ledger names the credential kind and never stores its value",
    /aws_access_key/.test(String(row?.last_error || "")) &&
      !String(row?.last_error || "").includes("AKIAZXMPLE4TESTKEY01"), String(row?.last_error));
  check("no document was written", zoomDocuments(env).length === 0);
  check("and the refusal is still logged", /aws_access_key/.test(lines.join(" ")), lines.join(" "));

  // A deliberate refusal is the gate working, so it must not raise the missing-
  // transcript alarm on a connector that is behaving correctly.
  const state = await reconcileZoomSourceState(env, { now: NOW + 2 * HOUR });
  check("a refusal does not make the source read broken: the gate did its job",
    state.state === "ok", JSON.stringify(state));
  check("but it stays countable in the ledger",
    (await zoomDeliveryBacklog(env, { now: NOW + 2 * HOUR })).refused === 1);

  // A redelivery of a refused transcript would be refused again; reopening it
  // would manufacture a failure out of the gate working twice.
  await quiet(() => postThroughTheRoute(env, zoom, { timestamp: NOW + MINUTE }));
  check("a redelivery does not reopen a refused delivery", ledgerRow(env)?.state === "refused");
}

/* ==================================================================== */
/* 14. deferZoomDelivery is honest about a row that vanished             */
/* ==================================================================== */

{
  const env = mkEnv();
  const outcome = await deferZoomDelivery(env, "no-such-uuid", { error: "gone", now: NOW });
  check("deferring a delivery with no ledger row does not throw and does not invent one",
    outcome.state === "owed" && ledgerRows(env).length === 0, JSON.stringify(outcome));
}

/* ==================================================================== */
/* 15. The sentence itself, since it is the whole reporting surface      */
/* ==================================================================== */

{
  const backlog = {
    overdue: 1, abandoned_recent: 0,
    oldest_missing: {
      topic: "Quarterly review with the partnership team",
      start_time: "2026-08-20T17:00:00Z",
      last_error: "transcript ingest failed: Zoom refused the recording read. The Server-to-Server OAuth app needs the cloud_recording:read:admin scope.",
    },
  };
  const reason = describeZoomBacklog(backlog);
  check("the reason names the count, the meeting, the date and the cause",
    /^1 Zoom transcript\(s\)/.test(reason) && reason.includes("Quarterly review") &&
      reason.includes("2026-08-20") && reason.includes("cloud_recording:read:admin"), reason);
  check("it never doubles a full stop where it splices Zoom's own sentence in",
    !reason.includes(".."), reason);
  check("and it carries no trailing stop, because coverageGaps composes it into a longer sentence",
    !reason.endsWith("."), reason);

  // A fixed-width cut once produced "needs the cloud_recording:read." — a scope
  // name that reads as complete and is wrong. A clipped value must look clipped.
  const long = describeZoomBacklog({
    overdue: 1, abandoned_recent: 0,
    oldest_missing: { topic: "x".repeat(200), start_time: null, last_error: "y".repeat(400) },
  });
  check("a clipped topic or error is visibly clipped rather than silently wrong",
    long.includes("...") && long.length <= 500, `${long.length} ${long.slice(0, 120)}`);
  check("nothing is reported missing when nothing is",
    describeZoomBacklog({ overdue: 0, abandoned_recent: 0, oldest_missing: null }) === null);
}

console.log(fail ? `\n${fail} FAILURES` : `\nzoom durability: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
