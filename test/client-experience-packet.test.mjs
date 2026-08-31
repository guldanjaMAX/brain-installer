import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKET = join(ROOT, "onboarding", "client-experience");
const names = [
  "README.md",
  "TECHNICIAN-RUNBOOK.md",
  "ACCEPTANCE-AND-HANDOFF.md",
  "SUPPORT-AND-OFFLINE.md",
  "DATA-PROTECTION-DRAFT.md",
];
const documents = Object.fromEntries(names.map((name) => [name, readFileSync(join(PACKET, name), "utf8")]));
const all = Object.values(documents).join("\n");
const support = JSON.parse(readFileSync(join(PACKET, "support-profile.example.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(PACKET, "support-profile.schema.json"), "utf8"));

test("the client packet covers the complete journey with realistic proof boundaries", () => {
  for (const phrase of [
    "Pre-interview",
    "Readiness and install",
    "First source",
    "Golden 20",
    "Acceptance and handoff",
    "Future update notification",
    "Configured:",
    "Scripted or fixture proof:",
    "Live tested:",
    "Blocked:",
  ]) assert.match(all, new RegExp(phrase, "i"));
  assert.match(documents["README.md"], /45 to 75 minutes/);
  assert.match(documents["README.md"], /60 to 90 minutes/);
  assert.match(documents["README.md"], /30 minutes to many hours/);
  assert.match(all, /Node\.js 22 or newer is a behind-the-scenes technician prerequisite/);
  assert.match(all, /passkey-capable phone, tablet, or computer/);
});

test("copyable Claude prompts keep human ceremonies and secrets out of chat", () => {
  assert.match(all, /Open https:\/\/financialbrain\.ai\/update, read the whole page/);
  assert.match(all, /Begin read-only/i);
  assert.match(all, /Do not ask me to paste a password, token, authentication code/);
  assert.match(all, /hidden terminal prompt/);
  assert.match(all, /Ask for exact approval/i);
  assert.doesNotMatch(all, /(?:sk-|ghp_|eyJ[A-Za-z0-9_-]{20,})/);
});

test("the source, Golden 20, support, and update contracts stay honest", () => {
  assert.match(all, /dry run or preview/i);
  assert.match(all, /partial, unavailable/i);
  assert.match(all, /brain eval <manifest> --golden-20/);
  assert.match(all, /not a release\s+certification/i);
  assert.match(all, /brain support --preview/);
  assert.match(all, /update available.*current.*update check unavailable/is);
  assert.match(all, /Unavailable is not the same as current/);
  assert.match(all, /never performs a background update/);
});

test("Wrangler browser sign-in and recovery-token guidance match the installer", () => {
  assert.match(all, /named Cloudflare browser profile/i);
  assert.match(all, /OS keyring/i);
  assert.match(all, /API token remains available for a reviewed legacy/i);
  for (const permission of ["Workers Scripts", "D1", "Vectorize", "Workers AI"]) {
    assert.match(all, new RegExp(permission));
  }
  assert.match(all, /expiry, normally two days/i);
  assert.match(all, /owner enter the value only through the Brain\s+CLI's hidden prompt/i);
  assert.match(all, /real\s+browser callback[\s\S]*remain field gates/i);
});

test("support contact and response targets are explicit configurable fields", () => {
  assert.equal(support.schema_version, 1);
  assert.match(support.contact.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  assert.match(support.contact.incident_email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  for (const key of schema.required) assert.ok(Object.hasOwn(support, key), `missing ${key}`);
  for (const key of schema.properties.response_targets.required) {
    assert.equal(typeof support.response_targets[key], "string");
    assert.ok(support.response_targets[key].trim().length > 0, `empty ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(support), /TODO|TBD|<[^>]+>|\{\{[^}]+\}\}/i);
});

test("privacy and incident text is clearly a counsel-review draft", () => {
  const draft = documents["DATA-PROTECTION-DRAFT.md"];
  assert.match(draft, /product draft for privacy counsel, contract counsel, and security\s+review/i);
  assert.match(draft, /not legal advice, legal approval/i);
  assert.match(draft, /Draft role and subprocessor table/);
  assert.match(draft, /Draft retention schedule for decision/);
  assert.match(draft, /Draft incident and support language/);
  assert.match(draft, /Counsel decisions before publication/);
  assert.doesNotMatch(draft, /legally approved|counsel approved/i);
});

test("customer-facing packet avoids rejected video instructions, placeholder copy, and em dashes", () => {
  assert.doesNotMatch(all, /watch (?:this|the) video|setup video|video walkthrough/i);
  assert.doesNotMatch(all, /TODO|TBD|lorem ipsum|\{\{[^}]+\}\}/i);
  assert.doesNotMatch(all, /\u2014/);
});
