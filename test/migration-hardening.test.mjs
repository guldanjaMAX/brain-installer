import assert from "node:assert/strict";
import {
  chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTargetFamilies, getTargetInventory, listTargetSourceFamilies,
  postSourceReceipt, postTargetBatch, querySupabase, readBoundedResponseText,
} from "../migration/supabase-import.mjs";
import {
  MESSAGE_STATE_SCHEMA, MESSAGE_STATE_VERSION, loadMessageState,
  messageCompletionReceipt, messageHighWaterSha256, reconcileMessageTargetFamilies,
  runMessageMigration, sendMessageEnvelopes, verifyMessageTargetInventory,
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

const readyVectorInventory = (expectedVectors = 0) => ({
  vector_backlog: { pending: 0 },
  vector_readiness: {
    ready: true,
    pending: 0,
    submitted: 0,
    expected_vectors: expectedVectors,
    actual_vectors: expectedVectors,
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
      return response(JSON.stringify({ backend: "d1", rows: [], ...readyVectorInventory() }), { url });
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
  }), /different origin|changed origin or path/);

  let insecureTargetCalls = 0;
  await assert.rejects(() => postTargetBatch({
    targetUrl: "http://brain.example",
    adminKey: "fixture",
    items: [item()],
    fetchImpl: async () => { insecureTargetCalls++; return response("{}"); },
  }), /HTTPS.*loopback/i);
  assert.equal(insecureTargetCalls, 0, "migration refuses insecure target before fetch");
});

