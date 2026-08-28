/**
 * zoom.js — the client-owned Zoom transcript door.
 *
 * WHAT THIS IS. A Zoom cloud recording produces a WebVTT transcript some
 * minutes after the call ends. Zoom then fires a `recording.transcript_completed`
 * webhook. This module verifies that webhook, fetches that one transcript with
 * the client's own Server-to-Server OAuth app, turns the VTT into plain speaker
 * text, and pushes it through the same credential gate and store every other
 * ingest door uses. Nothing here belongs to us: the Zoom app, the Cloudflare
 * worker, the recordings and the four secrets are all in the client's accounts.
 *
 * WHAT THIS DELIBERATELY IS NOT. The reference implementation this was ported
 * from runs a webhook AND a 15-minute cron against the same recordings, so it
 * needs a poll-style sweep, a claim-row table and a 30-minute TTL to stop the
 * two racing each other into duplicate documents. There is no cron here. The
 * webhook names the exact recording in its own payload, so this fetches that
 * one recording and writes one document, and the brain's existing
 * (source_type, source_id) plus content-hash idempotency handles a redelivered
 * webhook for free. It also does no call analysis, no filing and no CRM work.
 * A transcript becomes a searchable, citable, forgettable document. That is all.
 *
 * FAIL CLOSED. With no ZOOM_WEBHOOK_SECRET_TOKEN set, every request is refused
 * before the body is even parsed. An unauthenticated endpoint that triggers
 * outbound authenticated API calls is a hole, not a convenience.
 */

import { jsonResponse } from "./core.js";
import {
  hasSensitiveTransportIdentity,
  scanEnvelope as scanEnvelopeSecrets,
  sanitizeEnvelope as sanitizeIngestEnvelope,
} from "./secret-scan.js";
import { storeFor, backendOf, D1 } from "./store.js";
import { vttToPlainTranscript } from "./vtt.js";

/** The one Zoom scope this connector needs. Anything more is over-asking. */
export const ZOOM_REQUIRED_SCOPE = "cloud_recording:read:admin";

/**
 * The only event subscribed to.
 *
 * NOT `recording.completed`: the audio file lands first and the VTT is written
 * afterwards, so acting on `completed` fetches a recording that has no
 * transcript yet and produces an empty document.
 */
export const ZOOM_TRANSCRIPT_EVENT = "recording.transcript_completed";

/** Zoom's own replay window. A body older than this is refused. */
export const ZOOM_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** The named source every Zoom transcript is loaded under. */
export const ZOOM_SOURCE = "zoom";

/* ------------------------------------------------------------- crypto */

/**
 * Hex HMAC-SHA256, the shape both legs of Zoom's verification want.
 */
export async function zoomHmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(String(message)));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string compare.
 *
 * Deliberately local rather than imported: core.js keeps its own copy private
 * to the admin-key path, and a webhook verifier that quietly depends on another
 * module's unexported internals is a refactor away from silently becoming `===`.
 * Length is not secret, so a length mismatch returns immediately.
 */
export function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Zoom's `x-zm-request-timestamp` as epoch milliseconds, whichever unit it
 * arrived in.
 *
 * The reference implementation asserts epoch milliseconds in a comment. That
 * may well be right, but it is not verifiable without a live Zoom account, and
 * the consequence of it being wrong is not small: every real event would fall
 * outside the replay window and be rejected, forever, with a 401 that looks
 * exactly like an attacker being turned away.
 *
 * The reference could afford that ambiguity because it also runs a 15-minute
 * cron that sweeps for recordings, so a webhook rejecting everything would be
 * silently covered by the poll. This connector is webhook-only by design, so
 * the same mistake here is total silent failure with nothing behind it. Both
 * units are therefore accepted: 1e11 sits between any plausible epoch-seconds
 * value (~1.8e9 today) and any plausible epoch-milliseconds one (~1.8e12).
 *
 * This widens only the REPLAY window. The signature is always computed over
 * the header's exact original characters, because that is what Zoom signed.
 */
export function zoomTimestampToMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Verify a real (non-handshake) Zoom event.
 *
 * Zoom signs `v0:{timestamp}:{raw body}` with the app's Secret Token and sends
 * `v0=<hex>` in `x-zm-signature`. The raw body must be the exact bytes received:
 * re-serializing parsed JSON changes whitespace and key order and breaks this.
 *
 * Returns a reason rather than throwing, so the caller decides the status code
 * and nothing about which check failed leaks into the HTTP response body.
 */
export async function verifyZoomSignature({ secret, rawBody, signature, timestamp, now = Date.now() }) {
  if (!secret) return { ok: false, reason: "no_secret" };
  // The header's original text, never a normalized number: Zoom signed those
  // exact characters, so reformatting them would break every signature.
  const expected = "v0=" + (await zoomHmacHex(secret, `v0:${timestamp ?? ""}:${rawBody ?? ""}`));
  if (!constantTimeEquals(expected, String(signature ?? ""))) {
    return { ok: false, reason: "bad_signature" };
  }
  // Replay guard. A correctly signed body stays correctly signed forever, so
  // without this a captured request could be replayed at will.
  const ts = zoomTimestampToMs(timestamp);
  if (ts === null || Math.abs(now - ts) > ZOOM_REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- vtt */

/**
 * The transcript parser moved to ./vtt.js so the local ingest path can use the
 * SAME one for a `.vtt` a client saved out of a meeting tool by hand. It is
 * re-exported here because this module's own tests and every existing caller
 * import it from `zoom.js`, and because there must be exactly one answer to
 * "how does this product turn captions into text".
 */
export { vttToPlainTranscript } from "./vtt.js";

/* ---------------------------------------------------------- zoom api */

/**
 * Zoom meeting UUIDs are base64 and routinely contain `/` and `+`. Zoom's own
 * documented convention is that a UUID containing `/` or `//` must be DOUBLE
 * url-encoded in a path segment, or their router splits it into path segments
 * and the request 404s.
 */
export function zoomRecordingPathId(uuid) {
  return encodeURIComponent(encodeURIComponent(String(uuid)));
}

/**
 * Server-to-Server OAuth. No browser step, no refresh token: an account-
 * credentials grant exchanged fresh for each burst of calls.
 */
export async function getZoomAccessToken(
  { accountId, clientId, clientSecret },
  { fetchImpl = fetch } = {},
) {
  if (!accountId || !clientId || !clientSecret) {
    const error = new Error("Zoom is not configured on this brain: account id, client id and client secret must all be set.");
    error.zoom_not_configured = true;
    throw error;
  }
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetchImpl("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    const error = new Error(
      response.status === 401
        ? "Zoom rejected these credentials. Check the Account ID, Client ID and Client Secret, and that the Server-to-Server OAuth app is Activated."
        : `Zoom token exchange failed (HTTP ${response.status}): ${detail}`,
    );
    error.zoom_status = response.status;
    throw error;
  }
  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("Zoom returned a token response with no access token. The Server-to-Server OAuth app may need reactivating.");
  }
  return data.access_token;
}

