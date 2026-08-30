// Freshness in the acceptance suite: a PER-SOURCE claim, never a corpus-wide one.
//
// The defect this file exists to keep dead: acceptance took the newest ingest
// timestamp across every source, sorted descending, took element zero, and
// recorded "corpus is fresh" if that one value was under two days old. Any
// install with a fast source — message capture ticks every minute — therefore
// passed forever, including while the client's largest corpus had been dead for
// half a year. It was a global claim supported by a single source, and it was
// the instrument a money-back guarantee is judged against.
//
// The first block below is the decisive one. It runs the REAL Acceptance tier
// against a fixture whose message source was written seconds ago and whose
// daily-scheduled Drive source has not been read in six months, and requires a
// FAIL that NAMES drive. Restore the old max-across-sources logic and that
// block fails, which is the only reason to trust the rest.
//
// The freshness payload is produced by the WORKER's own freshnessReport, not by
// a hand-written JSON blob, so this also proves the acceptance suite and
// `brain sources` cannot disagree about the same install.

import { Acceptance, freshnessVerdicts } from "../acceptance.mjs";
import { freshnessReport } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const NOW = Date.parse("2026-08-28T09:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();
const MINUTE = 60, DAY = 86400;

const manifest = {
  client: { slug: "morgan-diaz", display_name: "Morgan Diaz" },
  infrastructure: { cloudflare: { storage: "d1" } },
};

/** The worker's own report, from source-table rows, at a fixed clock. */
const reportFor = (rows) =>
  freshnessReport(
    { DB: { prepare: () => ({ all: async () => ({ results: rows }), bind() { return this; } }) } },
    { now: NOW },
  );

/**
 * A fully healthy /documents payload, so the ONLY thing that can fail a tier-2
 * run in these fixtures is freshness. `last_ingested` deliberately carries the
 * fast source's very recent timestamp: that is the exact value the old
 * max-across-sources check read, and reading it is what made the bug invisible.
 */
function documentsPayload(rows) {
  const docRows = rows.map((r) => ({
    source_type: r.name,
    total: Number(r.document_count || 1),
    embedded: Number(r.document_count || 1),
    last_ingested: r.last_ingest_at,
  }));
  const total = docRows.reduce((a, r) => a + r.total, 0);
  return {
    backend: "d1",
    rows: docRows,
    vector_readiness: {
      ready: true, expected_vectors: total, actual_vectors: total, pending: 0, submitted: 0,
    },
  };
}

/** Run the real tier-2 checks against a fixture install. */
async function tierDataFor(rows) {
  const freshness = await reportFor(rows);
  const suite = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest,
    fetchImpl: async (url) => {
      const body = String(url).includes("/freshness") ? freshness : documentsPayload(rows);
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  await suite.tierData();
  return suite;
}

const named = (suite, needle) =>
  suite.results.filter((r) => `${r.name} ${r.detail}`.toLowerCase().includes(needle));

/* ================================================================
   1. THE DECISIVE CASE
   One source written seconds ago, one expected-daily source dead for
   six months. The old logic called this install fresh.
   ================================================================ */
{
  const rows = [
    // Ticks every minute. Its timestamp is always recent, which is exactly why
    // it used to certify the whole corpus.
    { name: "imessage", kind: "imessage", status: "ready", last_ingest_at: ago(20),
      expected_refresh_seconds: MINUTE, document_count: 41_000 },
    // The client's real working corpus. Nothing has read it since February.
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: ago(183 * DAY),
      expected_refresh_seconds: DAY, document_count: 12_400 },
  ];
  const suite = await tierDataFor(rows);
  const failures = suite.results.filter((r) => r.status === "fail");

  check("a source dead for six months FAILS the run, even beside a source written seconds ago",
    failures.length > 0, JSON.stringify(suite.results, null, 1));
  check("the failure NAMES the stale source, because \"something is stale\" is not actionable",
    failures.some((r) => /drive/.test(`${r.name} ${r.detail}`)),
    JSON.stringify(failures));
  check("and does not blame the source that is actually current",
    !failures.some((r) => /imessage/.test(`${r.name} ${r.detail}`)),
    JSON.stringify(failures));
  check("the failure says how long it has been dead",
    failures.some((r) => /183 day/.test(r.detail || "")), JSON.stringify(failures));
  check("and says what it was supposed to do, so the claim is checkable",
    failures.some((r) => /expected to refresh about every 1 day/.test(r.detail || "")),
    JSON.stringify(failures));
  check("the consequence is stated: material added since is invisible, not merely old",
    failures.some((r) => /not in the brain/.test(r.detail || "")), JSON.stringify(failures));
  check("it is a FAIL, not a warning: this is the instrument a guarantee is judged against",
    !suite.results.some((r) => r.status === "warn" && /drive/.test(r.detail || "")),
    JSON.stringify(suite.results.filter((r) => r.status === "warn")));
  check("no check anywhere in the tier calls this corpus fresh",
    !suite.results.some((r) => r.status === "pass" && /fresh|current/i.test(r.name)),
    JSON.stringify(suite.results.filter((r) => r.status === "pass").map((r) => r.name)));
}

/* ================================================================
   2. A SOURCE WITH NO REFRESH EXPECTATION IS NEVER JUDGED STALE
   A one-time history load was finished, not neglected.
   ================================================================ */
{
  const rows = [
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: ago(2 * 3600),
      expected_refresh_seconds: DAY, document_count: 900 },
    // Loaded by hand from a laptop we cannot reach. It was never going to update.
    { name: "iphone-backup", kind: "upload", status: "ready", last_ingest_at: ago(400 * DAY),
      expected_refresh_seconds: null, document_count: 55_000 },
  ];
  const suite = await tierDataFor(rows);
  check("a source with no refresh expectation is not stale after 400 days",
    suite.results.every((r) => r.status !== "fail"),
    JSON.stringify(suite.results.filter((r) => r.status === "fail")));
  check("and the run still passes overall", suite.summary().passed, JSON.stringify(suite.summary().counts));
  check("but it is not hidden either: the report says how many are never judged",
    named(suite, "never judged stale").length === 1,
    JSON.stringify(suite.results.map((r) => r.detail)));
}

