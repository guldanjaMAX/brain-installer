/*
 * REGRESSION TEST for message-export document families.
 *
 * THE BUG THIS LOCKS DOWN
 *
 * A message export (WhatsApp .txt, SMS Backup & Restore .xml, Google Voice
 * Takeout) is ONE FILE that becomes MANY documents, one per conversation
 * session. brain.mjs used to build that file's family plan with
 *
 *     base_doc_uid  = `${sourceName}:${FILE PATH}`
 *     keep_doc_uids = sanitized.map((e) => `${sourceName}:${e.source_id}`)
 *
 * while the documents are actually stored as `message:<first message id>`
 * (worker/src/lib/store.js keys doc_uid on the ENVELOPE's own source_type, and
 * ingest/message-session.mjs sets source_id from session.first_id). Wrong on
 * both axes: wrong namespace, wrong identity. worker/src/lib/store-d1.js
 * forgetFamilies refused the plan, so a fully SUCCESSFUL ingest died at the
 * very last step, after all the work.
 *
 * The perverse part, and the reason it shipped: the FAILURE path sends
 * keep_doc_uids: [] which passes validation, and a --dry-run never reaches
 * reconciliation at all. Reconciliation succeeded when the ingest failed and
 * failed when the ingest succeeded.
 *
 * THE FIX BEING GUARDED. The producer now DECLARES the relationship: every
 * document a multi-document file yields carries `metadata.family_of` holding
 * the fully qualified uid of the file it came from (ingest/run.mjs), the delete
 * scope reads that declaration (store-d1.js), and the guard checks membership
 * against it instead of against a name prefix.
 *
 * WHAT MUST STAY TRUE, and which section proves it:
 *   1  a successful message-export ingest reconciles                  (1, 5)
 *   2  the failure path keeps working                                 (3, 7)
 *   3  a real export loads end to end                                 (5)
 *   4  re-loading the same export duplicates nothing                  (6)
 *   5  cleanup still cannot delete the revision it reconciles         (4)
 *
 * Section 4 is the one that must not be weakened. It fails if anyone "fixes" a
 * future family bug by loosening the guard rather than by making the family
 * relationship true.
 *
 *   node --no-warnings test/family-reconciliation.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepare as prepareFile } from "../ingest/run.mjs";
import { splitOversized } from "../ingest/envelope-batching.mjs";
import { sanitizeEnvelope } from "../worker/src/lib/secret-scan.js";
import { forgetFamilies } from "../worker/src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const FETCH = pathToFileURL(join(HERE, "fixtures", "family-reconciliation-fetch.mjs")).href;
const WHATSAPP_FIXTURE = join(HERE, "fixtures", "whatsapp", "ios-unambiguous.txt");
const EXPORT_NAME = "WhatsApp Chat with Alex Rivera.txt";
const MBOX_FIXTURE = join(HERE, "fixtures", "formats", "three-messages.mbox");

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};
const ESC = String.fromCharCode(27);
const strip = (s) => String(s).split(new RegExp(`${ESC}\\[[0-9;]*m`, "g")).join("");
const sorted = (list) => JSON.stringify([...list].sort());

/* ------------------------------------------------------------------------ *
 * A real brain: the real migrations, real SQLite, a D1-shaped env. Deletes
 * really delete, so a claim that the current revision survived is measured
 * rather than asserted.
 * ------------------------------------------------------------------------ */

function makeBrain() {
  const db = new DatabaseSync(":memory:");
  const dir = join(HERE, "..", "migrations", "d1");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,'fixture','0.0.0',12,0,'2026-01-01T00:00:00Z','test')`
  ).run();

  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(r.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    STORAGE: "d1",
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
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  return {
    env,
    store(docUid, { source, sourceId, metadata = {} } = {}) {
      db.prepare(
        `INSERT OR REPLACE INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        docUid,
        source ?? String(docUid).split(":")[0],
        sourceId ?? String(docUid).slice(String(docUid).indexOf(":") + 1),
        docUid, Date.now(), `hash:${docUid}`, JSON.stringify(metadata),
      );
    },
    liveDocUids: () => db.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((r) => r.doc_uid),
  };
}

