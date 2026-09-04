import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentialScannerFingerprint } from "../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "brain.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "gmail-incremental-policy-fetch.mjs")).href;
const strip = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

function runCase(mode) {
  const directory = mkdtempSync(join(tmpdir(), `brain-gmail-${mode}-`));
  const manifestPath = join(directory, "fixture.manifest.json");
  const statePath = join(directory, ".brain-ingest-gmail.json");
  const evidencePath = join(directory, "evidence.json");
  const userRoot = join(directory, "isolated-user-root");
  const tokenRoot = join(userRoot, ".brain");
  mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }));
  writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
    google: { client_id: "fixture-client", client_secret: null, refresh_token: "fixture-refresh", scopes: ["gmail"] },
  }), { mode: 0o600 });
  writeFileSync(statePath, JSON.stringify({
    version: 1, done: {}, skipped: {}, history_id: "history-prior",
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
  }), { mode: 0o600 });

  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    NO_COLOR: "1",
    ADMIN_KEY: "fixture-admin",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    BRAIN_GMAIL_POLICY_MODE: mode,
    BRAIN_GMAIL_POLICY_EVIDENCE: evidencePath,
    BRAIN_GMAIL_POLICY_USER_ROOT: userRoot,
  });
  const result = spawnSync(process.execPath, [
    "--import", FIXTURE, CLI, "ingest", manifestPath, "--from", "gmail",
  ], { encoding: "utf8", env: environment, timeout: 30_000 });
  assert.equal(result.error, undefined, String(result.error || ""));
  assert.equal(result.signal, null, `${mode} Gmail fixture was terminated`);
  return {
    directory,
    code: result.status,
    output: strip(`${result.stdout || ""}${result.stderr || ""}`),
    state: JSON.parse(readFileSync(statePath, "utf8")),
    evidence: JSON.parse(readFileSync(evidencePath, "utf8")),
  };
}

{
  const result = runCase("mixed");
  try {
    check("incremental Gmail indexes ordinary inbox mail but not a promotion",
      result.code === 0 && result.evidence.ingested_ids.join(",") === "inbox",
      result.output.slice(-1_200));
    check("an incremental promotion is a deliberate policy skip, not missing coverage",
      result.state.history_id === "history-current" &&
      result.evidence.final_receipt?.status === "ready" &&
      /policy_skipped=1; coverage_gaps=0/.test(result.evidence.final_receipt?.detail || ""),
      JSON.stringify(result.evidence.final_receipt));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

{
  const result = runCase("unclassified");
  try {
    check("missing Gmail label evidence fails closed without indexing or deletion",
      result.code === 1 && result.evidence.ingested_ids.length === 0 &&
      result.evidence.forget_targets.length === 0 && /(?:refused|partial) coverage/i.test(result.output),
      result.output.slice(-1_200));
    check("an unclassified incremental message withholds the cursor and closes health as error",
      result.state.history_id === "history-prior" && result.evidence.final_receipt?.status === "error" &&
      result.evidence.final_receipt?.issue_code === "INGEST_FAILED" &&
      !("error" in result.evidence.final_receipt) && !("detail" in result.evidence.final_receipt),
      JSON.stringify(result.evidence.final_receipt));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
}

console.log(`\ngmail incremental policy: all ${ran} checks passed`);