/* ================================================================
   3. AN UNSCHEDULED SOURCE IS REPORTED HONESTLY
   Nothing schedules Drive on Windows or Linux. The product must say so
   rather than pass quietly.
   ================================================================ */
{
  const rows = [
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: ago(3 * DAY),
      expected_refresh_seconds: null, document_count: 12_400 },
  ];
  const suite = await tierDataFor(rows);
  const line = suite.results.find((r) => r.name === "freshness: drive");
  check("an automatable source with no schedule is reported, not silently green",
    line !== undefined, JSON.stringify(suite.results.map((r) => r.name)));
  check("it is a warning, because an absent schedule is not a dead corpus",
    line?.status === "warn", JSON.stringify(line));
  check("and it says plainly that nothing will refresh it",
    /NO REFRESH IS SCHEDULED/.test(line?.detail || ""), JSON.stringify(line));
  check("no check claims it is fresh",
    !suite.results.some((r) => r.status === "pass" && /drive/.test(r.detail || "")),
    JSON.stringify(suite.results.filter((r) => r.status === "pass")));
  check("an unscheduled source is never ALSO called stale, three days after its last read",
    !suite.results.some((r) => r.status === "fail" || /STALE —/.test(r.detail || "")),
    JSON.stringify(suite.results.map((r) => r.detail)));
  check("and the headline refuses the vacuous \"0 of 0 current\" green",
    named(suite, "nothing here is being kept current").length === 1,
    JSON.stringify(suite.results.map((r) => `${r.status} ${r.detail}`)));
}

