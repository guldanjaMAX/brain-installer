// `brain load <manifest>` — one sweep of every source an install actually has.
//
// WHAT THIS FILE PROVES, and why each one is worth a test:
//
//   1. A source failing MID-SWEEP does not stop the sources after it, and the
//      failure is reported at the end rather than swallowed. This is the whole
//      reason the command exists in this shape: the operator running it is
//      usually sitting next to the client, and a dead mail token must not be
//      the reason Drive and Calendar never loaded.
//   2. A skipped source is NEVER reported as loaded, and the four different
//      reasons a source can be skipped stay four different messages. "You do
//      not use this" and "this is broken" are not the same sentence.
//   3. --dry-run sends nothing. Proved twice: once through scripted producers
//      that record whether they were asked to send, and once end to end
//      through the REAL local walker with the network torn out from under it.
//   4. Resume does not redo completed work, and `brain load` adds no cursor of
//      its own that could later disagree with the per-source ones.
//   5. --only and --skip select exactly what they say, and a typo is refused
//      instead of quietly sweeping nothing.
//   6. The totals at the bottom match what actually happened, including the
//      case where a connector reports no counts — which must print as unknown
//      and never as zero.
//
// Everything the sweep ORCHESTRATES is real: the real planner, the real
// manifest reading, the real registry (labels, order, Zoom's push-only skip),
// the real report renderer, and in Part B the real local-folder ingest. Only
// the per-source producers are scripted, because the point of these cases is
// what the sweep does around a producer, not what the producer does inside.
//
// Personas here are invented. Nothing in this file names a real person.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdLoad,
  planLoad,
  loadSourceRegistry,
  normalizeLoadKey,
  uploadFoldersOf,
  describeLoadResult,
  formatLoadElapsed,
} from "../brain.mjs";
import { ingestionOutcome } from "../ingest/outcome.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const sandbox = mkdtempSync(join(tmpdir(), "brain-load-all-"));
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

/** Run cmdLoad with console.log captured, so the report itself can be asserted on. */
async function runLoad(manifestPath, options) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  let error = null;
  let result = null;
  try {
    result = await cmdLoad(manifestPath, options);
  } catch (e) {
    error = e;
  } finally {
    console.log = realLog;
  }
  const text = lines.map(strip).join("\n");
  return { result, error, text, lines: lines.map(strip) };
}

/** The block of the report under one heading, so "loaded" and "skipped" can be told apart. */
function reportSection(text, heading) {
  const all = text.split("\n");
  const start = all.findIndex((line) => line.includes(heading));
  if (start === -1) return "";
  const rest = all.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Z]/.test(line) || /^ {2}totals:/.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

function writeManifest(dir, corpora, extra = {}) {
  const path = join(dir, "brain.manifest.json");
  writeFileSync(path, JSON.stringify({
    manifest_version: 1,
    client: { slug: "northwind", display_name: "Northwind Studio", timezone: "America/Phoenix" },
    brain: { version: "0.1.0", domain: "brain.northwind.test", worker_name: "northwind-brain" },
    infrastructure: { cloudflare: { account_id: "acct", storage: "d1" } },
    corpora,
    ...extra,
  }, null, 2));
  return path;
}

/**
 * A scripted producer set laid over the REAL registry.
 *
 * Only `legs` is replaced, so order, labels, Zoom's push-only skip and the
 * planner's own behaviour all stay genuine.
 */
function scriptedRegistry(behaviour) {
  const calls = [];
  const real = loadSourceRegistry();
  const table = {};
  for (const [key, descriptor] of Object.entries(real)) {
    if (!behaviour[key]) { table[key] = descriptor; continue; }
    table[key] = {
      ...descriptor,
      legs: ({ flags }) => [{
        source: key,
        run: async () => {
          calls.push({ key, dryRun: !!flags["dry-run"] });
          return behaviour[key]({ flags });
        },
      }],
    };
  }
  return { table, calls };
}

const connected = () => ({ connected: true });