/**
 * Exactly what brain.mjs builds for a file that became many documents: the
 * family uid read back off the SANITIZED envelopes, and the doc_uids the store
 * will actually key on (worker store.js: `${source_type}:${source_id}`).
 *
 * The fallback is deliberate. If the producer stops declaring a family this
 * drops back to the pre-fix key, so the regression shows up as failing
 * BEHAVIOUR here rather than as a crash that says nothing about what broke.
 */
function planFor(envelopes, rel) {
  const sanitized = envelopes.map((e) => sanitizeEnvelope(e));
  const declared = [...new Set(sanitized.map((e) => String(e.metadata?.family_of || "")))];
  return {
    sanitized,
    declaresOneFamily: declared.length === 1 && Boolean(declared[0]),
    base_doc_uid: declared.length === 1 && declared[0] ? declared[0] : `upload:${rel}`,
    keep_doc_uids: sanitized.map((e) => `${e.source_type}:${e.source_id}`),
  };
}

async function prepareFixture(fixturePath, name) {
  const dir = mkdtempSync(join(tmpdir(), "brain-family-probe-"));
  copyFileSync(fixturePath, join(dir, name));
  return prepareFile(
    { full: join(dir, name), rel: name, name, size: 1 },
    { sourceName: "upload" },
  );
}

/* ------------------------------------------------------------------------ *
 * 1. Every message-export format builds a family the store accepts, and that
 *    family reaches the documents the store actually holds.
 * ------------------------------------------------------------------------ */

const FORMATS = [
  ["whatsapp (iOS)", join(HERE, "fixtures", "whatsapp", "ios-unambiguous.txt"), EXPORT_NAME],
  ["whatsapp (Android)", join(HERE, "fixtures", "whatsapp", "android-unambiguous.txt"), "WhatsApp Chat with Priya Nair.txt"],
  ["whatsapp (order-only dates)", join(HERE, "fixtures", "whatsapp", "monotonicity-only.txt"), "WhatsApp Chat with Sam Osei.txt"],
  ["sms backup & restore", join(HERE, "fixtures", "sms-backup", "sms-backup-restore.xml"), "sms-20240301.xml"],
  ["google voice takeout", join(HERE, "fixtures", "google-voice", "Jordan Lee - Text - 2024-03-01T09_00_00Z.html"), "Jordan Lee - Text - 2024-03-01T09_00_00Z.html"],
];

const probed = await prepareFixture(WHATSAPP_FIXTURE, EXPORT_NAME);
check("a WhatsApp export really is one file that becomes many documents",
  Array.isArray(probed.envelopes) && probed.envelopes.length > 1,
  JSON.stringify(probed.envelopes?.length));

const messagePlan = planFor(probed.envelopes, EXPORT_NAME);
console.log("\n  message-export family plan the local ingest path builds:");
console.log(`    base_doc_uid : ${messagePlan.base_doc_uid}`);
for (const uid of messagePlan.keep_doc_uids) console.log(`    keep_doc_uid : ${uid}`);
console.log("");

