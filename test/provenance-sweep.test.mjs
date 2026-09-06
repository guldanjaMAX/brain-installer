// Generic synthetic fixtures for the provenance sweep and its CLI wiring.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agreementVerdict, bestTier, tierOf, OWNER_CONFIRMED_SOURCE,
} from "../operations/provenance.mjs";
import { authorityFor } from "../worker/src/lib/evidence-authority.js";
import {
  assessProbe, groupCandidates, renderSweep, severityOf, sweep,
} from "../operations/contradiction-sweep.mjs";
import {
  assessZoneReadiness,
  collectAnswers,
  confirmationEnvelope,
  gather,
  partition,
  rowMatchesSubject,
  renderConfirmations,
  renderReport,
  renderZoneReadiness,
  unavailableZoneReadiness,
  validateConfirmationReceipt,
} from "../operations/check-run.mjs";

let pass = 0;
const ok = (name) => { pass++; console.log(`PASS  ${name}`); };
const SUBJECT = "Example Owner";

// Authority tiers are heuristics and always carry the rule that produced them.
assert.equal(tierOf({ source: "plaid" }).tier, "T1");
assert.equal(tierOf({ source: "drive", title: "Synthetic registrar record.pdf" }).tier, "T1");
assert.equal(tierOf({ source: "drive", title: "Synthetic invoice.pdf" }).tier, "T2");
assert.equal(tierOf({ source: "gmail", title: "Synthetic correspondence" }).tier, "T3");
assert.equal(tierOf({ source: "zoom", title: "Synthetic weekly sync" }).tier, "T4");
assert.equal(tierOf({ source: "drive", title: "Synthetic call notes.md" }).tier, "T4");
for (const document of [{ source: "plaid" }, { source: "zoom" }, { source: "drive", title: "Synthetic file" }]) {
  assert.ok(tierOf(document).reason.length > 8);
}
assert.equal(bestTier([]).tier, "T0");
ok("authority tiers are explained and absence has its own tier");

const softPile = [
  { source: "zoom", title: "Synthetic call" },
  { source: "drive", title: "Synthetic meeting notes" },
  { source: "imessage", title: "Synthetic message" },
];
const changingAgreement = agreementVerdict(softPile, { changes: true });
assert.equal(changingAgreement.confident, false);
assert.equal(changingAgreement.caution, true);
assert.match(changingAgreement.line, /tracks how long something has been written down/);
assert.equal(agreementVerdict(softPile, { changes: false }).confident, true);
assert.equal(
  agreementVerdict([...softPile, {
    source: "drive", title: "Synthetic signed agreement.pdf",
    ts: "2026-01-15T00:00:00.000Z", date_reliable: true,
    text_source: "native", text_reliable: true,
  }], { changes: true }).confident,
  true,
);
ok("agreement on a changing fact stays cautious without primary evidence");

const undatedPrimary = assessProbe({
  name: "Mailing address",
  changes: true,
  candidates: [{
    value: "100 Example Avenue",
    doc: { source: "plaid", text_source: "native", text_reliable: true },
  }],
});
assert.equal(undatedPrimary.verdict.confident, false);
assert.equal(undatedPrimary.verdict.caution, true);
ok("an undated T1 record is possible evidence, not a confident current fact");

const address = assessProbe({
  name: "Mailing address",
  changes: true,
  candidates: [
    { value: "100 Example Avenue", doc: { source: "drive", title: "Synthetic note one", date: "2024-01-01", date_reliable: false } },
    { value: "100 Example Avenue", doc: { source: "imessage", title: "Synthetic note two", date: "2024-02-01", date_reliable: true } },
    { value: "100 example avenue", doc: { source: "gmail", title: "Synthetic note three", date: "2024-03-01", date_reliable: true } },
    { value: "200 Sample Road", doc: { source: "drive", title: "Synthetic lease agreement.pdf", date: "2026-01-15", date_reliable: true } },
  ],
});
assert.equal(address.conflict, true);
assert.equal(address.groups.length, 2);
assert.equal(address.groups.find((group) => group.value === "100 Example Avenue")?.count, 3);
assert.equal(address.verdict.caution, true);
ok("a synthetic stale majority becomes a conflict and never wins automatically");

