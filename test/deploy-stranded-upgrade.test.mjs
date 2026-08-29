/**
 * Deploy safety over stranded upgrades, tested against the incident's shape.
 *
 * The field incident: a worker reported a version six releases ahead of its
 * schema while an unfinished upgrade sat in upgrade_runs, and the pause that
 * protected corpus writes lived ONLY in a plain_text binding — which any full
 * deploy rewrites, because keep_bindings preserves secret_text alone. A plain
 * `brain deploy` on that install would have silently resumed writes over a
 * half-migrated schema.
 *
 * Two records now stop that, and this file proves both against a REAL D1
 * schema (every shipped migration executed into SQLite) behind a mocked
 * Cloudflare API:
 *
 *   - an active-mode deploy refuses while the newest upgrade_runs row is
 *     unfinished, naming the repair commands;
 *   - the pause is recorded durably in install_state (0022), survives the
 *     deploy that would have erased its binding — by refusing that deploy —
 *     and is cleared only when active code is genuinely uploaded again.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDeploy, loadMigrations, splitStatements } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 500)));
  if (!c) fail++;
};

const sandbox = mkdtempSync(join(tmpdir(), "brain-deploy-stranded-"));
const manifestPath = join(sandbox, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture-install", display_name: "Fixture Install" },
  brain: { worker_name: "fixture-brain", domain: "brain.example.test", version: "0.1.22" },
  infrastructure: { cloudflare: {
    account_id: "fixture-account",
    d1_database_id: "fixture-database",
    storage: "d1",
    vectorize_index: "fixture-index",
    drain_cron: "*/5 * * * *",
  } },
  retrieval: { chunk_size: 1500, chunk_overlap: 300 },
  safety: { daily_llm_spend_cap_usd: 1, credential_scanner: { enabled: true } },
}));

/* ---- a real D1 schema behind a mocked Cloudflare API ---- */

const migrations = loadMigrations();

