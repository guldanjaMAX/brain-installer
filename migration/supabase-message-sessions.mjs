#!/usr/bin/env node

/**
 * Resumable migration from the normalized messaging schema.
 *
 * Source reads are globally chronological and use the existing timestamp
 * index. Email remains one document per message. Short-form chat is grouped by
 * the reusable MessageSessionizer into bounded, speaker-labelled sessions.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { batches, splitOversized } from "../ingest/run.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";
import { scan as scanSecrets } from "../worker/src/lib/secret-scan.js";
import { postTargetBatch, querySupabase } from "./supabase-import.mjs";

const ELIGIBLE = "coalesce(m.flagged, false) = false AND m.body IS NOT NULL AND length(trim(m.body)) >= 4";
const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");
const sqlText = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;
const positiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
const bound = (value, label) => {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a valid date`);
  return date.toISOString();
};
const rangeSql = ({ from = null, to = null } = {}) => [
  from ? `AND m.ts >= ${sqlText(from)}::timestamptz` : "",
  to ? `AND m.ts <= ${sqlText(to)}::timestamptz` : "",
].filter(Boolean).join("\n            ");

export function messageHighWaterSql(scope = {}) {
  return `SELECT m.ts::text AS ts, m.id::text AS id
    FROM messaging.messages m
    WHERE ${ELIGIBLE}
      ${rangeSql(scope)}
    ORDER BY m.ts DESC, m.id DESC LIMIT 1`;
}

export function messagePageSql(cursor, highWater, limit = 1000, scope = {}) {
  if (!highWater?.ts || !highWater?.id) throw new Error("message migration high-water mark is missing");
  const after = cursor?.ts && cursor?.id
    ? `AND (m.ts, m.id::text) > (${sqlText(cursor.ts)}::timestamptz, ${sqlText(cursor.id)})`
    : "";
  return `SELECT m.id::text AS cursor_id, m.id::text AS id, m.thread_id::text AS thread_id,
                 m.platform, m.direction, m.ts::text AS ts, m.body,
                 t.title AS thread_title, t.category,
                 coalesce(p.display_name, h.display_label) AS sender_name
          FROM messaging.messages m
          LEFT JOIN messaging.threads t ON t.id = m.thread_id
          LEFT JOIN messaging.handles h ON h.id = m.sender_handle_id
          LEFT JOIN messaging.people p ON p.id = h.person_id
          WHERE ${ELIGIBLE}
            ${rangeSql(scope)}
            ${after}
            AND (m.ts, m.id::text) <= (${sqlText(highWater.ts)}::timestamptz, ${sqlText(highWater.id)})
          ORDER BY m.ts, m.id
          LIMIT ${positiveInt(limit, 1000, 5000)}`;
}

const freshLane = () => ({
  high_water: null,
  cursor: null,
  active: [],
  complete: false,
  pages: 0,
  source_messages: 0,
  candidate_documents: 0,
  target_documents: 0,
  target_chunks: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  refused: 0,
  failed: 0,
  skipped: 0,
  refusals: [],
  scope: null,
});

export function loadMessageState(path, { projectRef, targetUrl } = {}) {
  let state = null;
  if (path && existsSync(path)) {
    try { state = JSON.parse(readFileSync(path, "utf-8")); }
    catch { throw new Error(`message migration state is not valid JSON: ${path}`); }
  }
  state ||= { version: 1, project_ref: projectRef, target_url: cleanUrl(targetUrl), message_sessions: freshLane() };
  if (state.version !== 1) throw new Error(`unsupported message migration state version ${state.version}`);
  if (state.project_ref && projectRef && state.project_ref !== projectRef) throw new Error("message state belongs to another Supabase project");
  if (state.target_url && targetUrl && state.target_url !== cleanUrl(targetUrl)) throw new Error("message state belongs to another target brain");
  state.message_sessions ||= freshLane();
  return state;
}

export function saveMessageState(path, state) {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, absolute);
}

const itemize = (envelopes) => envelopes.flatMap((envelope) =>
  splitOversized(envelope).map((part) => ({ envelope: part }))
);

const emptyTally = () => ({
  candidate_documents: 0, target_documents: 0, target_chunks: 0,
  created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0,
  refusals: [],
});

export async function sendMessageEnvelopes(envelopes, postFn) {
  const tally = emptyTally();
  tally.candidate_documents = envelopes.length;
  const safe = [];
  for (const envelope of envelopes) {
    const scan = scanSecrets(envelope.content);
    if (scan.shouldRefuse) {
      tally.refused++;
      if (tally.refusals.length < 1000) tally.refusals.push({
        source_id: envelope.source_id,
        labels: scan.labels,
      });
    } else {
      safe.push(envelope);
    }
  }
  const items = itemize(safe);
  for (const group of batches(items)) {
    const receipt = await postFn(group);
    if (!Array.isArray(receipt?.results) || receipt.results.length !== group.length) {
      throw new Error(`message target receipt has ${receipt?.results?.length ?? 0} slots for ${group.length} documents`);
    }
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const slot = receipt.results[i];
      const status = slot?.status;
      if (["created", "updated", "unchanged"].includes(status)) {
        tally[status]++;
        tally.target_documents++;
        tally.target_chunks += Number(slot.chunks || 0);
      } else if (status === "refused") {
        tally.refused++;
        if (tally.refusals.length < 1000) tally.refusals.push({
          source_id: item.envelope.source_id,
          labels: slot.labels || [],
        });
      } else {
        tally.failed++;
        throw new Error(`message ${item.envelope.source_id} failed: ${slot?.error || "unknown target status"}`);
      }
    }
  }
  return tally;
}

const mergeTally = (lane, tally) => {
  for (const key of ["candidate_documents", "target_documents", "target_chunks", "created", "updated", "unchanged", "refused", "failed"]) {
    lane[key] += Number(tally[key] || 0);
  }
  if (tally.refusals?.length) {
    lane.refusals.push(...tally.refusals);
    if (lane.refusals.length > 1000) lane.refusals.splice(0, lane.refusals.length - 1000);
  }
};

export async function runMessageMigration({
  state,
  queryFn,
  postFn,
  saveFn = () => {},
  ownerLabel = "Owner",
  pageSize = 1000,
  maxRows = Infinity,
  dryRun = false,
  from = null,
  to = null,
} = {}) {
  const lane = state.message_sessions ||= freshLane();
  const scope = { from: bound(from, "--from"), to: bound(to, "--to"), owner_label: ownerLabel };
  if (scope.from && scope.to && Date.parse(scope.from) > Date.parse(scope.to)) throw new Error("--from must be before --to");
  if (lane.scope && JSON.stringify(lane.scope) !== JSON.stringify(scope)) {
    throw new Error("message migration scope changed after the lane started; use the original date bounds and owner label");
  }
  if (!lane.scope) {
    if (lane.source_messages > 0 && (scope.from || scope.to)) {
      throw new Error("date bounds cannot be added to an in-progress unbounded message migration");
    }
    lane.scope = scope;
    if (!dryRun) saveFn(state);
  }
  if (lane.complete) return { status: "complete", ...lane };
  if (!lane.high_water) {
    const [high] = await queryFn(messageHighWaterSql(scope));
    if (!high?.ts || !high?.id) {
      lane.complete = true;
      if (!dryRun) saveFn(state);
      return { status: "complete", ...lane };
    }
    lane.high_water = { ts: high.ts, id: high.id };
    if (!dryRun) saveFn(state);
  }

  const sessionizer = new MessageSessionizer({ ownerLabel, active: lane.active || [] });
  let cursor = lane.cursor;
  let runRows = 0;
  let runPages = 0;
  let dryDocuments = 0;
  let dryParts = 0;
  const preview = [];

  while (runRows < maxRows) {
    const remaining = Number.isFinite(maxRows) ? Math.max(1, Math.min(pageSize, maxRows - runRows)) : pageSize;
    const rows = await queryFn(messagePageSql(cursor, lane.high_water, remaining, scope));
    if (!rows.length) {
      const finalEnvelopes = sessionizer.finish();
      if (dryRun) {
        dryDocuments += finalEnvelopes.length;
        dryParts += itemize(finalEnvelopes).length;
      } else {
        mergeTally(lane, await sendMessageEnvelopes(finalEnvelopes, postFn));
        lane.active = [];
        lane.complete = true;
        lane.last_checkpoint_at = new Date().toISOString();
        saveFn(state);
      }
      break;
    }

    const envelopes = [];
    let skipped = 0;
    for (const row of rows) {
      const before = envelopes.length;
      envelopes.push(...sessionizer.push(row));
      if (before === envelopes.length && !sessionizer.snapshot().some((s) => s.last_id === row.id)) {
        // Email and closed chat sessions produce immediately. A row that did
        // neither is an empty/media marker or unsupported platform.
        if (String(row.platform || "").toLowerCase() !== "email") skipped++;
      }
    }

    if (dryRun) {
      dryDocuments += envelopes.length;
      dryParts += itemize(envelopes).length;
      for (const envelope of envelopes) if (preview.length < 5) preview.push({
        source_id: envelope.source_id,
        title: envelope.title,
        platform: envelope.metadata?.platform,
        messages: envelope.metadata?.message_count || 1,
        chars: envelope.content.length,
      });
    } else {
      const tally = await sendMessageEnvelopes(envelopes, postFn);
      mergeTally(lane, tally);
      lane.cursor = { ts: rows.at(-1).ts, id: rows.at(-1).id };
      lane.active = sessionizer.snapshot();
      lane.pages++;
      lane.source_messages += rows.length;
      lane.skipped += skipped;
      lane.last_checkpoint_at = new Date().toISOString();
      saveFn(state);
    }

    cursor = { ts: rows.at(-1).ts, id: rows.at(-1).id };

    runRows += rows.length;
    runPages++;
    if (rows.length < remaining) continue;
  }

  return {
    status: dryRun ? "dry_run" : lane.complete ? "complete" : "checkpointed",
    run_rows: runRows,
    run_pages: runPages,
    would_create_documents: dryRun ? dryDocuments : undefined,
    would_create_parts: dryRun ? dryParts : undefined,
    preview: dryRun ? preview : undefined,
    ...lane,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (["dry-run", "reset"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const projectRef = flags["project-ref"] || process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const targetUrl = flags.target || process.env.BRAIN_URL;
  const adminKey = process.env.ADMIN_KEY;
  const dryRun = !!flags["dry-run"];
  if (!projectRef) throw new Error("pass --project-ref or set SUPABASE_PROJECT_REF");
  if (!accessToken) throw new Error("set SUPABASE_ACCESS_TOKEN; it is read at runtime and never stored");
  if (!dryRun && !targetUrl) throw new Error("pass --target or set BRAIN_URL");
  if (!dryRun && !adminKey) throw new Error("set ADMIN_KEY for the isolated target brain");

  const statePath = resolve(flags.state || ".brain-migration-message-sessions.json");
  if (flags.reset && existsSync(statePath)) throw new Error("--reset requires removing or archiving the existing state file deliberately");
  const state = loadMessageState(statePath, { projectRef, targetUrl });
  const queryFn = (sql) => querySupabase({ projectRef, accessToken, sql });
  const result = await runMessageMigration({
    state,
    queryFn,
    postFn: (items) => postTargetBatch({ targetUrl, adminKey, items }),
    saveFn: (next) => saveMessageState(statePath, next),
    ownerLabel: flags["owner-label"] || "Owner",
    pageSize: positiveInt(flags["page-size"], 1000, 5000),
    maxRows: flags["max-rows"] ? positiveInt(flags["max-rows"], 10000) : dryRun ? 10000 : Infinity,
    dryRun,
    from: flags.from,
    to: flags.to,
  });
  console.log(JSON.stringify({
    ...result,
    active: result.active?.length,
    refusals: result.refusals?.slice(-20),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(`message migration failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
