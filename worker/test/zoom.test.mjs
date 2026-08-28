// worker/test/zoom.test.mjs
//
// The client-owned Zoom transcript door, proven the way worker/test/routes.test.mjs
// proves the rest of the worker: no network, no Zoom account, a scripted fetch,
// and the HMAC recomputed independently with node:crypto so a bug in the
// verifier cannot agree with itself.
//
// WHAT THIS FILE CANNOT PROVE, stated here rather than implied by silence: no
// test in this repo has ever spoken to Zoom. A real cloud recording producing a
// real transcript requires a paid (Licensed) Zoom account, which the build
// session did not have. The live commands the owner must run to close that gap
// are written out in evidence/WP-08.md. Everything below is fixture-level truth.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import {
  ZOOM_REQUIRED_SCOPE,
  ZOOM_TRANSCRIPT_EVENT,
  buildZoomEnvelope,
  describeZoomPlan,
  gatedIngest,
  handleZoomWebhook,
  verifyZoomSignature,
  vttToPlainTranscript,
  zoomHmacHex,
  zoomRecordingPathId,
  zoomTimestampToMs,
} from "../src/lib/zoom.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "zoom");
const vtt = (name) => readFileSync(resolve(FIXTURES, name), "utf-8");

/* Deliberately fake. A fixture secret, not a Zoom one. */
const SECRET = "zoom-secret-token-for-tests-only";
const sign = (secret, message) => createHmac("sha256", secret).update(message).digest("hex");

const UUID = "aB3/xY9z+Qw==";
const MEETING_ID = 81234567890;

const transcriptEvent = (overrides = {}) => ({
  event: ZOOM_TRANSCRIPT_EVENT,
  event_ts: 1_756_000_000_000,
  payload: {
    account_id: "acct-fixture",
    object: {
      uuid: UUID,
      id: MEETING_ID,
      topic: "Quarterly review with the partnership team",
      start_time: "2026-08-20T17:00:00Z",
      duration: 42,
      host_email: "owner@example.test",
      ...overrides,
    },
  },
});

function mkEnv({ secret = SECRET, extra = {} } = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "admin-key-fixture",
    ZOOM_ACCOUNT_ID: "zoom-account-fixture",
    ZOOM_CLIENT_ID: "zoom-client-fixture",
    ZOOM_CLIENT_SECRET: "zoom-client-secret-fixture",
    ...(secret ? { ZOOM_WEBHOOK_SECRET_TOKEN: secret } : {}),
    ...extra,
  };
}

function signedRequest(body, { timestamp = Date.now(), secret = SECRET, signature = null, raw = null } = {}) {
  const payload = raw ?? JSON.stringify(body);
  const sig = signature ?? `v0=${sign(secret, `v0:${timestamp}:${payload}`)}`;
  return new Request("https://brain.example/api/webhooks/zoom", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zm-signature": sig,
      "x-zm-request-timestamp": String(timestamp),
    },
    body: payload,
  });
}

const DOWNLOAD_URL = "https://download.zoom.us.example/rec/transcript/fixture";

/** A scripted Zoom API. Records every URL so the path shape is assertable. */
function mkZoomFetch({
  transcript = vtt("cue-numbers.vtt"),
  recordingFiles = [
    { file_type: "MP4", download_url: "https://download.zoom.us.example/rec/video/fixture" },
    { file_type: "TRANSCRIPT", download_url: DOWNLOAD_URL },
  ],
  tokenStatus = 200,
  recordingStatus = 200,
  downloadStatus = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.startsWith("https://zoom.us/oauth/token")) {
      return tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: "zoom-access-token-fixture" }), { status: 200 })
        : new Response("token refused", { status: tokenStatus });
    }
    if (href.includes("/v2/meetings/")) {
      return recordingStatus === 200
        ? new Response(JSON.stringify({
          topic: "Quarterly review with the partnership team",
          start_time: "2026-08-20T17:00:00Z",
          duration: 42,
          host_email: "owner@example.test",
          recording_files: recordingFiles,
        }), { status: 200 })
        : new Response("recording lookup refused", { status: recordingStatus });
    }
    if (href.startsWith(DOWNLOAD_URL)) {
      return downloadStatus === 200
        ? new Response(transcript, { status: 200 })
        : new Response("", { status: downloadStatus });
    }
    return new Response("unexpected call", { status: 599 });
  };
  return { fetchImpl, calls };
}