for (const [label, path, name] of FORMATS) {
  const r = await prepareFixture(path, name);
  if (!Array.isArray(r.envelopes) || !r.envelopes.length) {
    check(`${label}: produced documents`, false, JSON.stringify(Object.keys(r)));
    continue;
  }
  const plan = planFor(r.envelopes, name);
  check(`${label}: every document it produced declares the same origin file`,
    plan.declaresOneFamily,
    JSON.stringify(plan.sanitized.map((e) => e.metadata?.family_of ?? null)));
  const brain = makeBrain();
  // Store them the way the worker would: doc_uid from the envelope's own
  // source_type + source_id, meta carrying the declaration.
  for (const e of plan.sanitized) {
    brain.store(`${e.source_type}:${e.source_id}`, {
      source: e.source_type, sourceId: e.source_id, metadata: e.metadata,
    });
  }
  let error = null;
  let scope = null;
  try {
    await forgetFamilies(brain.env, {
      families: [{ base_doc_uid: plan.base_doc_uid, keep_doc_uids: plan.keep_doc_uids }],
      dryRun: false,
    });
    scope = await forgetFamilies(brain.env, {
      families: [{ base_doc_uid: plan.base_doc_uid, keep_doc_uids: [] }],
      dryRun: true,
    });
  } catch (e) {
    error = String(e.message);
  }
  check(`${label}: the family plan a successful ingest builds is accepted`, error === null, String(error));
  check(`${label}: the family reaches every document the brain stored`,
    error === null && sorted(scope.targets) === sorted(plan.keep_doc_uids),
    `scope ${JSON.stringify(scope?.targets)} vs stored ${JSON.stringify(plan.keep_doc_uids)}`);
  check(`${label}: reconciling a complete revision deletes none of it`,
    error === null && sorted(brain.liveDocUids()) === sorted(plan.keep_doc_uids),
    JSON.stringify(brain.liveDocUids()));
}

/* ------------------------------------------------------------------------ *
 * 2. Control: the structural `#part` family still validates unchanged.
 * ------------------------------------------------------------------------ */

const oversizedParts = splitOversized(
  { source_type: "upload", source_id: "notes/big.txt", title: "big", content: "x".repeat(900_000), metadata: {} },
);
const splitPlan = {
  base_doc_uid: "upload:notes/big.txt",
  keep_doc_uids: oversizedParts.map((e) => `upload:${e.source_id}`),
};
let splitError = null;
try {
  await forgetFamilies(makeBrain().env, { families: [splitPlan], dryRun: false });
} catch (error) {
  splitError = String(error.message);
}
check("the oversized-split family plan (the #part convention) is still accepted",
  splitError === null, String(splitError));
check("the control really does exercise a multi-part family",
  oversizedParts.length > 1 && splitPlan.keep_doc_uids.every((uid) => uid.startsWith(`${splitPlan.base_doc_uid}#part`)),
  JSON.stringify(splitPlan.keep_doc_uids));

/* ------------------------------------------------------------------------ *
 * 3. Control: the failure path (keep_doc_uids: []) is still accepted.
 * ------------------------------------------------------------------------ */

let emptyError = null;
try {
  await forgetFamilies(makeBrain().env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: [] }], dryRun: false,
  });
} catch (error) {
  emptyError = String(error.message);
}
check("the failure path (keep_doc_uids: []) is still accepted",
  emptyError === null, String(emptyError));

/* ------------------------------------------------------------------------ *
 * 4. PROTECTION. Cleanup must remain unable to remove the revision it is
 *    reconciling. Do not weaken anything in this section.
 *
 *    This got MORE important with the fix, not less. Before it, the delete
 *    scope for a message export was empty, so a wrong keep list was merely
 *    inert. Now the scope really does hold every session document, so a wrong
 *    keep list protects nothing while the scope is real: accepting one would
 *    delete the entire freshly-loaded export. The guard is what stands between
 *    those two facts.
 * ------------------------------------------------------------------------ */

const atRisk = makeBrain();
for (const e of messagePlan.sanitized) {
  atRisk.store(`${e.source_type}:${e.source_id}`, {
    source: e.source_type, sourceId: e.source_id, metadata: e.metadata,
  });
}

// First measure that these documents genuinely are inside the delete scope,
// so the refusal below is protecting something real rather than nothing.
let atRiskScope = null;
try {
  atRiskScope = await forgetFamilies(atRisk.env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: [] }], dryRun: true,
  });
} catch (error) {
  atRiskScope = { targets: [], error: String(error.message) };
}
check("the freshly-loaded export IS inside its family's delete scope",
  sorted(atRiskScope.targets || []) === sorted(messagePlan.keep_doc_uids),
  JSON.stringify(atRiskScope));

