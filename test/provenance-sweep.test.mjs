// The tiering and the sweep, tested against the four real failures that
// produced them. Each case below happened on a live brain on 2026-09-03.
import assert from "node:assert/strict";
import { agreementVerdict, bestTier, tierOf, OWNER_CONFIRMED_SOURCE } from "../operations/provenance.mjs";
import { assessProbe, groupCandidates, renderSweep, severityOf, sweep } from "../operations/contradiction-sweep.mjs";

let pass = 0;
const ok = (n) => { pass++; console.log(`PASS  ${n}`); };

// --- tiers ---
assert.equal(tierOf({ source: "plaid" }).tier, "T1");
assert.equal(tierOf({ source: "drive", title: "Registrar letter.pdf" }).tier, "T1");
assert.equal(tierOf({ source: "drive", title: "Q3 invoice.pdf" }).tier, "T2");
assert.equal(tierOf({ source: "gmail", title: "re: the house" }).tier, "T3");
assert.equal(tierOf({ source: "zoom", title: "Weekly sync" }).tier, "T4");
assert.equal(tierOf({ source: "drive", title: "Call notes 2021.md" }).tier, "T4");
ok("a machine feed and a registrar letter outrank an invoice, an email and a meeting note");

assert.equal(tierOf({ source: OWNER_CONFIRMED_SOURCE }).tier, "T1");
assert.match(tierOf({ source: OWNER_CONFIRMED_SOURCE }).reason, /you confirmed this yourself/);
ok("what the owner confirmed is primary, and says why in their own terms");

for (const d of [{ source: "plaid" }, { source: "zoom" }, { source: "drive", title: "x" }]) {
  assert.ok(tierOf(d).reason && tierOf(d).reason.length > 8, "every verdict carries its reason");
}
assert.equal(bestTier([]).tier, "T0");
ok("no verdict is ever returned without the rule that produced it, and absence is its own tier");

// --- the inversion, which is the whole point ---
const softPile = [{ source: "zoom", title: "call" }, { source: "drive", title: "meeting notes" }, { source: "imessage" }];
const soft = agreementVerdict(softPile, { changes: true });
assert.equal(soft.confident, false);
assert.equal(soft.caution, true);
assert.match(soft.line, /agreement among records like these tracks how long something has been written down/);
ok("three soft records agreeing about a CHANGING fact is a caution, not a confirmation");

const stable = agreementVerdict(softPile, { changes: false });
assert.equal(stable.confident, true);
ok("the same three records agreeing about a fact that does NOT change is fine");

const withPrimary = agreementVerdict([...softPile, { source: "drive", title: "Divorce decree.pdf" }], { changes: true });
assert.equal(withPrimary.confident, true);
ok("one primary record settles what any number of soft ones could not");

// --- the real mailing-address failure: four agreeing sources, all wrong ---
const address = assessProbe({
  name: "Mailing address", changes: true,
  candidates: [
    { value: "4180 W Juniper Ave", doc: { source: "drive", title: "Court exhibit B.pdf", date: "2021-04-02" } },
    { value: "4180 W Juniper Ave", doc: { source: "drive", title: "Patient intake.pdf", date: "2022-01-11" } },
    { value: "4180 W Juniper Ave", doc: { source: "imessage", date: "2022-06-30" } },
    { value: "4180 w juniper ave", doc: { source: "gmail", title: "shipping", date: "2023-02-02" } },
    { value: "77 N Kestrel Way", doc: { source: "drive", title: "Lease agreement.pdf", date: "2026-01-15" } },
  ],
});
assert.equal(address.conflict, true);
assert.equal(address.groups.length, 2, "case and spacing differences are the same value");
assert.equal(address.groups[0].docs.length, 4, "the stale value is the popular one");
assert.equal(address.verdict.caution, true, "and the pile must NOT read as confidence");
ok("the four-agreeing-sources address failure is caught, and the majority does not win");

// --- severity ranks danger, not novelty ---
const dangerous = severityOf(address.groups);
const safe = severityOf(groupCandidates([
  { value: "A", doc: { source: "plaid" } },
  { value: "B", doc: { source: "drive", title: "Bank statement.pdf" } },
]));
assert.ok(dangerous > safe, "a soft majority outvoting something better is the dangerous shape");
ok("worst-first means most likely to produce a confident wrong answer, not most values");

// --- ordering and absence ---
const ordered = sweep([
  { name: "Degree", changes: false, candidates: [{ value: "BBA", doc: { source: "drive", title: "resume.pdf" } }] },
  { name: "Mailing address", changes: true, candidates: address.groups.flatMap((g) => g.docs.map((d) => ({ value: g.value, doc: d }))) },
  { name: "Current insurer", changes: true, candidates: [] },
]);
assert.equal(ordered[0].name, "Mailing address", "the dangerous one is read first");
assert.equal(ordered.find((o) => o.name === "Current insurer").missing, true);
ok("the sweep leads with the most dangerous conflict and reports absence as absence");