const noDates = groupCandidates([
  { value: "A", doc: { source: "gmail" } },
  { value: "A", doc: { source: "gmail" } },
  { value: "A", doc: { source: "gmail" } },
  { value: "B", doc: { source: "gmail" } },
]);
const unreliableNewest = groupCandidates([
  { value: "A", doc: { source: "gmail", date: "2024-01-01", date_reliable: true } },
  { value: "A", doc: { source: "gmail", date: "2024-02-01", date_reliable: true } },
  { value: "A", doc: { source: "gmail", date: "2024-03-01", date_reliable: true } },
  { value: "B", doc: { source: "gmail", date: "2099-01-01", date_reliable: false } },
]);
const reliableNewest = groupCandidates([
  ...unreliableNewest.flatMap((group) => group.docs.map((doc) => ({ value: group.value, doc })))
    .map((candidate) => candidate.value === "B"
      ? { ...candidate, doc: { ...candidate.doc, date_reliable: true } }
      : candidate),
]);
assert.equal(severityOf(unreliableNewest), severityOf(noDates));
assert.ok(severityOf(reliableNewest) > severityOf(unreliableNewest));
ok("only reliable dates can increase recency severity");

const ordered = sweep([
  { name: "Stable category", changes: false, candidates: [{ value: "Synthetic value", doc: { source: "drive" } }] },
  { name: "Mailing address", changes: true, candidates: address.groups.flatMap((group) => group.docs.map((doc) => ({ value: group.value, doc }))) },
  { name: "Unreturned category", changes: true, candidates: [] },
]);
const sweepText = renderSweep(ordered);
assert.equal(ordered[0].name, "Mailing address");
assert.match(sweepText, /\[T1\] Synthetic lease agreement\.pdf/);
assert.match(sweepText, /Which is current\? Nothing is written until you say\./);
assert.match(sweepText, /not proof that the corpus contains nothing/);
assert.match(sweepText, /possible date 2024-01-01; source did not verify it/);
ok("the report leads with danger, shows evidence and does not turn search absence into corpus absence");

// Current unified rows use snippet + ts and carry extraction/date provenance.
const rowsFor = (query) => {
  if (/mailing address/i.test(query)) return { results: [
    {
      snippet: `${SUBJECT} received mail at 100 Example Avenue`, source: "drive",
      source_id: "synthetic-old", title: `${SUBJECT} synthetic note`,
      ts: "2024-01-01T00:00:00.000Z", date_source: "document", date_reliable: true,
      text_source: "native", text_reliable: true,
    },
    {
      snippet: `${SUBJECT} now receives mail at 200 Sample Road`, source: "drive",
      source_id: "synthetic-new", title: `${SUBJECT} synthetic lease agreement.pdf`,
      ts: "2026-01-15T00:00:00.000Z", date_source: "document", date_reliable: true,
      text_source: "ocr_partial", text_reliable: false,
    },
  ] };
  if (/current client/i.test(query)) return { results: [{
    snippet: `${SUBJECT} has a synthetic current engagement`, source: "zoom", title: `${SUBJECT} synthetic call`,
  }] };
  return { results: [] };
};

const gathered = await gather(async ({ q }) => rowsFor(q), { subject: SUBJECT });
const parts = partition(gathered);
assert.ok(parts.structured.length > 0 && parts.freeform.length > 0);
assert.equal(parts.failed.length, 0);
const mailingCandidate = gathered.find((item) => item.name === "Mailing address")?.candidates[1];
assert.equal(mailingCandidate?.doc.date, "2026-01-15T00:00:00.000Z");
assert.equal(mailingCandidate?.doc.date_reliable, true);
assert.equal(mailingCandidate?.doc.text_source, "ocr_partial");
ok("current unified snippet, ts, date and extraction provenance reach candidates");

