/**
 * Owner-session bank exports: private preview, then one explicitly confirmed
 * D1 transaction.
 *
 * The raw OFX/QFX/CSV bytes are parsed in the Worker and are never persisted.
 * Preview stores only hashes and a fifteen-minute binding. Commit reparses the
 * exact bytes, revalidates entity/account scope, and sends the resulting plan
 * through fin-import's single ledger statement builder. No omission is ever a
 * deletion signal.
 */

import { readBankExport } from "../../../ingest/bank-export.mjs";
import { jsonResponse, privateNoStore } from "./core.js";
import { prepareBankExportImport, DEFAULT_TENANT } from "./fin-import.js";
import { ledgerInstalled } from "./fin-d1.js";
import { validateBankEnvelope } from "./fin-upload.js";
import { ownerActivityStatement } from "./owner-activity.js";

export const OWNER_BANK_IMPORT_PATH_PREFIX = "/api/owner/bank-imports/";
export const OWNER_BANK_IMPORT_CAPABILITIES_PATH = `${OWNER_BANK_IMPORT_PATH_PREFIX}capabilities`;
export const OWNER_BANK_IMPORT_PREVIEW_PATH = `${OWNER_BANK_IMPORT_PATH_PREFIX}preview`;
export const OWNER_BANK_IMPORT_COMMIT_PATH = `${OWNER_BANK_IMPORT_PATH_PREFIX}commit`;

export const OWNER_BANK_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const OWNER_BANK_IMPORT_MAX_TRANSACTIONS = 70;
export const OWNER_BANK_IMPORT_MAX_ACCOUNTS = 4;
export const OWNER_BANK_IMPORT_PREVIEW_TTL_SECONDS = 15 * 60;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_KINDS = new Set([
  "checking", "savings", "card", "loan", "line_of_credit", "investment",
  "retirement", "merchant", "point_of_sale", "escrow", "other",
]);
const CSV_MAPPING_KEYS = new Set([
  "account_slug", "account_kind", "account_label", "institution", "currency",
]);
const MEDIA_BY_EXTENSION = Object.freeze({
  ".ofx": Object.freeze({ format: "ofx", mediaType: "application/x-ofx" }),
  ".qfx": Object.freeze({ format: "qfx", mediaType: "application/vnd.intu.qfx" }),
  ".csv": Object.freeze({ format: "csv", mediaType: "text/csv" }),
});
const ACCEPTED_MEDIA = new Set(Object.values(MEDIA_BY_EXTENSION).map((item) => item.mediaType));
const TABLES = Object.freeze(["owner_bank_import_previews", "owner_bank_import_commits"]);

export const OWNER_BANK_IMPORT_CAPABILITIES = Object.freeze({
  supported_media_types: Object.freeze([...ACCEPTED_MEDIA]),
  supported_extensions: Object.freeze(Object.keys(MEDIA_BY_EXTENSION)),
  media_type_extensions: Object.freeze({
    "application/x-ofx": Object.freeze([".ofx"]),
    "application/vnd.intu.qfx": Object.freeze([".qfx"]),
    "text/csv": Object.freeze([".csv"]),
  }),
  empty_media_type_supported: true,
  max_file_bytes: OWNER_BANK_IMPORT_MAX_BYTES,
  max_transactions_per_commit: OWNER_BANK_IMPORT_MAX_TRANSACTIONS,
  max_accounts_per_commit: OWNER_BANK_IMPORT_MAX_ACCOUNTS,
  preview_ttl_seconds: OWNER_BANK_IMPORT_PREVIEW_TTL_SECONDS,
  confirmation_required: true,
  raw_file_persisted: false,
  deletion_behavior: "Missing transactions are never treated as deletions.",
});

