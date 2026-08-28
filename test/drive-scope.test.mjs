/**
 * Drive scope: a root allowlist that is enforced where it can be, and honest
 * about the one lane where the platform will not let it be.
 *
 * Issue 8's substance: without an include-allowlist, "connect Drive" means the
 * whole Drive, and the exclusion rules run client-side AFTER listing, so the
 * name, path, size and id of every excluded file has already been fetched. The
 * test that matters here is the negative one — a file outside the allowlist is
 * never REQUESTED, not merely never ingested.
 */

import assert from "node:assert/strict";

import {
  DRIVE_ID,
  describeDriveScope,
  isUnderRoots,
  normalizeIncludeRootIds,
} from "../connectors/drive-scope.mjs";
import { exclusionReason, listFiles, listFilesUnderRoots } from "../connectors/google-drive.mjs";
import { driveConnectorConfig, drivePolicyFingerprint } from "../brain.mjs";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} (${String(error?.message || error).slice(0, 300)})`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} (${String(error?.message || error).slice(0, 300)})`);
  }
};

const token = async () => "access-token";
const FOLDER = "application/vnd.google-apps.folder";

/**
 * A Drive that would happily hand over everything if asked. Each fetch records
 * the `q` it was asked, so the test can assert on what was NEVER requested.
 */
function driveWith(tree) {
  const queries = [];
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get("q") || "";
    queries.push(q);
    const match = q.match(/^'([^']+)' in parents and trashed = false$/);
    const files = match ? (tree[match[1]] || []) : Object.values(tree).flat();
    return {
      ok: true,
      status: 200,
      json: async () => ({ files }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetchImpl, queries };
}

