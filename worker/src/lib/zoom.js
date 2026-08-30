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
 * DURABLE DELIVERY. A verified transcript or recording-completed event is
 * written to D1 before the route acknowledges it. A short lease drives safe
 * retries, and a bounded scheduled sweep lists recent recordings so a webhook
 * that never arrives still leaves recoverable debt. The brain's existing
 * (source_type, source_id) plus content-hash idempotency makes replay safe. This
 * still does no call analysis, filing, or CRM work. A transcript becomes a
 * searchable, citable, forgettable document. That is all.
 *
 * FAIL CLOSED. With no ZOOM_WEBHOOK_SECRET_TOKEN set, every request is refused
 * before the body is even parsed. An unauthenticated endpoint that triggers
 * outbound authenticated API calls is a hole, not a convenience.
 */

import { jsonResponse } from "./core.js";
import {
  ProviderSyncError,
  createPaginationGuard,
  providerJson,
  providerText,
} from "./provider-sync.js";
import { ingestionOutcome } from "./ingestion-outcome.js";
import {
  hasSensitiveTransportIdentity,
  scanEnvelope as scanEnvelopeSecrets,
  sanitizeEnvelope as sanitizeIngestEnvelope,
} from "./secret-scan.js";
import { storeFor, backendOf, D1 } from "./store.js";
import { vttToPlainTranscript } from "./vtt.js";
import {
  ZOOM_RECONCILE_INTERVAL_MS,
  zoomDeliveryStore,
} from "./zoom-deliveries.js";

/** The one Zoom scope this connector needs. Anything more is over-asking. */
export const ZOOM_REQUIRED_SCOPE = "cloud_recording:read:admin";

/** The transcript-ready event wakes existing debt immediately. */
export const ZOOM_TRANSCRIPT_EVENT = "recording.transcript_completed";

/** Early recording debt is useful even though its transcript may not exist yet. */
export const ZOOM_RECORDING_EVENT = "recording.completed";

export const ZOOM_DELIVERY_EVENTS = Object.freeze(new Set([
  ZOOM_TRANSCRIPT_EVENT,
  ZOOM_RECORDING_EVENT,
]));

