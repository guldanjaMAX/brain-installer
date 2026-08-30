// test/formats-extra.test.mjs
//
// The formats the product's own documentation told clients to use before they
// were registered: meeting transcripts (.vtt), subtitles (.srt), mail archives
// (.mbox), calendar exports (.ics), rich text (.rtf), and YAML (.yaml/.yml).
//
// Every case runs against a real fixture file on disk, through the SAME
// `extract()` and `prepare()` entry points the installer uses, because the
// failure being guarded against here is not "the parser is wrong" — it is
// "the file is silently skipped and the client is told it was loaded". So
// each format is proven three ways: it reads a real file, it REFUSES a
// malformed one by name instead of indexing noise, and it is actually in the
// registry both the folder walk and the Drive triage consult.

import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "@e965/xlsx";
import { extract, canExtract, supported } from "../ingest/extract.mjs";
import { walk, prepare } from "../ingest/run.mjs";
import { splitMbox, unquoteFromLine, mboxMessageKey } from "../ingest/mbox.mjs";
import { parseIcs } from "../ingest/ics.mjs";
import { rtfToText, looksLikeRtf } from "../ingest/rtf.mjs";
import { vttToPlainTranscript, srtToPlainTranscript } from "../worker/src/lib/vtt.js";
import { vttToPlainTranscript as fromZoom } from "../worker/src/lib/zoom.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "formats");
const bytes = (name) => readFileSync(join(FIXTURES, name));
const read = async (name) => extract(bytes(name), name);

/* ================= the registry itself ================= */
{
  for (const ext of [".vtt", ".srt", ".mbox", ".ics", ".rtf", ".yaml", ".yml"]) {
    check(`${ext} is registered, so the walk and Drive triage both stop skipping it`,
      canExtract(`anything${ext}`), supported().join(" "));
  }
}

/* ================= YAML, preserved as written ================= */
{
  const got = await read("client-settings.yaml");
  check("YAML is read as text exactly as the source matrix promises",
    got.text?.includes("client: Brightfield Partners") &&
      got.text.includes("review_every_days: 30") &&
      got.how === "yaml",
    JSON.stringify(got));
  check("YAML indentation is preserved for retrieval context",
    /(?:^|\r?\n)  review_every_days: 30(?:\r?\n|$)/.test(got.text || ""), got.text);
}

/* ================= JSON, bounded without silent loss ================= */
{
  const wide = Object.fromEntries(Array.from({ length: 25_000 }, (_, index) => [`field_${index}`, index]));
  const got = await extract(Buffer.from(JSON.stringify(wide)), "wide.json");
  check("wide JSON states that values beyond the limit were not indexed",
    /additional JSON values were not indexed/.test(got.note || "") &&
      /additional JSON values were not indexed/.test(got.text || ""), JSON.stringify(got).slice(-300));
  check("wide JSON is capped at exactly 20,000 values plus one omission marker",
    (got.text || "").split("\n").length === 20_001, (got.text || "").split("\n").length);
  check("capped JSON carries a machine-visible incomplete signal",
    got.incomplete === true, JSON.stringify(got).slice(-300));
}
{
  const depth = 5_000;
  const raw = `${'{"nested":'.repeat(depth)}"leaf"${"}".repeat(depth)}`;
  const got = await extract(Buffer.from(raw), "deep.json");
  check("deep valid JSON is flattened without recursive stack overflow",
    got.error === undefined && /nested\.nested/.test(got.text || "") && /: leaf$/.test(got.text || ""),
    got.error || got.text?.slice(0, 120));
  check("complete JSON is not mislabeled incomplete", got.incomplete !== true, JSON.stringify(got));
}
{
  const truncated = await extract(
    Buffer.from('{"participants":[{"name":"Fixture"}],"messages":[{"content":"half copied"}'),
    "message_1.json",
  );
  check("a truncated JSON export is refused instead of indexed as complete raw text",
    truncated.text === null && /incomplete or malformed/.test(truncated.error || ""),
    JSON.stringify(truncated));
}