function migratedDatabase(throughVersion = Infinity) {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations.filter((m) => m.version <= throughVersion)) {
    for (const statement of splitStatements(migration.sql)) db.exec(statement);
  }
  db.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture-install', '0.1.22', ${Math.min(throughVersion, migrations.length)}, 0,
             '2026-08-20T00:00:00Z', 'test')`,
  );
  return db;
}

function apiResponse(result, { success = true, status = 200, message = "fixture denial" } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code: 7500, message }],
  }), { status, headers: { "content-type": "application/json" } });
}

/**
 * The whole deploy surface: worker upload, routes, schedules, and a D1 query
 * endpoint backed by the real SQLite database so UPDATEs PERSIST between
 * deploys — that persistence is exactly what fix two is about.
 */
function harness(db, { d1 = "live" } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const method = options.method || "GET";
    calls.push({ path, method });
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") {
      return apiResponse({});
    }
    if (path.endsWith("/workers/scripts/fixture-brain/subdomain")) {
      return apiResponse({ enabled: true });
    }
    if (path.endsWith("/workers/scripts/fixture-brain/schedules") && method === "PUT") {
      return apiResponse([]);
    }
    if (path === "/client/v4/accounts/fixture-account/d1/database/fixture-database/query" && method === "POST") {
      if (d1 === "outage") {
        return apiResponse(null, { success: false, status: 500, message: "internal error: fixture D1 outage" });
      }
      let sql = "", params = [];
      try { ({ sql = "", params = [] } = JSON.parse(options.body || "{}")); } catch { /* fall through */ }
      try {
        const text = String(sql).trim();
        if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
          return apiResponse([{ results: db.prepare(sql).all(...params), success: true, meta: {} }]);
        }
        const outcome = params.length ? db.prepare(sql).run(...params) : (db.exec(sql), null);
        return apiResponse([{ results: [], success: true, meta: { changes: Number(outcome?.changes || 0) } }]);
      } catch (error) {
        return apiResponse(null, { success: false, status: 400, message: String(error?.message || error) });
      }
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  const uploads = () => calls.filter((c) => c.method === "PUT" && c.path.endsWith("/workers/scripts/fixture-brain")).length;
  return { fetchImpl, calls, uploads };
}

async function withHarness(h, fn) {
  const priorFetch = globalThis.fetch;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    globalThis.fetch = h.fetchImpl;
    process.env.CLOUDFLARE_API_TOKEN = "fixture-cloudflare-value";
    return await fn();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
}

const attempt = async (h, options = {}) => {
  try {
    await withHarness(h, () => cmdDeploy(manifestPath, options));
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
};

const pauseRow = (db) => db.prepare(
  "SELECT vector_drain_pause, vector_drain_paused_at, vector_drain_pause_run FROM install_state WHERE id = 1",
).get();

/* ---- a healthy install deploys exactly as before ---- */

const db = migratedDatabase();
{
  const h = harness(db);
  const outcome = await attempt(h);
  check("a healthy install with no upgrade history deploys normally",
    outcome.ok && h.uploads() === 1, outcome.error);
}

/* ---- the incident: an unfinished upgrade refuses an active deploy ---- */

db.prepare(
  `INSERT INTO upgrade_runs (started_at, finished_at, from_version, to_version, status, d1_bookmark, detail)
   VALUES ('2026-08-27T05:00:00Z', '2026-08-27T05:04:00Z', '0.1.13', '0.1.16', 'failed',
           'fixture-bookmark', 'stage:migration scope:schema-partial')`,
).run();
{
  const h = harness(db);
  const outcome = await attempt(h);
  check("an active deploy over an unfinished upgrade is refused",
    outcome.ok === false, "the deploy went through");
  check("and the refusal names the run it found",
    /did not finish/.test(outcome.error) && /0\.1\.13 -> 0\.1\.16/.test(outcome.error) &&
      /stage:migration/.test(outcome.error),
    outcome.error);
  check("and it points at the repair commands, not just at a wall",
    /brain doctor <manifest> --repair/.test(outcome.error) && /brain update <manifest>/.test(outcome.error) &&
      /--force-active/.test(outcome.error),
    outcome.error);
  check("and nothing was uploaded before the refusal", h.uploads() === 0, JSON.stringify(h.calls));
}

/* ---- pausing is always allowed, and it leaves a durable record ---- */

{
  const h = harness(db);
  const outcome = await attempt(h, {
    pauseVectorDrainForUpgrade: true,
    pauseRunId: "2026-08-28T06:00:00Z",
  });
  const row = pauseRow(db);
  check("a paused-mode deploy is never blocked by the guard",
    outcome.ok && h.uploads() === 1, outcome.error);
  check("and the pause is recorded durably in install_state with the run that set it",
    row?.vector_drain_pause === "paused-for-upgrade" &&
      row?.vector_drain_pause_run === "2026-08-28T06:00:00Z" &&
      typeof row?.vector_drain_paused_at === "string",
    JSON.stringify(row));
}

/* ---- the pause survives the deploy that would have erased its binding ---- */

// Model the worst version of the incident: the update process was hard-killed,
// so it never even wrote a failed history row. Make the ledger LOOK clean;
// the durable record is then the only thing standing.
db.prepare("UPDATE upgrade_runs SET status = 'verified'").run();
{
  const h = harness(db);
  const outcome = await attempt(h);
  const row = pauseRow(db);
  check("a plain deploy cannot erase the pause: it is refused on the durable record alone",
    outcome.ok === false && /install_state records that corpus writes were paused/.test(outcome.error),
    outcome.error);
  check("and the refusal explains the record outlives deploys on purpose",
    /survives deploys ON PURPOSE/.test(outcome.error) && /--force-active/.test(outcome.error),
    outcome.error);
  check("and no binding rewrite happened: nothing was uploaded",
    h.uploads() === 0, JSON.stringify(h.calls));
  check("and the durable record is still intact after the refusal",
    row?.vector_drain_pause === "paused-for-upgrade" &&
      row?.vector_drain_pause_run === "2026-08-28T06:00:00Z",
    JSON.stringify(row));
}

/* ---- the operator who knows better, and the clean state afterwards ---- */

{
  const h = harness(db);
  const outcome = await attempt(h, { forceActive: true });
  const row = pauseRow(db);
  check("--force-active (as an option) deploys anyway and clears the durable pause",
    outcome.ok && h.uploads() === 1 && row?.vector_drain_pause === null &&
      row?.vector_drain_paused_at === null && row?.vector_drain_pause_run === null,
    outcome.error || JSON.stringify(row));
}

{
  const h = harness(db);
  const outcome = await attempt(h);
  check("after the upgrade history is finished and the pause is cleared, a plain deploy proceeds",
    outcome.ok && h.uploads() === 1, outcome.error);
}

/* ---- fail closed: an unreadable history is not a clean history ---- */

{
  const h = harness(db, { d1: "outage" });
  const outcome = await attempt(h);
  check("a D1 outage during the guard read refuses the deploy instead of assuming clean",
    outcome.ok === false && /upgrade history could not be read/.test(outcome.error) &&
      /fixture D1 outage/.test(outcome.error),
    outcome.error);
  check("and the outage refusal uploaded nothing", h.uploads() === 0, JSON.stringify(h.calls));
}

/* ---- a pre-0022 schema keeps working: the columns simply do not exist yet ---- */

{
  const oldDb = migratedDatabase(21);
  const h = harness(oldDb);
  const paused = await attempt(h, { pauseVectorDrainForUpgrade: true, pauseRunId: "2026-08-28T06:30:00Z" });
  const active = await attempt(h, { forceActive: true });
  const plain = await attempt(h);
  check("a schema-21 install pauses and deploys without the durable columns (binding still enforces)",
    paused.ok && active.ok && plain.ok && h.uploads() === 3,
    JSON.stringify({ paused: paused.error, active: active.error, plain: plain.error }));
  oldDb.close();
}

db.close();
rmSync(sandbox, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILURES` : `\ndeploy stranded-upgrade safety: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
