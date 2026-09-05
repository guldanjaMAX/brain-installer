/**
 * Error-path behaviour, asserted rather than hoped for.
 *
 * Install number one runs live on a client's machine while they watch. What
 * they see when something goes wrong is a product surface, so it gets tests
 * like any other.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { previewSupportJournal } from "../support-journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "brain.mjs");
function filesBelow(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
  });
}
const PUBLIC_MARKDOWN_GUIDANCE = [
  join(ROOT, "README.md"),
  join(ROOT, "CHANGELOG.md"),
  ...filesBelow(join(ROOT, "docs"), ".md").filter((path) => !/-readiness-/.test(path)),
  ...filesBelow(join(ROOT, "onboarding"), ".md"),
  // The migration tool is private to the transition and not in npm, but its
  // operator instructions are still public guidance in this repository.
  join(ROOT, "migration", "README.md"),
];
const PUBLIC_CLI_GUIDANCE = [
  ...["acceptance.mjs", "brain.mjs", "doctor.mjs", "report-html.mjs", "report.mjs", "support-journal.mjs"]
    .map((name) => join(ROOT, name)),
  ...["components", "connectors", "eval", "ingest", "operations"]
    .flatMap((directory) => filesBelow(join(ROOT, directory), ".mjs"))
    .filter((path) => !/\.test\.mjs$/.test(path)),
];
const PUBLIC_SECRET_GUIDANCE = [
  ...new Set([...PUBLIC_MARKDOWN_GUIDANCE, ...PUBLIC_CLI_GUIDANCE]),
];
const INGEST_EXIT_FETCH = pathToFileURL(join(HERE, "fixtures", "ingest-exit-fetch.mjs")).href;
const ISOLATE_SUPPORT_ROOT = pathToFileURL(join(HERE, "fixtures", "isolate-support-root.mjs")).href;
const UNEXPECTED_CRASH = pathToFileURL(join(HERE, "fixtures", "unexpected-crash.mjs")).href;
const UNWRITABLE_SUPPORT = pathToFileURL(join(HERE, "fixtures", "unwritable-support.mjs")).href;
let fail = 0, ran = 0;
let observedConfigFingerprint = "";
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const journalEvents = (text) => typeof text === "string" && text.trim()
  ? text.trim().split("\n").map((line) => JSON.parse(line))
  : [];
function readSupportJournal(userRoot) {
  const supportRoot = join(userRoot, ".brain", "support");
  if (!existsSync(supportRoot)) return "";
  try { return previewSupportJournal({ root: userRoot }); }
  catch { return null; }
}
function cli(args, env = {}, options = {}) {
  const userRoot = options.userRoot || mkdtempSync(join(tmpdir(), "brain-support-cli-"));
  const e = { ...process.env, ...env };
  delete e.CLOUDFLARE_API_TOKEN;
  delete e.ADMIN_KEY;
  delete e.BRAIN_DEBUG;
  e.BRAIN_TEST_USER_ROOT = userRoot;
  // These assert what happens when NO Cloudflare credential exists. A
  // `wrangler login` on the machine running the suite is a credential, so pin
  // it off rather than letting the result depend on who is signed in.
  e.BRAIN_NO_WRANGLER_LOGIN = "1";
  const imports = [ISOLATE_SUPPORT_ROOT, ...(options.imports || [])];
  const nodeArguments = imports.flatMap((specifier) => ["--import", specifier]);
  // Generous: on a cold machine the Cloudflare checks download wrangler before
  // they can answer, which is minutes, not seconds.
  const r = spawnSync("node", [...nodeArguments, CLI, ...args], {
    encoding: "utf-8", env: e, timeout: 300_000,
  });
  const journal = readSupportJournal(userRoot);
  if (!options.keepUserRoot) rmSync(userRoot, { recursive: true, force: true });
  return { code: r.status, out: strip(`${r.stdout || ""}${r.stderr || ""}`), journal, userRoot };
}

/* ---- an unexpected crash records exactly one sanitized internal note ---- */
{
  const rawSentinel = "RAW_UNEXPECTED_CRASH_SENTINEL";
  const r = cli(["whatsnew"], {}, { imports: [UNEXPECTED_CRASH] });
  const events = journalEvents(r.journal);
  check("an unexpected command crash exits through the guarded failure path",
    r.code === 1 && /unexpected error|This is a bug in the installer/.test(r.out), r.out.slice(0, 260));
  check("an unexpected crash creates exactly one INTERNAL_ERROR issue note",
    events.length === 1 && events[0]?.command === "whatsnew" && events[0]?.error_code === "INTERNAL_ERROR",
    r.journal);
  check("the unexpected crash note has a product call-site fingerprint and no raw error text",
    /^loc_[0-9a-f]{24}$/.test(events[0]?.fingerprint || "") && !r.journal.includes(rawSentinel), r.journal);
}