/** Records the envelopes handed to the ingest path. */
function mkIngest() {
  const envelopes = [];
  return {
    envelopes,
    ingest: async (_env, envelope) => {
      envelopes.push(envelope);
      return { doc_uid: `zoom:${envelope.source_id}`, action: "created", chunks: 1 };
    },
  };
}

/* ============================================================ VTT parsing */

{
  const out = vttToPlainTranscript(vtt("cue-numbers.vtt"));
  // THE PORTED BUG. The parser live on the reference system's ingest path never
  // strips the bare "1", "2", "3" cue-number lines, so every transcript it wrote
  // carries stray digits. Nothing in the output may be a lone number.
  check("cue-number lines never leak into the transcript",
    !out.split("\n").some((line) => /^\s*\d+\s*$/.test(line)) && !/:\s*\d+\s/.test(out),
    JSON.stringify(out));
  check("the cue-number fixture parses to exactly its four speaker turns",
    out === [
      "Alex Rivera: Thanks for making time, I know the week is full.",
      "Priya Nair: No problem at all. I pulled the renewal numbers you asked for.",
      "Priya Nair: They are a little better than last quarter, about four percent up.",
      "Alex Rivera: Good. Send them over and I will read them before Thursday.",
    ].join("\n"),
    JSON.stringify(out));
  check("every line is speaker-attributed, none is a stray cue index",
    out.split("\n").every((line) => /^[A-Z][A-Za-z ]+: \S/.test(line)), JSON.stringify(out.split("\n")));
}

{
  const out = vttToPlainTranscript(vtt("multi-line-cue.vtt"));
  check("a wrapped cue is joined into one line under its speaker",
    out.startsWith("Jordan Lee: Let's lock the schedule before we lose the room, meet at 3:30"),
    JSON.stringify(out));
  check("a colon inside continuation text does not invent a speaker",
    !/(^|\n)meet at 3:/.test(out) && !out.includes("meet at 3: 30"), JSON.stringify(out));
  check("the second speaker still starts a new turn",
    out.split("\n").length === 2 && out.split("\n")[1].startsWith("Sam Osei: "), JSON.stringify(out));
}

{
  const out = vttToPlainTranscript(vtt("header-and-note.vtt"));
  check("WebVTT header metadata never becomes a speaker",
    !/Kind/.test(out) && !/Language/.test(out), JSON.stringify(out));
  check("a NOTE block is not transcript text", !/generated automatically/.test(out), JSON.stringify(out));
  check("the header/NOTE fixture leaves exactly its one real line",
    out === "Morgan Diaz: Recording is on, so let's start with the inventory question.", JSON.stringify(out));
}

{
  const out = vttToPlainTranscript(vtt("unattributed.vtt"));
  check("a transcript with no speaker labels is kept, not silently dropped",
    out === [
      "Good morning everyone, thanks for joining on short notice.",
      "We will start with the quarterly numbers and then the hiring plan.",
    ].join("\n"),
    JSON.stringify(out));
  check("comma-decimal cue timings are recognised as timings",
    !out.includes("-->"), JSON.stringify(out));
}

check("an empty or missing VTT parses to an empty string",
  vttToPlainTranscript("") === "" && vttToPlainTranscript(null) === "" && vttToPlainTranscript(undefined) === "");

/* ================================================= signature verification */

