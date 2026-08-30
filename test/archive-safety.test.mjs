import assert from "node:assert/strict";
import { strFromU8, strToU8, zipSync } from "fflate";
import {
  ArchiveSafetyError,
  extractZipEntries,
  validateZipArchive,
} from "../ingest/archive.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const zip = (entries, options = {}) => zipSync(
  Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])),
  options,
);
const refused = (fn, code) => {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  return error instanceof ArchiveSafetyError && error.code === code;
};

{
  const bytes = zip({ "word/document.xml": "<w:p>kept</w:p>", "word/image.bin": "ignored" });
  const result = extractZipEntries(bytes, { select: (name) => name.endsWith(".xml") });
  check("streaming extraction returns only selected entries",
    result.entries.size === 1 && strFromU8(result.entries.get("word/document.xml")).includes("kept"));
  check("unselected entries still count against the expanded budget",
    result.stats.file_count === 2 && result.stats.expanded_bytes > result.entries.get("word/document.xml").length);
}

{
  const bytes = zip({ "one.txt": "one" });
  check("compressed archive bytes are bounded", refused(() => extractZipEntries(bytes, {
    limits: { maxCompressedBytes: bytes.length - 1 },
  }), "compressed_bytes"));
}

{
  const bytes = zip({ "one.txt": "12345678", "two.txt": "abcdefgh" }, { level: 0 });
  check("total expanded bytes are bounded", refused(() => extractZipEntries(bytes, {
    limits: { maxExpandedBytes: 12, maxEntryBytes: 12, maxCompressionRatio: 200 },
  }), "expanded_bytes"));
}

{
  const bytes = zip({ "large.txt": "123456789" }, { level: 0 });
  check("each entry has its own expanded-byte bound", refused(() => extractZipEntries(bytes, {
    limits: { maxEntryBytes: 8 },
  }), "entry_bytes"));
}

{
  const bytes = zip({ "one.txt": "one", "two.txt": "two" });
  check("archive file count is bounded", refused(() => extractZipEntries(bytes, {
    limits: { maxFiles: 1 },
  }), "file_count"));
}

{
  const bytes = zip({ "a/b/c.txt": "deep" });
  check("entry path depth is bounded", refused(() => extractZipEntries(bytes, {
    limits: { maxPathDepth: 2 },
  }), "path_depth"));
}

{
  const bytes = zip({ "../outside.txt": "unsafe" });
  check("archive paths cannot escape their root", refused(() => extractZipEntries(bytes), "unsafe_entry_path"));
}

{
  const bytes = zip({ "bomb.txt": "A".repeat(200_000) }, { level: 9 });
  check("archive compression ratio is bounded", refused(() => extractZipEntries(bytes, {
    limits: { maxCompressionRatio: 10, maxExpandedBytes: 1_000_000, maxEntryBytes: 1_000_000 },
  }), "compression_ratio"));
}

{
  const bytes = zip({ "nested.txt": "one level" });
  check("recursive archive nesting is bounded", refused(() => extractZipEntries(bytes, {
    nesting: 2,
    limits: { maxNesting: 1 },
  }), "nesting"));
}

{
  const bytes = zip({ "sheet.xml": "safe" });
  const stats = validateZipArchive(bytes);
  check("validation streams the complete archive without retaining entries",
    stats.selected_count === 0 && stats.file_count === 1 && stats.expanded_bytes === 4);
}

{
  check("malformed ZIP input is refused", refused(() => extractZipEntries(strToU8("not a zip")), "invalid_archive"));
}

console.log(`\narchive safety: all ${ran} checks passed`);
