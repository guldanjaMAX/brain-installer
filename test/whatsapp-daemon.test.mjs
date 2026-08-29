// test/whatsapp-daemon.test.mjs
//
// Supervision for WhatsApp capture, proven with the exact technique
// test/imessage-scheduler.test.mjs and test/drive-scheduler.test.mjs use: a
// synthetic manifest in a sandbox home, a scripted launchctl closure, and
// fixed node/brain paths — no real launchd interaction, no real daemon
// process, no network.
//
// Two agents are under test because WhatsApp capture is genuinely two
// processes with opposite lifecycles:
//   - the RESIDENT daemon (operations/whatsapp-daemon.mjs), RunAtLoad +
//     KeepAlive, holding a live websocket;
//   - the TICK drain (operations/whatsapp-drain-scheduler.mjs), a
//     run-to-completion pass on the SHARED generalized scheduler that Drive
//     and iMessage already use.
//
// The file also pins the decision that keeps them apart: the shared tick
// scheduler is untouched by the persistent shape, and both connectors still
// build fully distinct labels, plists, logs and locks.
//
// WHAT THIS CANNOT PROVE: that launchd actually keeps the daemon alive across
// a crash or a reboot. Named in evidence/WP-07-cli.md. Windows supervision is
// a separate mechanism in operations/windows-supervision.mjs with its own
// suite, test/windows-supervision.test.mjs.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  WHATSAPP_DAEMON_SPEC,
  WHATSAPP_DAEMON_THROTTLE_SECONDS,
  buildWhatsappDaemonPlan,
  installWhatsappDaemon,
  removeWhatsappDaemon,
  renderDaemonPlist,
  statusWhatsappDaemon,
  whatsappDaemonReference,
} from "../operations/whatsapp-daemon.mjs";
import {
  WHATSAPP_DRAIN_DEFAULT_CRON,
  WHATSAPP_DRAIN_SCHEDULER_SPEC,
  buildWhatsappDrainSchedulerPlan,
  installWhatsappDrainScheduler,
  removeWhatsappDrainScheduler,
  statusWhatsappDrainScheduler,
} from "../operations/whatsapp-drain-scheduler.mjs";
import { buildDriveSchedulerPlan } from "../operations/drive-scheduler.mjs";
import { buildImessageSchedulerPlan } from "../operations/imessage-scheduler.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const directory = mkdtempSync(join(tmpdir(), "brain-whatsapp-daemon-"));
const home = join(directory, "home & logs");
const manifestPath = join(directory, "client & manifest", "brain.manifest.json");

// An executable stand-in for the compiled Go daemon. Nothing runs it here;
// the installer only needs it to exist and be executable, because a
// LaunchAgent pointed at a missing binary is a job that fails every thirty
// seconds forever while reporting itself installed.
const binaryPath = join(directory, "wa-daemon-darwin-arm64");
writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
chmodSync(binaryPath, 0o755);

const baseManifest = {
  manifest_version: 1,
  client: { slug: "acme-brain", display_name: "Acme", timezone: "America/Phoenix" },
  brain: { version: "0.1.22", domain: "brain.acme.test" },
  infrastructure: { cloudflare: { account_id: "account-123" } },
  corpora: { google_drive: { enabled: true }, imessage: { enabled: true }, whatsapp: { enabled: true } },
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
    binaryPath,
    ...extra,
  };
}

