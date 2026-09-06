// The migrations already applied on installed brains are frozen bytes.
//
// A client's brain records a checksum per applied migration. cmdMigrate
// compares each shipped file against that record and refuses the whole
// update if any of them disagree - correctly, since an applied migration is
// history. The consequence is that editing a shipped migration does not
// change a client's schema; it strands every client who already ran it, with
// no way forward but a hand repair on their database.
//
// Nothing enforced that. Three releases went out in twelve hours on
// 2026-09-02 preserving these bytes by luck. This pins them, so a change to
// an already-applied migration fails the build here rather than at a client.
//
// Adding a NEW migration is always fine: append its version and checksum.
// Changing one below means asking whether every installed brain can migrate
// forward, and the answer is almost always no - write a new migration instead.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

// Exactly the computation in loadMigrations(): sha256 of the file read as
// utf-8, first 16 hex characters. Recomputed here rather than imported, so a
// change to the hashing itself also trips this test - that change would
// invalidate every recorded checksum in the field.
const checksumOf = (sql) => createHash("sha256").update(sql).digest("hex").slice(0, 16);

// Version, name and checksum of every migration published to a client brain.
// Verified 2026-09-02 against the bytes inside the shipped v0.2.0 and v0.2.3
// tarballs, not merely against this checkout.
const PUBLISHED = [
  [1, "0001_install_state", "d6e1236935412fe1"],
  [2, "0002_llm_call_log", "3714cbb59316de52"],
  [3, "0003_sources", "142c43dcc7124554"],
  [4, "0004_corpus", "38aca888d983ac22"],
  [5, "0005_vector_id", "dd73a816377c1a81"],
  [6, "0006_freshness", "76730d73021a7dd3"],
  [7, "0007_filter_metadata", "323563095685909c"],
  [8, "0008_vector_delete_outbox", "76b051f683fbdba9"],
  [9, "0009_document_content_hash_index", "8e83ea16b71af73e"],
  [10, "0010_vector_outbox_generation", "699b0590840b6f31"],
  [11, "0011_vector_drain_lease", "a1b4af184e514511"],
  [12, "0012_vector_visibility_receipts", "2469e9cbb67566f4"],
  [13, "0013_accelerated_vector_bootstrap", "be67ec689175ff5d"],
  [14, "0014_owner_passkeys", "daf56b963a43bf5b"],
  [15, "0015_grants", "0da6552a3dc6c98d"],
  [16, "0016_zones", "a11d86d8b381dc86"],
  [17, "0017_financial_ledger", "4d2b54042a2f6dba"],
  [18, "0018_bank_feed", "28af4e821ab62797"],
  [19, "0019_mcp_connector_oauth", "231bd9d5aa0ed9cd"],
  [20, "0020_extraction_provenance", "0e5a337a58de45fe"],
  [21, "0021_owner_workspace", "71fac1542e497122"],
  [22, "0022_document_access_passkey_observability", "ba12fffa95c7e22e"],
];

const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const onDisk = files.map((f) => ({
  version: parseInt(f.split("_")[0], 10),
  name: f.replace(/\.sql$/, ""),
  checksum: checksumOf(readFileSync(join(dir, f), "utf-8")),
}));

for (const [version, name, checksum] of PUBLISHED) {
  const actual = onDisk.find((m) => m.version === version);
  check(
    `${name} is byte-identical to what installed brains applied`,
    actual && actual.name === name && actual.checksum === checksum,
    actual
      ? `now ${actual.name} ${actual.checksum}, clients recorded ${name} ${checksum}. ` +
        "An applied migration is history: add a new migration instead of editing this one."
      : `migration ${version} is missing; installed brains have it applied.`,
  );
}

check(
  "no published migration was removed or renumbered",
  onDisk.length >= PUBLISHED.length &&
    PUBLISHED.every(([version]) => onDisk.some((m) => m.version === version)),
  `on disk ${onDisk.length}, published ${PUBLISHED.length}`,
);

// Contiguity from 1 is a separate contract the recovery adapter enforces, and
// a gap refuses recovery on every install. Cheap to assert here too, where the
// message can say why.
const versions = onDisk.map((m) => m.version);
check(
  "migration versions are contiguous from 1",
  versions.every((version, index) => version === index + 1),
  `saw ${versions.join(",")} - a gap refuses RECOVERY_MIGRATION_CONTRACT_INVALID on every install`,
);

console.log(`\nmigration checksum pin: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