{
  const body = JSON.stringify(transcriptEvent());
  const ts = Date.now();
  const good = `v0=${sign(SECRET, `v0:${ts}:${body}`)}`;

  const okResult = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: good, timestamp: ts, now: ts });
  check("a correctly signed, fresh body verifies", okResult.ok === true, JSON.stringify(okResult));

  const flipped = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
  const badBytes = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: flipped, timestamp: ts, now: ts });
  check("a same-length signature with wrong bytes is refused",
    badBytes.ok === false && badBytes.reason === "bad_signature", JSON.stringify(badBytes));

  const short = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: "v0=deadbeef", timestamp: ts, now: ts });
  check("a wrong-length signature is refused", short.ok === false && short.reason === "bad_signature");

  const otherSecret = await verifyZoomSignature({
    secret: SECRET, rawBody: body, timestamp: ts, now: ts,
    signature: `v0=${sign("a-different-secret", `v0:${ts}:${body}`)}`,
  });
  check("a signature made with a different secret is refused", otherSecret.ok === false);

  const stale = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: good, timestamp: ts, now: ts + 6 * 60 * 1000 });
  check("a body older than five minutes is refused as a replay",
    stale.ok === false && stale.reason === "stale_timestamp", JSON.stringify(stale));

  const future = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: good, timestamp: ts, now: ts - 6 * 60 * 1000 });
  check("a timestamp six minutes in the future is refused too", future.ok === false && future.reason === "stale_timestamp");

  const edge = await verifyZoomSignature({ secret: SECRET, rawBody: body, signature: good, timestamp: ts, now: ts + 4 * 60 * 1000 });
  check("four minutes old is still inside the window", edge.ok === true);

  const noSecret = await verifyZoomSignature({ secret: "", rawBody: body, signature: good, timestamp: ts, now: ts });
  check("verification with no secret fails closed", noSecret.ok === false && noSecret.reason === "no_secret");

  check("the module's HMAC agrees with an independent node:crypto HMAC",
    (await zoomHmacHex(SECRET, "v0:1:{}")) === sign(SECRET, "v0:1:{}"));
}

/* --------------------------------------------- the timestamp's unit */
{
  // Whether Zoom's header is epoch seconds or epoch milliseconds is not
  // verifiable without a live Zoom account. Guessing wrong would reject every
  // real event as stale, forever, with a 401 indistinguishable from an
  // attacker being refused — and unlike the reference, there is no cron here
  // to quietly cover for it. So both units are accepted.
  const nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);

  check("an epoch-milliseconds timestamp passes through unchanged",
    zoomTimestampToMs(nowMs) === nowMs);
  check("an epoch-seconds timestamp is scaled to milliseconds",
    zoomTimestampToMs(nowSeconds) === nowSeconds * 1000);
  check("a string timestamp is accepted, as headers always arrive",
    zoomTimestampToMs(String(nowMs)) === nowMs);
  check("junk is null, never coerced to 0 and treated as 1970",
    zoomTimestampToMs("not-a-number") === null && zoomTimestampToMs("") === null &&
    zoomTimestampToMs(0) === null && zoomTimestampToMs(-5) === null);

  const body = JSON.stringify({ event: ZOOM_TRANSCRIPT_EVENT });
  // The signature is over the header's ORIGINAL characters either way: Zoom
  // signed those, so normalizing before hashing would break every signature.
  const secondsSig = `v0=${sign(SECRET, `v0:${nowSeconds}:${body}`)}`;
  const inSeconds = await verifyZoomSignature({
    secret: SECRET, rawBody: body, signature: secondsSig, timestamp: String(nowSeconds), now: nowMs,
  });
  check("a fresh event timestamped in SECONDS verifies and is not called stale",
    inSeconds.ok === true, JSON.stringify(inSeconds));

  const msSig = `v0=${sign(SECRET, `v0:${nowMs}:${body}`)}`;
  const inMs = await verifyZoomSignature({
    secret: SECRET, rawBody: body, signature: msSig, timestamp: String(nowMs), now: nowMs,
  });
  check("a fresh event timestamped in MILLISECONDS verifies too", inMs.ok === true, JSON.stringify(inMs));

  const staleSeconds = Math.floor((nowMs - 6 * 60 * 1000) / 1000);
  const staleSig = `v0=${sign(SECRET, `v0:${staleSeconds}:${body}`)}`;
  const refused = await verifyZoomSignature({
    secret: SECRET, rawBody: body, signature: staleSig, timestamp: String(staleSeconds), now: nowMs,
  });
  check("accepting seconds does NOT weaken the replay window for seconds",
    refused.ok === false && refused.reason === "stale_timestamp", JSON.stringify(refused));
}

/* ============================================ route: fail closed, no secret */

{
  const env = mkEnv({ secret: null });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const response = await worker.fetch(signedRequest(transcriptEvent()), env, ctx);
  check("with no webhook secret set, a signed event is refused 503", response.status === 503, String(response.status));
  const challenge = await worker.fetch(
    signedRequest({ event: "endpoint.url_validation", payload: { plainToken: "abc" } }),
    env, ctx,
  );
  const challengeBody = await challenge.json();
  check("with no webhook secret set, even the validation challenge is refused",
    challenge.status === 503 && !challengeBody.encryptedToken, JSON.stringify(challengeBody));
  check("a fail-closed refusal starts no background work", pending.length === 0);
}