const multiEntity = await gather(async () => ({ results: [
  { snippet: `${SUBJECT} receives mail at 100 Example Avenue`, title: `${SUBJECT} profile`, source: "drive" },
  { snippet: "Other Example receives mail at 200 Sample Road", title: "Other Example profile", source: "drive" },
] }), {
  subject: SUBJECT,
  probes: [{ name: "Mailing address", changes: true, extract: (text) => text.match(/\d+ [A-Z][a-z]+ (?:Avenue|Road)/g) || [], query: "mailing address" }],
});
assert.equal(multiEntity[0].rows.length, 1);
assert.equal(multiEntity[0].candidates.length, 1);
assert.equal(assessProbe(multiEntity[0]).conflict, false);
assert.equal(rowMatchesSubject({ snippet: "Joanne Example has a synthetic record" }, "Ann"), false);
assert.equal(rowMatchesSubject({ snippet: "Ann has a synthetic record" }, "Ann"), true);
ok("rows explicitly about another synthetic subject cannot create a conflict");

const degraded = await gather(async () => ({
  degraded: "vector", notice: "meaning search was unavailable", results: rowsFor("mailing address").results,
}), { subject: SUBJECT, probes: [{ name: "Mailing address", changes: true, extract: () => ["x"], query: "mailing address" }] });
assert.equal(degraded[0].candidates.length, 0);
assert.match(degraded[0].error, /meaning search was unavailable/);
assert.match(renderReport(degraded, { subject: SUBJECT }).text, /NOT checked/);
ok("a partial or degraded search is unchecked even when it returned rows");

const zoneReadiness = assessZoneReadiness({
  zones: [
    { zone: "records", sources: 2, documents: 11, chunks: 39 },
    { zone: "(unzoned)", sources: 1, documents: 3, chunks: 9 },
  ],
  readiness: {
    state: "needs_review", ready: false, authorization_authority: "source_registry",
    counts: {
      sources: { registered: 3, zoned: 2, unzoned: 1 },
      documents: { total: 15, unregistered: 1, projection_drift: 2 },
      chunks: { total: 49, unregistered: 1, projection_drift: 3 },
    },
  },
});
assert.equal(zoneReadiness.checked, true);
assert.equal(zoneReadiness.ready, false);
assert.equal(zoneReadiness.state, "needs_review");
assert.equal(zoneReadiness.counts.sources.unzoned, 1);
const zoneText = renderZoneReadiness(zoneReadiness);
assert.match(zoneText, /owner-only \(no named zone\)/);
assert.match(zoneText, /1 registered source\(s\) still have no named zone/);
assert.match(zoneText, /Needs review/);
assert.match(zoneText, /Corpus rows outside the source registry: 1 document\(s\), 1 chunk\(s\)/);
assert.match(zoneText, /Zone projection mismatches: 2 document\(s\), 3 chunk\(s\)/);
assert.match(zoneText, /never assigns a zone/);
assert.equal(assessZoneReadiness({ zones: [] }).checked, false);
assert.equal(assessZoneReadiness({
  zones: [{ zone: "records", sources: "2", documents: 1, chunks: 1 }],
  readiness: zoneReadiness,
}).checked, false);
assert.match(renderZoneReadiness(unavailableZoneReadiness(new Error("synthetic endpoint failure"))), /NOT checked/);
ok("needs-review zone readiness is aggregate, read-only and fail-closed on missing or malformed proof");

const readyZoneResponse = {
  zones: [{ zone: "records", sources: 1, documents: 2, chunks: 4 }],
  readiness: {
    state: "ready", ready: true, authorization_authority: "source_registry",
    counts: {
      sources: { registered: 1, zoned: 1, unzoned: 0 },
      documents: { total: 2, unregistered: 0, projection_drift: 0 },
      chunks: { total: 4, unregistered: 0, projection_drift: 0 },
    },
  },
};
const readyZoneText = renderZoneReadiness(assessZoneReadiness(readyZoneResponse));
assert.match(readyZoneText, /Ready: all 1 registered source/);
assert.match(readyZoneText, /source registry is the authorization authority/);
assert.equal(assessZoneReadiness({
  ...readyZoneResponse,
  readiness: {
    ...readyZoneResponse.readiness,
    counts: {
      ...readyZoneResponse.readiness.counts,
      sources: { registered: 2, zoned: 1, unzoned: 1 },
    },
  },
}).checked, false);
ok("only the endpoint's ready state renders access-zone readiness as complete");

