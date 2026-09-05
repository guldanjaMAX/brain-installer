import assert from "node:assert/strict";
import { Miniflare, Log, LogLevel } from "miniflare";

import {
  createFaultProxy,
  createLocalJsonFixture,
} from "../test/fixtures/fault-proxy.mjs";

const workerScript = `
export default {
  async fetch(request, env) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS fault_jobs (id TEXT PRIMARY KEY,write_count INTEGER NOT NULL,receipt TEXT,cursor INTEGER NOT NULL DEFAULT 0)"
    ).run();
    const url = new URL(request.url);
    if (url.pathname === "/state") {
      const row = await env.DB.prepare(
        "SELECT id,write_count,receipt,cursor FROM fault_jobs WHERE id=?"
      ).bind(url.searchParams.get("id")).first();
      return Response.json(row || null);
    }
    if (url.pathname === "/count") {
      return Response.json(await env.DB.prepare("SELECT count(*) AS n FROM fault_jobs").first());
    }
    if (url.pathname !== "/apply" || request.method !== "POST") return new Response("not found", { status: 404 });
    const body = await request.json();
    const crash = request.headers.get("x-fault-crash-point");
    await env.DB.prepare(
      "INSERT INTO fault_jobs (id,write_count,receipt,cursor) VALUES (?,1,NULL,0) ON CONFLICT(id) DO NOTHING"
    ).bind(body.id).run();
    if (crash === "after_write") throw new Error("synthetic crash after write");
    await env.DB.prepare(
      "UPDATE fault_jobs SET receipt=COALESCE(receipt,?) WHERE id=?"
    ).bind("receipt:" + body.id, body.id).run();
    if (crash === "after_receipt") throw new Error("synthetic crash after receipt");
    await env.DB.prepare(
      "UPDATE fault_jobs SET cursor=MAX(cursor,?) WHERE id=?"
    ).bind(body.cursor, body.id).run();
    if (crash === "after_cursor") throw new Error("synthetic crash after cursor");
    const row = await env.DB.prepare(
      "SELECT id,write_count,receipt,cursor FROM fault_jobs WHERE id=?"
    ).bind(body.id).first();
    return Response.json(row);
  }
};`;

const mf = new Miniflare({
  modules: true,
  script: workerScript,
  compatibilityDate: "2026-08-06",
  d1Databases: { DB: "operational-fault-lab" },
  d1Persist: false,
  log: new Log(LogLevel.NONE),
});

let fixture;
let proxy;
try {
  const apply = (id, cursor, crash = null) => mf.dispatchFetch("http://fault.invalid/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(crash ? { "X-Fault-Crash-Point": crash } : {}),
    },
    body: JSON.stringify({ id, cursor }),
  });
  const state = async (id) => (await mf.dispatchFetch(`http://fault.invalid/state?id=${id}`)).json();

  for (const [id, point, expectedBefore] of [
    ["write-crash", "after_write", { write_count: 1, receipt: null, cursor: 0 }],
    ["receipt-crash", "after_receipt", { write_count: 1, receipt: "receipt:receipt-crash", cursor: 0 }],
    ["cursor-crash", "after_cursor", { write_count: 1, receipt: "receipt:cursor-crash", cursor: 9 }],
  ]) {
    const crashed = await apply(id, 9, point);
    assert.equal(crashed.status, 500, `${point} must interrupt the response`);
    assert.deepEqual(await state(id), { id, ...expectedBefore });
    const retried = await apply(id, 9);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), {
      id, write_count: 1, receipt: `receipt:${id}`, cursor: 9,
    });
  }
  assert.deepEqual(
    await (await mf.dispatchFetch("http://fault.invalid/count")).json(),
    { n: 3 },
    "retries must not duplicate durable writes",
  );

  fixture = await createLocalJsonFixture();
  proxy = await createFaultProxy({ upstreamPort: fixture.port });

  const pass = await fetch(`${proxy.url}/ok`);
  assert.deepEqual(await pass.json(), { ok: true, fixture: "local" });

  proxy.setMode("latency", { latencyMs: 60 });
  const latencyStarted = performance.now();
  const latent = await fetch(`${proxy.url}/ok`);
  assert.equal(latent.status, 200);
  await latent.arrayBuffer();
  assert.ok(performance.now() - latencyStarted >= 50, "latency toxic must delay the response path");

  proxy.setMode("reset");
  await assert.rejects(() => fetch(`${proxy.url}/ok`, { signal: AbortSignal.timeout(1000) }));

  proxy.setMode("half_response");
  await assert.rejects(async () => {
    const response = await fetch(`${proxy.url}/ok`);
    await response.text();
  });

  proxy.setMode("malformed_json");
  await assert.rejects(async () => {
    const response = await fetch(`${proxy.url}/ok`);
    await response.json();
  }, SyntaxError);

  proxy.setMode("retry_after");
  const throttled = await fetch(`${proxy.url}/ok`);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("Retry-After"), "3");
  assert.deepEqual(await throttled.json(), { error: "synthetic_throttle" });

  console.log(JSON.stringify({
    ok: true,
    runtime: "miniflare-d1",
    crash_points: ["after_write", "after_receipt", "after_cursor"],
    http_faults: ["latency", "reset", "half_response", "malformed_json", "retry_after"],
    network: "loopback_only",
  }));
} finally {
  await proxy?.close().catch(() => {});
  await fixture?.close().catch(() => {});
  await mf.dispose();
}
