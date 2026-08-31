// test/bank-feed-secrets.test.mjs
//
// THE TRAP THIS FILE EXISTS FOR.
//
// `reconcileWorkerProviderSecrets` DELETES any worker secret that is in
// WORKER_PROVIDER_SECRET_NAMES and is not in the manifest-derived allowlist
// from `optionalWorkerSecretNames`. That is correct and deliberate: it is how a
// brain switched off Supabase stops carrying a Supabase credential.
//
// It is also how a bank feed silently dies. Add the feed's two service
// identifiers to the managed list WITHOUT teaching the allowlist to return them
// when the manifest enables the feed, and the next routine `brain secrets` run
// deletes them. Every bank the client authorised then stops being read, with no
// error, on an install nobody touched. The client's answers just quietly stop
// including anything that happened after that day.
//
// So both halves are asserted here, against a REAL reconciliation run through
// `cmdSecrets` with an offline Cloudflare fixture. What is proven is not that a
// constant contains a string: it is that a reconciliation over a worker holding
// those secrets LEAVES THEM ALONE when the manifest enables the feed, and
// REMOVES them when it does not.
//
// The second half of the file covers the other thing that cannot be fixed while
// a client is sitting in front of you: the return address registration.
//
// Every persona and identifier here is invented.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_PROVIDER_SECRET_NAMES, optionalWorkerSecretNames, cmdSecrets, bankFeedWorkerBindings,
  probeBankFeedRuntime, checkBankFeedRuntime,
} from "../brain.mjs";
import {
  checkBankFeedRedirect, bankFeedRedirectUri, plaidWebhookUri,
  BANK_FEED_REDIRECT_PATH, PLAID_WEBHOOK_PATH, OK, WARN, FAIL,
} from "../doctor.mjs";
import { redirectUriFor } from "../worker/src/lib/bank-feed.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bank-feed-secrets-")));
const FIXTURE_KEY = `fixture-admin-${"a".repeat(40)}`;
const SERVICE_NAMES = ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"];
const WRAPPING_NAME = "BANK_FEED_WRAPPING_KEY_V2";
const FEED_NAMES = [...SERVICE_NAMES, WRAPPING_NAME];
const FIXTURE_WRAPPING_KEY = `v2.${Buffer.alloc(32, 37).toString("base64url")}`;

function manifest({ bankFeed = false } = {}) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain", domain: "fixture-brain.example.workers.dev" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    ...(bankFeed ? { corpora: { bank_feed: { enabled: true } } } : {}),
  };
}

