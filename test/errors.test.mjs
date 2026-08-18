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
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
function cli(args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.CLOUDFLARE_API_TOKEN;
  delete e.ADMIN_KEY;
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf-8", env: e, timeout: 60_000 });
  return { code: r.status, out: strip(`${r.stdout || ""}${r.stderr || ""}`) };
}

/* ---- a stack trace must never reach a client ---- */
{
  const bad = join(mkdtempSync(join(tmpdir(), "brain-err-")), "nope.json");
  const r = cli(["status", bad]);
  check("a missing manifest fails cleanly", r.code === 1);
  check("and shows no stack trace", !/\bat .*\.mjs:\d+/.test(r.out), r.out.slice(0, 200));
  check("and names the file it could not read", r.out.includes("nope.json"), r.out.slice(0, 160));
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
}
{
  const r = cli(["ingest", join(HERE, "..", "templates", "brain.manifest.json"), "--path", "/definitely/not/here"]);
  check("a missing ingest folder is explained", r.code === 1 && /no such folder/i.test(r.out), r.out.slice(0, 200));
  check("and no stack trace", !/\bat .*\.mjs:\d+/.test(r.out));
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
