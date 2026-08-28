/*
 * FAILING REPRODUCTION, COMMITTED ON PURPOSE. Do not "fix" this test; fix the
 * product and this test turns green.
 *
 * WHAT IT PROVES
 *
 * A message export (WhatsApp .txt, SMS Backup & Restore .xml, Google Voice
 * Takeout .html) is ONE FILE that becomes MANY documents, one per conversation
 * session. brain.mjs builds that file's family plan with
 *
 *     base_doc_uid  = `${sourceName}:${FILE PATH}`
 *     keep_doc_uids = sanitized.map((e) => `${sourceName}:${e.source_id}`)
 *
 * but a message-session envelope's source_id is `session.first_id` (a content
 * hash of the session's first message, ingest/message-session.mjs), which is
 * not derived from the file path. worker/src/lib/store-d1.js forgetFamilies
 * then refuses the plan, because a keep uid must either EQUAL the base or
 * start with `${base}#part`.
 *
 * The perverse part, and the reason this shipped: the FAILURE path sends
 * keep_doc_uids: [] which passes validation, and a --dry-run never reaches
 * reconciliation at all. So reconciliation succeeds when the ingest failed,
 * and fails when the ingest succeeded.
 *
 * This drives the REAL CLI (brain ingest --path) against a scripted brain that
 * runs the REAL forgetFamilies against real SQLite built from the real
 * migrations. See test/fixtures/family-reconciliation-fetch.mjs.
 *
 * Deliberately NOT wired into package.json "test" yet, because it fails. Wire
 * it in as part of the fix, so the suite would catch a regression.
 *
 *   node --no-warnings test/family-reconciliation-repro.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepare as prepareFile } from "../ingest/run.mjs";
import { splitOversized } from "../ingest/envelope-batching.mjs";
import { forgetFamilies } from "../worker/src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const FETCH = pathToFileURL(join(HERE, "fixtures", "family-reconciliation-fetch.mjs")).href;
const WHATSAPP_FIXTURE = join(HERE, "fixtures", "whatsapp", "ios-unambiguous.txt");
const EXPORT_NAME = "WhatsApp Chat with Alex Rivera.txt";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};
const ESC = String.fromCharCode(27);
const strip = (s) => String(s).split(new RegExp(`${ESC}\\[[0-9;]*m`, "g")).join("");

/* ------------------------------------------------------------------------ *
 * 1. The exact values, computed by the real ingest code, checked against the
 *    real validation. No CLI, no network: the smallest statement of the bug.
 * ------------------------------------------------------------------------ */

const inertDb = {
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
};

const probeDir = mkdtempSync(join(tmpdir(), "brain-family-probe-"));
copyFileSync(WHATSAPP_FIXTURE, join(probeDir, EXPORT_NAME));
const probed = await prepareFile(
  { full: join(probeDir, EXPORT_NAME), rel: EXPORT_NAME, name: EXPORT_NAME, size: 1 },
  { sourceName: "upload" },
);

check("a WhatsApp export really is one file that becomes many documents",
  Array.isArray(probed.envelopes) && probed.envelopes.length > 1,
  JSON.stringify(probed.envelopes?.length));

// Exactly what brain.mjs builds for a multi-document file (brain.mjs ~5121).
const messagePlan = {
  base_doc_uid: `upload:${EXPORT_NAME}`,
  keep_doc_uids: probed.envelopes.map((e) => `upload:${e.source_id}`),
};
console.log("\n  message-export family plan the local ingest path builds:");
console.log(`    base_doc_uid : ${messagePlan.base_doc_uid}`);
for (const uid of messagePlan.keep_doc_uids) console.log(`    keep_doc_uid : ${uid}`);

let messageError = null;
try {
  await forgetFamilies(inertDb, { families: [messagePlan], dryRun: false });
} catch (error) {
  messageError = String(error.message);
}
console.log(`    forgetFamilies -> ${messageError || "accepted"}\n`);

check("forgetFamilies REJECTS the plan a successful message-export ingest builds",
  messageError === null,
  `rejected with: ${messageError}`);

// The control. splitOversized DOES follow the #part convention, so an
// oversized ordinary document produces a family plan that validates. The
// difference between these two is the whole bug.
const oversizedParts = splitOversized(
  { source_type: "upload", source_id: "notes/big.txt", title: "big", content: "x".repeat(900_000), metadata: {} },
);
const splitPlan = {
  base_doc_uid: "upload:notes/big.txt",
  keep_doc_uids: oversizedParts.map((e) => `upload:${e.source_id}`),
};
let splitError = null;
try {
  await forgetFamilies(inertDb, { families: [splitPlan], dryRun: false });
} catch (error) {
  splitError = String(error.message);
}
check("the oversized-split family plan (the #part convention) is accepted",
  splitError === null, String(splitError));