// One allowlisted root with a subfolder, and a sibling root that is off limits.
// The private file's NAME is the thing that must never be requested.
const TREE = {
  "root-allowed-1": [
    { id: "doc-a1", name: "quarterly summary.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parents: ["root-allowed-1"] },
    { id: "folder-sub", name: "Statements", mimeType: FOLDER, parents: ["root-allowed-1"] },
  ],
  "folder-sub": [
    { id: "doc-a2", name: "2026-01 statement.pdf", mimeType: "application/pdf", parents: ["folder-sub"] },
  ],
  "root-private-9": [
    { id: "doc-secret", name: "settlement terms.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parents: ["root-private-9"] },
  ],
};

/* ------------------------------------------------- the allowlist contract */

check("a root id that could break out of the query is refused, not escaped", () => {
  for (const bad of ["' or '1'='1", "root'", "a", "with space", "tab\there"]) {
    assert.throws(() => normalizeIncludeRootIds([bad]), /not a Drive folder id/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(DRIVE_ID.test("1HBPox5hUdS3Pl89G4Yf99_TPFmW-Mu1"), true);
});

check("entries are trimmed and de-duplicated, order preserved", () => {
  assert.deepEqual(normalizeIncludeRootIds([" root-one ", "root-two", "root-one"]), ["root-one", "root-two"]);
  assert.deepEqual(normalizeIncludeRootIds([]), []);
  assert.deepEqual(normalizeIncludeRootIds(null), []);
});

check("no allowlist is described as the whole Drive, out loud", () => {
  assert.match(describeDriveScope([]), /NO Drive root allowlist/);
  assert.match(describeDriveScope([]), /every file this Google account can see/);
  assert.match(describeDriveScope(["root-allowed-1"]), /nothing outside them is requested from Google/);
});

/* --------------------------------- the source-side guarantee, negatively */

await checkAsync("a file outside the allowlist is never REQUESTED from Google", async () => {
  const { fetchImpl, queries } = driveWith(TREE);
  const seen = [];
  for await (const file of listFilesUnderRoots(token, ["root-allowed-1"], { opts: { fetchImpl, sleep: async () => {} } })) {
    seen.push(file);
  }
  const ids = seen.map((f) => f.id).sort();
  assert.deepEqual(ids, ["doc-a1", "doc-a2", "folder-sub"]);

  // The whole point. Not "the private file was skipped" — the private folder
  // was never asked about, so its file's name never entered this process.
  assert.equal(queries.some((q) => q.includes("root-private-9")), false,
    `the excluded root was queried: ${JSON.stringify(queries)}`);
  assert.equal(JSON.stringify(seen).includes("settlement terms"), false,
    "an excluded file's name reached the installer");
  assert.deepEqual(queries, [
    "'root-allowed-1' in parents and trashed = false",
    "'folder-sub' in parents and trashed = false",
  ]);
});

await checkAsync("the whole-Drive walk, by contrast, fetches the excluded file's metadata", async () => {
  const { fetchImpl } = driveWith(TREE);
  const seen = [];
  for await (const file of listFiles(token, { opts: { fetchImpl, sleep: async () => {} } })) seen.push(file);
  const secret = seen.find((f) => f.id === "doc-secret");
  assert.ok(secret, "the unscoped walk should still return everything");
  // And the client-side rule can only refuse it AFTER this point, which is the
  // gap the issue reports and the reason the allowlist exists.
  assert.equal(
    exclusionReason(secret, "root-private-9", { excludePaths: ["root-private-9"] }) === null,
    false,
  );
});

await checkAsync("a folder with two parents does not walk forever", async () => {
  const cyclic = {
    "root-loop": [{ id: "folder-x", name: "X", mimeType: FOLDER, parents: ["root-loop"] }],
    "folder-x": [
      { id: "folder-x", name: "X", mimeType: FOLDER, parents: ["root-loop", "folder-x"] },
      { id: "doc-x", name: "x.txt", mimeType: "text/plain", parents: ["folder-x"] },
    ],
  };
  const { fetchImpl, queries } = driveWith(cyclic);
  const seen = [];
  for await (const file of listFilesUnderRoots(token, ["root-loop"], { opts: { fetchImpl, sleep: async () => {} } })) {
    seen.push(file.id);
  }
  assert.equal(queries.length, 2, JSON.stringify(queries));
  assert.ok(seen.includes("doc-x"));
});

await checkAsync("an incomplete search aborts rather than proving absence", async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ files: [], incompleteSearch: true }),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  let error = null;
  try {
    for await (const _ of listFilesUnderRoots(token, ["root-allowed-1"], { opts: { fetchImpl, sleep: async () => {} } })) { /* unreachable */ }
  } catch (caught) { error = caught; }
  assert.ok(error, "an incomplete page must not be treated as a complete one");
  assert.equal(error.reason, "incompleteSearch");
});

await checkAsync("an empty allowlist is refused rather than silently meaning everything", async () => {
  const { fetchImpl, queries } = driveWith(TREE);
  let error = null;
  try {
    for await (const _ of listFilesUnderRoots(token, [], { opts: { fetchImpl } })) { /* unreachable */ }
  } catch (caught) { error = caught; }
  assert.ok(error);
  assert.equal(error.reason, "emptyRootAllowlist");
  assert.deepEqual(queries, [], "nothing may be requested before the scope is settled");
});

/* -------------------------- the incremental lane, and its honest weakness */

const FOLDERS = {
  "root-allowed-1": { name: "Business", parents: [] },
  "folder-sub": { name: "Statements", parents: ["root-allowed-1"] },
  "root-private-9": { name: "Sealed", parents: [] },
};

check("a changed file under an allowlisted root is inside", () => {
  assert.equal(isUnderRoots({ id: "doc-a2", parents: ["folder-sub"] }, FOLDERS, ["root-allowed-1"]), true);
  assert.equal(isUnderRoots({ id: "doc-a1", parents: ["root-allowed-1"] }, FOLDERS, ["root-allowed-1"]), true);
  assert.equal(isUnderRoots({ id: "root-allowed-1", parents: [] }, FOLDERS, ["root-allowed-1"]), true);
});

check("a changed file outside the allowlist is refused on arrival", () => {
  assert.equal(isUnderRoots({ id: "doc-secret", parents: ["root-private-9"] }, FOLDERS, ["root-allowed-1"]), false);
});

check("unresolvable ancestry is OUTSIDE, never given the benefit of the doubt", () => {
  assert.equal(isUnderRoots({ id: "doc-unknown", parents: ["folder-never-seen"] }, FOLDERS, ["root-allowed-1"]), false);
  assert.equal(isUnderRoots({ id: "doc-orphan", parents: [] }, FOLDERS, ["root-allowed-1"]), false);
});

check("with no allowlist configured, everything is inside it", () => {
  assert.equal(isUnderRoots({ id: "doc-secret", parents: ["root-private-9"] }, FOLDERS, []), true);
});

/* ------------------------------------------------ the installer's wiring */

check("the manifest's include_root_ids reaches the connector policy", () => {
  const config = driveConnectorConfig({
    corpora: { google_drive: { include_root_ids: [" root-allowed-1 ", "root-allowed-1", "folder-sub"] } },
  }, "/tmp/probe/brain.manifest.json", () => "{}");
  assert.deepEqual(config.includeRootIds, ["root-allowed-1", "folder-sub"]);
});

check("a bad root id stops the run instead of quietly changing the scope", () => {
  assert.throws(() => driveConnectorConfig({
    corpora: { google_drive: { include_root_ids: ["' or '1'='1"] } },
  }, "/tmp/probe/brain.manifest.json", () => "{}"), /not a Drive folder id/);
});

check("changing the allowlist changes the policy identity, forcing one full sweep", () => {
  const narrow = drivePolicyFingerprint({ includeRootIds: ["root-allowed-1"] });
  const wide = drivePolicyFingerprint({ includeRootIds: ["root-allowed-1", "root-two-2"] });
  const none = drivePolicyFingerprint({ includeRootIds: [] });
  assert.notEqual(narrow, wide);
  assert.notEqual(narrow, none);
  assert.equal(drivePolicyFingerprint({ includeRootIds: ["root-allowed-1"] }), narrow);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall drive scope tests passed");
process.exit(failures ? 1 : 0);
