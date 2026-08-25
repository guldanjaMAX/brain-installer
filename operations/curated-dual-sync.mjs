/**
 * Fail-closed sync for a small, authoritative Markdown collection.
 *
 * This operation exists for legacy brains that still need their established
 * write path while a Cloudflare Brain is proved in parallel. The private plan
 * is an exact inventory, not a folder hint: credentials and network access are
 * unreachable until enumeration matches that inventory and its role counts.
 * Both targets then receive content built once from the same bytes. A failure
 * at either target stays retryable and never suppresses the other target.
 *
 * The coverage ledger deliberately contains only salted logical fingerprints,
 * content hashes, roles, bounded status enums, and aggregate counts. It cannot
 * become another copy of filenames, source IDs, URLs, content, or credentials.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminKeyPersistencePlan,
  readAdminKeyDurably,
} from "./admin-key-persistence.mjs";

export const CURATED_SYNC_PLAN_VERSION = 1;
export const CURATED_SYNC_LEDGER_VERSION = 2;
export const CURATED_SYNC_ROLES = Object.freeze([
  "authoritative",
  "superseded",
  "plain",
]);

const ROLE_SET = new Set(CURATED_SYNC_ROLES);
const RECEIPT_ACTIONS = new Set(["created", "updated", "unchanged"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const TARGET_NAMES = Object.freeze(["legacy", "cloudflare"]);
const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1_000_000;
const TARGET_TIMEOUT_MS = 180_000;
const PATH_CONTROL = /[\u0000-\u001f\u007f]/;
const SOURCE_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATUS_VALUES = new Set([
  "not_attempted",
  "confirmed",
  "credential_unavailable",
  "network_error",
  "http_error",
  "invalid_receipt",
  "oversized",
]);
const RAW_DRIVE_STATUS_VALUES = new Set([
  "not_configured",
  "state_unmapped",
  "not_verified",
  "not_present",
  "presence_unverified",
  "checksum_mismatch",
  "checksum_confirmed_duplicate",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function safeRelativePath(value, label) {
  const text = String(value ?? "");
  if (
    !text || isAbsolute(text) || text.includes("\\") || PATH_CONTROL.test(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} must be a normalized relative path`);
  }
  if (!MARKDOWN_EXTENSIONS.has(extname(text).toLowerCase())) {
    fail(`${label} must identify a Markdown document`);
  }
  return text;
}

function safeInstancePath(value, label) {
  const text = String(value ?? "");
  if (!text || PATH_CONTROL.test(text)) fail(`${label} must be a path`);
  return text;
}

function safeSourceIdentity(document, index) {
  const sourceType = String(document.legacy_source_type ?? "").trim().toLowerCase();
  const sourceId = String(document.legacy_source_id ?? "");
  if (!SOURCE_TYPE_RE.test(sourceType)) {
    fail(`documents[${index}].legacy_source_type is invalid`);
  }
  if (!sourceId || sourceId.length > 2048 || PATH_CONTROL.test(sourceId)) {
    fail(`documents[${index}].legacy_source_id is invalid`);
  }
  return { sourceType, sourceId };
}

function checkedMetadata(value, label) {
  if (value === undefined) return {};
  plainObject(value, label);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${label} must be JSON serializable`);
  }
  if (encoded === undefined || encoded.length > 256 * 1024) {
    fail(`${label} is too large`);
  }
  return structuredClone(value);
}

function targetPlan(value, label) {
  const target = plainObject(value, label);
  return Object.freeze({
    manifest: safeInstancePath(target.manifest, `${label}.manifest`),
  });
}

/** Validate a private plan without touching its corpus, credentials, or targets. */
export function validateCuratedSyncPlan(input) {
  const plan = plainObject(input, "curated sync plan");
  if (plan.schema_version !== CURATED_SYNC_PLAN_VERSION) {
    fail(`curated sync plan schema_version must be ${CURATED_SYNC_PLAN_VERSION}`);
  }
  const root = safeInstancePath(plan.root, "root");
  const expectedDocuments = positiveInteger(plan.expected_documents, "expected_documents");
  const namespace = String(plan.ledger_namespace ?? "");
  if (namespace.length < 16 || namespace.length > 1024 || PATH_CONTROL.test(namespace)) {
    fail("ledger_namespace must be 16 to 1024 printable characters");
  }

  const expectedRolesInput = plainObject(plan.expected_roles, "expected_roles");
  const expectedRoles = {};
  for (const role of CURATED_SYNC_ROLES) {
    const count = expectedRolesInput[role];
    if (!Number.isInteger(count) || count < 0) {
      fail(`expected_roles.${role} must be a non-negative integer`);
    }
    expectedRoles[role] = count;
  }
  if (Object.values(expectedRoles).reduce((sum, value) => sum + value, 0) !== expectedDocuments) {
    fail("expected role counts must add up to expected_documents");
  }

  if (!Array.isArray(plan.documents) || plan.documents.length !== expectedDocuments) {
    fail("documents must contain exactly expected_documents entries");
  }
  const paths = new Set();
  const identities = new Set();
  const actualRoles = Object.fromEntries(CURATED_SYNC_ROLES.map((role) => [role, 0]));
  const documents = plan.documents.map((value, index) => {
    const document = plainObject(value, `documents[${index}]`);
    const relativePath = safeRelativePath(document.relative_path, `documents[${index}].relative_path`);
    if (paths.has(relativePath)) fail("documents contains a duplicate relative path");
    paths.add(relativePath);
    const role = String(document.role ?? "");
    if (!ROLE_SET.has(role)) fail(`documents[${index}].role is invalid`);
    actualRoles[role]++;
    const { sourceType, sourceId } = safeSourceIdentity(document, index);
    const identity = `${sourceType}\0${sourceId}`;
    if (identities.has(identity)) fail("documents contains a duplicate legacy identity");
    identities.add(identity);
    const title = document.title === undefined ? null : String(document.title);
    if (title !== null && (!title.trim() || title.length > 500 || PATH_CONTROL.test(title))) {
      fail(`documents[${index}].title is invalid`);
    }
    const reason = document.superseded_reason === undefined
      ? ""
      : String(document.superseded_reason);
    if (reason.length > 16_384 || PATH_CONTROL.test(reason)) {
      fail(`documents[${index}].superseded_reason is invalid`);
    }
    return Object.freeze({
      relativePath,
      role,
      sourceType,
      sourceId,
      title,
      supersededReason: reason,
      metadata: checkedMetadata(document.metadata, `documents[${index}].metadata`),
    });
  });
  for (const role of CURATED_SYNC_ROLES) {
    if (actualRoles[role] !== expectedRoles[role]) {
      fail("document role counts do not match expected_roles");
    }
  }

  const transformsInput = plainObject(plan.transforms, "transforms");
  const transforms = {};
  for (const role of CURATED_SYNC_ROLES) {
    const transform = plainObject(transformsInput[role], `transforms.${role}`);
    const contentPrefix = String(transform.content_prefix ?? "");
    const titlePrefix = String(transform.title_prefix ?? "");
    if (contentPrefix.length > 256 * 1024 || titlePrefix.length > 500) {
      fail(`transforms.${role} is too large`);
    }
    transforms[role] = Object.freeze({ contentPrefix, titlePrefix });
  }

  const excluded = plan.exclude_directories ?? [];
  if (!Array.isArray(excluded) || excluded.some((name) =>
    typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || PATH_CONTROL.test(name))) {
    fail("exclude_directories must contain plain directory names");
  }

  let rawDrive = null;
  if (plan.raw_drive !== undefined && plan.raw_drive !== null) {
    const raw = plainObject(plan.raw_drive, "raw_drive");
    const pathPrefix = String(raw.path_prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (PATH_CONTROL.test(pathPrefix) || pathPrefix.split("/").some((part) => part === "." || part === "..")) {
      fail("raw_drive.path_prefix is invalid");
    }
    rawDrive = Object.freeze({
      stateFile: safeInstancePath(raw.state_file, "raw_drive.state_file"),
      pathPrefix,
      match: raw.match === undefined ? "path" : String(raw.match),
      requireStateMatch: raw.require_state_match !== false,
    });
    if (!new Set(["path", "basename"]).has(rawDrive.match)) {
      fail("raw_drive.match must be path or basename");
    }
    if (rawDrive.match === "basename") {
      const basenames = documents.map((document) => basename(document.relativePath));
      if (new Set(basenames).size !== basenames.length) {
        fail("raw_drive basename matching requires unique planned filenames");
      }
    }
  }

  return Object.freeze({
    schemaVersion: CURATED_SYNC_PLAN_VERSION,
    root,
    expectedDocuments,
    expectedRoles: Object.freeze(expectedRoles),
    namespace,
    documents: Object.freeze(documents),
    transforms: Object.freeze(transforms),
    excludedDirectories: Object.freeze([...new Set(excluded)]),
    commonMetadata: checkedMetadata(plan.common_metadata, "common_metadata"),
    legacyTarget: targetPlan(plan.legacy_target, "legacy_target"),
    cloudflareTarget: targetPlan(plan.cloudflare_target, "cloudflare_target"),
    rawDrive,
    ledgerFile: safeInstancePath(
      plan.ledger_file ?? ".brain-curated-sync-ledger.json",
      "ledger_file",
    ),
  });
}

function assertPrivatePlanFile(path, options = {}) {
  const platform = options.platform ?? process.platform;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("curated sync plan must be a regular file");
  if (platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      fail("curated sync plan must be owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) fail("curated sync plan must use owner-only mode 0600");
  }
  if (info.size < 2 || info.size > MAX_PLAN_BYTES) fail("curated sync plan has an invalid size");
}

/** Read a private sidecar plan without ever echoing its path or contents. */
export function loadCuratedSyncPlan(planPath, options = {}) {
  const absolute = resolve(planPath);
  try {
    assertPrivatePlanFile(absolute, options);
    return {
      plan: validateCuratedSyncPlan(JSON.parse(readFileSync(absolute, "utf8"))),
      planDirectory: dirname(absolute),
    };
  } catch (error) {
    if (error?.message?.startsWith("curated sync plan") ||
        error?.message?.startsWith("documents") ||
        error?.message?.startsWith("expected") ||
        error?.message?.startsWith("root") ||
        error?.message?.startsWith("ledger_") ||
        error?.message?.startsWith("raw_drive") ||
        error?.message?.startsWith("exclude_") ||
        error?.message?.startsWith("transforms") ||
        error?.message?.startsWith("legacy_target") ||
        error?.message?.startsWith("cloudflare_target") ||
        error?.message?.startsWith("common_metadata")) {
      throw error;
    }
    fail("curated sync plan could not be read and validated");
  }
}

function resolveFromPlan(planDirectory, value) {
  return isAbsolute(value) ? resolve(value) : resolve(planDirectory, value);
}

function enumerateMarkdown(root, excludedDirectories) {
  const found = [];
  const excluded = new Set(excludedDirectories);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("curated corpus root must be a real directory");
  }

  const visit = (directory, prefix = "") => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail("curated corpus enumeration could not read a directory");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (PATH_CONTROL.test(entry.name)) fail("curated corpus contains an unsafe path name");
      if (entry.isSymbolicLink()) fail("curated corpus contains a symbolic link");
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(absolute, relativePath);
      } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(relativePath);
      }
    }
  };
  visit(root);
  return found.sort();
}