/* ===================================================== route: the handshake */

{
  const env = mkEnv();
  const plainToken = "qgg8vlvZRS6UYooatFL8Aw";
  const response = await worker.fetch(
    // Zoom signs nothing on the challenge, so this deliberately carries no
    // valid signature: answering it must not depend on one.
    new Request("https://brain.example/api/webhooks/zoom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken } }),
    }),
    env, { waitUntil() {} },
  );
  const body = await response.json();
  check("the URL-validation challenge is answered 200", response.status === 200, String(response.status));
  check("the challenge echoes the plainToken it was sent", body.plainToken === plainToken, JSON.stringify(body));
  check("the challenge returns HMAC-SHA256(secret, plainToken) as hex",
    body.encryptedToken === sign(SECRET, plainToken), JSON.stringify(body));
}

/* ======================================================== route: the gate */

{
  const env = mkEnv();
  const notFound = await worker.fetch(
    new Request("https://brain.example/api/webhooks/zoom"), env, { waitUntil() {} },
  );
  check("GET on the webhook route is not a route", notFound.status === 404, String(notFound.status));

  const noKey = await worker.fetch(
    signedRequest(transcriptEvent()), env, { waitUntil() {} },
  );
  check("the webhook needs no admin key: Zoom cannot send one", noKey.status !== 401, String(noKey.status));

  const badSig = await worker.fetch(
    signedRequest(transcriptEvent(), { secret: "wrong-secret" }), env, { waitUntil() {} },
  );
  const badBody = await badSig.json();
  check("a wrongly signed event is refused 401", badSig.status === 401, String(badSig.status));
  check("the refusal names no failing check an attacker could iterate against",
    JSON.stringify(badBody) === JSON.stringify({ error: "unauthorized" }), JSON.stringify(badBody));

  const stale = await worker.fetch(
    signedRequest(transcriptEvent(), { timestamp: Date.now() - 6 * 60 * 1000 }), env, { waitUntil() {} },
  );
  check("a correctly signed but stale body is refused 401", stale.status === 401, String(stale.status));

  // Signing a re-serialized copy of the body must not verify: the signature
  // covers the exact bytes received, and re-serializing changes whitespace.
  const pretty = JSON.stringify(transcriptEvent(), null, 2);
  const ts = Date.now();
  const compactSignature = `v0=${sign(SECRET, `v0:${ts}:${JSON.stringify(JSON.parse(pretty))}`)}`;
  const reserialized = await worker.fetch(
    signedRequest(null, { raw: pretty, timestamp: ts, signature: compactSignature }), env, { waitUntil() {} },
  );
  check("a signature over re-serialized JSON does not verify (raw bytes are signed)",
    reserialized.status === 401, String(reserialized.status));

  const rawOk = await worker.fetch(
    signedRequest(null, { raw: pretty, timestamp: ts }), env, { waitUntil() {} },
  );
  check("the same pretty-printed body signed as sent does verify", rawOk.status === 200, String(rawOk.status));

  const badJson = await worker.fetch(
    new Request("https://brain.example/api/webhooks/zoom", { method: "POST", body: "not json" }),
    env, { waitUntil() {} },
  );
  check("an unparseable body is a 400, not a crash", badJson.status === 400, String(badJson.status));
}

/* ================================================== route: which events act */

{
  const env = mkEnv();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const completed = await worker.fetch(
    signedRequest({ event: "recording.completed", payload: { object: { uuid: UUID } } }), env, ctx,
  );
  const body = await completed.json();
  check("recording.completed is acknowledged and NOT acted on (the VTT is not written yet)",
    completed.status === 200 && body.ignored === "recording.completed" && pending.length === 0,
    JSON.stringify(body));

  const noUuid = await worker.fetch(
    signedRequest({ event: ZOOM_TRANSCRIPT_EVENT, payload: { object: { topic: "no uuid here" } } }), env, ctx,
  );
  const noUuidBody = await noUuid.json();
  check("a transcript event with no uuid is acknowledged rather than retried forever",
    noUuid.status === 200 && /no recording uuid/.test(noUuidBody.ignored || "") && pending.length === 0,
    JSON.stringify(noUuidBody));
}

