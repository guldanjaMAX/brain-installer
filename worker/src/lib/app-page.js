/**
 * app-page — the owner's page, served by the worker at /app.
 *
 * One self-contained HTML string: ask a question, read the cited answer with
 * its confidence line, manage devices in Settings. No framework, no external
 * fetch (the CSP in owner-auth.mjs enforces connect-src 'self'), installable
 * from the phone's share sheet as a home-screen app.
 *
 * Auth is a passkey: enrollment when the URL carries #enroll=<code>, plain
 * sign-in otherwise. All API calls send X-Brain-App: 1 — the CSRF companion
 * to the SameSite=Strict session cookie.
 */

import { SEARCH_UNAVAILABLE, unavailableNotice } from "./retrieval-status.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Fallback only. The worker sends `notice` with the response; this covers a
// cached page talking to a worker that did not.
const GENERIC_UNAVAILABLE_NOTICE = unavailableNotice("unknown");

/**
 * The brand mark, as a standalone SVG. Served at /brand/og.svg for link
 * previews and reused inline for the favicon, so a shared invite carries the
 * brain's own identity instead of a bare URL.
 *
 * Everything is drawn from per-install configuration. A hardcoded name or
 * logo here would ship one client's identity to every other client.
 */
export function brandOgSvg(env) {
  const owner = esc(env.BRAIN_OWNER || "Your");
  const possessive = /s$/i.test(owner) ? `${owner}'` : `${owner}'s`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${possessive} brain">
  <rect width="1200" height="630" fill="#12141a"/>
  <circle cx="960" cy="140" r="300" fill="#3b5bdb" opacity="0.14"/>
  <circle cx="200" cy="560" r="240" fill="#3b5bdb" opacity="0.10"/>
  <g transform="translate(96,150)">
    <svg viewBox="6 24 88 52" width="132" height="78">
      <path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z"
            fill="none" stroke="#7d94f5" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </g>
  <text x="96" y="330" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="76" font-weight="600" letter-spacing="-2">${possessive} brain</text>
  <text x="96" y="404" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Everything you have written, decided and been told.</text>
  <text x="96" y="452" fill="#aab3c5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="34">Ask it anything. It answers with its sources.</text>
  <text x="96" y="556" fill="#7d94f5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="27" letter-spacing="1">PRIVATE  ·  YOURS  ·  OPENS WITH YOUR FACE</text>
</svg>`;
}

// Inline so the tab icon needs no second request and no route of its own.
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 24 88 52">' +
  '<path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z" ' +
  'fill="none" stroke="#3b5bdb" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/></svg>');

export function appPageHtml(env, origin = "") {
  const brainName = esc(env.BRAIN_NAME || "Your brain");
  const owner = esc(env.BRAIN_OWNER || "");
  // "Dana's brain", but "Chris' brain" — a possessive that reads wrong
  // is the first thing a client notices about a page built for them.
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "";
  const headline = possessive ? `${possessive} brain` : brainName;
  const description =
    "Everything you have written, decided and been told, in one place you own. " +
    "Ask it anything and it answers with its sources. Opens with your face or fingerprint, never a password.";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${headline}">
<meta name="theme-color" content="#12141a">
<title>${headline}</title>
<meta name="description" content="${description}">
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${headline}">
<meta property="og:title" content="${headline}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${origin}/brand/og.svg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${origin}/app">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${headline}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${origin}/brand/og.svg">
<style>
  :root { --ink:#1a1a1a; --dim:#666; --line:#e4e0d8; --accent:#3b5bdb; --bg:#faf9f6; --card:#fff; }
  * { box-sizing:border-box; margin:0; }
  body { font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); min-height:100vh; }
  main { max-width:640px; margin:0 auto; padding:28px 20px 80px; }
  h1 { font-size:20px; letter-spacing:-.02em; display:flex; align-items:center; gap:10px; }
  h1 svg { width:28px; height:28px; flex:none; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-top:16px; }
  textarea { width:100%; border:1px solid var(--line); border-radius:10px; padding:12px; font:inherit; resize:vertical; min-height:76px; background:var(--bg); }
  button { font:inherit; border:0; border-radius:10px; padding:11px 18px; cursor:pointer; background:var(--accent); color:#fff; font-weight:600; }
  button.quiet { background:transparent; color:var(--dim); font-weight:400; padding:6px 10px; }
  button.danger { background:transparent; color:#b03030; font-weight:400; padding:6px 10px; }
  .row { display:flex; gap:10px; align-items:center; margin-top:12px; flex-wrap:wrap; }
  .answer { white-space:pre-wrap; margin-top:14px; }
  .confidence { color:var(--dim); font-size:13.5px; margin-top:12px; padding-top:10px; border-top:1px dashed var(--line); }
  .sources { margin-top:10px; font-size:13.5px; color:var(--dim); }
  .sources div { margin-top:3px; }
  .muted { color:var(--dim); font-size:14px; }
  .gate { max-width:460px; margin-top:22px; }
  .gate h2 { font-size:22px; letter-spacing:-.02em; margin-bottom:8px; }
  .gate p { color:var(--dim); font-size:15px; }
  .points { list-style:none; padding:0; margin:16px 0 4px; }
  .points li { position:relative; padding-left:24px; margin-top:9px; color:var(--ink); font-size:14.5px; }
  .points li::before { content:"✓"; position:absolute; left:0; color:var(--accent); font-weight:700; }
  .fineprint { color:var(--dim); font-size:13px; margin-top:12px; }
  .gate button { width:100%; padding:14px 18px; font-size:15.5px; }
  .error { color:#b03030; font-size:14px; margin-top:10px; }
  .device { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 0; border-bottom:1px solid var(--line); }
  .device:last-child { border-bottom:0; }
  .spin { opacity:.55; pointer-events:none; }
  #settings h2, #askcard h2 { font-size:15px; color:var(--dim); font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  a.toggle { color:var(--accent); font-size:14px; cursor:pointer; text-decoration:none; }
</style>
<main>
  <h1><svg viewBox="6 24 88 52"><path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z" fill="none" stroke="#3b5bdb" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>${brainName}</h1>

  <div id="gate" class="card gate" hidden>
    <h2 id="gate-title"></h2>
    <p id="gate-msg"></p>
    <ul id="gate-points" class="points"></ul>
    <div class="row">
      <button id="gate-btn"></button>
    </div>
    <p id="gate-foot" class="fineprint"></p>
    <p id="gate-err" class="error" hidden></p>
  </div>

  <div id="askcard" class="card" hidden>
    <h2>Ask</h2>
    <div class="row" style="margin-top:10px">
      <textarea id="q" placeholder="Ask your brain anything…"></textarea>
    </div>
    <div class="row">
      <button id="ask">Ask</button>
      <span id="askstate" class="muted"></span>
    </div>
    <div id="out" hidden>
      <div class="answer" id="answer"></div>
      <div class="confidence" id="confidence"></div>
      <div class="sources" id="sources"></div>
    </div>
  </div>

  <div id="settings" class="card" hidden>
    <div class="row" style="justify-content:space-between; margin-top:0">
      <h2>Settings</h2>
      <a class="toggle" id="settings-toggle">show</a>
    </div>
    <div id="settings-body" hidden>
      <p class="muted" style="margin-top:8px">Devices that can open this brain. Your passkey syncs to your own devices automatically; add one here only for a device outside that sync.</p>
      <div id="devices"></div>
      <div class="row">
        <button id="add-device" class="quiet">+ Add this device</button>
        <button id="signout" class="quiet">Sign out</button>
        <button id="signout-all" class="danger">Sign out everywhere</button>
      </div>
      <p id="set-err" class="error" hidden></p>
    </div>
  </div>
</main>
<script>
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  const api = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-App": "1" },
    body: JSON.stringify(payload || {}),
  }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });

  const enrollCode = (location.hash.match(/enroll=([A-Za-z0-9_-]+)/) || [])[1] || null;

  async function enroll(viaSession) {
    const options = await api("/auth/register/options", viaSession ? {} : { code: enrollCode });
    const credential = await navigator.credentials.create({ publicKey: {
      challenge: b64uToBytes(options.challenge),
      rp: { id: options.rp.id, name: options.rp.name },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: options.user_name, displayName: options.user_name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    }});
    await api("/auth/register/verify", {
      code: viaSession ? undefined : enrollCode,
      nickname: navigator.platform || "device",
      credentialId: credential.id,
      attestationObject: bytesToB64u(credential.response.attestationObject),
      clientDataJSON: bytesToB64u(credential.response.clientDataJSON),
    });
  }

  async function signIn() {
    const options = await api("/auth/login/options");
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: b64uToBytes(options.challenge),
      rpId: options.rp_id,
      userVerification: "required",
      allowCredentials: [],
    }});
    await api("/auth/login/verify", {
      credentialId: assertion.id,
      authenticatorData: bytesToB64u(assertion.response.authenticatorData),
      clientDataJSON: bytesToB64u(assertion.response.clientDataJSON),
      signature: bytesToB64u(assertion.response.signature),
    });
  }

  async function me() {
    try { return await api("/api/app/me"); } catch { return null; }
  }

  function renderDevices(devices) {
    const box = $("devices");
    box.textContent = "";
    for (const device of devices || []) {
      const row = document.createElement("div");
      row.className = "device";
      const name = document.createElement("span");
      name.textContent = (device.nickname || "unnamed device") +
        (device.last_used_at ? " · last used " + new Date(device.last_used_at).toLocaleDateString() : " · never used");
      const actions = document.createElement("span");
      const rename = document.createElement("button");
      rename.className = "quiet"; rename.textContent = "rename";
      rename.onclick = async () => {
        const nickname = prompt("Name this device", device.nickname || "");
        if (nickname === null) return;
        await api("/api/app/devices/rename", { credential_id: device.credential_id, nickname });
        refresh();
      };
      const revoke = document.createElement("button");
      revoke.className = "danger"; revoke.textContent = "revoke";
      revoke.onclick = async () => {
        if (!confirm("Remove this device's access?")) return;
        const result = await api("/api/app/devices/revoke", { credential_id: device.credential_id });
        if (result.reason) { $("set-err").textContent = result.reason; $("set-err").hidden = false; }
        refresh();
      };
      actions.append(rename, revoke);
      row.append(name, actions);
      box.append(row);
    }
  }

  async function refresh() {
    const session = await me();
    const signedIn = Boolean(session && session.signed_in);
    $("gate").hidden = signedIn;
    $("askcard").hidden = !signedIn;
    $("settings").hidden = !signedIn;
    if (!signedIn) {
      const enrolling = Boolean(enrollCode);
      $("gate-title").textContent = enrolling ? "Your brain is ready" : "Welcome back";
      $("gate-msg").textContent = enrolling
        ? "Everything you have written, decided and been told, in one place that belongs to you. Ask it anything and it answers with its sources."
        : "Sign in to ask your brain a question.";
      const points = $("gate-points");
      points.textContent = "";
      if (enrolling) {
        for (const line of [
          "One tap sets up your face or fingerprint as the key",
          "No password to create, remember, or lose",
          "It lives in your own account. Nobody else can read it",
        ]) {
          const li = document.createElement("li");
          li.textContent = line;
          points.append(li);
        }
      }
      $("gate-btn").textContent = enrolling ? "Set up with Face ID" : "Sign in";
      $("gate-foot").textContent = enrolling
        ? "Takes about ten seconds. Works on every device you own."
        : "";
      return;
    }
    renderDevices(session.devices);
  }

  $("gate-btn").onclick = async () => {
    $("gate-err").hidden = true;
    $("gate-btn").classList.add("spin");
    try {
      if (enrollCode) { await enroll(false); history.replaceState(null, "", "/app"); }
      else await signIn();
      await refresh();
    } catch (error) {
      $("gate-err").textContent = String(error.message || error);
      $("gate-err").hidden = false;
    } finally {
      $("gate-btn").classList.remove("spin");
    }
  };

  /* render-contract:start
     Pure, DOM-free, and fenced by these sentinels so the offline test can lift
     these three functions out of the served page and exercise the REAL shipped
     source. A test that greps this file for a pattern would pass whether or not
     the branch is live; these are the behaviour. */
  function unavailableSearch(r) {
    // An incomplete search must never render as "the documents do not answer
    // the question". On this page that sentence is all the owner sees, and
    // during the first hours of a new brain the index is still building, so
    // this is the likeliest empty result they will ever get.
    return r.status === ${JSON.stringify(SEARCH_UNAVAILABLE)} ||
      (!!r.degraded && !r.answer && !(r.citations || []).length && !(r.results || []).length);
  }
  function answerText(r) {
    if (unavailableSearch(r)) return r.notice || ${JSON.stringify(GENERIC_UNAVAILABLE_NOTICE)};
    return r.answer || (r.answer_error ? "No answer: " + r.answer_error : "The documents do not answer the question.");
  }
  function confidenceText(r) {
    // No rubric for a search that never ran: "how sure are we nothing is
    // recorded" has no answer when nothing was read.
    if (unavailableSearch(r)) return "Search incomplete. This is not a statement about what your brain holds.";
    const conf = r.confidence;
    if (!conf) return "";
    return (r.answer && !/^The documents do not answer/.test(r.answer || "") ? "Confidence" : "Confidence nothing is recorded") +
      ": " + conf.percent + "% (" + conf.band + ") — " + conf.basis.join("; ") + ".";
  }
  /* render-contract:end */

  $("ask").onclick = async () => {
    const q = $("q").value.trim();
    if (!q) return;
    $("ask").classList.add("spin");
    $("askstate").textContent = "thinking…";
    $("out").hidden = true;
    try {
      const r = await api("/api/rag/think", { q, limit: 12 });
      $("answer").textContent = answerText(r);
      $("confidence").textContent = confidenceText(r);
      const sources = $("sources");
      sources.textContent = "";
      for (const c of r.citations || []) {
        const line = document.createElement("div");
        line.textContent = "[" + c.n + "] " + c.title + (c.ts ? " · " + String(c.ts).slice(0, 10) : "");
        sources.append(line);
      }
      $("out").hidden = false;
    } catch (error) {
      $("answer").textContent = "";
      $("confidence").textContent = "";
      $("sources").textContent = String(error.message || error);
      $("out").hidden = false;
    } finally {
      $("ask").classList.remove("spin");
      $("askstate").textContent = "";
    }
  };

  $("settings-toggle").onclick = () => {
    const bodyEl = $("settings-body");
    bodyEl.hidden = !bodyEl.hidden;
    $("settings-toggle").textContent = bodyEl.hidden ? "show" : "hide";
  };
  $("add-device").onclick = async () => {
    $("set-err").hidden = true;
    try { await enroll(true); refresh(); }
    catch (error) { $("set-err").textContent = String(error.message || error); $("set-err").hidden = false; }
  };
  $("signout").onclick = async () => { await api("/api/app/signout"); refresh(); };
  $("signout-all").onclick = async () => {
    if (!confirm("Sign out on every device? Everyone signs back in with their passkey.")) return;
    await api("/api/app/signout-all");
    refresh();
  };

  refresh();
})();
</script>
</html>`;
}