/**
 * Fetch one recording's transcript, named by the per-occurrence UUID.
 *
 * The UUID, never the meeting id. A recurring Zoom meeting reuses ONE meeting
 * id across every occurrence, so `/meetings/{meetingId}/recordings` can return a
 * different occurrence entirely — the reference implementation carries a code
 * comment about a real incident where a June call was filed against a recording
 * from the previous December because of exactly that ambiguity.
 */
export async function fetchZoomTranscript(
  { token, uuid },
  { fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(
    `https://api.zoom.us/v2/meetings/${zoomRecordingPathId(uuid)}/recordings`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    const error = new Error(
      response.status === 404
        ? "Zoom has no recording under that identifier. It may have been deleted from cloud storage."
        : response.status === 403
          ? `Zoom refused the recording read. The Server-to-Server OAuth app needs the ${ZOOM_REQUIRED_SCOPE} scope.`
          : `Zoom recording lookup failed (HTTP ${response.status}): ${detail}`,
    );
    error.zoom_status = response.status;
    throw error;
  }
  const recording = await response.json();
  const files = Array.isArray(recording?.recording_files) ? recording.recording_files : [];
  const transcriptFile = files.find((file) => file?.file_type === "TRANSCRIPT");

  if (!transcriptFile?.download_url) {
    return {
      topic: recording?.topic || null,
      startTime: recording?.start_time || null,
      duration: recording?.duration ?? null,
      hostEmail: recording?.host_email || null,
      hasTranscript: false,
      transcript: "",
      // Named, not guessed. "Nothing happened" is the failure mode this whole
      // product exists to avoid.
      reason: "this recording carries no transcript file. Cloud Recording > Audio Transcript must be on in the Zoom account's recording settings.",
    };
  }

  // Zoom's download URLs are signed but still require the bearer token; the
  // documented way to pass it on a download is the query parameter.
  const download = await fetchImpl(`${transcriptFile.download_url}?access_token=${token}`);
  if (!download.ok) {
    return {
      topic: recording?.topic || null,
      startTime: recording?.start_time || null,
      duration: recording?.duration ?? null,
      hostEmail: recording?.host_email || null,
      hasTranscript: true,
      transcript: "",
      reason: `the transcript file could not be downloaded (HTTP ${download.status}). Zoom may still be writing it.`,
    };
  }

  return {
    topic: recording?.topic || null,
    startTime: recording?.start_time || null,
    duration: recording?.duration ?? null,
    hostEmail: recording?.host_email || null,
    hasTranscript: true,
    transcript: vttToPlainTranscript(await download.text()),
    reason: null,
  };
}

/* ------------------------------------------------------------ plan tier */

/**
 * Zoom plan types, as the API reports them on `/users/me`.
 *
 * Type 1 is Basic and CANNOT cloud record at all, which means it can never
 * produce a transcript, which means this connector can never do anything for
 * that account. Saying so at connect time is the entire point: the alternative
 * is a client who believes their calls are being read and finds out otherwise
 * weeks later, when the missing calls are the ones they wanted to ask about.
 */
export function describeZoomPlan(type) {
  const value = Number(type);
  if (value === 1) {
    return {
      type: 1,
      label: "Basic",
      cloudRecording: false,
      detail: "Basic is Zoom's free tier and has no cloud recording, so it can never produce the transcript this connector reads. A Licensed (paid) seat is required.",
    };
  }
  if (value === 2) return { type: 2, label: "Licensed", cloudRecording: true, detail: null };
  if (value === 3) return { type: 3, label: "On-prem", cloudRecording: true, detail: null };
  return {
    type: Number.isFinite(value) ? value : null,
    label: "unknown",
    cloudRecording: null,
    detail: "Zoom did not report a recognised plan type, so whether this account can cloud record could not be confirmed.",
  };
}

/* -------------------------------------------------------------- ingest */

/**
 * The credential gate plus the store write, without the HTTP shell.
 *
 * Every door into the index runs this. A gate on one door is not a gate, and a
 * webhook that wrote straight to the store would be exactly that missing gate:
 * a meeting where someone reads an API key aloud, or pastes one into the chat
 * that Zoom folds into the transcript, must be refused here like any other
 * document.
 */
export async function gatedIngest(env, envelope) {
  if (hasSensitiveTransportIdentity(envelope)) {
    return { refused: true, labels: ["sensitive_transport_identity"] };
  }
  const clean = sanitizeIngestEnvelope(envelope);
  if (env.CREDENTIAL_SCANNER !== "off") {
    const secrets = scanEnvelopeSecrets(clean);
    // Named, never quoted. The refusal has to be actionable without becoming
    // its own copy of the credential.
    if (secrets.shouldRefuse) return { refused: true, labels: secrets.labels };
  }
  const out = await storeFor(env).ingest(env, clean);
  return { refused: false, ...out };
}

/**
 * Record the load against the named source so `brain sources` can see it and
 * `brain forget --source zoom` can take it back.
 *
 * No refresh expectation is written. Zoom pushes when a call happens, so there
 * is no cadence to be late against, and inventing one would make a quiet week
 * look like a broken connector.
 *
 * This clears `stale_reason`, which is right for the transcript that just
 * landed and WRONG on its own for the source as a whole: an older transcript
 * may still be owed. Every caller therefore runs `reconcileZoomSourceState`
 * immediately after this, which re-states the debt if there is one. Do not
 * separate the pair.
 */
export async function recordZoomSourceReceipt(env, { at = new Date().toISOString(), detail } = {}) {
  if (backendOf(env) !== D1 || !env.DB) return false;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM documents WHERE source = ?1",
  ).bind(ZOOM_SOURCE).first();
  const documents = Number(count?.n || 0);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sources (name, kind, status, created_at, last_ingest_at, document_count, stale_reason)
       VALUES (?1,'zoom','ready',?2,?2,?3,NULL)
       ON CONFLICT(name) DO UPDATE SET
         kind='zoom', status='ready', last_ingest_at=excluded.last_ingest_at,
         document_count=excluded.document_count, stale_reason=NULL`,
    ).bind(ZOOM_SOURCE, at, documents),
    env.DB.prepare(
      "INSERT INTO source_events (source_name,event,at,documents,detail) VALUES (?1,'ingest',?2,?3,?4)",
    ).bind(ZOOM_SOURCE, at, documents, String(detail || "zoom transcript webhook").slice(0, 500)),
  ]);
  return true;
}

/**
 * Build the one envelope a transcript becomes.
 *
 * `source_id` is the per-occurrence UUID, which is what makes a redelivered
 * webhook a no-op: the store keys on (source_type, source_id) and compares a
 * content hash, so the second delivery reports `unchanged` and writes nothing.
 * That is why this connector needs no dedupe table of its own.
 */
export function buildZoomEnvelope({ uuid, meetingId, topic, startTime, duration, hostEmail, transcript }) {
  const occurredAt = startTime && Number.isFinite(Date.parse(startTime))
    ? new Date(startTime).toISOString()
    : null;
  return {
    source_type: ZOOM_SOURCE,
    source_id: String(uuid),
    title: topic || "Zoom meeting",
    content: transcript,
    occurred_at: occurredAt,
    // Zoom states the meeting's own start time. That is an event date, not a
    // file mtime or a name guessed out of a filename, so it is allowed to
    // count as reliable for recency claims.
    date_source: occurredAt ? "zoom:recording_start_time" : null,
    date_reliable: Boolean(occurredAt),
    uri: null,
    metadata: {
      category: "meeting",
      platform: "zoom",
      ...(meetingId ? { zoom_meeting_id: String(meetingId) } : {}),
      ...(Number.isFinite(Number(duration)) ? { duration_minutes: Number(duration) } : {}),
      ...(hostEmail ? { zoom_host_email: String(hostEmail) } : {}),
    },
  };
}

/* --------------------------------------------------------- durability */

/**
 * WHY A LEDGER, AND WHY IT IS WRITTEN BEFORE THE ACKNOWLEDGEMENT.
 *
 * The constraint that shapes everything here: Zoom treats a slow response as a
 * failure and disables an endpoint that keeps failing, so the 200 has to go out
 * before any of the real work. Every expensive step therefore lives on the far
 * side of the acknowledgement — the OAuth exchange, the recording lookup, the
 * transcript download, the credential gate, the store write — and Zoom will
 * never send that delivery again once it has been acknowledged. Until this
 * change, a failure in any of those steps was a `console.warn` and a return.
 * The call was not in the brain, nothing counted it, nothing reported it, and
 * the only trace was a log line in the client's own Cloudflare account. That is
 * the same shape of defect as answering "nothing recorded" from a search that
 * never ran: the system's silence looked like the world's silence.
 *
 * WHAT WAS CHOSEN. One D1 row, written synchronously in the request path,
 * before the acknowledgement. From that instant the transcript is a debt owed
 * by this brain rather than a hope pinned on a background promise.
 *
 *   - Fast enough to keep the acknowledgement fast. One INSERT against the
 *     binding this worker already holds, no provider call, no embedding.
 *   - If that INSERT cannot be made, the webhook answers 503 instead of 200,
 *     which keeps the delivery on ZOOM's retry schedule. An unrecorded
 *     obligation is exactly the defect being fixed, so it must not be
 *     acknowledged. This is the same trade the paused-for-upgrade branch above
 *     already makes, for the same reason.
 *   - The failure is RETRIED, not merely logged, by the drain cron that every
 *     D1 install is already required to run (`brain deploy` refuses to leave a
 *     D1 install without it). No second scheduler, no queue product, no Durable
 *     Object: the deferred-work pattern this codebase already uses is an outbox
 *     table plus that tick, and this is that pattern applied to a second kind
 *     of owed work.
 *   - The debt becomes VISIBLE through the surface the client already reads.
 *     A debt older than its grace window sets `sources.stale_reason` on the
 *     `zoom` row, which `freshnessReport` already renders as BROKEN in
 *     `brain sources` and `brain health`, which `acceptance.mjs` already fails
 *     on, and which `coverageGaps` already attaches to EVERY answer the brain
 *     gives. That last one is the point: the owner learns a call is missing
 *     while asking about something else, without ever having suspected it.
 *
 * WHAT WAS REJECTED, and why:
 *
 *   - Cloudflare Queues. A second binding, a second thing to provision in the
 *     client's account, and a second thing that can be missing at install time.
 *     The retry budget here is a handful of rows a day.
 *   - A Durable Object per recording. Same objection, plus a migration class to
 *     maintain forever for work that is already keyed by a uuid in D1.
 *   - Doing the work before the 200. It is the one option Zoom's own timeout
 *     rules out.
 *   - A polling sweep of Zoom's recordings list. That is a different feature
 *     (it would also find recordings never delivered at all — see
 *     `zoomNeverDeliveredIsNotDetectable` below), it needs a Zoom scope this
 *     connector deliberately does not ask for, and it reintroduces the second
 *     writer this connector was designed to avoid. Out of scope here, which is
 *     durability of what Zoom DID deliver.
 */

/** Retries before a delivery is written off. Six attempts spans about a day. */
export const ZOOM_DELIVERY_MAX_ATTEMPTS = 6;

/**
 * Backoff per completed attempt. Front-loaded because the most common real
 * failure is Zoom still writing the transcript file, which resolves in minutes;
 * stretched at the end so a genuinely dead recording stops costing calls.
 */
export const ZOOM_RETRY_BACKOFF_MS = [
  5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000,
  2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000,
];

/**
 * How long a transcript may be owed before the source is called broken.
 *
 * Not zero, deliberately. Zoom announces a transcript that it is sometimes
 * still writing, so the first attempt failing is ordinary and self-correcting.
 * Raising an alarm on it would put a red line on `brain sources` and a gap on
 * every answer several times a week for something that fixes itself in five
 * minutes, and a warning that fires for nothing is how a client learns to
 * ignore the warning that matters.
 */
export const ZOOM_OWED_GRACE_MS = 60 * 60 * 1000;

/**
 * How long a written-off delivery keeps driving the alarm.
 *
 * The row itself is kept forever; this window governs only whether it still
 * makes the SOURCE read broken. A permanent alarm for a call that can no longer
 * be recovered is a nag nobody can clear, which is the failure mode above in a
 * different costume. Two weeks of it on every answer is loud, and after that
 * the record is still in `zoom_deliveries` for anyone who looks, and a new
 * failure raises the alarm again.
 */
export const ZOOM_ABANDONED_ALERT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Deliveries retried per sweep. The tick is every five minutes. */
export const ZOOM_SWEEP_LIMIT = 5;

/** A settled, stored delivery is history after this. Failures are never pruned. */
export const ZOOM_DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** How long one sweep may hold a claimed row before another sweep may take it. */
export const ZOOM_CLAIM_LEASE_MS = 10 * 60 * 1000;

export function zoomRetryDelayMs(attempts) {
  const index = Math.max(0, Math.min(ZOOM_RETRY_BACKOFF_MS.length - 1, Number(attempts) || 0));
  return ZOOM_RETRY_BACKOFF_MS[index];
}

/**
 * The ledger is a D1 table, so a Supabase-backed install has none.
 *
 * Said plainly rather than papered over: on that backend this connector is
 * exactly as durable as it was before, which is not durable. The Supabase
 * adapter exists as a migration and rollback path, and refusing every Zoom
 * delivery on it would be a worse answer than processing it and saying so. The
 * acknowledgement carries `durable: false` when that is the case.
 */
export function zoomLedgerAvailable(env) {
  return backendOf(env) === D1 && Boolean(env?.DB);
}

/**
 * A schema that predates this table, told apart from a database that is down.
 *
 * `brain deploy` uploads the worker and `brain migrate` applies the SQL, in
 * that order, so there is a real window where this code is live and
 * `zoom_deliveries` does not exist. Treating that as "D1 is broken" would 503
 * every Zoom delivery until someone migrated. Treating a genuine D1 outage as
 * "no table" would silently drop transcripts. So they are separated, and only
 * the first one degrades quietly.
 */
export function isMissingLedgerTable(error) {
  return /no such table/i.test(String(error?.message || error));
}

const ledgerText = (value, max = 200) =>
  value === null || value === undefined || value === "" ? null : String(value).slice(0, max);

/**
 * Write down that this transcript is owed. Runs BEFORE the acknowledgement.
 *
 * A redelivery of something already stored must not reopen the debt, and a
 * redelivery of something the credential gate refused must not either: retrying
 * it would refuse it again, and flipping the row back to owed would turn a
 * deliberate refusal into a phantom failure. Everything else reopens, with its
 * attempt count reset, because a second announcement from Zoom is new evidence
 * that the recording exists.
 */
export async function recordZoomDeliveryOwed(env, delivery = {}, { now = Date.now() } = {}) {
  const uuid = String(delivery.uuid || "");
  if (!uuid) throw new Error("a zoom delivery cannot be recorded without its recording uuid");
  // The first retry is scheduled past the inline attempt that is about to run,
  // so the five-minute sweep cannot pick up a row that is already in flight.
  const firstRetryAt = now + zoomRetryDelayMs(0);
  const result = await env.DB.prepare(
    `INSERT INTO zoom_deliveries
       (uuid, meeting_id, topic, start_time, host_email, received_at, state, attempts, next_attempt_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owed', 0, ?7)
     ON CONFLICT(uuid) DO UPDATE SET
       meeting_id = COALESCE(excluded.meeting_id, zoom_deliveries.meeting_id),
       topic      = COALESCE(excluded.topic, zoom_deliveries.topic),
       start_time = COALESCE(excluded.start_time, zoom_deliveries.start_time),
       host_email = COALESCE(excluded.host_email, zoom_deliveries.host_email),
       received_at = CASE WHEN zoom_deliveries.state IN ('stored','refused')
                          THEN zoom_deliveries.received_at ELSE excluded.received_at END,
       state       = CASE WHEN zoom_deliveries.state IN ('stored','refused')
                          THEN zoom_deliveries.state ELSE 'owed' END,
       attempts    = CASE WHEN zoom_deliveries.state IN ('stored','refused')
                          THEN zoom_deliveries.attempts ELSE 0 END,
       next_attempt_at = CASE WHEN zoom_deliveries.state IN ('stored','refused')
                          THEN zoom_deliveries.next_attempt_at ELSE ?7 END,
       settled_at  = CASE WHEN zoom_deliveries.state IN ('stored','refused')
                          THEN zoom_deliveries.settled_at ELSE NULL END`,
  ).bind(
    uuid,
    ledgerText(delivery.meetingId, 64),
    ledgerText(delivery.topic, 200),
    ledgerText(delivery.startTime, 40),
    ledgerText(delivery.hostEmail, 200),
    now,
    firstRetryAt,
  ).run();
  return { recorded: true, changes: Number(result?.meta?.changes ?? 1) };
}

/** Settle a delivery: it landed, or it was refused, or it is written off. */
export async function settleZoomDelivery(env, uuid, { state, error = null, now = Date.now() } = {}) {
  await env.DB.prepare(
    `UPDATE zoom_deliveries
        SET state = ?2, settled_at = ?3, last_attempt_at = ?3,
            next_attempt_at = NULL, last_error = ?4
      WHERE uuid = ?1`,
  ).bind(String(uuid), String(state), now, ledgerText(error, 400)).run();
  return { uuid: String(uuid), state };
}

/**
 * The attempt failed. Keep the debt, record why, and schedule the next try.
 *
 * `burnAttempt: false` records the reason without spending one of the six
 * attempts. That is for failures where trying again is not the useful response
 * and writing the delivery off would be a lie about what happened — the only
 * one today is Zoom being unconfigured on this brain, where the recording is
 * still in Zoom's cloud and reconnecting recovers it.
 */
export async function deferZoomDelivery(env, uuid, { error = null, now = Date.now(), burnAttempt = true } = {}) {
  const row = await env.DB.prepare(
    "SELECT attempts FROM zoom_deliveries WHERE uuid = ?1",
  ).bind(String(uuid)).first();
  const attempts = Number(row?.attempts || 0) + (burnAttempt ? 1 : 0);
  if (burnAttempt && attempts >= ZOOM_DELIVERY_MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE zoom_deliveries
          SET state = 'abandoned', attempts = ?2, last_attempt_at = ?3,
              settled_at = ?3, next_attempt_at = NULL, last_error = ?4
        WHERE uuid = ?1`,
    ).bind(String(uuid), attempts, now, ledgerText(error, 400)).run();
    return { uuid: String(uuid), state: "abandoned", attempts };
  }
  await env.DB.prepare(
    `UPDATE zoom_deliveries
        SET state = 'owed', attempts = ?2, last_attempt_at = ?3,
            next_attempt_at = ?4, last_error = ?5
      WHERE uuid = ?1`,
  ).bind(String(uuid), attempts, now, now + zoomRetryDelayMs(attempts), ledgerText(error, 400)).run();
  return { uuid: String(uuid), state: "owed", attempts };
}