// The exact pre-fix plan: right base, keep uids in the wrong namespace. Every
// one of them is a real document under a different name, so an unguarded
// cleanup would find nothing to keep and delete the whole revision.
const wrongNamespaceKeep = messagePlan.sanitized.map((e) => `upload:${e.source_id}`);
let wrongNamespaceError = null;
try {
  await forgetFamilies(atRisk.env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: wrongNamespaceKeep }],
    dryRun: false,
  });
} catch (error) {
  wrongNamespaceError = String(error.message);
}
check("a keep list in the wrong namespace is REFUSED, not silently accepted",
  wrongNamespaceError !== null, "it was accepted");
check("and the revision it would have deleted is still there",
  sorted(atRisk.liveDocUids()) === sorted(messagePlan.keep_doc_uids),
  JSON.stringify(atRisk.liveDocUids()));

// A keep uid belonging to a different family is still refused.
const stranger = makeBrain();
stranger.store("drive:F1");
stranger.store("drive:F2");
let strangerError = null;
try {
  await forgetFamilies(stranger.env, {
    families: [{ base_doc_uid: "drive:F1", keep_doc_uids: ["drive:F2"] }], dryRun: false,
  });
} catch (error) {
  strangerError = String(error.message);
}
check("a keep uid from another family is still refused",
  strangerError !== null, "it was accepted");
check("and neither document was removed",
  sorted(stranger.liveDocUids()) === sorted(["drive:F1", "drive:F2"]),
  JSON.stringify(stranger.liveDocUids()));

// A document cannot smuggle itself into a family it does not declare.
const forged = makeBrain();
forged.store("message:kept", { metadata: { family_of: messagePlan.base_doc_uid } });
forged.store("message:elsewhere", { metadata: { family_of: "upload:some other export.txt" } });
let forgedError = null;
try {
  await forgetFamilies(forged.env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: ["message:kept", "message:elsewhere"] }],
    dryRun: false,
  });
} catch (error) {
  forgedError = String(error.message);
}
check("a document that declares a DIFFERENT family cannot be kept in this one",
  forgedError !== null, "it was accepted");
check("and a document of another family is never in this family's delete scope",
  sorted(forged.liveDocUids()) === sorted(["message:kept", "message:elsewhere"]),
  JSON.stringify(forged.liveDocUids()));

// The transition the family mechanism exists for: a re-export that dropped one
// conversation. The stale session goes, both current ones stay.
const revised = makeBrain();
for (const e of messagePlan.sanitized) {
  revised.store(`${e.source_type}:${e.source_id}`, {
    source: e.source_type, sourceId: e.source_id, metadata: e.metadata,
  });
}
revised.store("message:stale-session-from-a-previous-export", {
  source: "message", sourceId: "stale-session-from-a-previous-export",
  metadata: { family_of: messagePlan.base_doc_uid },
});
let revision = null;
try {
  revision = await forgetFamilies(revised.env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: messagePlan.keep_doc_uids }],
    dryRun: false,
  });
} catch (error) {
  revision = { error: String(error.message) };
}
check("a stale session from a previous revision of the same export IS removed",
  Number(revision?.documents) === 1 && !revised.liveDocUids().includes("message:stale-session-from-a-previous-export"),
  `${JSON.stringify(revision)} ${JSON.stringify(revised.liveDocUids())}`);
check("and every session of the current revision survived that removal",
  sorted(revised.liveDocUids()) === sorted(messagePlan.keep_doc_uids),
  JSON.stringify(revised.liveDocUids()));

