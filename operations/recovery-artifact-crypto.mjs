/**
 * Encrypted custody for the SQL artifact used by verified recovery.
 *
 * The artifact can contain the complete corpus. The durable file is therefore
 * AES-256-GCM ciphertext. A short-lived plaintext is allowed only inside the
 * reviewed owner-only directory while a callback owns it. Stale plaintext
 * residue is a hard stop on the next run rather than something deleted without
 * review.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAGIC = Buffer.from("FBRREC1\n", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const PLAINTEXT_PREFIX = ".brain-recovery-plaintext.tmp-";
const CIPHERTEXT_PREFIX = ".brain-recovery-encrypted.tmp-";
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = FS_CONSTANTS;

export const RECOVERY_ARTIFACT_KEY_PREFIX = "v1.";
export const RECOVERY_ARTIFACT_FORMAT_VERSION = 1;

function refuse(message) {
  const error = new Error(message);
  error.code = "RECOVERY_ARTIFACT_CRYPTO_REFUSED";
  throw error;
}

export function validateRecoveryArtifactKey(value) {
  if (typeof value !== "string" || !/^v1\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("the recovery artifact key must be a version-1 32-byte base64url key");
  }
  const decoded = Buffer.from(value.slice(RECOVERY_ARTIFACT_KEY_PREFIX.length), "base64url");
  if (decoded.length !== 32) throw new TypeError("the recovery artifact key must decode to 32 bytes");
  return value;
}

export function generateRecoveryArtifactKey(randomBytesImpl = randomBytes) {
  const value = randomBytesImpl(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError("the recovery-key random source must return exactly 32 bytes");
  }
  return validateRecoveryArtifactKey(`${RECOVERY_ARTIFACT_KEY_PREFIX}${value.toString("base64url")}`);
}

function keyBytes(value, salt) {
  const checked = validateRecoveryArtifactKey(value);
  const input = Buffer.from(checked.slice(RECOVERY_ARTIFACT_KEY_PREFIX.length), "base64url");
  const derived = hkdfSync(
    "sha256",
    input,
    salt,
    Buffer.from("financial-brain-recovery-artifact-v1", "utf8"),
    32,
  );
  input.fill(0);
  return Buffer.from(derived);
}

function assertPrivateDirectory(directory) {
  const absolute = resolve(directory);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse("the recovery artifact directory is unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    refuse("the recovery artifact directory is not owned by the current user");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    refuse("the recovery artifact directory must be owner-only");
  }
  return absolute;
}

function assertNewDestination(path, directory) {
  const absolute = resolve(path);
  if (dirname(absolute) !== directory) refuse("the recovery artifact destination must stay in its private directory");
  try {
    lstatSync(absolute);
    refuse("the recovery artifact destination already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return absolute;
}

function stableRegularFile(path) {
  const absolute = resolve(path);
  const fd = openSync(absolute, O_RDONLY | O_NOFOLLOW);
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) {
    closeSync(fd);
    refuse("the recovery artifact source is unsafe");
  }
  return { absolute, fd, info };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function temporaryPath(directory, prefix, randomBytesImpl = randomBytes) {
  return join(directory, `${prefix}${randomBytesImpl(12).toString("hex")}`);
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

async function writeAtomically(destination, directory, prefix, chunks, randomBytesImpl) {
  const temporary = temporaryPath(directory, prefix, randomBytesImpl);
  const fd = openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  closeSync(fd);
  assertNewDestination(destination, directory);
  renameSync(temporary, destination);
  syncDirectory(directory);
  return destination;
}

export function recoveryPlaintextResidues(directory) {
  const privateDirectory = assertPrivateDirectory(directory);
  return readdirSync(privateDirectory)
    .filter((name) => name.startsWith(PLAINTEXT_PREFIX))
    .sort();
}

export function assertNoRecoveryPlaintextResidue(directory) {
  const residues = recoveryPlaintextResidues(directory);
  if (residues.length) {
    refuse("a prior recovery plaintext residue requires manual review before continuing");
  }
}

export function recoveryArtifactResidues(directory) {
  const privateDirectory = assertPrivateDirectory(directory);
  return readdirSync(privateDirectory)
    .filter((name) => name.startsWith(PLAINTEXT_PREFIX) || name.startsWith(CIPHERTEXT_PREFIX))
    .sort();
}

export function assertNoRecoveryArtifactResidue(directory) {
  if (recoveryArtifactResidues(directory).length) {
    refuse("a prior recovery encryption residue requires manual review before continuing");
  }
}

export async function encryptRecoveryArtifact(sourcePath, destinationPath, key, {
  randomBytesImpl = randomBytes,
} = {}) {
  const directory = assertPrivateDirectory(dirname(resolve(destinationPath)));
  const destination = assertNewDestination(destinationPath, directory);
  const source = stableRegularFile(sourcePath);
  const salt = randomBytesImpl(SALT_BYTES);
  const iv = randomBytesImpl(IV_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES ||
      !Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    closeSync(source.fd);
    throw new TypeError("the recovery artifact random source returned invalid bytes");
  }
  const derived = keyBytes(key, salt);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  derived.fill(0);

  async function* chunks() {
    yield Buffer.concat([MAGIC, salt, iv]);
    for await (const chunk of createReadStream(source.absolute, {
      fd: source.fd,
      autoClose: false,
      start: 0,
      end: source.info.size - 1,
    })) {
      yield cipher.update(chunk);
    }
    yield cipher.final();
    yield cipher.getAuthTag();
  }

  try {
    await writeAtomically(destination, directory, CIPHERTEXT_PREFIX, chunks(), randomBytesImpl);
    if (!sameFile(source.info, fstatSync(source.fd))) refuse("the recovery artifact source changed during encryption");
    return destination;
  } finally {
    closeSync(source.fd);
  }
}

export async function decryptRecoveryArtifact(sourcePath, destinationPath, key, {
  randomBytesImpl = randomBytes,
} = {}) {
  const directory = assertPrivateDirectory(dirname(resolve(destinationPath)));
  const destination = assertNewDestination(destinationPath, directory);
  const source = stableRegularFile(sourcePath);
  if (source.info.size < HEADER_BYTES + TAG_BYTES) {
    closeSync(source.fd);
    refuse("the encrypted recovery artifact is truncated");
  }
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  readSync(source.fd, header, 0, header.length, 0);
  readSync(source.fd, tag, 0, tag.length, source.info.size - TAG_BYTES);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    closeSync(source.fd);
    refuse("the encrypted recovery artifact format is unsupported");
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const derived = keyBytes(key, salt);
  const decipher = createDecipheriv("aes-256-gcm", derived, iv);
  derived.fill(0);
  decipher.setAuthTag(tag);

  async function* chunks() {
    const first = HEADER_BYTES;
    const last = source.info.size - TAG_BYTES - 1;
    for await (const chunk of createReadStream(source.absolute, {
      fd: source.fd,
      autoClose: false,
      start: first,
      end: last,
    })) {
      yield decipher.update(chunk);
    }
    yield decipher.final();
  }

  try {
    await writeAtomically(destination, directory, PLAINTEXT_PREFIX, chunks(), randomBytesImpl);
    if (!sameFile(source.info, fstatSync(source.fd))) refuse("the encrypted recovery artifact changed during decryption");
    return destination;
  } catch {
    try { unlinkSync(destination); } catch { /* destination normally does not exist */ }
    refuse("the encrypted recovery artifact could not be authenticated");
  } finally {
    closeSync(source.fd);
  }
}

export async function withDecryptedRecoveryArtifact(sourcePath, directory, key, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("a recovery artifact callback is required");
  const privateDirectory = assertPrivateDirectory(directory);
  assertNoRecoveryArtifactResidue(privateDirectory);
  const plaintext = temporaryPath(privateDirectory, PLAINTEXT_PREFIX, options.randomBytesImpl);
  await decryptRecoveryArtifact(sourcePath, plaintext, key, options);
  try {
    return await callback(plaintext);
  } finally {
    try { unlinkSync(plaintext); } catch { /* a missing reviewed temporary is already clean */ }
  }
}

export const RECOVERY_ARTIFACT_PLAINTEXT_PREFIX = PLAINTEXT_PREFIX;