/* ---- an unsafe journal never replaces the command's original failure ---- */
{
  const userRoot = mkdtempSync(join(tmpdir(), "brain-support-unsafe-"));
  const brainRoot = join(userRoot, ".brain");
  const unsafeSupportPath = join(brainRoot, "support");
  const missingManifest = join(userRoot, "original-missing.manifest.json");
  mkdirSync(brainRoot, { mode: 0o700 });
  writeFileSync(unsafeSupportPath, "preserve unsafe journal path", { mode: 0o600 });
  const r = cli(["status", missingManifest], {}, { userRoot, keepUserRoot: true });
  check("an unsafe journal leaves the original command failure intact",
    r.code === 1 && /original-missing\.manifest\.json/.test(r.out) && !/unexpected error/i.test(r.out), r.out);
  check("an unsafe journal adds no misleading receipt and changes no unsafe path",
    r.journal === null && !/Private issue note/.test(r.out) &&
      readFileSync(unsafeSupportPath, "utf8") === "preserve unsafe journal path", r.out);
  rmSync(userRoot, { recursive: true, force: true });
}

{
  const userRoot = mkdtempSync(join(tmpdir(), "brain-support-unwritable-"));
  const missingManifest = join(userRoot, "write-blocked.manifest.json");
  const r = cli(["status", missingManifest], {}, {
    userRoot,
    keepUserRoot: true,
    imports: [UNWRITABLE_SUPPORT],
  });
  check("an unwritable journal also leaves the original command failure intact",
    r.code === 1 && /write-blocked\.manifest\.json/.test(r.out) && !/unexpected error/i.test(r.out) &&
      !/Private issue note/.test(r.out) && r.journal === "", r.out);
  rmSync(userRoot, { recursive: true, force: true });
}

function ingestExitCli(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "brain-ingest-exit-"));
  const manifest = join(dir, "fixture.manifest.json");
  const source = join(dir, "source");
  const userRoot = join(dir, "isolated-user-root");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(userRoot, ".brain"), { recursive: true });
  writeFileSync(join(source, "fixture-note.txt"),
    "This fixture note has enough ordinary prose to pass extraction quality and reach the ingest receipt boundary safely.");
  writeFileSync(manifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: { google_drive: { root_folder_ids: ["root-fixture"] } },
  }));
  writeFileSync(join(userRoot, ".brain", "google-tokens.json"), JSON.stringify({
    google: {
      client_id: "fixture-client",
      client_secret: null,
      refresh_token: "fixture-refresh",
      scopes: ["drive"],
    },
  }), { mode: 0o600 });

  const env = {
    ...process.env,
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    BRAIN_INGEST_EXIT_TEST: scenario,
    BRAIN_INGEST_EXIT_USER_ROOT: userRoot,
    ADMIN_KEY: "fixture-admin",
  };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.BRAIN_DEBUG;
  const args = scenario.startsWith("drive")
    ? ["ingest", manifest, "--from", "drive"]
    : ["ingest", manifest, "--path", source];
  const result = spawnSync("node", ["--import", INGEST_EXIT_FETCH, CLI, ...args], {
    encoding: "utf-8", env, timeout: 30_000,
  });
  return {
    code: result.status,
    out: strip(`${result.stdout || ""}${result.stderr || ""}`),
    dir,
    statePath: join(dir, `.brain-ingest-${scenario.startsWith("drive") ? "drive" : "upload"}.json`),
    journal: readSupportJournal(userRoot),
  };
}

