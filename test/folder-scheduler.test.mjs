// test/folder-scheduler.test.mjs
//
// The watched folder lane, in two halves.
//
// HALF ONE, the scheduler: proven with the exact technique
// test/drive-scheduler.test.mjs and test/imessage-scheduler.test.mjs use — a
// synthetic manifest in a sandbox home, a scripted launchctl closure, and
// fixed node/brain/scheduler paths. No real launchd, no network. It also
// proves the folder lane is the SAME mechanism as the other two rather than a
// parallel one: Drive's identity is untouched and all three coexist.
//
// HALF TWO, what a tick actually does to a folder: a file added after the
// first run is picked up, a changed file is re-sent, an unchanged file is not,
// a deleted file is reconciled, and an interrupted run resumes. Those run
// against the real `walk`, `prepare`, `loadState`/`saveState` and
// `removedSinceLastRun` — the same functions the ingest command calls — plus a
// source assertion that the command really is wired to them.

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  FOLDER_INGEST_DEFAULT_CRON,
  FOLDER_SCHEDULER_SPEC,
  buildFolderSchedulerPlan,
  installFolderScheduler,
  removeFolderScheduler,
  runFolderIngest,
  statusFolderScheduler,
} from "../operations/folder-scheduler.mjs";
import {
  CLOUDFLARE_CREDENTIAL_ENV,
  buildDriveSchedulerPlan,
  buildSchedulerPlan,
  renderLaunchAgentPlist,
} from "../operations/drive-scheduler.mjs";
import { IMESSAGE_SCHEDULER_SPEC } from "../operations/imessage-scheduler.mjs";
import { walk, prepare, loadState, saveState, removedSinceLastRun } from "../ingest/run.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const directory = mkdtempSync(join(tmpdir(), "brain-folder-scheduler-"));
const home = join(directory, "home & logs");
const watched = join(directory, "dropbox for exports");
const manifestPath = join(directory, "client & manifest", "brain.manifest.json");
mkdirSync(watched, { recursive: true });

const baseManifest = {
  manifest_version: 1,
  client: { slug: "acme-brain", display_name: "Acme", timezone: "America/Phoenix" },
  brain: { version: "0.1.0", domain: "brain.acme.test" },
  infrastructure: { cloudflare: { account_id: "account-123" } },
  corpora: {
    google_drive: { enabled: true },
    imessage: { enabled: true },
    local_folder: { enabled: true, path: watched, source: "documents" },
  },
  operations: {
    ingest_cron: "0 9 * * *",
    admin_key_secret: "keychain://acme-brain-admin/owner",
    google_token_store: "auto",
  },
};

function writeManifest(manifest = baseManifest, path = manifestPath) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function opts(extra = {}) {
  return {
    platform: "darwin",
    home,
    uid: 501,
    nodePath: "/opt/node/bin/node",
    brainPath: "/opt/brain installer/brain.mjs",
    localTimeZone: "America/Phoenix",
    ...extra,
  };
}

