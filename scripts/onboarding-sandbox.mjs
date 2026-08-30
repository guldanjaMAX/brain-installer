#!/usr/bin/env node
/**
 * Launch the real owner-workspace bundle against synthetic local responses.
 *
 * This is deliberately a source-checkout QA tool, not a pretend Cloudflare
 * install. It makes no network request after optional frontend dependency
 * installation, reads no manifest or OS credential store, and cannot connect a
 * customer account. The browser is proxied through a safety page that labels
 * every app screen as a local rehearsal.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");

export const SANDBOX_SCENARIOS = Object.freeze([
  { id: "populated", label: "Normal owner workspace", proof: "Real UI with synthetic populated records" },
  { id: "signin", label: "First passkey screen", proof: "Visual rehearsal only, no physical ceremony" },
  { id: "empty", label: "Healthy empty Brain", proof: "Shows the difference between empty and unavailable" },
  { id: "partial", label: "Partial financial evidence", proof: "One section unavailable while the rest remains usable" },
  { id: "degraded", label: "Degraded services", proof: "Unavailable data stays explicit and never becomes zero" },
  { id: "conflict", label: "Conflicting owner action", proof: "A stale decision or reused request ID refuses safely" },
  { id: "idempotent", label: "Lost-response retry", proof: "The same action receipt replays without a second change" },
  { id: "grant", label: "Exact-document guest", proof: "Guest navigation exposes only Documents and Explore" },
  { id: "grant-unavailable", label: "Guest search degraded", proof: "No unauthorized result and no false healthy-empty answer" },
]);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function onboardingGuideHtml({ appOrigin }) {
  const cards = SANDBOX_SCENARIOS.map((scenario, index) => {
    const fragment = scenario.id === "signin" ? "#enroll=local-rehearsal-only" : "";
    const href = `${appOrigin}/app?state=${encodeURIComponent(scenario.id)}${fragment}`;
    return `<a class="card" href="${esc(href)}"><span>${index + 1}</span><div><strong>${esc(scenario.label)}</strong><p>${esc(scenario.proof)}</p></div></a>`;
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Financial Brain local rehearsal</title>
  <style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#161923;background:#f4f5f8}*{box-sizing:border-box}body{margin:0}.wrap{max-width:920px;margin:0 auto;padding:48px 20px 72px}.flag{display:inline-flex;padding:7px 11px;border-radius:999px;background:#fff0d9;color:#7d4300;font-size:12px;font-weight:800;letter-spacing:.08em}.hero{background:#12141a;color:white;border-radius:24px;padding:32px;margin:18px 0 24px;box-shadow:0 20px 60px #17204a20}.hero h1{font-size:clamp(30px,6vw,52px);letter-spacing:-.04em;margin:0 0 12px}.hero p{color:#c2c8d8;line-height:1.6;max-width:700px;margin:0}.notice{border:1px solid #f0c67e;background:#fff9ec;border-radius:16px;padding:16px 18px;line-height:1.5;margin-bottom:24px}.grid{display:grid;gap:12px}.card{display:flex;gap:14px;align-items:flex-start;text-decoration:none;color:inherit;background:white;border:1px solid #dfe2ea;border-radius:16px;padding:18px;transition:.15s}.card:hover{transform:translateY(-1px);border-color:#6680ed;box-shadow:0 10px 30px #17204a12}.card span{display:grid;place-items:center;min-width:30px;height:30px;border-radius:9px;background:#ebefff;color:#334fc0;font-weight:800}.card strong{display:block;margin:2px 0 5px}.card p{margin:0;color:#62697a;line-height:1.45}.foot{color:#62697a;font-size:14px;line-height:1.5;margin-top:24px}
  </style><body><main class="wrap"><span class="flag">LOCAL REHEARSAL · SYNTHETIC DATA</span><section class="hero"><h1>See the Brain before connecting anything.</h1><p>This launches the actual owner-workspace bundle with invented records. Click through every important state safely. Nothing is deployed, no account is contacted, and no credential is requested.</p></section><div class="notice"><strong>Proof boundary:</strong> this proves layout, navigation, response contracts, and error handling. It does not prove Cloudflare, OAuth consent, a real mailbox, Zoom delivery, or a physical passkey.</div><section class="grid">${cards}</section><p class="foot">Close this terminal or press Control-C when finished. The sandbox keeps no user data and stops with the terminal.</p></main></body></html>`;
}

export function injectRehearsalBanner(html) {
  const banner = '<div role="status" style="position:sticky;top:0;z-index:9999;padding:9px 16px;background:#fff0d9;color:#6f3c00;border-bottom:1px solid #e9be73;text-align:center;font:700 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.06em">LOCAL REHEARSAL · SYNTHETIC DATA · NO ACCOUNTS CONNECTED</div>';
  return String(html).replace("<body>", `<body>${banner}`);
}

export function sandboxScenarioFromReferer(referer, base) {
  try { return new URL(referer || base, base).searchParams.get("state") || "populated"; }
  catch { return "populated"; }
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

export function prepareFrontend({ root = ROOT } = {}) {
  const frontend = join(root, "frontend");
  const vite = process.platform === "win32"
    ? join(frontend, "node_modules", ".bin", "vite.cmd")
    : join(frontend, "node_modules", ".bin", "vite");
  if (!existsSync(vite)) {
    console.log("Installing the local UI test dependencies. No account credential is used.");
    runChecked(commandName("npm"), ["ci", "--ignore-scripts"], { cwd: frontend });
  }
  // Run Vite directly. `npm run build` also folds the result into the committed
  // Worker asset module, which a local rehearsal must not rewrite.
  runChecked(vite, ["build"], { cwd: frontend });
}

async function waitForFixture(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("the synthetic UI fixture exited before it became ready");
    try {
      const response = await fetch(`${origin}/app`);
      if (response.ok) return;
    } catch { /* fixture still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("the synthetic UI fixture did not become ready within 20 seconds");
}

async function proxyToFixture(request, response, fixtureOrigin, publicOrigin) {
  const incomingUrl = new URL(request.url || "/", publicOrigin);
  const scenario = sandboxScenarioFromReferer(request.headers.referer, publicOrigin);
  if (incomingUrl.pathname === "/api/app/me" && scenario === "signin") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ signed_in: false, owner: "Owner", brain: "Financial Brain rehearsal" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = { ...request.headers, host: new URL(fixtureOrigin).host };
  delete headers["content-length"];
  const upstream = await fetch(`${fixtureOrigin}${incomingUrl.pathname}${incomingUrl.search}`, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method || "GET") ? undefined : Buffer.concat(chunks),
    redirect: "manual",
  });
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  let bytes = Buffer.from(await upstream.arrayBuffer());
  if (incomingUrl.pathname === "/app" && (upstream.headers.get("content-type") || "").includes("text/html")) {
    bytes = Buffer.from(injectRehearsalBanner(bytes.toString("utf8")), "utf8");
    delete responseHeaders["content-length"];
  }
  response.writeHead(upstream.status, responseHeaders);
  response.end(bytes);
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function startOnboardingSandbox({
  host = "127.0.0.1",
  port = Number(process.env.BRAIN_ONBOARDING_PORT || 4176),
  fixturePort = Number(process.env.BRAIN_VISUAL_PORT || 4177),
  open = true,
  prepare = true,
} = {}) {
  if (prepare) prepareFrontend();
  const fixture = spawn(process.execPath, [join(FRONTEND, "test", "visual-server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, BRAIN_VISUAL_PORT: String(fixturePort) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  fixture.stdout?.on("data", () => {});
  const fixtureOrigin = `http://${host}:${fixturePort}`;
  await waitForFixture(fixtureOrigin, fixture);

  const publicOrigin = `http://${host}:${port}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", publicOrigin);
      if (url.pathname === "/" || url.pathname === "/rehearsal") {
        const html = onboardingGuideHtml({ appOrigin: publicOrigin });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
        return;
      }
      await proxyToFixture(request, response, fixtureOrigin, publicOrigin);
    } catch (error) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`Local rehearsal unavailable: ${error.message}`);
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  console.log("");
  console.log("Financial Brain local onboarding rehearsal is ready:");
  console.log(`  ${publicOrigin}/`);
  console.log("");
  console.log("LOCAL REHEARSAL ONLY: synthetic data, no deployment, no accounts, no real passkey proof.");
  console.log("Press Control-C when finished.");
  if (open) openBrowser(`${publicOrigin}/`);

  const close = async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    if (fixture.exitCode === null) fixture.kill("SIGTERM");
  };
  return { server, fixture, origin: publicOrigin, close };
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  const noOpen = process.argv.includes("--no-open");
  startOnboardingSandbox({ open: !noOpen }).then(({ close }) => {
    const stop = async () => { await close(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch((error) => {
    console.error(`Financial Brain local rehearsal could not start: ${error.message}`);
    process.exit(1);
  });
}
