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
  const expected = "v0=" + (await zoomHmacHex(secret, `v0:${timestamp ?? ""}:${rawBody ?? ""}`));
  if (!constantTimeEquals(expected, String(signature ?? ""))) {
    return { ok: false, reason: "bad_signature" };
  }
  // Replay guard. Zoom's header is epoch milliseconds. A correctly signed body
  // stays correctly signed forever, so without this a captured request could be
  // replayed at will.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > ZOOM_REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- vtt */

const VTT_TIMESTAMP = /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/;

/**
 * WebVTT to plain speaker-tagged transcript.
 *
 * Ported from the reference implementation's `vttToPlainTranscript`, NOT from
 * the parser that is actually live on its ingest path — that one never strips
 * WebVTT cue-number lines, so a bare "12" before each cue is appended into the
 * transcript text and every Zoom transcript in that index carries stray digits.
 * A fresh port is the only cheap moment to not inherit a bug, so it is fixed
 * here, along with three others found while porting. Each is deliberate and has
 * its own fixture in worker/test/zoom.test.mjs:
 *
 *   1. Cue-number lines (`^\d+$`) are skipped. The named bug.
 *   2. The header block (`WEBVTT` through the first blank line) is skipped
 *      whole. The reference skipped only the WEBVTT line itself, so a
 *      "Kind: captions" or "Language: en-US" metadata line became a SPEAKER
 *      called "Kind" with the rest of the transcript attributed to it.
 *   3. A speaker prefix is only recognised on the FIRST line of a cue. The
 *      reference matched `^([^:]+):` on every line, so a wrapped continuation
 *      line reading "meet at 3:30 tomorrow" invented a speaker named "meet at 3".
 *   4. Text in a cue with no speaker prefix is emitted unattributed instead of
 *      being dropped. The reference only flushed its buffer when a speaker was
 *      known, so a transcript with no speaker attribution at all parsed to the
 *      empty string — silent, total data loss with no error anywhere.
 *
 * NOTE blocks are skipped as the WebVTT spec defines them.
 */
export function vttToPlainTranscript(vttBody) {
  if (!vttBody) return "";
  const lines = String(vttBody).split(/\r?\n/);
  const out = [];
  let speaker = null;
  let buffer = [];
  // A speaker prefix is only meaningful at the start of a cue. Everything after
  // that is continuation text, colons and all.
  let atCueStart = false;
  let index = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join(" ").trim();
    if (text) out.push(speaker ? `${speaker}: ${text}` : text);
    buffer = [];
    speaker = null;
  };

  // The header block: WEBVTT plus any metadata lines, through the first blank
  // line. Skipped whole rather than one line deep.
  if (lines[0] && /^﻿?WEBVTT/i.test(lines[0])) {
    index = 1;
    while (index < lines.length && lines[index].trim()) index++;
  }

  for (; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      atCueStart = false;
      continue;
    }
    // A NOTE comment runs to the next blank line and is never transcript text.
    if (/^NOTE(\s|$)/.test(trimmed)) {
      flush();
      while (index + 1 < lines.length && lines[index + 1].trim()) index++;
      atCueStart = false;
      continue;
    }
    if (/^\d+$/.test(trimmed)) continue;          // cue number
    if (VTT_TIMESTAMP.test(trimmed)) {            // cue timing
      atCueStart = true;
      continue;
    }

    if (atCueStart) {
      const speakerMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (speakerMatch) {
        // A cue that names a speaker ends whatever turn was open. Ordinary
        // Zoom output already separates cues with a blank line, so this only
        // matters for a file whose cues run together.
        flush();
        speaker = speakerMatch[1].trim();
        const tail = speakerMatch[2].trim();
        if (tail) buffer.push(tail);
      } else {
        buffer.push(trimmed);
      }
      atCueStart = false;
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return out.join("\n");
}

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
  // or a manual re-fetch cannot recover.
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

  const work = (async () => {
    try {
      const token = await getZoomAccessToken({
        accountId: env.ZOOM_ACCOUNT_ID,
        clientId: env.ZOOM_CLIENT_ID,
        clientSecret: env.ZOOM_CLIENT_SECRET,
      }, { fetchImpl });
      const detail = await fetchZoomTranscript({ token, uuid }, { fetchImpl });
      if (!detail.transcript || !detail.transcript.trim()) {
        console.warn(`[zoom] no transcript text for this recording: ${detail.reason || "the transcript was empty"}`);
        return;
      }
      const result = await ingest(env, buildZoomEnvelope({
        uuid,
        meetingId: object?.id,
        topic: detail.topic || object?.topic || null,
        startTime: detail.startTime || object?.start_time || null,
        duration: detail.duration ?? object?.duration ?? null,
        hostEmail: detail.hostEmail || object?.host_email || null,
        transcript: detail.transcript,
      }));
      if (result?.refused) {
        console.warn(`[zoom] transcript refused by the credential gate: ${(result.labels || []).join(", ")}`);
        return;
      }
      try {
        await receipt(env, { detail: `zoom transcript ${result?.action || "stored"}` });
      } catch (error) {
        // The document is already written. A receipt failure makes `brain
        // sources` thinner, not the brain wrong.
        console.warn(`[zoom] source receipt failed: ${String(error?.message || error).slice(0, 200)}`);
      }
    } catch (error) {
      console.error(`[zoom] transcript ingest failed: ${String(error?.message || error).slice(0, 300)}`);
    }
  })();

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return jsonResponse({ ok: true, event, accepted: true });
}
