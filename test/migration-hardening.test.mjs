import assert from "node:assert/strict";
import {
  chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTargetInventory, postSourceReceipt, postTargetBatch, querySupabase,
  readBoundedResponseText,
} from "../migration/supabase-import.mjs";
import {
  MESSAGE_STATE_SCHEMA, MESSAGE_STATE_VERSION, loadMessageState,
  messageCompletionReceipt, runMessageMigration,
  verifyMessageTargetInventory,
} from "../migration/supabase-message-sessions.mjs";
import {
  protectedStatePreviousPath, readProtectedStateJson, saveProtectedStateJson,
} from "../migration/state-file.mjs";

let ran = 0;
let failed = 0;
const check = async (name, fn) => {
  ran++;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}  ${String(error?.message || error).slice(0, 240)}`);
  }
};

const response = (body, {
  status = 200,
  url = "",
  redirected = false,
  headers = {},
} = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  redirected,
  headers: new Headers(headers),
  body: null,
  text: async () => body,
});

const item = (sourceId = "synthetic-one") => ({
  envelope: {
    source_type: "message",
    source_id: sourceId,
    title: "Synthetic",
    content: "Synthetic migration fixture content.",
  },
});

await check("source, target, and completion calls refuse automatic redirects", async () => {
  const seen = [];
  const projectRef = "abcdefghijklmnopqrst";
  await querySupabase({
    projectRef,
    accessToken: "fixture",
    sql: "select 1",
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect });
      return response("[]", { url });
    },
  });
  await postTargetBatch({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    items: [item()],
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect });
      return response(JSON.stringify({
        results: [{ source_type: "message", source_id: "synthetic-one", status: "created", chunks: 1 }],
      }), { url });
    },
  });
  await getTargetInventory({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect });
      return response(JSON.stringify({ backend: "d1", rows: [], vector_backlog: { pending: 0 } }), { url });
    },
  });
  await postSourceReceipt({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    receipt: { source: "message", kind: "upload" },
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect });
      return response(JSON.stringify({ source: "message", status: "ready" }), { url });
    },
  });
  assert.equal(seen.length, 4);
  assert.ok(seen.every((entry) => entry.redirect === "error"));

  await assert.rejects(() => querySupabase({
    projectRef,
    accessToken: "fixture",
    sql: "select 1",
    fetchImpl: async (url) => response("[]", { url, redirected: true }),
  }), /redirected/);
  await assert.rejects(() => postTargetBatch({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    items: [item()],
    fetchImpl: async () => response("{}", { url: "https://other.example/api/admin/brain/ingest/batch" }),
  }), /changed origin or path/);
});

await check("migration responses are bounded before JSON parsing", async () => {
  await assert.rejects(() => readBoundedResponseText(new Response("12345"), {
    maxBytes: 4,
    label: "fixture response",
  }), /size limit/);
  await assert.rejects(() => readBoundedResponseText(response("ok", {
    headers: { "content-length": "999" },
  }), {
    maxBytes: 10,
    label: "fixture response",
  }), /size limit/);

  await assert.rejects(() => querySupabase({
    projectRef: "abcdefghijklmnopqrst",
    accessToken: "fixture",
    sql: "select 1",
    timeoutMs: 5,
    fetchImpl: async (url, options) => ({
      ok: true,
      status: 200,
      url,
      redirected: false,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          }),
          releaseLock: () => {},
        }),
      },
    }),
  }), /timed out after 5ms/);
});

await check("target and completion receipts must echo the exact source identity", async () => {
  const items = [item("synthetic-one"), item("synthetic-two")];
  await assert.rejects(() => postTargetBatch({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    items,
    fetchImpl: async (url) => response(JSON.stringify({ results: [
      { source_type: "message", source_id: "synthetic-two", status: "created", chunks: 1 },
      { source_type: "message", source_id: "synthetic-one", status: "created", chunks: 1 },
    ] }), { url }),
  }), /identity mismatch at slot 1/);
  await assert.rejects(() => postSourceReceipt({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    receipt: { source: "message", kind: "upload" },
    fetchImpl: async (url) => response(JSON.stringify({ source: "drive", status: "ready" }), { url }),
  }), /wrong source identity/);
  await assert.rejects(() => postSourceReceipt({
    targetUrl: "https://brain.example",
    adminKey: "fixture",
    receipt: { source: "message", kind: "upload", run_id: "migration-fixture" },
    fetchImpl: async (url) => response(JSON.stringify({
      source: "message", status: "ready", run_id: "migration-other",
    }), { url }),
  }), /wrong run identity/);
});

await check("HTTP failures do not echo a remote response payload", async () => {
  const marker = "REMOTE_PRIVATE_FIXTURE_MARKER";
  let error;
  try {
    await querySupabase({
      projectRef: "abcdefghijklmnopqrst",
      accessToken: "fixture",
      sql: "select 1",
      fetchImpl: async (url) => response(JSON.stringify({ error: marker }), { status: 500, url }),
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error?.message || "", /returned 500/);
  assert.doesNotMatch(error?.message || "", new RegExp(marker));
});

await check("checkpoint writes are owner-only, durable, and preserve one previous-good copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-state-fixture-"));
  chmodSync(dir, 0o700);
  try {
    const path = join(dir, "checkpoint.json");
    saveProtectedStateJson(path, { version: 1, value: 1 });
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o077, 0);
    assert.equal(lstatSync(path).nlink, 1);
    saveProtectedStateJson(path, { version: 1, value: 2 });
    assert.equal(readProtectedStateJson(path).value, 2);
    assert.equal(readProtectedStateJson(protectedStatePreviousPath(path)).value, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("checkpoint readers reject links, broad modes, and corrupt replacement sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-state-guard-fixture-"));
  chmodSync(dir, 0o700);
  try {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      const symbolic = join(dir, "symbolic.json");
      symlinkSync(real, symbolic);
      await assert.rejects(async () => readProtectedStateJson(symbolic), /regular file|link/);
    }

    const linked = join(dir, "linked.json");
    linkSync(real, linked);
    await assert.rejects(async () => readProtectedStateJson(real), /hard links/);
    rmSync(linked);

    if (process.platform !== "win32") {
      chmodSync(real, 0o644);
      await assert.rejects(async () => readProtectedStateJson(real), /permissions are too broad/);
      chmodSync(real, 0o600);
    }

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "not-json\n", { mode: 0o600 });
    await assert.rejects(async () => saveProtectedStateJson(corrupt, { safe: true }), /not valid JSON/);
    assert.equal(readFileSync(corrupt, "utf8"), "not-json\n");

    const guarded = join(dir, "guarded.json");
    saveProtectedStateJson(guarded, { value: 1 });
    if (process.platform !== "win32") {
      const previous = protectedStatePreviousPath(guarded);
      symlinkSync(guarded, previous);
      await assert.rejects(async () => saveProtectedStateJson(guarded, { value: 2 }), /regular file|link/);
      assert.equal(readProtectedStateJson(guarded).value, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const freshState = () => ({
  version: MESSAGE_STATE_VERSION,
  schema: MESSAGE_STATE_SCHEMA,
  project_ref: "synthetic-project",
  target_url: "https://brain.example",
  message_sessions: undefined,
});

await check("new migrations require and pin an explicit owner label and IANA timezone", async () => {
  await assert.rejects(() => runMessageMigration({
    state: freshState(),
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
  }), /--owner-label is required/);

  const state = freshState();
  const result = await runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ownerLabel: "Fixture Owner",
    groupingTimezone: "America/Denver",
  });
  assert.equal(result.status, "complete");
  assert.equal(state.message_sessions.scope.owner_label, "Fixture Owner");
  assert.equal(state.message_sessions.scope.grouping_timezone, "America/Denver");
  assert.match(state.message_sessions.config_fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ownerLabel: "Changed Owner",
  }), /reset and reconcile/);
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    groupingTimezone: "UTC",
  }), /reset and reconcile/);
  const tampered = structuredClone(state);
  tampered.message_sessions.config_fingerprint = "0".repeat(64);
  await assert.rejects(() => runMessageMigration({
    state: tampered,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
  }), /configuration changed/);
});

await check("a dry run leaves the caller's checkpoint object byte-for-byte unchanged", async () => {
  const state = freshState();
  const before = structuredClone(state);
  const result = await runMessageMigration({
    state,
    queryFn: async () => [],
    dryRun: true,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
  });
  assert.equal(result.status, "dry_run");
  assert.deepEqual(state, before);
});

await check("version-one checkpoints keep their historical Owner and UTC defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-state-legacy-fixture-"));
  chmodSync(dir, 0o700);
  try {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      project_ref: "synthetic-project",
      target_url: "https://brain.example",
      message_sessions: {},
    }) + "\n", { mode: 0o600 });
    const state = loadMessageState(path, {
      projectRef: "synthetic-project",
      targetUrl: "https://brain.example",
    });
    assert.equal(state.version, MESSAGE_STATE_VERSION);
    assert.equal(state.message_sessions.legacy_defaults_applied, true);
    assert.throws(() => loadMessageState(path, {
      projectRef: "different-project",
      targetUrl: "https://brain.example",
    }), /another Supabase project/);
    assert.throws(() => loadMessageState(path, {
      projectRef: "synthetic-project",
      targetUrl: "https://different.example",
    }), /another target brain/);
    await runMessageMigration({
      state,
      queryFn: async () => [],
      postFn: async () => ({ results: [] }),
    });
    assert.equal(state.message_sessions.scope.owner_label, "Owner");
    assert.equal(state.message_sessions.scope.grouping_timezone, "UTC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const syntheticRows = (count = 47) => Array.from({ length: count }, (_, index) => {
  const ordinal = String(index + 1).padStart(4, "0");
  const ts = new Date(Date.UTC(2026, 0, 1, 0, index * 7)).toISOString();
  let platform = index % 7 === 0 ? "email" : "imessage";
  let body = `Synthetic message body ${ordinal}`;
  if (index % 11 === 5) platform = "unsupported_fixture";
  if (index % 13 === 8) body = "[image]";
  return {
    cursor_id: `id-${ordinal}`,
    id: `id-${ordinal}`,
    thread_id: `thread-${index % 4}`,
    platform,
    direction: index % 3 === 0 ? "out" : "in",
    ts,
    body,
    thread_title: `Synthetic thread ${index % 4}`,
    category: "fixture",
    sender_name: "Fixture Contact",
  };
});

const sourceFor = (rows, { expected = rows.length } = {}) => async (sql) => {
  if (/ORDER BY m\.ts DESC, m\.id DESC LIMIT 1/.test(sql)) {
    const high = rows.at(-1);
    return high ? [{ ts: high.ts, id: high.id, eligible_rows: String(expected) }] : [];
  }
  if (/SELECT count\(\*\)::text AS eligible_rows/.test(sql)) {
    return [{ eligible_rows: String(expected) }];
  }
  const cursorMatch = sql.match(/\(m\.ts, m\.id::text\) > \('([^']+)'::timestamptz, '([^']+)'\)/);
  const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] || rows.length);
  const start = cursorMatch
    ? rows.findIndex((row) => row.ts === cursorMatch[1] && row.id === cursorMatch[2]) + 1
    : 0;
  return structuredClone(rows.slice(start, start + limit));
};

const targetStore = () => {
  const documents = new Map();
  return {
    documents,
    post: async (items) => ({
      results: items.map(({ envelope }) => {
        const key = `${envelope.source_type}:${envelope.source_id}`;
        const prior = documents.get(key);
        documents.set(key, JSON.stringify(envelope));
        return {
          source_type: envelope.source_type,
          source_id: envelope.source_id,
          status: prior === undefined ? "created" : prior === JSON.stringify(envelope) ? "unchanged" : "updated",
          chunks: 1,
        };
      }),
    }),
  };
};

const canonicalDocuments = (documents) => [...documents.entries()].sort(([a], [b]) => a.localeCompare(b));

const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

await check("random page sizes and repeated restarts preserve the exact document set", async () => {
  const rows = syntheticRows();
  const baselineState = freshState();
  const baselineTarget = targetStore();
  const baseline = await runMessageMigration({
    state: baselineState,
    queryFn: sourceFor(rows),
    postFn: baselineTarget.post,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "America/Denver",
    pageSize: 17,
  });
  assert.equal(baseline.status, "complete");
  assert.equal(baseline.accounting.expected_source_messages, rows.length);

  for (let seed = 1; seed <= 12; seed++) {
    const nextRandom = random(seed);
    let state = freshState();
    const target = targetStore();
    let result;
    for (let restart = 0; restart < 200; restart++) {
      result = await runMessageMigration({
        state,
        queryFn: sourceFor(rows),
        postFn: target.post,
        ownerLabel: restart === 0 ? "Fixture Owner" : undefined,
        groupingTimezone: restart === 0 ? "America/Denver" : undefined,
        pageSize: 1 + Math.floor(nextRandom() * 9),
        maxRows: 1 + Math.floor(nextRandom() * 13),
      });
      state = structuredClone(state);
      if (result.status === "complete") break;
    }
    assert.equal(result?.status, "complete", `seed ${seed} did not finish`);
    assert.deepEqual(canonicalDocuments(target.documents), canonicalDocuments(baselineTarget.documents));
    assert.equal(state.message_sessions.accounting.expected_source_messages, rows.length);
    assert.equal(state.message_sessions.accounting.processed_source_messages, rows.length);
  }
});

await check("an ambiguous committed response restarts without advancing or duplicating", async () => {
  const rows = syntheticRows(16);
  const state = freshState();
  const target = targetStore();
  let ambiguousCalls = 0;
  const ambiguousPost = async (items) => {
    await target.post(items);
    ambiguousCalls++;
    throw new Error("Network connection lost after commit");
  };
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: ambiguousPost,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    pageSize: 1,
    maxRows: 1,
  }), /Network connection lost/);
  assert.equal(ambiguousCalls, 3);
  assert.equal(state.message_sessions.cursor, null);
  assert.equal(state.message_sessions.source_messages, 0);
  const committedCount = target.documents.size;
  assert.ok(committedCount > 0);

  const result = await runMessageMigration({
    state: structuredClone(state),
    queryFn: sourceFor(rows),
    postFn: target.post,
    pageSize: 4,
  });
  assert.equal(result.status, "complete");
  assert.ok(result.unchanged >= committedCount);
  assert.equal(target.documents.size, result.target_documents);
  assert.equal(result.accounting.processed_source_messages, rows.length);
});

await check("final completion is blocked when the frozen source count does not balance", async () => {
  const rows = syntheticRows(9);
  const state = freshState();
  const target = targetStore();
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: sourceFor(rows, { expected: rows.length + 1 }),
    postFn: target.post,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    pageSize: 4,
  }), /processed 9 of 10 eligible rows/);
  assert.equal(state.message_sessions.complete, false);
  assert.equal(state.message_sessions.accounting, null);
});

await check("completion receipts are available only after aggregate accounting verifies", async () => {
  const state = freshState();
  await runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
  });
  state.message_sessions.target_readback = verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1",
    rows: [],
    vector_backlog: { pending: 0 },
  });
  const receipt = messageCompletionReceipt(state.message_sessions, "2026-01-01T00:00:00Z");
  assert.equal(receipt.source, "message");
  assert.equal(receipt.complete_sweep, false);
  assert.match(receipt.run_id, /^migration-[a-f0-9]{32}$/);
  assert.equal(receipt.run_id, messageCompletionReceipt(
    state.message_sessions, "2026-01-02T00:00:00Z",
  ).run_id);
  assert.match(receipt.detail, /expected=0/);
  const incomplete = structuredClone(state.message_sessions);
  incomplete.complete = false;
  await assert.rejects(async () => messageCompletionReceipt(incomplete), /not accounting-verified complete/);
});

await check("completion waits for exact D1 visibility and an empty vector outbox", async () => {
  const state = freshState();
  await runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
  });
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1", rows: [], vector_backlog: { pending: 3 },
  }), /3 vector operations are still pending/);
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "supabase", rows: [], vector_backlog: { pending: 0 },
  }), /expected D1 backend/);

  const lane = structuredClone(state.message_sessions);
  lane.target_documents = 2;
  lane.created = 2;
  lane.candidate_parts = 2;
  assert.throws(() => verifyMessageTargetInventory(lane, {
    backend: "d1",
    rows: [{ source_type: "message", stored_documents: 1 }],
    vector_backlog: { pending: 0 },
  }), /fewer stored documents/);
});

console.log(`\nmigration hardening: ${ran - failed}/${ran} passed`);
if (failed) process.exit(1);