await check("target-family inventory and deletion use authenticated exact receipts", async () => {
  const seen = [];
  const families = await listTargetSourceFamilies({
    targetUrl: "https://brain.example",
    adminKey: "fixture-admin",
    source: "message",
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      seen.push({
        url,
        authenticated: new Headers(options.headers).get("X-Admin-Key") === "fixture-admin",
        request,
      });
      const body = request.cursor
        ? { source: "message", families: ["message:zulu"], next_cursor: null }
        : { source: "message", families: ["message:one", "message:two"], next_cursor: "message:two" };
      return response(JSON.stringify(body), { url });
    },
  });
  assert.deepEqual(families, ["message:one", "message:two", "message:zulu"]);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((entry) => entry.authenticated));
  assert.equal(seen[1].request.cursor, "message:two");

  const deletion = await deleteTargetFamilies({
    targetUrl: "https://brain.example",
    adminKey: "fixture-admin",
    source: "message",
    families: ["message:one", "message:two"],
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(new Headers(options.headers).get("X-Admin-Key"), "fixture-admin");
      assert.equal(request.confirm, true);
      assert.equal(request.families.length, 2);
      return response(JSON.stringify({
        documents: 3,
        vector_cleanup_queued: 1,
        dry_run: false,
        targets: ["message:one", "message:two", "message:two#part1of2"],
      }), { url });
    },
  });
  assert.deepEqual(deletion, { families: 2, documents: 3, vector_cleanup_queued: 1 });

  await assert.rejects(() => deleteTargetFamilies({
    targetUrl: "https://brain.example",
    adminKey: "fixture-admin",
    source: "message",
    families: ["message:one"],
    fetchImpl: async (url) => response(JSON.stringify({
      documents: 1, dry_run: false, targets: ["message:unrelated"],
    }), { url }),
  }), /unrelated identity/);
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
const EMPTY_SOURCE_BOUNDARY = Object.freeze({
  minimum_source_messages: 0,
  high_water_sha256: messageHighWaterSha256(null),
});
const EMPTY_TARGET = Object.freeze({
  reconcileFn: async (plans) => ({ families: plans.length, documents: 0 }),
  listTargetFamiliesFn: async () => [],
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
    sourceBoundary: EMPTY_SOURCE_BOUNDARY,
    ...EMPTY_TARGET,
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
    sourceBoundary: EMPTY_SOURCE_BOUNDARY,
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
    const result = await runMessageMigration({
      state,
      queryFn: async () => [],
      postFn: async () => ({ results: [] }),
      sourceBoundary: EMPTY_SOURCE_BOUNDARY,
      ...EMPTY_TARGET,
    });
    assert.equal(result.status, "complete");
    assert.equal(state.message_sessions.scope.owner_label, "Owner");
    assert.equal(state.message_sessions.scope.grouping_timezone, "UTC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("a completed version-one checkpoint without a safety fingerprint fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-state-legacy-complete-fixture-"));
  chmodSync(dir, 0o700);
  try {
    const path = join(dir, "legacy-complete.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      project_ref: "synthetic-project",
      target_url: "https://brain.example",
      message_sessions: { complete: true },
    }) + "\n", { mode: 0o600 });
    const state = loadMessageState(path, {
      projectRef: "synthetic-project",
      targetUrl: "https://brain.example",
    });
    let queries = 0;
    let posts = 0;
    let saves = 0;
    await assert.rejects(() => runMessageMigration({
      state,
      queryFn: async () => { queries++; return []; },
      postFn: async () => { posts++; return { results: [] }; },
      saveFn: () => { saves++; },
    }), /content-safety identity.*reset.*reconcile/);
    assert.equal(queries, 0);
    assert.equal(posts, 0);
    assert.equal(saves, 0);
    assert.equal(state.message_sessions.config_fingerprint, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("an incomplete progressed version-one checkpoint without a safety fingerprint fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-state-legacy-progress-fixture-"));
  chmodSync(dir, 0o700);
  try {
    const path = join(dir, "legacy-progress.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      project_ref: "synthetic-project",
      target_url: "https://brain.example",
      message_sessions: {
        complete: false,
        pages: 4,
        source_messages: 4000,
        candidate_documents: 3987,
        candidate_parts: 3987,
        target_documents: 3987,
        created: 3987,
        high_water: { ts: "2026-08-01T00:00:00.000Z", id: "high-water" },
        cursor: { ts: "2026-07-20T00:00:00.000Z", id: "cursor" },
      },
    }) + "\n", { mode: 0o600 });
    const state = loadMessageState(path, {
      projectRef: "synthetic-project",
      targetUrl: "https://brain.example",
    });
    let queries = 0;
    let posts = 0;
    let saves = 0;
    await assert.rejects(() => runMessageMigration({
      state,
      queryFn: async () => { queries++; return []; },
      postFn: async () => { posts++; return { results: [] }; },
      saveFn: () => { saves++; },
    }), /progressed legacy.*content-safety identity.*reset.*reconcile/);
    assert.equal(queries, 0);
    assert.equal(posts, 0);
    assert.equal(saves, 0);
    assert.equal(state.message_sessions.config_fingerprint, null);
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
    const frozen = sql.match(/\(m\.ts, m\.id::text\) <= \('([^']+)'::timestamptz, '([^']+)'\)/);
    const eligible = frozen
      ? rows.filter((row) => row.ts < frozen[1] || (row.ts === frozen[1] && row.id <= frozen[2]))
      : rows;
    const high = eligible.at(-1);
    return high ? [{
      ts: high.ts,
      id: high.id,
      eligible_rows: String(frozen ? eligible.length : expected),
    }] : [];
  }
  if (/SELECT count\(\*\)::text AS eligible_rows/.test(sql)) {
    return [{ eligible_rows: String(expected) }];
  }
  const cursorMatch = sql.match(/\(m\.ts, m\.id::text\) > \('([^']+)'::timestamptz, '([^']+)'\)/);
  const upperMatch = sql.match(/\(m\.ts, m\.id::text\) <= \('([^']+)'::timestamptz, '([^']+)'\)/);
  const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] || rows.length);
  const boundedRows = upperMatch
    ? rows.filter((row) => row.ts < upperMatch[1] || (row.ts === upperMatch[1] && row.id <= upperMatch[2]))
    : rows;
  const start = cursorMatch
    ? boundedRows.findIndex((row) => row.ts === cursorMatch[1] && row.id === cursorMatch[2]) + 1
    : 0;
  return structuredClone(boundedRows.slice(start, start + limit));
};