/* ================= bounded tables, without false completeness ================= */
{
  const headerless = await extract(
    Buffer.from("2026-01-01,Coffee,5.00\n2026-01-02,Gas,40.00\n"),
    "transactions.csv",
  );
  check("a headerless mixed date/text/number CSV keeps its first transaction",
    /2026-01-01 \| Coffee \| 5\.00/.test(headerless.text || "") &&
      /2026-01-02 \| Gas \| 40\.00/.test(headerless.text || "") &&
      !/2026-01-01: 2026-01-02/.test(headerless.text || ""),
    JSON.stringify(headerless));
  check("a complete headerless CSV stays complete",
    headerless.incomplete !== true, JSON.stringify(headerless));

  const malformed = await extract(Buffer.from('Name,Note\nAlice,"unterminated\nBob,hidden'), "broken.csv");
  check("an unterminated quoted CSV field cannot report complete",
    malformed.incomplete === true && /unterminated|misplaced quoted field/.test(malformed.note || ""),
    JSON.stringify(malformed));
}
{
  const body = Array.from({ length: 5_001 }, (_, index) => `row-${index},${index}`).join("\n");
  const cappedCsv = await extract(Buffer.from(`Name,Value\n${body}\n`), "large.csv");
  check("CSV rows beyond the cap carry a machine-visible incomplete signal",
    cappedCsv.incomplete === true && /1 further rows were not indexed/.test(cappedCsv.note || ""),
    JSON.stringify(cappedCsv).slice(-300));

  const cappedTsv = await extract(Buffer.from(`Name\tValue\n${body.replaceAll(",", "\t")}\n`), "large.tsv");
  check("TSV uses the same structured cap signal as CSV",
    cappedTsv.incomplete === true && /1 further rows were not indexed/.test(cappedTsv.note || ""),
    JSON.stringify(cappedTsv).slice(-300));

  const exactBody = Array.from({ length: 5_000 }, (_, index) => `row-${index},${index}`).join("\n");
  const exactCsv = await extract(Buffer.from(`Name,Value\n${exactBody}\n`), "exact.csv");
  check("a CSV exactly at the row limit stays complete",
    exactCsv.incomplete !== true && !/not indexed/.test(exactCsv.text || ""), JSON.stringify(exactCsv).slice(-300));

  const root = mkdtempSync(join(tmpdir(), "brain-incomplete-csv-"));
  writeFileSync(join(root, "large.csv"), `Name,Value\n${body}\n`);
  const walked = walk(root, {}).files[0];
  const prepared = await prepare(walked, { sourceName: "documents" });
  check("prepare preserves known extraction loss for orchestration",
    prepared.incomplete === true && prepared.envelope?.metadata?.extraction_incomplete === true,
    JSON.stringify(prepared).slice(-400));
  rmSync(root, { recursive: true, force: true });
}

/* ================= generic XML, preserved as written ================= */
{
  const got = await extract(
    Buffer.from('<invoice customer="Acme" amount="1200"><status>paid</status></invoice>'),
    "invoice.xml",
  );
  check("generic XML retains element names, attributes, and values",
    got.how === "xml" && got.text?.includes("invoice") && got.text.includes('customer="Acme"') &&
      got.text.includes('amount="1200"') && got.text.includes("status") && got.text.includes("paid"),
    JSON.stringify(got));
}

/* ================= spreadsheets, with exact per-sheet caps ================= */
{
  const workbook = XLSX.utils.book_new();
  const cappedRows = [
    ["Name", "Value"],
    ...Array.from({ length: 5_001 }, (_, index) => [`row-${index}`, index]),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(cappedRows), "Capped");
  const capped = await extract(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }), "large.xlsx");
  check("XLSX rows beyond a sheet cap carry a machine-visible incomplete signal",
    capped.incomplete === true && /1 row\(s\).*not indexed/.test(capped.note || ""), JSON.stringify(capped).slice(-300));

  const completeWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(completeWorkbook,
    XLSX.utils.aoa_to_sheet([["Name", "Value"], ["complete-row", 1]]), "Complete");
  const complete = await extract(
    XLSX.write(completeWorkbook, { bookType: "xlsx", type: "buffer" }), "complete.xlsx");
  check("a fully rendered workbook is not mislabeled incomplete",
    complete.incomplete !== true && complete.note === undefined, JSON.stringify(complete));
}