/* ---- a stack trace must never reach a client ---- */
{
  const directory = mkdtempSync(join(tmpdir(), "brain-err-"));
  const bad = join(directory, "nope.json");
  const r = cli(["status", bad]);
  const events = journalEvents(r.journal);
  observedConfigFingerprint = events[0]?.fingerprint || "";
  check("a missing manifest fails cleanly", r.code === 1);
  check("and shows no stack trace", !/\bat .*\.mjs:\d+/.test(r.out), r.out.slice(0, 200));
  check("and names the file it could not read", r.out.includes("nope.json"), r.out.slice(0, 160));
  check("the local issue note classifies the failure without copying its private path",
    events.length === 1 &&
      events[0]?.command === "status" &&
      events[0]?.error_code === "CONFIG_INVALID" &&
      /^loc_[0-9a-f]{24}$/.test(observedConfigFingerprint) &&
      !r.journal.includes("nope.json") && !r.journal.includes(directory), r.journal);
  rmSync(directory, { recursive: true, force: true });
}
{
  const d = mkdtempSync(join(tmpdir(), "brain-err-"));
  const p = join(d, "broken.json");
  writeFileSync(p, "{ this is not json at all");
  const r = cli(["status", p]);
  check("malformed JSON fails cleanly", r.code === 1);
  check("without a stack trace", !/\bat .*\.mjs:\d+/.test(r.out), r.out.slice(0, 200));
  rmSync(d, { recursive: true, force: true });
}