check("the control really does exercise a multi-part family",
  oversizedParts.length > 1 && splitPlan.keep_doc_uids.every((uid) => uid.startsWith(`${splitPlan.base_doc_uid}#part`)),
  JSON.stringify(splitPlan.keep_doc_uids));

// And the failure path, which is what has been silently passing all along.
let emptyError = null;
try {
  await forgetFamilies(inertDb, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: [] }], dryRun: false,
  });
} catch (error) {
  emptyError = String(error.message);
}
check("the FAILURE path (keep_doc_uids: []) is accepted, which is why nobody noticed",
  emptyError === null, String(emptyError));

/* ------------------------------------------------------------------------ *
 * 2. End to end. The real CLI, the real local ingest, a scripted brain that
 *    runs the real forgetFamilies. A fully accepted ingest must not fail.
 * ------------------------------------------------------------------------ */

function runIngest({ label, files, env: extraEnv = {} }) {
  const dir = mkdtempSync(join(tmpdir(), `brain-family-${label}-`));
  const manifest = join(dir, "fixture.manifest.json");
  const source = join(dir, "source");
  const userRoot = join(dir, "isolated-user-root");
  const evidencePath = join(dir, "evidence.json");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(userRoot, ".brain"), { recursive: true });
  for (const [name, produce] of Object.entries(files)) produce(join(source, name));
  writeFileSync(manifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: {},
  }));

  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.BRAIN_DEBUG;
  Object.assign(env, {
    NO_COLOR: "1",
    ADMIN_KEY: "fixture-admin",
    BRAIN_FAMILY_REPRO_USER_ROOT: userRoot,
    BRAIN_FAMILY_REPRO_EVIDENCE: evidencePath,
    ...extraEnv,
  });

  const result = spawnSync(process.execPath, [
    "--import", FETCH, CLI, "ingest", manifest, "--path", source,
  ], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(result.error, undefined, String(result.error || ""));
  let evidence = null;
  try { evidence = JSON.parse(readFileSync(evidencePath, "utf8")); } catch { /* reported by the caller */ }
  return {
    code: result.status,
    out: strip(`${result.stdout || ""}${result.stderr || ""}`),
    evidence,
    statePath: join(dir, ".brain-ingest-upload.json"),
    dir,
  };
}

// Long enough to split into #part documents, and varied enough to clear the
// repeated-content quality gate in ingest/quality.mjs.
function longVariedProse(targetChars) {
  const out = [];
  let size = 0;
  for (let i = 0; size < targetChars; i++) {
    const line =
      `Entry ref-${i.toString(36)}-${(i * 7919 % 99991).toString(36)}: the planning note records ` +
      `what owner-${(i % 137).toString(36)} agreed about milestone-${(i % 211).toString(36)}, ` +
      `the amount ${1000 + (i % 8999)} it depends on, and the date it is expected to land.\n`;
    out.push(line);
    size += line.length;
  }
  return out.join("");
}

/* ---- 2a. the success path on a WhatsApp export ---- */
const whatsapp = runIngest({
  label: "whatsapp",
  files: { [EXPORT_NAME]: (path) => copyFileSync(WHATSAPP_FIXTURE, path) },
});

console.log("\n  --- CLI output, WhatsApp export, every part accepted ---");
console.log(whatsapp.out.trimEnd().split("\n").map((l) => `  | ${l}`).join("\n"));
console.log("");

const rejection = whatsapp.evidence?.forgetRejections?.[0] || null;
check("every session document was accepted by the scripted brain",
  (whatsapp.evidence?.storedDocUids || []).length === probed.envelopes.length,
  JSON.stringify(whatsapp.evidence?.storedDocUids));
check("a fully accepted WhatsApp export ingest exits 0",
  whatsapp.code === 0,
  `exit ${whatsapp.code}; rejection: ${rejection ? rejection.message : "(none)"}`);
check("the worker never rejected the reconciliation request",
  (whatsapp.evidence?.forgetRejections || []).length === 0,
  JSON.stringify(whatsapp.evidence?.forgetRejections));
check("the ingest does not end in split-document cleanup failure",
  !/split-document cleanup failed/i.test(whatsapp.out),
  whatsapp.out.slice(-400));

