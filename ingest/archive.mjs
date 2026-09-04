/**
 * Streaming ZIP extraction with one shared safety budget.
 *
 * ZIP metadata is advisory, so every declared bound is checked again against
 * bytes actually emitted by the inflater. Selected entries are collected;
 * unselected entries are still streamed and counted so a hidden image, nested
 * package, or unknown file cannot carry an unobserved expansion bomb.
 */

import { Unzip, UnzipInflate } from "fflate";

export const ZIP_LIMITS = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxFiles: 4_096,
  maxNesting: 1,
  maxPathDepth: 32,
  maxCompressionRatio: 200,
  inputChunkBytes: 4 * 1024,
});

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function archiveLimits(overrides = {}) {
  return Object.freeze({
    maxCompressedBytes: boundedInteger(overrides.maxCompressedBytes, ZIP_LIMITS.maxCompressedBytes),
    maxExpandedBytes: boundedInteger(overrides.maxExpandedBytes, ZIP_LIMITS.maxExpandedBytes),
    maxEntryBytes: boundedInteger(overrides.maxEntryBytes, ZIP_LIMITS.maxEntryBytes),
    maxFiles: boundedInteger(overrides.maxFiles, ZIP_LIMITS.maxFiles),
    maxNesting: boundedInteger(overrides.maxNesting, ZIP_LIMITS.maxNesting),
    maxPathDepth: boundedInteger(overrides.maxPathDepth, ZIP_LIMITS.maxPathDepth),
    maxCompressionRatio: boundedInteger(overrides.maxCompressionRatio, ZIP_LIMITS.maxCompressionRatio),
    inputChunkBytes: boundedInteger(overrides.inputChunkBytes, ZIP_LIMITS.inputChunkBytes, { max: 64 * 1024 }),
  });
}

export class ArchiveSafetyError extends Error {
  constructor(message, { code, limit = null, actual = null, entry = null } = {}) {
    super(message);
    this.name = "ArchiveSafetyError";
    this.code = code;
    this.limit = limit;
    this.actual = actual;
    this.entry = entry;
  }
}

function fail(label, message, options) {
  return new ArchiveSafetyError(`${label}: ${message}`, options);
}

function safeEntryName(value, label) {
  const name = String(value || "");
  if (!name || name.includes("\0")) {
    throw fail(label, "the archive contains an invalid entry name", { code: "invalid_entry_name" });
  }
  const normalized = name.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || segments.includes("..")) {
    throw fail(label, "the archive contains a path outside its own root", {
      code: "unsafe_entry_path", entry: name.slice(0, 160),
    });
  }
  return { name: normalized, depth: segments.length };
}