/* ================= transcripts (.vtt) ================= */
{
  const got = await read("saved-call.vtt");
  check("a saved meeting transcript reads as speaker-tagged text",
    got.text?.includes("Alex Rivera: Before we sign") &&
    got.text.includes("Priya Nair: Thirty is fine."), JSON.stringify(got).slice(0, 300));
  check("the WEBVTT header block never becomes a speaker",
    !/Kind:|Language:/.test(got.text || ""), got.text);
  check("cue numbers do not leak into the transcript",
    !/^\d+$/m.test(got.text || ""), got.text);
  check("cue timings and their positioning settings are gone",
    !/-->|position:|align:/.test(got.text || ""), got.text);
  check("a NOTE comment is not indexed as speech",
    !/exported from a meeting recording/.test(got.text || ""), got.text);
  check("a cue wrapped over two lines is joined into one turn",
    /Thirty is fine\. The renewal price holds at nine hundred dollars a month through the end of March\./
      .test(got.text || ""), got.text);
  check("it is labelled as a transcript, not as plain text", got.how === "transcript", got.how);
}
{
  const got = await read("voice-spans.vtt");
  check("the WebVTT <v Name> voice span is read as the speaker",
    got.text?.includes("Sam Osei: The warehouse lease expires in November, not September.") &&
    got.text.includes("Jordan Lee: Then we have four extra weeks"), got.text);
  check("inline styling markup is removed without eating the sentence",
    !/<i>|<\/i>|<v /.test(got.text || ""), got.text);
  check("an unattributed cue is still emitted rather than silently dropped",
    got.text?.includes("No speaker was recorded for this line"), got.text);
}
{
  const got = await read("not-a-transcript.vtt");
  check("a .vtt with no cue timings is REFUSED, not indexed as prose",
    got.text === null && /no timed captions/.test(got.error || ""), JSON.stringify(got));
  check("and the refusal never carries the file's content", !/prose in it/.test(got.error || ""), got.error);
}

