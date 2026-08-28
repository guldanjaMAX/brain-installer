// test/zoom-cli.test.mjs
//
// The `brain connect zoom` / `brain disconnect zoom` wiring, driven the way
// test/imessage-ingest.test.mjs drives iMessage: the REAL command functions
// against the REAL connector module, with only the outside world faked. Zoom
// is a scripted fetch; Cloudflare's secret PUT/DELETE is a recording closure;
// and the live webhook check is pointed at the REAL worker route handler, so
// the CLI, the connector and the worker are all proven to agree end to end.
//
// The assertions that matter most here are about ORDER, not output. Zoom
// validates a webhook URL at the moment it is saved, so a wizard that printed
// that URL before the worker was verifiably holding the secret would send the
// client into an opaque Zoom-side failure. Several tests below exist only to
// prove that nothing is written and no URL is printed until each earlier gate
// has passed.
//
// What this cannot prove is stated in evidence/WP-08.md rather than implied
// away: no test here has ever spoken to Zoom.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdConnectZoom, cmdDisconnectZoom } from "../brain.mjs";
import * as zoomConnector from "../connectors/zoom.mjs";
import { handleZoomWebhook } from "../worker/src/lib/zoom.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260)));
  if (!c) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-zoom-cli-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  manifest_version: 1,
  client: { slug: "northwind", display_name: "Northwind Supply", timezone: "America/Phoenix" },
  brain: { version: "0.1.22", domain: "brain.northwind-example.test", worker_name: "northwind-brain" },
  corpora: { zoom: { enabled: true } },
  operations: {},
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const disabledPath = join(sandbox, "zoom-off.manifest.json");
writeFileSync(disabledPath, JSON.stringify({ ...manifest, corpora: {} }, null, 2));

const CREDS = Object.freeze({
  ZOOM_ACCOUNT_ID: "acct-northwind",
  ZOOM_CLIENT_ID: "client-northwind",
  ZOOM_CLIENT_SECRET: "clientsecret-northwind",
  ZOOM_WEBHOOK_SECRET_TOKEN: "secrettoken-northwind",
});

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
  json: async () => (typeof body === "string" ? JSON.parse(body) : (body ?? {})),
});

/** Zoom, scripted. `planType` drives the tier check; `scope` the recordings read. */
function zoomApi({ planType = 2, recordingsStatus = 200 } = {}) {
  return async (url) => {
    const target = String(url);
    if (target.includes("zoom.us/oauth/token")) return reply(200, { access_token: "tok-live" });
    if (target.includes("/users/me/recordings")) {
      return recordingsStatus === 200
        ? reply(200, { meetings: [] })
        : reply(recordingsStatus, { code: 4711, message: "does not contain scopes:[cloud_recording:read:admin]" });
    }
    if (target.includes("/users/me")) return reply(200, { type: planType });
    return reply(404, {});
  };
}

/** The live worker, for real, so the handshake is proven across both halves. */
const workerFetch = (env) => async (url, init = {}) => handleZoomWebhook(
  env,
  new Request(String(url), { method: init.method || "GET", headers: init.headers || {}, body: init.body }),
  { waitUntil() {} },
);

/** Cloudflare's secrets API, recorded rather than called. */
function secretRecorder(behaviour = {}) {
  const written = [];
  const deleted = [];
  return {
    written,
    deleted,
    put: async (account, script, name, text) => {
      if (behaviour.putThrows) throw new Error(behaviour.putThrows);
      written.push({ accountId: account.id, script, name, text });
    },
    del: async (account, script, name) => {
      const outcome = behaviour.deleteThrows?.[name];
      if (outcome) throw new Error(outcome);
      deleted.push({ accountId: account.id, script, name });
    },
  };
}

/** Run a command with console captured, returning printed text and any Fatal. */
async function run(fn) {
  const lines = [];
  const realLog = console.log, realErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  let error = null, result = null;
  try { result = await fn(); } catch (caught) { error = caught; }
  console.log = realLog; console.error = realErr;
  return { output: lines.join("\n"), error, result };
}

