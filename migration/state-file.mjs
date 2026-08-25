/**
 * Durable owner-only state files for one-time migrations.
 *
 * These checkpoints can contain source identifiers and, for pending message
 * sessions, source text. Atomic rename alone is not enough: a link can redirect
 * the write, a hard link can create an undeclared copy, and a power loss can
 * lose an acknowledged cursor unless both the file and directory are synced.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";

export const MAX_MIGRATION_STATE_BYTES = 64 * 1024 * 1024;

const isWindows = process.platform === "win32";
const currentUid = () => typeof process.getuid === "function" ? process.getuid() : null;

const sameIdentity = (a, b) => Boolean(a && b) &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
  a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  a.nlink === b.nlink;

function assertProtectedDirectory(path, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`${label} parent directory is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} parent must be a real directory`);
  }
  if (!isWindows) {
    if (stat.uid !== currentUid()) throw new Error(`${label} parent is not owned by the current user`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} parent is writable by another user`);
  }
}

function assertProtectedFileStat(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link`);
  }
  if (stat.nlink !== 1) throw new Error(`${label} must not have hard links`);
  if (!isWindows) {
    if (stat.uid !== currentUid()) throw new Error(`${label} is not owned by the current user`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad`);
  }
}

export function protectedStatePreviousPath(path) {
  const absolute = resolve(path);
  const extension = extname(absolute);
  return extension
    ? `${absolute.slice(0, -extension.length)}.previous${extension}`
    : `${absolute}.previous`;
}

export function readProtectedStateText(path, {
  label = "migration checkpoint",
  maxBytes = MAX_MIGRATION_STATE_BYTES,
  allowMissing = false,
} = {}) {
  const absolute = resolve(path);
  assertProtectedDirectory(dirname(absolute), label);
  let before;
  try { before = lstatSync(absolute); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw new Error(`${label} is unavailable`);
  }
  assertProtectedFileStat(before, label);
  if (before.size > maxBytes) throw new Error(`${label} exceeds its size limit`);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    assertProtectedFileStat(opened, label);
    if (!sameIdentity(before, opened)) throw new Error(`${label} changed while it was opened`);
    const text = readFileSync(fd, "utf8");
    const afterRead = fstatSync(fd);
    if (!sameIdentity(opened, afterRead)) throw new Error(`${label} changed while it was read`);
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} exceeds its size limit`);
    const named = lstatSync(absolute);
    if (!sameIdentity(afterRead, named)) throw new Error(`${label} path changed while it was read`);
    return text;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readProtectedStateJson(path, options = {}) {
  const text = readProtectedStateText(path, options);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`${options.label || "migration checkpoint"} is not valid JSON`); }
}

function durableTemp(path, text, label) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const verified = readProtectedStateText(temp, { label });
    if (verified !== text) throw new Error(`${label} temporary write did not read back exactly`);
    return temp;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* exact temporary path may not exist */ }
    throw error;
  }
}

function syncDirectory(path) {
  if (isWindows) return;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function saveProtectedStateJson(path, state, {
  label = "migration checkpoint",
  maxBytes = MAX_MIGRATION_STATE_BYTES,
} = {}) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const previous = protectedStatePreviousPath(absolute);
  assertProtectedDirectory(parent, label);

  const text = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} exceeds its size limit`);

  const current = readProtectedStateText(absolute, { label, maxBytes, allowMissing: true });
  if (current !== null) {
    try { JSON.parse(current); }
    catch { throw new Error(`${label} is not valid JSON; refusing to replace it`); }
  }
  // An unsafe previous-good path is not overwritten. A backup that can be
  // redirected is worse than having no backup because recovery would trust it.
  readProtectedStateText(previous, {
    label: `${label} previous-good copy`, maxBytes, allowMissing: true,
  });

  let previousTemp = null;
  let nextTemp = null;
  try {
    if (current !== null) {
      previousTemp = durableTemp(previous, current, `${label} previous-good copy`);
      renameSync(previousTemp, previous);
      previousTemp = null;
      syncDirectory(parent);
    }
    nextTemp = durableTemp(absolute, text, label);
    renameSync(nextTemp, absolute);
    nextTemp = null;
    syncDirectory(parent);
    const verified = readProtectedStateText(absolute, { label, maxBytes });
    if (verified !== text) throw new Error(`${label} replacement did not read back exactly`);
  } finally {
    for (const temp of [previousTemp, nextTemp]) {
      if (!temp) continue;
      try { unlinkSync(temp); } catch { /* exact temporary path may not exist */ }
    }
  }
}