function localDate(value) {
  const date = new Date(value);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameStableFile(left, right) {
  // File Provider may legitimately update ctime while hydrating bytes for a
  // read, even though inode, size, and source mtime stay fixed. The latter are
  // the source-revision identity; including ctime makes healthy cloud files
  // fail the stability gate merely because they were opened.
  return ["dev", "ino", "size", "mtimeNs"].every((field) =>
    left?.[field] !== undefined && left[field] === right?.[field]);
}

function assertRegularOwner(info, options = {}) {
  if (!info?.isFile?.()) fail("curated corpus inventory contains a nonregular file");
  const platform = options.platform ?? process.platform;
  const currentUid = options.currentUid ?? (
    typeof process.getuid === "function" ? process.getuid() : null
  );
  if (platform !== "win32" && currentUid !== null && BigInt(info.uid) !== BigInt(currentUid)) {
    fail("curated corpus document is not owned by the current user");
  }
}

/**
 * Read one stable source revision through a no-follow descriptor.
 *
 * Cloud-sync clients commonly replace a file while updating it. Path-based
 * lstat followed by readFile can therefore validate one inode and read another.
 * Opening first with O_NOFOLLOW, comparing descriptor metadata before and after
 * the read, and proving the path still names that descriptor closes that
 * window. The returned MD5 is over the exact bytes read, before UTF-8 decoding.
 */
export function readStableRegularSource(path, options = {}) {
  const openSource = options.openSource ?? openSync;
  const fstatSource = options.fstatSource ?? fstatSync;
  const readSource = options.readSource ?? readFileSync;
  const lstatSource = options.lstatSource ?? lstatSync;
  const closeSource = options.closeSource ?? closeSync;
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let descriptor;
  let bytes;
  try {
    descriptor = openSource(path, flags);
    const before = fstatSource(descriptor, { bigint: true });
    assertRegularOwner(before, options);
    bytes = readSource(descriptor);
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    const after = fstatSource(descriptor, { bigint: true });
    assertRegularOwner(after, options);
    let pathAfter;
    try {
      pathAfter = lstatSource(path, { bigint: true });
    } catch {
      fail("curated corpus document changed while being read");
    }
    assertRegularOwner(pathAfter, options);
    if (
      pathAfter.isSymbolicLink?.() || !sameStableFile(before, after) ||
      !sameStableFile(after, pathAfter) || BigInt(bytes.length) !== after.size
    ) {
      fail("curated corpus document changed while being read");
    }
    return Object.freeze({
      body: bytes.toString("utf8"),
      rawMd5: createHash("md5").update(bytes).digest("hex"),
      stats: after,
    });
  } catch (error) {
    if (error?.message?.startsWith("curated corpus")) throw error;
    fail("curated corpus document could not be read through a stable descriptor");
  } finally {
    if (descriptor !== undefined) {
      try { closeSource(descriptor); } catch { /* the read result is already bounded */ }
    }
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function markdownTitle(relativePath, body) {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return trimmed.replace(/^#+/, "").trim().slice(0, 200);
  }
  return basename(relativePath).replace(/\.(?:md|markdown)$/i, "").slice(0, 200);
}

function renderString(template, context, label) {
  const rendered = String(template)
    .replaceAll("{{modified_date}}", context.modifiedDate)
    .replaceAll("{{superseded_reason}}", context.supersededReason)
    .replaceAll("{{relative_path}}", context.relativePath)
    .replaceAll("{{content_sha256}}", context.contentHash)
    .replaceAll("{{content_sha256_16}}", context.contentHash.slice(0, 16));
  if (/{{[^{}]+}}/.test(rendered)) fail(`${label} contains an unknown template token`);
  return rendered;
}

function renderMetadata(value, context) {
  if (typeof value === "string") return renderString(value, context, "metadata");
  if (Array.isArray(value)) return value.map((item) => renderMetadata(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderMetadata(item, context)]));
  }
  return value;
}

function planSetMismatch(found, planned) {
  const foundSet = new Set(found);
  const plannedSet = new Set(planned);
  let missing = 0;
  let unexpected = 0;
  for (const path of plannedSet) if (!foundSet.has(path)) missing++;
  for (const path of foundSet) if (!plannedSet.has(path)) unexpected++;
  return { missing, unexpected };
}

/**
 * Enumerate, compare the exact inventory, then build target-neutral envelopes.
 * This is the sole function allowed to read source content. It finishes before
 * callers may resolve credentials, which is the fail-closed scheduler gate.
 */
export function prepareCuratedCorpus(planInput, options = {}) {
  const planDirectory = options.planDirectory ?? process.cwd();
  const plan = planInput?.schemaVersion === CURATED_SYNC_PLAN_VERSION
    ? planInput
    : validateCuratedSyncPlan(planInput);
  const root = resolveFromPlan(planDirectory, plan.root);
  let found;
  try {
    found = enumerateMarkdown(root, plan.excludedDirectories);
  } catch (error) {
    if (error?.message?.startsWith("curated corpus")) throw error;
    fail("curated corpus root could not be enumerated");
  }
  if (!found.length) {
    fail(`curated corpus enumeration found zero Markdown documents; expected ${plan.expectedDocuments}`);
  }
  if (found.length !== plan.expectedDocuments) {
    fail(`curated corpus enumeration found ${found.length} Markdown documents; expected ${plan.expectedDocuments}`);
  }
  const mismatch = planSetMismatch(found, plan.documents.map((document) => document.relativePath));
  if (mismatch.missing || mismatch.unexpected) {
    fail(`curated corpus inventory mismatch: ${mismatch.missing} missing and ${mismatch.unexpected} unexpected`);
  }

  const documents = plan.documents.map((document) => {
    const absolute = resolve(root, ...document.relativePath.split("/"));
    if (relative(root, absolute).startsWith("..")) fail("curated corpus inventory escaped its root");
    const snapshotReader = options.readStableSource ?? readStableRegularSource;
    const snapshot = snapshotReader(absolute, options);
    const body = snapshot.body;
    const modifiedDate = localDate(Number(snapshot.stats.mtimeMs));
    const transform = plan.transforms[document.role];
    const prefixContext = {
      modifiedDate,
      supersededReason: document.supersededReason,
      relativePath: document.relativePath,
      contentHash: "",
    };
    const contentPrefix = renderString(transform.contentPrefix, prefixContext, "content transform");
    const content = `${contentPrefix}${body}`;
    const contentHash = sha256(content);
    const context = { ...prefixContext, contentHash };
    const baseTitle = document.title || markdownTitle(document.relativePath, body);
    const title = `${renderString(transform.titlePrefix, context, "title transform")}${baseTitle}`.slice(0, 500);
    const metadata = renderMetadata({ ...plan.commonMetadata, ...document.metadata }, context);
    const logicalFingerprint = sha256(
      `curated-sync-logical-v1\0${plan.namespace}\0${document.sourceType}\0${document.sourceId}`,
    );
    const legacyEnvelope = {
      source_type: document.sourceType,
      source_id: document.sourceId,
      title,
      content,
      metadata,
    };
    const cloudflareEnvelope = {
      ...legacyEnvelope,
      source_type: "curated",
      source_id: `brain:${document.sourceType}:${document.sourceId}`,
    };
    return Object.freeze({
      relativePath: document.relativePath,
      role: document.role,
      contentHash,
      rawMd5: snapshot.rawMd5,
      logicalFingerprint,
      legacyEnvelope: Object.freeze(legacyEnvelope),
      cloudflareEnvelope: Object.freeze(cloudflareEnvelope),
    });
  });

  // A folder update can add or replace another planned file while this loop is
  // reading. Re-enumeration proves the collection boundary stayed exact for the
  // duration of the snapshot rather than trusting only the initial walk.
  const after = enumerateMarkdown(root, plan.excludedDirectories);
  const afterMismatch = planSetMismatch(after, found);
  if (after.length !== found.length || afterMismatch.missing || afterMismatch.unexpected) {
    fail("curated corpus inventory changed while the snapshot was being built");
  }

  documents.sort((left, right) => left.logicalFingerprint.localeCompare(right.logicalFingerprint));
  return Object.freeze({ plan, planDirectory, root, documents: Object.freeze(documents) });
}

function privateStateData(prepared) {
  if (!prepared.plan.rawDrive) return null;
  const path = resolveFromPlan(prepared.planDirectory, prepared.plan.rawDrive.stateFile);
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("raw Drive state could not be read and validated");
  }
  if (!state?.done || typeof state.done !== "object" || Array.isArray(state.done)) {
    fail("raw Drive state does not contain a completed-document map");
  }
  return state.done;
}