// The companion defect the same declaration repairs: removing the FILE (a
// private-path-prefix removal, or a credential-scanner refusal on a re-run)
// used to resolve to `upload:<path>`, match nothing, and retract none of the
// session documents it was supposed to retract.
const retracted = makeBrain();
for (const e of messagePlan.sanitized) {
  retracted.store(`${e.source_type}:${e.source_id}`, {
    source: e.source_type, sourceId: e.source_id, metadata: e.metadata,
  });
}
retracted.store("message:unrelated-conversation", { source: "message", sourceId: "unrelated-conversation" });
let retraction = null;
try {
  retraction = await forgetFamilies(retracted.env, {
    families: [{ base_doc_uid: messagePlan.base_doc_uid, keep_doc_uids: [] }], dryRun: false,
  });
} catch (error) {
  retraction = { error: String(error.message) };
}
check("retracting the FILE removes every document it produced",
  Number(retraction?.documents) === messagePlan.keep_doc_uids.length &&
    sorted(retracted.liveDocUids()) === sorted(["message:unrelated-conversation"]),
  `${JSON.stringify(retraction)} ${JSON.stringify(retracted.liveDocUids())}`);

/* ------------------------------------------------------------------------ *
 * 5-8. End to end. The real CLI, the real local ingest, a scripted brain that
 *      runs the real forgetFamilies against real SQLite.
 * ------------------------------------------------------------------------ */

