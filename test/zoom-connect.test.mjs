// test/zoom-connect.test.mjs
//
// The client-side half of the Zoom connector: credential custody, the live
// probe, the plan-tier finding, and the URL-validation self-check that has to
// pass before a client is told to paste anything into Zoom.
//
// No network. Zoom is a scripted fetch closure throughout. The one place a
// real implementation is used rather than a fake is deliberate and is the most
// valuable test in this file: `verifyLiveWebhookEndpoint` is pointed at the
// ACTUAL worker route handler, so the CLI's idea of the handshake and the
// worker's idea of the handshake are proven to agree. Two halves of a
// challenge-response that were only ever tested against their own fakes would
// pass forever while failing in front of the client.

import {
  ZOOM_CREDENTIAL_ENV,
  ZOOM_OPTIONAL_PLAN_SCOPE,
  ZOOM_WEBHOOK_PATH,
  probeZoomAccount,
  randomPlainToken,
  readZoomCredentialsFromEnv,
  summarizeZoomProbe,
  verifyLiveWebhookEndpoint,
  zoomAppCreationSteps,
  zoomEventSubscriptionSteps,
  zoomWebhookUrl,
} from "../connectors/zoom.mjs";
import { ZOOM_REQUIRED_SCOPE, handleZoomWebhook } from "../worker/src/lib/zoom.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

/**
 * Use a real streaming Response so the probe exercises the same bounded body
 * reader used for provider traffic in production.
 */
const reply = (status, body) => new Response(
  typeof body === "string" ? body : JSON.stringify(body ?? {}),
  { status, headers: { "content-type": "application/json" } },
);

const GOOD = Object.freeze({
  ZOOM_ACCOUNT_ID: "account-abc",
  ZOOM_CLIENT_ID: "client-abc",
  ZOOM_CLIENT_SECRET: "secret-abc",
  ZOOM_WEBHOOK_SECRET_TOKEN: "webhook-secret-abc",
});

/**
 * Script a Zoom API surface. Each key is matched as a substring of the URL,
 * first match wins, so the token endpoint and the two v2 reads stay readable.
 */
function zoomFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [fragment, responder] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        if (typeof responder === "function") return responder(String(url), init);
        return typeof responder?.clone === "function" ? responder.clone() : responder;
      }
    }
    return reply(404, { message: "unscripted" });
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_OK = reply(200, { access_token: "tok-live", expires_in: 3600 });