/**
 * Take exclusive ownership of one due row for this sweep.
 *
 * Pushing `next_attempt_at` out by a bounded lease is the whole mechanism: a
 * concurrent sweep sees the row as not due and leaves it alone, and an isolate
 * that dies mid-attempt loses nothing, because the lease expires and the row is
 * still owed with its attempt count unspent. No claim table, no TTL sweeper.
 */
export async function claimZoomDelivery(env, uuid, { now = Date.now() } = {}) {
  const result = await env.DB.prepare(
    `UPDATE zoom_deliveries
        SET last_attempt_at = ?2, next_attempt_at = ?3
      WHERE uuid = ?1 AND state = 'owed'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)`,
  ).bind(String(uuid), now, now + ZOOM_CLAIM_LEASE_MS).run();
  return Number(result?.meta?.changes || 0) === 1;
}

/** What the ledger currently says is missing, and which recording it is. */
export async function zoomDeliveryBacklog(env, { now = Date.now() } = {}) {
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN state = 'owed' THEN 1 ELSE 0 END) AS owed,
       SUM(CASE WHEN state = 'owed' AND received_at <= ?1 THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
       SUM(CASE WHEN state = 'abandoned' AND settled_at >= ?2 THEN 1 ELSE 0 END) AS abandoned_recent,
       SUM(CASE WHEN state = 'refused' THEN 1 ELSE 0 END) AS refused,
       SUM(CASE WHEN state = 'stored' THEN 1 ELSE 0 END) AS stored
     FROM zoom_deliveries`,
  ).bind(now - ZOOM_OWED_GRACE_MS, now - ZOOM_ABANDONED_ALERT_WINDOW_MS).first();
  // The oldest thing still missing, named. A count alone is an alarm; the topic
  // and the date are what let the owner go and look.
  const oldest = await env.DB.prepare(
    `SELECT uuid, topic, start_time, received_at, attempts, state, last_error
       FROM zoom_deliveries
      WHERE (state = 'owed' AND received_at <= ?1)
         OR (state = 'abandoned' AND settled_at >= ?2)
      ORDER BY received_at ASC LIMIT 1`,
  ).bind(now - ZOOM_OWED_GRACE_MS, now - ZOOM_ABANDONED_ALERT_WINDOW_MS).first();
  return {
    owed: Number(counts?.owed || 0),
    overdue: Number(counts?.overdue || 0),
    abandoned: Number(counts?.abandoned || 0),
    abandoned_recent: Number(counts?.abandoned_recent || 0),
    refused: Number(counts?.refused || 0),
    stored: Number(counts?.stored || 0),
    oldest_missing: oldest
      ? {
        uuid: oldest.uuid,
        topic: oldest.topic || null,
        start_time: oldest.start_time || null,
        state: oldest.state,
        attempts: Number(oldest.attempts || 0),
        last_error: oldest.last_error || null,
      }
      : null,
  };
}

/**
 * The sentence a client reads. Written to be actionable on its own, because it
 * arrives in places with no room for a second paragraph: one line in
 * `brain sources`, one gap beside an answer.
 */
export function describeZoomBacklog(backlog, { configured = true } = {}) {
  const missing = Number(backlog?.overdue || 0) + Number(backlog?.abandoned_recent || 0);
  if (missing <= 0) return null;
  const oldest = backlog.oldest_missing;
  // A truncated error must LOOK truncated. Cutting Zoom's own sentence at a
  // fixed width once produced "needs the cloud_recording:read." — a scope name
  // that reads as complete and is wrong, which is worse than saying less.
  const clipped = (value, max) => {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
  };
  const named = oldest
    ? ` The oldest is ${oldest.topic ? `"${clipped(oldest.topic, 80)}"` : "an untitled meeting"}${
      oldest.start_time ? ` from ${String(oldest.start_time).slice(0, 10)}` : ""
    }${oldest.last_error ? `, last failing with: ${clipped(oldest.last_error, 200).replace(/\.+$/, "")}` : ""}.`
    : "";
  const tail = !configured
    ? " Zoom is no longer configured on this brain, so nothing can fetch them until it is reconnected."
    : Number(backlog.abandoned_recent || 0) > 0
      ? " Retries are exhausted for some of them. If Audio Transcript is off in the Zoom account's recording settings, no transcript was ever written and turning it on only helps future calls."
      : " They are retried automatically every few minutes.";
  // No trailing full stop, matching every other `stale_reason` this brain
  // writes: `coverageGaps` composes it into a longer sentence and would
  // otherwise print two in a row.
  return `${missing} Zoom transcript(s) that Zoom reported ready are not in the brain.${named}${tail}`
    .slice(0, 500)
    .replace(/\.+$/, "");
}

/**
 * Turn the ledger into the one thing the client already looks at.
 *
 * No new dashboard and no new endpoint. `sources.stale_reason` is the existing
 * field for "why this source stopped being current", `freshnessReport` already
 * renders it as BROKEN, and `coverageGaps` already puts it in front of every
 * answer. Writing there is the whole reporting mechanism.
 */
export async function reconcileZoomSourceState(env, { now = Date.now() } = {}) {
  const backlog = await zoomDeliveryBacklog(env, { now });
  const configured = Boolean(env?.ZOOM_WEBHOOK_SECRET_TOKEN);
  const reason = describeZoomBacklog(backlog, { configured });
  const at = new Date(now).toISOString();
  if (reason) {
    // Upsert, because a brain whose very first delivery fails has no sources
    // row yet, and that is exactly the install where silence is most expensive.
    await env.DB.prepare(
      `INSERT INTO sources (name, kind, status, created_at, stale_reason)
       VALUES (?1, 'zoom', 'error', ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET status = 'error', stale_reason = excluded.stale_reason`,
    ).bind(ZOOM_SOURCE, at, reason).run();
    return { state: "broken", reason, backlog };
  }
  // Only this connector writes the zoom row's status, so clearing it here
  // cannot erase another writer's finding.
  await env.DB.prepare(
    `UPDATE sources
        SET status = CASE WHEN status = 'error' THEN 'ready' ELSE status END,
            stale_reason = NULL
      WHERE name = ?1 AND (stale_reason IS NOT NULL OR status = 'error')`,
  ).bind(ZOOM_SOURCE).run();
  return { state: "ok", reason: null, backlog };
}

/** Settled, stored rows are history. Failed ones are the record and are kept. */
export async function pruneZoomDeliveries(env, { now = Date.now() } = {}) {
  const result = await env.DB.prepare(
    "DELETE FROM zoom_deliveries WHERE state = 'stored' AND settled_at IS NOT NULL AND settled_at < ?1",
  ).bind(now - ZOOM_DELIVERY_RETENTION_MS).run();
  return Number(result?.meta?.changes || 0);
}

/**
 * Fetch one recording's transcript and put it in the brain.
 *
 * ONE body, called by both the inline attempt and the retry sweep, on purpose.
 * Two copies of this would drift, and the copy that drifts is the retry, which
 * is the one nobody watches run.
 *
 * Returns an outcome rather than throwing, because the caller has to decide
 * between settling the row and scheduling another attempt, and that decision is
 * not the same in both callers' contexts.
 */
export async function deliverZoomTranscript(env, delivery = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const ingest = deps.ingest || gatedIngest;
  const receipt = deps.recordReceipt || recordZoomSourceReceipt;
  const uuid = String(delivery.uuid || "");
  try {
    const token = await getZoomAccessToken({
      accountId: env.ZOOM_ACCOUNT_ID,
      clientId: env.ZOOM_CLIENT_ID,
      clientSecret: env.ZOOM_CLIENT_SECRET,
    }, { fetchImpl });
    const detail = await fetchZoomTranscript({ token, uuid }, { fetchImpl });
    if (!detail.transcript || !detail.transcript.trim()) {
      // NOT settled. Zoom's own answer for the common case is that it may still
      // be writing the file, and the previous code took that sentence at face
      // value and then never tried again.
      return {
        outcome: "owed",
        burnAttempt: true,
        level: "warn",
        reason: `no transcript text for this recording: ${detail.reason || "the transcript was empty"}`,
      };
    }
    const result = await ingest(env, buildZoomEnvelope({
      uuid,
      meetingId: delivery.meetingId,
      topic: detail.topic || delivery.topic || null,
      startTime: detail.startTime || delivery.startTime || null,
      duration: detail.duration ?? delivery.duration ?? null,
      hostEmail: detail.hostEmail || delivery.hostEmail || null,
      transcript: detail.transcript,
    }));
    if (result?.refused) {
      return {
        outcome: "refused",
        level: "warn",
        reason: `transcript refused by the credential gate: ${(result.labels || []).join(", ")}`,
      };
    }
    try {
      await receipt(env, { detail: `zoom transcript ${result?.action || "stored"}` });
    } catch (error) {
      // The document is already written. A receipt failure makes `brain
      // sources` thinner, not the brain wrong.
      console.warn(`[zoom] source receipt failed: ${String(error?.message || error).slice(0, 200)}`);
    }
    return { outcome: "stored", level: null, action: result?.action || "stored", reason: null };
  } catch (error) {
    return {
      outcome: "owed",
      // A brain with no Zoom credentials cannot fetch anything, and spending
      // the retry budget on that would write the recording off for a reason
      // that reconnecting would fix. The debt stays and says so.
      burnAttempt: !error?.zoom_not_configured,
      level: "error",
      reason: `transcript ingest failed: ${String(error?.message || error).slice(0, 300)}`,
    };
  }
}

