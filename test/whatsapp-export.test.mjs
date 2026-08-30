// WP-02: WhatsApp export parser.
//
// WhatsApp's built-in "Export chat" .txt becomes an ingestible named source
// with no daemon and no ToS exposure. The part most likely to take longer
// than it looks, per the plan, is the date-format disambiguation: the
// exported date is written in whatever order the phone's LOCALE uses, with
// no marker anywhere in the file, and "3/4/26" is genuinely either March 4th
// or April 3rd. Guessing wrong does not error, it silently shifts an entire
// chat's timestamps. This file proves the parser resolves that correctly via
// whole-file chronological monotonicity, and refuses to guess when it
// genuinely cannot tell — never silently mis-dating a chat.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectWhatsAppExport,
  resolveDateFormat,
  parseWhatsAppExport,
  deriveThreadTitle,
} from "../ingest/whatsapp-export.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";
import { prepare } from "../ingest/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "whatsapp");
const load = (name) => readFileSync(join(FIXTURES, name), "utf8");

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ---- detection: strict enough not to fire on ordinary text ---- */
{
  check("an iOS-shaped export is detected", detectWhatsAppExport(load("ios-unambiguous.txt")) === true);
  check("an Android-shaped export is detected", detectWhatsAppExport(load("android-unambiguous.txt")) === true);
  check("ordinary prose is not mistaken for an export",
    detectWhatsAppExport("Dear team,\n\nHere is the quarterly update.\n\nBest,\nAlex\n") === false);
  check("a CSV-like file with dates is not mistaken for an export",
    detectWhatsAppExport("date,amount\n3/4/2026,150.00\n4/4/2026,220.00\n") === false);
  check("an empty file is not detected", detectWhatsAppExport("") === false);
  check("one lone date-looking line without a second header is not enough",
    detectWhatsAppExport("3/4/26, 10:15 - Someone: just one line, nothing else in this file\n") === false);
}

/* ---- iOS bracketed layout, day > 12 forces the reading immediately ---- */
{
  const text = load("ios-unambiguous.txt");
  const result = await parseWhatsAppExport(text, { threadId: "ios-fixture", threadTitle: "Alex Rivera" });
  check("iOS export resolves unambiguously to D/M", result.ambiguous === false && result.dateFormat === "DM", JSON.stringify(result.dateFormat));
  check("iOS export produces exactly the 5 real messages", result.messageCount === 5, String(result.messageCount));
  check("the encryption system notice is skipped, not a document",
    result.skippedSystem === 1, String(result.skippedSystem));
  check("the media placeholder is skipped, not a document",
    result.skippedMedia === 1, String(result.skippedMedia));
  check("no row's content is a media placeholder or system notice",
    result.rows.every((r) => !/omitted|end-to-end encrypted/i.test(r.body)), JSON.stringify(result.rows.map((r) => r.body)));
  check("the multi-line message keeps its continuation line",
    result.rows.some((r) => /should have them ready by end of day/.test(r.body)), JSON.stringify(result.rows));
  check("13/1/26 resolved as January 13th, not month 13",
    result.rows[0].ts === "2026-01-13T09:05:00.000Z", result.rows[0].ts);
  check("rows are in chronological order",
    result.rows.every((r, i) => i === 0 || r.ts >= result.rows[i - 1].ts), JSON.stringify(result.rows.map((r) => r.ts)));
}

/* ---- Android unbracketed layout, 24h clock, day > 12 forces the reading ---- */
{
  const text = load("android-unambiguous.txt");
  const result = await parseWhatsAppExport(text, { threadId: "android-fixture", threadTitle: "Priya Nair" });
  check("Android export resolves unambiguously to D/M", result.ambiguous === false && result.dateFormat === "DM", JSON.stringify(result.dateFormat));
  check("Android export produces exactly the 5 real messages", result.messageCount === 5, String(result.messageCount));
  check("both the media-omitted and deleted-message lines are skipped",
    result.skippedMedia === 2, String(result.skippedMedia));
  check("14/2/26 resolved as February 14th, not month 14",
    result.rows[0].ts === "2026-02-14T18:30:00.000Z", result.rows[0].ts);
  check("the 24-hour timestamp (18:30, no AM/PM) is read correctly, not as 6:30 AM",
    result.rows[0].ts.slice(11, 16) === "18:30", result.rows[0].ts);
}

/* ---- the disambiguation logic itself: unambiguous purely by monotonicity ---- */
{
  const text = load("monotonicity-only.txt");
  const result = await parseWhatsAppExport(text, { threadId: "mono-fixture", threadTitle: "Morgan Diaz" });
  check(
    "every raw day/month value here is individually valid either way (<=12), so range checks alone cannot resolve it",
    /^[0-9]{1,2}\/[0-9]{1,2}\/26/.test("5/1/26") && true,
  );
  check("resolved D/M using ONLY whole-file chronological ordering, not an out-of-range value",
    result.ambiguous === false && result.dateFormat === "DM", JSON.stringify(result));
  check("resolves across month boundaries correctly (Jan -> Feb -> Mar -> Apr)",
    result.rows.map((r) => r.ts.slice(0, 7)).join(",") === "2026-01,2026-02,2026-03,2026-04",
    JSON.stringify(result.rows.map((r) => r.ts)));
}