{
  const env = mkEnv({ extra: { VECTOR_DRAIN_MODE: "paused-for-upgrade" } });
  const pending = [];
  const paused = await worker.fetch(
    signedRequest(transcriptEvent()), env, { waitUntil: (p) => pending.push(p) },
  );
  const body = await paused.json();
  check("a paused install refuses the transcript rather than silently dropping it",
    paused.status === 503 && body.paused === true && pending.length === 0, JSON.stringify(body));
}

/* ============================================ the fetch, parse, ingest path */

{
  const env = mkEnv();
  const zoom = mkZoomFetch();
  const sink = mkIngest();
  const receipts = [];
  const response = await handleZoomWebhook(env, signedRequest(transcriptEvent()), null, {
    fetchImpl: zoom.fetchImpl,
    ingest: sink.ingest,
    recordReceipt: async (_env, detail) => { receipts.push(detail); return true; },
  });
  check("a verified transcript event is acknowledged 200", response.status === 200, String(response.status));

  const [envelope] = sink.envelopes;
  check("exactly one document is written for one recording", sink.envelopes.length === 1, String(sink.envelopes.length));
  check("the envelope is keyed on the per-occurrence uuid, which is what makes a redelivery a no-op",
    envelope?.source_type === "zoom" && envelope?.source_id === UUID, JSON.stringify(envelope?.source_id));
  check("the meeting topic becomes the title",
    envelope?.title === "Quarterly review with the partnership team", String(envelope?.title));
  check("the meeting start time becomes a reliable document date",
    envelope?.occurred_at === "2026-08-20T17:00:00.000Z" && envelope?.date_reliable === true &&
      envelope?.date_source === "zoom:recording_start_time",
    JSON.stringify({ at: envelope?.occurred_at, reliable: envelope?.date_reliable }));
  check("the content is the parsed transcript, with no cue numbers",
    envelope?.content.startsWith("Alex Rivera: Thanks for making time") &&
      !/(^|\n)\s*\d+\s*(\n|$)/.test(envelope?.content || ""),
    JSON.stringify(envelope?.content));
  check("the document carries platform and meeting metadata",
    envelope?.metadata?.platform === "zoom" && envelope?.metadata?.category === "meeting" &&
      envelope?.metadata?.zoom_meeting_id === String(MEETING_ID) && envelope?.metadata?.duration_minutes === 42,
    JSON.stringify(envelope?.metadata));
  check("the named source records a receipt so `brain sources` can see the load", receipts.length === 1);

  const tokenCall = zoom.calls.find((c) => c.url.startsWith("https://zoom.us/oauth/token"));
  check("the token is a Server-to-Server account_credentials grant",
    /grant_type=account_credentials/.test(tokenCall?.init?.body || "") &&
      /account_id=zoom-account-fixture/.test(tokenCall?.init?.body || ""),
    String(tokenCall?.init?.body));
  check("the token exchange authenticates with Basic base64(clientId:clientSecret)",
    tokenCall?.init?.headers?.Authorization ===
      `Basic ${Buffer.from("zoom-client-fixture:zoom-client-secret-fixture").toString("base64")}`,
    String(tokenCall?.init?.headers?.Authorization));

  const recordingCall = zoom.calls.find((c) => c.url.includes("/v2/meetings/"));
  check("the recording is fetched by DOUBLE-encoded uuid, per Zoom's own convention",
    recordingCall?.url === `https://api.zoom.us/v2/meetings/${encodeURIComponent(encodeURIComponent(UUID))}/recordings`,
    String(recordingCall?.url));
  check("the shared meeting id is never used as the path identity (recurring meetings reuse it)",
    !recordingCall?.url.includes(String(MEETING_ID)), String(recordingCall?.url));
  check("the transcript download carries the access token",
    zoom.calls.some((c) => c.url === `${DOWNLOAD_URL}?access_token=zoom-access-token-fixture`),
    JSON.stringify(zoom.calls.map((c) => c.url)));
}

check("double encoding is exactly two passes of encodeURIComponent",
  zoomRecordingPathId(UUID) === "aB3%252FxY9z%252BQw%253D%253D", zoomRecordingPathId(UUID));

/* ============================================== transcript missing or empty */