/**
 * Apply one delivery attempt's outcome to the ledger.
 *
 * Shared by both callers so the inline attempt and the retry cannot disagree
 * about what "stored" means.
 */
export async function applyZoomDeliveryOutcome(env, uuid, outcome, { now = Date.now() } = {}) {
  if (outcome.outcome === "stored") {
    return settleZoomDelivery(env, uuid, { state: "stored", now });
  }
  if (outcome.outcome === "refused") {
    return settleZoomDelivery(env, uuid, { state: "refused", error: outcome.reason, now });
  }
  return deferZoomDelivery(env, uuid, {
    error: outcome.reason,
    now,
    burnAttempt: outcome.burnAttempt !== false,
  });
}

/**
 * Retry everything still owed. Runs on the drain cron the install already has.
 *
 * Bounded on purpose: five rows per tick, every five minutes, is far more than
 * a real Zoom account produces, and an unbounded loop over a large backlog
 * would be killed mid-attempt by the Worker's wall clock every time.
 */
export async function sweepZoomDeliveries(env, deps = {}) {
  if (!zoomLedgerAvailable(env)) {
    return { available: false, reason: "the delivery ledger is a d1 table and this install is not on d1" };
  }
  const now = deps.now ? deps.now() : Date.now();
  const limit = Number.isInteger(deps.limit) ? Math.max(1, Math.min(50, deps.limit)) : ZOOM_SWEEP_LIMIT;
  let due;
  try {
    const rows = await env.DB.prepare(
      `SELECT uuid, meeting_id, topic, start_time, host_email
         FROM zoom_deliveries
        WHERE state = 'owed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
        ORDER BY received_at ASC
        LIMIT ?2`,
    ).bind(now, limit).all();
    due = rows?.results || [];
  } catch (error) {
    if (isMissingLedgerTable(error)) {
      return { available: false, reason: "zoom_deliveries does not exist yet; run `brain migrate`" };
    }
    throw error;
  }

  let attempted = 0, stored = 0, refused = 0, abandoned = 0, stillOwed = 0;
  for (const row of due) {
    if (!(await claimZoomDelivery(env, row.uuid, { now }))) continue;
    attempted++;
    const outcome = await deliverZoomTranscript(env, {
      uuid: row.uuid,
      meetingId: row.meeting_id,
      topic: row.topic,
      startTime: row.start_time,
      hostEmail: row.host_email,
    }, deps);
    const settled = await applyZoomDeliveryOutcome(env, row.uuid, outcome, { now });
    if (settled.state === "stored") stored++;
    else if (settled.state === "refused") refused++;
    else if (settled.state === "abandoned") {
      abandoned++;
      // Logged once, at the moment the retry budget runs out, rather than on
      // every attempt. The ledger row is the durable record either way.
      console.error(`[zoom] giving up on a transcript after ${ZOOM_DELIVERY_MAX_ATTEMPTS} attempts: ${outcome.reason}`);
    } else stillOwed++;
  }

  const pruned = await pruneZoomDeliveries(env, { now });
  const state = await reconcileZoomSourceState(env, { now });
  return {
    available: true,
    due: due.length, attempted, stored, refused, abandoned, still_owed: stillOwed,
    pruned,
    source_state: state.state,
    reason: state.reason,
    backlog: state.backlog,
  };
}

