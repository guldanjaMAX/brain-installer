import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeMetaText,
  detectFacebookMessengerExport,
  isFacebookMessengerExportFilename,
  parseFacebookMessengerExport,
} from "../ingest/facebook-messenger-export.mjs";
import { prepare } from "../ingest/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "facebook-messenger", "inbox", "finance_group_abc", "message_1.json");
const text = readFileSync(fixture, "utf8");
let failures = 0;
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  ${String(detail).slice(0, 220)}`}`);
  if (!condition) failures++;
};

check("detects a Messenger Download Your Information JSON thread",
  detectFacebookMessengerExport(text));
check("ordinary JSON is not mistaken for Messenger",
  !detectFacebookMessengerExport('{"messages":[],"participants":[],"name":"ordinary"}'));
check("a non-JSON file is not detected",
  !detectFacebookMessengerExport("sender_name timestamp_ms participants messages"));
check("only Meta's split thread filename receives the larger archive ceiling",
  isFacebookMessengerExportFilename("message_1.json") &&
  isFacebookMessengerExportFilename("MESSAGE_22.JSON") &&
  !isFacebookMessengerExportFilename("ledger.json"));
check("known Meta mojibake is repaired without changing ordinary Unicode",
  decodeMetaText("JosÃ©") === "José" && decodeMetaText("Renée") === "Renée");

const parsed = parseFacebookMessengerExport(text, {
  sourceLabel: "messages",
  fallbackThreadId: "fixture",
  ownerName: "Owner Example",
});
check("reads every textual message and no attachment-only placeholder",
  parsed.messageCount === 4 && parsed.rows.length === 4, JSON.stringify(parsed));
check("counts attachment-only, unavailable, and malformed rows separately",
  parsed.skippedMedia === 1 && parsed.skippedUnavailable === 1 && parsed.skippedMalformed === 1,
  JSON.stringify(parsed));
check("uses the export's stable thread path and human title",
  parsed.threadId === "messages:inbox/finance_group_abc" && parsed.title === "Finance group",
  JSON.stringify({ threadId: parsed.threadId, title: parsed.title }));
check("sorts Meta's newest-first array into exact chronological order",
  parsed.sourceOrder === "newest_first" &&
  parsed.rows.every((row, index) => index === 0 || row.ts >= parsed.rows[index - 1].ts),
  JSON.stringify(parsed.rows.map((row) => row.ts)));
check("epoch milliseconds become exact ISO timestamps",
  parsed.rows.at(-1).ts === "2026-01-01T13:00:00.000Z", parsed.rows.at(-1).ts);
check("sender names are repaired and the optional owner label sets direction",
  parsed.rows.some((row) => row.sender_name === "José Rivera" && row.direction === "in") &&
  parsed.rows.some((row) => row.sender_name === "Owner Example" && row.direction === "out"),
  JSON.stringify(parsed.rows));
check("two genuinely identical same-millisecond messages both survive with distinct ids",
  new Set(parsed.rows.map((row) => row.id)).size === parsed.rows.length &&
  parsed.rows.filter((row) => row.body === "Can you confirm the term?").length === 2,
  JSON.stringify(parsed.rows.map((row) => row.id)));

const parsedAgain = parseFacebookMessengerExport(text, {
  sourceLabel: "messages",
  fallbackThreadId: "fixture",
  ownerName: "Owner Example",
});
check("rerunning the same export produces identical ids",
  JSON.stringify(parsed.rows.map((row) => row.id)) === JSON.stringify(parsedAgain.rows.map((row) => row.id)));

const prepared = await prepare({
  full: fixture,
  rel: "facebook-messenger/inbox/finance_group_abc/message_1.json",
  name: "message_1.json",
  size: Buffer.byteLength(text),
}, { sourceName: "messages" });
check("common folder ingestion routes Messenger JSON into conversation documents",
  prepared.envelopes?.length === 1 && prepared.envelopes[0].metadata.platform === "fb_messenger",
  JSON.stringify(prepared));
check("the resulting document retains the export-file family for deletion and reconciliation",
  prepared.envelopes?.every((envelope) =>
    envelope.metadata.family_of === "messages:facebook-messenger/inbox/finance_group_abc/message_1.json"),
  JSON.stringify(prepared.envelopes?.map((envelope) => envelope.metadata.family_of)));
check("the resulting document contains the real message text, not the JSON container",
  /renewal is for twelve months/.test(prepared.envelopes?.[0]?.content || "") &&
  !/timestamp_ms/.test(prepared.envelopes?.[0]?.content || ""),
  prepared.envelopes?.[0]?.content);

console.log(failures ? `\n${failures} FAILURE(S)` : `\nfacebook-messenger-export: all ${ran} checks passed`);
process.exit(failures ? 1 : 0);
