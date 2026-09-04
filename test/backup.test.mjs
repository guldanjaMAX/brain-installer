// `brain backup`: the safe half of the recovery machinery, given a door.
//
// Every case here is a property a client depends on and cannot check
// themselves: that the export gets past the FTS5 refusal, that no sign-in
// material is in the file, that a too-small file is never called a backup, and
// that nothing runs without them saying yes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupArgs, EXCLUDED_BY_DESIGN, renderBackupPlan, renderBackupReceipt, sidecarFor, verifyBackup } from "../operations/backup.mjs";
import { RECOVERY_EXPORT_TABLES } from "../operations/cloudflare-recovery-adapter.mjs";

let pass = 0;
const ok = (n) => { pass++; console.log(`PASS  ${n}`); };

// --- the flag that gets past the refusal ---
const args = backupArgs({ databaseName: "acme-brain", out: "/tmp/x.sql", tables: ["documents", "chunks"] });
assert.ok(args.includes("--no-schema"), "without this, wrangler refuses this schema over the fts5 table");
assert.ok(args.includes("--remote"));
assert.deepEqual(args.filter((a) => a === "--table").length, 2);
ok("the export is data-only, which is what gets past the virtual-table refusal");

assert.throws(() => backupArgs({ out: "/tmp/x.sql" }), /database name/);
assert.throws(() => backupArgs({ databaseName: "d" }), /output path/);
ok("it refuses to build a half-specified export");

// --- no credentials can be in the artifact ---
const secrets = ["auth_challenges", "enrollment_codes", "oauth_tokens", "oauth_codes", "oauth_clients", "bank_feed_link_sessions"];
for (const s of secrets) {
  assert.ok(!RECOVERY_EXPORT_TABLES.includes(s), `${s} must never enter a backup file`);
}
assert.ok(RECOVERY_EXPORT_TABLES.includes("documents"), "but the documents must");
ok("no live sign-in material is exportable, and the documents are");

// --- the owner is told, before anything runs ---
const plan = renderBackupPlan({ databaseName: "acme-brain", out: "/tmp/b.sql", tables: RECOVERY_EXPORT_TABLES, schemaVersion: 22 });
assert.match(plan, /UNAVAILABLE/);
assert.match(plan, /do not run it during a call/);
for (const e of EXCLUDED_BY_DESIGN) assert.ok(plan.includes(e.what), `the plan must say ${e.what} is absent`);
ok("the plan warns the brain goes briefly dark, and says what is deliberately absent");

// --- a small file is not a backup ---
assert.equal(verifyBackup({ bytes: 0, tables: ["documents"] }).ok, false);
assert.equal(verifyBackup({ bytes: 12, tables: ["documents"] }).ok, false);
assert.match(verifyBackup({ bytes: 12, tables: ["documents"] }).reason, /too small/);
assert.equal(verifyBackup({ bytes: 900_000, tables: ["documents"] }).ok, true);
ok("an empty or tiny export is refused rather than reported as a backup");

// --- the sidecar makes it restorable by someone who was not there ---
const side = sidecarFor({ databaseName: "acme-brain", schemaVersion: 22, migrations: ["0001_x", "0022_y"], tables: ["documents"], bytes: 900_000, productVersion: "0.3.5", when: "2026-09-04T15:00:00.000Z" });
assert.equal(side.contains_schema, false);
assert.equal(side.highest_migration, "0022_y");
assert.match(side.restore_note, /create the schema first/);
assert.match(side.restore_note, /rebuild the search and vector indexes/);
ok("the sidecar records what a restore must do first, because the file has no schema in it");

const receipt = renderBackupReceipt({ out: "/tmp/b.sql", sidecar: side, verified: verifyBackup({ bytes: 900_000, tables: ["documents"] }) });
assert.match(receipt, /keep it somewhere you would keep a tax return/i);
assert.match(receipt, /NOT: a one-click restore/);
ok("the receipt says plainly what this is not, rather than implying a restore button exists");

// --- the command: nothing happens without a yes, and nothing can touch the brain ---
const { cmdBackup } = await import("../brain.mjs");
const dir = mkdtempSync(join(tmpdir(), "brain-backup-"));
const manifestPath = join(dir, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture" },
  brain: { version: "0.3.5", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: "a".repeat(32), d1_database_name: "fixture-brain", d1_database_id: "b".repeat(36) } },
}, null, 2));

const base = {
  account: { id: "a".repeat(32) },
  d1Query: async () => ({ results: [{ schema_version: 22, product_version: "0.3.5" }] }),
  statBytes: () => 900_000,
  writeFile: () => {},
  now: () => new Date("2026-09-04T15:00:00.000Z"),
};

let ran = false;
const declined = await cmdBackup(manifestPath, { ...base, flags: {}, ask: async () => "n", wrangler: async () => { ran = true; } });
assert.equal(declined.taken, false);
assert.equal(ran, false, "declining must not run the export");
ok("answering no runs nothing at all");

let argv = null;
const taken = await cmdBackup(manifestPath, { ...base, flags: { yes: true, out: join(dir, "b.sql") }, wrangler: async (_b, a) => { argv = a; } });
assert.equal(taken.taken, true);
assert.ok(argv.includes("--no-schema"));
assert.equal(taken.schemaVersion, 22);
ok("--yes takes the backup, data-only, and records the schema it came from");

// A brain whose schema cannot be read still backs up, and says so rather than inventing one.
const blind = await cmdBackup(manifestPath, {
  ...base, flags: { yes: true, out: join(dir, "c.sql") },
  d1Query: async () => { throw new Error("unreachable"); },
  wrangler: async () => {},
});
assert.equal(blind.taken, true);
assert.equal(blind.schemaVersion, null, "unknown is recorded as unknown");
ok("an unreadable schema version does not block the backup, and is never guessed");

console.log(`\n${pass} passed`);