/**
 * A recording whose webhook NEVER ARRIVED is not detectable here, and saying so
 * is the honest half of this change.
 *
 * The ledger records deliveries Zoom made and this worker verified. If the
 * worker was down long enough to exhaust Zoom's own retries, or the signature
 * failed because the Secret Token had drifted, or the Event Subscription was
 * never saved, or the meeting was recorded before the connector was connected,
 * then no row is written here, no document is written anywhere, and nothing in
 * this brain knows the call happened. Its absence is indistinguishable from a
 * week with no meetings.
 *
 * What it would take, concretely: a scheduled poll of the client's own
 * recordings list (`GET /v2/users/me/recordings?from=&to=`), diffed against
 * this table and the `documents` rows under `zoom:<uuid>`. This change supplies
 * the half of that comparison that did not exist before — a record of what Zoom
 * told us about. The half still missing needs a Zoom LISTING scope this
 * connector does not request today, and a second writer racing the webhook,
 * which is the exact duplication the reference implementation needed claim rows
 * and three partial unique indexes to survive. That is a feature decision about
 * what permission to ask a client for, not a durability fix, so it is named
 * here rather than smuggled in.
 */
export const ZOOM_NEVER_DELIVERED_IS_NOT_DETECTABLE =
  "A Zoom recording whose webhook never reached this brain leaves no trace here. " +
  "Detecting it needs a poll of the Zoom account's own recordings list, which needs " +
  "a listing scope this connector does not request. Not built, and not claimed.";