const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));
const invalid = (code, field) => respond({
  error: "invalid_request", code, ...(field ? { field } : {}),
}, 400);
const conflict = (code) => respond({ error: "conflict", code }, 409);
const unavailable = (code) => respond({ error: "unavailable", code }, 503);
const tooLarge = (code, extra = {}) => respond({ error: "too_large", code, ...extra }, 413);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const input = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(typeof value === "string" ? value : canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentIso(now) {
  const supplied = typeof now === "function" ? now() : now;
  const date = supplied instanceof Date ? supplied : new Date(supplied ?? Date.now());
  return Number.isFinite(date.valueOf()) ? date.toISOString() : new Date().toISOString();
}

function extensionOf(fileName) {
  const lower = fileName.toLowerCase();
  const cut = lower.lastIndexOf(".");
  return cut < 0 ? "" : lower.slice(cut);
}

function boundedLabel(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? undefined : null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if ((!normalized && required) || normalized.length > max) return undefined;
  return normalized || null;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0) {
    return { error: "invalid_bank_import_base64" };
  }
  if (value.length > Math.ceil(OWNER_BANK_IMPORT_MAX_BYTES / 3) * 4) {
    return { tooLarge: true };
  }
  // Avoid a large backtracking regular expression on an owner-supplied file.
  // A simple byte-class scan stays linear even at the eight MiB boundary.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index++) {
    const code = value.charCodeAt(index);
    const accepted = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!accepted) return { error: "invalid_bank_import_base64" };
  }
  for (let index = dataEnd; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return { error: "invalid_bank_import_base64" };
  }
  if ((padding === 1 && dataEnd % 4 !== 3) || (padding === 2 && dataEnd % 4 !== 2)) {
    return { error: "invalid_bank_import_base64" };
  }
  let raw;
  try { raw = atob(value); } catch { return { error: "invalid_bank_import_base64" }; }
  if (raw.length > OWNER_BANK_IMPORT_MAX_BYTES) return { tooLarge: true };
  if (!raw.length) return { error: "empty_bank_import" };
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return { bytes };
}

function normalizedMapping(format, value) {
  const mapping = value === undefined || value === null ? {} : value;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return { error: "invalid_bank_mapping" };
  }
  if (format !== "csv") {
    if (Object.keys(mapping).length) return { error: "bank_mapping_not_applicable" };
    return { mapping: {} };
  }
  if (Object.keys(mapping).some((key) => !CSV_MAPPING_KEYS.has(key))) {
    return { error: "invalid_bank_mapping" };
  }
  const accountSlug = typeof mapping.account_slug === "string" ? mapping.account_slug : "";
  const accountKind = typeof mapping.account_kind === "string" ? mapping.account_kind : "";
  const currency = typeof mapping.currency === "string" ? mapping.currency.toUpperCase() : "";
  const accountLabel = boundedLabel(mapping.account_label, 160);
  const institution = boundedLabel(mapping.institution, 160);
  if (!SLUG.test(accountSlug)) return { error: "invalid_bank_account_slug", field: "mapping.account_slug" };
  if (!ACCOUNT_KINDS.has(accountKind)) return { error: "invalid_bank_account_kind", field: "mapping.account_kind" };
  if (!CURRENCY.test(currency)) return { error: "invalid_bank_currency", field: "mapping.currency" };
  if (mapping.account_label !== undefined && accountLabel === undefined) {
    return { error: "invalid_bank_account_label", field: "mapping.account_label" };
  }
  if (mapping.institution !== undefined && institution === undefined) {
    return { error: "invalid_bank_institution", field: "mapping.institution" };
  }
  return {
    mapping: {
      account_slug: accountSlug,
      account_kind: accountKind,
      account_label: accountLabel,
      institution,
      currency,
    },
  };
}

function summaryOf(envelope) {
  let transactions = 0;
  let unread = 0;
  const accounts = envelope.accounts.map((account) => {
    const readable = account.transactions.filter((txn) => !txn.unparsedReason);
    const missing = account.transactions.length - readable.length;
    transactions += readable.length;
    unread += missing;
    const count = (direction) => readable.filter((txn) => txn.direction === direction).length;
    return {
      account_slug: account.accountKey,
      account_kind: account.accountKind,
      mask: account.mask || null,
      currency: account.currency,
      period_start: account.periodStart || null,
      period_end: account.periodEnd || null,
      transactions: readable.length,
      unread_lines: missing,
      inflows: count("inflow"),
      outflows: count("outflow"),
      direction_basis: account.directionBasis || "trusted",
    };
  });
  return {
    format: envelope.format,
    sign_convention: envelope.signConvention,
    established_by: envelope.establishedBy || null,
    accounts,
    transactions,
    unread_lines: unread,
  };
}

