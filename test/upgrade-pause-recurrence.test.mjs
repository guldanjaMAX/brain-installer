/**
 * A pause that keeps coming back.
 *
 * WHAT THIS IS DEFENDING, measured on a live install on 2026-08-28
 *
 * One brain stranded itself mid-upgrade twice in a single day. /health reported
 * the pause honestly each time, and `brain doctor` read it, so both events were
 * seen. What nobody saw is that they were the same event twice: between them the
 * brain reported healthy, so the second arrived looking like a first.
 *
 * Those are different problems and they call for different responses. A pause
 * that happened once is a bad day. A pause that recurs is a broken upgrade path,
 * and the next one lands on a client who paid. The difference is written down in
 * the upgrade_runs table and nowhere else, which means it is only ever found by
 * someone who already suspects it.
 *
 * The two properties these tests pin are in tension, and both matter:
 *   1. more than one pause is COUNTED and the earlier ones are named with their
 *      dates, so an operator meets the recurrence without going to look for it;
 *   2. a brain that has never stranded says nothing at all, because an extra
 *      paragraph on every healthy install is how a real signal gets scrolled past.
 *
 * This changes only what is REPORTED. Nothing here repairs an upgrade.
 *
 * Every name and domain here is invented. This repository is public.
 */
import { writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradePauseRecurrence, UPGRADE_RUN_COMPLETED } from "../doctor.mjs";
import { readUpgradePauseHistory, diagnoseStuckUpgrade } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const FIRST = "2026-08-28T09:12:04Z";
const SECOND = "2026-08-28T16:41:37Z";
const THIRD = "2026-08-29T08:03:52Z";
const run = (started_at, status, extra = {}) => ({
  started_at, status, from_version: "0.1.21", to_version: "0.1.22", detail: "stage:migrate", ...extra,
});

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-pause-recurrence-")));
const manifestAt = (name, cloudflare) => {
  const path = join(sandbox, name);
  writeFileSync(path, JSON.stringify({
    client: { slug: "osei" },
    brain: { worker_name: "osei-brain", domain: "brain.example.test" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1", ...cloudflare } },
  }));
  return path;
};

/* ================================================================== */
/* 1. Quiet at zero. This is half the value of the check.              */
/* ================================================================== */
{
  check("no history at all says nothing", upgradePauseRecurrence([]).note === "", JSON.stringify(upgradePauseRecurrence([])));
  check("a null history says nothing", upgradePauseRecurrence(null).note === "");
  check("junk rows are ignored rather than counted",
    upgradePauseRecurrence([null, "x", 7]).note === "" && upgradePauseRecurrence([null, "x", 7]).total === 0);

  const clean = upgradePauseRecurrence([
    run(FIRST, UPGRADE_RUN_COMPLETED), run(SECOND, "verified"),
  ]);
  check("a brain whose every upgrade finished says nothing", clean.note === "" && clean.total === 0, JSON.stringify(clean));

  // The pause being reported right now is not news. Repeating it under a
  // "this has happened before" heading would be the check crying wolf.
  const onlyCurrent = upgradePauseRecurrence([run(SECOND, "started")], { currentlyPaused: true });
  check("a first-ever pause, happening now, adds nothing",
    onlyCurrent.note === "" && onlyCurrent.total === 1 && onlyCurrent.previous === 0, JSON.stringify(onlyCurrent));
}

/* ================================================================== */
/* 2. More than one pause is counted, and the earlier ones are named.  */
/* ================================================================== */
{
  const paused = upgradePauseRecurrence([run(SECOND, "started"), run(FIRST, "failed")], { currentlyPaused: true });
  check("two pauses are counted", paused.total === 2, JSON.stringify(paused));
  check("and one of them is prior, not just the current one", paused.previous === 1, JSON.stringify(paused));
  check("the wording says which number this is", /This is pause number 2 on this brain/.test(paused.note), paused.note);
  check("and says it is not the first", /It is not the first/.test(paused.note), paused.note);
  check("the earlier pause is dated", paused.note.includes(FIRST), paused.note);
  check("and so is the current one, so the two can be told apart", paused.note.includes(SECOND), paused.note);
  check("each run carries its status", /failed/.test(paused.note) && /started/.test(paused.note), paused.note);
  check("and the stage it died at", /stage:migrate/.test(paused.note), paused.note);
  check("and the versions it was moving between", /0\.1\.21 -> 0\.1\.22/.test(paused.note), paused.note);
  check("it names why recurrence matters rather than leaving it to be inferred",
    /broken upgrade path rather than a bad\n  day/.test(paused.note), paused.note);
  check("and it names the reason each one looks like a first",
    /reported itself healthy between these/i.test(paused.note), paused.note);
  check("and it hands over the query for the rest", /SELECT \* FROM upgrade_runs/.test(paused.note), paused.note);
}

/* ================================================================== */
/* 3. The case the current-state report can never show: healthy NOW.   */
/* ================================================================== */
{
  const healthy = upgradePauseRecurrence([run(SECOND, "rolled_back"), run(FIRST, "failed")]);
  check("a brain that is fine right now still reports its earlier pauses",
    healthy.note !== "" && healthy.total === 2, JSON.stringify(healthy));
  check("and both are counted as prior, because none is happening now", healthy.previous === 2, JSON.stringify(healthy));
  check("the wording says it is not paused now", /not paused now/i.test(healthy.note), healthy.note);
  check("and gives the count of earlier strandings", /stranded mid-upgrade 2 time\(s\) before/.test(healthy.note), healthy.note);
  check("both dates are present", healthy.note.includes(FIRST) && healthy.note.includes(SECOND), healthy.note);

  const single = upgradePauseRecurrence([run(FIRST, "failed")]);
  check("even ONE earlier pause is surfaced on a healthy brain, since that is how the second one starts",
    single.note !== "" && single.previous === 1, JSON.stringify(single));

  // A run still marked `started` long after the fact did not finish, it stopped.
  const stillStarted = upgradePauseRecurrence([run(FIRST, "started")]);
  check("an upgrade left in `started` counts as a pause", stillStarted.total === 1, JSON.stringify(stillStarted));
  const mixed = upgradePauseRecurrence([run(THIRD, "verified"), run(SECOND, "failed"), run(FIRST, "rolled_back")]);
  check("a later successful upgrade does not erase the pauses behind it",
    mixed.total === 2 && mixed.note.includes(FIRST) && mixed.note.includes(SECOND), JSON.stringify(mixed));
  check("and the successful run is not listed as a pause", !mixed.note.includes(THIRD), mixed.note);
}

/* ================================================================== */
/* 4. Reading the history: tolerant, and never a false "none".         */
/* ================================================================== */
{
  const manifestPath = manifestAt("with-db.manifest.json", { d1_database_id: "fixture-database" });
  const seen = [];
  const history = await readUpgradePauseHistory(manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async (acctId, dbId, sql) => {
      seen.push(sql);
      return { results: [run(SECOND, "started"), run(FIRST, "failed")] };
    },
  });
  check("the history is read from upgrade_runs", history.checked === true && history.runs.length === 2, JSON.stringify(history));
  check("newest first, and more than one row", /ORDER BY started_at DESC/.test(seen[0]) && /LIMIT 25/.test(seen[0]), seen[0]);
  check("and it feeds the recurrence note",
    upgradePauseRecurrence(history.runs).note.includes(FIRST), upgradePauseRecurrence(history.runs).note);

  const outage = await readUpgradePauseHistory(manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async () => { throw new Error("synthetic D1 outage"); },
  });
  check("a D1 outage is reported as not-checked, never thrown",
    outage.checked === false && /synthetic D1 outage/.test(outage.reason), JSON.stringify(outage));
  check("and it does not pretend there were zero pauses",
    outage.checked === false && outage.runs.length === 0, JSON.stringify(outage));

  const noToken = await readUpgradePauseHistory(manifestPath, {
    resolveAccount: async () => { throw new Error("CLOUDFLARE_API_TOKEN is not set"); },
  });
  check("no Cloudflare access degrades to not-checked", noToken.checked === false, JSON.stringify(noToken));

  const noDb = await readUpgradePauseHistory(manifestAt("no-db.manifest.json", {}), {});
  check("a manifest with no database says so instead of failing",
    noDb.checked === false && /no d1_database_id/.test(noDb.reason), JSON.stringify(noDb));

  const missing = await readUpgradePauseHistory(join(sandbox, "does-not-exist.json"), {});
  check("a missing manifest is reported, never thrown",
    missing.checked === false && /manifest could not be read/.test(missing.reason), JSON.stringify(missing));
}

