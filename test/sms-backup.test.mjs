// WP-03: SMS backup parser (Android SMS Backup & Restore, and Google Voice
// Takeout), platform `sms`.
//
// Built regardless of what WP-05 found about Devon's phone ("Devon" is an
// invented placeholder for the real pilot client, unconfirmed — see planning
// notes), because it is real capability for the next Android
// client either way. Unlike WP-02's WhatsApp export, neither format here has
// a locale-dependent date to disambiguate: SMS Backup & Restore writes a
// Unix epoch in milliseconds, and Google Voice Takeout writes a full
// ISO-8601 timestamp with a UTC offset. This file proves both parsers read
// those correctly, handle entity-escaped text, skip what they cannot
// represent (MMS, call/voicemail pages) with a clear reason instead of
// silently mis-parsing it, and feed message-session.mjs identically to
// every other chat platform.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectSmsBackupXml, parseSmsBackupXml,
  detectGoogleVoiceTakeout, parseGoogleVoiceTakeout, deriveVoiceThreadTitle,
} from "../ingest/sms-backup.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (...parts) => readFileSync(join(HERE, "fixtures", ...parts), "utf8");

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ---- SMS Backup & Restore XML ---- */
{
  const xml = load("sms-backup", "sms-backup-restore.xml");
  check("detects a real SMS Backup & Restore export", detectSmsBackupXml(xml) === true);
  check("does not detect an unrelated XML file",
    detectSmsBackupXml('<?xml version="1.0"?><root><item>not sms</item></root>') === false);
  check("does not detect plain HTML", detectSmsBackupXml("<html><body>hi</body></html>") === false);

  const r = parseSmsBackupXml(xml, { sourceLabel: "sms-test" });
  check("reads exactly the 6 real <sms> messages", r.messageCount === 6, String(r.messageCount));
  check("skips the one empty-body message", r.skippedEmpty === 1, String(r.skippedEmpty));
  check("counts the one <mms> entry as not parsed by this version, not silently dropped",
    r.skippedMms === 1, String(r.skippedMms));
  check("epoch-millisecond dates are read exactly, not off by a timezone guess",
    r.rows[0].ts === "2024-01-01T00:00:00.000Z", r.rows[0].ts);
  check("XML entities in the body are decoded (&amp; and &#39;)",
    r.rows.some((row) => row.body === "Yes, confirmed & the numbers are ready") &&
      r.rows.some((row) => row.body === "Also, don't forget the deposit slip"),
    JSON.stringify(r.rows.map((row) => row.body)));
  check("type=1 is incoming, type=2 is outgoing",
    r.rows[0].direction === "in" && r.rows[1].direction === "out", JSON.stringify(r.rows.slice(0, 2)));
  check("a contact name is used as the thread title when present",
    r.rows.find((row) => row.thread_id.endsWith("+15551234567")).thread_title === "Alex Rivera");
  check("the bare number is used as the thread title when contact_name is null",
    r.rows.find((row) => row.thread_id.endsWith("+15559876543")).thread_title === "+15559876543");
  check("two different addresses in ONE file become two different threads",
    new Set(r.rows.map((row) => row.thread_id)).size === 2, JSON.stringify([...new Set(r.rows.map((row) => row.thread_id))]));
  check("rows across interleaved threads are still globally chronological",
    r.rows.every((row, i) => i === 0 || row.ts >= r.rows[i - 1].ts), JSON.stringify(r.rows.map((row) => row.ts)));
}