/* ================= subtitles (.srt) ================= */
{
  const got = await read("interview.srt");
  check("a SubRip file reads as speaker-tagged text",
    got.text?.includes("Morgan Diaz: The second warehouse came in at eleven thousand square feet.") &&
    got.text.includes("Sam Osei: That is bigger than we costed."), got.text);
  check("SubRip positioning overrides are stripped", !/\{\\an/.test(got.text || ""), got.text);
  check("comma-separated SubRip timings are recognised as timings",
    !/-->/.test(got.text || ""), got.text);
  check("it is labelled as subtitles", got.how === "subtitles", got.how);
}
{
  const got = await read("garbled.srt");
  check("a .srt with no cues at all is REFUSED",
    got.text === null && /no timed captions/.test(got.error || ""), JSON.stringify(got));
}

/* ================= one transcript reader, not two ================= */
{
  const sample = readFileSync(join(FIXTURES, "saved-call.vtt"), "utf-8");
  check("the Zoom connector and the local ingest path use the SAME function",
    fromZoom === vttToPlainTranscript, "zoom.js re-export is not the shared implementation");
  check("and therefore produce identical text for identical bytes",
    fromZoom(sample) === vttToPlainTranscript(sample));
  check("the SubRip reader shares that machinery rather than duplicating it",
    srtToPlainTranscript("1\n00:00:01,000 --> 00:00:02,000\nSam Osei: Hello.\n") === "Sam Osei: Hello.");
}

/* ================= mail archives (.mbox) ================= */
{
  const raw = readFileSync(join(FIXTURES, "three-messages.mbox"), "utf-8");
  const messages = splitMbox(raw);
  check("an archive splits on its From_ delimiter lines", messages.length === 3, String(messages.length));
  check("the delimiter line itself is not part of the message",
    !messages.some((m) => /^From \S+ \w{3} \w{3}/.test(m)), messages[0]?.slice(0, 60));
  check("mbox >From quoting is undone in the body",
    messages[0].includes("\nFrom what I can tell") && !messages[0].includes(">From what I can tell"),
    messages[0]);
  check("the un-quoting only touches a From_ escape",
    unquoteFromLine(">From here on") === "From here on" &&
    unquoteFromLine(">> quoted reply text") === ">> quoted reply text");
  check("a message identity survives the archive being re-exported",
    mboxMessageKey("mail/archive.mbox", "<abc@example.test>", 7) === "mail/archive.mbox#abc@example.test" &&
    mboxMessageKey("mail/archive.mbox", null, 7) === "mail/archive.mbox#message-7");
}
{
  // The whole point: many messages, many DOCUMENTS.
  const root = mkdtempSync(join(tmpdir(), "brain-mbox-"));
  mkdirSync(join(root, "mail"), { recursive: true });
  writeFileSync(join(root, "mail", "archive.mbox"), readFileSync(join(FIXTURES, "three-messages.mbox")));
  writeFileSync(join(root, "mail", "broken.mbox"), readFileSync(join(FIXTURES, "not-an-archive.mbox")));

  const { files } = walk(root, {});
  const one = (name) => files.find((f) => f.name === name);

  const loaded = await prepare(one("archive.mbox"), { sourceName: "documents" });
  check("a three-message archive becomes THREE documents, not one",
    loaded.envelopes?.length === 3, JSON.stringify(loaded).slice(0, 200));
  check("each document is titled by its own subject",
    loaded.envelopes.map((e) => e.title).join(" | ") ===
      "Renewal terms for the operations contract | Re: Renewal terms for the operations contract | Warehouse handover date",
    loaded.envelopes.map((e) => e.title).join(" | "));
  check("each document is dated by its own Date header, not the file",
    loaded.envelopes.map((e) => e.occurred_at.slice(0, 10)).join(",") === "2026-06-12,2026-06-15,2026-06-16" &&
    loaded.envelopes.every((e) => e.date_source === "mbox:date_header" && e.date_reliable === true),
    JSON.stringify(loaded.envelopes.map((e) => [e.occurred_at, e.date_source])));
  check("each document has its own citable identity inside the archive",
    loaded.envelopes.map((e) => e.source_id).join(",") ===
      "mail/archive.mbox#first-message@example.test,mail/archive.mbox#second-message@example.test,mail/archive.mbox#third-message@example.test",
    loaded.envelopes.map((e) => e.source_id).join(","));
  check("the headers a person searches for are kept in the body",
    /From: Alex Rivera <alex@example\.test>/.test(loaded.envelopes[0].content) &&
    /Subject: Renewal terms/.test(loaded.envelopes[0].content), loaded.envelopes[0].content.slice(0, 200));
  check("the run says how many messages it found", /3 message\(s\) loaded/.test(loaded.note || ""), loaded.note);
  check("an informational complete-mbox note does not imply missing content",
    loaded.incomplete !== true, JSON.stringify(loaded));

  const broken = await prepare(one("broken.mbox"), { sourceName: "documents" });
  check("a file that is not an archive is REFUSED with the reason",
    !broken.envelopes && /no message separator line/.test(broken.skip?.reason || ""), JSON.stringify(broken));
  rmSync(root, { recursive: true, force: true });
}
{
  const got = await read("three-messages.mbox");
  check("the single-document fallback reads every message through the same mail reader",
    got.text?.includes("Renewal terms") && got.text.includes("Warehouse handover date") &&
    got.how === "mail archive", JSON.stringify(got).slice(0, 200));
  check("and says out loud that a local folder would split it",
    /own document/.test(got.note || ""), got.note);
  check("the complete fallback archive note is informational, not incomplete",
    got.incomplete !== true, JSON.stringify(got));
  const refused = await read("not-an-archive.mbox");
  check("the fallback refuses a non-archive too",
    refused.text === null && /no message separator line/.test(refused.error || ""), JSON.stringify(refused));
}

/* ================= calendars (.ics) ================= */
{
  const got = await read("team-calendar.ics");
  check("an event reads with its title, date, attendees and description",
    got.text?.includes("Meeting: Renewal review with the operations team") &&
    got.text.includes("(2026-06-12)") &&
    got.text.includes("Attendees: Priya Nair <priya@example.test>") &&
    got.text.includes("Walk the renewal numbers line by line."), got.text?.slice(0, 400));
  check("a declined attendee is not reported as an attendee",
    /Declined: Sam Osei/.test(got.text || "") && !/Attendees:.*Sam Osei/.test(got.text || ""), got.text);
  check("a room is a room, not a person",
    /room: Meeting Room 2/.test(got.text || "") && !/Attendees:.*Meeting Room 2/.test(got.text || ""), got.text);
  check("a recurrence rule is spelled out in English, not left as RRULE",
    /Recurring: this is a series that repeats monthly/.test(got.text || "") && !/FREQ=/.test(got.text || ""),
    got.text);
  check("a folded description line is rejoined into a sentence",
    /signed notice-period amendment/.test(got.text || ""), got.text);
  check("a VALARM's own DESCRIPTION does not overwrite the meeting's",
    !/Reminder/.test(got.text || ""), got.text);
  check("an all-day event is not reported a day longer than it was",
    /Meeting: Warehouse handover[\s\S]*?\(2026-07-01\), all day/.test(got.text || ""), got.text);
  check("a VTODO is not read as a meeting",
    !/This is a task/.test(got.text || ""), got.text);
  check("it is labelled as a calendar", got.how === "calendar", got.how);
  check("a fully read calendar is not mislabeled incomplete", got.incomplete !== true, JSON.stringify(got));
}
{
  const got = await read("timezones-only.ics");
  check("a calendar with no events is REFUSED rather than indexed as its timezone table",
    got.text === null && /no events in it/.test(got.error || ""), JSON.stringify(got));
  const truncated = await read("truncated.ics");
  check("a truncated calendar is REFUSED and says the entries were unreadable",
    truncated.text === null && /no readable events/.test(truncated.error || ""), JSON.stringify(truncated));
  const parsed = parseIcs(readFileSync(join(FIXTURES, "truncated.ics"), "utf-8"));
  check("an unterminated final event counts as malformed, never as an event",
    parsed.events.length === 0 && parsed.malformed === 1, JSON.stringify(parsed));

  const oneGoodOneBroken = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:good", "DTSTART:20260612T180000Z", "SUMMARY:Readable event", "END:VEVENT",
    "BEGIN:VEVENT", "UID:broken", "SUMMARY:Truncated event",
    "END:VCALENDAR",
  ].join("\r\n");
  const partial = await extract(Buffer.from(oneGoodOneBroken), "partial.ics");
  check("a calendar with readable and malformed events is explicitly incomplete",
    partial.incomplete === true && /1 calendar entry could not be read/.test(partial.note || "") &&
      /Readable event/.test(partial.text || ""), JSON.stringify(partial));

  const missingCalendarEnd = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:good-before-cutoff", "DTSTART:20260612T180000Z", "SUMMARY:Readable before cutoff", "END:VEVENT",
  ].join("\r\n");
  const cutoff = await extract(Buffer.from(missingCalendarEnd), "missing-calendar-end.ics");
  check("a readable event cannot hide a missing END:VCALENDAR boundary",
    cutoff.incomplete === true && /ended before END:VCALENDAR/.test(cutoff.note || "") &&
      /Readable before cutoff/.test(cutoff.text || ""), JSON.stringify(cutoff));

  const events = Array.from({ length: 501 }, (_, index) => [
    "BEGIN:VEVENT", `UID:event-${index}`, "DTSTART:20260612T180000Z", `SUMMARY:Event ${index}`, "END:VEVENT",
  ].join("\r\n")).join("\r\n");
  const capped = await extract(Buffer.from(`BEGIN:VCALENDAR\r\n${events}\r\nEND:VCALENDAR\r\n`), "capped.ics");
  check("a calendar beyond its event cap is explicitly incomplete",
    capped.incomplete === true && /1 further event\(s\) were not indexed/.test(capped.note || "") &&
      !/Meeting: Event 500(?:\r?\n|$)/.test(capped.text || ""), JSON.stringify(capped).slice(-300));
}