function driveFamiliesByLogicalDocument(prepared) {
  const done = privateStateData(prepared);
  if (!done) return new Map();
  const byMatch = new Map();
  const prefix = prepared.plan.rawDrive.pathPrefix;
  for (const [family, encoded] of Object.entries(done)) {
    if (!family.startsWith("drive:") || typeof encoded !== "string") continue;
    let version;
    try { version = JSON.parse(encoded); } catch { continue; }
    const path = Array.isArray(version) && typeof version[4] === "string"
      ? version[4].replace(/^\/+|\/+$/g, "")
      : "";
    if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    const name = Array.isArray(version) && typeof version[2] === "string" ? version[2] : "";
    const key = prepared.plan.rawDrive.match === "basename"
      ? name
      : (path ? `${path}/${name}` : name);
    if (!key) continue;
    if (!byMatch.has(key)) byMatch.set(key, []);
    const signal = Array.isArray(version) ? String(version[1] ?? "") : "";
    byMatch.get(key).push({
      family,
      driveMd5: /^[0-9a-f]{32}$/i.test(signal) ? signal.toLowerCase() : null,
    });
  }
  const mapped = new Map();
  let missing = 0;
  for (const document of prepared.documents) {
    const key = prepared.plan.rawDrive.match === "basename"
      ? basename(document.relativePath)
      : (prefix ? `${prefix}/${document.relativePath}` : document.relativePath);
    const candidates = byMatch.get(key) || [];
    if (!candidates.length) missing++;
    const unique = [...new Map(candidates.map((candidate) => [candidate.family, candidate])).values()]
      .sort((left, right) => left.family.localeCompare(right.family));
    mapped.set(document.logicalFingerprint, unique);
  }
  if (missing && prepared.plan.rawDrive.requireStateMatch) {
    fail(`raw Drive state is missing ${missing} curated inventory matches`);
  }
  return mapped;
}