export const ZOOM_RECONCILE_MAX_PAGES = 5;
export const ZOOM_RECONCILE_OVERLAP_DAYS = 2;
export const ZOOM_RECONCILE_INITIAL_DAYS = 30;

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
 * The bounded reconciliation path can recover a missed delivery, but it should
 * not be used to conceal a verifier that rejects every real webhook. Both units
 * are therefore accepted: 1e11 sits between any plausible epoch-seconds value
 * (~1.8e9 today) and any plausible epoch-milliseconds one (~1.8e12).
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
  { fetchImpl = fetch, requestOptions = {} } = {},
) {
  if (!accountId || !clientId || !clientSecret) {
    const error = new Error("Zoom is not configured on this brain: account id, client id and client secret must all be set.");
    error.zoom_not_configured = true;
    throw error;
  }
  const credentials = btoa(`${clientId}:${clientSecret}`);
  let data;
  try {
    ({ data } = await providerJson("zoom", "https://zoom.us/oauth/token", {
      fetchImpl,
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
      maxResponseBytes: 256 * 1024,
      ...requestOptions,
    }));
  } catch (error) {
    if (error instanceof ProviderSyncError && error.status === 401) {
      error.message = "zoom: check the Account ID, Client ID and Client Secret, and confirm the Server-to-Server OAuth app is Activated";
    }
    throw error;
  }
  if (!data?.access_token) {
    throw new ProviderSyncError("zoom", "the token response carried no access token", {
      kind: "unavailable",
      code: "missing_access_token",
    });
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
  { fetchImpl = fetch, requestOptions = {} } = {},
) {
  let recording;
  try {
    ({ data: recording } = await providerJson(
      "zoom",
      `https://api.zoom.us/v2/meetings/${zoomRecordingPathId(uuid)}/recordings`,
      { accessToken: token, fetchImpl, ...requestOptions },
    ));
  } catch (error) {
    if (error instanceof ProviderSyncError) {
      if (error.status === 403) {
        error.message = `zoom: the recording read needs the ${ZOOM_REQUIRED_SCOPE} scope`;
      } else if (error.status === 404) {
        throw new ProviderSyncError("zoom", "the recording is not available yet under this occurrence UUID", {
          kind: "retryable",
          status: 404,
          code: "recording_not_ready",
          cause: error,
        });
      }
    }
    throw error;
  }
  const files = Array.isArray(recording?.recording_files) ? recording.recording_files : [];
  const transcriptFile = files.find((file) => file?.file_type === "TRANSCRIPT");

  if (!transcriptFile?.download_url) {
    return {
      meetingId: recording?.id || null,
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
  const separator = String(transcriptFile.download_url).includes("?") ? "&" : "?";
  let transcriptText;
  try {
    ({ data: transcriptText } = await providerText(
      "zoom",
      `${transcriptFile.download_url}${separator}access_token=${encodeURIComponent(token)}`,
      { fetchImpl, maxResponseBytes: 32 * 1024 * 1024, ...requestOptions },
    ));
  } catch (error) {
    if (error instanceof ProviderSyncError && error.status === 404) {
      throw new ProviderSyncError("zoom", "the transcript file is not available yet", {
        kind: "retryable",
        status: 404,
        code: "transcript_not_ready",
        cause: error,
      });
    }
    throw error;
  }

  return {
    meetingId: recording?.id || null,
    topic: recording?.topic || null,
    startTime: recording?.start_time || null,
    duration: recording?.duration ?? null,
    hostEmail: recording?.host_email || null,
    hasTranscript: true,
    transcript: vttToPlainTranscript(transcriptText),
    reason: null,
  };
}

/** List one bounded reconciliation page of recent cloud recordings. */
export async function listZoomRecordingsPage({ token, from, to, nextPageToken = null }, {
  fetchImpl = fetch,
  requestOptions = {},
} = {}) {
  const query = new URLSearchParams({ from, to, page_size: "100" });
  if (nextPageToken) query.set("next_page_token", nextPageToken);
  const { data } = await providerJson(
    "zoom",
    `https://api.zoom.us/v2/users/me/recordings?${query}`,
    { accessToken: token, fetchImpl, ...requestOptions },
  );
  return {
    meetings: Array.isArray(data?.meetings) ? data.meetings : [],
    nextPageToken: String(data?.next_page_token || "").trim() || null,
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

function zoomFailureOutcome(error) {
  if (error?.zoom_not_configured) {
    return ingestionOutcome("unavailable", { reason: "Zoom credentials are not configured" });
  }
  if (error instanceof ProviderSyncError && error.outcome) return error.outcome;
  return ingestionOutcome("retryable", { reason: "Zoom delivery processing was interrupted" });
}

function zoomFailureCode(error) {
  return String(error?.code || error?.provider_code || error?.zoom_status || error?.name || "processing_error")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 100);
}

/** Fetch, gate, and ingest one claimed recording without changing its debt row. */
export async function processZoomDelivery(env, delivery, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const ingest = deps.ingest || gatedIngest;
  const receipt = deps.recordReceipt || recordZoomSourceReceipt;
  try {
    const token = deps.token || await getZoomAccessToken({
      accountId: env.ZOOM_ACCOUNT_ID,
      clientId: env.ZOOM_CLIENT_ID,
      clientSecret: env.ZOOM_CLIENT_SECRET,
    }, { fetchImpl, requestOptions: deps.requestOptions });
    const detail = await fetchZoomTranscript(
      { token, uuid: delivery.recording_uuid },
      { fetchImpl, requestOptions: deps.requestOptions },
    );
    if (!detail.transcript || !detail.transcript.trim()) {
      console.warn(`[zoom] no transcript text for this recording: ${detail.reason || "the transcript was empty"}`);
      return {
        outcome: ingestionOutcome("retryable", { reason: detail.reason || "the transcript is not ready" }),
        code: "transcript_not_ready",
      };
    }
    const result = await ingest(env, buildZoomEnvelope({
      uuid: delivery.recording_uuid,
      meetingId: detail.meetingId || delivery.meeting_id,
      topic: detail.topic,
      startTime: detail.startTime,
      duration: detail.duration,
      hostEmail: detail.hostEmail,
      transcript: detail.transcript,
    }));
    if (result?.refused) {
      console.warn(`[zoom] transcript refused by the credential gate: ${(result.labels || []).join(", ")}`);
      return {
        outcome: ingestionOutcome("refused", { reason: "the transcript was refused by the credential gate" }),
        code: "credential_gate_refused",
      };
    }
    try {
      await receipt(env, { detail: `zoom transcript ${result?.action || "stored"}` });
    } catch (error) {
      // The document is already written. A receipt failure makes `brain
      // sources` thinner, not the brain wrong.
      console.warn(`[zoom] source receipt failed: ${String(error?.message || error).slice(0, 200)}`);
    }
    return { outcome: ingestionOutcome("completed"), code: null, result };
  } catch (error) {
    console.error(`[zoom] transcript ingest failed: ${String(error?.message || error).slice(0, 300)}`);
    return { outcome: zoomFailureOutcome(error), code: zoomFailureCode(error), error };
  }
}

/** Claim and settle a bounded batch of durable Zoom delivery debt. */
export async function drainZoomDeliveries(env, deps = {}) {
  const store = deps.deliveryStore || zoomDeliveryStore;
  const nowMs = deps.now ? deps.now() : Date.now();
  const claimed = await store.claim(env, {
    nowMs,
    limit: deps.limit || 5,
    ...(deps.ownerToken ? { ownerToken: deps.ownerToken } : {}),
  });
  if (!claimed.length) {
    return { claimed: 0, completed: 0, outcome: ingestionOutcome("completed") };
  }

  let token = null;
  let tokenError = null;
  try {
    token = await getZoomAccessToken({
      accountId: env.ZOOM_ACCOUNT_ID,
      clientId: env.ZOOM_CLIENT_ID,
      clientSecret: env.ZOOM_CLIENT_SECRET,
    }, { fetchImpl: deps.fetchImpl || fetch, requestOptions: deps.requestOptions });
  } catch (error) {
    tokenError = error;
  }

  const outcomes = [];
  for (const delivery of claimed) {
    const processed = tokenError
      ? { outcome: zoomFailureOutcome(tokenError), code: zoomFailureCode(tokenError), error: tokenError }
      : await processZoomDelivery(env, delivery, { ...deps, token });
    await store.finish(env, delivery, {
      outcome: processed.outcome,
      errorCode: processed.code,
      nowMs: deps.now ? deps.now() : Date.now(),
      randomImpl: deps.randomImpl,
    });
    outcomes.push(processed.outcome);
  }

  const completed = outcomes.filter((outcome) => outcome.kind === "completed").length;
  const refused = outcomes.filter((outcome) => outcome.kind === "refused").length;
  const unavailable = outcomes.filter((outcome) => outcome.kind === "unavailable").length;
  const retryable = outcomes.filter((outcome) => outcome.kind === "retryable").length;
  let outcome;
  if (completed === outcomes.length) outcome = ingestionOutcome("completed");
  else if (completed > 0 || refused > 0) {
    outcome = ingestionOutcome("partial", { reason: "some Zoom delivery debt remains unsettled" });
  } else if (retryable > 0) {
    outcome = ingestionOutcome("retryable", { reason: "Zoom delivery debt is scheduled for another attempt" });
  } else {
    outcome = ingestionOutcome("unavailable", { reason: "the Zoom connection is unavailable" });
  }
  return { claimed: claimed.length, completed, refused, unavailable, retryable, outcome };
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Reconcile recent recordings so a missing webhook cannot become silent loss. */
export async function reconcileZoomRecordings(env, deps = {}) {
  const store = deps.deliveryStore || zoomDeliveryStore;
  const nowMs = deps.now ? deps.now() : Date.now();
  const lease = await store.claimReconciliation(env, {
    nowMs,
    ...(deps.reconcileOwnerToken ? { ownerToken: deps.reconcileOwnerToken } : {}),
  });
  if (!lease.acquired) return { acquired: false, pages: 0, recordings: 0, outcome: ingestionOutcome("completed") };

  const initialFrom = utcDate(nowMs - (ZOOM_RECONCILE_INITIAL_DAYS * 24 * 60 * 60 * 1000));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(lease.window_from || "")) ? lease.window_from : initialFrom;
  const to = utcDate(nowMs);
  let nextPageToken = lease.next_page_token || null;
  let pages = 0;
  let recordings = 0;
  try {
    const token = await getZoomAccessToken({
      accountId: env.ZOOM_ACCOUNT_ID,
      clientId: env.ZOOM_CLIENT_ID,
      clientSecret: env.ZOOM_CLIENT_SECRET,
    }, { fetchImpl: deps.fetchImpl || fetch, requestOptions: deps.requestOptions });
    const guard = createPaginationGuard("zoom", { maxPages: deps.maxPages || ZOOM_RECONCILE_MAX_PAGES });
    while (pages < (deps.maxPages || ZOOM_RECONCILE_MAX_PAGES)) {
      guard.visit(nextPageToken ? `cursor:${nextPageToken}` : `initial:${from}:${to}`);
      const page = await listZoomRecordingsPage({ token, from, to, nextPageToken }, {
        fetchImpl: deps.fetchImpl || fetch,
        requestOptions: deps.requestOptions,
      });
      pages++;
      for (const meeting of page.meetings) {
        if (!meeting?.uuid) {
          throw new ProviderSyncError("zoom", "a recordings page carried an item without an occurrence UUID", {
            kind: "retryable",
            code: "recording_uuid_missing",
          });
        }
        await store.persist(env, {
          uuid: meeting.uuid,
          eventType: ZOOM_RECORDING_EVENT,
          meetingId: meeting.id,
          receivedAtMs: nowMs,
        });
        recordings++;
      }
      nextPageToken = page.nextPageToken;
      if (!nextPageToken) break;
      if (pages < (deps.maxPages || ZOOM_RECONCILE_MAX_PAGES)) {
        await store.checkpointReconciliation(env, lease, {
          nextPageToken,
          windowFrom: from,
          nextRunAtMs: nowMs,
          status: "processing",
          nowMs,
          release: false,
        });
      }
    }

    const completeWindow = !nextPageToken;
    const nextWindowFrom = completeWindow
      ? utcDate(nowMs - (ZOOM_RECONCILE_OVERLAP_DAYS * 24 * 60 * 60 * 1000))
      : from;
    await store.checkpointReconciliation(env, lease, {
      nextPageToken,
      windowFrom: nextWindowFrom,
      nextRunAtMs: completeWindow ? nowMs + ZOOM_RECONCILE_INTERVAL_MS : nowMs,
      status: "idle",
      nowMs,
      release: true,
    });
    return { acquired: true, pages, recordings, completeWindow, outcome: ingestionOutcome("completed") };
  } catch (error) {
    const outcome = zoomFailureOutcome(error);
    await store.checkpointReconciliation(env, lease, {
      nextPageToken,
      windowFrom: from,
      nextRunAtMs: nowMs + ZOOM_RECONCILE_INTERVAL_MS,
      status: outcome.kind === "refused" ? "refused" : outcome.kind === "unavailable" ? "unavailable" : "retryable",
      errorCode: zoomFailureCode(error),
      nowMs,
      release: true,
    });
    return { acquired: true, pages, recordings, outcome, error };
  }
}

/** Scheduled entrypoint: discover missed recordings, then settle due debt. */
export async function runZoomDeliveryMaintenance(env, deps = {}) {
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    return { outcome: ingestionOutcome("retryable", { reason: "brain corpus writes are paused" }) };
  }
  const configuredValues = [
    env.ZOOM_ACCOUNT_ID,
    env.ZOOM_CLIENT_ID,
    env.ZOOM_CLIENT_SECRET,
    env.ZOOM_WEBHOOK_SECRET_TOKEN,
  ].filter(Boolean);
  if (!configuredValues.length) {
    return { skipped: "not_configured", outcome: ingestionOutcome("completed") };
  }
  const reconciliation = await reconcileZoomRecordings(env, deps);
  const deliveries = await drainZoomDeliveries(env, deps);
  const kinds = [reconciliation.outcome.kind, deliveries.outcome.kind];
  const acceptedWork = Number(reconciliation.recordings || 0) > 0 || Number(deliveries.completed || 0) > 0;
  const outcome = kinds.every((kind) => kind === "completed")
    ? ingestionOutcome("completed")
    : acceptedWork || kinds.includes("partial")
      ? ingestionOutcome("partial", { reason: "Zoom maintenance left durable work for a later attempt" })
      : kinds.includes("retryable")
        ? ingestionOutcome("retryable", { reason: "Zoom maintenance will retry" })
        : kinds.includes("unavailable")
          ? ingestionOutcome("unavailable", { reason: "the Zoom connection is unavailable" })
          : ingestionOutcome("refused", { reason: "Zoom maintenance was refused" });
  return { reconciliation, deliveries, outcome };
}

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
 * Zoom retries non-2xx responses. A verified delivery event is acknowledged
 * only after its recording UUID is durable in D1. Fetch and ingest can then run
 * on ctx.waitUntil because a crash leaves reclaimable debt.
 */
export async function handleZoomWebhook(env, request, ctx, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const deliveryStore = deps.deliveryStore || zoomDeliveryStore;
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
  // or a manual re-fetch cannot recover.
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    return jsonResponse({
      error: "brain corpus writes are paused for a verified upgrade or rollback",
      paused: true,
    }, 503);
  }

  if (!ZOOM_DELIVERY_EVENTS.has(event)) {
    // An unsubscribed event gets a 200 so an accidental subscription does not
    // disable the endpoint. Only the two recording events can create debt.
    return jsonResponse({ ok: true, ignored: event || "unknown" });
  }

  const object = payload?.payload?.object || {};
  const uuid = object?.uuid || "";
  if (!uuid) {
    // Retrying will not add a uuid, so this is acknowledged rather than failed.
    return jsonResponse({ ok: true, ignored: "recording event carried no recording uuid" });
  }

  try {
    await deliveryStore.persist(env, { uuid, eventType: event, meetingId: object?.id, receivedAtMs: now });
  } catch (error) {
    console.error(`[zoom] delivery debt could not be persisted: ${String(error?.message || error).slice(0, 200)}`);
    return jsonResponse({
      error: "the Zoom delivery could not be made durable",
      retryable: true,
    }, 503);
  }

  const work = drainZoomDeliveries(env, {
    ...deps,
    fetchImpl,
    deliveryStore,
  }).catch((error) => {
    // Persistence already succeeded. A crash or claim failure leaves the row
    // for the scheduled maintenance path or the next webhook to reclaim.
    console.error(`[zoom] durable delivery drain failed: ${String(error?.message || error).slice(0, 240)}`);
  });

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return jsonResponse({ ok: true, event, accepted: true, durable: true });
}