try {
  /* ------------------------------------------------------------------ units */
  check("normalizeLoadKey maps what an operator would actually type",
    normalizeLoadKey("drive") === "google_drive" &&
    normalizeLoadKey("Google-Drive") === "google_drive" &&
    normalizeLoadKey("iphone") === "iphone_backup" &&
    normalizeLoadKey("gcal") === "calendar");

  check("uploadFoldersOf accepts a bare string and an explicitly named folder",
    JSON.stringify(uploadFoldersOf({ folders: ["/a", { path: "/b", source: "contracts" }] })) ===
    JSON.stringify([{ path: "/a", source: null }, { path: "/b", source: "contracts" }]));

  assert.throws(
    () => describeLoadResult(undefined),
    /no recognized completion receipt/,
  );
  check("describeLoadResult refuses to invent completion from an absent receipt", true);

  check("formatLoadElapsed stays readable past a minute",
    formatLoadElapsed(4100) === "4.1s" && formatLoadElapsed(2_460_000) === "41m00s",
    `${formatLoadElapsed(4100)} / ${formatLoadElapsed(2_460_000)}`);

  /* ---- the real table forwards the operator's flags to the real commands ---- */
  //
  // Found by a discrimination pass, not by design: dropping --dry-run on the
  // way into one leg of the REAL registry broke no test at all, because every
  // other case here scripts `legs` and never exercises the table's own wiring.
  {
    const dir = mkdtempSync(join(sandbox, "wiring-"));
    const manifestPath = writeManifest(dir, { upload: { enabled: true, folders: ["/tmp/wiring"] } });
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const seen = [];
    const spy = (name) => async (_m, _path, flags) => { seen.push({ name, flags }); return { created: 0, updated: 0, unchanged: 0 }; };
    const table = loadSourceRegistry({
      ingestCalendar: spy("calendar"),
      ingestImessage: spy("imessage"),
      ingestWhatsapp: spy("whatsapp"),
      ingestLocal: spy("local"),
      ingestRemote: spy("remote"),
      ingestIphoneBackup: spy("iphone"),
    });
    const flags = { "dry-run": true, limit: "5" };
    for (const key of ["calendar", "imessage", "whatsapp", "upload", "gmail", "google_drive", "iphone_backup"]) {
      for (const leg of table[key].legs({ m, manifestPath, flags })) await leg.run();
    }
    check("every source in the real registry is wired to a command",
      seen.length === 7, JSON.stringify(seen.map((x) => x.name)));
    check("the real registry forwards --dry-run to EVERY source, unaltered",
      seen.every((x) => x.flags["dry-run"] === true),
      JSON.stringify(seen.filter((x) => x.flags["dry-run"] !== true).map((x) => x.name)));
    check("the real registry forwards --limit to every source too",
      seen.every((x) => x.flags.limit === "5"),
      JSON.stringify(seen.filter((x) => x.flags.limit !== "5").map((x) => x.name)));
    check("each source is asked for its OWN source, not a neighbour's",
      JSON.stringify(seen.map((x) => x.flags.from)) === JSON.stringify([
        "calendar", "imessage", "whatsapp", undefined, "gmail", "drive", "iphone-backup",
      ]), JSON.stringify(seen.map((x) => x.flags.from)));
    check("the folder leg is handed the folder path from the manifest",
      seen[3].flags.path === "/tmp/wiring" && seen[3].flags.source === "upload",
      JSON.stringify(seen[3].flags));
    check("no source is ever handed --reset by the sweep",
      seen.every((x) => x.flags.reset === undefined),
      JSON.stringify(seen.filter((x) => x.flags.reset !== undefined).map((x) => x.name)));
  }

  /* ---------------------------------------------- the ordering the code claims */
  {
    const dir = mkdtempSync(join(sandbox, "order-"));
    const manifestPath = writeManifest(dir, {
      google_drive: { enabled: true }, gmail: { enabled: true }, calendar: { enabled: true },
      imessage: { enabled: true }, upload: { enabled: true, folders: ["/tmp/x"] },
      whatsapp: { enabled: true }, iphone_backup: { enabled: true },
    });
    const entries = await planLoad({
      m: JSON.parse(readFileSync(manifestPath, "utf8")),
      manifestPath,
      probes: Object.fromEntries(
        ["google_drive", "gmail", "calendar", "imessage", "whatsapp", "iphone_backup"].map((k) => [k, connected]),
      ),
    });
    const order = entries.map((e) => e.key);
    check("the plan is ordered cheap-and-fast first, long bulk last, snapshot dead last",
      JSON.stringify(order) === JSON.stringify([
        "calendar", "imessage", "whatsapp", "upload", "gmail", "google_drive", "iphone_backup",
      ]), JSON.stringify(order));
  }

  /* ------------------- the headline case: one source fails, the rest still load */
  let sweep;
  {
    const dir = mkdtempSync(join(sandbox, "sweep-"));
    const manifestPath = writeManifest(dir, {
      _comment: "a comment key must never be mistaken for a source",
      calendar: { enabled: true },
      imessage: { enabled: true },
      upload: { enabled: true, folders: ["/tmp/does-not-matter-scripted"] },
      gmail: { enabled: true },
      google_drive: { enabled: true },
      whatsapp: { enabled: true },
      zoom: { enabled: true },
      slack: { enabled: true },
      notion: { enabled: false },
    });
    const { table, calls } = scriptedRegistry({
      calendar: () => ({ sent: { created: 3, updated: 1, unchanged: 2, refused: [], errors: [] }, removed: 0 }),
      imessage: () => ({ documents_sent: 7, rows_seen: 412 }),
      upload: () => ({ created: 40, updated: 2, unchanged: 5, refused: 0, skipped: 3 }),
      gmail: () => { throw new Error("Google refused the refresh token (invalid_grant): it is dead"); },
      google_drive: () => ({ created: 900, updated: 11, unchanged: 120, refused: 0, skipped: 60 }),
    });
    sweep = await runLoad(manifestPath, {
      flags: {},
      registry: table,
      probes: {
        calendar: connected, imessage: connected, gmail: connected, google_drive: connected,
        whatsapp: () => ({
          connected: false,
          reason: "no WhatsApp outbox on this machine; the linked device was never paired",
          fix: "brain connect whatsapp <manifest> --accept-risk",
        }),
      },
    });
    sweep.calls = calls;

    const ranKeys = calls.map((c) => c.key);
    check("a source failing mid-sweep does not stop the sources after it",
      ranKeys.indexOf("google_drive") > ranKeys.indexOf("gmail") && ranKeys.includes("google_drive"),
      JSON.stringify(ranKeys));
    check("every runnable source ran exactly once, in plan order",
      JSON.stringify(ranKeys) === JSON.stringify(["calendar", "imessage", "upload", "gmail", "google_drive"]),
      JSON.stringify(ranKeys));

    const loadedBlock = reportSection(sweep.text, "IN THE BRAIN");
    const skippedBlock = reportSection(sweep.text, "NOT LOADED — skipped");
    const unavailableBlock = reportSection(sweep.text, "NOT LOADED — unavailable");
    const failedBlock = reportSection(sweep.text, "NOT LOADED — failed");

    check("the failure is reported, in the failed list, with its cause",
      /Gmail/.test(failedBlock) && /invalid_grant/.test(failedBlock), failedBlock);
    check("the failure carries the exact command to retry just that one source",
      /--only gmail/.test(failedBlock), failedBlock);
    check("a failed source is NOT listed among what is in the brain",
      !/Gmail/.test(loadedBlock), loadedBlock);

    // A source the manifest deliberately does not run is skipped. A source the
    // manifest wants but cannot reach is unavailable. Neither may look loaded.
    for (const [label, why] of [
      ["Zoom", "push"],
      ["notion", "not enabled"],
    ]) {
      check(`a source skipped because it is ${why} appears only in the skipped list`,
        skippedBlock.includes(label) && !loadedBlock.includes(label),
        `${label}: loaded=${loadedBlock.includes(label)} skipped=${skippedBlock.includes(label)}`);
    }
    for (const [label, why] of [["WhatsApp", "not connected"], ["slack", "no loader"]]) {
      check(`a source ${why} appears only in the unavailable list`,
        unavailableBlock.includes(label) && !loadedBlock.includes(label) && !skippedBlock.includes(label),
        `${label}: loaded=${loadedBlock.includes(label)} skipped=${skippedBlock.includes(label)} unavailable=${unavailableBlock.includes(label)}`);
    }

    check('"this client does not use it" stays a different message from "it is broken"',
      /notion.*not enabled in this manifest/.test(skippedBlock) &&
      /WhatsApp.*enabled, but not connected/.test(unavailableBlock), `${skippedBlock}\n${unavailableBlock}`);
    check("a source with no loader in this build is unavailable instead of vanishing from the sweep",
      /slack.*has no loader for it/.test(unavailableBlock), unavailableBlock);
    check("Zoom is skipped as a push connector, not reported as loaded work",
      /Zoom.*nothing to pull/.test(skippedBlock), skippedBlock);
    check("a manifest _comment key is not treated as a source",
      !/_comment/.test(sweep.text));

    check("the unavailable list carries the fix for the disconnected source",
      /brain connect whatsapp/.test(unavailableBlock), unavailableBlock);

    check("the totals match what actually happened",
      /totals: 4 loaded, 2 skipped, 2 unavailable, 1 failed, of 9 declared/.test(sweep.text),
      sweep.text.split("\n").filter((l) => l.includes("totals:")).join(" | "));
    check("the document totals are the sum of what the producers really reported",
      /943 created, 14 updated, 127 unchanged, 7 conversation document\(s\) sent/.test(sweep.text),
      sweep.text.split("\n").filter((l) => l.includes("created,")).join(" | "));
    check("the report states plainly that not everything is in the brain",
      /3 of 9 declared source\(s\) are NOT in the brain\./.test(sweep.text),
      sweep.text.split("\n").filter((l) => l.includes("declared source")).join(" | "));
    check("the sweep exits through the failure path so a script can see it",
      sweep.error && /1 of 5 source\(s\) did not load; the other 4 did\./.test(sweep.error.message),
      sweep.error?.message);
    check("progress is printed as each source STARTS, not only when it finishes",
      sweep.lines.some((l) => /\[1\/5\] Google Calendar.*starting/.test(l)) &&
      sweep.lines.some((l) => /\[5\/5\] Google Drive.*starting/.test(l)),
      sweep.lines.filter((l) => l.includes("starting")).join(" | "));
  }

  /* ---------------------------------- an unknown count is unknown, never zero */
  {
    const dir = mkdtempSync(join(sandbox, "unknown-"));
    const manifestPath = writeManifest(dir, { calendar: { enabled: true }, gmail: { enabled: true } });
    const { table } = scriptedRegistry({
      calendar: () => ({ sent: { created: 2, updated: 0, unchanged: 0, refused: [], errors: [] } }),
      gmail: () => ({ outcome: ingestionOutcome("completed") }),
    });
    const run = await runLoad(manifestPath, {
      flags: {}, registry: table, probes: { calendar: connected, gmail: connected },
    });
    check("an explicitly completed connector may report counts as unknown, never zero",
      /Gmail.*unknown \(not zero\)/.test(reportSection(run.text, "IN THE BRAIN")),
      reportSection(run.text, "IN THE BRAIN"));
    check("the totals say how many sources could not report, so the number reads as a floor",
      /plus 1 source\(s\) whose counts are UNKNOWN, not zero/.test(run.text),
      run.text.split("\n").filter((l) => l.includes("created")).join(" | "));
  }

  /* ------------------------------------------ a partial load says it is partial */
  {
    const dir = mkdtempSync(join(sandbox, "partial-"));
    const manifestPath = writeManifest(dir, { calendar: { enabled: true } });
    const { table } = scriptedRegistry({
      calendar: () => ({ sent: { created: 5, updated: 0, unchanged: 1, refused: [{}], errors: [{}, {}] } }),
    });
    const run = await runLoad(manifestPath, { flags: {}, registry: table, probes: { calendar: connected } });
    check("a source that loaded some documents and failed others is labelled partly loaded",
      /partly loaded/.test(run.text) && /2 failed to send/.test(run.text) && /1 refused/.test(run.text),
      reportSection(run.text, "IN THE BRAIN"));
    check("a partial source makes the sweep non-zero after the complete report",
      /1 partial source outcome/.test(run.error?.message || "") && /load report/.test(run.text),
      run.error?.message);
  }

  /* ------------------------------------------------------ --only and --skip */
  {
    const dir = mkdtempSync(join(sandbox, "select-"));
    const manifestPath = writeManifest(dir, {
      calendar: { enabled: true }, gmail: { enabled: true }, google_drive: { enabled: true },
    });
    const behaviour = {
      calendar: () => ({ sent: { created: 1, updated: 0, unchanged: 0, refused: [], errors: [] } }),
      gmail: () => ({ created: 1, updated: 0, unchanged: 0 }),
      google_drive: () => ({ created: 1, updated: 0, unchanged: 0 }),
    };
    const probes = { calendar: connected, gmail: connected, google_drive: connected };

    const onlyScript = scriptedRegistry(behaviour);
    const onlyRun = await runLoad(manifestPath, {
      flags: { only: "gmail,drive" }, registry: onlyScript.table, probes,
    });
    check("--only runs exactly the named sources, resolving an alias on the way",
      JSON.stringify(onlyScript.calls.map((c) => c.key)) === JSON.stringify(["gmail", "google_drive"]),
      JSON.stringify(onlyScript.calls.map((c) => c.key)));
    check("--only says why the others were left out, rather than hiding them",
      /Google Calendar.*not selected by --only/.test(reportSection(onlyRun.text, "NOT LOADED — skipped")),
      reportSection(onlyRun.text, "NOT LOADED — skipped"));

    const skipScript = scriptedRegistry(behaviour);
    const skipRun = await runLoad(manifestPath, {
      flags: { skip: "google_drive" }, registry: skipScript.table, probes,
    });
    check("--skip removes exactly the named source and runs the rest",
      JSON.stringify(skipScript.calls.map((c) => c.key)) === JSON.stringify(["calendar", "gmail"]),
      JSON.stringify(skipScript.calls.map((c) => c.key)));
    check("--skip states itself as the reason in the report",
      /Google Drive.*excluded by --skip/.test(reportSection(skipRun.text, "NOT LOADED — skipped")),
      reportSection(skipRun.text, "NOT LOADED — skipped"));

    const typoScript = scriptedRegistry(behaviour);
    const typoRun = await runLoad(manifestPath, {
      flags: { only: "gmial" }, registry: typoScript.table, probes,
    });
    check("a typo in --only is refused instead of quietly sweeping nothing",
      typoRun.error && /--only gmial is not a source/.test(typoRun.error.message) &&
      typoScript.calls.length === 0,
      typoRun.error?.message);

    const resetRun = await runLoad(manifestPath, {
      flags: { reset: true }, registry: scriptedRegistry(behaviour).table, probes,
    });
    check("--reset is refused, so a sweep can never wipe every source's resume state at once",
      resetRun.error && /will not take --reset/.test(resetRun.error.message), resetRun.error?.message);
  }

  /* --------------------------------------------------- --dry-run sends nothing */
  {
    const dir = mkdtempSync(join(sandbox, "dry-"));
    const manifestPath = writeManifest(dir, {
      calendar: { enabled: true }, gmail: { enabled: true }, google_drive: { enabled: true },
    });
    let sends = 0;
    const preview = ({ flags }) => {
      if (!flags["dry-run"]) { sends++; return { created: 5, updated: 0, unchanged: 0 }; }
      return { dry_run: true, would_send: 5, unchanged: 0, skipped: 0 };
    };
    const { table, calls } = scriptedRegistry({ calendar: preview, gmail: preview, google_drive: preview });
    const run = await runLoad(manifestPath, {
      flags: { "dry-run": true },
      registry: table,
      probes: { calendar: connected, gmail: connected, google_drive: connected },
    });
    check("--dry-run reaches every source in the sweep",
      calls.length === 3 && calls.every((c) => c.dryRun === true), JSON.stringify(calls));
    check("--dry-run sent nothing",
      sends === 0 && run.error === null, `sends=${sends} error=${run.error?.message}`);
    check("the report says out loud that it was a dry run and nothing was sent",
      /DRY RUN, nothing was sent/.test(run.text) && /WOULD LOAD \(3\)/.test(run.text) &&
      /WOULD be sent/.test(run.text), run.text.slice(-600));
    check("--dry-run shows the scope BEFORE the sweep, so a client can see it first",
      run.text.indexOf("what WOULD be read") < run.text.indexOf("[1/3]"),
      `${run.text.indexOf("what WOULD be read")} < ${run.text.indexOf("[1/3]")}`);
  }

  /* ------------------------------------------------------------------ resume */
  {
    const dir = mkdtempSync(join(sandbox, "resume-"));
    const manifestPath = writeManifest(dir, { google_drive: { enabled: true } });
    const statePath = join(dir, ".brain-ingest-drive.json");
    const UNITS = ["a", "b", "c"];
    const processedThisRun = [];

    // A producer that keeps its OWN durable resume state, exactly as every real
    // connector does. If `brain load` layered a second cursor on top, this is
    // where the two would disagree.
    const producer = (failAfter) => ({ flags }) => {
      // Honouring --reset is what makes this a real stand-in. A sweep that
      // quietly forced a reset on its legs would wipe this state and redo
      // finished work, and without this line no assertion would notice.
      if (flags.reset && existsSync(statePath)) rmSync(statePath);
      const done = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).done : [];
      let created = 0;
      for (const unit of UNITS) {
        if (done.includes(unit)) continue;
        if (created >= failAfter) throw new Error("the connection dropped part way through");
        done.push(unit);
        processedThisRun.push(unit);
        created++;
        writeFileSync(statePath, JSON.stringify({ done }));
      }
      return { created, updated: 0, unchanged: done.length - created };
    };

    const first = scriptedRegistry({ google_drive: producer(2) });
    const firstRun = await runLoad(manifestPath, {
      flags: {}, registry: first.table, probes: { google_drive: connected },
    });
    check("an interrupted sweep reports the interrupted source as failed, not as loaded",
      firstRun.error !== null && /Google Drive/.test(reportSection(firstRun.text, "NOT LOADED — failed")),
      reportSection(firstRun.text, "NOT LOADED — failed"));
    check("the first run got through two of three units",
      JSON.stringify(processedThisRun) === JSON.stringify(["a", "b"]), JSON.stringify(processedThisRun));

    processedThisRun.length = 0;
    const second = scriptedRegistry({ google_drive: producer(99) });
    const secondRun = await runLoad(manifestPath, {
      flags: {}, registry: second.table, probes: { google_drive: connected },
    });
    check("re-running the sweep continues from the source's own state instead of redoing the work",
      JSON.stringify(processedThisRun) === JSON.stringify(["c"]), JSON.stringify(processedThisRun));
    check("the resumed run reports only the new work, and says the rest was already there",
      /1 created, 0 updated, 2 unchanged/.test(secondRun.text) && secondRun.error === null,
      reportSection(secondRun.text, "IN THE BRAIN"));

    const ownState = readdirSync(dir).filter((f) => /^\.brain-load/.test(f));
    check("brain load keeps NO cursor of its own that could disagree with the per-source ones",
      ownState.length === 0, JSON.stringify(readdirSync(dir)));

    // The same producer, told to reset, redoes all three. That is what makes
    // the assertion above a real measurement rather than a producer that would
    // have processed one unit whatever the sweep did.
    processedThisRun.length = 0;
    const forced = scriptedRegistry({ google_drive: producer(99) });
    await runLoad(manifestPath, {
      flags: { reset: true }, registry: forced.table, probes: { google_drive: connected },
      // planLoad is reached directly here, past cmdLoad's own --reset refusal,
      // to prove the producer really can tell the difference.
    });
    const resetRegistry = scriptedRegistry({ google_drive: producer(99) });
    const legs = resetRegistry.table.google_drive.legs({ flags: { reset: true } });
    processedThisRun.length = 0;
    await legs[0].run();
    check("the resume assertion is a real measurement: told to reset, the same producer redoes all three",
      JSON.stringify(processedThisRun) === JSON.stringify(["a", "b", "c"]), JSON.stringify(processedThisRun));
  }

  /* ------------- Part B: real registry, real local walker, network torn out ---- */
  {
    const dir = mkdtempSync(join(sandbox, "real-"));
    const docs = join(dir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "kickoff.md"), "# Kickoff\n\nAlex Rivera and Priya Nair agreed the scope on 4 March.\n");
    writeFileSync(join(docs, "scope.md"), "# Scope\n\nTwo phases. Sam Osei signs off phase one.\n");
    writeFileSync(join(docs, "notes.md"), "# Notes\n\nJordan Lee to send the revised numbers.\n");
    const manifestPath = writeManifest(dir, {
      upload: { enabled: true, folders: [docs] },
      google_drive: { enabled: false },
      gmail: { enabled: false },
      calendar: { enabled: false },
      zoom: { enabled: true },
    });

    // If any byte leaves this process during a dry run, this throws and the
    // assertion below fails. That is the strongest form of "sent nothing".
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { throw new Error(`a dry run tried to reach the network: ${url}`); };
    let run;
    try {
      run = await runLoad(manifestPath, { flags: { "dry-run": true } });
    } finally {
      globalThis.fetch = realFetch;
    }

    check("a real end-to-end dry run over the real local walker completes without touching the network",
      run.error === null, run.error?.message);
    check("it previewed the three real documents it WOULD send",
      /3 document\(s\) WOULD be sent/.test(run.text), reportSection(run.text, "WOULD LOAD"));
    check("a real dry run wrote no resume state at all",
      readdirSync(dir).filter((f) => f.startsWith(".brain-ingest")).length === 0,
      JSON.stringify(readdirSync(dir)));
    check("the disabled sources are skipped with the client-does-not-use-it reason",
      /Google Drive.*not enabled in this manifest/.test(reportSection(run.text, "NOT LOADED — skipped")),
      reportSection(run.text, "NOT LOADED — skipped"));
    check("nothing failed, so the failed list is explicitly empty rather than absent",
      /NOT LOADED — failed \(0\)/.test(run.text) && /none/.test(reportSection(run.text, "NOT LOADED — failed")),
      reportSection(run.text, "NOT LOADED — failed"));
  }

  /* ------ isolation one level deeper: one folder fails, the next still loads --- */
  {
    const dir = mkdtempSync(join(sandbox, "legs-"));
    const good = join(dir, "transcripts");
    mkdirSync(good);
    writeFileSync(join(good, "call.md"), "# Call\n\nMorgan Diaz walked through the renewal terms.\n");
    const manifestPath = writeManifest(dir, {
      upload: {
        enabled: true,
        folders: [
          { path: join(dir, "folder-that-was-moved"), source: "contracts" },
          { path: good, source: "transcripts" },
        ],
      },
    });
    const run = await runLoad(manifestPath, { flags: { "dry-run": true } });
    const loadedBlock = reportSection(run.text, "WOULD LOAD");
    check("a folder that cannot be read does not stop the next folder in the same source",
      /transcripts.*1 document\(s\) WOULD be sent/.test(loadedBlock), loadedBlock);
    check("the folder that failed is named as NOT loaded, beside the one that did",
      /contracts: NOT loaded — no such folder/.test(loadedBlock), loadedBlock);
    check("the source is labelled partly loaded rather than loaded",
      /partly loaded/.test(loadedBlock) && /part of this source is NOT in the brain/.test(loadedBlock),
      loadedBlock);
    check("a partly loaded source is counted as only partly loaded in the totals",
      /totals: 1 loaded \(1 only partly\)/.test(run.text),
      run.text.split("\n").filter((l) => l.includes("totals:")).join(" | "));
    check("a source that loaded in part is not counted as missing entirely",
      /^1 loaded only in part\./m.test(run.text.replace(/^\s+/gm, "")) &&
      !/are NOT in the brain/.test(run.text),
      run.text.split("\n").filter((l) => l.includes("declared source") || l.includes("only in part")).join(" | "));
  }

  /* ------------ a malformed corpus block is unavailable, not a sweep crash --- */
  {
    const dir = mkdtempSync(join(sandbox, "malformed-"));
    const manifestPath = writeManifest(dir, {
      upload: { enabled: true, folders: "/one/folder/as/a/string" },
      calendar: { enabled: true },
    });
    const { table, calls } = scriptedRegistry({
      calendar: () => ({ sent: { created: 1, updated: 0, unchanged: 0, refused: [], errors: [] } }),
    });
    const run = await runLoad(manifestPath, {
      flags: {}, registry: table, probes: { calendar: connected },
    });
    check("a malformed corpus block makes that source unavailable with the problem named",
      /could not be read: corpora.upload.folders must be an array/.test(run.text),
      reportSection(run.text, "NOT LOADED — unavailable"));
    check("and the rest of the sweep still runs",
      JSON.stringify(calls.map((c) => c.key)) === JSON.stringify(["calendar"]),
      JSON.stringify(calls.map((c) => c.key)));
    check("an unavailable source makes the completed sweep report non-zero",
      /1 unavailable source outcome/.test(run.error?.message || ""), run.error?.message);
  }

  /* --------------------- a folder-less upload corpus is unavailable, not crashed */
  {
    const dir = mkdtempSync(join(sandbox, "nofolder-"));
    const manifestPath = writeManifest(dir, { upload: { enabled: true } });
    const run = await runLoad(manifestPath, { flags: { "dry-run": true } });
    check("an enabled upload corpus with no folder declared is unavailable with the fix, not run empty",
      /the manifest names no folder for it to read/.test(run.text) &&
      /corpora.upload/.test(run.text) && /1 unavailable source outcome/.test(run.error?.message || ""),
      reportSection(run.text, "NOT LOADED — unavailable"));
  }

  /* --------- a source that cannot size itself in advance says so, never 0 or undefined */
  {
    // The message captures (iMessage, WhatsApp, iPhone backup) return dry_run
    // without a would_send. Printing that as "undefined document(s)" or
    // silently as 0 lets an operator previewing a job in front of a client
    // under-read what those sources actually hold.
    const unsized = describeLoadResult({ dry_run: true });
    check("a dry-run source with no advance count never renders the literal undefined",
      !/undefined/.test(unsized.text), unsized.text);
    check("and it is not reported as zero either, because zero is a claim",
      unsized.wouldSend === null && unsized.volumeUnknown === true,
      JSON.stringify({ wouldSend: unsized.wouldSend, volumeUnknown: unsized.volumeUnknown }));
    check("and it says plainly that the count is unknown rather than absent",
      /unknown, not zero/.test(unsized.text), unsized.text);

    const sized = describeLoadResult({ dry_run: true, would_send: 412, unchanged: 8 });
    check("a source that DOES report an advance count is unchanged by that rule",
      sized.wouldSend === 412 && !sized.volumeUnknown && /412 document\(s\) WOULD be sent/.test(sized.text),
      sized.text);
  }

  console.log(fail ? `\n${fail} FAILURES` : `\nload-all: all ${ran} tests passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