async function defaultResolveTarget(target, planDirectory, options = {}) {
  const manifestPath = resolveFromPlan(planDirectory, target.manifest);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("target manifest could not be read and validated");
  }
  const domain = String(manifest?.brain?.domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || !domain.includes(".")) {
    fail("target manifest brain.domain is invalid");
  }
  const persistence = adminKeyPersistencePlan(manifestPath, manifest, options);
  const adminKey = readAdminKeyDurably(persistence, options);
  if (!adminKey) fail("target durable admin key is unavailable");
  return { baseUrl: `https://${domain}`, adminKey };
}

function blankTargetStatuses(prepared) {
  return new Map(prepared.documents.map((document) => [document.logicalFingerprint, "not_attempted"]));
}

function setAll(statuses, value) {
  for (const key of statuses.keys()) statuses.set(key, value);
}

async function parseJsonResponse(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

async function postOneTarget(name, prepared, options = {}) {
  const statuses = blankTargetStatuses(prepared);
  const actions = { created: 0, updated: 0, unchanged: 0 };
  const target = name === "legacy" ? prepared.plan.legacyTarget : prepared.plan.cloudflareTarget;
  const resolveTarget = options.resolveTarget ?? defaultResolveTarget;
  let resolved;
  try {
    resolved = await resolveTarget(target, prepared.planDirectory, options, name);
    if (!resolved?.baseUrl || !resolved?.adminKey) throw new Error("invalid target resolution");
  } catch {
    setAll(statuses, "credential_unavailable");
    return { statuses, actions };
  }

  const request = options.fetch ?? globalThis.fetch;
  for (const document of prepared.documents) {
    const envelope = name === "legacy" ? document.legacyEnvelope : document.cloudflareEnvelope;
    if (Buffer.byteLength(envelope.content, "utf8") > MAX_DOCUMENT_BYTES) {
      statuses.set(document.logicalFingerprint, "oversized");
      continue;
    }
    let response;
    try {
      response = await request(`${resolved.baseUrl}/api/admin/brain/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": resolved.adminKey,
        },
        body: JSON.stringify(envelope),
        signal: options.abortSignal?.() ?? AbortSignal.timeout(options.targetTimeoutMs ?? TARGET_TIMEOUT_MS),
      });
    } catch {
      statuses.set(document.logicalFingerprint, "network_error");
      continue;
    }
    let body;
    try {
      body = await parseJsonResponse(response);
    } catch {
      statuses.set(document.logicalFingerprint, "network_error");
      continue;
    }
    if (!response.ok) {
      statuses.set(document.logicalFingerprint, "http_error");
      continue;
    }
    const action = String(body?.action ?? "");
    const identityValid = name === "legacy"
      ? Boolean(body?.brain_doc_id)
      : body?.doc_uid === `curated:${document.cloudflareEnvelope.source_id}`;
    if (!identityValid || !RECEIPT_ACTIONS.has(action)) {
      statuses.set(document.logicalFingerprint, "invalid_receipt");
      continue;
    }
    statuses.set(document.logicalFingerprint, "confirmed");
    actions[action]++;
  }
  return { statuses, actions };
}

async function postOneTargetSafely(name, prepared, options) {
  try {
    return await postOneTarget(name, prepared, options);
  } catch {
    // A malformed response object or another target-local exception is still a
    // retryable target failure. Collapsing it to a bounded status preserves the
    // other write and prevents raw response details from reaching the ledger.
    const statuses = blankTargetStatuses(prepared);
    setAll(statuses, "network_error");
    return { statuses, actions: { created: 0, updated: 0, unchanged: 0 } };
  }
}

async function listCloudflareDriveFamilies(prepared, options = {}) {
  const resolveTarget = options.resolveTarget ?? defaultResolveTarget;
  let resolved;
  try {
    resolved = await resolveTarget(
      prepared.plan.cloudflareTarget,
      prepared.planDirectory,
      options,
      "cloudflare",
    );
    if (!resolved?.baseUrl || !resolved?.adminKey) throw new Error("invalid target resolution");
  } catch {
    return { ok: false, families: new Set() };
  }
  const families = new Set();
  const request = options.fetch ?? globalThis.fetch;
  let cursor = "";
  for (let page = 0; page < 10_000; page++) {
    const query = new URLSearchParams({ source: "drive", limit: "1000" });
    if (cursor) query.set("cursor", cursor);
    let response;
    try {
      response = await request(`${resolved.baseUrl}/api/admin/brain/source-families?${query}`, {
        headers: { "X-Admin-Key": resolved.adminKey },
        signal: options.abortSignal?.() ?? AbortSignal.timeout(options.targetTimeoutMs ?? TARGET_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, families: new Set() };
    }
    let body;
    try {
      body = await parseJsonResponse(response);
    } catch {
      return { ok: false, families: new Set() };
    }
    if (!response.ok || body?.source !== "drive" || !Array.isArray(body?.families)) {
      return { ok: false, families: new Set() };
    }
    for (const family of body.families) {
      if (typeof family !== "string" || !family.startsWith("drive:")) {
        return { ok: false, families: new Set() };
      }
      families.add(family);
    }
    if (!body.next_cursor) return { ok: true, families };
    if (typeof body.next_cursor !== "string" || body.next_cursor === cursor) {
      return { ok: false, families: new Set() };
    }
    cursor = body.next_cursor;
  }
  return { ok: false, families: new Set() };
}

function rawDriveStatuses(prepared, mapped, live) {
  const statuses = new Map();
  for (const document of prepared.documents) {
    const candidates = mapped.get(document.logicalFingerprint) || [];
    let status = "not_configured";
    if (prepared.plan.rawDrive) {
      if (!candidates.length) status = "state_unmapped";
      else if (!live.ok) status = "not_verified";
      else {
        const present = candidates.filter((candidate) => live.families.has(candidate.family));
        if (!present.length) status = "not_present";
        else if (present.some((candidate) => candidate.driveMd5 === document.rawMd5)) {
          status = "checksum_confirmed_duplicate";
        } else if (present.some((candidate) => candidate.driveMd5 === null)) {
          // driveVersion falls back to size when Drive provides no MD5. Same
          // path and size are presence evidence, never byte-equality evidence.
          status = "presence_unverified";
        } else {
          status = "checksum_mismatch";
        }
      }
    }
    statuses.set(document.logicalFingerprint, status);
  }
  return statuses;
}

function aggregateByRole(prepared, statuses, wanted) {
  const out = Object.fromEntries(CURATED_SYNC_ROLES.map((role) => [role, 0]));
  let total = 0;
  for (const document of prepared.documents) {
    if (statuses.get(document.logicalFingerprint) === wanted) {
      out[document.role]++;
      total++;
    }
  }
  return { total, ...out };
}

/** Build stable, private-safe ledger data from bounded observations. */
export function buildCuratedCoverageLedger(prepared, observations = {}) {
  const legacy = observations.legacy ?? blankTargetStatuses(prepared);
  const cloudflare = observations.cloudflare ?? blankTargetStatuses(prepared);
  const rawDrive = observations.rawDrive ?? new Map(
    prepared.documents.map((document) => [document.logicalFingerprint, "not_configured"]),
  );
  const documents = prepared.documents.map((document) => {
    const legacyStatus = legacy.get(document.logicalFingerprint) ?? "not_attempted";
    const cloudflareStatus = cloudflare.get(document.logicalFingerprint) ?? "not_attempted";
    const rawDriveStatus = rawDrive.get(document.logicalFingerprint) ?? "not_configured";
    if (!STATUS_VALUES.has(legacyStatus) || !STATUS_VALUES.has(cloudflareStatus)) {
      fail("target observation contains an invalid status");
    }
    if (!RAW_DRIVE_STATUS_VALUES.has(rawDriveStatus)) {
      fail("raw Drive observation contains an invalid status");
    }
    return {
      logical_fingerprint: document.logicalFingerprint,
      content_sha256: document.contentHash,
      role: document.role,
      targets: { cloudflare: cloudflareStatus, legacy: legacyStatus },
      raw_drive: rawDriveStatus,
    };
  });
  documents.sort((left, right) => left.logical_fingerprint.localeCompare(right.logical_fingerprint));
  const corpusFingerprint = sha256(canonical(documents.map((document) => ({
    content_sha256: document.content_sha256,
    logical_fingerprint: document.logical_fingerprint,
    role: document.role,
  }))));
  return {
    schema_version: CURATED_SYNC_LEDGER_VERSION,
    corpus_fingerprint: corpusFingerprint,
    documents_expected: prepared.plan.expectedDocuments,
    roles: { ...prepared.plan.expectedRoles },
    target_coverage: {
      cloudflare_confirmed: aggregateByRole(prepared, cloudflare, "confirmed"),
      legacy_confirmed: aggregateByRole(prepared, legacy, "confirmed"),
    },
    raw_drive_checksum_duplicates: aggregateByRole(
      prepared,
      rawDrive,
      "checksum_confirmed_duplicate",
    ),
    raw_drive_presence_unverified: aggregateByRole(prepared, rawDrive, "presence_unverified"),
    raw_drive_checksum_mismatches: aggregateByRole(prepared, rawDrive, "checksum_mismatch"),
    documents,
  };
}

function assertLedgerDestination(path, options = {}) {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail("coverage ledger destination is not a safe regular file");
  }
  if ((options.platform ?? process.platform) !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      fail("coverage ledger destination is not owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) fail("coverage ledger destination is not owner-only");
  }
}

/** Atomically replace the private ledger with canonical, owner-only bytes. */
export function writeCuratedCoverageLedger(path, ledger, options = {}) {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertLedgerDestination(absolute, options);
  const bytes = Buffer.from(`${canonical(ledger)}\n`, "utf8");
  const suffix = (options.randomBytes ?? randomBytes)(8).toString("hex");
  const temporary = `${absolute}.tmp-${suffix}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
    const readback = readFileSync(absolute);
    if (!readback.equals(bytes)) fail("coverage ledger did not read back exactly");
    const info = statSync(absolute);
    if ((options.platform ?? process.platform) !== "win32" && (info.mode & 0o077) !== 0) {
      fail("coverage ledger did not retain owner-only permissions");
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
    if (error?.message?.startsWith("coverage ledger")) throw error;
    fail("coverage ledger could not be replaced safely");
  } finally {
    bytes.fill(0);
  }
  return { bytes: readFileSync(absolute), path: absolute };
}

/**
 * Run one of three explicit modes:
 *   dry-run: exact local inventory and hashes only, no credential or network;
 *   audit:   read-only Cloudflare duplicate inventory, no ingest writes;
 *   sync:    independent legacy and Cloudflare writes plus duplicate audit.
 */
export async function runCuratedDualSync(planInput, options = {}) {
  const mode = String(options.mode ?? "");
  if (!new Set(["dry-run", "audit", "sync"]).has(mode)) {
    fail("curated sync mode must be dry-run, audit, or sync");
  }
  const prepared = prepareCuratedCorpus(planInput, {
    ...options,
    planDirectory: options.planDirectory ?? process.cwd(),
  });

  let mapped = new Map();
  if (prepared.plan.rawDrive) mapped = driveFamiliesByLogicalDocument(prepared);
  let live = { ok: false, families: new Set() };
  if (mode !== "dry-run" && prepared.plan.rawDrive) {
    live = await listCloudflareDriveFamilies(prepared, options);
  }
  const rawDrive = rawDriveStatuses(prepared, mapped, live);

  let legacyResult = { statuses: blankTargetStatuses(prepared), actions: {} };
  let cloudflareResult = { statuses: blankTargetStatuses(prepared), actions: {} };
  if (mode === "sync") {
    // Target-level parallelism is intentional. An unavailable legacy endpoint
    // must not prevent Cloudflare from converging, and the reverse is equally
    // important while legacy retrieval remains the rollback path.
    [legacyResult, cloudflareResult] = await Promise.all([
      postOneTargetSafely("legacy", prepared, options),
      postOneTargetSafely("cloudflare", prepared, options),
    ]);
  }

  const ledger = buildCuratedCoverageLedger(prepared, {
    legacy: legacyResult.statuses,
    cloudflare: cloudflareResult.statuses,
    rawDrive,
  });
  const ledgerPath = resolveFromPlan(prepared.planDirectory, prepared.plan.ledgerFile);
  const writer = options.writeLedger ?? writeCuratedCoverageLedger;
  writer(ledgerPath, ledger, options);

  const allConfirmed = (statuses) => [...statuses.values()].every((value) => value === "confirmed");
  const auditComplete = !prepared.plan.rawDrive || live.ok || mode === "dry-run";
  const ok = mode === "sync"
    ? allConfirmed(legacyResult.statuses) && allConfirmed(cloudflareResult.statuses) && auditComplete
    : auditComplete;
  return {
    ok,
    mode,
    count: prepared.documents.length,
    roles: { ...prepared.plan.expectedRoles },
    corpusFingerprint: ledger.corpus_fingerprint,
    rawDriveChecksumDuplicates: ledger.raw_drive_checksum_duplicates,
    rawDrivePresenceUnverified: ledger.raw_drive_presence_unverified,
    rawDriveChecksumMismatches: ledger.raw_drive_checksum_mismatches,
    targetCoverage: ledger.target_coverage,
    actions: {
      legacy: legacyResult.actions,
      cloudflare: cloudflareResult.actions,
    },
    ledger,
  };
}

function usage() {
  return [
    "Usage:",
    "  node operations/curated-dual-sync.mjs --plan <private-plan.json> --dry-run",
    "  node operations/curated-dual-sync.mjs --plan <private-plan.json> --audit",
    "  node operations/curated-dual-sync.mjs --plan <private-plan.json> --sync",
    "",
    "The plan must be owner-only mode 0600. Audit never writes remotely.",
  ].join("\n");
}

function cliArguments(argv) {
  let planPath = null;
  let mode = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--plan" && index + 1 < argv.length) {
      planPath = argv[++index];
    } else if (["--dry-run", "--audit", "--sync"].includes(arg)) {
      if (mode) fail("choose exactly one curated sync mode");
      mode = arg.slice(2);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      fail("curated sync arguments are invalid");
    }
  }
  if (!planPath || !mode) fail("a private plan and one explicit mode are required");
  return { help: false, planPath, mode };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = cliArguments(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const { plan, planDirectory } = loadCuratedSyncPlan(args.planPath);
    const report = await runCuratedDualSync(plan, { mode: args.mode, planDirectory });
    console.log(
      `curated ${report.mode}: ${report.count} documents; ` +
      `${report.roles.authoritative} authoritative, ${report.roles.superseded} superseded, ` +
      `${report.roles.plain} plain`,
    );
    console.log(
      `checksum-confirmed raw Drive duplicates: ${report.rawDriveChecksumDuplicates.total}; ` +
      `unverified presence: ${report.rawDrivePresenceUnverified.total}; ` +
      `checksum mismatches: ${report.rawDriveChecksumMismatches.total}; ` +
      `coverage ledger ${report.ok ? "updated" : "updated with incomplete receipts"}`,
    );
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`curated sync stopped: ${String(error?.message || "unknown failure")}`);
    return 1;
  }
}

let isDirect = false;
try {
  // realpath matters on macOS where /tmp and /private/tmp name the same file.
  // A lexical URL comparison makes the packed operation silently do nothing.
  isDirect = Boolean(process.argv[1]) &&
    realpathSync.native(resolve(process.argv[1])) ===
      realpathSync.native(fileURLToPath(import.meta.url));
} catch { /* imported as a module, or argv no longer names an existing file */ }
if (isDirect) process.exitCode = await main();
