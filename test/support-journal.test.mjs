import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORT_COMMANDS,
  SUPPORT_MAX_AGE_DAYS,
  SUPPORT_MAX_BYTES,
  SUPPORT_MAX_EVENTS,
  clearSupportJournal,
  exportSupportJournal,
  previewSupportEvent,
  previewSupportJournal,
  productRelativeFingerprint,
  recordSupportEvent,
  supportJournalPaths,
} from "../support-journal.mjs";

const SELF = fileURLToPath(import.meta.url);

// A real OS process, not a Promise in one event loop. The parent launches
// sixteen of these at once to catch read-modify-write event loss.
if (process.argv[2] === "--concurrent-writer") {
  try {
    recordSupportEvent(
      { command: "test", source: "local", errorCode: "INTERNAL_ERROR" },
      { root: process.argv[3] },
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error?.code || "SUPPORT_WRITER_FAILED"}\n`);
    process.exit(1);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "brain-support-journal-"));
const fixedNow = new Date("2026-08-24T18:00:00.000Z");
const maliciousUuid = "123e4567-e89b-12d3-a456-426614174000";
const malicious = [
  "api token sk_live_THIS_MUST_NEVER_APPEAR",
  "person@example.test",
  "/Users/private-person/Company/secret.txt",
  "C:\\Users\\private-person\\Company\\secret.txt",
  "private-customer.example.com/path?q=secret",
  maliciousUuid,
  "line one\nline two\r\nline three",
  "x".repeat(4 * 1024 * 1024),
].join(" | ");

const options = (root, index = 1, now = fixedNow) => ({
  root,
  now,
  productVersion: "0.1.9",
  platform: "linux",
  arch: "x64",
  nodeVersion: "22.14.0",
  randomBytes: () => Buffer.alloc(16, index % 256),
});

function freshRoot(label) {
  const root = join(sandbox, label);
  mkdirSync(root, { mode: 0o700 });
  return root;
}

function eventPath(paths, event) {
  return join(paths.eventsDir, `${event.event_id}.json`);
}

function writePrivate(path, content) {
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch {}
}

function safeChildEnvironment() {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function concurrentWriter(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, "--concurrent-writer", root], {
      env: safeChildEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic += chunk.toString().slice(0, 200); });
    child.on("error", (error) => resolve({ code: null, diagnostic: error.code || "spawn failed" }));
    child.on("close", (code) => resolve({ code, diagnostic: diagnostic.trim() }));
  });
}

try {
  const moduleSource = readFileSync(new URL("../support-journal.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(moduleSource, /from\s+["']node:(?:http|https|http2|net|tls|dns)["']/);
  assert.doesNotMatch(moduleSource, /\bfetch\s*\(/, "support journal has no network call path");
  assert.doesNotMatch(moduleSource, /process\.(?:argv|env)/, "support journal never reads arguments or environment");
  assert.doesNotMatch(moduleSource.slice(0, 500), /telemetry/i);

  const publicCommands = [
    "setup", "doctor", "whatsnew", "verify", "provision", "deploy", "secrets",
    "health", "test", "mcp-config", "migrate", "ingest", "connect", "status",
    "sources", "forget", "drain", "reindex", "diagnose", "eval", "upgrade",
    "rollback", "schedule", "support",
  ];
  for (const command of publicCommands) {
    assert.ok(SUPPORT_COMMANDS.includes(command), `support command catalog is missing ${command}`);
    assert.equal(
      previewSupportEvent({ command, source: "local", errorCode: "INTERNAL_ERROR" }, options(sandbox)).command,
      command,
    );
  }
  assert.equal(
    previewSupportEvent(
      { command: "eval", source: "installer", errorCode: "COMMAND_FAILED" },
      options(sandbox),
    ).error_code,
    "COMMAND_FAILED",
    "the CLI fallback failure classification is journalable",
  );
  const fallbackRoot = freshRoot("command-failed");
  recordSupportEvent(
    { command: "eval", source: "installer", errorCode: "COMMAND_FAILED" },
    options(fallbackRoot),
  );
  const fallbackPreview = previewSupportJournal(options(fallbackRoot));
  assert.equal(JSON.parse(fallbackPreview).error_code, "COMMAND_FAILED");
  const fallbackExport = join(sandbox, "command-failed-export.jsonl");
  exportSupportJournal(fallbackExport, options(fallbackRoot));
  assert.equal(readFileSync(fallbackExport, "utf8"), fallbackPreview);

  const root = freshRoot("privacy");
  const eventInput = {
    command: "ingest",
    source: "drive",
    errorCode: "EXTRACTION_FAILED",
    productRelativeLocation: "ingest/run.mjs#extract-document",
    message: malicious,
    stack: malicious,
    argv: [malicious],
    env: { SECRET: malicious },
    path: malicious,
    url: malicious,
    remoteId: maliciousUuid,
    content: malicious,
    unknown: malicious,
  };
  const previewed = previewSupportEvent(eventInput, options(root));
  assert.deepEqual(Object.keys(previewed), [
    "schema_version", "event_id", "timestamp", "product_version", "platform",
    "arch", "node_major", "command", "source", "error_code", "fingerprint",
  ]);
  assert.deepEqual(previewed, {
    schema_version: 1,
    event_id: `evt_${"01".repeat(16)}`,
    timestamp: fixedNow.toISOString(),
    product_version: "0.1.9",
    platform: "linux",
    arch: "x64",
    node_major: 22,
    command: "ingest",
    source: "drive",
    error_code: "EXTRACTION_FAILED",
    fingerprint: productRelativeFingerprint("ingest/run.mjs#extract-document"),
  });

  const recorded = recordSupportEvent(eventInput, options(root));
  assert.deepEqual(recorded, previewed);
  const paths = supportJournalPaths({ root });
  assert.equal(Object.hasOwn(paths, "eventsPath"), false, "path API no longer describes a shared JSONL file");
  assert.equal(Object.hasOwn(paths, "home"), false, "path API does not expose a generic home field");
  assert.equal(paths.userRoot, root);
  assert.equal(paths.eventsDir, join(root, ".brain", "support", "events"));
  assert.deepEqual(readdirSync(paths.eventsDir), [`${recorded.event_id}.json`]);
  const storedPath = eventPath(paths, recorded);
  const onDisk = readFileSync(storedPath, "utf8");
  for (const forbidden of [
    "THIS_MUST_NEVER_APPEAR", "person@example.test", "/Users/private-person",
    "C:\\Users\\private-person", "private-customer.example.com", maliciousUuid,
    "line one", "line two", "line three",
  ]) assert.equal(onDisk.includes(forbidden), false, `journal leaked ${forbidden}`);
  assert.ok(onDisk.length < 1024, "a huge ignored error cannot make a huge journal event");
  assert.deepEqual(Object.keys(JSON.parse(onDisk)), Object.keys(previewed), "stored events have zero unknown fields");
  if (process.platform !== "win32") {
    for (const directory of [paths.brainRoot, paths.supportRoot, paths.eventsDir]) {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(directory).uid, process.getuid());
    }
    assert.equal(statSync(storedPath).mode & 0o777, 0o600);
    assert.equal(statSync(storedPath).uid, process.getuid());
    assert.throws(
      () => previewSupportJournal({ ...options(root), getUid: () => process.getuid() + 1 }),
      /owned by the current process user/,
    );
    assert.throws(
      () => recordSupportEvent(
        { command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" },
        { ...options(root, 2), getUid: () => process.getuid() + 1 },
      ),
      /owned by the current process user/,
    );
  }

  // O_EXCL makes an event-id collision an explicit refusal, never an overwrite.
  assert.throws(() => recordSupportEvent(eventInput, options(root)), /refusing to overwrite/);
  assert.equal(readFileSync(storedPath, "utf8"), onDisk);

  const exported = join(sandbox, "support-export.jsonl");
  const canonicalPreview = previewSupportJournal(options(root));
  const exportResult = exportSupportJournal(exported, options(root));
  assert.equal(readFileSync(exported, "utf8"), canonicalPreview, "preview bytes exactly equal export bytes");
  assert.equal(exportResult.bytes, Buffer.byteLength(canonicalPreview));
  if (process.platform !== "win32") assert.equal(statSync(exported).mode & 0o777, 0o600);
  for (const forbidden of ["person@example.test", "private-customer.example.com", maliciousUuid]) {
    assert.equal(readFileSync(exported, "utf8").includes(forbidden), false, `export leaked ${forbidden}`);
  }
  assert.throws(() => exportSupportJournal(exported, options(root)), /refusing to overwrite/);
  assert.equal(readFileSync(exported, "utf8"), canonicalPreview, "refused overwrite leaves the export unchanged");

  assert.throws(() => previewSupportEvent({ ...eventInput, command: malicious }, options(root)), /command/);
  assert.throws(() => previewSupportEvent({ ...eventInput, source: malicious }, options(root)), /source/);
  assert.throws(() => previewSupportEvent({ ...eventInput, errorCode: malicious }, options(root)), /errorCode/);
  for (const unsafeLocation of [malicious, "../ingest/run.mjs", "/ingest/run.mjs", "https://private.example/run.mjs", "C:\\run.mjs"])
    assert.throws(() => productRelativeFingerprint(unsafeLocation), /product-relative/);

  // Corrupt, unknown-field, and torn immutable events are ignored. They cannot
  // contaminate preview/export, and a new writer does not rewrite them.
  const partialRoot = freshRoot("partial");
  const first = recordSupportEvent(
    { command: "doctor", source: "local", errorCode: "CONFIG_INVALID" },
    options(partialRoot, 2),
  );
  const partialPaths = supportJournalPaths({ root: partialRoot });
  const firstContent = readFileSync(eventPath(partialPaths, first), "utf8");
  writePrivate(
    join(partialPaths.eventsDir, `evt_${"03".repeat(16)}.json`),
    JSON.stringify({ ...JSON.parse(firstContent), event_id: `evt_${"03".repeat(16)}`, message: "unknown-field" }) + "\n",
  );
  writePrivate(
    join(partialPaths.eventsDir, `evt_${"04".repeat(16)}.json`),
    `{"message":"${maliciousUuid}","unfinished":`,
  );
  assert.equal(previewSupportJournal(options(partialRoot, 4)).split("\n").filter(Boolean).length, 1);
  recordSupportEvent(
    { command: "health", source: "cloudflare", errorCode: "HEALTH_CHECK_FAILED" },
    options(partialRoot, 5),
  );
  const repairedView = previewSupportJournal(options(partialRoot, 6));
  assert.equal(repairedView.split("\n").filter(Boolean).length, 2);
  assert.equal(repairedView.includes(maliciousUuid), false);

  // Preview/export are strictly bounded. Immutable physical retention is lazy,
  // so recording never risks deleting an event another writer just created.
  const pruneRoot = freshRoot("prune");
  recordSupportEvent(
    { command: "ingest", source: "drive", errorCode: "INGEST_FAILED" },
    options(pruneRoot, 250, new Date(fixedNow.getTime() - (SUPPORT_MAX_AGE_DAYS + 1) * 86_400_000)),
  );
  for (let index = 1; index <= SUPPORT_MAX_EVENTS + 17; index++) {
    recordSupportEvent(
      { command: "ingest", source: "drive", errorCode: "INGEST_FAILED" },
      options(pruneRoot, index, new Date(fixedNow.getTime() - (SUPPORT_MAX_EVENTS + 17 - index) * 1000)),
    );
  }
  const prunePaths = supportJournalPaths({ root: pruneRoot });
  assert.equal(readdirSync(prunePaths.eventsDir).length, SUPPORT_MAX_EVENTS + 18);
  const prunedText = previewSupportJournal(options(pruneRoot, 1));
  const pruned = prunedText.split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(pruned.length, SUPPORT_MAX_EVENTS);
  assert.ok(Buffer.byteLength(prunedText) <= SUPPORT_MAX_BYTES);
  assert.ok(pruned.every((event) => Date.parse(event.timestamp) >= fixedNow.getTime() - SUPPORT_MAX_AGE_DAYS * 86_400_000));
  assert.equal(pruned.some((event) => event.event_id === `evt_${"fa".repeat(16)}`), false, "expired event is not exported");

  // This is the regression for the reproduced blocker: sixteen processes start
  // together, every successful return must correspond to one durable event.
  const concurrencyRoot = freshRoot("concurrency");
  const writerResults = await Promise.all(Array.from({ length: 16 }, () => concurrentWriter(concurrencyRoot)));
  assert.deepEqual(writerResults.map((result) => result.code), Array(16).fill(0), JSON.stringify(writerResults));
  const concurrentPaths = supportJournalPaths({ root: concurrencyRoot });
  const concurrentFiles = readdirSync(concurrentPaths.eventsDir);
  assert.equal(concurrentFiles.length, 16, "all sixteen immutable event files survive");
  assert.ok(concurrentFiles.every((name) => /^evt_[0-9a-f]{32}\.json$/.test(name)));
  const concurrentLines = previewSupportJournal({ root: concurrencyRoot, now: new Date() }).split("\n").filter(Boolean);
  assert.equal(concurrentLines.length, 16, "all sixteen events survive canonical preview");
  assert.equal(new Set(concurrentLines.map((line) => JSON.parse(line).event_id)).size, 16);

  // The journal refuses links and special aliases rather than following them.
  const outside = join(sandbox, "outside");
  mkdirSync(outside);
  if (process.platform !== "win32") {
    const symlinkRoot = freshRoot("symlink");
    mkdirSync(join(symlinkRoot, ".brain"));
    symlinkSync(outside, join(symlinkRoot, ".brain", "support"), "dir");
    assert.throws(
      () => recordSupportEvent({ command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" }, options(symlinkRoot, 1)),
      /real directory/,
    );
    assert.throws(() => previewSupportJournal(options(symlinkRoot, 1)), /real directory/);
    assert.equal(readdirSync(outside).length, 0);

    const danglingRoot = freshRoot("dangling");
    mkdirSync(join(danglingRoot, ".brain"));
    symlinkSync(join(sandbox, "missing-target"), join(danglingRoot, ".brain", "support"), "dir");
    assert.throws(
      () => recordSupportEvent({ command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" }, options(danglingRoot, 1)),
      /real directory/,
    );

    const hardlinkRoot = freshRoot("hardlink");
    const hardlinkEvent = recordSupportEvent(
      { command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" },
      options(hardlinkRoot, 1),
    );
    const hardlinkPath = eventPath(supportJournalPaths({ root: hardlinkRoot }), hardlinkEvent);
    const secondLink = join(sandbox, "journal-hardlink");
    linkSync(hardlinkPath, secondLink);
    assert.equal(lstatSync(hardlinkPath).nlink, 2);
    assert.throws(() => previewSupportJournal(options(hardlinkRoot, 1)), /hard links/);
    recordSupportEvent(
      { command: "health", source: "local", errorCode: "HEALTH_CHECK_FAILED" },
      options(hardlinkRoot, 2),
    );
    assert.throws(() => clearSupportJournal({ root: hardlinkRoot }), /hard links/);
    unlinkSync(secondLink);

    const eventLinkRoot = freshRoot("event-symlink");
    const safeEvent = recordSupportEvent(
      { command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" },
      options(eventLinkRoot, 1),
    );
    const eventLinkPaths = supportJournalPaths({ root: eventLinkRoot });
    symlinkSync(
      eventPath(eventLinkPaths, safeEvent),
      join(eventLinkPaths.eventsDir, `evt_${"02".repeat(16)}.json`),
    );
    assert.throws(() => previewSupportJournal(options(eventLinkRoot, 1)), /regular file/);
  }

  const nonregularRoot = freshRoot("nonregular-store");
  const nonregularEvent = recordSupportEvent(
    { command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" },
    options(nonregularRoot, 1),
  );
  const nonregularPaths = supportJournalPaths({ root: nonregularRoot });
  rmSync(nonregularPaths.eventsDir, { recursive: true });
  writeFileSync(nonregularPaths.eventsDir, "not a directory", { mode: 0o600 });
  assert.throws(() => previewSupportJournal(options(nonregularRoot, 1)), /real directory/);
  assert.throws(
    () => recordSupportEvent({ command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" }, options(nonregularRoot, 2)),
    /real directory/,
  );
  assert.ok(nonregularEvent.event_id);

  const nonregularEntryRoot = freshRoot("nonregular-entry");
  recordSupportEvent(
    { command: "doctor", source: "local", errorCode: "INTERNAL_ERROR" },
    options(nonregularEntryRoot, 1),
  );
  const nonregularEntryPaths = supportJournalPaths({ root: nonregularEntryRoot });
  mkdirSync(join(nonregularEntryPaths.eventsDir, `evt_${"02".repeat(16)}.json`));
  assert.throws(() => previewSupportJournal(options(nonregularEntryRoot, 1)), /regular file/);

  if (process.platform !== "win32") {
    const exportTarget = join(sandbox, "export-target");
    writeFileSync(exportTarget, "do not overwrite");
    const exportLink = join(sandbox, "export-link.jsonl");
    symlinkSync(exportTarget, exportLink);
    assert.throws(() => exportSupportJournal(exportLink, options(root)), /regular file/);
    assert.equal(readFileSync(exportTarget, "utf8"), "do not overwrite");
  }

  writeFileSync(join(paths.brainRoot, "unrelated.txt"), "preserve me");
  assert.equal(clearSupportJournal({ root }), true);
  assert.equal(existsSync(paths.supportRoot), false);
  assert.equal(existsSync(paths.brainRoot), true, "clear preserves the parent .brain directory");
  assert.equal(readFileSync(join(paths.brainRoot, "unrelated.txt"), "utf8"), "preserve me");
  assert.equal(clearSupportJournal({ root }), false);

  if (process.platform !== "win32") {
    const clearSymlinkRoot = freshRoot("clear-symlink");
    mkdirSync(join(clearSymlinkRoot, ".brain"), { mode: 0o700 });
    chmodSync(join(clearSymlinkRoot, ".brain"), 0o700);
    symlinkSync(outside, join(clearSymlinkRoot, ".brain", "support"), "dir");
    assert.throws(() => clearSupportJournal({ root: clearSymlinkRoot }), /real directory/);
    assert.equal(existsSync(outside), true);
  }

  console.log("support journal: all focused tests passed");
} finally {
  try { chmodSync(sandbox, 0o700); } catch {}
  rmSync(sandbox, { recursive: true, force: true });
}