async function preparePayload(body) {
  const entitySlug = typeof body?.entity_slug === "string" ? body.entity_slug : "";
  if (!SLUG.test(entitySlug)) return { response: invalid("invalid_entity_slug", "entity_slug") };
  if (typeof body.file_name !== "string" || !body.file_name.trim() || body.file_name.length > 255 || /[\\/]/.test(body.file_name)) {
    return { response: invalid("invalid_bank_file_name", "file_name") };
  }
  const fileName = body.file_name.trim();
  const extension = extensionOf(fileName);
  const declaration = MEDIA_BY_EXTENSION[extension];
  if (!declaration) {
    return { response: respond({
      error: "unsupported_media", code: "unsupported_bank_export",
      supported_extensions: OWNER_BANK_IMPORT_CAPABILITIES.supported_extensions,
    }, 415) };
  }
  const declaredMedia = typeof body.media_type === "string" ? body.media_type.trim().toLowerCase() : "";
  if (declaredMedia && (!ACCEPTED_MEDIA.has(declaredMedia) || declaredMedia !== declaration.mediaType)) {
    return { response: respond({
      error: "unsupported_media", code: "bank_media_extension_mismatch",
      media_type: declaredMedia,
      expected_media_type: declaration.mediaType,
    }, 415) };
  }
  const mapped = normalizedMapping(declaration.format, body.mapping);
  if (mapped.error) return { response: invalid(mapped.error, mapped.field || "mapping") };
  const decoded = decodeBase64(body.content_base64);
  if (decoded.tooLarge) return {
    response: tooLarge("bank_import_file_too_large", { max_file_bytes: OWNER_BANK_IMPORT_MAX_BYTES }),
  };
  if (decoded.error) return { response: invalid(decoded.error, "content_base64") };
  const contentSha256 = await sha256(decoded.bytes);
  const sourceDocUid = `owner-bank:${entitySlug}:${contentSha256}`;
  let envelope;
  try {
    envelope = readBankExport(decoded.bytes, {
      name: fileName,
      format: declaration.format,
      currency: mapped.mapping.currency || "USD",
      sourceDocUid,
      accountHint: declaration.format === "csv" ? {
        accountKey: mapped.mapping.account_slug,
        accountKind: mapped.mapping.account_kind,
        institution: mapped.mapping.institution,
      } : null,
    });
  } catch {
    return { response: respond({
      error: "unprocessable", code: "bank_export_unreadable",
      reason: "This bank export could not be read. Nothing was imported.",
    }, 422) };
  }
  if (envelope.ok && declaration.format === "csv") {
    envelope = {
      ...envelope,
      accounts: envelope.accounts.map((account) => ({
        ...account,
        label: mapped.mapping.account_label,
      })),
    };
  }
  const checked = validateBankEnvelope(envelope);
  if (!checked.ok) {
    return { response: respond({
      error: "unprocessable", code: "bank_export_refused", reason: checked.error,
    }, 422) };
  }
  const totalTransactions = checked.envelope.accounts.reduce(
    (total, account) => total + account.transactions.length, 0,
  );
  if (checked.envelope.accounts.length > OWNER_BANK_IMPORT_MAX_ACCOUNTS ||
      totalTransactions > OWNER_BANK_IMPORT_MAX_TRANSACTIONS) {
    return {
      response: tooLarge("bank_import_atomic_limit", {
        accounts: checked.envelope.accounts.length,
        transactions: totalTransactions,
        max_accounts_per_commit: OWNER_BANK_IMPORT_MAX_ACCOUNTS,
        max_transactions_per_commit: OWNER_BANK_IMPORT_MAX_TRANSACTIONS,
        recovery: "Export a narrower date range. Overlapping imports are safe and do not imply deletions.",
      }),
    };
  }
  const previewBinding = {
    content_sha256: contentSha256,
    content_bytes: decoded.bytes.byteLength,
    entity_slug: entitySlug,
    file_name: fileName,
    media_type: declaration.mediaType,
    format: declaration.format,
    mapping: mapped.mapping,
  };
  return {
    entitySlug,
    fileName,
    mediaType: declaration.mediaType,
    format: declaration.format,
    mapping: mapped.mapping,
    bytes: decoded.bytes,
    contentSha256,
    sourceDocUid,
    previewHash: await sha256(previewBinding),
    envelope: checked.envelope,
    summary: summaryOf(checked.envelope),
  };
}