function writeManifest(name, value) {
  const directory = join(sandbox, name);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const apiResponse = (result) => new Response(JSON.stringify({ success: true, result, errors: [] }), {
  status: 200, headers: { "content-type": "application/json" },
});

/** An offline Cloudflare, recording every secret write and delete in order. */
function cloudflareHarness(events, initialSecrets = []) {
  const secrets = new Set(initialSecrets);
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      return apiResponse([...secrets].map((name) => ({ name, type: "secret_text" })));
    }
    const one = url.pathname.match(/\/workers\/scripts\/fixture-brain\/secrets\/([^/]+)$/);
    if (one && method === "DELETE") {
      const name = decodeURIComponent(one[1]);
      events.push(`delete:${name}`);
      secrets.delete(name);
      return apiResponse({});
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      const name = JSON.parse(String(options.body || "{}")).name;
      events.push(`set:${name}`);
      secrets.add(name);
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
}

async function isolatedRuntime({ fetchImpl, env }, operation) {
  const priorFetch = globalThis.fetch;
  const names = [
    "CLOUDFLARE_API_TOKEN", "ADMIN_KEY", "ANTHROPIC_API_KEY",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", ...FEED_NAMES,
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const priorLog = console.log;
  const output = [];
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...args) => output.push(args.map(String).join(" "));
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(env || {})) process.env[name] = value;
    return { value: await operation(), output: output.join("\n") };
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

const secretsOptions = { explicitAdminKey: FIXTURE_KEY, assertKeyDirSafe: () => {} };

try {
  /* ============ both halves of the trap, as constants ============ */
  {
    check("the feed's two provider identifiers are managed, so an install that stops using the feed stops carrying them",
      SERVICE_NAMES.every((name) => WORKER_PROVIDER_SECRET_NAMES.includes(name)),
      JSON.stringify(WORKER_PROVIDER_SECRET_NAMES));
    check("the wrapping key is never in routine provider-secret deletion scope",
      !WORKER_PROVIDER_SECRET_NAMES.includes(WRAPPING_NAME),
      JSON.stringify(WORKER_PROVIDER_SECRET_NAMES));
    check("and the complete set is allowed when the manifest enables the feed",
      FEED_NAMES.every((name) => optionalWorkerSecretNames(manifest({ bankFeed: true })).includes(name)),
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))));
    check("with the feed off they are managed and NOT allowed, so reconciliation removes them",
      FEED_NAMES.every((name) => !optionalWorkerSecretNames(manifest()).includes(name)),
      JSON.stringify(optionalWorkerSecretNames(manifest())));
    check("enabling the feed does not quietly widen any OTHER credential's eligibility",
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))) ===
      JSON.stringify([...FEED_NAMES]),
      JSON.stringify(optionalWorkerSecretNames(manifest({ bankFeed: true }))));
    check("`enabled: true` is required; a truthy-looking manifest value does not turn it on",
      optionalWorkerSecretNames({ corpora: { bank_feed: { enabled: "yes" } } }).length === 0, "");
  }

  /* ============ THE PROOF: a real reconciliation run ============ */
  {
    const events = [];
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(events, [
        "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", ...FEED_NAMES,
      ]),
      env: {
        CLOUDFLARE_API_TOKEN: "fixture-token",
        BANK_FEED_CLIENT_ID: "fixture-client-id",
        BANK_FEED_SECRET: "fixture-service-secret",
        [WRAPPING_NAME]: FIXTURE_WRAPPING_KEY,
      },
    }, () => cmdSecrets(writeManifest("feed-on", manifest({ bankFeed: true })), secretsOptions));

    check("A RECONCILIATION RUN ON A FEED-ENABLED BRAIN LEAVES THE BANK SECRETS INTACT",
      !events.some((event) => event.startsWith("delete:BANK_FEED")), JSON.stringify(events));
    check("and it re-sets them from the environment rather than leaving them unmanaged",
      FEED_NAMES.every((name) => events.includes(`set:${name}`)), JSON.stringify(events));
    check("the admin key and its derived keys are still set in the same run",
      ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY"].every((n) => events.includes(`set:${n}`)),
      JSON.stringify(events));
  }

  {
    const events = [];
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(events, [
        "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY", ...FEED_NAMES, "UNRELATED_FIXTURE_SECRET",
      ]),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(writeManifest("feed-off", manifest()), secretsOptions));

    check("with the feed OFF the same run removes provider credentials but preserves the wrapping key",
      SERVICE_NAMES.every((name) => events.includes(`delete:${name}`)) &&
      !events.includes(`delete:${WRAPPING_NAME}`), JSON.stringify(events));
    check("and it still never touches a secret name it does not manage",
      !events.includes("delete:UNRELATED_FIXTURE_SECRET"), JSON.stringify(events));
  }

  {
    // The regression this whole file is named after: the managed list gains the
    // names and the allowlist does not. Simulated by asking the allowlist for a
    // manifest that does NOT enable the feed while the worker holds the
    // secrets — which is exactly the state a half-done change produces.
    const allowed = new Set(optionalWorkerSecretNames(manifest()));
    const wouldDelete = WORKER_PROVIDER_SECRET_NAMES.filter((name) => !allowed.has(name));
    check("the half-done change is exactly what the second half prevents",
      SERVICE_NAMES.every((name) => wouldDelete.includes(name)) &&
      SERVICE_NAMES.every((name) =>
        !WORKER_PROVIDER_SECRET_NAMES.filter((n) => !new Set(optionalWorkerSecretNames(manifest({ bankFeed: true }))).has(n))
          .includes(name)),
      JSON.stringify(wouldDelete));
  }

  /* ============ deploy before secrets ============ */
  {
    const events = [];
    let message = "";
    const missingScript = async (input, options = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/client/v4/accounts") return apiResponse([{ id: "fixture-account", name: "Fixture" }]);
      if (url.pathname.endsWith("/secrets") && (options.method || "GET") === "GET") return apiResponse([]);
      return new Response(JSON.stringify({
        success: false, result: null,
        errors: [{ code: 10007, message: "workers.api.error.script_not_found This Worker does not exist on your account" }],
      }), { status: 404, headers: { "content-type": "application/json" } });
    };
    try {
      await isolatedRuntime({
        fetchImpl: missingScript,
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-token",
          BANK_FEED_CLIENT_ID: "fixture-client-id",
          BANK_FEED_SECRET: "fixture-service-secret",
          [WRAPPING_NAME]: FIXTURE_WRAPPING_KEY,
        },
      }, () => cmdSecrets(writeManifest("no-worker", manifest({ bankFeed: true })), secretsOptions));
    } catch (error) {
      message = String(error?.message || error);
    }
    check("ORDER IS DEPLOY THEN SECRETS: setting secrets on a worker that is not there says so, in those words",
      /has not been deployed yet/.test(message) && /brain deploy/.test(message), message.slice(0, 200));
    check("and the failure never echoes the admin key or a service secret back",
      !message.includes(FIXTURE_KEY) && !message.includes("fixture-service-secret"), message.slice(0, 200));
    void events;
  }

  /* ============ the return address, checked before the session ============ */
  {
    check("the two runtimes agree on the return address path, so the check cannot drift from the route",
      BANK_FEED_REDIRECT_PATH === "/app/connect/bank" &&
      redirectUriFor("https://fixture-brain.example.workers.dev/x") ===
        bankFeedRedirectUri("fixture-brain.example.workers.dev"),
      `${BANK_FEED_REDIRECT_PATH} vs ${redirectUriFor("https://fixture-brain.example.workers.dev/x")}`);

    const off = checkBankFeedRedirect(manifest());
    check("a brain not using the feed passes without noise", off.status === OK && /not in use/.test(off.detail), JSON.stringify(off));

    const undeployed = checkBankFeedRedirect({ ...manifest({ bankFeed: true }), brain: { worker_name: "x" } });
    check("before deploy there is no address to check, and it says to deploy first",
      undeployed.status === WARN && /brain deploy/.test(undeployed.fix), JSON.stringify(undeployed));

    const unregistered = checkBankFeedRedirect(manifest({ bankFeed: true }));
    check("THE CHECK THAT SAVES A SESSION: an unregistered return address is a FAILURE, found in advance",
      unregistered.status === FAIL, JSON.stringify(unregistered));
    check("and the fix carries the exact address to register, and where to register it",
      unregistered.fix.includes("https://fixture-brain.example.workers.dev/app/connect/bank") &&
      /CLIENT'S OWN/.test(unregistered.fix), unregistered.fix);
    check("and it says what happens if it is skipped, so it is not filed as a nag",
      /land on a dead return/.test(unregistered.fix), unregistered.fix);

    const halfConfigured = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: { enabled: true, registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"] } },
    });
    check("a registered address with no provider host declared is a warning naming what is missing",
      halfConfigured.status === WARN && /api_base/.test(halfConfigured.fix), JSON.stringify(halfConfigured));

    const ready = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        api_base: "https://sandbox.provider.invalid",
        link_sdk_url: "https://cdn.provider.invalid/link.js",
        link_global: "ProviderLink",
      } },
    });
    check("a fully prepared install passes and names the environment it will rehearse in",
      ready.status === OK && /sandbox/.test(ready.detail), JSON.stringify(ready));
    const plaidReady = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, provider: "plaid", environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
      } },
    });
    check("the named Plaid profile needs no custom host and prints its signed webhook address",
      plaidReady.status === OK && /plaid; sandbox/.test(plaidReady.detail) &&
      plaidReady.detail.includes("https://fixture-brain.example.workers.dev/api/webhooks/plaid") &&
      PLAID_WEBHOOK_PATH === "/api/webhooks/plaid" &&
      plaidWebhookUri("fixture-brain.example.workers.dev") ===
        "https://fixture-brain.example.workers.dev/api/webhooks/plaid",
      JSON.stringify(plaidReady));
    const plaidOverride = checkBankFeedRedirect({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true, provider: "plaid", environment: "sandbox",
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
        api_base: "https://unexpected.example",
      } },
    });
    check("the named Plaid profile refuses custom endpoint overrides",
      plaidOverride.status === FAIL && /custom endpoint override/.test(plaidOverride.detail),
      JSON.stringify(plaidOverride));
    check("a different brain's registered address does not satisfy this brain's check",
      checkBankFeedRedirect({
        ...manifest({ bankFeed: true }),
        corpora: { bank_feed: { enabled: true, registered_redirect_uris: ["https://other-brain.example.workers.dev/app/connect/bank"] } },
      }).status === FAIL, "");
  }

  /* ============ deploy carries public Plaid configuration, never credentials ============ */
  {
    check("a brain with the feed off deploys no stale bank-feed configuration",
      bankFeedWorkerBindings(manifest()).length === 0, "");
    const plaidBindings = bankFeedWorkerBindings({
      ...manifest({ bankFeed: true }),
      client: { slug: "fixture", display_name: "Fixture Brain" },
      corpora: { bank_feed: {
        enabled: true, provider: "plaid", environment: "sandbox",
        entity_slug: "primary", country_codes: ["US"], reconciliation_interval_minutes: 360,
      } },
    });
    const plaidNames = plaidBindings.map((binding) => binding.name);
    check("deploy names the Plaid profile and its reconciliation policy without endpoint overrides",
      plaidNames.includes("BANK_FEED_PROVIDER") && plaidNames.includes("BANK_FEED_RECONCILE_MINUTES") &&
      !plaidNames.includes("BANK_FEED_API_BASE") && !plaidNames.includes("BANK_FEED_LINK_SDK_URL") &&
      !plaidNames.includes("BANK_FEED_ENTITY"),
      JSON.stringify(plaidBindings));
    const customNames = bankFeedWorkerBindings({
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: { enabled: true, provider: "custom", entity_slug: "fixture-company" } },
    }).map((binding) => binding.name);
    check("only the compatible custom feed receives its explicit single-entity binding",
      customNames.includes("BANK_FEED_ENTITY"), JSON.stringify(customNames));
    check("deploy metadata contains no Plaid credential name or fixture secret",
      !JSON.stringify(plaidBindings).includes("BANK_FEED_CLIENT_ID") &&
      !JSON.stringify(plaidBindings).includes("BANK_FEED_SECRET") &&
      !JSON.stringify(plaidBindings).includes("fixture-service-secret"),
      JSON.stringify(plaidBindings));
  }

  /* ============ manifest intent must match the deployed private runtime ============ */
  {
    const liveManifest = {
      ...manifest({ bankFeed: true }),
      corpora: { bank_feed: {
        enabled: true,
        provider: "plaid",
        environment: "sandbox",
        reconciliation_interval_minutes: 360,
        registered_redirect_uris: ["https://fixture-brain.example.workers.dev/app/connect/bank"],
      } },
    };
    const runtimeBody = {
      configured: true,
      provider: "plaid",
      environment: "sandbox",
      signed_webhook_path: "/api/webhooks/plaid",
      reconciliation_interval_minutes: 360,
      connections: [],
      needs_attention: [],
    };
    const calls = [];
    const runtimePath = writeManifest("runtime-proof", liveManifest);
    const runtimeProbe = await probeBankFeedRuntime(runtimePath, {
      resolveAdminKey: () => FIXTURE_KEY,
      http: async (url, options) => {
        calls.push({ url, key: options?.headers?.["X-Admin-Key"] });
        return new Response(JSON.stringify(runtimeBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    check("doctor reads the deployed private status route rather than trusting manifest intent",
      runtimeProbe.checked === true && calls.length === 1 &&
      calls[0].url === "https://fixture-brain.example.workers.dev/api/bank-feed/status" &&
      calls[0].key === FIXTURE_KEY,
      JSON.stringify({ runtimeProbe, calls: calls.map((entry) => ({ url: entry.url, key_present: Boolean(entry.key) })) }));
    check("matching deployed Plaid configuration passes even before the first account is connected",
      checkBankFeedRuntime(liveManifest, runtimeProbe).status === OK,
      JSON.stringify(checkBankFeedRuntime(liveManifest, runtimeProbe)));

    const missingSecrets = checkBankFeedRuntime(liveManifest, {
      checked: true,
      body: { ...runtimeBody, configured: false },
    });
    check("a Worker with missing effective secrets fails instead of reporting a healthy empty bank list",
      missingSecrets.status === FAIL && /not configured/.test(missingSecrets.detail),
      JSON.stringify(missingSecrets));

    const staleDeploy = checkBankFeedRuntime(liveManifest, {
      checked: true,
      body: { ...runtimeBody, environment: "production", reconciliation_interval_minutes: 720 },
    });
    check("a stale deployment with the wrong environment or refresh interval fails by name",
      staleDeploy.status === FAIL && /environment/.test(staleDeploy.detail) && /refresh interval/.test(staleDeploy.detail),
      JSON.stringify(staleDeploy));

    const unavailable = checkBankFeedRuntime(liveManifest, {
      checked: false,
      reason: "private status returned 503",
    });
    check("an unavailable runtime proof is a blocking failure, not a confident configured result",
      unavailable.status === FAIL && /not proven/.test(unavailable.detail),
      JSON.stringify(unavailable));

    const refusedProbe = await probeBankFeedRuntime(runtimePath, {
      resolveAdminKey: () => FIXTURE_KEY,
      http: async () => new Response("unauthorized", { status: 401 }),
    });
    check("a refused private runtime receipt stays explicitly unproven",
      refusedProbe.checked === false && /401/.test(refusedProbe.reason), JSON.stringify(refusedProbe));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILURES" : "bank-feed-secrets"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