const baseOptions = (extra = {}) => ({
  zoom: zoomConnector,
  env: { ...CREDS },
  resolveAccount: async () => ({ id: "cf-account-northwind", name: "Northwind" }),
  resolveBaseUrl: async () => "https://brain.northwind-example.test",
  resolveAdminKey: () => "admin-key-for-tests",
  postSourceExpectation: async () => ({ source: "zoom" }),
  // Real code waits between retries; tests must not.
  sleep: async () => {},
  probeOptions: { fetchImpl: zoomApi() },
  verifyOptions: { fetchImpl: workerFetch({ ZOOM_WEBHOOK_SECRET_TOKEN: CREDS.ZOOM_WEBHOOK_SECRET_TOKEN }) },
  ...extra,
});

try {
  /* ------------------------------------------------ the manifest gate */
  {
    const rec = secretRecorder();
    const { error, output } = await run(() => cmdConnectZoom(disabledPath, {}, baseOptions({
      putWorkerSecret: rec.put,
    })));
    check("a manifest that has not declared zoom is refused",
      /corpora\.zoom\.enabled is not true/.test(error?.message || ""), error?.message);
    check("and nothing was written to the worker", rec.written.length === 0);
    check("and no webhook URL was printed", !output.includes("/api/webhooks/zoom"));
  }

  /* ------------------------------------------- the credential gate */
  {
    const rec = secretRecorder();
    const { error, output } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      env: { ZOOM_ACCOUNT_ID: "acct-northwind" },
      putWorkerSecret: rec.put,
    })));
    check("a partial environment is refused and names every missing value",
      /ZOOM_CLIENT_ID/.test(error?.message || "") &&
      /ZOOM_CLIENT_SECRET/.test(error?.message || "") &&
      /ZOOM_WEBHOOK_SECRET_TOKEN/.test(error?.message || ""), error?.message);
    check("the refusal says nothing was created or changed",
      /Nothing was created or changed/.test(error?.message || ""));
    check("the marketplace steps are printed so the client knows what to make",
      /marketplace\.zoom\.us/.test(output) && /Server-to-Server OAuth/.test(output));
    check("but still no webhook URL, because the worker holds no secret yet",
      !output.includes("/api/webhooks/zoom"));
    check("and nothing was written", rec.written.length === 0);
  }

  /* --------------------------------- the plan tier, before any write */
  {
    const rec = secretRecorder();
    const { error, output } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      probeOptions: { fetchImpl: zoomApi({ planType: 1 }) },
      putWorkerSecret: rec.put,
    })));
    check("a Basic Zoom account is refused",
      /Basic/.test(error?.message || "") && /no cloud recording/i.test(error?.message || ""),
      error?.message);
    check("the plan check runs BEFORE any secret is written",
      rec.written.length === 0, `${rec.written.length} secrets were written`);
    check("and no webhook URL was printed", !output.includes("/api/webhooks/zoom"));
  }
  {
    const rec = secretRecorder();
    const { error } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      probeOptions: { fetchImpl: zoomApi({ recordingsStatus: 400 }) },
      putWorkerSecret: rec.put,
    })));
    check("a missing cloud_recording scope is refused, naming the scope",
      /cloud_recording:read:admin/.test(error?.message || ""), error?.message);
    check("the scope check also runs before any secret is written", rec.written.length === 0);
  }

  /* ------------------------------------------------- the happy path */
  {
    const rec = secretRecorder();
    const expectations = [];
    const { error, output, result } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      postSourceExpectation: async (base, key, body) => { expectations.push({ base, key, body }); return body; },
    })));
    check("a Licensed account with the right scope connects cleanly", !error, error?.message);
    check("exactly four secrets are written, no more",
      rec.written.length === 4, JSON.stringify(rec.written.map((w) => w.name)));
    check("they are the four Zoom issues",
      ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"]
        .every((name) => rec.written.some((w) => w.name === name)));
    check("they carry the values supplied, unmodified",
      rec.written.every((w) => w.text === CREDS[w.name]));
    check("they go to the CLIENT'S own account and the manifest's own worker",
      rec.written.every((w) => w.accountId === "cf-account-northwind" && w.script === "northwind-brain"));
    check("the live handshake against the real worker route is confirmed",
      /answered Zoom's validation challenge correctly/.test(output), output.slice(-400));
    check("the webhook URL is printed only now, after all of that",
      output.includes("https://brain.northwind-example.test/api/webhooks/zoom") &&
      result?.webhookUrl === "https://brain.northwind-example.test/api/webhooks/zoom");
    check("the event to subscribe to is the transcript one",
      output.includes("recording.transcript_completed") && /Not recording\.completed/.test(output));
    check("zoom is registered as a named source with no refresh cadence",
      expectations.length === 1 && expectations[0].body.source === "zoom" &&
      expectations[0].body.kind === "zoom" && expectations[0].body.expected_refresh_seconds === null,
      JSON.stringify(expectations));
    check("no credential value is ever printed to the terminal",
      !Object.values(CREDS).some((value) => output.includes(value)),
      Object.values(CREDS).filter((v) => output.includes(v)).join(","));
  }

  /* -------------------------------- the worker is not deployed yet */
  {
    const rec = secretRecorder({ putThrows: "PUT /accounts/x/workers/scripts/y/secrets failed (404): 10007: This Worker does not exist" });
    const { error } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
    })));
    check("an undeployed worker is explained as an ordering problem, not an account problem",
      /has not been deployed yet/.test(error?.message || "") && /brain deploy/.test(error?.message || ""),
      error?.message);
  }

  /* ------------------------- the worker is live but holds another secret */
  {
    const rec = secretRecorder();
    const { error, output } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      verifyOptions: { fetchImpl: workerFetch({ ZOOM_WEBHOOK_SECRET_TOKEN: "some-other-token" }) },
    })));
    check("a worker answering with a different secret stops the wizard",
      /Secret Token it holds is not the one supplied/.test(error?.message || ""), error?.message);
    check("and the client is told explicitly NOT to paste the URL into Zoom yet",
      /do NOT paste the URL into Zoom yet/.test(error?.message || ""), error?.message);
    check("so the URL and the event steps are never printed on that path",
      !output.includes("recording.transcript_completed"));
  }
  {
    const rec = secretRecorder();
    const { error } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      verifyOptions: { fetchImpl: workerFetch({}) },
    })));
    check("a worker running a build with no Zoom route/secret is named as needing a redeploy",
      /not configured/.test(error?.message || "") && /[Rr]edeploy/.test(error?.message || ""),
      error?.message);
  }

  /* ------------------- a secret that has not propagated yet is retried */
  {
    // A secret written seconds ago can miss an already-running isolate. The
    // first check then answers with the OLD secret, which looks exactly like
    // the client having copied the wrong Secret Token. Telling them that would
    // send them back to Zoom to re-copy a value that is already correct.
    const rec = secretRecorder();
    let call = 0;
    const settlesOnSecondTry = async (url, init) => {
      call++;
      const env = call === 1
        ? { ZOOM_WEBHOOK_SECRET_TOKEN: "the-previous-secret" }
        : { ZOOM_WEBHOOK_SECRET_TOKEN: CREDS.ZOOM_WEBHOOK_SECRET_TOKEN };
      return workerFetch(env)(url, init);
    };
    const { error, output } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      verifyOptions: { fetchImpl: settlesOnSecondTry },
    })));
    check("a secret that lands on the second check still connects",
      !error && call === 2, error?.message || `checked ${call} times`);
    check("and the retry is said out loud rather than hidden",
      /has not answered the validation challenge yet; retrying/.test(output), output.slice(-300));
    check("and the client still gets the webhook steps",
      output.includes("recording.transcript_completed"));
  }
  {
    // But retrying is not the same as giving up quietly: a permanently wrong
    // secret must still stop the wizard after the attempts are spent.
    const rec = secretRecorder();
    let call = 0;
    const neverSettles = async (url, init) => {
      call++;
      return workerFetch({ ZOOM_WEBHOOK_SECRET_TOKEN: "permanently-different" })(url, init);
    };
    const { error } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      verifyOptions: { fetchImpl: neverSettles },
    })));
    check("a genuinely wrong secret still fails, after a bounded number of tries",
      /Secret Token it holds is not the one supplied/.test(error?.message || "") && call === 3,
      error?.message || `checked ${call} times`);
  }

  /* ------------------------------ a failed source registration is not fatal */
  {
    const rec = secretRecorder();
    const { error, output } = await run(() => cmdConnectZoom(manifestPath, {}, baseOptions({
      putWorkerSecret: rec.put,
      postSourceExpectation: async () => { throw new Error("brain unreachable"); },
    })));
    check("an unreachable brain does not undo a good connection", !error, error?.message);
    check("it warns and explains why it is harmless",
      /could not be registered up front/.test(output) && /first transcript that arrives registers it/.test(output));
    check("the webhook steps are still printed", output.includes("recording.transcript_completed"));
  }

  /* ----------------------------------------------------- disconnect */
  {
    const rec = secretRecorder();
    const { error, output, result } = await run(() => cmdDisconnectZoom(manifestPath, {}, baseOptions({
      deleteWorkerSecret: rec.del,
    })));
    check("disconnect removes all four secrets", !error && rec.deleted.length === 4,
      error?.message || JSON.stringify(rec.deleted.map((d) => d.name)));
    check("from the same client account and worker",
      rec.deleted.every((d) => d.accountId === "cf-account-northwind" && d.script === "northwind-brain"));
    check("and says plainly that the webhook now refuses deliveries",
      /refuses every delivery/.test(output));
    check("it names the Zoom-side step it cannot do for the client",
      /marketplace\.zoom\.us/.test(output) && /Remove the Event Subscription/.test(output));
    check("and points at forget for the transcripts already loaded",
      /brain forget .* --source zoom/.test(output));
    check("the result reports what it removed", result?.removed?.length === 4);
  }
  {
    // Already gone is the desired state, not an error.
    const rec = secretRecorder({
      deleteThrows: {
        ZOOM_ACCOUNT_ID: "DELETE ... failed (404): 10056: binding does not exist",
        ZOOM_CLIENT_ID: "DELETE ... failed (404): 10056: binding does not exist",
        ZOOM_CLIENT_SECRET: "DELETE ... failed (404): 10056: binding does not exist",
        ZOOM_WEBHOOK_SECRET_TOKEN: "DELETE ... failed (404): 10056: binding does not exist",
      },
    });
    const { error, output } = await run(() => cmdDisconnectZoom(manifestPath, {}, baseOptions({
      deleteWorkerSecret: rec.del,
    })));
    check("secrets that were never set are not treated as a failure",
      !error && /nothing to remove/.test(output), error?.message);
  }
  {
    // A secret that genuinely would not delete must be loud: Zoom can still deliver.
    const rec = secretRecorder({ deleteThrows: { ZOOM_WEBHOOK_SECRET_TOKEN: "PUT failed (403): 10000: Authentication error" } });
    const { error } = await run(() => cmdDisconnectZoom(manifestPath, {}, baseOptions({
      deleteWorkerSecret: rec.del,
    })));
    check("a secret that will not delete is a hard failure, naming which one",
      /ZOOM_WEBHOOK_SECRET_TOKEN/.test(error?.message || ""), error?.message);
    check("and warns that Zoom may still be able to deliver transcripts",
      /may still be able to deliver/.test(error?.message || ""), error?.message);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nzoom cli: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
