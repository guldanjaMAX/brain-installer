import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const OFF_PROVIDER_BACKUP_FORMAT = "brain-off-provider-backup-v1";
export const BACKUP_RPO_HOURS = 24;
export const BACKUP_RTO_HOURS = 8;
export const RESTORE_DRILL_INTERVAL_DAYS = 90;
export const RETENTION_CLASSES = Object.freeze({
  daily: Object.freeze({ cadence_hours: 24, copies: 14 }),
  weekly: Object.freeze({ cadence_hours: 168, copies: 8 }),
  monthly: Object.freeze({ cadence_hours: 24 * 28, copies: 12 }),
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function exactKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("backup encryption key must be exactly 32 bytes and supplied out of band");
  }
  return Buffer.from(key);
}

function exactTime(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date;
}

function aadFor(metadata) {
  return Buffer.from(JSON.stringify({
    format: metadata.format,
    algorithm: metadata.algorithm,
    created_at: metadata.created_at,
    retention_class: metadata.retention_class,
    plaintext_sha256: metadata.plaintext_sha256,
  }));
}

/** Encrypt one already-verified recovery artifact for independent storage. */
export function encryptOffProviderBackup(plaintext, {
  key,
  createdAt = new Date(),
  retentionClass = "daily",
  randomBytesImpl = randomBytes,
} = {}) {
  const source = Buffer.from(plaintext || []);
  if (!source.length) throw new Error("backup plaintext must not be empty");
  if (!RETENTION_CLASSES[retentionClass]) throw new Error("backup retention class is invalid");
  const created = exactTime(createdAt, "backup creation time").toISOString();
  const iv = Buffer.from(randomBytesImpl(12));
  if (iv.byteLength !== 12) throw new Error("backup IV generator must return 12 bytes");
  const metadata = {
    format: OFF_PROVIDER_BACKUP_FORMAT,
    algorithm: "AES-256-GCM",
    created_at: created,
    retention_class: retentionClass,
    plaintext_sha256: sha256(source),
  };
  const cipher = createCipheriv("aes-256-gcm", exactKey(key), iv);
  cipher.setAAD(aadFor(metadata));
  const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
  const envelope = {
    ...metadata,
    iv_base64: iv.toString("base64"),
    auth_tag_base64: cipher.getAuthTag().toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(envelope)}\n`);
}

/** Authenticate, decrypt, and hash-verify one portable backup envelope. */
export function decryptOffProviderBackup(artifact, { key } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(artifact || []).toString("utf8"));
  } catch {
    throw new Error("backup artifact is not a valid encrypted envelope");
  }
  if (envelope?.format !== OFF_PROVIDER_BACKUP_FORMAT || envelope?.algorithm !== "AES-256-GCM" ||
      !RETENTION_CLASSES[envelope?.retention_class] ||
      !/^[a-f0-9]{64}$/.test(String(envelope?.plaintext_sha256 || ""))) {
    throw new Error("backup artifact metadata is invalid");
  }
  const metadata = {
    format: envelope.format,
    algorithm: envelope.algorithm,
    created_at: exactTime(envelope.created_at, "backup creation time").toISOString(),
    retention_class: envelope.retention_class,
    plaintext_sha256: envelope.plaintext_sha256,
  };
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm", exactKey(key), Buffer.from(envelope.iv_base64, "base64"),
    );
    decipher.setAAD(aadFor(metadata));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag_base64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext_base64, "base64")),
      decipher.final(),
    ]);
    if (sha256(plaintext) !== metadata.plaintext_sha256) {
      throw new Error("backup plaintext hash does not match the envelope");
    }
    return { plaintext, metadata };
  } catch (error) {
    if (/plaintext hash/.test(error?.message || "")) throw error;
    throw new Error("backup authentication failed");
  }
}

function safeCounts(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be aggregate counts`);
  }
  const out = {};
  for (const [key, count] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${name} contains an invalid aggregate`);
    }
    out[key] = count;
  }
  return out;
}

/** Build content-free evidence for one isolated restore drill. */
export function buildRestoreEvidence({
  artifactMetadata,
  startedAt,
  completedAt,
  sourceCounts,
  restoredCounts,
  restoredSha256,
  schemaVersion,
  evaluationPassed,
} = {}) {
  const started = exactTime(startedAt, "restore start time");
  const completed = exactTime(completedAt, "restore completion time");
  const durationMs = completed.getTime() - started.getTime();
  if (durationMs < 0) throw new Error("restore completion precedes its start");
  const source = safeCounts(sourceCounts, "source counts");
  const restored = safeCounts(restoredCounts, "restored counts");
  if (JSON.stringify(source) !== JSON.stringify(restored)) {
    throw new Error("restored aggregate counts do not match the source artifact");
  }
  if (restoredSha256 !== artifactMetadata?.plaintext_sha256) {
    throw new Error("restored durable-data hash does not match the source artifact");
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || evaluationPassed !== true) {
    throw new Error("restore schema and evaluation proof are required");
  }
  const artifactCreated = exactTime(artifactMetadata.created_at, "artifact creation time");
  const rpoHours = (started.getTime() - artifactCreated.getTime()) / 3600000;
  const rtoHours = durationMs / 3600000;
  return {
    format: "brain-restore-evidence-v1",
    status: rpoHours <= BACKUP_RPO_HOURS && rtoHours <= BACKUP_RTO_HOURS ? "passed" : "objective_missed",
    completed_at: completed.toISOString(),
    artifact_created_at: artifactCreated.toISOString(),
    artifact_sha256: artifactMetadata.plaintext_sha256,
    retention_class: artifactMetadata.retention_class,
    schema_version: schemaVersion,
    aggregate_counts: restored,
    evaluation_passed: true,
    rpo_hours: Number(rpoHours.toFixed(3)),
    rto_hours: Number(rtoHours.toFixed(3)),
    objectives: { rpo_hours: BACKUP_RPO_HOURS, rto_hours: BACKUP_RTO_HOURS },
    privacy: "Hashes, timings, schema version, and aggregate counts only.",
  };
}

/** Decide whether recurring restore evidence is current without reading data. */
export function restoreEvidenceStatus(evidence, { now = new Date() } = {}) {
  const current = exactTime(now, "current time");
  if (!evidence || evidence.format !== "brain-restore-evidence-v1" || evidence.status !== "passed") {
    return { current: false, due: true, reason: "no_passing_restore_evidence" };
  }
  const completed = exactTime(evidence.completed_at, "restore evidence completion time");
  const ageDays = Math.max(0, (current.getTime() - completed.getTime()) / 86400000);
  return {
    current: ageDays <= RESTORE_DRILL_INTERVAL_DAYS,
    due: ageDays > RESTORE_DRILL_INTERVAL_DAYS,
    reason: ageDays > RESTORE_DRILL_INTERVAL_DAYS ? "restore_drill_due" : null,
    age_days: Number(ageDays.toFixed(1)),
    next_due_at: new Date(completed.getTime() + RESTORE_DRILL_INTERVAL_DAYS * 86400000).toISOString(),
  };
}