const sourceBoundaryFor = (rows, minimum = rows.length) => ({
  minimum_source_messages: minimum,
  high_water_sha256: messageHighWaterSha256(rows.length ? {
    ts: rows.at(-1).ts,
    id: rows.at(-1).id,
  } : null),
});

const targetStore = () => {
  const documents = new Map();
  const logicalFamily = (serialized, key) => {
    const envelope = JSON.parse(serialized);
    return `message:${envelope.metadata?.part_of || envelope.source_id || key.slice("message:".length)}`;
  };
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
    list: async () => [...new Set(
      [...documents.entries()].map(([key, serialized]) => logicalFamily(serialized, key)),
    )].sort(),
    reconcile: async (plans) => {
      const requested = new Map(plans.map((plan) => [
        plan.base_doc_uid,
        new Set(plan.keep_doc_uids),
      ]));
      let removed = 0;
      for (const [key, serialized] of [...documents.entries()]) {
        const keep = requested.get(logicalFamily(serialized, key));
        if (keep && !keep.has(key)) {
          documents.delete(key);
          removed++;
        }
      }
      return { families: requested.size, documents: removed };
    },
  };
};

const canonicalDocuments = (documents) => [...documents.entries()].sort(([a], [b]) => a.localeCompare(b));

const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

await check("reviewed source evidence blocks empty or truncated replacements before target writes", async () => {
  const reviewedRows = syntheticRows(6);
  const boundary = sourceBoundaryFor(reviewedRows, reviewedRows.length);
  for (const queryFn of [
    async () => [],
    sourceFor(reviewedRows, { expected: reviewedRows.length - 1 }),
  ]) {
    const state = freshState();
    let posts = 0;
    let reconciliations = 0;
    let inventories = 0;
    let saves = 0;
    await assert.rejects(() => runMessageMigration({
      state,
      queryFn,
      postFn: async () => { posts++; return { results: [] }; },
      reconcileFn: async (plans) => { reconciliations++; return { families: plans.length }; },
      listTargetFamiliesFn: async () => { inventories++; return []; },
      saveFn: () => { saves++; },
      ownerLabel: "Fixture Owner",
      groupingTimezone: "UTC",
      sourceBoundary: boundary,
    }), /high-water continuity|below the reviewed minimum/);
    assert.equal(posts, 0);
    assert.equal(reconciliations, 0);
    assert.equal(inventories, 0);
    assert.equal(saves, 0);
    assert.notEqual(state.message_sessions?.complete, true);
  }
});

await check("resume verifies the frozen prefix while ignoring messages newer than its saved high-water", async () => {
  const initialRows = syntheticRows(12);
  const laterRows = syntheticRows(13);
  const state = freshState();
  const target = targetStore();
  const first = await runMessageMigration({
    state,
    queryFn: sourceFor(initialRows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(initialRows),
    maxRows: 3,
    pageSize: 3,
  });
  assert.equal(first.status, "checkpointed");
  const resumed = await runMessageMigration({
    state,
    queryFn: sourceFor(laterRows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    pageSize: 4,
  });
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.expected_source_messages, initialRows.length);
  assert.equal(resumed.source_messages, initialRows.length);
  assert.equal(resumed.cursor.id, initialRows.at(-1).id);
});

await check("a refusal cleanup failure cannot advance the source cursor", async () => {
  const rows = syntheticRows(1);
  rows[0].body = `CLOUDFLARE_API_TOKEN=cfut_${"A".repeat(48)}`;
  const state = freshState();
  const target = targetStore();
  target.documents.set("message:id-0001", JSON.stringify({
    source_type: "message", source_id: "id-0001", metadata: {}, content: "old accepted fixture",
  }));
  let posts = 0;
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: async () => { posts++; return { results: [] }; },
    reconcileFn: async () => { throw new Error("Network connection lost during exact cleanup"); },
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
    pageSize: 1,
  }), /Network connection lost/);
  assert.equal(posts, 0);
  assert.equal(state.message_sessions.cursor, null);
  assert.equal(state.message_sessions.source_messages, 0);
  assert.equal(state.message_sessions.complete, false);
  assert.equal(target.documents.size, 1);

  const completed = await runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    pageSize: 1,
  });
  assert.equal(completed.status, "complete");
  assert.equal(completed.reconciled_refused_families, 1);
  assert.equal(target.documents.size, 0);
});