/* ================================================================== */
/* 5. --repair sees the history too, from the same single query.       */
/* ================================================================== */
{
  const manifestPath = manifestAt("repair.manifest.json", { d1_database_id: "fixture-database" });
  const diagnosis = await diagnoseStuckUpgrade(manifestPath, {
    http: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: false, vector_drain_mode: "paused-for-upgrade", accepting_documents: false }),
    }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async (acctId, dbId, sql) => {
      if (/FROM upgrade_runs/.test(sql)) {
        return { results: [run(SECOND, "started", { d1_bookmark: "fixture-bookmark" }), run(FIRST, "failed")] };
      }
      return { results: [] };
    },
  });
  check("the stuck diagnosis still names the current run", diagnosis.lastRun?.started_at === SECOND, JSON.stringify(diagnosis.lastRun));
  check("and its recovery bookmark is unchanged", diagnosis.lastRun?.d1_bookmark === "fixture-bookmark", JSON.stringify(diagnosis.lastRun));
  check("and it now carries the runs behind it", (diagnosis.pauseRuns || []).length === 2, JSON.stringify(diagnosis.pauseRuns));
  check("so the repair path can say this is the second pause",
    /This is pause number 2 on this brain/.test(upgradePauseRecurrence(diagnosis.pauseRuns, { currentlyPaused: true }).note),
    upgradePauseRecurrence(diagnosis.pauseRuns, { currentlyPaused: true }).note);
}

console.log(fail ? `\n${fail} FAILURES` : `\nupgrade pause recurrence: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
