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

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
</style>
<main>
  <h1><svg viewBox="6 24 88 52"><path d="M50 50 C50 30 16 30 16 50 C16 70 50 70 50 50 C50 30 84 30 84 50 C84 70 50 70 50 50 Z" fill="none" stroke="#3b5bdb" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>${brainName}</h1>

  <div id="gate" class="card" hidden>
    <p id="gate-msg" class="muted"></p>
    <div class="row">
      <button id="gate-btn"></button>
    </div>
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
      $("gate-msg").textContent = enrollCode
        ? "You have an enrollment link. One tap creates your passkey — your face or fingerprint, on this device."
        : "Sign in with your passkey.";
      $("gate-btn").textContent = enrollCode ? "Set up with Face ID / fingerprint" : "Sign in";
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

  $("ask").onclick = async () => {
    const q = $("q").value.trim();
    if (!q) return;
    $("ask").classList.add("spin");
    $("askstate").textContent = "thinking…";
    $("out").hidden = true;
    try {
      const r = await api("/api/rag/think", { q, limit: 12 });
      $("answer").textContent = r.answer || (r.answer_error ? "No answer: " + r.answer_error : "The documents do not answer the question.");
      const conf = r.confidence;
      $("confidence").textContent = conf
        ? (r.answer && !/^The documents do not answer/.test(r.answer || "") ? "Confidence" : "Confidence nothing is recorded") +
          ": " + conf.percent + "% (" + conf.band + ") — " + conf.basis.join("; ") + "."
        : "";
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