/* ---------------------------------------------- credential custody */
{
  const { values, missing, complete } = readZoomCredentialsFromEnv({ ...GOOD });
  check("all four credentials are read from the environment", complete && missing.length === 0);
  check("the four names are exactly the four Zoom issues",
    ZOOM_CREDENTIAL_ENV.length === 4 && Object.keys(values).length === 4,
    ZOOM_CREDENTIAL_ENV.join(","));
  check("the webhook Secret Token is one of them, distinct from the client secret",
    ZOOM_CREDENTIAL_ENV.includes("ZOOM_WEBHOOK_SECRET_TOKEN") &&
    ZOOM_CREDENTIAL_ENV.includes("ZOOM_CLIENT_SECRET"));

  const partial = readZoomCredentialsFromEnv({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b" });
  check("a partial environment is refused and names every missing value",
    !partial.complete && partial.missing.length === 2 &&
    partial.missing.includes("ZOOM_CLIENT_SECRET") &&
    partial.missing.includes("ZOOM_WEBHOOK_SECRET_TOKEN"),
    partial.missing.join(","));

  const blank = readZoomCredentialsFromEnv({ ...GOOD, ZOOM_CLIENT_SECRET: "   " });
  check("a whitespace-only value counts as missing, not as a credential",
    !blank.complete && blank.missing.includes("ZOOM_CLIENT_SECRET"));

  const padded = readZoomCredentialsFromEnv({ ...GOOD, ZOOM_ACCOUNT_ID: "  account-abc\n" });
  check("a value pasted with surrounding whitespace is trimmed, not sent as-is",
    padded.values.ZOOM_ACCOUNT_ID === "account-abc");
}

/* ------------------------------------------------------- the steps */
{
  const creation = zoomAppCreationSteps().join("\n");
  check("the setup steps name the one required scope", creation.includes(ZOOM_REQUIRED_SCOPE));
  check("the setup steps ask for no write scope at all",
    !/write:admin/.test(creation), creation.match(/\S*write:admin\S*/)?.[0]);
  check("the optional plan scope is offered as optional and read-only",
    creation.includes(ZOOM_OPTIONAL_PLAN_SCOPE) && /Optionally/.test(creation) && /read-only/.test(creation));
  check("the setup steps say Zoom issues the Secret Token rather than offering to generate one",
    /Zoom issues this one\. You cannot choose it/.test(creation) && !/generate/i.test(creation));
  check("the setup steps warn the Secret Token is not the Client Secret",
    /not the Client Secret/.test(creation));
  check("the setup steps keep the credential-custody rule",
    /Never paste them into a shell command/.test(creation));
  check("the setup steps say the app must be activated before credentials work",
    /Activate the app/.test(creation) && /do not work until/.test(creation));

  // The ordering constraint, enforced structurally rather than documented.
  check("the setup steps do NOT yet mention the webhook endpoint URL",
    !creation.includes(ZOOM_WEBHOOK_PATH) && !/Event Subscription/i.test(creation),
    "the URL must not be pasted into Zoom until the worker holds the secret");

  const subscription = zoomEventSubscriptionSteps("https://brain.example.test/api/webhooks/zoom").join("\n");
  check("the subscription steps carry the exact URL the worker answers on",
    subscription.includes("https://brain.example.test/api/webhooks/zoom"));
  check("the subscription records early debt and transcript-ready delivery",
    subscription.includes("recording.completed") &&
    subscription.includes("recording.transcript_completed"));
  check("the steps explain why both events are required",
    /durable work debt/.test(subscription) && /transcript is ready/.test(subscription));
  check("the subscription steps explain that clicking Validate calls the URL live",
    /Zoom calls that URL right now/.test(subscription));
  check("the subscription steps state the cloud-recording-with-transcript prerequisite",
    /Audio\s*\n?\s*transcript/i.test(subscription) || /audio transcript/i.test(subscription));
}

/* ------------------------------------------------------- webhook url */
{
  check("the webhook url is the base plus the worker's own route",
    zoomWebhookUrl("https://brain.example.test") === "https://brain.example.test/api/webhooks/zoom");
  check("a trailing slash on the base does not produce a double slash",
    zoomWebhookUrl("https://brain.example.test/") === "https://brain.example.test/api/webhooks/zoom");
}

/* ------------------------------------------------------- live probe */
{
  const impl = zoomFetch({
    "zoom.us/oauth/token": TOKEN_OK,
    "/users/me/recordings": reply(200, { meetings: [] }),
    "/users/me": reply(200, { type: 2, email: "owner@example.test" }),
  });
  const probe = await probeZoomAccount(GOOD, { fetchImpl: impl });
  const summary = summarizeZoomProbe(probe);

  check("a good account probes clean", summary.ok && summary.blockers.length === 0, summary.blockers.join(" | "));
  check("the token exchange is the account_credentials grant",
    /grant_type=account_credentials/.test(impl.calls[0].init.body));
  check("the token exchange authenticates with Basic base64(clientId:clientSecret)",
    impl.calls[0].init.headers.Authorization === `Basic ${Buffer.from("client-abc:secret-abc").toString("base64")}`);
  check("the recordings read is the cheap one-row call, not a full listing",
    impl.calls.some((call) => call.url.includes("/users/me/recordings?page_size=1")));
  check("the recordings read carries the freshly issued token",
    impl.calls[1].init.headers.Authorization === "Bearer tok-live");
  check("a Licensed plan is reported as confirmed, and as able to cloud record",
    probe.plan.confirmed && probe.plan.plan.label === "Licensed" && probe.plan.plan.cloudRecording === true);
  check("a confirmed working plan is a note, never a blocker",
    summary.notes.some((note) => /Licensed/.test(note)));
}

/* ------------------------------- the plan tier is the load-bearing check */
{
  const impl = zoomFetch({
    "zoom.us/oauth/token": TOKEN_OK,
    "/users/me/recordings": reply(200, { meetings: [] }),
    "/users/me": reply(200, { type: 1, email: "owner@example.test" }),
  });
  const summary = summarizeZoomProbe(await probeZoomAccount(GOOD, { fetchImpl: impl }));
  check("a Basic account is a BLOCKER, not a warning", !summary.ok && summary.blockers.length === 1);
  check("the Basic refusal explains that cloud recording does not exist on that tier",
    /no cloud recording/i.test(summary.blockers[0]), summary.blockers[0]);
  check("the Basic refusal says nothing was written",
    /Nothing was written/.test(summary.blockers[0]));
}
{
  // The optional scope was declined. This must degrade to a named unknown.
  const impl = zoomFetch({
    "zoom.us/oauth/token": TOKEN_OK,
    "/users/me/recordings": reply(200, { meetings: [] }),
    "/users/me": reply(400, { code: 4711, message: "Invalid access token, does not contain scopes:[user:read:admin]" }),
  });
  const probe = await probeZoomAccount(GOOD, { fetchImpl: impl });
  const summary = summarizeZoomProbe(probe);
  check("an unreadable plan tier is reported as unknown, never assumed Licensed",
    !probe.plan.confirmed && probe.plan.plan.label === "unknown" && probe.plan.plan.cloudRecording === null);
  check("Zoom's scope refusal is recognised at 400/4711, not only at 403",
    /is not granted/.test(probe.plan.reason), probe.plan.reason);
  check("an unconfirmed plan does NOT block the connection",
    summary.ok && summary.blockers.length === 0);
  check("but it is stated plainly, with the paid-plan requirement and where to look",
    summary.notes.some((note) => /not confirmed/.test(note) && /Licensed \(paid\)/.test(note) && /zoom\.us\/profile/.test(note)),
    summary.notes.join(" | "));
}
{
  const impl = zoomFetch({
    "zoom.us/oauth/token": TOKEN_OK,
    "/users/me/recordings": reply(400, { code: 4711, message: "does not contain scopes:[cloud_recording:read:admin]" }),
    "/users/me": reply(200, { type: 2 }),
  });
  const summary = summarizeZoomProbe(await probeZoomAccount(GOOD, { fetchImpl: impl }));
  check("a missing cloud_recording scope blocks the connect", !summary.ok);
  check("and the refusal names the exact scope to add and says to reactivate",
    summary.blockers[0].includes(ZOOM_REQUIRED_SCOPE) && /activate the app again/i.test(summary.blockers[0]),
    summary.blockers[0]);
}
{
  const impl = zoomFetch({ "zoom.us/oauth/token": reply(401, { reason: "Invalid client" }) });
  let error = null;
  try {
    await probeZoomAccount(GOOD, { fetchImpl: impl });
  } catch (caught) { error = caught; }
  check("bad credentials fail at the token exchange, before any other call",
    Boolean(error) && impl.calls.length === 1);
  check("and the message points at the three values and the activation state",
    /Account ID, Client ID and Client Secret/.test(error?.message || "") && /Activated/.test(error?.message || ""),
    error?.message);
}
{
  // Nothing is unreachable merely because the optional check threw.
  const impl = zoomFetch({
    "zoom.us/oauth/token": TOKEN_OK,
    "/users/me/recordings": reply(200, { meetings: [] }),
    "/users/me": () => { throw new Error("socket hang up"); },
  });
  const probe = await probeZoomAccount(GOOD, {
    fetchImpl: impl,
    requestOptions: { maxAttempts: 2, sleepImpl: async () => {} },
  });
  const summary = summarizeZoomProbe(probe);
  check("a thrown plan check is caught and named, not left to crash the connect",
    !probe.plan.confirmed && /could not be reached/.test(probe.plan.reason || "") && summary.ok,
    probe.plan.reason);
}

/* ------------------------------------- the live handshake self-check */
{
  check("each challenge uses a fresh random plainToken",
    randomPlainToken() !== randomPlainToken());
}
{
  // THE integration test. `fetchImpl` here is the real worker route handler,
  // so a disagreement between the two halves of the handshake fails right here
  // instead of in front of a client with Zoom's opaque error.
  const workerAsFetch = (env) => async (url, init = {}) => {
    const request = new Request(String(url), {
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body,
    });
    return handleZoomWebhook(env, request, { waitUntil() {} });
  };

  const live = await verifyLiveWebhookEndpoint(
    zoomWebhookUrl("https://brain.example.test"),
    GOOD.ZOOM_WEBHOOK_SECRET_TOKEN,
    { fetchImpl: workerAsFetch({ ZOOM_WEBHOOK_SECRET_TOKEN: GOOD.ZOOM_WEBHOOK_SECRET_TOKEN }) },
  );
  check("the CLI's challenge and the real worker route agree on the answer", live.ok, live.reason);

  const wrongSecret = await verifyLiveWebhookEndpoint(
    zoomWebhookUrl("https://brain.example.test"),
    GOOD.ZOOM_WEBHOOK_SECRET_TOKEN,
    { fetchImpl: workerAsFetch({ ZOOM_WEBHOOK_SECRET_TOKEN: "a-different-secret" }) },
  );
  check("a worker holding a DIFFERENT secret is caught before Zoom ever sees it",
    !wrongSecret.ok && /Secret Token it holds is not the one supplied/.test(wrongSecret.reason),
    wrongSecret.reason);

  const noSecret = await verifyLiveWebhookEndpoint(
    zoomWebhookUrl("https://brain.example.test"),
    GOOD.ZOOM_WEBHOOK_SECRET_TOKEN,
    { fetchImpl: workerAsFetch({}) },
  );
  check("a worker with no secret set is reported as not configured, with the fix",
    !noSecret.ok && /not configured/.test(noSecret.reason) && /redeploy/i.test(noSecret.reason),
    noSecret.reason);
}
{
  const old = await verifyLiveWebhookEndpoint("https://brain.example.test/api/webhooks/zoom", "s", {
    fetchImpl: async () => reply(404, { error: "not found" }),
  });
  check("a worker with no such route is reported as needing a redeploy",
    !old.ok && /404/.test(old.reason), old.reason);

  const wrongShape = await verifyLiveWebhookEndpoint("https://brain.example.test/api/webhooks/zoom", "s", {
    fetchImpl: async () => reply(200, { ok: true }),
  });
  check("a 200 that is not the challenge shape is caught, not treated as a pass",
    !wrongShape.ok && /before this connector existed/.test(wrongShape.reason), wrongShape.reason);

  const unreachable = await verifyLiveWebhookEndpoint("https://brain.example.test/api/webhooks/zoom", "s", {
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
  });
  check("an unreachable brain is named as unreachable, with its URL",
    !unreachable.ok && /did not answer at https:\/\/brain\.example\.test/.test(unreachable.reason),
    unreachable.reason);

  // A worker that echoed a constant would pass a fixed-token check forever.
  const echoed = await verifyLiveWebhookEndpoint("https://brain.example.test/api/webhooks/zoom", "s", {
    fetchImpl: async () => reply(200, { plainToken: "not-the-one-we-sent", encryptedToken: "whatever" }),
  });
  check("a worker echoing the wrong plainToken back is rejected",
    !echoed.ok, echoed.reason);
}

console.log(fail ? `\n${fail} FAILURES` : `\nzoom connect: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