try {
  writeManifest();

  /* ================= plan, schedule, and identity ================= */
  {
    const plan = buildFolderSchedulerPlan(manifestPath, opts());
    check("the label is standard, client-scoped, and distinct from the other lanes",
      plan.label === "com.brain-installer.acme-brain.folder-ingest", plan.label);
    check("the default schedule is hourly, not every minute",
      plan.cron === FOLDER_INGEST_DEFAULT_CRON && plan.expectedRefreshSeconds === 3600,
      JSON.stringify({ cron: plan.cron, seconds: plan.expectedRefreshSeconds }));
    check("the LaunchAgent invokes the folder runner with a configuration binding",
      plan.programArguments[1].endsWith("operations/folder-scheduler.mjs") &&
      JSON.stringify(plan.programArguments.slice(2, 7)) === JSON.stringify([
        "run", manifestPath, "--brain", resolve("/opt/brain installer/brain.mjs"), "--config-hash",
      ]) && plan.programArguments[7] === plan.configHash && /^[a-f0-9]{64}$/.test(plan.configHash),
      JSON.stringify(plan.programArguments));
    check("logs and the single-instance lock are folder-named under .brain",
      plan.stdoutPath.endsWith("acme-brain-folder-ingest.out.log") &&
      plan.lockPath.endsWith("acme-brain-folder-ingest.lock"));
    const plist = renderLaunchAgentPlist(plan);
    check("the plist contains no credential material",
      !plist.includes("keychain://") && !plist.includes("CLOUDFLARE") &&
      plist.includes("folder-scheduler.mjs"));
    check("the manifest cron knob overrides the hourly default",
      buildFolderSchedulerPlan(
        writeManifest({ ...baseManifest, operations: { ...baseManifest.operations, folder_ingest_cron: "*/30 * * * *" } },
          join(directory, "cron-override", "brain.manifest.json")),
        opts()
      ).expectedRefreshSeconds === 1800);
  }
  {
    // The same generalized machinery, a third time: not a parallel scheduler.
    const drive = buildDriveSchedulerPlan(manifestPath, opts({
      schedulerPath: "/opt/brain installer/operations/drive-scheduler.mjs",
    }));
    const folder = buildFolderSchedulerPlan(manifestPath, opts());
    const imessage = buildSchedulerPlan(manifestPath, opts({ spec: IMESSAGE_SCHEDULER_SPEC }));
    check("the folder lane is built by the shared buildSchedulerPlan, only its spec differs",
      JSON.stringify(buildSchedulerPlan(manifestPath, opts({ spec: FOLDER_SCHEDULER_SPEC })).programArguments) ===
        JSON.stringify(folder.programArguments));
    check("adding it leaves Drive's identity exactly as before",
      drive.label === "com.brain-installer.acme-brain.drive-ingest" &&
      drive.stdoutPath.endsWith("acme-brain-drive-ingest.out.log"), drive.label);
    check("all three lanes coexist with distinct plists, logs, locks and config hashes",
      new Set([drive.plistPath, folder.plistPath, imessage.plistPath]).size === 3 &&
      new Set([drive.lockPath, folder.lockPath, imessage.lockPath]).size === 3 &&
      new Set([drive.configHash, folder.configHash, imessage.configHash]).size === 3);
  }

  /* ================= validation ================= */
  {
    let error = null;
    try { buildFolderSchedulerPlan(manifestPath, opts({ platform: "win32" })); } catch (caught) { error = caught; }
    check("non-macOS scheduling fails with the honest platform statement",
      /macOS LaunchAgents; this machine reports win32/.test(error?.message), error?.message);
  }
  {
    const path = join(directory, "disabled", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { google_drive: { enabled: true } } }, path);
    let error = null;
    try { buildFolderSchedulerPlan(path, opts()); } catch (caught) { error = caught; }
    check("corpora.local_folder.enabled must be declared before install",
      /corpora\.local_folder\.enabled must be true/.test(error?.message), error?.message);
  }
  {
    const path = join(directory, "relative", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      corpora: { ...baseManifest.corpora, local_folder: { enabled: true, path: "exports" } },
    }, path);
    let error = null;
    try { buildFolderSchedulerPlan(path, opts()); } catch (caught) { error = caught; }
    check("a relative folder path is refused, because launchd's cwd is not the client's shell",
      /must be an absolute path/.test(error?.message), error?.message);
  }
  {
    const path = join(directory, "missing", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      corpora: { ...baseManifest.corpora, local_folder: { enabled: true, path: join(directory, "not-there") } },
    }, path);
    let error = null;
    try { buildFolderSchedulerPlan(path, opts()); } catch (caught) { error = caught; }
    check("a folder that is not on this machine is refused instead of scheduled",
      /does not exist as a folder/.test(error?.message) && /reports success forever/.test(error?.message),
      error?.message);
  }
  {
    const path = join(directory, "bad-source", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      corpora: { ...baseManifest.corpora, local_folder: { enabled: true, path: watched, source: "Documents; drop" } },
    }, path);
    let error = null;
    try { buildFolderSchedulerPlan(path, opts()); } catch (caught) { error = caught; }
    check("an unsafe source name is refused, since the name is the deletion scope",
      /corpora\.local_folder\.source must be lowercase/.test(error?.message), error?.message);
  }
  {
    const path = join(directory, "bad-cron", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      operations: { ...baseManifest.operations, folder_ingest_cron: "0 25 * * *" },
    }, path);
    let error = null;
    try { buildFolderSchedulerPlan(path, opts()); } catch (caught) { error = caught; }
    check("a bad cron names the folder knob, not Drive's",
      /hour.*0-23.*watched folder ingest cron/i.test(error?.message), error?.message);
  }

  /* ================= lifecycle: install, status, remove ================= */
  {
    const calls = [];
    const launchctl = (args) => {
      calls.push(args);
      return args[0] === "print" ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: "", stderr: "" };
    };
    const installed = installFolderScheduler(manifestPath, opts({ launchctl }));
    check("install atomically writes a private LaunchAgent plist",
      existsSync(installed.plistPath) &&
      (process.platform === "win32" || (statSync(installed.plistPath).mode & 0o777) === 0o600));
    check("install enables and bootstraps the user service",
      calls.some((x) => x[0] === "enable" && x[1] === installed.service) &&
      calls.some((x) => x[0] === "bootstrap" && x[1] === installed.domain && x[2] === installed.plistPath),
      JSON.stringify(calls));
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", installed.plistPath], { encoding: "utf-8" });
      check("the generated definition passes macOS's native plist parser", lint.status === 0, lint.stderr || lint.stdout);
    }

    const status = statusFolderScheduler(manifestPath, opts({
      launchctl: () => ({ status: 0, stdout: "state = running\npid = 4321\nruns = 12\nlast exit code = 0\n", stderr: "" }),
    }));
    check("status reports installed, loaded, running, and run history",
      status.installed && status.loaded && status.running && status.pid === 4321 &&
      status.runs === 12 && status.lastRunSucceeded === true, JSON.stringify(status).slice(0, 200));
    check("status names the folder it is watching", status.folderPath === watched, status.folderPath);
    check("status proves the loaded definition matches the current manifest",
      status.definitionMatches && !status.definitionDrift);

    const removed = removeFolderScheduler(manifestPath, opts({
      launchctl: (args) => args[0] === "print"
        ? { status: 0, stdout: "state = waiting\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    }));
    check("remove unloads and removes only the plist", removed.removed && !existsSync(installed.plistPath));
  }
  {
    // Removal must stay reachable after the folder itself is gone, or a client
    // who deletes the watched folder strands a loaded LaunchAgent forever.
    const strandedPath = join(directory, "stranded", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      corpora: { ...baseManifest.corpora, local_folder: { enabled: true, path: join(directory, "deleted-folder") } },
    }, strandedPath);
    const strandedHome = join(directory, "stranded-home");
    const expectedPlist = join(strandedHome, "Library", "LaunchAgents", "com.brain-installer.acme-brain.folder-ingest.plist");
    mkdirSync(dirname(expectedPlist), { recursive: true });
    writeFileSync(expectedPlist, "old folder scheduler\n");
    const launchctl = () => ({ status: 1, stdout: "", stderr: "not loaded" });
    const status = statusFolderScheduler(strandedPath, opts({ home: strandedHome, launchctl }));
    check("status stays reachable and states why the schedule is broken",
      status.installed && /does not exist as a folder/.test(status.scheduleError || ""), status.scheduleError);
    const removed = removeFolderScheduler(strandedPath, opts({ home: strandedHome, launchctl }));
    check("remove stays reachable after the watched folder is deleted",
      removed.removed && !existsSync(expectedPlist));
  }

  /* ================= the scheduled tick ================= */
  {
    let child = null;
    const result = runFolderIngest(manifestPath, opts({
      env: {
        HOME: home,
        CLOUDFLARE_API_TOKEN: "deployment-secret",
        ADMIN_KEY: "ambient-key",
      },
      spawn: (command, args, options) => { child = { command, args, options }; return { status: 0 }; },
    }));
    check("a tick invokes lockf around the ordinary local ingest, not a new command",
      child.command === "/usr/bin/lockf" && JSON.stringify(child.args) === JSON.stringify([
        "-k", "-s", "-t", "0", result.lockPath,
        resolve("/opt/node/bin/node"), resolve("/opt/brain installer/brain.mjs"),
        "ingest", manifestPath, "--path", watched, "--source", "documents",
      ]), JSON.stringify(child?.args));
    check("the tick's child environment is scrubbed of every credential",
      CLOUDFLARE_CREDENTIAL_ENV.every((name) => child.options.env[name] === undefined) &&
      child.options.env.ADMIN_KEY === undefined && child.options.env.HOME === home,
      JSON.stringify(child.options.env));
    check("a successful tick reports complete", result.status === "complete" && result.code === 0);
  }
  {
    const busy = runFolderIngest(manifestPath, opts({
      env: { HOME: home },
      spawn: () => ({ status: 75 }),
    }));
    check("lock contention skips a tick with the folder busy reason",
      busy.status === "skipped" && busy.code === 0 && /watched folder ingest is already running/.test(busy.reason),
      JSON.stringify(busy));
  }
  {
    const boundPath = join(directory, "bound-config", "brain.manifest.json");
    const otherFolder = join(directory, "somewhere else");
    mkdirSync(otherFolder, { recursive: true });
    writeManifest(baseManifest, boundPath);
    const original = buildFolderSchedulerPlan(boundPath, opts());
    writeManifest({
      ...baseManifest,
      corpora: { ...baseManifest.corpora, local_folder: { enabled: true, path: otherFolder, source: "documents" } },
    }, boundPath);
    let error = null, spawned = false;
    try {
      runFolderIngest(boundPath, opts({
        expectedConfigHash: original.configHash,
        spawn: () => { spawned = true; return { status: 0 }; },
      }));
    } catch (caught) { error = caught; }
    check("repointing the folder after install stops the tick before any child runs",
      /watched folder configuration changed.*reinstall/i.test(error?.message) && !spawned, error?.message);
  }

  /* ================= what a tick does to the folder ================= */
  //
  // The ingest command decides three things per file: unchanged when the
  // content hash matches the resume state, re-send when it differs, new when
  // there is no entry. This exercises the real walk/prepare/state helpers with
  // that same decision, then asserts below that the command is still wired to
  // them, so the two cannot drift apart silently.
  {
    const root = join(directory, "lane");
    const statePath = join(directory, "lane-state", ".brain-ingest-documents.json");
    mkdirSync(root, { recursive: true });
    const put = (rel, content) => {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    };

    const tick = async ({ interruptAfter = Infinity } = {}) => {
      const state = loadState(statePath);
      const { files, skipped } = walk(root, {});
      const sent = [];
      const unchanged = [];
      let processed = 0;
      for (const file of files) {
        if (processed >= interruptAfter) break;
        processed++;
        const prepared = await prepare(file, { sourceName: "documents" });
        if (prepared.skip) continue;
        const key = prepared.envelope ? prepared.envelope.source_id : file.rel.split(/[\\/]/).join("/");
        if (state.done[key] === prepared.hash) { unchanged.push(key); continue; }
        sent.push(key);
        state.done[key] = prepared.hash;
        // State is written per accepted file, which is what makes an
        // interrupted run cost one file rather than the whole pass.
        saveState(statePath, state);
      }
      const present = new Set(files.map((f) => f.rel.split(/[\\/]/).join("/")));
      for (const skip of skipped) present.add(String(skip.path).split(/[\\/]/).join("/"));
      const removed = processed >= files.length
        ? removedSinceLastRun(Object.keys(state.done), present)
        : [];
      return { sent, unchanged, removed, files: files.length };
    };

    put("notes/renewal terms.md", "The renewal price holds at nine hundred dollars a month through March.");
    put("notes/warehouse.md", "Morgan Diaz collects the warehouse keys on the first of July.");

    const first = await tick();
    check("the first tick loads everything in the folder",
      first.sent.length === 2 && first.unchanged.length === 0, JSON.stringify(first));

    const second = await tick();
    check("a second tick over an untouched folder sends nothing",
      second.sent.length === 0 && second.unchanged.length === 2, JSON.stringify(second));

    put("exports/saved call.vtt",
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nAlex Rivera: The notice period is now thirty days.\n");
    const third = await tick();
    check("a file dropped in after the first run is picked up on the next tick",
      third.sent.length === 1 && third.sent[0] === "exports/saved call.vtt" && third.unchanged.length === 2,
      JSON.stringify(third));

    put("notes/warehouse.md", "Morgan Diaz collects the warehouse keys on the eighth of July, not the first.");
    const fourth = await tick();
    check("a file whose contents changed is re-sent, and only that file",
      fourth.sent.length === 1 && fourth.sent[0] === "notes/warehouse.md" && fourth.unchanged.length === 2,
      JSON.stringify(fourth));

    unlinkSync(join(root, "notes", "renewal terms.md"));
    const fifth = await tick();
    check("a file deleted from the folder is reported as removed, exactly once",
      fifth.removed.length === 1 && fifth.removed[0] === "notes/renewal terms.md" && fifth.sent.length === 0,
      JSON.stringify(fifth));

    const state = loadState(statePath);
    check("removal is computed from the resume state, not from a second ledger",
      Object.keys(state.done).sort().join(",") ===
        "exports/saved call.vtt,notes/renewal terms.md,notes/warehouse.md",
      JSON.stringify(Object.keys(state.done)));
    check("a file merely SKIPPED this run does not count as deleted",
      removedSinceLastRun(["a.md", "b.md"], new Set(["a.md", "b.md"])).length === 0 &&
      removedSinceLastRun(["a.md", "b.md"], new Set(["a.md"])).join(",") === "b.md");
  }
  {
    // Resumability, the way a real tick is interrupted: the laptop sleeps
    // partway through and the next tick continues rather than restarting.
    const root = join(directory, "resume");
    const statePath = join(directory, "resume-state", ".brain-ingest-documents.json");
    mkdirSync(root, { recursive: true });
    for (let n = 1; n <= 6; n++) {
      writeFileSync(join(root, `note-${n}.md`),
        `Invoice ${n} was approved by Priya Nair and paid the following week without any dispute.`);
    }
    const pass = async (limit) => {
      const state = loadState(statePath);
      const { files } = walk(root, {});
      let sent = 0;
      let seen = 0;
      for (const file of files) {
        if (seen >= limit) break;
        seen++;
        const prepared = await prepare(file, { sourceName: "documents" });
        const key = prepared.envelope.source_id;
        if (state.done[key] === prepared.hash) continue;
        state.done[key] = prepared.hash;
        saveState(statePath, state);
        sent++;
      }
      return sent;
    };
    const before = await pass(2);
    const resumed = await pass(Infinity);
    check("an interrupted tick resumes instead of restarting",
      before === 2 && resumed === 4 && Object.keys(loadState(statePath).done).length === 6,
      JSON.stringify({ before, resumed }));
  }

  /* ================= the command is really wired to all of this ================= */
  {
    const cli = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
    const ingestIndex = cli.indexOf("async function cmdIngest(manifestPath)");
    const forgetIndex = cli.indexOf("export function validateForgetReceipt", ingestIndex);
    const local = cli.slice(ingestIndex, forgetIndex);
    check("the local ingest lane computes deletions with the shared helper",
      /removedSinceLastRun\(previouslyKnownKeys, protectedLocalSkipKeys\)/.test(local), "helper call not found");
    check("deletions are refused under --limit, where an unseen file is not a deleted one",
      /flags\.limit\s*\n?\s*\?\s*\[\]/.test(local), "limit guard not found");
    const planIndex = local.indexOf("buildDriveRemovalPlan({");
    const assertIndex = local.indexOf("assertDriveRemovalPlanSafe(", planIndex);
    const applyIndex = local.indexOf("applyDriveRemovals({", assertIndex);
    check("every removal reason goes into one plan",
      planIndex > 0 && ["storedFamilies", "activeFamilies", "policyCandidates", "vanishedCandidates", "intentionalCandidates"]
        .every((field) => new RegExp(`\\b${field}\\b`).test(local.slice(planIndex, assertIndex))),
      "aggregate plan is missing a category");
    check("and the plan is approved BEFORE anything is removed",
      assertIndex > planIndex && applyIndex > assertIndex, JSON.stringify({ planIndex, assertIndex, applyIndex }));
    check("the folder lane's tick argv is the documented ingest command",
      /"ingest", plan\.path, "--path", plan\.folderPath, "--source", plan\.folderSource/
        .test(readFileSync(new URL("../operations/folder-scheduler.mjs", import.meta.url), "utf8")));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nfolder scheduler: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