/* ================= rich text (.rtf) ================= */
{
  const got = await read("renewal-letter.rtf");
  check("an RTF letter reads as its prose",
    got.text?.includes("The renewal price holds at") &&
    got.text.includes("Signed on 12 June 2026"), got.text?.slice(0, 300));
  check("smart quotes survive the cp1252 escape decoding",
    got.text?.includes("“nine hundred dollars”"), got.text);
  check("the font, colour and style tables are not indexed as text",
    !/Calibri|Times New Roman|Riched20/.test(got.text || ""), got.text);
  check("an embedded picture's hex payload is not indexed as text",
    !/0100090000039e/.test(got.text || "") && !/[0-9a-f]{40}/.test(got.text || ""), got.text);
  check("document metadata destinations stay out of the body",
    !/Renewal letter/.test(got.text || ""), got.text);
  check("paragraph breaks become line breaks",
    (got.text || "").split("\n").length >= 4, JSON.stringify(got.text));
  check("it is labelled as rich text", got.how === "rich text", got.how);
}
{
  const got = await read("not-really.rtf");
  check("a plain-text file renamed .rtf is REFUSED, not indexed by accident",
    got.text === null && /does not begin with an RTF header/.test(got.error || ""), JSON.stringify(got));
  check("looksLikeRtf is what decides that", looksLikeRtf("{\\rtf1 hello}") && !looksLikeRtf("hello"));
  const empty = await read("tables-only.rtf");
  check("a structurally valid RTF holding only tables and a picture is REFUSED",
    empty.text === null && /no text outside its font, style and image tables/.test(empty.error || ""),
    JSON.stringify(empty));
  check("rtfToText separates 'not RTF' from 'RTF with nothing in it'",
    rtfToText("plain") === null && rtfToText("{\\rtf1{\\fonttbl{\\f0 Calibri;}}}") === "");
}

console.log(fail ? `\n${fail} FAILURES` : `\nformats-extra: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
