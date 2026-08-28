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

export function appPageHtml(env) {
  const brainName = esc(env.BRAIN_NAME || "Your brain");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${brainName}</title>
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
  .error { color:#b03030; font-size:14px; margin-top:10px; }
  .device { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 0; border-bottom:1px solid var(--line); }
  .device:last-child { border-bottom:0; }
  .spin { opacity:.55; pointer-events:none; }
  #settings h2, #askcard h2 { font-size:15px; color:var(--dim); font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  a.toggle { color:var(--accent); font-size:14px; cursor:pointer; text-decoration:none; }
  .warn { color:#8a5a00; font-size:14px; }
  input[type=text] { width:100%; border:1px solid var(--line); border-radius:10px; padding:12px; font:16px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.06em; text-transform:uppercase; background:var(--bg); }
  pre.codes { font:15px/2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px; margin-top:12px; overflow-x:auto; }
  @media print { .card:not(#codes), h1 { display:none !important; } #codes .row { display:none; } }
</style>
<main>
  <h1><svg viewBox="6 24 88 52"><path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z" fill="none" stroke="#3b5bdb" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>${brainName}</h1>

  <div id="gate" class="card" hidden>
    <p id="gate-msg" class="muted"></p>
    <div class="row">
      <button id="gate-btn"></button>
    </div>
    <p id="gate-err" class="error" hidden></p>
    <p id="lost-link" style="margin-top:14px" hidden><a class="toggle" id="lost-toggle">Lost the device you sign in with?</a></p>
    <div id="lost" hidden>
      <p class="muted" style="margin-top:10px">Type one code from the recovery card you were given when this was set up. It creates a new passkey on the device you are holding now, and signs you in. Each code works once.</p>
      <div class="row">
        <input id="rcode" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX">
      </div>
      <div class="row">
        <button id="recover-btn">Use recovery code</button>
      </div>
      <p id="lost-err" class="error" hidden></p>
    </div>
  </div>

  <div id="codes" class="card" hidden>
    <h2>Your recovery card</h2>
    <p class="muted" style="margin-top:8px">These are the only way back in if you lose every device that can open this brain. Print them or write them down, and keep them where you keep a spare house key — somewhere that is not the device itself. They are shown once and cannot be shown again.</p>
    <pre class="codes" id="codelist"></pre>
    <div class="row">
      <button id="codes-print" class="quiet">Print</button>
      <button id="codes-copy" class="quiet">Copy</button>
      <button id="codes-done">I have saved these</button>
    </div>
    <p id="codes-note" class="muted" style="margin-top:10px"></p>
  </div>

  <div id="nocodes" class="card" hidden>
    <p class="warn" id="nocodes-msg"></p>
    <div class="row">
      <button id="make-codes" hidden>Create recovery codes</button>
    </div>
    <p id="nocodes-err" class="error" hidden></p>
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
      <p class="muted" id="recovery-state" style="margin-top:14px"></p>
      <div class="row">
        <button id="new-codes" class="quiet">Print a new recovery card</button>
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

  // One ceremony, three callers (first setup, add-a-device, recovery). Sharing
  // it is deliberate: a recovery that quietly asked for less than a normal
  // enrolment would be exactly the weaker door this feature must not be.
  function createPasskey(options) {
    return navigator.credentials.create({ publicKey: {
      challenge: b64uToBytes(options.challenge),
      rp: { id: options.rp.id, name: options.rp.name },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: options.user_name, displayName: options.user_name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    }});
  }

  function ceremonyPayload(credential) {
    return {
      nickname: navigator.platform || "device",
      credentialId: credential.id,
      attestationObject: bytesToB64u(credential.response.attestationObject),
      clientDataJSON: bytesToB64u(credential.response.clientDataJSON),
    };
  }

  async function enroll(viaSession) {
    const options = await api("/auth/register/options", viaSession ? {} : { code: enrollCode });
    const credential = await createPasskey(options);
    const result = await api("/auth/register/verify", Object.assign(
      { code: viaSession ? undefined : enrollCode }, ceremonyPayload(credential),
    ));
    if (result.recovery_codes) showCodes(result.recovery_codes, "");
    return result;
  }

  // Every enrolled device is gone. The code buys one registration, right now,
  // with Face ID or a fingerprint, on the device in your hand.
  async function recover() {
    const code = $("rcode").value;
    const options = await api("/auth/recover/options", { code });
    const credential = await createPasskey(options);
    return api("/auth/recover/verify", Object.assign({ code }, ceremonyPayload(credential)));
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

  // Shown once, and the page says so. Holding the rest of the UI behind an
  // acknowledgement is the point: a card that scrolled past unread is the same
  // as no card at all on the day it is needed.
  let showingCodes = false;
  function showCodes(codes, note) {
    showingCodes = true;
    $("codelist").textContent = (codes || []).join("\\n");
    $("codes-note").textContent = note || "";
    $("codes").hidden = false;
    $("askcard").hidden = true;
    $("settings").hidden = true;
    $("nocodes").hidden = true;
    $("gate").hidden = true;
  }

  function renderRecoveryState(recovery) {
    const state = recovery || { available: false, unused: 0 };
    const missing = !state.available;
    const empty = state.available && state.unused === 0;
    $("nocodes").hidden = !(missing || empty);
    $("make-codes").hidden = !empty;
    $("nocodes-msg").textContent = missing
      ? "This brain has no recovery codes, because it is running a database older than the version that added them. Ask whoever set it up to run the update; until then, the only way back in after losing every device is your admin key."
      : (empty ? "You have no recovery codes left. If you lose this device, nothing on this page can let you back in. Create a card now — it takes ten seconds." : "");
    $("recovery-state").textContent = missing
      ? "Recovery codes: not available on this install."
      : "Recovery codes: " + state.unused + " unused. Printing a new card destroys any unused codes from the old one.";
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
    if (showingCodes) return;
    const session = await me();
    const signedIn = Boolean(session && session.signed_in);
    $("gate").hidden = signedIn;
    $("askcard").hidden = !signedIn;
    $("settings").hidden = !signedIn;
    if (!signedIn) {
      $("nocodes").hidden = true;
      $("gate-msg").textContent = enrollCode
        ? "You have an enrollment link. One tap creates your passkey — your face or fingerprint, on this device."
        : "Sign in with your passkey.";
      $("gate-btn").textContent = enrollCode ? "Set up with Face ID / fingerprint" : "Sign in";
      // The way back in belongs on the screen of somebody who cannot get in,
      // not in a document they were emailed at setup.
      $("lost-link").hidden = Boolean(enrollCode);
      return;
    }
    renderDevices(session.devices);
    renderRecoveryState(session.recovery);
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

  $("lost-toggle").onclick = () => {
    $("lost").hidden = !$("lost").hidden;
    $("lost-toggle").textContent = $("lost").hidden
      ? "Lost the device you sign in with?"
      : "hide";
  };
  $("recover-btn").onclick = async () => {
    $("lost-err").hidden = true;
    $("recover-btn").classList.add("spin");
    try {
      const result = await recover();
      $("rcode").value = "";
      await refresh();
      if (result && typeof result.codes_remaining === "number" && result.codes_remaining === 0) {
        const fresh = await api("/api/app/recovery-codes");
        showCodes(fresh.recovery_codes, "That was your last code, so here is a new card. The old one is now dead.");
      }
    } catch (error) {
      $("lost-err").textContent = String(error.message || error);
      $("lost-err").hidden = false;
    } finally {
      $("recover-btn").classList.remove("spin");
    }
  };
  $("codes-print").onclick = () => window.print();
  $("codes-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("codelist").textContent);
      $("codes-copy").textContent = "copied";
    } catch {
      $("codes-copy").textContent = "select the codes above and copy them";
    }
  };
  $("codes-done").onclick = async () => {
    if (!confirm("Have you written these down or printed them? They cannot be shown again.")) return;
    showingCodes = false;
    $("codes").hidden = true;
    $("codelist").textContent = "";
    await refresh();
  };
  const mintCodes = async (errorField) => {
    $(errorField).hidden = true;
    try {
      const fresh = await api("/api/app/recovery-codes");
      showCodes(fresh.recovery_codes, "");
    } catch (error) {
      $(errorField).textContent = String(error.message || error);
      $(errorField).hidden = false;
    }
  };
  $("make-codes").onclick = () => mintCodes("nocodes-err");
  $("new-codes").onclick = () => mintCodes("set-err");

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