// --- the report shows evidence beside every verdict ---
const report = renderSweep(ordered);
assert.match(report, /Mailing address/);
assert.match(report, /\[T1\] Lease agreement\.pdf/, "each record is shown with its tier");
assert.match(report, /Which is current\? Nothing is written until you say\./);
assert.match(report, /records gap, not a contradiction/);
ok("the report never prints a verdict without the records behind it, and asks rather than decides");

console.log(`\n${pass} passed`);

// --- the run: gather, report, confirm. Every side effect injected. ---
const run = await import("../operations/check-run.mjs");

const rowsFor = (q) => {
  if (/mailing address/i.test(q)) return { results: [
    { text: "mail to 4180 W Juniper Ave", source: "drive", title: "Court exhibit B.pdf", document_date: "2021-04-02" },
    { text: "shipped to 4180 W Juniper Ave", source: "imessage", document_date: "2022-06-30" },
    { text: "the lease is for 77 N Kestrel Way", source: "drive", title: "Lease agreement.pdf", document_date: "2026-01-15" },
  ] };
  if (/current client/i.test(q)) return { results: [{ text: "retainer with Acme", source: "zoom", title: "call" }] };
  return { results: [] };
};

const gathered = await run.gather(async ({ q }) => rowsFor(q));
const parts = run.partition(gathered);
assert.ok(parts.structured.length > 0 && parts.freeform.length > 0);
assert.equal(parts.failed.length, 0);
ok("a run separates what can be grouped from what only a person can read");

const runReport = run.renderReport(gathered);
assert.match(runReport.text, /Mailing address/);
assert.match(runReport.text, /Worth your own eyes/);
assert.match(runReport.text, /Nothing has been written/);
ok("the report offers freeform records for reading and promises nothing was written");

// A probe that errors must be named, never swallowed into a clean bill.
const withFailure = await run.gather(async ({ q }) => {
  if (/mailing address/i.test(q)) throw new Error("brain unreachable");
  return rowsFor(q);
});
const failedReport = run.renderReport(withFailure);
assert.match(failedReport.text, /Could not check/);
assert.match(failedReport.text, /brain unreachable/);
assert.match(failedReport.text, /do not read the rest as a clean bill/i);
ok("a probe that fails is reported as unchecked rather than passing silently");

// --- the owner decides, and silence is not a decision ---
const conflicts = runReport.assessed.filter((a) => a.conflict);
assert.ok(conflicts.length >= 1);
const picked = await run.collectAnswers(conflicts, async () => "2");
assert.equal(picked.answers.length, conflicts.length);
assert.ok(picked.answers[0].supersedes.length >= 1, "the values not chosen are recorded as superseded");
ok("choosing an option records it and names what it supersedes");

const unsure = await run.collectAnswers(conflicts, async () => "");
assert.equal(unsure.answers.length, 0);
assert.equal(unsure.unresolved.length, conflicts.length);
ok("an empty answer is UNRESOLVED, never resolved by silence or by the majority");

const typed = await run.collectAnswers(conflicts, async () => "77 Somewhere New Rd");
assert.equal(typed.answers[0].value, "77 Somewhere New Rd");
assert.match(typed.answers[0].note, /supplied by the owner/);
ok("an owner can supply a value no record contains, and it is marked as theirs");

const bogus = await run.collectAnswers(conflicts, async () => "99");
assert.equal(bogus.answers.length, 0, "a number that is not on the list resolves nothing");
ok("an out-of-range choice is unresolved rather than silently mapped to something");

// --- what gets written, and what makes it outrank the pile ---
const doc = run.renderConfirmations(picked.answers, { today: "2026-09-04" });
assert.match(doc, /# Confirmed by the owner, 2026-09-04/);
assert.match(doc, /Operative value:/);
assert.match(doc, /As of: 2026-09-04, confirmed by the owner/);
assert.match(doc, /Supersedes:/);
ok("a confirmation carries the value, the date, and what it replaces");

assert.equal(run.renderConfirmations([]), null, "no answers writes no document");
ok("a pass where the owner resolved nothing writes nothing at all");

const env = run.confirmationEnvelope(doc, { today: "2026-09-04" });
assert.equal(env.source, "owner-confirmed");
assert.equal(tierOf({ source: env.source }).tier, "T1");
ok("the written record is primary, because the owner made it about the present on purpose");

console.log(`\n${pass} passed`);