async function importStorageReady(env) {
  if (!env?.DB || typeof env.DB.batch !== "function") return false;
  const ledger = await ledgerInstalled(env);
  if (!ledger.installed) return false;
  const placeholders = TABLES.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
  ).bind(...TABLES).all();
  return new Set(result?.results?.map((row) => row.name) || []).size === TABLES.length;
}

async function accountScopeConflict(env, entitySlug, envelope) {
  for (const account of envelope.accounts) {
    const row = await env.DB.prepare(
      `SELECT entity_slug FROM fin_accounts
        WHERE tenant_id=? AND account_slug=? AND superseded_by_id IS NULL`,
    ).bind(DEFAULT_TENANT, account.accountKey).first();
    if (row && row.entity_slug !== entitySlug) return true;
  }
  return false;
}

function planStatements(env, plan) {
  return plan.statements.map(([sql, binds]) => env.DB.prepare(sql).bind(...binds));
}

function actionReceiptStatement(env, { requestId, requestHash, response, status, at }) {
  return env.DB.prepare(
    `INSERT INTO owner_action_requests
       (tenant_id,request_id,action_type,request_hash,response_json,response_status,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    DEFAULT_TENANT, requestId, "bank_import", requestHash,
    JSON.stringify(response), status, at,
  );
}

async function replayFor(env, requestId, requestHash) {
  const row = await env.DB.prepare(
    `SELECT action_type,request_hash,response_json
       FROM owner_action_requests WHERE tenant_id=? AND request_id=?`,
  ).bind(DEFAULT_TENANT, requestId).first();
  if (!row) return null;
  if (row.action_type !== "bank_import" || row.request_hash !== requestHash) {
    return conflict("request_id_conflict");
  }
  try { return respond({ ...JSON.parse(row.response_json), replayed: true }, 200); }
  catch { return unavailable("owner_bank_import_receipt_unavailable"); }
}

async function alreadyImported(env, sourceDocUid, transactionUids) {
  const result = await env.DB.prepare(
    `SELECT txn_uid FROM fin_transactions
      WHERE tenant_id=? AND source_doc_uid=? AND superseded_by_id IS NULL`,
  ).bind(DEFAULT_TENANT, sourceDocUid).all();
  const stored = (result?.results || []).map((row) => row.txn_uid).sort();
  const expected = [...transactionUids].sort();
  return stored.length === expected.length && expected.length > 0 &&
    stored.every((value, index) => value === expected[index]);
}

async function preview(env, body, options) {
  const prepared = await preparePayload(body);
  if (prepared.response) return prepared.response;
  const scope = await options.validateEntity(env, prepared.entitySlug);
  if (!scope.ok) return scope.response;
  if (scope.entity.status !== "active") return conflict("bank_import_entity_inactive");
  try {
    if (!(await importStorageReady(env))) return unavailable("owner_bank_import_unavailable");
    if (await accountScopeConflict(env, prepared.entitySlug, prepared.envelope)) {
      return conflict("bank_account_entity_conflict");
    }
  } catch {
    return unavailable("owner_bank_import_unavailable");
  }
  const at = currentIso(options.now);
  const expiresAt = new Date(new Date(at).valueOf() + OWNER_BANK_IMPORT_PREVIEW_TTL_SECONDS * 1000).toISOString();
  const previewId = `bank_preview_${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(
      `INSERT INTO owner_bank_import_previews
         (preview_id,tenant_id,preview_hash,content_sha256,content_bytes,entity_slug,
          source_doc_uid,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      previewId, DEFAULT_TENANT, prepared.previewHash, prepared.contentSha256,
      prepared.bytes.byteLength, prepared.entitySlug, prepared.sourceDocUid, at, expiresAt,
    ).run();
  } catch {
    return unavailable("owner_bank_import_preview_unavailable");
  }
  return respond({
    previewed: true,
    preview_id: previewId,
    expires_at: expiresAt,
    entity_scope: { entity_slug: prepared.entitySlug },
    file: {
      file_name: prepared.fileName,
      media_type: prepared.mediaType,
      format: prepared.format,
      content_bytes: prepared.bytes.byteLength,
      sha256: prepared.contentSha256,
    },
    mapping: prepared.mapping,
    summary: prepared.summary,
    confirmation: {
      required: true,
      commit_path: OWNER_BANK_IMPORT_COMMIT_PATH,
      exact_bytes_required: true,
    },
    mutated: false,
  });
}

async function commit(env, body, options) {
  const requestId = typeof body?.request_id === "string" && REQUEST_ID.test(body.request_id)
    ? body.request_id
    : null;
  if (!requestId) return invalid("invalid_request_id", "request_id");
  if (body.confirmed !== true) return invalid("bank_import_confirmation_required", "confirmed");
  const previewId = typeof body.preview_id === "string" &&
    /^bank_preview_[A-Za-z0-9_-]{1,166}$/.test(body.preview_id)
    ? body.preview_id
    : null;
  if (!previewId) return invalid("invalid_bank_preview_id", "preview_id");
  const prepared = await preparePayload(body);
  if (prepared.response) return prepared.response;
  const requestHash = await sha256({
    action: "bank_import", request_id: requestId, preview_id: previewId,
    preview_hash: prepared.previewHash, confirmed: true,
  });
  try {
    if (!(await importStorageReady(env))) return unavailable("owner_bank_import_unavailable");
    const replay = await replayFor(env, requestId, requestHash);
    if (replay) return replay;
  } catch {
    return unavailable("owner_bank_import_receipt_unavailable");
  }
  const scope = await options.validateEntity(env, prepared.entitySlug);
  if (!scope.ok) return scope.response;
  if (scope.entity.status !== "active") return conflict("bank_import_entity_inactive");

  let intent;
  try {
    intent = await env.DB.prepare(
      `SELECT p.preview_hash,p.content_sha256,p.content_bytes,p.entity_slug,p.source_doc_uid,
              p.expires_at,c.request_id AS consumed_request_id
         FROM owner_bank_import_previews p
         LEFT JOIN owner_bank_import_commits c
           ON c.tenant_id=p.tenant_id AND c.preview_id=p.preview_id
        WHERE p.tenant_id=? AND p.preview_id=?`,
    ).bind(DEFAULT_TENANT, previewId).first();
  } catch {
    return unavailable("owner_bank_import_preview_unavailable");
  }
  if (!intent) return respond({ error: "not_found", code: "bank_import_preview_not_found" }, 404);
  if (intent.consumed_request_id) {
    return intent.consumed_request_id === requestId
      ? unavailable("owner_bank_import_receipt_unavailable")
      : conflict("bank_import_preview_consumed");
  }
  if (intent.expires_at <= currentIso(options.now)) return conflict("bank_import_preview_expired");
  if (intent.preview_hash !== prepared.previewHash ||
      intent.content_sha256 !== prepared.contentSha256 ||
      Number(intent.content_bytes) !== prepared.bytes.byteLength ||
      intent.entity_slug !== prepared.entitySlug ||
      intent.source_doc_uid !== prepared.sourceDocUid) {
    return conflict("bank_import_preview_mismatch");
  }
  try {
    if (await accountScopeConflict(env, prepared.entitySlug, prepared.envelope)) {
      return conflict("bank_account_entity_conflict");
    }
  } catch {
    return unavailable("owner_bank_import_unavailable");
  }

  const at = currentIso(options.now);
  const plan = prepareBankExportImport(prepared.envelope, {
    tenantId: DEFAULT_TENANT,
    entitySlug: prepared.entitySlug,
    entityLabel: scope.entity.label,
    now: at,
    origin: { provenance: "extracted", sourceDocUid: prepared.sourceDocUid },
  });
  let changed;
  try { changed = !(await alreadyImported(env, prepared.sourceDocUid, plan.transactionUids)); }
  catch { return unavailable("owner_bank_import_unavailable"); }
  const eventId = changed ? `evt_bank_import_completed_${requestId}` : null;
  const importReceipt = {
    source_doc_uid: prepared.sourceDocUid,
    file_sha256: prepared.contentSha256,
    format: prepared.format,
    sign_convention: plan.receipt.sign_convention,
    established_by: plan.receipt.established_by,
    accounts: plan.receipt.accounts,
    statements: plan.receipt.statements,
    transactions: plan.receipt.transactions,
    unread_lines: plan.receipt.unread_lines,
    balance_snapshots: plan.receipt.balance_snapshots,
  };
  const response = {
    imported: true,
    request_id: requestId,
    preview_id: previewId,
    entity_scope: { entity_slug: prepared.entitySlug },
    changed,
    import: importReceipt,
    activity_event_id: eventId,
    replayed: false,
  };
  const status = changed ? 201 : 200;
  const statements = [
    env.DB.prepare(
      `INSERT INTO owner_bank_import_commits (tenant_id,preview_id,request_id,committed_at)
       VALUES (?,?,?,?)`,
    ).bind(DEFAULT_TENANT, previewId, requestId, at),
    ...(changed ? planStatements(env, plan) : []),
    ...(changed ? [ownerActivityStatement(env, {
      eventId,
      eventType: "bank_import_completed",
      entitySlug: prepared.entitySlug,
      subjectKind: "bank_export",
      subjectId: prepared.sourceDocUid,
      // The owner reviewed the filename in the transient preview response.
      // The durable activity stream needs only the action, not another copy of
      // a potentially identifying filename.
      displayLabel: "Imported bank export",
      occurredAt: at,
      requestId,
    })] : []),
    actionReceiptStatement(env, { requestId, requestHash, response, status, at }),
  ];
  if (statements.length > 90) {
    return tooLarge("bank_import_atomic_limit", {
      max_transactions_per_commit: OWNER_BANK_IMPORT_MAX_TRANSACTIONS,
    });
  }
  try {
    await env.DB.batch(statements);
  } catch {
    try {
      const replay = await replayFor(env, requestId, requestHash);
      if (replay) return replay;
      const consumed = await env.DB.prepare(
        `SELECT request_id FROM owner_bank_import_commits WHERE tenant_id=? AND preview_id=?`,
      ).bind(DEFAULT_TENANT, previewId).first();
      if (consumed?.request_id && consumed.request_id !== requestId) {
        return conflict("bank_import_preview_consumed");
      }
    } catch {}
    return unavailable("owner_bank_import_commit_unavailable");
  }
  if (typeof options.afterCommit === "function") {
    try { await options.afterCommit({ requestId, previewId, response }); }
    catch { return unavailable("owner_bank_import_finalize_unavailable"); }
  }
  return respond(response, status);
}

export async function handleOwnerBankImport(env, body, path, options = {}) {
  if (path === OWNER_BANK_IMPORT_CAPABILITIES_PATH) return respond(OWNER_BANK_IMPORT_CAPABILITIES);
  if (typeof options.validateEntity !== "function") return unavailable("owner_bank_import_unavailable");
  if (path === OWNER_BANK_IMPORT_PREVIEW_PATH) return preview(env, body, options);
  if (path === OWNER_BANK_IMPORT_COMMIT_PATH) return commit(env, body, options);
  return respond({ error: "not found" }, 404);
}
