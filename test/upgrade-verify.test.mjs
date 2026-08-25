// From Jay's second field report, 2026-08-19.
//
// `brain upgrade` probed /health, got a 200 from the worker it was REPLACING,
// printed that worker's version, and declared the new one verified:
//
//     ok deployed "bhakta-brain"
//     ok /health 200 {"ok":true,"version":"0.1.1", ...}
//     ok upgrade verified, now at 0.1.2
//
// Sixteen seconds later /health returned 0.1.2, so nothing was harmed that time.
// But the check would pass green on a deploy that genuinely failed, which makes
// it worse than no check: it converts an unknown into a false assurance.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdUpgrade, healthProbeVerdict } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const V = (o) => healthProbeVerdict(o);
const body = (v) => JSON.stringify({ ok: true, brain: "x", version: v });

/* ---- the exact failure Jay saw ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("a 200 from the OLD worker is not accepted as the new one", v !== "accept", `got ${v}`);
  check("it retries instead, because propagation is normal", v === "retry", `got ${v}`);
}

/* ---- it must eventually give up rather than pass ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("if the old version is STILL serving on the last attempt, it FAILS", v === "fail", `got ${v}`);
}

/* ---- the happy path still works ---- */
{
  check("the expected version is accepted immediately",
    V({ ok: true, body: body("0.1.2"), expectVersion: "0.1.2", attempt: 1, attempts: 6 }) === "accept");
  check("a plain health check with no expectation still accepts any 200",
    V({ ok: true, body: body("0.1.1"), expectVersion: null, attempt: 1, attempts: 6 }) === "accept");
}

/* ---- a body that cannot be parsed must not be read as success ---- */
{
  const v = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("an unparseable body is not treated as the right version", v !== "accept", `got ${v}`);
  const last = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("and fails once the attempts are spent", last === "fail", `got ${last}`);
}

/* ---- a version-less body is not a pass either ---- */
{
  const v = V({ ok: true, body: JSON.stringify({ ok: true }), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("a 200 carrying no version at all fails rather than passing", v === "fail", `got ${v}`);
}

/* ---- non-200s keep the old retry behaviour ---- */
{
  check("a 404 retries while attempts remain", V({ ok: false, body: "", attempt: 1, attempts: 6 }) === "retry");
  check("and fails when they are spent", V({ ok: false, body: "", attempt: 6, attempts: 6 }) === "fail");
}

/* ---- a normal upgrade reconciles provider secrets before health passes ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-provider-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { worker_name: "fixture-brain" },
      infrastructure: {
        cloudflare: {
          account_id: "fixture-account",
          d1_database_id: "fixture-database",
          storage: "d1",
        },
      },
      retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false },
    }));
    const events = [];
    await cmdUpgrade(manifestPath, {
      resolveAccount: async () => {
        events.push("account");
        return { id: "fixture-account" };
      },
      d1Query: async (_account, _database, sql) => {
        if (/SELECT \* FROM install_state/i.test(sql)) {
          events.push("state");
          return { results: [{ product_version: "0.1.9" }] };
        }
        if (/UPDATE install_state/i.test(sql)) events.push("version");
        if (/INSERT INTO upgrade_runs/i.test(sql)) events.push("log");
        return { results: [] };
      },
      cf: async () => {
        events.push("bookmark");
        return { bookmark: "fixture-bookmark" };
      },
      cmdMigrate: async () => { events.push("migrate"); },
      cmdDeploy: async () => { events.push("deploy"); },
      reconcileWorkerProviderSecrets: async (_manifest, account, scriptName, allowed) => {
        events.push("reconcile");
        check("upgrade reconciliation uses the resolved account", account.id === "fixture-account");
        check("upgrade reconciliation targets only this worker", scriptName === "fixture-brain");
        check("standard D1 upgrade allows no provider secrets", Array.isArray(allowed) && allowed.length === 0);
      },
      cmdHealth: async (_path, options) => {
        events.push("health");
        check("upgrade health requires the running package version", options.expectVersion === "0.1.10");
      },
    });
    check(
      "upgrade reconciles provider secrets after deploy and before health",
      events.join(",") === "account,state,bookmark,migrate,deploy,reconcile,health,version,log",
      events.join(","),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\nupgrade verification: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