// A scripted launchctl: records every invocation, answers from a queue.
function scriptedLaunchctl(script = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(" "));
    const verb = args[0];
    const handler = script[verb];
    const result = typeof handler === "function" ? handler(args, calls) : handler;
    return result || { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

// launchctl print for a service that is not loaded: real launchctl exits 113.
const NOT_LOADED = { status: 113, stdout: "", stderr: "Could not find service" };
const LOADED = {
  status: 0,
  stdout: "state = running\n  pid = 4242\n  runs = 3\n  last exit code = 0\n",
};

try {
  writeManifest();

  /* ================== the persistent shape, in the plist ================== */
  {
    const plan = buildWhatsappDaemonPlan(manifestPath, opts());
    check("the daemon label is client-scoped and distinct from every tick agent",
      plan.label === "com.brain-installer.acme-brain.whatsapp-daemon", plan.label);
    check("the LaunchAgent runs the compiled daemon directly, with no node wrapper",
      plan.programArguments.length === 1 && plan.programArguments[0] === binaryPath,
      JSON.stringify(plan.programArguments));

    const plist = renderDaemonPlist(plan);
    check("RunAtLoad and KeepAlive are both set: this is a resident process, not a tick",
      /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist) && /<key>KeepAlive<\/key>\s*<true\/>/.test(plist),
      plist.slice(0, 400));
    check("there is no StartCalendarInterval: a daemon is never scheduled",
      !plist.includes("StartCalendarInterval"));
    check("a restart throttle keeps a broken install from spinning the battery flat",
      plist.includes(`<key>ThrottleInterval</key>\n  <integer>${WHATSAPP_DAEMON_THROTTLE_SECONDS}</integer>`),
      String(WHATSAPP_DAEMON_THROTTLE_SECONDS));
    // The sandbox home deliberately contains an ampersand, so this also proves
    // the plist escapes rather than emitting invalid XML.
    const escapedDataDir = plan.dataDir.replaceAll("&", "&amp;");
    check("the working directory is the daemon's own data directory, never an inherited cwd",
      plist.includes(`<key>WorkingDirectory</key>\n  <string>${escapedDataDir}</string>`) &&
      escapedDataDir !== plan.dataDir,
      plan.dataDir);

    /* ---- the credential claim, asserted rather than asserted-in-prose ---- */
    check("the plist carries WA_DATA_DIR and OS basics only",
      Object.keys(plan.environment).sort().join(",") === "HOME,PATH,WA_DATA_DIR",
      JSON.stringify(plan.environment));
    check("no credential material of any kind reaches the resident process",
      !plist.includes("keychain://") && !plist.includes("CLOUDFLARE") &&
      !plist.includes("ADMIN") && !plist.includes("TOKEN") && !plist.includes("brain.acme.test"),
      plist.slice(0, 600));
    check("the daemon's two SQLite files are resolved under one data directory",
      plan.outboxPath === join(plan.dataDir, "wa-outbox.db") &&
      plan.sessionDbPath === join(plan.dataDir, "wa-session.db"),
      JSON.stringify({ outbox: plan.outboxPath, session: plan.sessionDbPath }));
  }

  /* ============ the manifest knob steers BOTH halves identically ========== */
  {
    const pinned = join(directory, "pinned-dir", "brain.manifest.json");
    const dataDir = join(directory, "pinned data dir");
    writeManifest({
      ...baseManifest,
      operations: { ...baseManifest.operations, whatsapp_data_dir: dataDir },
    }, pinned);
    const plan = buildWhatsappDaemonPlan(pinned, opts());
    check("operations.whatsapp_data_dir moves the daemon's directory",
      plan.dataDir === resolve(dataDir) && plan.environment.WA_DATA_DIR === resolve(dataDir),
      plan.dataDir);
    check("the daemon writing one directory while the drain reads another is impossible by construction",
      plan.outboxPath === join(resolve(dataDir), "wa-outbox.db"), plan.outboxPath);
  }

  /* ====================== the tick drain, on the shared scheduler ========= */
  {
    const plan = buildWhatsappDrainSchedulerPlan(manifestPath, opts());
    check("the drain label is distinct from the daemon's",
      plan.label === "com.brain-installer.acme-brain.whatsapp-drain", plan.label);
    check("the drain defaults to every minute, expressed as one empty calendar entry",
      plan.cron === WHATSAPP_DRAIN_DEFAULT_CRON && JSON.stringify(plan.intervals) === JSON.stringify([{}]),
      JSON.stringify({ cron: plan.cron, intervals: plan.intervals }));
    check("an every-minute drain derives a one-minute freshness expectation",
      plan.expectedRefreshSeconds === 60, String(plan.expectedRefreshSeconds));
    check("the drain LaunchAgent invokes the shared scheduler runner with a configuration binding",
      plan.programArguments[1] === resolve("operations/whatsapp-drain-scheduler.mjs") &&
      JSON.stringify(plan.programArguments.slice(2, 7)) === JSON.stringify([
        "run", manifestPath, "--brain", resolve("/opt/brain installer/brain.mjs"), "--config-hash",
      ]) && /^[a-f0-9]{64}$/.test(plan.configHash),
      JSON.stringify(plan.programArguments));
    check("the child that runner spawns is the real CLI verb, so the credential gate applies to it too",
      JSON.stringify(WHATSAPP_DRAIN_SCHEDULER_SPEC.childArgumentsOf(plan)) ===
      JSON.stringify(["ingest", manifestPath, "--from", "whatsapp"]),
      JSON.stringify(WHATSAPP_DRAIN_SCHEDULER_SPEC.childArgumentsOf(plan)));
    check("the manifest cron knob overrides the built-in default",
      buildWhatsappDrainSchedulerPlan(
        writeManifest({ ...baseManifest, operations: { ...baseManifest.operations, whatsapp_drain_cron: "*/5 * * * *" } },
          join(directory, "drain-cron", "brain.manifest.json")),
        opts()
      ).expectedRefreshSeconds === 300);
  }

  /* ============ four agents coexist without colliding on anything ========= */
  {
    const drive = buildDriveSchedulerPlan(manifestPath, opts({
      schedulerPath: "/opt/brain installer/operations/drive-scheduler.mjs",
    }));
    const imessage = buildImessageSchedulerPlan(manifestPath, opts());
    const daemon = buildWhatsappDaemonPlan(manifestPath, opts());
    const drain = buildWhatsappDrainSchedulerPlan(manifestPath, opts());
    const labels = [drive.label, imessage.label, daemon.label, drain.label];
    const plists = [drive.plistPath, imessage.plistPath, daemon.plistPath, drain.plistPath];
    const logs = [drive.stdoutPath, imessage.stdoutPath, daemon.stdoutPath, drain.stdoutPath];
    check("all four agents have distinct labels, plists and logs",
      new Set(labels).size === 4 && new Set(plists).size === 4 && new Set(logs).size === 4,
      JSON.stringify({ labels, logs }));
    check("adding the persistent shape left Drive's identity exactly as it was",
      drive.label === "com.brain-installer.acme-brain.drive-ingest" &&
      drive.stdoutPath.endsWith("acme-brain-drive-ingest.out.log"), drive.label);
    check("adding the persistent shape left iMessage's identity exactly as it was",
      imessage.label === "com.brain-installer.acme-brain.imessage-capture" &&
      imessage.stdoutPath.endsWith("acme-brain-imessage-capture.out.log"), imessage.label);
    // The shared identity helper hands every plan a lockPath field. The tick
    // runner actually WRAPS its child in lockf at run time; the daemon module
    // never reads the field, so the resident process takes no lock — which is
    // the point, since a lock it never releases would fight KeepAlive's own
    // restarts. Asserted against the plist, not against the vestigial field.
    const daemonPlist = renderDaemonPlist(daemon);
    check("the resident daemon takes no single-instance lock: launchd owns restarts",
      !daemonPlist.includes("lockf") && !daemonPlist.includes(".lock") &&
      daemon.programArguments.length === 1,
      JSON.stringify(daemon.programArguments));
    check("the tick drain still routes its child through the shared lockf wrapper",
      typeof drain.lockPath === "string" && drain.lockPath.endsWith("acme-brain-whatsapp-drain.lock"),
      drain.lockPath);
  }

  /* ============================== validation ============================= */
  {
    let error = null;
    try { buildWhatsappDaemonPlan(manifestPath, opts({ platform: "win32" })); } catch (caught) { error = caught; }
    // This module supervises with launchd and only launchd. A Windows caller
    // arriving here is a routing bug, so the refusal has to name the module
    // that should have been used rather than reading as a missing capability.
    check("a Windows caller is refused and pointed at the Windows supervisor",
      /windows-supervision\.mjs/.test(error?.message) && /Scheduled Task/.test(error?.message), error?.message);
  }
  {
    const disabled = join(directory, "wa-disabled", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { google_drive: { enabled: true } } }, disabled);
    let error = null;
    try { buildWhatsappDaemonPlan(disabled, opts()); } catch (caught) { error = caught; }
    check("corpora.whatsapp.enabled must be declared before the daemon can be installed",
      /corpora\.whatsapp\.enabled must be true/.test(error?.message), error?.message);
    // ...but the REFERENCE still resolves, which is what keeps removal reachable.
    check("the reference still resolves with the corpus off, so removal stays reachable",
      whatsappDaemonReference(disabled, opts()).label === "com.brain-installer.acme-brain.whatsapp-daemon");
  }
  {
    let error = null;
    try {
      buildWhatsappDaemonPlan(manifestPath, opts({
        binaryPath: null, env: {}, arch: "arm64",
      }));
    } catch (caught) { error = caught; }
    check("installing without a daemon binary refuses with the build command, not a stack trace",
      error?.reason === "daemon_binary_missing" && /build\.sh/.test(error?.message), error?.message);
  }

  /* ======================= install: the real sequence ==================== */
  {
    const launchctl = scriptedLaunchctl({ print: NOT_LOADED });
    const installed = installWhatsappDaemon(manifestPath, opts({ launchctl }));
    check("install writes the plist and reports itself loaded",
      installed.installed === true && installed.loaded === true && existsSync(installed.plistPath),
      JSON.stringify({ plist: installed.plistPath }));
    check("install checks, enables, then bootstraps, in that order",
      launchctl.calls[0].startsWith("print gui/501/") &&
      launchctl.calls[1].startsWith("enable gui/501/") &&
      launchctl.calls[2].startsWith("bootstrap gui/501 "),
      JSON.stringify(launchctl.calls));
    check("nothing was booted out, because nothing was loaded to begin with",
      !launchctl.calls.some((c) => c.startsWith("bootout")), JSON.stringify(launchctl.calls));
    check("the plist on disk is exactly what the plan renders",
      readFileSync(installed.plistPath, "utf-8") ===
      renderDaemonPlist(buildWhatsappDaemonPlan(manifestPath, opts())));
    check("the data directory is created private to the owner",
      existsSync(installed.dataDir), installed.dataDir);

    /* ---- status reflects a loaded daemon and parses launchctl's report ---- */
    const status = statusWhatsappDaemon(manifestPath, opts({
      launchctl: scriptedLaunchctl({ print: LOADED }),
    }));
    check("status reports installed, loaded, running, with the pid launchd gave",
      status.installed === true && status.loaded === true && status.running === true &&
      status.pid === 4242 && status.definitionDrift === false,
      JSON.stringify({ installed: status.installed, pid: status.pid, drift: status.definitionDrift }));
    check("status distinguishes a paired session from an empty data directory",
      status.pairedSessionExists === false && status.outboxExists === false,
      JSON.stringify({ session: status.pairedSessionExists, outbox: status.outboxExists }));
  }

  /* ======= reinstall over a RUNNING daemon is allowed, unlike a tick ====== */
  {
    // This is the whole reason the persistent shape is a sibling module: for a
    // tick, "running" means a pass is mid-flight and replacing it is unsafe.
    // For a daemon, running is the normal condition, and refusing here would
    // mean the operator has to stop capture in order to fix capture.
    const launchctl = scriptedLaunchctl({ print: LOADED });
    const again = installWhatsappDaemon(manifestPath, opts({ launchctl }));
    check("reinstalling while the daemon is running succeeds instead of refusing",
      again.installed === true && again.replaced === true, JSON.stringify({ replaced: again.replaced }));
    check("the running daemon is booted out before its definition is replaced",
      launchctl.calls.some((c) => c.startsWith("bootout gui/501/")) &&
      launchctl.calls.findIndex((c) => c.startsWith("bootout")) <
      launchctl.calls.findIndex((c) => c.startsWith("bootstrap")),
      JSON.stringify(launchctl.calls));
  }

  /* =========================== uninstall ================================= */
  {
    const launchctl = scriptedLaunchctl({ print: LOADED });
    const removed = removeWhatsappDaemon(manifestPath, opts({ launchctl }));
    check("removal boots the daemon out and deletes its definition",
      removed.removed === true && removed.wasLoaded === true && !existsSync(removed.plistPath),
      JSON.stringify({ removed: removed.removed, plist: removed.plistPath }));
    check("removal stops the process before deleting the plist",
      launchctl.calls.some((c) => c.startsWith("bootout gui/501/")), JSON.stringify(launchctl.calls));

    const second = removeWhatsappDaemon(manifestPath, opts({ launchctl: scriptedLaunchctl({ print: NOT_LOADED }) }));
    check("removing an already-removed daemon is a no-op, not an error",
      second.removed === false && second.wasLoaded === false, JSON.stringify(second));
  }
  {
    // The precedent the iMessage and Drive removals set: switching a corpus
    // off must never strand an already-loaded LaunchAgent.
    const off = join(directory, "removal-with-corpus-off", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { google_drive: { enabled: true } } }, off);
    const launchctl = scriptedLaunchctl({ print: LOADED });
    const removed = removeWhatsappDaemon(off, opts({ launchctl }));
    check("removal works with corpora.whatsapp.enabled already false",
      removed.wasLoaded === true && launchctl.calls.some((c) => c.startsWith("bootout")),
      JSON.stringify(launchctl.calls));
  }
  {
    // A deleted binary must not block stopping the process that pointed at it.
    const gone = join(directory, "removal-with-binary-gone", "brain.manifest.json");
    writeManifest(baseManifest, gone);
    const launchctl = scriptedLaunchctl({ print: LOADED });
    const removed = removeWhatsappDaemon(gone, opts({ launchctl, binaryPath: undefined, env: {} }));
    check("removal works when the daemon binary has been deleted",
      removed.wasLoaded === true && removed.loaded === false, JSON.stringify(removed));
  }

  /* ================= the drain agent installs and uninstalls ============= */
  {
    const launchctl = scriptedLaunchctl({ print: NOT_LOADED });
    const installed = installWhatsappDrainScheduler(manifestPath, opts({ launchctl }));
    check("the drain LaunchAgent installs through the shared, already-hardened path",
      installed.installed === true && existsSync(installed.plistPath), installed.plistPath);
    const plist = readFileSync(installed.plistPath, "utf-8");
    check("the drain's plist schedules a tick and carries no credential material",
      plist.includes("StartCalendarInterval") && !plist.includes("keychain://") &&
      !plist.includes("CLOUDFLARE"), plist.slice(0, 300));
    const status = statusWhatsappDrainScheduler(manifestPath, opts({ launchctl: scriptedLaunchctl({ print: LOADED }) }));
    check("the drain reports itself installed and loaded with no definition drift",
      status.installed === true && status.loaded === true && status.definitionDrift === false,
      JSON.stringify({ installed: status.installed, drift: status.definitionDrift }));
    const removed = removeWhatsappDrainScheduler(manifestPath, opts({ launchctl: scriptedLaunchctl({ print: LOADED }) }));
    check("the drain LaunchAgent is removed and its definition deleted",
      removed.removed === true && !existsSync(removed.plistPath), JSON.stringify(removed));
  }

  /* ====================== the spec states its own truth ================== */
  {
    check("the daemon spec names itself as a daemon, not a scheduler",
      WHATSAPP_DAEMON_SPEC.kind === "whatsapp-daemon", WHATSAPP_DAEMON_SPEC.kind);
    check("the module says in its own source that it is the launchd half, and names the other one",
      /supervises with launchd/.test(
        readFileSync(new URL("../operations/whatsapp-daemon.mjs", import.meta.url), "utf-8")
      ) && /operations\/windows-supervision\.mjs/.test(
        readFileSync(new URL("../operations/whatsapp-daemon.mjs", import.meta.url), "utf-8")
      ));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nwhatsapp daemon supervision: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
