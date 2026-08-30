// Coverage staleness: what the brain has not LOOKED at, as distinct from the age
// of what it retrieved.
//
// The two tests that matter most here are the ones asserting SILENCE. A warning
// that fires for something nobody can act on is how clients learn to ignore the
// warning that matters, and this feature only earns its place if it stays quiet
// when quiet is correct.

import { coverageGaps, freshnessReport } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const NOW = Date.parse("2026-08-19T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const hoursAgo = (h) => NOW - h * 3600000;
const mk = (rows) => ({ DB: { prepare: () => ({ all: async () => ({ results: rows }), bind() { return this; } }) } });
const DAILY = 86400;

/* ---- it warns when a source we CAN refresh has gone unread ---- */
{
  const g = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: daysAgo(40), expected_refresh_seconds: DAILY }]), { now: NOW });
  check("an overdue connector produces a gap", g.length === 1 && g[0].type === "coverage_stale", JSON.stringify(g));
  check("and says how long it has been", g[0].days_since_ingest === 40, JSON.stringify(g[0]));
  check("and says material added since is invisible, not merely old",
    /not in the brain/.test(g[0].detail) && /would not show up as a missing answer/.test(g[0].detail), g[0].detail);
}

/* ---- SILENCE 1: a finished one-off load is not stale, it is done ---- */
{
  const g = await coverageGaps(mk([{ name: "documents", kind: "upload", last_ingest_at: daysAgo(400), expected_refresh_seconds: null }]), { now: NOW });
  check("a source with no expected refresh makes NO claim, even after 400 days", g.length === 0, JSON.stringify(g));
}

/* ---- SILENCE 2: late is not broken ---- */
{
  const g = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: daysAgo(1.25), expected_refresh_seconds: DAILY }]), { now: NOW });
  check("six hours late on a daily schedule does not warn", g.length === 0, JSON.stringify(g));
  const g2 = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: daysAgo(2), expected_refresh_seconds: DAILY }]), { now: NOW });
  check("but twice the expected interval does", g2.length === 1, JSON.stringify(g2));
}

/* ---- a broken connector names the reason ---- */
{
  const g = await coverageGaps(mk([{ name: "gmail", kind: "gmail", last_ingest_at: daysAgo(9), stale_reason: "auth_expired", expected_refresh_seconds: DAILY }]), { now: NOW });
  check("a broken sync is its own gap type", g[0]?.type === "sync_broken", JSON.stringify(g));
  check("and names the cause verbatim, so it is actionable", /auth_expired/.test(g[0].detail), g[0].detail);
}

/* ---- connector-reported failure is broken immediately, schedule or not ---- */
{
  const rows = [{
    name: "drive", kind: "drive", status: "error", last_ingest_at: daysAgo(0.1),
    stale_reason: null, expected_refresh_seconds: null,
  }];
  const f = await freshnessReport(mk(rows), { now: NOW });
  check("source status=error is surfaced as broken", f.sources[0]?.state === "broken", JSON.stringify(f));
  check("a status-only error still has an actionable non-null reason",
    /last sync reported an error/.test(f.sources[0]?.reason || ""), JSON.stringify(f.sources[0]));
  check("the underlying source status is retained in the report",
    f.sources[0]?.source_status === "error", JSON.stringify(f.sources[0]));
  const g = await coverageGaps(mk(rows), { now: NOW });
  check("a connector-reported error also qualifies retrieved answers",
    g[0]?.type === "sync_broken" && /last sync reported an error/.test(g[0]?.detail || ""), JSON.stringify(g));
}

/* ---- a live run is distinct from a crashed or stuck run ---- */
{
  const active = {
    name: "drive", kind: "drive", status: "indexing", indexing_started_at: hoursAgo(5),
    last_ingest_at: daysAgo(1), expected_refresh_seconds: DAILY,
  };
  const atLimit = { ...active, name: "gmail", kind: "gmail", indexing_started_at: hoursAgo(6) };
  const stuck = { ...active, name: "calendar", kind: "calendar", indexing_started_at: hoursAgo(6.01) };
  const orphaned = { ...active, name: "drive-orphaned", indexing_started_at: null };
  const f = await freshnessReport(mk([active, atLimit, stuck, orphaned]), { now: NOW });
  const by = Object.fromEntries(f.sources.map((s) => [s.name, s]));
  check("an indexing run younger than six hours remains in progress",
    by.drive.state === "indexing" && by.drive.hours_indexing === 5, JSON.stringify(by.drive));
  check("six hours exactly is not called stuck", by.gmail.state === "indexing", JSON.stringify(by.gmail));
  check("an indexing run older than six hours is broken",
    by.calendar.state === "broken" && /6 hour/.test(by.calendar.reason || ""), JSON.stringify(by.calendar));
  check("an indexing row with no open run is treated as interrupted",
    by["drive-orphaned"].state === "broken" && /no open sync run/.test(by["drive-orphaned"].reason || ""), JSON.stringify(by["drive-orphaned"]));

  const g = await coverageGaps(mk([stuck]), { now: NOW });
  check("a stuck run becomes a sync_broken answer gap",
    g[0]?.type === "sync_broken" && /not completed/.test(g[0]?.detail || ""), JSON.stringify(g));
}

/* ---- never synced is distinct from stale ---- */
{
  const g = await coverageGaps(mk([{ name: "drive", kind: "drive", last_ingest_at: null, expected_refresh_seconds: DAILY }]), { now: NOW });
  check("a source expected to refresh but never synced says so", g[0]?.type === "never_synced", JSON.stringify(g));
}

/* ---- it must never break an answer ---- */
{
  const broken = { DB: { prepare: () => { throw new Error("no such table: sources"); } } };

  // Catch explicitly. An uncaught throw here would abort the whole file, which
  // reports as zero failures rather than one, so the assertion has to own the
  // error path itself.
  let g = null, threw = null;
  try { g = await coverageGaps(broken, { now: NOW }); } catch (e) { threw = e.message; }
  check("a database error returns no gaps rather than throwing into the answer path",
    threw === null && Array.isArray(g) && g.length === 0, threw ? `it threw: ${threw}` : JSON.stringify(g));

  let f = null, threw2 = null;
  try { f = await freshnessReport(broken, { now: NOW }); } catch (e) { threw2 = e.message; }
  check("and the report degrades rather than throwing", threw2 === null && f?.unavailable === true,
    threw2 ? `it threw: ${threw2}` : JSON.stringify(f));
}

/* ---- the report distinguishes what we can fix from what we cannot ---- */
{
  const f = await freshnessReport(mk([
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: daysAgo(40), expected_refresh_seconds: DAILY, document_count: 900 },
    { name: "documents", kind: "upload", status: "ready", last_ingest_at: daysAgo(400), document_count: 61 },
    { name: "gmail", kind: "gmail", status: "ready", last_ingest_at: daysAgo(2), document_count: 10 },
  ]), { now: NOW });
  const by = Object.fromEntries(f.sources.map((s) => [s.name, s]));
  check("an overdue connector reads stale", by.drive.state === "stale", JSON.stringify(by.drive));
  check("a laptop folder reads MANUAL, never stale", by.documents.state === "manual", JSON.stringify(by.documents));
  check("and is marked as one we cannot refresh ourselves", by.documents.automatable === false);
  check("a connector with no schedule reads unscheduled, not broken", by.gmail.state === "unscheduled", JSON.stringify(by.gmail));
  check("and IS marked automatable, because it could be scheduled", by.gmail.automatable === true);
}

console.log(`\nfreshness: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