/* --------------------------------------------------------------- route */

/**
 * POST /api/webhooks/zoom
 *
 * Sits IN FRONT of the admin-key gate on purpose: Zoom cannot send the brain's
 * admin key, and its authentication is the HMAC signature verified here. That
 * makes this the only unauthenticated-by-key write path in the worker, which is
 * why it fails closed on a missing secret, verifies in constant time, and
 * refuses anything outside a five-minute window.
 *
 * Zoom retries any slow or non-2xx response and disables an endpoint that keeps
 * failing, so a verified event is acknowledged immediately and the fetch and
 * ingest run on ctx.waitUntil.
 *
 * The one thing that happens BEFORE the acknowledgement is the ledger row. See
 * the durability section above for why: everything after the 200 is work Zoom
 * will never offer again, so it has to be written down as owed first or its
 * failure is unrecoverable and, worse, unnoticeable.
 */
export async function handleZoomWebhook(env, request, ctx, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const ingest = deps.ingest || gatedIngest;
  const receipt = deps.recordReceipt || recordZoomSourceReceipt;
  const secret = env.ZOOM_WEBHOOK_SECRET_TOKEN;

  // Fail closed BEFORE reading the body. An endpoint that triggers outbound
  // authenticated Zoom calls must never be reachable without its secret.
  if (!secret) {
    return jsonResponse({
      error: "the Zoom webhook is not configured on this brain",
      detail: "ZOOM_WEBHOOK_SECRET_TOKEN is not set. Run `brain connect zoom <manifest>` before adding this URL in Zoom.",
    }, 503);
  }

  const raw = await request.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const event = payload?.event;

  // Leg one: the URL-validation challenge. Zoom signs nothing here; saving the
  // endpoint URL in the Zoom app IS this request, and Zoom refuses to save an
  // endpoint whose answer is wrong. That is why the worker has to be deployed
  // with this secret already set before the client pastes the URL.
  if (event === "endpoint.url_validation") {
    const plainToken = payload?.payload?.plainToken || "";
    return jsonResponse({ plainToken, encryptedToken: await zoomHmacHex(secret, plainToken) });
  }

  // Leg two: every real event.
  const verified = await verifyZoomSignature({
    secret,
    rawBody: raw,
    signature: request.headers.get("x-zm-signature"),
    timestamp: request.headers.get("x-zm-request-timestamp"),
    now,
  });
  if (!verified.ok) {
    // One status, one body, for every failure reason. Which check failed is a
    // hint an attacker can iterate against.
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // A paused install refuses corpus writes everywhere else; acknowledging here
  // would silently drop the transcript. 503 makes Zoom retry, and the recording
  // stays in Zoom's cloud either way, so nothing is lost that a later delivery
  // cannot recover. (This comment used to promise "or a manual re-fetch". There
  // has never been one, and there still is not; what exists now is the retry
  // sweep below, which only covers deliveries that were acknowledged.)
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    return jsonResponse({
      error: "brain corpus writes are paused for a verified upgrade or rollback",
      paused: true,
    }, 503);
  }

  if (event !== ZOOM_TRANSCRIPT_EVENT) {
    // Acknowledged, not acted on. Zoom disables endpoints that keep failing, so
    // an unsubscribed event gets a 200 rather than an error. recording.completed
    // arrives before the VTT exists and is ignored here deliberately.
    return jsonResponse({ ok: true, ignored: event || "unknown" });
  }

  const object = payload?.payload?.object || {};
  const uuid = object?.uuid || "";
  if (!uuid) {
    // Retrying will not add a uuid, so this is acknowledged rather than failed.
    return jsonResponse({ ok: true, ignored: "transcript event carried no recording uuid" });
  }

  const delivery = {
    uuid: String(uuid),
    meetingId: object?.id ?? null,
    topic: object?.topic || null,
    startTime: object?.start_time || null,
    duration: object?.duration ?? null,
    hostEmail: object?.host_email || null,
  };

  // Write the debt down before answering. One INSERT, no provider call, so the
  // acknowledgement stays inside Zoom's timeout.
  let durable = false;
  if (zoomLedgerAvailable(env)) {
    try {
      await (deps.recordOwed || recordZoomDeliveryOwed)(env, delivery, { now });
      durable = true;
    } catch (error) {
      if (isMissingLedgerTable(error)) {
        // The worker is newer than the schema, which is a real state between
        // `brain deploy` and `brain migrate`. Refusing every delivery until
        // someone migrates would be worse than the pre-existing behaviour, so
        // this degrades to it and says so at full volume instead of quietly.
        console.error(
          "[zoom] the zoom_deliveries ledger does not exist on this brain, so a failure after " +
          "the acknowledgement cannot be recovered. Run `brain migrate <manifest>`.",
        );
      } else {
        // We cannot record that we owe this transcript, so we must not tell Zoom
        // we have it. 503 leaves the delivery on Zoom's own retry schedule,
        // which is the only durability left when ours is unavailable.
        return jsonResponse({
          error: "this brain could not record the delivery, so it will not acknowledge it",
          detail: String(error?.message || error).slice(0, 200),
        }, 503);
      }
    }
  }

  const work = (async () => {
    const outcome = await deliverZoomTranscript(env, delivery, {
      fetchImpl, ingest, recordReceipt: receipt,
    });
    // Logged on the first attempt exactly as before, so the operator-facing log
    // lines did not get quieter when the ledger arrived. Retries log only when
    // the budget runs out; the ledger is the record in between.
    if (outcome.level === "warn") console.warn(`[zoom] ${outcome.reason}`);
    else if (outcome.level === "error") console.error(`[zoom] ${outcome.reason}`);
    if (!durable) return;
    try {
      await applyZoomDeliveryOutcome(env, delivery.uuid, outcome, { now });
      // Paired with the receipt written inside deliverZoomTranscript, which
      // clears stale_reason for the transcript that just landed. This decides
      // whether the SOURCE as a whole is still owed anything.
      await (deps.reconcile || reconcileZoomSourceState)(env, { now });
    } catch (error) {
      console.error(`[zoom] the delivery ledger could not be updated: ${String(error?.message || error).slice(0, 200)}`);
    }
  })();

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  // `durable` is stated, not assumed. A caller (or a client reading their own
  // worker's response) can tell the difference between a delivery this brain
  // has written down as owed and one it is merely trying.
  return jsonResponse({ ok: true, event, accepted: true, durable });
}