function runIngest({ label, files, env: extraEnv = {}, dbPath = null, dir = null, args = [] }) {
  const root = dir || mkdtempSync(join(tmpdir(), `brain-family-${label}-`));
  const manifest = join(root, "fixture.manifest.json");
  const source = join(root, "source");
  const userRoot = join(root, "isolated-user-root");
  const evidencePath = join(root, `evidence-${label}.json`);
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
    ...(dbPath ? { BRAIN_FAMILY_REPRO_DB: dbPath } : {}),
    ...extraEnv,
  });

  const result = spawnSync(process.execPath, [
    "--import", FETCH, CLI, "ingest", manifest, "--path", source, ...args,
  ], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(result.error, undefined, String(result.error || ""));
  let evidence = null;
  try { evidence = JSON.parse(readFileSync(evidencePath, "utf8")); } catch { /* reported by the caller */ }
  return {
    code: result.status,
    out: strip(`${result.stdout || ""}${result.stderr || ""}`),
    evidence,
    statePath: join(root, ".brain-ingest-upload.json"),
    dir: root,
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

/* ---- 5. the success path on a WhatsApp export ---- */
const sharedBrainDir = mkdtempSync(join(tmpdir(), "brain-family-shared-"));
const sharedDb = join(sharedBrainDir, "brain.sqlite");
const whatsapp = runIngest({
  label: "whatsapp",
  files: { [EXPORT_NAME]: (path) => copyFileSync(WHATSAPP_FIXTURE, path) },
  dbPath: sharedDb,
});

console.log("\n  --- CLI output, WhatsApp export, every part accepted ---");
console.log(whatsapp.out.trimEnd().split("\n").map((l) => `  | ${l}`).join("\n"));
console.log("");

const rejection = whatsapp.evidence?.forgetRejections?.[0] || null;
check("every session document was accepted by the scripted brain",
  (whatsapp.evidence?.storedDocUids || []).length === probed.envelopes.length,
  JSON.stringify(whatsapp.evidence?.storedDocUids));
check("accepted WhatsApp messages do not hide the export's omitted media",
  whatsapp.code === 1 && /partial coverage/.test(whatsapp.out),
  `exit ${whatsapp.code}; rejection: ${rejection ? rejection.message : "(none)"}`);
check("the worker never rejected the reconciliation request",
  (whatsapp.evidence?.forgetRejections || []).length === 0,
  JSON.stringify(whatsapp.evidence?.forgetRejections));
check("the ingest does not end in split-document cleanup failure",
  !/split-document cleanup failed/i.test(whatsapp.out),
  whatsapp.out.slice(-400));
check("the plan's keep uids are the doc_uids the brain actually stored",
  sorted(whatsapp.evidence?.storedDocUids || []) === sorted(messagePlan.keep_doc_uids),
  `stored ${JSON.stringify(whatsapp.evidence?.storedDocUids)} vs keep ${JSON.stringify(messagePlan.keep_doc_uids)}`);
check("reconciliation removed nothing from a first, complete load",
  (whatsapp.evidence?.forgetResults || []).every((r) => Number(r.documents) === 0),
  JSON.stringify(whatsapp.evidence?.forgetResults));

/* ---- 6. the same export loaded AGAIN into the SAME brain ---- */
const readback = new DatabaseSync(sharedDb);
const uidsAfterFirst = readback.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((r) => r.doc_uid);
const reload = runIngest({
  label: "whatsapp-reload",
  files: { [EXPORT_NAME]: (path) => copyFileSync(WHATSAPP_FIXTURE, path) },
  dbPath: sharedDb,
});
const uidsAfterReload = readback.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((r) => r.doc_uid);
check("re-loading preserves the same visible incomplete-export result",
  reload.code === 1 && /partial coverage/.test(reload.out) && (reload.evidence?.forgetRejections || []).length === 0,
  `exit ${reload.code}; ${JSON.stringify(reload.evidence?.forgetRejections)}; ${reload.out.slice(-500)}`);
check("re-loading the same export duplicates no documents",
  uidsAfterFirst.length > 1 && sorted(uidsAfterReload) === sorted(uidsAfterFirst),
  `${JSON.stringify(uidsAfterFirst)} -> ${JSON.stringify(uidsAfterReload)}`);
check("and re-loading deletes none of them either",
  (reload.evidence?.forgetResults || []).every((r) => Number(r.documents) === 0),
  JSON.stringify(reload.evidence?.forgetResults));

/* ---- 6a. a vanished export is planned from live family truth and read back ---- */
rmSync(join(whatsapp.dir, "source", EXPORT_NAME));
const deletionStopped = runIngest({
  label: "whatsapp-delete-plan", files: {}, dbPath: sharedDb, dir: whatsapp.dir,
});
const deletionFingerprint = /--approve-removals ([0-9a-f]{64})/.exec(deletionStopped.out)?.[1] || null;
check("a whole-family watched-folder deletion stops at the aggregate approval gate",
  deletionStopped.code === 1 && !!deletionFingerprint &&
  (deletionStopped.evidence?.forgetRequests || []).length === 0,
  deletionStopped.out.slice(-500));
check("the deletion plan read authenticated family truth before asking for approval",
  Number(deletionStopped.evidence?.inventoryRequests || 0) >= 1,
  JSON.stringify(deletionStopped.evidence));

const deletionApproved = runIngest({
  label: "whatsapp-delete-approved", files: {}, dbPath: sharedDb, dir: whatsapp.dir,
  args: ["--approve-removals", deletionFingerprint],
});
const afterDeletion = new DatabaseSync(sharedDb)
  .prepare("SELECT doc_uid FROM documents WHERE deleted_at IS NULL ORDER BY doc_uid")
  .all().map((row) => row.doc_uid);
check("the exact approved watched-folder plan removes the declared message family",
  deletionApproved.code === 0 && afterDeletion.length === 0,
  `exit ${deletionApproved.code}; ${JSON.stringify(afterDeletion)}; ${deletionApproved.out.slice(-400)}`);
check("watched-folder deletion performs authenticated post-delete readback",
  Number(deletionApproved.evidence?.inventoryRequests || 0) >= 2,
  JSON.stringify(deletionApproved.evidence));

/* ---- 6b. a .mbox ARCHIVE, the producer this file's own guard missed ---- */
//
// THE BUG. `prepareMboxArchive` was the ONLY multi-document producer in
// ingest/run.mjs that did not call declareFamily(). Every other one does. That
// is not cosmetic: cmdIngestLocal hard-throws when a multi-envelope result
// carries no family declaration, so ONE .mbox anywhere under an ingested folder
// aborted the ENTIRE run, dry run included, and took every unrelated file in
// that folder down with it. A client with a mail archive in their documents
// folder would have seen their whole first ingest fail.
//
// WHY NO TEST SAW IT. Every other mbox test calls prepare() directly and never
// goes through the ingest command, so the throw sits in a seam none of them
// cross. This section crosses it, which is the only reason it is here rather
// than in the mbox tests.
//
// The ordinary note is not decoration. It is the "took everything with it"
// half of the bug, and it is what fails if someone reintroduces the abort.
{
  const mboxDir = mkdtempSync(join(tmpdir(), "brain-family-mbox-"));
  const mboxDb = join(mboxDir, "brain.sqlite");
  const archive = runIngest({
    label: "mbox",
    files: {
      "archive.mbox": (path) => copyFileSync(MBOX_FIXTURE, path),
      "note.txt": (path) => writeFileSync(path, "An ordinary note that must survive the archive beside it.\n"),
    },
    dbPath: mboxDb,
  });

  check("a folder containing a .mbox ingests at all",
    archive.code === 0,
    `exit ${archive.code}; ${archive.out.slice(-500)}`);
  check("and it does not abort on an undeclared family",
    !/do not agree on one family/i.test(archive.out),
    archive.out.slice(-400));

  const stored = archive.evidence?.storedDocUids || [];
  check("the archive's messages became separate documents",
    stored.length > 2, JSON.stringify(stored));
  check("the ordinary file beside the archive was ingested too",
    stored.some((uid) => /note/.test(uid)),
    JSON.stringify(stored));
  check("the worker never rejected the archive's reconciliation",
    (archive.evidence?.forgetRejections || []).length === 0,
    JSON.stringify(archive.evidence?.forgetRejections));
  check("a first, complete archive load removes nothing",
    (archive.evidence?.forgetResults || []).every((r) => Number(r.documents) === 0),
    JSON.stringify(archive.evidence?.forgetResults));
}

/* ---- 7. the control: the SAME file, every part failed ---- */
const failed = runIngest({
  label: "whatsapp-failed",
  files: { [EXPORT_NAME]: (path) => copyFileSync(WHATSAPP_FIXTURE, path) },
  env: { BRAIN_FAMILY_REPRO_FAIL_ALL: "1" },
});
const failedFamilies = (failed.evidence?.forgetRequests || []).flat();
// A storage failure must PRESERVE the prior family and its retry, which is the
// rule remoteFamilySettlement states and the remote path already followed. An
// empty keep list is not a cleanup, it is "delete this whole family". That was
// harmless while a message-export base matched nothing, and became destructive
// the moment families were keyed correctly: one failed session could take every
// already-stored conversation from that file with it.
check("a FAILED ingest sends no delete-this-family instruction at all",
  failedFamilies.every((f) => !Array.isArray(f.keep_doc_uids) || f.keep_doc_uids.length > 0),
  JSON.stringify(failedFamilies));
check("and nothing is deleted as a result of the failure",
  (failed.evidence?.forgetResults || []).every((r) => Number(r.documents) === 0),
  JSON.stringify(failed.evidence?.forgetResults));
check("the failed ingest still exits non-zero for its own reason",
  failed.code === 1, failed.out.slice(-300));

/* ---- 8. the control: an oversized ordinary file that splits into #parts ---- */
const oversized = runIngest({
  label: "oversized",
  files: { "big-notes.txt": (path) => writeFileSync(path, longVariedProse(900_000)) },
});
check("an oversized ordinary document splits into more than one stored part",
  (oversized.evidence?.storedDocUids || []).length > 1,
  JSON.stringify(oversized.evidence?.storedDocUids));
check("the oversized-split ingest reconciles and exits 0",
  oversized.code === 0 && (oversized.evidence?.forgetRejections || []).length === 0,
  `exit ${oversized.code}; ${JSON.stringify(oversized.evidence?.forgetRejections)}`);

console.log(`\n${fail ? "FAILED" : "ok"}  ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