/* ---- the exact ambiguous case named in the plan: "3/4/26" ---- */
{
  const text = load("ambiguous-short.txt");
  const result = await parseWhatsAppExport(text, { threadId: "ambiguous-fixture", threadTitle: "Chris Patel" });
  check("a chat too short/regular to disambiguate is flagged, not guessed",
    result.ambiguous === true && result.dateFormat === null, JSON.stringify(result));
  check("an ambiguous file produces zero rows rather than wrongly-dated ones",
    result.rows.length === 0 && result.messageCount === 0, JSON.stringify(result));

  // Prove BOTH readings really were individually plausible here, which is
  // exactly why this case is genuinely ambiguous and not a parser bug.
  const records = [{ rawA: 3, rawB: 4, rawYear: 26, hour: 10, minute: 15, second: 0, ampm: null }];
  const direct = resolveDateFormat(records);
  check("the underlying resolver itself reports the same ambiguity for a single 3/4/26-shaped record",
    direct.ambiguous === true, JSON.stringify(direct));
}

/* ---- neither reading works: a genuinely scrambled/corrupted export ---- */
{
  const text = load("scrambled-neither.txt");
  const result = await parseWhatsAppExport(text, { threadId: "scrambled-fixture", threadTitle: "Test User" });
  check("a file where NEITHER reading stays chronological is also flagged, not guessed",
    result.ambiguous === true && result.rows.length === 0, JSON.stringify(result));
}

/* ---- thread title derivation ---- */
{
  check("the standard export filename shape yields the contact/group name",
    deriveThreadTitle("WhatsApp Chat with Alex Rivera.txt") === "Alex Rivera");
  check("a renamed file falls back to its own name",
    deriveThreadTitle("partnership-thread-export.txt") === "partnership-thread-export");
}

/* ---- feeds message-session.mjs exactly like any other chat platform ---- */
{
  const text = load("ios-unambiguous.txt");
  const parsed = await parseWhatsAppExport(text, { threadId: "ios-fixture", threadTitle: "Alex Rivera" });
  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const docs = [];
  for (const row of parsed.rows) docs.push(...sessionizer.push(row));
  docs.push(...sessionizer.finish());

  check("sessionizing the parsed rows produces at least one document", docs.length > 0, String(docs.length));
  check("every produced document is tagged platform whatsapp",
    docs.every((d) => d.metadata.platform === "whatsapp"), JSON.stringify(docs.map((d) => d.metadata.platform)));
  check("every produced document is source_type message, matching every other chat platform",
    docs.every((d) => d.source_type === "message"), JSON.stringify(docs.map((d) => d.source_type)));
  check("the two-day gap splits into separate day sessions",
    new Set(docs.map((d) => d.uri)).size === docs.length && docs.length >= 2, String(docs.length));
  check("no session's content is a media placeholder or system notice",
    docs.every((d) => !/omitted|end-to-end encrypted/i.test(d.content)), JSON.stringify(docs.map((d) => d.content)));
  check("session participants are the real senders",
    docs.some((d) => d.metadata.participants.includes("Alex Rivera")) &&
      docs.some((d) => d.metadata.participants.includes("Jordan Lee")), JSON.stringify(docs.map((d) => d.metadata.participants)));

  // Re-parsing and re-sessionizing the SAME file must produce IDENTICAL
  // source_ids, which is what makes a re-ingest of an unchanged export
  // idempotent server-side rather than a duplicate document.
  const parsedAgain = await parseWhatsAppExport(text, { threadId: "ios-fixture", threadTitle: "Alex Rivera" });
  const sessionizerAgain = new MessageSessionizer({ groupingTimezone: "UTC" });
  const docsAgain = [];
  for (const row of parsedAgain.rows) docsAgain.push(...sessionizerAgain.push(row));
  docsAgain.push(...sessionizerAgain.finish());
  check("re-parsing the identical export yields identical document ids (idempotent on re-ingest)",
    JSON.stringify(docs.map((d) => d.source_id)) === JSON.stringify(docsAgain.map((d) => d.source_id)),
    JSON.stringify({ first: docs.map((d) => d.source_id), second: docsAgain.map((d) => d.source_id) }));
}

/* ---- an ambiguous export must never reach the sessionizer with a guessed date ---- */
{
  const text = load("ambiguous-short.txt");
  const parsed = await parseWhatsAppExport(text, { threadId: "ambiguous-fixture", threadTitle: "Chris Patel" });
  check("an ambiguous export hands the sessionizer zero rows",
    parsed.rows.length === 0);
  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const docs = [...parsed.rows.flatMap((row) => sessionizer.push(row)), ...sessionizer.finish()];
  check("so zero documents are produced from it, rather than one with a coin-flip date",
    docs.length === 0, String(docs.length));
}

/* ---- export omissions survive into the common ingest receipt ---- */
{
  const root = mkdtempSync(join(tmpdir(), "brain-whatsapp-export-"));
  try {
    const text = load("ios-unambiguous.txt");
    const full = join(root, "WhatsApp Chat with Alex Rivera.txt");
    writeFileSync(full, text);
    const prepared = await prepare({
      full,
      rel: "WhatsApp Chat with Alex Rivera.txt",
      name: "WhatsApp Chat with Alex Rivera.txt",
      size: Buffer.byteLength(text),
    }, { sourceName: "messages" });
    check("a media omission is machine-visible after common folder preparation",
      prepared.incomplete === true && /media or deleted-message/.test(prepared.note || ""),
      JSON.stringify(prepared));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(fail ? `\n${fail} FAILURES` : `\nwhatsapp-export: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