function joinChunks(chunks, size) {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Extract selected ZIP entries while streaming every entry through the same
 * compressed, expanded, count, depth, and ratio budget.
 */
export function extractZipEntries(buffer, {
  select = () => true,
  limits: overrides = {},
  nesting = 1,
  label = "ZIP archive",
} = {}) {
  const limits = archiveLimits(overrides);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw fail(label, `compressed input exceeds ${limits.maxCompressedBytes} bytes`, {
      code: "compressed_bytes", limit: limits.maxCompressedBytes, actual: bytes.byteLength,
    });
  }
  if (!bytes.byteLength) throw fail(label, "the archive is empty", { code: "invalid_archive", actual: 0 });
  if (!Number.isInteger(nesting) || nesting < 1 || nesting > limits.maxNesting) {
    throw fail(label, `archive nesting exceeds ${limits.maxNesting}`, {
      code: "nesting", limit: limits.maxNesting, actual: nesting,
    });
  }

  const selected = new Map();
  const states = [];
  let failure = null;
  let fileCount = 0;
  let expandedBytes = 0;
  const ratioLimit = Math.min(
    limits.maxExpandedBytes,
    Math.max(1, bytes.byteLength) * limits.maxCompressionRatio,
  );

  const reject = (error) => {
    if (!failure) failure = error;
  };

  const unzip = new Unzip((file) => {
    if (failure) return;
    fileCount++;
    if (fileCount > limits.maxFiles) {
      reject(fail(label, `archive entry count exceeds ${limits.maxFiles}`, {
        code: "file_count", limit: limits.maxFiles, actual: fileCount,
      }));
      return;
    }

    let entry;
    try { entry = safeEntryName(file.name, label); }
    catch (error) { reject(error); return; }
    if (entry.depth > limits.maxPathDepth) {
      reject(fail(label, `archive path depth exceeds ${limits.maxPathDepth}`, {
        code: "path_depth", limit: limits.maxPathDepth, actual: entry.depth, entry: entry.name.slice(0, 160),
      }));
      return;
    }
    if (Number.isFinite(file.originalSize) && file.originalSize > limits.maxEntryBytes) {
      reject(fail(label, `an entry exceeds ${limits.maxEntryBytes} expanded bytes`, {
        code: "entry_bytes", limit: limits.maxEntryBytes, actual: file.originalSize, entry: entry.name.slice(0, 160),
      }));
      return;
    }
    if (Number.isFinite(file.originalSize) && expandedBytes + file.originalSize > limits.maxExpandedBytes) {
      reject(fail(label, `expanded content exceeds ${limits.maxExpandedBytes} bytes`, {
        code: "expanded_bytes", limit: limits.maxExpandedBytes,
        actual: expandedBytes + file.originalSize,
      }));
      return;
    }
    if (Number.isFinite(file.originalSize) && expandedBytes + file.originalSize > ratioLimit) {
      reject(fail(label, `expanded content exceeds the ${limits.maxCompressionRatio}:1 compression-ratio limit`, {
        code: "compression_ratio", limit: limits.maxCompressionRatio,
        actual: (expandedBytes + file.originalSize) / Math.max(1, bytes.byteLength),
      }));
      return;
    }

    const keep = Boolean(select(entry.name, {
      compressedSize: Number.isFinite(file.size) ? file.size : null,
      originalSize: Number.isFinite(file.originalSize) ? file.originalSize : null,
      compression: file.compression,
    }));
    const state = { name: entry.name, keep, chunks: [], size: 0, final: false };
    states.push(state);
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        reject(fail(label, "an archive entry could not be expanded", {
          code: "invalid_archive", entry: entry.name.slice(0, 160),
        }));
        return;
      }
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk || []);
      state.size += data.byteLength;
      expandedBytes += data.byteLength;
      if (state.size > limits.maxEntryBytes) {
        reject(fail(label, `an entry exceeds ${limits.maxEntryBytes} expanded bytes`, {
          code: "entry_bytes", limit: limits.maxEntryBytes, actual: state.size, entry: entry.name.slice(0, 160),
        }));
        file.terminate?.();
        return;
      }
      if (expandedBytes > limits.maxExpandedBytes) {
        reject(fail(label, `expanded content exceeds ${limits.maxExpandedBytes} bytes`, {
          code: "expanded_bytes", limit: limits.maxExpandedBytes, actual: expandedBytes,
        }));
        file.terminate?.();
        return;
      }
      if (expandedBytes > ratioLimit) {
        reject(fail(label, `expanded content exceeds the ${limits.maxCompressionRatio}:1 compression-ratio limit`, {
          code: "compression_ratio", limit: limits.maxCompressionRatio,
          actual: expandedBytes / Math.max(1, bytes.byteLength),
        }));
        file.terminate?.();
        return;
      }
      if (keep && data.byteLength) state.chunks.push(data.slice());
      if (final) {
        state.final = true;
        if (keep) selected.set(entry.name, joinChunks(state.chunks, state.size));
        state.chunks.length = 0;
      }
    };
    try { file.start(); }
    catch {
      reject(fail(label, `unsupported compression for ${entry.name.slice(0, 80)}`, {
        code: "unsupported_compression", entry: entry.name.slice(0, 160),
      }));
    }
  });
  unzip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < bytes.byteLength && !failure; offset += limits.inputChunkBytes) {
      const end = Math.min(bytes.byteLength, offset + limits.inputChunkBytes);
      unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
  } catch (error) {
    if (!failure) {
      failure = fail(label, "the archive is malformed or truncated", {
        code: "invalid_archive",
      });
      failure.cause = error;
    }
  }
  if (failure) throw failure;
  if (!fileCount) throw fail(label, "the archive contains no entries", { code: "invalid_archive" });
  if (states.some((state) => !state.final)) {
    throw fail(label, "the archive ended before every entry was complete", { code: "invalid_archive" });
  }
  return Object.freeze({
    entries: selected,
    stats: Object.freeze({
      compressed_bytes: bytes.byteLength,
      expanded_bytes: expandedBytes,
      file_count: fileCount,
      selected_count: selected.size,
      nesting,
      compression_ratio: expandedBytes / Math.max(1, bytes.byteLength),
    }),
  });
}

export function validateZipArchive(buffer, options = {}) {
  return extractZipEntries(buffer, { ...options, select: () => false }).stats;
}