const runReport = renderReport(gathered, { subject: SUBJECT, zoneReadiness });
assert.match(runReport.text, new RegExp(`# Brain check for ${SUBJECT}`));
assert.match(runReport.text, /Worth your own eyes/);
assert.match(runReport.text, /OCR text may be incomplete/);
assert.match(runReport.text, /## Access zones/);
assert.match(runReport.text, /Nothing has been written/);
ok("one read-only report shows subject-scoped provenance and access-zone readiness");

const failedGather = await gather(async ({ q }) => {
  if (/mailing address/i.test(q)) throw new Error("synthetic search failure");
  return rowsFor(q);
}, { subject: SUBJECT });
const failedReport = renderReport(failedGather, { subject: SUBJECT, zoneReadiness });
assert.match(failedReport.text, /Could not check/);
assert.match(failedReport.text, /synthetic search failure/);
assert.match(failedReport.text, /do not read the rest as a clean bill/i);
ok("a failed probe is named rather than folded into a clean result");

const conflicts = runReport.assessed.filter((item) => item.conflict);
assert.ok(conflicts.length >= 1);
const picked = await collectAnswers(conflicts, async () => "2");
assert.equal(picked.answers.length, conflicts.length);
assert.ok(picked.answers[0].supersedes.length >= 1);
assert.equal((await collectAnswers(conflicts, async () => "")).answers.length, 0);
assert.equal((await collectAnswers(conflicts, async () => "99")).answers.length, 0);
const typed = await collectAnswers(conflicts, async () => "300 Fixture Boulevard");
assert.equal(typed.answers[0].value, "300 Fixture Boulevard");
const typedExisting = await collectAnswers(conflicts, async () => `\n  ${conflicts[0].groups[0].value}  \n`);
assert.equal(typedExisting.answers[0].value, conflicts[0].groups[0].value);
assert.ok(!typedExisting.answers[0].supersedes.includes(conflicts[0].groups[0].value));
ok("only an explicit valid choice or owner-supplied value resolves a conflict");

const confirmation = renderConfirmations(picked.answers, { today: "2026-09-05", subject: SUBJECT });
assert.match(confirmation, /Subject: Example Owner/);
assert.match(confirmation, /Operative value:/);
assert.match(confirmation, /As of: 2026-09-05, confirmed by the owner/);
assert.match(confirmation, /Supersedes:/);
assert.equal(renderConfirmations([]), null);
const envelopeOne = confirmationEnvelope(confirmation, {
  confirmedAt: "2026-09-05T12:34:56.000Z", confirmationId: "synthetic-pass-one", subject: SUBJECT,
});
const envelopeTwo = confirmationEnvelope(confirmation, {
  confirmedAt: "2026-09-05T12:34:56.000Z", confirmationId: "synthetic-pass-two", subject: SUBJECT,
});
assert.notEqual(envelopeOne.source_id, envelopeTwo.source_id);
assert.equal(envelopeOne.source_type, "curated");
assert.equal(envelopeOne.date_source, "owner_confirmation");
assert.equal(envelopeOne.date_reliable, true);
assert.equal(envelopeOne.metadata.operative, true);
assert.equal(envelopeOne.metadata.client_name, SUBJECT);
const roundTrip = {
  source: envelopeOne.source_type,
  source_id: envelopeOne.source_id,
  category: envelopeOne.metadata.category,
  client: envelopeOne.metadata.client_name,
  title: envelopeOne.title,
  snippet: confirmation,
  ts: envelopeOne.occurred_at,
  date_source: envelopeOne.date_source,
  date_reliable: envelopeOne.date_reliable,
  text_source: envelopeOne.text_source,
  text_reliable: envelopeOne.text_reliable,
  authority_meta: envelopeOne.metadata,
};
const returnedRoundTrip = {
  ...roundTrip,
  authority: authorityFor(roundTrip, { query: `Records about ${SUBJECT}. current mailing address`, current: true }),
};
delete returnedRoundTrip.authority_meta;
assert.equal(tierOf(returnedRoundTrip).tier, "T1");
const brokenTuple = { ...roundTrip, category: null };
assert.notEqual(authorityFor(brokenTuple, { query: "current mailing address", current: true }).owner_confirmed, true);
const receipt = { doc_uid: `${envelopeOne.source_type}:${envelopeOne.source_id}`, action: "created", chunks: 1 };
assert.equal(validateConfirmationReceipt(receipt, envelopeOne), receipt);
assert.equal(validateConfirmationReceipt({ ...receipt, action: "unchanged" }, envelopeOne).action, "unchanged");
assert.throws(() => validateConfirmationReceipt({ ...receipt, action: "updated" }, envelopeOne), /did not confirm the exact/);
ok("owner confirmations round-trip as T1, use unique identities and require an exact creation receipt");

const confirmationRoundTrip = await gather(async () => ({ results: [{
  ...returnedRoundTrip,
}] }), {
  subject: SUBJECT,
  probes: [{
    name: "Mailing address", changes: true, query: "mailing address",
    extract: (text) => text.match(/\d+ [A-Z][a-z]+ (?:Avenue|Road|Boulevard)/g) || [],
  }],
});
assert.deepEqual(confirmationRoundTrip[0].candidates.map((candidate) => candidate.value), [picked.answers[0].value]);
for (const superseded of picked.answers[0].supersedes) {
  assert.ok(!confirmationRoundTrip[0].candidates.some((candidate) => candidate.value === superseded));
}
ok("a later check reads only the operative value and never resurrects Supersedes as T1 evidence");

// Command wiring, with network, prompt and write injected.
const { cmdCheck } = await import("../brain.mjs");
const dir = mkdtempSync(join(tmpdir(), "brain-check-synthetic-"));
const manifestPath = join(dir, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture", display_name: SUBJECT },
  brain: { version: "0.4.0", domain: "fixture.invalid", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: "a".repeat(32), storage: "d1", d1_database_name: "fixture-brain" } },
}, null, 2));
const readZones = async () => readyZoneResponse;
let querySeen = "";
const searchStub = async ({ q }) => { querySeen = q; return rowsFor(q); };
let wrote = false;
const readOnly = await cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: {},
  search: searchStub, readZones, write: async () => { wrote = true; },
});
assert.equal(readOnly.wrote, false);
assert.equal(wrote, false);
assert.equal(readOnly.zones_checked, true);
assert.equal(readOnly.zones_ready, true);
assert.match(querySeen, /Records about Example Owner/);
assert.ok(readOnly.conflicts >= 1);
ok("brain check is subject-scoped and read-only by default");

