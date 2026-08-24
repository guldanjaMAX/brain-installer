/**
 * Error-path behaviour, asserted rather than hoped for.
 *
 * Install number one runs live on a client's machine while they watch. What
 * they see when something goes wrong is a product surface, so it gets tests
 * like any other.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { previewSupportJournal } from "../support-journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const INGEST_EXIT_FETCH = join(HERE, "fixtures", "ingest-exit-fetch.mjs");
const ISOLATE_SUPPORT_ROOT = join(HERE, "fixtures", "isolate-support-root.mjs");
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const journalEvents = (text) => String(text).trim()
  ? String(text).trim().split("\n").map((line) => JSON.parse(line))
  : [];
function readSupportJournal(userRoot) {
  const supportRoot = join(userRoot, ".brain", "support");
  return existsSync(supportRoot) ? previewSupportJournal({ root: userRoot }) : "";
}
function cli(args, env = {}, options = {}) {
  const userRoot = options.userRoot || mkdtempSync(join(tmpdir(), "brain-support-cli-"));
  const e = { ...process.env, ...env };
  delete e.CLOUDFLARE_API_TOKEN;
  delete e.ADMIN_KEY;
  e.BRAIN_TEST_USER_ROOT = userRoot;
  // Generous: on a cold machine the Cloudflare checks download wrangler before
  // they can answer, which is minutes, not seconds.
  const r = spawnSync("node", ["--import", ISOLATE_SUPPORT_ROOT, CLI, ...args], {
    encoding: "utf-8", env: e, timeout: 300_000,
  });
  const journal = readSupportJournal(userRoot);
  if (!options.keepUserRoot) rmSync(userRoot, { recursive: true, force: true });
  return { code: r.status, out: strip(`${r.stdout || ""}${r.stderr || ""}`), journal, userRoot };
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
    corpora: { google_drive: {} },
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
    CLOUDFLARE_API_TOKEN: "fixture-cloudflare",
  };
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
  check("a missing manifest fails cleanly", r.code === 1);
  check("and shows no stack trace", !/\bat .*\.mjs:\d+/.test(r.out), r.out.slice(0, 200));
  check("and names the file it could not read", r.out.includes("nope.json"), r.out.slice(0, 160));
  check("the local issue note classifies the failure without copying its private path",
    journalEvents(r.journal).length === 1 &&
      journalEvents(r.journal)[0]?.command === "status" &&
      journalEvents(r.journal)[0]?.error_code === "CONFIG_INVALID" &&
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
  check("a missing token is an explained failure", r.code === 1 && /CLOUDFLARE_API_TOKEN/.test(r.out), r.out.slice(0, 160));
  check("and it says what to do about it", /export CLOUDFLARE_API_TOKEN/.test(r.out));
  // Fatal is anticipated, so it must NOT be dressed up as an installer bug.
  check("an anticipated failure is not reported as a bug", !/This is a bug in the installer/.test(r.out));
  check("anticipated auth failures create one private typed note and send no raw credential guidance",
    journalEvents(r.journal).length === 1 &&
      journalEvents(r.journal)[0]?.command === "verify" &&
      journalEvents(r.journal)[0]?.error_code === "AUTH_REQUIRED" &&
      !r.journal.includes("CLOUDFLARE_API_TOKEN") && /Nothing was sent/.test(r.out), r.journal);
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

  const exportPath = join(userRoot, "safe-support-export.jsonl");
  const exported = cli(["support", "--export", exportPath], {}, { userRoot, keepUserRoot: true });
  check("support export writes the reviewed bytes and states that nothing was sent",
    exported.code === 0 && readFileSync(exportPath, "utf-8") === failed.journal &&
      /nothing was uploaded or sent/i.test(exported.out), exported.out);
  const existingRefusal = cli(["support", "--export", exportPath], {}, { userRoot, keepUserRoot: true });
  check("support export refuses overwrite as an expected user-facing failure, not an installer bug",
    existingRefusal.code === 1 && /refusing to overwrite/i.test(existingRefusal.out) &&
      !/This is a bug in the installer|unexpected error/i.test(existingRefusal.out) &&
      readFileSync(exportPath, "utf-8") === failed.journal, existingRefusal.out);

  const missingDirectoryExport = cli(
    ["support", "--export", join(userRoot, "missing-directory", "bundle.jsonl")],
    {}, { userRoot, keepUserRoot: true }
  );
  check("a missing support export directory is an expected failure and sends nothing",
    missingDirectoryExport.code === 1 && /directory does not exist/i.test(missingDirectoryExport.out) &&
      /Nothing was uploaded or sent/i.test(missingDirectoryExport.out) &&
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
}
{
  // A hang is worse than a failure: every network call must have a deadline.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(CLI, "utf-8");
  const bare = (src.match(/await fetch\(/g) || []).length;
  check("no bare fetch remains outside the http() wrapper", bare === 1, `${bare} found`);
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
  check("the send loop reads the raw body, not res.json()", /const raw = await res\.text\(\)/.test(body));
  check("and requires a results array before believing a 200", /Array\.isArray\(body\.results\)/.test(body));
  check("and names HTML as an Access or SSO page", /Access or SSO page/.test(body));
  check("and says nothing was marked as loaded", /Nothing was marked as loaded/.test(body));
}

console.log(fail ? `\n${fail} FAILURES` : `\nerrors: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
