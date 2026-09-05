#!/usr/bin/env node
/**
 * Delete the Cloudflare resources one TEST brain install created.
 *
 * There is no `brain uninstall`, so every bench run otherwise leaves a Worker,
 * a D1 database and a Vectorize index behind forever. That caps how many cold
 * installs are affordable, and it is the gap REC-02 asks us to close.
 *
 * This is deliberately an ALLOWLIST tool. It deletes exactly the names you
 * pass and nothing else. The test account is not empty: it also hosts a live
 * preview brain, so a "delete everything that looks like a brain" sweep here
 * would be destructive. Refusing to guess is the whole design.
 *
 *   node scripts/teardown-test-brain.mjs --name brain-test-run-1
 *   node scripts/teardown-test-brain.mjs --name brain-test-run-1 --commit
 *
 * Dry run is the default. Nothing is deleted until --commit is passed.
 * Token: CLOUDFLARE_API_TOKEN, or macOS Keychain (-a brain-test -s cf-api-token).
 * Account: CLOUDFLARE_ACCOUNT_ID, or resolved from the token when it can see
 * exactly one account.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

/**
 * Names this tool will never touch, whatever is passed.
 *
 * Sourced from the environment because this repo is public and the live
 * resources sharing the test account should not be named in it. Set
 * BRAIN_TEARDOWN_PROTECTED to a comma-separated list of name prefixes.
 * The positive test-name check below is the primary guard; this is the
 * second lock, for the case where a real name happens to contain "test".
 */
const PROTECTED_RAW = process.env.BRAIN_TEARDOWN_PROTECTED || "";
const PROTECTED = PROTECTED_RAW
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((prefix) => new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

/**
 * Does this name look like a disposable test resource?
 *
 * ANCHORED. The original was /^brain-test|test/i, which alternates across the
 * whole pattern: "starts with brain-test, OR contains test anywhere". That made
 * `my-production-testbed` and even `latest-greatest` deletable, because both
 * contain the letters t-e-s-t. A deletion guard that matches the middle of a
 * word is not a guard.
 */
export function looksDisposable(name) {
  return /^(brain-test|test)/i.test(String(name || ""));
}

/** The second lock, and it must actually exist. */
export function protectedListMissing(raw = PROTECTED_RAW) {
  return String(raw || "").split(",").map((x) => x.trim()).filter(Boolean).length === 0;
}

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const COMMIT = process.argv.includes("--commit");

function keychainToken() {
  try {
    return execFileSync("security",
      ["find-generic-password", "-a", "brain-test", "-s", "cf-api-token", "-w"],
      { encoding: "utf8" }).trim();
  } catch { return null; }
}

async function cf(token, path, method = "GET") {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* status carries it */ }
  return { ok: res.ok && body?.success !== false, status: res.status, body };
}

function fail(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

/**
 * The command-line body, run only when this file is executed directly.
 * Importing it must not delete anything, so the guards above can be tested.
 */
const RUN_DIRECTLY = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN_DIRECTLY) {
  const name = arg("--name");
  if (!name) {
    fail("Pass --name <exact resource name>. This tool deletes only what you name.\n" +
         "  Dry run is the default; add --commit to actually delete.");
  }
  // Fail closed. With the variable unset the second lock was an empty list, so
  // it protected nothing at all and did so silently: a guard that exists only
  // for whoever remembers to export it is not a guard either.
  if (protectedListMissing()) {
    fail("Refusing: BRAIN_TEARDOWN_PROTECTED is not set, so the live-resource lock is empty.\n" +
         "  This repo is public, so the protected names live in the environment rather than the source.\n" +
         "  Set it to a comma-separated list of live name prefixes before deleting anything, e.g.\n" +
         "    BRAIN_TEARDOWN_PROTECTED='some-live-brain,another-live-brain' node scripts/teardown-test-brain.mjs --name ...");
  }
  if (PROTECTED.some((re) => re.test(name))) {
    fail(`Refusing: "${name}" matches a protected name. That is a live brain, not a test.`);
  }
  if (!looksDisposable(name)) {
    fail(`Refusing: "${name}" does not look like a test resource.\n` +
         "  Name test brains so they are obviously disposable (e.g. brain-test-run-1).");
  }

  const token = process.env.CLOUDFLARE_API_TOKEN || keychainToken();
  if (!token) {
    fail("No token. Set CLOUDFLARE_API_TOKEN, or store one in the login Keychain as\n" +
         "  account 'brain-test', service 'cf-api-token'.");
  }

  const verify = await cf(token, "/user/tokens/verify");
  if (!verify.ok) fail(`That token is not valid or active (HTTP ${verify.status}).`);

  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const accts = await cf(token, "/accounts");
    const list = accts.body?.result || [];
    if (list.length !== 1) {
      fail(`The token sees ${list.length} accounts, so the target is ambiguous.\n` +
           "  Set CLOUDFLARE_ACCOUNT_ID to the one you mean.");
    }
    account = list[0].id;
    console.log(`  account: ${list[0].name} (${account})`);
  }

  const targets = [
    { kind: "Worker",   path: `/accounts/${account}/workers/scripts/${name}` },
    { kind: "D1",       path: null, resolve: async () => {
        const r = await cf(token, `/accounts/${account}/d1/database`);
        const hit = (r.body?.result || []).find((d) => d.name === name);
        return hit ? `/accounts/${account}/d1/database/${hit.uuid}` : null;
      } },
    { kind: "Vectorize", path: `/accounts/${account}/vectorize/v2/indexes/${name}` },
  ];

  /**
   * A dry run that says "would delete" about something that is not there is a
   * small lie, and this tool exists to be trusted about deletion. So the preview
   * asks whether each resource actually exists rather than assuming it does.
   */
  async function exists(path) {
    const r = await cf(token, path);
    if (r.status === 404) return false;
    return r.ok;
  }

  console.log(`\n  ${COMMIT ? "DELETING" : "DRY RUN — nothing will be deleted"}: ${name}\n`);

  let deleted = 0, missing = 0, failed = 0;
  for (const t of targets) {
    const path = t.path || (await t.resolve());
    if (!path) { console.log(`  ${t.kind.padEnd(10)} not found`); missing++; continue; }
    if (!COMMIT) {
      console.log(`  ${t.kind.padEnd(10)} ${(await exists(path)) ? "would delete" : "not found"}`);
      continue;
    }
    const r = await cf(token, path, "DELETE");
    if (r.ok) { console.log(`  ${t.kind.padEnd(10)} deleted`); deleted++; }
    else if (r.status === 404) { console.log(`  ${t.kind.padEnd(10)} not found`); missing++; }
    else {
      const why = (r.body?.errors || []).map((e) => e.message).join("; ") || `HTTP ${r.status}`;
      console.log(`  ${t.kind.padEnd(10)} FAILED: ${why}`);
      failed++;
    }
  }

  if (!COMMIT) {
    console.log("\n  Re-run with --commit to delete.\n");
  } else {
    console.log(`\n  ${deleted} deleted, ${missing} already gone, ${failed} failed.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}