/* ---- expected failures explain themselves and stay quiet about internals ---- */
{
  const r = cli(["verify", join(HERE, "..", "templates", "brain.manifest.json")]);
  const events = journalEvents(r.journal);
  check("a missing token is an explained failure", r.code === 1 && /CLOUDFLARE_API_TOKEN/.test(r.out), r.out.slice(0, 160));
  check("and it gives a safe next step instead of a shell-history command",
    /brain setup.*brain update.*hidden token entry/is.test(r.out) &&
      !/export\s+CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_TOKEN\s*=\s*['\"]/i.test(r.out), r.out.slice(0, 400));
  // Fatal is anticipated, so it must NOT be dressed up as an installer bug.
  check("an anticipated failure is not reported as a bug", !/This is a bug in the installer/.test(r.out));
  check("anticipated auth failures create one private typed note and send no raw credential guidance",
    events.length === 1 &&
      events[0]?.command === "verify" &&
      events[0]?.error_code === "AUTH_REQUIRED" &&
      /^loc_[0-9a-f]{24}$/.test(events[0]?.fingerprint || "") &&
      events[0]?.fingerprint !== observedConfigFingerprint &&
      !r.journal.includes("CLOUDFLARE_API_TOKEN") &&
      /did not upload or send this issue note/.test(r.out), r.journal);
}

/* ---- public remediation must never teach people to paste a secret ---- */
{
  const secretNames = "(?:CLOUDFLARE_API_TOKEN|ADMIN_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_SERVICE_ROLE_KEY|GOOGLE_CLIENT_SECRET)";
  const pasteable = new RegExp(
    `(?:export\\s+${secretNames}\\b|\\$env:${secretNames}\\s*=|(?:^|[\\s;])${secretNames}\\s*=\\s*['\"<])`,
    "gmi",
  );
  const unsafeNarrative = [
    /\bexport\s+the\s+replacement\s+as\s+`?(?:ADMIN_KEY|CLOUDFLARE_API_TOKEN)\b/gmi,
    /\btoken\s+arrives\b/gmi,
    /\bleave\s+(?:the\s+)?api\s+token\s+exported\b/gmi,
    /\bsend\s+(?:it|the\s+(?:api\s+)?token)\s+(?:to\s+(?:me|us|support)|(?:over|through)\s+\[?agreed\s+channel\]?)/gmi,
  ];
  const offenders = PUBLIC_SECRET_GUIDANCE.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [pasteable, ...unsafeNarrative].flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => `${path}:${match[0].trim()}`));
  });
  check("public guidance and CLI contain no pasteable assignment or credential-transport instruction",
    offenders.length === 0, offenders.join(" | "));
}
{
  const r = cli(["ingest", join(HERE, "..", "templates", "brain.manifest.json"), "--path", "/definitely/not/here"]);
  check("a missing ingest folder is explained", r.code === 1 && /no such folder/i.test(r.out), r.out.slice(0, 200));
  check("and no stack trace", !/\bat .*\.mjs:\d+/.test(r.out));
  check("invalid local input is classified without retaining the path",
    journalEvents(r.journal)[0]?.error_code === "CONFIG_INVALID" &&
      journalEvents(r.journal)[0]?.source === "local" &&
      !r.journal.includes("definitely"), r.journal);
}

/* ---- a document-level receipt must fail the CLI after saving recovery state ---- */
{
  const r = ingestExitCli("local-failed");
  const state = JSON.parse(readFileSync(r.statePath, "utf-8"));
  const receiptAt = r.out.indexOf("TEST_LOCAL_ERROR_RECEIPT_RECORDED");
  const failureAt = r.out.indexOf("1 stored part failed, so this ingest is incomplete");
  check("a local document failure exits non-zero", r.code === 1, r.out.slice(-500));
  check("local resume state records the failed document before exit",
    Object.keys(state.done || {}).length === 0 && /part status was failed/.test(state.skipped?.["fixture-note.txt"] || ""),
    JSON.stringify(state));
  check("local source status is closed as error before the CLI fails",
    receiptAt !== -1 && failureAt > receiptAt, r.out.slice(-700));
  check("a known local document failure is not dressed up as an installer crash",
    !/unexpected error|This is a bug in the installer/.test(r.out), r.out.slice(-400));
  check("a failed local ingest never prints a green success summary",
    !/ok\s+0 created, 0 updated/.test(r.out), r.out.slice(-500));
  check("a failed local ingest creates a sanitized retry note",
    journalEvents(r.journal).length === 1 &&
      journalEvents(r.journal)[0]?.error_code === "INGEST_FAILED" &&
      journalEvents(r.journal)[0]?.source === "local" &&
      !r.journal.includes("fixture-note") && !r.journal.includes("synthetic"), r.journal);
  rmSync(r.dir, { recursive: true, force: true });
}
{
  const r = ingestExitCli("drive-failed");
  const state = JSON.parse(readFileSync(r.statePath, "utf-8"));
  const receiptAt = r.out.indexOf("TEST_REMOTE_ERROR_RECEIPT_RECORDED");
  const failureAt = r.out.indexOf("1 stored part failed, so this ingest is incomplete");
  check("a Drive document failure exits non-zero for launchd", r.code === 1, r.out.slice(-600));
  check("Drive resume state stays retryable and withholds its cursor",
    !("sync_token" in state) && Object.keys(state.done || {}).length === 0 &&
      /part status was failed/.test(state.skipped?.["drive:fixture-file-one"] || ""), JSON.stringify(state));
  check("Drive posts its error receipt before the CLI fails",
    receiptAt !== -1 && failureAt > receiptAt, r.out.slice(-800));
  check("Drive explains that the cursor was not advanced",
    /source cursor was NOT advanced/.test(r.out), r.out.slice(-700));
  check("a known Drive document failure is not dressed up as an installer crash",
    !/unexpected error|This is a bug in the installer/.test(r.out), r.out.slice(-400));
  check("a failed Drive ingest creates one typed note without a Drive id",
    journalEvents(r.journal).length === 1 &&
      journalEvents(r.journal)[0]?.error_code === "INGEST_FAILED" &&
      journalEvents(r.journal)[0]?.source === "drive" &&
      !r.journal.includes("fixture-file-one"), r.journal);
  rmSync(r.dir, { recursive: true, force: true });
}
{
  const r = ingestExitCli("local-refused");
  check("a credential refusal remains a reasoned outcome, not a failed run",
    r.code === 0 && /refused for carrying live credentials/.test(r.out) &&
      !/ingest is incomplete/.test(r.out), r.out.slice(-600));
  check("a successful policy refusal does not create an issue note", r.journal === "", r.journal);
  rmSync(r.dir, { recursive: true, force: true });
}

/* ---- support notes are reviewable and exportable, never transmitted ---- */
{
  const userRoot = mkdtempSync(join(tmpdir(), "brain-support-command-"));
  const missing = join(userRoot, "missing.manifest.json");
  const failed = cli(["status", missing], {}, { userRoot, keepUserRoot: true });
  const preview = cli(["support", "--preview"], {}, { userRoot, keepUserRoot: true });
  check("support preview returns the exact canonical bytes recorded by the failed command",
    failed.code === 1 && preview.code === 0 && preview.out === failed.journal, preview.out);
  if (process.platform !== "win32") {
    const legacyDirectories = [
      join(userRoot, ".brain"),
      join(userRoot, ".brain", "support"),
      join(userRoot, ".brain", "support", "events"),
    ];
    for (const directory of legacyDirectories) chmodSync(directory, 0o755);
    const legacyPreview = cli(["support", "--preview"], {}, { userRoot, keepUserRoot: true });
    check("support preview safely upgrades legacy installer directory modes",
      legacyPreview.code === 0 && legacyPreview.out === failed.journal &&
        legacyDirectories.every((directory) => (statSync(directory).mode & 0o777) === 0o700),
      legacyPreview.out);
  }

  const status = cli(["support"], {}, { userRoot, keepUserRoot: true });
  check("support status reports the bounded recent shareable count without exposing the home path",
    status.code === 0 && /1 recent shareable issue note\(s\) available to preview or export/i.test(status.out) &&
      /last 30 days, newest 200 notes, up to 2 MiB/i.test(status.out) &&
      /safe expired and overflow notes are cleaned up after writes/i.test(status.out) &&
      /fresh or concurrent files may remain until a later safe cleanup/i.test(status.out) &&
      /links and special files are refused and require manual review/i.test(status.out) &&
      !status.out.includes(userRoot) && !/stored locally/i.test(status.out), status.out);

  const exportPath = join(userRoot, "safe-support-export.jsonl");
  const exported = cli(["support", "--export", exportPath], {}, { userRoot, keepUserRoot: true });
  check("support export scopes its no-send claim to the installer and warns about destination sync",
    exported.code === 0 && readFileSync(exportPath, "utf-8") === failed.journal &&
      /the installer did not upload or send this export/i.test(exported.out) &&
      /a synced destination may upload it/i.test(exported.out) &&
      !/nothing was uploaded or sent/i.test(exported.out), exported.out);
  const existingRefusal = cli(["support", "--export", exportPath], {}, { userRoot, keepUserRoot: true });
  check("support export refuses overwrite as an expected user-facing failure, not an installer bug",
    existingRefusal.code === 1 && /refusing to overwrite/i.test(existingRefusal.out) &&
      !/This is a bug in the installer|unexpected error/i.test(existingRefusal.out) &&
      readFileSync(exportPath, "utf-8") === failed.journal, existingRefusal.out);

  const missingDirectoryExport = cli(
    ["support", "--export", join(userRoot, "missing-directory", "bundle.jsonl")],
    {}, { userRoot, keepUserRoot: true }
  );
  check("a missing support export directory is an expected failure and attributes no-send to the installer",
    missingDirectoryExport.code === 1 && /directory does not exist/i.test(missingDirectoryExport.out) &&
      /The installer did not upload or send anything/i.test(missingDirectoryExport.out) &&
      !/This is a bug in the installer|unexpected error/i.test(missingDirectoryExport.out),
    missingDirectoryExport.out);
  if (process.platform === "win32") {
    check("support export link refusal is covered on POSIX hosts", true);
  } else {
    const outside = join(userRoot, "outside-export-target.jsonl");
    const linked = join(userRoot, "linked-export.jsonl");
    writeFileSync(outside, "unchanged", { mode: 0o600 });
    symlinkSync(outside, linked);
    const linkRefusal = cli(["support", "--export", linked], {}, { userRoot, keepUserRoot: true });
    check("an unsafe support export link is refused without touching its target or blaming the installer",
      linkRefusal.code === 1 && /regular file|link/i.test(linkRefusal.out) &&
        readFileSync(outside, "utf-8") === "unchanged" &&
        !/This is a bug in the installer|unexpected error/i.test(linkRefusal.out), linkRefusal.out);
  }

  const previewOnlyClear = cli(["support", "--clear"], {}, { userRoot, keepUserRoot: true });
  check("support clear requires explicit confirmation and preserves the journal by default",
    previewOnlyClear.code === 0 && previewOnlyClear.journal === failed.journal &&
      /nothing was cleared/i.test(previewOnlyClear.out), previewOnlyClear.out);
  const cleared = cli(["support", "--clear", "--yes"], {}, { userRoot, keepUserRoot: true });
  check("confirmed support clear removes only the private journal",
    cleared.code === 0 && cleared.journal === "" && existsSync(exportPath), cleared.out);
  rmSync(userRoot, { recursive: true, force: true });
}

/* ---- unknown input is guided, not dumped ---- */
{
  const r = cli(["definitelynotacommand"]);
  check("an unknown command prints usage", /brain setup/.test(r.out), r.out.slice(0, 160));
  check("and exits non-zero", r.code === 1, String(r.code));
}
{
  const r = cli([]);
  check("no arguments prints usage and exits 0", /brain setup/.test(r.out) && r.code === 0, String(r.code));
}

/* ---- doctor must never be the thing that breaks ---- */
{
  const r = cli(["doctor"]);
  check("doctor reports even with nothing configured", /Node/.test(r.out), r.out.slice(0, 160));
  check("and shows no stack trace", !/\bat .*\.mjs:\d+/.test(r.out));
  check("and tells the reader what to fix", /What to do/.test(r.out) || /ready to install/.test(r.out), r.out.slice(-200));
}

/* ---- the network layer translates rather than leaking ---- */
{
  const mod = await import("../brain.mjs");
  check("brain.mjs imports without running the CLI", true);
  const outsideRoot = mkdtempSync(join(tmpdir(), "brain-support-stack-"));
  const outsideModule = join(outsideRoot, "private-caller.mjs");
  writeFileSync(outsideModule, "export default true;\n");
  const cliUrl = pathToFileURL(CLI).href;
  const outsideUrl = pathToFileURL(outsideModule).href;
  const syntheticStack = {
    stack:
      "Error: RAW_CALL_SITE_SENTINEL /private/outside/path\n" +
      `    at outside (${outsideUrl}:7:3)\n` +
      `    at die (${cliUrl}:144:9)\n` +
      `    at cmdStatus (${cliUrl}:2345:11)`,
  };
  const safeLocation = mod.supportProductRelativeLocation(syntheticStack);
  check("support call-site extraction skips outside and capture frames before validation",
    safeLocation === "brain.mjs:2345" && !safeLocation.includes("RAW_CALL_SITE_SENTINEL") &&
      !safeLocation.includes(outsideRoot), safeLocation);
  check("an outside-only stack yields no fingerprint input",
    mod.supportProductRelativeLocation({ stack: `Error: private\n    at outside (${outsideUrl}:7:3)` }) === null);
  rmSync(outsideRoot, { recursive: true, force: true });
  check("PDF process timeouts keep their specific support category",
    mod.supportErrorCode(new Error("PDF process timed out"), { command: "ingest", unexpected: true }) ===
      "PDF_PROCESS_TIMEOUT");
  check("ordinary network timeouts keep the network support category",
    mod.supportErrorCode(new Error("the request timed out"), { command: "ingest", unexpected: true }) ===
      "NETWORK_UNREACHABLE");
  let evalFailure = null;
  try { mod.assertEvalSucceeded({ ok: false }); } catch (error) { evalFailure = error; }
  check("a failed eval result throws so the top-level issue journal can observe it",
    /evaluation did not complete successfully/i.test(evalFailure?.message || ""), evalFailure?.message);

  let calls = 0, sleeps = 0, retries = 0;
  const value = await mod.retryTransient(async () => {
    calls++;
    if (calls < 3) throw new Error("temporary fetch failure");
    return "recovered";
  }, {
    attempts: 3,
    delayMs: 1,
    sleep: async () => { sleeps++; },
    onRetry: () => { retries++; },
  });
  check("a resumable operation retries transient failures", value === "recovered" && calls === 3, `${value}, calls=${calls}`);
  check("and waits plus reports only between attempts", sleeps === 2 && retries === 2, `sleeps=${sleeps} retries=${retries}`);

  let terminalCalls = 0, terminal = null;
  try {
    await mod.retryTransient(async () => {
      terminalCalls++;
      throw new Error("still offline");
    }, { attempts: 3, delayMs: 1, sleep: async () => {} });
  } catch (error) {
    terminal = error;
  }
  check("retry remains bounded and preserves the final error",
    terminalCalls === 3 && terminal?.message === "still offline", `calls=${terminalCalls} error=${terminal?.message}`);

  const docs = [{ source_id: "synthetic-doc", content: "synthetic body" }];
  const receipt = (status = "created") => JSON.stringify({
    created: status === "created" ? 1 : 0,
    updated: 0,
    unchanged: status === "unchanged" ? 1 : 0,
    refused: 0,
    failed: 0,
    results: [{ source_id: "synthetic-doc", status }],
  });

  let dnsCalls = 0;
  const dnsWaits = [];
  const dnsRetries = [];
  const dnsResult = await mod.requestIngestBatch({
    base: "https://brain.invalid",
    adminKey: "synthetic-admin-key",
    docs,
    fetchImpl: async () => {
      dnsCalls++;
      if (dnsCalls < 5) {
        const error = new Error("RAW_DNS_FAILURE_SENTINEL");
        error.code = "ENOTFOUND";
        throw error;
      }
      return new Response(receipt(), { status: 200 });
    },
    sleep: async (ms) => { dnsWaits.push(ms); },
    onRetry: (error) => { dnsRetries.push(error.message); },
  });
  check("an ingest batch retries a transient DNS failure and then accepts the receipt",
    dnsCalls === 5 && JSON.parse(dnsResult.raw).results[0]?.status === "created", `calls=${dnsCalls}`);
  check("ingest transport retry uses bounded exponential backoff",
    JSON.stringify(dnsWaits) === JSON.stringify([2_000, 4_000, 8_000, 16_000]), JSON.stringify(dnsWaits));
  check("translated DNS retry errors omit the raw transport message",
    dnsRetries.length === 4 && dnsRetries.every((message) =>
      /brain\.invalid could not be resolved \(ENOTFOUND\)/.test(message) && !message.includes("RAW_DNS_FAILURE_SENTINEL")),
    dnsRetries.join(" | "));

  let acceptedWrites = 0;
  const lostResponseWaits = [];
  const lostResponseRetries = [];
  const recoveredWrite = await mod.requestIngestBatch({
    base: "https://brain.invalid",
    adminKey: "synthetic-admin-key",
    docs,
    fetchImpl: async () => {
      // Increment before the body read: the first request represents a write
      // accepted by the server whose response stream is then lost in transit.
      const acceptedAttempt = ++acceptedWrites;
      return {
        ok: true,
        status: 200,
        redirected: false,
        url: "",
        text: async () => {
          if (acceptedAttempt === 1) {
            const error = new Error("RAW_RESPONSE_BODY_SENTINEL");
            error.code = "ECONNRESET";
            throw error;
          }
          return receipt("unchanged");
        },
      };
    },
    sleep: async (ms) => { lostResponseWaits.push(ms); },
    onRetry: (error) => { lostResponseRetries.push(error.message); },
  });
  check("a lost response after an accepted ingest write safely retries the exact batch",
    acceptedWrites === 2 && JSON.parse(recoveredWrite.raw).results[0]?.status === "unchanged" &&
      JSON.stringify(lostResponseWaits) === JSON.stringify([2_000]), `writes=${acceptedWrites}`);
  check("response-body network errors are sanitized before retry reporting",
    lostResponseRetries.length === 1 && /ECONNRESET/.test(lostResponseRetries[0]) &&
      !lostResponseRetries[0].includes("RAW_RESPONSE_BODY_SENTINEL"), lostResponseRetries.join(" | "));

  let temporaryHttpCalls = 0;
  const temporaryHttp = await mod.requestIngestBatch({
    base: "https://brain.invalid",
    adminKey: "synthetic-admin-key",
    docs,
    fetchImpl: async () => {
      temporaryHttpCalls++;
      return temporaryHttpCalls === 1
        ? new Response(JSON.stringify({ error: "synthetic unavailable" }), { status: 503 })
        : new Response(receipt(), { status: 200 });
    },
    sleep: async () => {},
  });
  check("an ingest batch retries a temporary 5xx response",
    temporaryHttpCalls === 2 && temporaryHttp.res.status === 200, `calls=${temporaryHttpCalls}`);

  let authCalls = 0;
  const authResponse = await mod.requestIngestBatch({
    base: "https://brain.invalid",
    adminKey: "synthetic-admin-key",
    docs,
    fetchImpl: async () => {
      authCalls++;
      return new Response(JSON.stringify({ error: "synthetic unauthorized" }), { status: 401 });
    },
    sleep: async () => { throw new Error("auth response must not sleep"); },
  });
  check("an ingest batch does not retry credential or other ordinary 4xx responses",
    authCalls === 1 && authResponse.res.status === 401, `calls=${authCalls} status=${authResponse.res.status}`);
}
{
  // A hang is worse than a failure: every network call must have a deadline.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(CLI, "utf-8");
  const bare = (src.match(/await fetch\(/g) || []).length;
  check("no bare fetch remains outside the http() wrapper", bare === 0, `${bare} found`);
  check("the wrapper routes admin requests through the exact-origin guard",
    /await guardBrainAdminFetch\(fetchImpl, url/.test(src));
  check("the wrapper sets a timeout", /AbortSignal\.timeout/.test(src));
  for (const sig of ["timed out after", "could not be resolved", "connection to"]) {
    check(`network failures are translated: "${sig}"`, src.includes(sig));
  }
  check("a timeout says progress was saved", /whatever had already completed is saved/.test(src));
}

/* ---- a 200 that is not a receipt must never read as success ----
   This regressed once already: the guard was written against an inline send
   loop that was later deleted during a dedupe, and the shipping artifact went
   out without it. Asserting on the source is what caught that. */
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(CLI, "utf-8");
  const loop = src.slice(src.indexOf("async function sendBatches"));
  const body = loop.slice(0, loop.indexOf("\nasync function") > 0 ? loop.indexOf("\nasync function") : 4000);
  const request = src.slice(src.indexOf("export async function requestIngestBatch"));
  const requestBody = request.slice(0,
    request.indexOf("\n\n/**") > 0 ? request.indexOf("\n\n/**") : 5000);
  check("the send loop uses the bounded ingest request helper", /await requestIngestBatch\(/.test(body));
  check("the request helper reads the raw body, not res.json()", /raw = await res\.text\(\)/.test(requestBody));
  check("and requires a results array before believing a 200", /Array\.isArray\(body\.results\)/.test(body));
  check("and names HTML as an Access or SSO page", /Access or SSO page/.test(body));
  check("and says nothing was marked as loaded", /Nothing was marked as loaded/.test(body));
}

/* ---------------------------------------------------------------------------
 * A refused Cloudflare credential is the client's most likely install-day
 * mistake and the one thing the tool must not call its own bug. `brain verify`
 * used to route it to the unexpected-error handler, which says "This is a bug
 * in the installer, not something you did wrong" (bench, 2026-08-28).
 */
{
  const { isCredentialRejection, CF_TOKEN_REJECTED_REMEDY } = await import("../doctor.mjs");

  for (const refusal of [
    new Error("GET /accounts failed (403): 9109: Invalid access token"),
    new Error("GET /accounts/x/d1/database failed (403): 10000: Authentication error"),
    new Error("the token has expired"),
  ]) {
    check("a refused credential is classified as the owner's to fix: " + refusal.message.slice(0, 40),
      isCredentialRejection(refusal) === true, refusal.message);
  }

  for (const other of [
    new Error("connect ETIMEDOUT 1.2.3.4:443"),
    new Error("drain failed (500): the reply was a web page, not this brain"),
    new Error("D1 is not reachable"),
  ]) {
    check("an ordinary failure is not mistaken for a credential problem: " + other.message.slice(0, 40),
      isCredentialRejection(other) === false, other.message);
  }

  check("the remedy names the variable, the dashboard path and the scopes",
    /CLOUDFLARE_API_TOKEN/.test(CF_TOKEN_REJECTED_REMEDY) &&
      /My Profile > API Tokens/.test(CF_TOKEN_REJECTED_REMEDY) &&
      /Workers Scripts: Edit/.test(CF_TOKEN_REJECTED_REMEDY),
    CF_TOKEN_REJECTED_REMEDY);

  check("the remedy never tells the owner it is our bug",
    !/bug in the installer/i.test(CF_TOKEN_REJECTED_REMEDY), CF_TOKEN_REJECTED_REMEDY);
}

console.log(fail ? `\n${fail} FAILURES` : `\nerrors: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