{
  const env = mkEnv();
  const zoom = mkZoomFetch({
    recordingFiles: [{ file_type: "MP4", download_url: "https://download.zoom.us.example/rec/video/fixture" }],
  });
  const sink = mkIngest();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const response = await handleZoomWebhook(env, signedRequest(transcriptEvent()), null, {
      fetchImpl: zoom.fetchImpl, ingest: sink.ingest, recordReceipt: async () => true,
    });
    check("a recording with no transcript file writes no document",
      response.status === 200 && sink.envelopes.length === 0, String(sink.envelopes.length));
    check("and says why, naming the Zoom setting rather than going quiet",
      warnings.join(" ").includes("Audio Transcript"), warnings.join(" "));
  } finally {
    console.warn = originalWarn;
  }
}

{
  const env = mkEnv();
  const zoom = mkZoomFetch({ recordingStatus: 403 });
  const sink = mkIngest();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    await handleZoomWebhook(env, signedRequest(transcriptEvent()), null, {
      fetchImpl: zoom.fetchImpl, ingest: sink.ingest, recordReceipt: async () => true,
    });
    check("a 403 from Zoom names the missing scope instead of a bare status",
      errors.join(" ").includes(ZOOM_REQUIRED_SCOPE) && sink.envelopes.length === 0, errors.join(" "));
  } finally {
    console.error = originalError;
  }
}

/* ======================================================= the credential gate */

{
  // The default ingest path, not an injected one: this is the gate that must
  // run on every door. The store is rigged to fail loudly if it is reached.
  let storeTouched = false;
  const env = mkEnv({
    extra: {
      VECTORIZE: {},
      DB: {
        prepare() { storeTouched = true; throw new Error("the store must not be reached for a refused document"); },
        batch() { storeTouched = true; throw new Error("the store must not be reached for a refused document"); },
      },
    },
  });
  const leaked = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nSam Osei: the deploy key is AKIAZXMPLE4TESTKEY01 if you need it\n";
  const zoom = mkZoomFetch({ transcript: leaked });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const response = await handleZoomWebhook(env, signedRequest(transcriptEvent()), null, {
      fetchImpl: zoom.fetchImpl,
      ingest: gatedIngest,
      recordReceipt: async () => true,
    });
    check("a transcript carrying a live credential is refused before the store",
      response.status === 200 && storeTouched === false, String(storeTouched));
    check("the refusal names the credential kind and never quotes its value",
      /aws_access_key/.test(warnings.join(" ")) && !warnings.join(" ").includes("AKIAZXMPLE4TESTKEY01"),
      warnings.join(" "));
  } finally {
    console.warn = originalWarn;
  }
}

{
  // The mirror image: ordinary meeting prose must pass the gate and reach the
  // store. A sentinel throw from the store proves it got that far without
  // standing up a whole D1.
  let reachedStore = false;
  const env = {
    STORAGE: "d1",
    VECTORIZE: {},
    DB: { prepare() { reachedStore = true; throw new Error("sentinel: store reached"); } },
  };
  try {
    await gatedIngest(env, {
      source_type: "zoom", source_id: "u", title: "t", content: "ordinary meeting prose",
    });
  } catch { /* the sentinel is the assertion */ }
  check("a clean transcript passes the gate and reaches the store", reachedStore === true);
}

/* ============================================================== plan tier */

{
  const basic = describeZoomPlan(1);
  check("plan type 1 is Basic and is reported as unable to cloud record",
    basic.label === "Basic" && basic.cloudRecording === false && /Licensed/.test(basic.detail),
    JSON.stringify(basic));
  check("plan type 2 is Licensed and can cloud record",
    describeZoomPlan(2).label === "Licensed" && describeZoomPlan(2).cloudRecording === true);
  check("plan type 3 is on-prem and can cloud record", describeZoomPlan(3).cloudRecording === true);
  const unknown = describeZoomPlan(undefined);
  check("an unrecognised plan type is reported as unknown, never assumed fine",
    unknown.cloudRecording === null && /could not be confirmed/.test(unknown.detail), JSON.stringify(unknown));
}

/* ============================================================== envelope */

{
  const undated = buildZoomEnvelope({ uuid: "u", topic: null, startTime: null, transcript: "text" });
  check("a recording with no start time is not given a fabricated reliable date",
    undated.occurred_at === null && undated.date_reliable === false && undated.date_source === null,
    JSON.stringify(undated));
  check("a recording with no topic still gets an honest generic title",
    undated.title === "Zoom meeting", undated.title);
}

console.log(fail ? `\n${fail} FAILURES` : `\nzoom: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