/* ---- Google Voice Takeout ---- */
{
  const html = load("google-voice", "Jordan Lee - Text - 2024-03-01T09_00_00Z.html");
  check("detects a real Google Voice Takeout conversation page", detectGoogleVoiceTakeout(html) === true);
  check("does not detect ordinary HTML", detectGoogleVoiceTakeout("<html><body><p>Hi</p></body></html>") === false);

  const gv = parseGoogleVoiceTakeout(html, { threadId: "gv-test", threadTitle: "Jordan Lee" });
  check("reads exactly the 3 real messages", gv.messageCount === 3, String(gv.messageCount));
  check("the ISO timestamp WITH offset is converted to exact UTC, not misread as local time",
    gv.rows[0].ts === "2024-03-01T17:00:00.000Z", gv.rows[0].ts);
  check("HTML entities in the message text are decoded",
    gv.rows[0].body === "Morning! Quick update on the Q1 numbers & the store count", gv.rows[0].body);
  check("the apostrophe entity decodes correctly too",
    gv.rows[1].body === "Love it, let's discuss Tuesday", gv.rows[1].body);
  check("a named sender (span.fn) is used when present", gv.rows[0].sender_name === "Jordan Lee");
  check("the bare phone number is used when there is no contact name",
    gv.rows[2].sender_name === "+15551112222", gv.rows[2].sender_name);

  check("filename-derived thread title strips the standard Takeout suffix",
    deriveVoiceThreadTitle("Jordan Lee - Text - 2024-03-01T09_00_00Z.html") === "Jordan Lee");
  check("a group conversation filename is also handled",
    deriveVoiceThreadTitle("Family Group - Group Conversation - 2024-01-01T00_00_00Z.html") === "Family Group");
  check("an unrecognised filename shape falls back to itself",
    deriveVoiceThreadTitle("export.html") === "export");
}

/* ---- a call/voicemail page sharing the same template produces nothing, not noise ---- */
{
  const html = load("google-voice", "Sam Osei - Placed - 2024-03-02T10_00_00Z.html");
  check("a call-only Takeout page is still detected as the same export family",
    detectGoogleVoiceTakeout(html) === true);
  const gv = parseGoogleVoiceTakeout(html, { threadId: "gv-call", threadTitle: "Sam Osei" });
  check("but it produces zero message rows rather than a fabricated conversation",
    gv.messageCount === 0 && gv.rows.length === 0, String(gv.messageCount));
}

/* ---- feeds message-session.mjs exactly like every other chat platform ---- */
{
  const xml = load("sms-backup", "sms-backup-restore.xml");
  const parsed = parseSmsBackupXml(xml, { sourceLabel: "sms-test" });
  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const docs = [];
  for (const row of parsed.rows) docs.push(...sessionizer.push(row));
  docs.push(...sessionizer.finish());

  check("sessionizing an interleaved two-thread SMS export produces multiple documents",
    docs.length > 1, String(docs.length));
  check("every produced document is tagged platform sms",
    docs.every((d) => d.metadata.platform === "sms"), JSON.stringify(docs.map((d) => d.metadata.platform)));
  check("the two addresses never merge into one conversation",
    new Set(docs.map((d) => d.metadata.thread_id)).size === 2, JSON.stringify(docs.map((d) => d.metadata.thread_id)));
  check("outgoing messages are attributed to the owner label, not left unattributed",
    docs.some((d) => d.metadata.participants.includes("Owner")), JSON.stringify(docs.map((d) => d.metadata.participants)));

  const parsedAgain = parseSmsBackupXml(xml, { sourceLabel: "sms-test" });
  const sessionizerAgain = new MessageSessionizer({ groupingTimezone: "UTC" });
  const docsAgain = [];
  for (const row of parsedAgain.rows) docsAgain.push(...sessionizerAgain.push(row));
  docsAgain.push(...sessionizerAgain.finish());
  check("re-parsing the identical export yields identical document ids (idempotent on re-ingest)",
    JSON.stringify(docs.map((d) => d.source_id)) === JSON.stringify(docsAgain.map((d) => d.source_id)),
    JSON.stringify({ first: docs.map((d) => d.source_id), second: docsAgain.map((d) => d.source_id) }));
}

console.log(fail ? `\n${fail} FAILURES` : `\nsms-backup: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
