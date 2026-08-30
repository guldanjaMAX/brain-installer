import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimZoomDeliveries,
  finishZoomDelivery,
  persistZoomDelivery,
  zoomDeliveryRetryDelay,
} from "../src/lib/zoom-deliveries.js";
import {
  ZOOM_RECORDING_EVENT,
  ZOOM_TRANSCRIPT_EVENT,
  fetchZoomTranscript,
  handleZoomWebhook,
  reconcileZoomRecordings,
} from "../src/lib/zoom.js";

let ran = 0;
const ZOOM_MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "migrations", "d1", "0025_zoom_deliveries.sql",
);
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

function d1(db) {
  return {
    prepare(sql) {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) } }),
      });
      return shape();
    },
  };
}

{
  let error;
  try {
    await fetchZoomTranscript({ token: "fixture-token", uuid: "not-ready" }, {
      fetchImpl: async () => new Response("not ready", { status: 404 }),
    });
  } catch (caught) { error = caught; }
  check("an early recording 404 stays retryable instead of becoming permanent loss",
    error?.outcome?.kind === "retryable" && error?.code === "recording_not_ready");
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(ZOOM_MIGRATION, "utf8"));
  db.prepare(
    "UPDATE zoom_reconciliation SET window_from='2026-08-01',next_run_at_ms=0,updated_at_ms=0",
  ).run();
  return { db, env: { DB: d1(db) } };
}

const completed = Object.freeze({ kind: "completed" });
const retryable = Object.freeze({ kind: "retryable", reason: "try again" });

{
  const { db, env } = database();
  await persistZoomDelivery(env, { uuid: "early", eventType: ZOOM_RECORDING_EVENT, receivedAtMs: 1_000 });
  await persistZoomDelivery(env, { uuid: "early", eventType: ZOOM_TRANSCRIPT_EVENT, receivedAtMs: 2_000 });
  const row = db.prepare("SELECT * FROM zoom_deliveries WHERE recording_uuid='early'").get();
  check("a redelivery keeps one debt row and upgrades it to transcript-ready evidence",
    row.event_type === ZOOM_TRANSCRIPT_EVENT && row.status === "pending" && row.received_at_ms === 2_000);

  const [claim] = await claimZoomDeliveries(env, { nowMs: 2_000, ownerToken: "worker-a" });
  check("one worker claims due debt under an opaque lease",
    claim.ownerToken === "worker-a" && claim.status === "processing" && claim.attempts === 1);
  check("the same live lease cannot be claimed twice",
    (await claimZoomDeliveries(env, { nowMs: 2_001, ownerToken: "worker-b" })).length === 0);
  await finishZoomDelivery(env, claim, { outcome: completed, nowMs: 2_100 });
  await persistZoomDelivery(env, { uuid: "early", eventType: ZOOM_TRANSCRIPT_EVENT, receivedAtMs: 2_200 });
  check("a completed delivery stays completed across webhook redelivery",
    db.prepare("SELECT status FROM zoom_deliveries WHERE recording_uuid='early'").get().status === "completed");
  db.close();
}

{
  const { db, env } = database();
  await persistZoomDelivery(env, { uuid: "retry", eventType: ZOOM_RECORDING_EVENT, receivedAtMs: 1_000 });
  const [first] = await claimZoomDeliveries(env, {
    nowMs: 1_000,
    ownerToken: "worker-a",
    leaseMs: 1_000,
  });
  check("expired processing debt is reclaimable after a worker crash",
    (await claimZoomDeliveries(env, { nowMs: 2_001, ownerToken: "worker-b" }))[0]?.attempts === 2);

  db.prepare(
    "UPDATE zoom_deliveries SET status='processing',lease_owner='worker-a',lease_expires_at_ms=5000,attempts=1 WHERE recording_uuid='retry'",
  ).run();
  await finishZoomDelivery(env, first, {
    outcome: retryable,
    nowMs: 1_100,
    retryDelayMs: 900,
  });
  const scheduled = db.prepare("SELECT * FROM zoom_deliveries WHERE recording_uuid='retry'").get();
  check("a retryable failure clears the lease and records an exact next attempt",
    scheduled.status === "retryable" && scheduled.next_attempt_at_ms === 2_000 && scheduled.lease_owner === null);
  check("retry jitter is deterministic when its random source is injected",
    zoomDeliveryRetryDelay(3, { baseDelayMs: 100, maxDelayMs: 10_000, randomImpl: () => 0 }) === 200);
  db.close();
}