await check("accepted split families prune every obsolete physical part before settling", async () => {
  const target = targetStore();
  for (let part = 1; part <= 3; part++) {
    const sourceId = `split-family#part${part}of3`;
    target.documents.set(`message:${sourceId}`, JSON.stringify({
      source_type: "message",
      source_id: sourceId,
      content: `obsolete part ${part}`,
      metadata: { part, part_count: 3, part_of: "split-family" },
    }));
  }
  const receipt = await sendMessageEnvelopes([
    {
      source_type: "message",
      source_id: "split-family",
      title: "Synthetic oversized family",
      content: "x".repeat(500_000),
      metadata: { message_count: 1 },
    },
  ], target.post, { reconcileFn: target.reconcile });
  assert.equal(receipt.target_documents, 2);
  assert.equal(receipt.reconciled_accepted_families, 1);
  assert.deepEqual([...target.documents.keys()].sort(), [
    "message:split-family#part1of2",
    "message:split-family#part2of2",
  ]);
});

await check("full replay removes extra logical families and refuses missing expected families", async () => {
  const rows = syntheticRows(4);
  const target = targetStore();
  target.documents.set("message:obsolete", JSON.stringify({
    source_type: "message", source_id: "obsolete", metadata: {}, content: "obsolete fixture",
  }));
  const state = freshState();
  const completed = await runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
  });
  assert.equal(completed.status, "complete");
  assert.equal(completed.target_reconciliation.removed_extra_families, 1);
  assert.ok(!target.documents.has("message:obsolete"));

  const missingState = freshState();
  const missingTarget = targetStore();
  await assert.rejects(() => runMessageMigration({
    state: missingState,
    queryFn: sourceFor(rows),
    postFn: missingTarget.post,
    reconcileFn: missingTarget.reconcile,
    listTargetFamiliesFn: async () => [],
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
  }), /missing [1-9][0-9]* expected families/);
  assert.equal(missingState.message_sessions.complete, false);
});

await check("random page sizes and repeated restarts preserve the exact document set", async () => {
  const rows = syntheticRows();
  const baselineState = freshState();
  const baselineTarget = targetStore();
  const baseline = await runMessageMigration({
    state: baselineState,
    queryFn: sourceFor(rows),
    postFn: baselineTarget.post,
    reconcileFn: baselineTarget.reconcile,
    listTargetFamiliesFn: baselineTarget.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "America/Denver",
    sourceBoundary: sourceBoundaryFor(rows),
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
        reconcileFn: target.reconcile,
        listTargetFamiliesFn: target.list,
        ownerLabel: restart === 0 ? "Fixture Owner" : undefined,
        groupingTimezone: restart === 0 ? "America/Denver" : undefined,
        sourceBoundary: restart === 0 ? sourceBoundaryFor(rows) : undefined,
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
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
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
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
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
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
    pageSize: 4,
  }), /processed 9 of 10 eligible rows/);
  assert.equal(state.message_sessions.complete, false);
  assert.equal(state.message_sessions.accounting, null);
});

await check("a historical row backfilled behind the cursor cannot be certified as complete", async () => {
  const initialRows = syntheticRows(2);
  const liveRows = structuredClone(initialRows);
  const boundary = sourceBoundaryFor(initialRows);
  const state = freshState();
  const target = targetStore();
  const source = sourceFor(liveRows);
  let pageQueries = 0;
  const queryFn = async (sql) => {
    const result = await source(sql);
    if (/ORDER BY m\.ts, m\.id\s+LIMIT/.test(sql) && ++pageQueries === 1) {
      const backfill = {
        ...structuredClone(initialRows[0]),
        cursor_id: "id-backfill",
        id: "id-backfill",
        ts: new Date(Date.parse(initialRows[0].ts) - 60_000).toISOString(),
        body: "Synthetic historical backfill",
      };
      liveRows.unshift(backfill);
    }
    return result;
  };

  await assert.rejects(() => runMessageMigration({
    state,
    queryFn,
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: boundary,
    pageSize: 1,
  }), /source count changed after the checkpoint started/);
  assert.equal(state.message_sessions.complete, false);
  assert.equal(state.message_sessions.expected_source_messages, 2);
  assert.equal(liveRows.length, 3);
});

