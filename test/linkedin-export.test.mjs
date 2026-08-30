import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { detectLinkedInArchive, parseCsv, parseLinkedInArchive } from "../ingest/linkedin-export.mjs";
import { prepare } from "../ingest/run.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const archive = zipSync({
  "Basic_LinkedInDataExport_08-29-2026/Connections.csv": strToU8(
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
    "Alex,Example,https://www.linkedin.com/in/alex,alex@example.invalid,\"Example, Inc.\",Founder,2026-08-01\n",
  ),
  "Basic_LinkedInDataExport_08-29-2026/Messages.csv": strToU8(
    "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT\n" +
    "c1,\"Fixture, Conversation\",Alex,,Riley,2026-08-02 12:30:00 UTC,Hello,\"Line one\nLine two\"\n",
  ),
  "Basic_LinkedInDataExport_08-29-2026/Ad_Targeting.csv": strToU8("Category,Value\nFixture,Ignored\n"),
});

const csv = parseCsv("a,b\n\"x,y\",\"line 1\nline 2\"\n");
check("CSV parser preserves quoted commas and embedded newlines", csv[1][0] === "x,y" && csv[1][1].includes("line 2"));
check("LinkedIn archive is detected by recognized export filenames", detectLinkedInArchive(archive));
const parsed = parseLinkedInArchive(archive, { sourceName: "custodian", archivePath: "exports/linkedin.zip" });
check("recognized LinkedIn CSVs become separate stable documents",
  parsed.envelopes.length === 2 && parsed.envelopes.every((item) => item.source_id.startsWith("linkedin:exports/linkedin.zip:")));
check("unknown tracking CSVs are not silently indexed", parsed.envelopes.every((item) => !item.content.includes("Ad_Targeting")));
check("export provenance records access mode and row counts", parsed.envelopes.every((item) =>
  item.metadata.platform === "linkedin" && item.metadata.access_mode === "account_owner_export" && item.metadata.row_count === 1));

const folder = mkdtempSync(join(tmpdir(), "brain-linkedin-export-"));
try {
  const full = join(folder, "linkedin-export.zip");
  writeFileSync(full, archive);
  const result = await prepare({ full, rel: "linkedin-export.zip", name: "linkedin-export.zip", size: archive.length }, { sourceName: "upload" });
  check("common folder ingestion recognizes the ZIP without a special command", result.envelopes.length === 2);
  check("every LinkedIn child declares one source-file family for safe deletion",
    result.envelopes.every((item) => item.metadata.family_of === "upload:linkedin-export.zip"));
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const bad = parseLinkedInArchive(strToU8("not a zip"));
check("an unreadable archive is refused with a named reason", /not a readable ZIP/.test(bad.error));
const malformed = parseLinkedInArchive(zipSync({ "Connections.csv": strToU8('Name\n"unfinished\n') }));
check("malformed recognized CSV is reported rather than partially indexed", /no readable data rows/.test(malformed.error));
const duplicate = parseLinkedInArchive(zipSync({
  "one/Connections.csv": strToU8("Name\nOne\n"),
  "two/Connections.csv": strToU8("Name\nTwo\n"),
}));
check("duplicate recognized basenames cannot create duplicate document identities", /duplicate recognized/.test(duplicate.error));
const traversal = parseLinkedInArchive(zipSync({ "../Connections.csv": strToU8("Name\nFixture\n") }));
check("archive path traversal is refused by the common boundary", /unsafe_entry_path/.test(traversal.error));
const bomb = parseLinkedInArchive(zipSync({ "Connections.csv": strToU8("A".repeat(1_000_000)) }, { level: 9 }));
check("archive compression bombs are refused by the common boundary", /compression_ratio/.test(bomb.error));

console.log(`\nlinkedin export: all ${ran} checks passed`);