let writtenEnvelope = null;
const setResult = await cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { set: true },
  search: searchStub, readZones, ask: async () => "2",
  confirmedAt: "2026-09-05T12:34:56.000Z", confirmationId: "synthetic-command-pass",
  write: async (candidate) => {
    writtenEnvelope = candidate;
    return { doc_uid: `${candidate.source_type}:${candidate.source_id}`, action: "created", chunks: 1 };
  },
});
assert.equal(setResult.wrote, true);
assert.equal(writtenEnvelope.metadata.client_name, SUBJECT);
assert.match(writtenEnvelope.content, /Operative value:/);
ok("--set writes one uniquely identified record after explicit owner answers and exact receipt proof");

let wroteOnUnsure = false;
const unsureResult = await cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { set: true },
  search: searchStub, readZones, ask: async () => "",
  write: async () => { wroteOnUnsure = true; },
});
assert.equal(unsureResult.wrote, false);
assert.equal(wroteOnUnsure, false);
ok("--set writes nothing when the owner resolves nothing");

await assert.rejects(cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { set: true },
  search: searchStub, readZones, ask: async () => "2",
  confirmedAt: "2026-09-05T12:34:56.000Z", confirmationId: "synthetic-bad-receipt",
  write: async () => ({ ok: true }),
}), /Nothing was declared saved/);
await assert.rejects(cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { unexpected: true },
  search: searchStub, readZones,
}), /unknown option --unexpected for `brain check`/);
await assert.rejects(cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { subject: true },
  search: searchStub, readZones,
}), /--subject needs a person or organization name/);
await assert.rejects(cmdCheck(manifestPath, {
  adminKey: "synthetic", baseUrl: "https://fixture.invalid", flags: { set: "false" },
  search: searchStub, readZones,
}), /--set is a switch and does not take a value/);
ok("the command refuses unknown flags and never calls an ambiguous ingest receipt saved");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed`);