await check("complete-state recovery rechecks for backfills after target reconciliation", async () => {
  const initialRows = syntheticRows(2);
  const state = freshState();
  const target = targetStore();
  await runMessageMigration({
    state,
    queryFn: sourceFor(initialRows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(initialRows),
    pageSize: 1,
  });
  assert.equal(state.message_sessions.complete, true);

  const liveRows = structuredClone(initialRows);
  let inserted = false;
  const listWithBackfill = async () => {
    if (!inserted) {
      inserted = true;
      liveRows.unshift({
        ...structuredClone(initialRows[0]),
        cursor_id: "id-recovery-backfill",
        id: "id-recovery-backfill",
        ts: new Date(Date.parse(initialRows[0].ts) - 60_000).toISOString(),
        body: "Synthetic recovery-window backfill",
      });
    }
    return target.list();
  };
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: sourceFor(liveRows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: listWithBackfill,
  }), /source count changed after the checkpoint started/);
  assert.equal(liveRows.length, 3);
});

await check("a recorded completion is sealed before any source or target operation", async () => {
  const rows = syntheticRows(3);
  const state = freshState();
  const target = targetStore();
  await runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
  });
  state.message_sessions.target_readback = verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1",
    rows: [{
      source_type: "message",
      stored_documents: state.message_sessions.target_documents,
      logical_documents: state.message_sessions.accepted_family_hashes.length,
      document_counts_exact: true,
    }],
    ...readyVectorInventory(state.message_sessions.target_documents),
  });
  state.message_sessions.receipt_recorded_at = "2026-08-25T00:00:00.000Z";
  target.documents.set("message:newer-delta", JSON.stringify({
    source_type: "message", source_id: "newer-delta", metadata: {}, content: "newer fixture",
  }));
  const before = canonicalDocuments(target.documents);
  const calls = { query: 0, post: 0, reconcile: 0, list: 0, save: 0 };
  const result = await runMessageMigration({
    state,
    queryFn: async () => { calls.query++; throw new Error("sealed replay queried its source"); },
    postFn: async () => { calls.post++; throw new Error("sealed replay posted a document"); },
    reconcileFn: async () => { calls.reconcile++; throw new Error("sealed replay reconciled target families"); },
    listTargetFamiliesFn: async () => { calls.list++; throw new Error("sealed replay listed target families"); },
    saveFn: () => { calls.save++; throw new Error("sealed replay saved its checkpoint"); },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.sealed_noop, true);
  assert.deepEqual(calls, { query: 0, post: 0, reconcile: 0, list: 0, save: 0 });
  assert.deepEqual(canonicalDocuments(target.documents), before);
});

await check("corrupt completed accounting fails before target reconciliation", async () => {
  const rows = syntheticRows(2);
  const state = freshState();
  const target = targetStore();
  await runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: target.post,
    reconcileFn: target.reconcile,
    listTargetFamiliesFn: target.list,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: sourceBoundaryFor(rows),
  });
  state.message_sessions.represented_source_messages++;
  let reconciliations = 0;
  let inventories = 0;
  let saves = 0;
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: sourceFor(rows),
    postFn: target.post,
    reconcileFn: async (plans) => {
      reconciliations++;
      return target.reconcile(plans);
    },
    listTargetFamiliesFn: async () => {
      inventories++;
      return target.list();
    },
    saveFn: () => { saves++; },
  }), /saved completion accounting|source classifications do not balance/);
  assert.equal(reconciliations, 0);
  assert.equal(inventories, 0);
  assert.equal(saves, 0);
});