const SECRET = "zoom-webhook-fixture-secret";
const WEBHOOK_NOW = Date.parse("2026-08-30T12:00:00Z");
const ZOOM_ENV = {
  ZOOM_ACCOUNT_ID: "fixture-account",
  ZOOM_CLIENT_ID: "fixture-client",
  ZOOM_CLIENT_SECRET: "fixture-secret",
};
function signedEvent(event, uuid = "webhook-uuid", now = WEBHOOK_NOW) {
  const body = JSON.stringify({ event, payload: { object: { uuid } } });
  const signature = createHmac("sha256", SECRET).update(`v0:${now}:${body}`).digest("hex");
  return new Request("https://brain.example/api/webhooks/zoom", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zm-request-timestamp": String(now),
      "x-zm-signature": `v0=${signature}`,
    },
    body,
  });
}

{
  let scheduled = false;
  const order = [];
  const deliveryStore = {
    async persist(_env, debt) { order.push(`persist:${debt.eventType}`); },
    async claim() { order.push("claim"); return []; },
  };
  const response = await handleZoomWebhook(
    { ZOOM_WEBHOOK_SECRET_TOKEN: SECRET },
    signedEvent(ZOOM_RECORDING_EVENT),
    { waitUntil(promise) { scheduled = true; order.push("scheduled"); return promise; } },
    { deliveryStore, now: () => WEBHOOK_NOW },
  );
  const body = await response.json();
  check("recording.completed debt is persisted before the webhook receives HTTP 2xx",
    response.status === 200 && body.durable === true && order[0] === `persist:${ZOOM_RECORDING_EVENT}` && scheduled);
}

{
  const response = await handleZoomWebhook(
    { ZOOM_WEBHOOK_SECRET_TOKEN: SECRET },
    signedEvent(ZOOM_TRANSCRIPT_EVENT),
    { waitUntil() { throw new Error("background work must not start"); } },
    {
      now: () => WEBHOOK_NOW,
      deliveryStore: { async persist() { throw new Error("D1 unavailable"); } },
    },
  );
  const body = await response.json();
  check("a persistence failure returns retryable 503 instead of losing the delivery behind HTTP 2xx",
    response.status === 503 && body.retryable === true && body.error.includes("durable"));
}

function reconciliationStore() {
  const persisted = [];
  const checkpoints = [];
  return {
    persisted,
    checkpoints,
    store: {
      async claimReconciliation() {
        return { acquired: true, ownerToken: "reconcile-a", window_from: "2026-08-01", next_page_token: null };
      },
      async persist(_env, debt) { persisted.push(debt); },
      async checkpointReconciliation(_env, _lease, checkpoint) { checkpoints.push(checkpoint); },
    },
  };
}

{
  const state = reconciliationStore();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://zoom.us/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fixture-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      meetings: [{ uuid: "missed-webhook-a" }, { uuid: "missed-webhook-b" }],
      next_page_token: "",
    }), { status: 200 });
  };
  const result = await reconcileZoomRecordings(ZOOM_ENV, {
    deliveryStore: state.store,
    fetchImpl,
    now: () => Date.parse("2026-08-30T12:00:00Z"),
  });
  check("the scheduled sweep makes recordings durable even when no webhook arrived",
    result.outcome.kind === "completed" && state.persisted.map((item) => item.uuid).join(",") === "missed-webhook-a,missed-webhook-b");
  check("the reconciliation cursor advances only after every page recording is persisted",
    state.checkpoints.at(-1)?.nextPageToken === null && state.checkpoints.at(-1)?.release === true);
  check("the reconciliation window is bounded to exact recent dates",
    calls.some((url) => /from=2026-08-01/.test(url) && /to=2026-08-30/.test(url) && /page_size=100/.test(url)));
}

{
  const state = reconciliationStore();
  let pages = 0;
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://zoom.us/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fixture-token" }), { status: 200 });
    }
    pages++;
    return new Response(JSON.stringify({ meetings: [], next_page_token: "same-token" }), { status: 200 });
  };
  const result = await reconcileZoomRecordings(ZOOM_ENV, {
    deliveryStore: state.store,
    fetchImpl,
    now: () => Date.parse("2026-08-30T12:00:00Z"),
  });
  check("a repeated Zoom page token is a retryable outcome, never a completed empty sweep",
    pages === 2 && result.outcome.kind === "retryable" && state.checkpoints.at(-1)?.status === "retryable");
}

console.log(`\nZoom delivery safety: all ${ran} checks passed`);
