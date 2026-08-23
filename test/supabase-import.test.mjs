import {
  driveExactDuplicateSql, joinOverlappingChunks, laneConfig, resolveDrivePolicy,
  rowToEnvelope, runLane,
} from "../migration/supabase-import.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 220)));
  if (!condition) fail++;
};

/* Drive reconstruction removes the repeated header and exact 500-char overlap. */
{
  const overlap = "x".repeat(500);
  const first = `[Folder/file.md]\n\nalpha ${overlap}`;
  const second = `[Folder/file.md]\n\n${overlap} omega`;
  const joined = joinOverlappingChunks([
    { id: 2, chunk_index: 1, text: second },
    { id: 1, chunk_index: 0, text: first },
  ]);
  check("Drive chunks are sorted by chunk index", joined.startsWith("alpha"), joined.slice(0, 40));
  check("a repeated path header appears zero times", !joined.includes("[Folder/file.md]"), joined.slice(0, 80));
  check("the exact overlap is stored once", joined.length === "alpha ".length + overlap.length + " omega".length, String(joined.length));
  check("both sides of the document survive", joined.endsWith("omega"));
}

/* Lane SQL is bounded, keyset-paged and excludes flagged Drive files whole. */
{
  const drive = laneConfig("drive").pageSql("a", "z", 10);
  check("Drive uses keyset pagination", /drive_file_id > 'a'/.test(drive), drive);
  check("Drive is bounded by a fixed high-water mark", /drive_file_id <= 'z'/.test(drive), drive);
  check("Drive excludes an entire file if any chunk is flagged", /HAVING NOT bool_or\(flagged\)/.test(drive), drive);
  check("Drive groups chunks into documents before target ingest", /GROUP BY drive_file_id/.test(drive), drive);
  const excluded = laneConfig("drive", { excludedDriveFileIds: ["drive_file_123"] }).pageSql("a", "z", 10);
  check("Drive applies exact per-install exclusions", /drive_file_id NOT IN \('drive_file_123'\)/.test(excluded), excluded);
  const messages = laneConfig("messages").pageSql("a", "z", 100);
  check("messages also use a high-water mark", /id::text <= 'z'/.test(messages), messages);
}

/* Exact-copy policy resolution is generic, deterministic and resumable. */
{
  const policy = {
    config_hash: "policy-one",
    dedupe_exact_content: true,
    explicit_exclusions: [{ id: "explicit_file_123", reason: "reviewed extraction failure" }],
  };
  let duplicateSql = "";
  const resolved = await resolveDrivePolicy({
    policy,
    queryFn: async (sql) => {
      duplicateSql = sql;
      return [{ drive_file_id: "duplicate_file_456", canonical_drive_file_id: "canonical_file_789" }];
    },
  });
  check("Drive policy combines reviewed exclusions and exact duplicates",
    resolved.summary.explicit === 1 && resolved.summary.exact_duplicates === 1 &&
      resolved.excluded_drive_file_ids.join(",") === "duplicate_file_456,explicit_file_123", JSON.stringify(resolved));
  check("duplicate discovery ignores an explicitly excluded file", duplicateSql.includes("'explicit_file_123'"), duplicateSql);
  check("duplicate discovery strips the repeated path header", /split_part\(chunk_text/.test(driveExactDuplicateSql()), driveExactDuplicateSql().slice(0, 500));
  check("a saved policy is reused without querying the changing source",
    await resolveDrivePolicy({ policy, existing: resolved, queryFn: async () => { throw new Error("should not query"); } }) === resolved);
  let changedPolicyRefused = false;
  try {
    await resolveDrivePolicy({ policy: { ...policy, config_hash: "policy-two" }, existing: resolved, queryFn: async () => [] });
  } catch (error) { changedPolicyRefused = /changed after the lane started/.test(error.message); }
  check("a changed policy cannot silently alter an in-progress lane", changedPolicyRefused);
}

/* Every source becomes the standard product document envelope. */
{
  const drive = rowToEnvelope("drive", {
    cursor_id: "f1", drive_file_id: "f1", drive_file_path: "Provider Records/Health.html",
    top_folder: "Provider Records", category: "medical", client_id: "James",
    document_date: "2025-02-03T00:00:00Z", document_date_reliable: true,
    chunks: [{ chunk_index: 0, text: "readable medical record" }], source_chunks: 1,
  });
  check("Drive preserves the stable file id", drive.source_type === "drive" && drive.source_id === "f1", JSON.stringify(drive));
  check("Drive filter metadata reaches the product envelope",
    drive.metadata.top_folder === "Provider Records" && drive.metadata.category === "medical" &&
      drive.metadata.client === "James" && drive.metadata.platform === "drive", JSON.stringify(drive.metadata));

  const message = rowToEnvelope("messages", {
    cursor_id: "r1", source_id: "m1", thread_id: "t1", platform: "imessage",
    category: "personal", client_id: "Easton", ts: "2025-03-04T10:00:00Z", content: "hello",
  });
  check("message identity, date and platform are preserved",
    message.source_type === "message" && message.source_id === "m1" &&
      message.occurred_at === "2025-03-04T10:00:00.000Z" && message.metadata.platform === "imessage", JSON.stringify(message));
}

/* A successful run checkpoints after receipts and is idempotent on replay. */
{
  const state = { version: 1, project_ref: "p", target_url: "t", lanes: {} };
  const page = [{ cursor_id: "1", d1_key: "k1", title: "One", category: "note", content: "enough content to ingest" }];
  let pageCalls = 0, posts = 0, saves = 0;
  const queryFn = async (sql) => /max\(id\)/.test(sql) ? [{ high_water: "1" }] : pageCalls++ === 0 ? page : [];
  const postFn = async (items) => {
    posts++;
    return { results: items.map(() => ({ status: "created", chunks: 2 })) };
  };
  const first = await runLane({ lane: "curated", state, queryFn, postFn, saveFn: () => { saves++; } });
  check("a successful lane completes", first.status === "complete", JSON.stringify(first));
  check("the accepted document and chunk receipt are recorded", first.created === 1 && first.target_chunks === 2, JSON.stringify(first));
  check("state was saved after durable progress", saves >= 3, String(saves));
  const second = await runLane({ lane: "curated", state, queryFn, postFn, saveFn: () => { saves++; } });
  check("rerunning a complete lane posts nothing twice", second.status === "complete" && posts === 1, `posts=${posts}`);
}

/* A target failure records the document and refuses to advance the cursor. */
{
  const state = { version: 1, lanes: {} };
  const queryFn = async (sql) => /max\(id\)/.test(sql)
    ? [{ high_water: "2" }]
    : [{ cursor_id: "2", d1_key: "bad", title: "Bad", category: "note", content: "content" }];
  const result = await runLane({
    lane: "curated", state, queryFn,
    postFn: async () => ({ results: [{ status: "failed", error: "target write failed" }] }),
    saveFn: () => {}, maxPages: 1,
  });
  check("a failed page blocks rather than skipping data", result.status === "blocked", JSON.stringify(result));
  check("the cursor did not advance", result.cursor === "", JSON.stringify(result));
  check("the failure is explicit and attributable", result.failures[0]?.source_id === "bad" && /target write failed/.test(result.failures[0]?.error), JSON.stringify(result.failures));
}

console.log(`\nsupabase importer: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