/* ================================================================
   4. A GENUINELY FRESH INSTALL STILL PASSES
   Paranoia that fails everything is the same uselessness in the other
   direction.
   ================================================================ */
{
  const rows = [
    { name: "imessage", kind: "imessage", status: "ready", last_ingest_at: ago(30),
      expected_refresh_seconds: MINUTE, document_count: 41_000 },
    { name: "drive", kind: "drive", status: "ready", last_ingest_at: ago(6 * 3600),
      expected_refresh_seconds: DAY, document_count: 12_400 },
    { name: "gmail", kind: "gmail", status: "ready", last_ingest_at: ago(30 * 3600),
      expected_refresh_seconds: DAY, document_count: 8_100 },
  ];
  const suite = await tierDataFor(rows);
  check("every scheduled source current passes the whole tier",
    suite.summary().passed && suite.summary().counts.warn === 0,
    JSON.stringify(suite.results.filter((r) => r.status !== "pass")));
  check("six hours late on a daily schedule is still current, not a warning",
    suite.results.every((r) => r.status === "pass"), JSON.stringify(suite.results));
  check("the passing line counts the sources it actually judged",
    named(suite, "3 of 3 scheduled source(s) current").length === 1,
    JSON.stringify(suite.results.map((r) => r.detail)));
}

/* ================================================================
   5. A CHECK THAT CANNOT RUN SAYS SO. IT NEVER PASSES.
   ================================================================ */
{
  const unreachable = freshnessVerdicts({ ok: false, status: 404, payload: null, expectedBackend: "d1" });
  check("a Worker with no freshness endpoint FAILS rather than passing silently",
    unreachable.length === 1 && unreachable[0].status === "fail", JSON.stringify(unreachable));
  check("and says freshness is unverified rather than implying it is fine",
    /UNVERIFIED/.test(unreachable[0].detail), unreachable[0].detail);

  const degraded = freshnessVerdicts({ ok: true, status: 200, payload: { sources: [], unavailable: true } });
  check("a Worker that cannot read its own sources table FAILS",
    degraded[0].status === "fail" && /could not read/.test(degraded[0].detail), JSON.stringify(degraded));

  const shapeless = freshnessVerdicts({ ok: true, status: 200, payload: { ok: true } });
  check("a 200 with no per-source list is not a pass",
    shapeless[0].status === "fail", JSON.stringify(shapeless));

  const empty = freshnessVerdicts({ ok: true, status: 200, payload: { sources: [] } });
  check("an install with no registered sources makes no freshness claim at all",
    empty[0].status === "warn" && /nothing here can be judged/.test(empty[0].detail),
    JSON.stringify(empty));

  const other = freshnessVerdicts({ ok: false, status: 400, payload: null, expectedBackend: "supabase" });
  check("a backend this instrument does not cover is skipped and named, not failed",
    other[0].status === "skip" && /supabase/.test(other[0].detail), JSON.stringify(other));
}

/* ================================================================
   6. BROKEN AND NEVER-SYNCED ARE FAILURES TOO, AND CARRY THEIR CAUSE
   ================================================================ */
{
  const rows = [
    { name: "gmail", kind: "gmail", status: "ready", last_ingest_at: ago(9 * DAY),
      stale_reason: "the refresh token was revoked", expected_refresh_seconds: DAY, document_count: 8_100 },
    { name: "calendar", kind: "calendar", status: "ready", last_ingest_at: null,
      expected_refresh_seconds: DAY, document_count: 0 },
  ];
  const suite = await tierDataFor(rows);
  const by = Object.fromEntries(suite.results.map((r) => [r.name, r]));
  check("a broken connector fails and repeats its cause verbatim",
    by["freshness: gmail"]?.status === "fail" && /refresh token was revoked/.test(by["freshness: gmail"].detail),
    JSON.stringify(by["freshness: gmail"]));
  check("a source expected to refresh that never has is its own named failure",
    by["freshness: calendar"]?.status === "fail" && /never completed a sync/.test(by["freshness: calendar"].detail),
    JSON.stringify(by["freshness: calendar"]));
  check("the headline counts both, so the summary line cannot understate the damage",
    /2 of 2 scheduled source\(s\) have stopped updating/.test(
      by["every source expected to refresh is current"]?.detail || ""),
    JSON.stringify(by["every source expected to refresh is current"]));
}

console.log(`\nacceptance freshness: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