/* ---- 2b. the perverse control: the SAME file, every part failed ---- */
const failed = runIngest({
  label: "whatsapp-failed",
  files: { [EXPORT_NAME]: (path) => copyFileSync(WHATSAPP_FIXTURE, path) },
  env: { BRAIN_FAMILY_REPRO_FAIL_ALL: "1" },
});
const failedFamilies = (failed.evidence?.forgetRequests || []).flat();
check("when the ingest FAILS, reconciliation is accepted (empty keep list)",
  failedFamilies.length > 0 &&
    failedFamilies.every((f) => Array.isArray(f.keep_doc_uids) && f.keep_doc_uids.length === 0) &&
    (failed.evidence?.forgetRejections || []).length === 0,
  JSON.stringify(failed.evidence?.forgetRejections || failedFamilies));
check("the failed ingest still exits non-zero for its own reason",
  failed.code === 1, failed.out.slice(-300));

/* ---- 2c. the control: an oversized ordinary file that splits into #parts ---- */
const oversized = runIngest({
  label: "oversized",
  files: {
    "big-notes.txt": (path) => writeFileSync(path, longVariedProse(900_000)),
  },
});
console.log("\n  --- CLI output, oversized ordinary .txt (the #part control) ---");
console.log(oversized.out.trimEnd().split("\n").map((l) => `  | ${l}`).join("\n"));
console.log("");
check("an oversized ordinary document splits into more than one stored part",
  (oversized.evidence?.storedDocUids || []).length > 1,
  JSON.stringify(oversized.evidence?.storedDocUids));
check("the oversized-split ingest reconciles and exits 0",
  oversized.code === 0 && (oversized.evidence?.forgetRejections || []).length === 0,
  `exit ${oversized.code}; ${JSON.stringify(oversized.evidence?.forgetRejections)}`);

/* ------------------------------------------------------------------------ *
 * 3. Why relaxing the guard would NOT be a fix.
 *
 * The family's delete scope is decided entirely by base_doc_uid: forgetFamilies
 * only ever looks at `base` and `base#part...`. Keyed on the FILE PATH, that
 * scope contains none of the session documents, which are stored under
 * `message:<first message id>` (the envelope's own source_type, not the ingest
 * source name). So a guard that simply accepted the current plan would answer
 * 200 and delete nothing, leaving stale sessions from a previous version of the
 * same export orphaned forever. Both halves of the family key are wrong.
 * ------------------------------------------------------------------------ */

const storedUids = whatsapp.evidence?.storedDocUids || [];
console.log("  doc_uids the brain actually stored:");
for (const uid of storedUids) console.log(`    ${uid}`);
console.log("  doc_uids the family plan asks to keep:");
for (const uid of messagePlan.keep_doc_uids) console.log(`    ${uid}`);
console.log("");

check("the plan's keep uids are the doc_uids the brain actually stored",
  storedUids.length > 0 &&
    JSON.stringify([...storedUids].sort()) === JSON.stringify([...messagePlan.keep_doc_uids].sort()),
  `stored ${JSON.stringify(storedUids)} vs keep ${JSON.stringify(messagePlan.keep_doc_uids)}`);

// The scope, measured with the one request shape the guard accepts today.
const scopeDb = new DatabaseSync(":memory:");
{
  const dir = join(HERE, "..", "migrations", "d1");
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    scopeDb.exec(readFileSync(join(dir, f), "utf-8"));
  }
  scopeDb.prepare(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,'fixture','0.0.0',12,0,'2026-01-01T00:00:00Z','test')`
  ).run();
  for (const uid of storedUids) {
    scopeDb.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES (?,?,?,?,?,?)`
    ).run(uid, String(uid).split(":")[0], String(uid).slice(String(uid).indexOf(":") + 1), uid, Date.now(), `h:${uid}`);
  }
}
const scopeEnv = {
  STORAGE: "d1",
  DB: {
    prepare: (sql) => {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        all: async () => ({ results: scopeDb.prepare(sql).all(...params) }),
        first: async () => scopeDb.prepare(sql).get(...params) ?? null,
        run: async () => ({ success: true, results: [], meta: { changes: 0 } }),
        _sql: sql, _params: params,
      });
      return shape();
    },
    batch: async () => [],
  },
};
const scope = await forgetFamilies(scopeEnv, {
  families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: [] }],
  dryRun: true,
});
console.log(`  delete scope for base ${messagePlan.base_doc_uid}: ${JSON.stringify(scope.targets)}\n`);
check("the family's delete scope reaches the stored session documents",
  storedUids.length > 0 && storedUids.every((uid) => scope.targets.includes(uid)),
  `scope was ${JSON.stringify(scope.targets)}`);

console.log(`\n${fail ? "FAILED" : "ok"}  ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