await check("a sealed completion rejects corrupt saved target readback without operations", async () => {
  const state = freshState();
  await runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ...EMPTY_TARGET,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: EMPTY_SOURCE_BOUNDARY,
  });
  state.message_sessions.target_readback = {
    backend: "d1",
    stored_documents: 999,
    logical_documents: 999,
    vector_backlog: 0,
    vector_readiness: {
      ready: true,
      pending: 0,
      submitted: 0,
      expected_vectors: 999,
      actual_vectors: 999,
    },
    verified_at: "2026-08-25T00:00:00.000Z",
  };
  state.message_sessions.receipt_recorded_at = "2026-08-25T00:01:00.000Z";
  const calls = { query: 0, post: 0, reconcile: 0, list: 0, save: 0 };
  await assert.rejects(() => runMessageMigration({
    state,
    queryFn: async () => { calls.query++; return []; },
    postFn: async () => { calls.post++; return { results: [] }; },
    reconcileFn: async () => { calls.reconcile++; return { families: 0 }; },
    listTargetFamiliesFn: async () => { calls.list++; return []; },
    saveFn: () => { calls.save++; },
  }), /recorded completion is not retrieval-ready/);
  assert.deepEqual(calls, { query: 0, post: 0, reconcile: 0, list: 0, save: 0 });
});

await check("completion receipts are available only after aggregate accounting verifies", async () => {
  const state = freshState();
  await runMessageMigration({
    state,
    queryFn: async () => [],
    postFn: async () => ({ results: [] }),
    ...EMPTY_TARGET,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: EMPTY_SOURCE_BOUNDARY,
  });
  state.message_sessions.target_readback = verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1",
    rows: [],
    ...readyVectorInventory(),
  });
  const receipt = messageCompletionReceipt(state.message_sessions, "2026-01-01T00:00:00Z");
  assert.equal(receipt.source, "message");
  assert.equal(receipt.complete_sweep, true);
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
    ...EMPTY_TARGET,
    ownerLabel: "Fixture Owner",
    groupingTimezone: "UTC",
    sourceBoundary: EMPTY_SOURCE_BOUNDARY,
  });
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1", rows: [], vector_backlog: { pending: 3 },
    vector_readiness: {
      ready: false, pending: 3, submitted: 0, expected_vectors: 0, actual_vectors: 0,
    },
  }), /3 vector operations are still pending/);
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "supabase", rows: [], ...readyVectorInventory(),
  }), /expected D1 backend/);

  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1", rows: [], vector_backlog: { pending: 0 },
  }), /no valid exact vector readiness/);
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1",
    rows: [],
    vector_backlog: { pending: 0 },
    vector_readiness: {
      ready: false,
      pending: 0,
      submitted: 0,
      expected_vectors: 1,
      actual_vectors: 0,
      reason: "vector_count_mismatch",
      action: "run brain diagnose",
    },
  }), /not query-ready \(vector_count_mismatch\); run brain diagnose/);
  assert.throws(() => verifyMessageTargetInventory(state.message_sessions, {
    backend: "d1",
    rows: [],
    vector_backlog: { pending: 0 },
    vector_readiness: {
      ready: true, pending: 0, submitted: 0, expected_vectors: 2, actual_vectors: 1,
    },
  }), /not query-ready/);

  const lane = structuredClone(state.message_sessions);
  lane.target_documents = 2;
  lane.created = 2;
  lane.candidate_parts = 2;
  assert.throws(() => verifyMessageTargetInventory(lane, {
    backend: "d1",
    rows: [{ source_type: "message", stored_documents: 1, document_counts_exact: true }],
    ...readyVectorInventory(1),
  }), /does not exactly match accepted physical documents/);
  assert.throws(() => verifyMessageTargetInventory(lane, {
    backend: "d1",
    rows: [{ source_type: "message", stored_documents: 2, logical_documents: 0 }],
    ...readyVectorInventory(2),
  }), /not based on exact live document counts/);
});

console.log(`\nmigration hardening: ${ran - failed}/${ran} passed`);
if (failed) process.exit(1);
