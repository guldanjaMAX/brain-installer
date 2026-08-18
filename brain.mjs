#!/usr/bin/env node
/**
 * brain — provision and manage a client-owned brain install.
 *
 *   brain verify      <manifest>   check the token and resolve the account
 *   brain provision   <manifest>   create D1 (and R2/KV), write IDs back
 *   brain deploy      <manifest>   upload the worker with its bindings
 *   brain secrets     <manifest>   set worker secrets interactively
 *   brain health      <manifest>   prove the install actually works
 *
 * DESIGN RULES
 *
 * Everything runs against the CLIENT's Cloudflare account using a scoped token
 * the client issued. We never hold their data and the token is revoked at
 * handoff, so this tool must work from a standing start with nothing but that
 * token and a manifest.
 *
 * The account id is RESOLVED FROM THE TOKEN, never hardcoded and never taken
 * from the manifest as gospel. A token that can see two accounts is ambiguous
 * and must fail loudly rather than provision into the wrong one, because
 * provisioning into the wrong account is the one mistake with no clean undo.
 *
 * Every step is idempotent: re-running finds existing resources by name and
 * adopts them rather than creating duplicates. An installer you are afraid to
 * re-run is an installer you will not use.
 *
 * The token is read from the CLOUDFLARE_API_TOKEN environment variable only.
 * It is never written to the manifest, never logged, and never passed as a
 * command-line argument where `ps` could read it.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
// The ingest pipeline is loaded LAZILY, inside the commands that use it. It
// pulls in the PDF/Office dependencies at import time, so a top-level import
// meant that on a clone without node_modules the very first command, including
// `brain doctor` whose whole job is diagnosing that machine, crashed with
// ERR_MODULE_NOT_FOUND before it could say anything useful.
async function ingestLib() {
  try {
    return await import("./ingest/run.mjs");
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      die(
        "the ingest dependencies are not installed. From the brain-installer folder run:\n" +
          "        npm ci --ignore-scripts\n" +
          "      then re-run this command."
      );
    }
    throw e;
  }
}
import { authorize, loadTokens, saveTokens, createTokenProvider, tokenPath, SCOPES, DEFAULT_PORT } from "./connectors/google-auth.mjs";
import { run } from "./doctor.mjs";
import { runAll as doctorRunAll, summarize as doctorSummarize, OK as D_OK, WARN as D_WARN, FAIL as D_FAIL } from "./doctor.mjs";

// fileURLToPath, never `new URL(...).pathname`. The latter is percent-encoded,
// so any install path containing a space resolves to a directory that does not
// exist, and on Windows it keeps a leading slash before the drive letter
// (/C:/Users/...), which readdirSync rejects outright. The first client install
// runs on Windows, so this is not hypothetical.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The version of the code actually running, read from package.json.
 *
 * NOT from the client's manifest. The manifest is their file and it records
 * what is INSTALLED; using it as the upgrade target meant shipping 0.2.0 and
 * having the upgrade dutifully record "upgraded to 0.1.0", because their
 * manifest still said so. Version tracking that reports the old number after a
 * successful upgrade is worse than none: it makes support impossible.
 */
const PRODUCT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "package.json"), "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const API = "https://api.cloudflare.com/client/v4";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const ok = (s) => console.log(`${c.green("ok")}    ${s}`);
const info = (s) => console.log(`${c.dim("·")}     ${s}`);
const warn = (s) => console.log(`${c.yellow("warn")}  ${s}`);
/**
 * Fatal error.
 *
 * `die` THROWS rather than calling process.exit, because commands call each
 * other: `upgrade` runs migrate, deploy and health in sequence. An exit inside
 * a sub-command skips the caller's catch entirely, so the failure never
 * reaches the upgrade log and a broken install reads as one that was simply
 * never upgraded. Found by running a real upgrade and watching the failure
 * vanish from the history.
 */
class Fatal extends Error {}

const die = (s) => {
  throw new Fatal(s);
};

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN;
  if (!t) {
    die(
      "CLOUDFLARE_API_TOKEN is not set.\n" +
        "      Export the scoped token the client issued:\n" +
        "        export CLOUDFLARE_API_TOKEN='...'\n" +
        "      It is deliberately not read from the manifest, so it never lands in a file."
    );
  }
  return t;
}

async function cf(path, { method = "GET", body, raw } = {}) {
  const res = await http(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!json.success) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${path} failed (${res.status}): ${errs || text.slice(0, 200)}`);
  }
  return json.result;
}

function loadManifest(path) {
  if (!path) die("usage: brain <command> <manifest.json>");
  try {
    return { path, m: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    die(`could not read manifest at ${path}: ${e.message}`);
  }
}

function saveManifest(path, m) {
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
}

/**
 * Resolve the account from the token itself.
 *
 * If the manifest names an account, it must MATCH one the token can see. A
 * mismatch is a hard stop: it usually means the wrong token, and provisioning
 * a brain into someone else's account is the one error with no clean undo.
 */
async function resolveAccount(m) {
  const accounts = await cf("/accounts");
  if (!accounts.length) die("this token cannot see any Cloudflare account.");

  const declared = m.infrastructure?.cloudflare?.account_id;
  if (declared && !declared.startsWith("REQUIRED")) {
    const match = accounts.find((a) => a.id === declared);
    if (!match) {
      die(
        `the manifest declares account ${declared}, but this token can only see:\n` +
          accounts.map((a) => `        ${a.id}  ${a.name}`).join("\n") +
          "\n      Refusing to provision into a different account than the manifest names."
      );
    }
    return match;
  }

  if (accounts.length > 1) {
    die(
      "this token can see more than one account and the manifest does not say which:\n" +
        accounts.map((a) => `        ${a.id}  ${a.name}`).join("\n") +
        "\n      Set infrastructure.cloudflare.account_id in the manifest."
    );
  }
  return accounts[0];
}

/* ------------------------------------------------------------- commands */

async function cmdVerify(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  ok(`token valid, account "${acct.name}" (${acct.id})`);

  // R2 needs separate activation and a card on file, even for the free tier.
  // It is the most common mid-install surprise, so it is checked up front.
  try {
    await cf(`/accounts/${acct.id}/r2/buckets`);
    ok("R2 is enabled");
  } catch (e) {
    warn(
      "R2 is NOT enabled (or the token lacks R2 scope). The client must enable it\n" +
        "        in the dashboard, which requires a payment method even on the free tier.\n" +
        `        detail: ${e.message.slice(0, 120)}`
    );
  }

  try {
    await cf(`/accounts/${acct.id}/d1/database`);
    ok("D1 is reachable");
  } catch (e) {
    warn(`D1 not reachable, the token may lack D1 scope: ${e.message.slice(0, 120)}`);
  }

  try {
    await cf(`/accounts/${acct.id}/workers/scripts`);
    ok("Workers is reachable");
  } catch (e) {
    die(`Workers is not reachable, so nothing can be deployed: ${e.message.slice(0, 160)}`);
  }

  // Vectorize is where the meaning lives. Without it the brain still answers,
  // but only by keyword, which means it finds documents that repeat the
  // question's words and misses the ones that answer it in different words.
  // That degradation is quiet, so it is checked up front rather than discovered
  // later as "search feels bad".
  try {
    await cf(`/accounts/${acct.id}/vectorize/v2/indexes`);
    ok("Vectorize is reachable");
  } catch (e) {
    warn(
      "Vectorize is NOT reachable. Two separate causes, both need fixing:\n" +
        "        1. TOKEN SCOPE. Add \"Vectorize: Edit\" to the API token.\n" +
        "           dash.cloudflare.com > My Profile > API Tokens > edit the token.\n" +
        "           An auth error here does NOT mean the token is invalid overall;\n" +
        "           it means this one permission is missing.\n" +
        "        2. PLAN. Vectorize requires the Workers Paid plan, 5 USD a month\n" +
        "           minimum. The free tier cannot create an index at all.\n" +
        `        detail: ${e.message.slice(0, 120)}`
    );
  }
  return acct;
}


/**
 * Vectorize through wrangler, because no API token can reach it.
 *
 * Verified 2026-08-17: every stored Cloudflare API token returns
 * "Authentication error 10000" on /vectorize/v2/indexes while /user/tokens/verify
 * reports the same token active and valid. Cloudflare surfaces a missing scope as
 * a flat auth failure, so this looks like a broken token and is not one.
 *
 * Wrangler's own OAuth session CAN do it. That matters beyond convenience: for a
 * live install the client running `wrangler login` in their own browser is the
 * better custody story anyway, because the session is theirs, it expires on its
 * own, and no long-lived credential to their business ever lands on our machine.
 *
 * CLOUDFLARE_API_TOKEN must be cleared for the child process. Wrangler prefers it
 * when set and will silently authenticate as the wrong identity.
 */
function wrangler(args, { accountId } = {}) {
  // Through doctor's runner, which knows that npm CLIs are .cmd shims on
  // Windows and that Node refuses to spawn those without a shell since
  // CVE-2024-27980. The previous raw spawnSync returned ENOENT there, which
  // made provision report "wrangler: not logged in" to a client whose doctor
  // had verified the login moments earlier.
  const env = { CLOUDFLARE_API_TOKEN: undefined };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const r = run("npx", ["wrangler@4", ...args], { timeout: 180_000, env });
  return { ok: r.ok, out: r.out, status: r.ok ? 0 : 1 };
}

function wranglerAvailable(accountId) {
  const r = wrangler(["whoami"], { accountId });
  return r.ok && /You are logged in|Account Name/i.test(r.out);
}

async function cmdProvision(manifestPath) {
  const { path, m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  info(`provisioning into "${acct.name}" (${acct.id})`);

  m.infrastructure = m.infrastructure || {};
  m.infrastructure.cloudflare = m.infrastructure.cloudflare || {};
  const cfg = m.infrastructure.cloudflare;
  cfg.account_id = acct.id;

  // D1. Adopt an existing database of the same name rather than failing or
  // creating a second one, so provision is safe to re-run.
  const dbName = cfg.d1_database_name || "brain";
  const existing = await cf(`/accounts/${acct.id}/d1/database`);
  let db = (existing || []).find((d) => d.name === dbName);
  if (db) {
    ok(`D1 "${dbName}" already exists (${db.uuid}), adopting it`);
  } else {
    db = await cf(`/accounts/${acct.id}/d1/database`, {
      method: "POST",
      body: { name: dbName },
    });
    ok(`D1 "${dbName}" created (${db.uuid})`);
  }
  cfg.d1_database_id = db.uuid;

  // R2, optional. A failure here is not fatal: the brain runs without it.
  if (cfg.r2_bucket) {
    try {
      const buckets = await cf(`/accounts/${acct.id}/r2/buckets`);
      const found = (buckets.buckets || []).find((b) => b.name === cfg.r2_bucket);
      if (found) {
        ok(`R2 bucket "${cfg.r2_bucket}" already exists, adopting it`);
      } else {
        await cf(`/accounts/${acct.id}/r2/buckets`, {
          method: "POST",
          body: { name: cfg.r2_bucket },
        });
        ok(`R2 bucket "${cfg.r2_bucket}" created`);
      }
    } catch (e) {
      warn(`R2 step skipped: ${e.message.slice(0, 140)}`);
    }
  }

  // Vectorize, when the manifest asks for the Cloudflare-only storage path.
  if ((cfg.storage || "d1") === "d1") {
    const idxName = cfg.vectorize_index || `${m.client?.slug || "client"}-brain`;
    // 768 and cosine are NOT free choices. They are the output shape of
    // @cf/baai/bge-base-en-v1.5, the model the worker embeds with. An index
    // built at other dimensions rejects every vector, and one built with a
    // different metric silently ranks wrong rather than erroring.
    let list = null;
    let viaApi = true;
    try {
      list = await cf(`/accounts/${acct.id}/vectorize/v2/indexes`);
    } catch (e) {
      // A missing scope, not a broken token. Fall through to wrangler rather
      // than stopping an install that can still complete.
      viaApi = false;
      info("the API token cannot reach Vectorize, trying wrangler's own session");
      if (!wranglerAvailable(acct.id)) {
        die(
          `Vectorize is unreachable both ways, so the install cannot continue.\n` +
            `  API token: ${e.message.slice(0, 100)}\n` +
            "  wrangler:  not logged in.\n\n" +
            "  Fix EITHER of these:\n" +
            '    1. Add "Vectorize: Edit" to the API token at\n' +
            "       dash.cloudflare.com > My Profile > API Tokens\n" +
            "    2. Or run `npx wrangler@4 login` and re-run provision. For a live install\n" +
            "       this is the better option: the session is the client's, it expires on\n" +
            "       its own, and no long-lived key to their account is ever stored here.\n\n" +
            "  Either way the account must be on the Workers Paid plan (5 USD a month);\n" +
            "  Vectorize cannot create an index on the free tier at all."
        );
      }
      const r = wrangler(["vectorize", "list"], { accountId: acct.id });
      if (!r.ok) die(`wrangler could not list Vectorize indexes: ${r.out.slice(-300)}`);
      // wrangler prints a table; a name match is enough to know it exists.
      list = new RegExp(`\\b${idxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(r.out)
        ? [{ name: idxName, config: {} }]
        : [];
    }

    try {
      const found = (list || []).find((i) => i.name === idxName);
      if (found) {
        const d = found.config?.dimensions;
        const metric = found.config?.metric;
        if (d && d !== 768) {
          die(
            `Vectorize index "${idxName}" has ${d} dimensions, but the embedding model\n` +
              "  produces 768. Adopting it would reject every vector. Delete it or pick\n" +
              "  another name via infrastructure.cloudflare.vectorize_index."
          );
        }
        if (metric && metric !== "cosine") {
          die(`Vectorize index "${idxName}" uses metric "${metric}", not cosine. Ranking would be wrong, not broken, so this refuses rather than adopts.`);
        }
        ok(`Vectorize "${idxName}" already exists, adopting it`);
      } else if (viaApi) {
        await cf(`/accounts/${acct.id}/vectorize/v2/indexes`, {
          method: "POST",
          body: {
            name: idxName,
            description: `retrieval index for ${m.client?.display_name || "brain"}`,
            config: { dimensions: 768, metric: "cosine" },
          },
        });
        ok(`Vectorize "${idxName}" created (768-dim, cosine)`);
      } else {
        // 768 and cosine are the output shape of @cf/baai/bge-base-en-v1.5, the
        // model the worker embeds with. Any other values reject every vector or
        // rank wrongly, so they are not configurable.
        const r = wrangler(
          ["vectorize", "create", idxName, "--dimensions=768", "--metric=cosine"],
          { accountId: acct.id }
        );
        if (!r.ok) die(`wrangler could not create the Vectorize index: ${r.out.slice(-400)}`);
        ok(`Vectorize "${idxName}" created via wrangler (768-dim, cosine)`);
      }

      // A metadata index must exist BEFORE any vector is written; it does not
      // apply retroactively. Creating it after ingest means source filtering
      // silently matches nothing for everything already indexed.
      try {
        if (viaApi) {
          await cf(`/accounts/${acct.id}/vectorize/v2/indexes/${idxName}/metadata_index`, {
            method: "POST",
            body: { propertyName: "source", indexType: "string" },
          });
        } else {
          const r = wrangler(
            ["vectorize", "create-metadata-index", idxName, "--property-name=source", "--type=string"],
            { accountId: acct.id }
          );
          if (!r.ok && !/already|exists/i.test(r.out)) throw new Error(r.out.slice(-200));
        }
        ok('metadata index on "source" created');
      } catch (e) {
        if (/already|exists|conflict/i.test(e.message)) ok('metadata index on "source" already present');
        else warn(`metadata index not created, source filtering will fall back to post-filtering: ${e.message.slice(0, 100)}`);
      }

      cfg.vectorize_index = idxName;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      die(
        `Vectorize could not be provisioned: ${e.message.slice(0, 140)}\n` +
          "  This is the storage backend, so the install cannot continue without it.\n" +
          '  Fix: add "Vectorize: Edit" to the API token, and confirm the account is on\n' +
          "  the Workers Paid plan (5 USD a month, which Vectorize requires).\n" +
          "  To install against Postgres instead, set infrastructure.cloudflare.storage\n" +
          '  to "supabase" in the manifest.'
      );
    }
  }

  saveManifest(path, m);
  ok(`manifest updated with the resource IDs (${relative(process.cwd(), path)})`);
  // Order matters and was wrong here. Secrets are set ON a worker script, so on
  // a first install the script must exist first; running secrets before deploy
  // returns a bare 404 "This Worker does not exist on your account". Deploy is
  // safe to run without secrets (it carries keep_bindings, so a later deploy
  // preserves them), which makes deploy-then-secrets the only order that works
  // from nothing.
  info("next: brain migrate <manifest>, then deploy, then secrets, then health");
}

function collectWorkerFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".js")) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function cmdDeploy(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const cfg = m.infrastructure.cloudflare;
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  if (!cfg.d1_database_id) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const srcRoot = join(HERE, "worker", "src");
  const files = collectWorkerFiles(srcRoot);
  if (!files.length) die(`no worker source found at ${srcRoot}`);

  const form = new FormData();
  for (const f of files) {
    // Module specifiers are relative to src/, matching the import paths.
    // POSIX separators ALWAYS. A module specifier is a URL, not a filesystem
    // path, and the worker imports "./lib/core.js". On Windows relative()
    // returns "lib\\core.js", so every module uploads under a name the runtime
    // cannot resolve and the worker dies with: No such module "lib/core.js".
    // Found by the first real Windows install; CI could not catch it because
    // deploying needs live Cloudflare credentials.
    const rel = relative(srcRoot, f).split(sep).join("/");
    form.append(
      rel,
      new Blob([readFileSync(f, "utf-8")], { type: "application/javascript+module" }),
      rel
    );
  }

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-01-01",
    bindings: [
      { type: "d1", name: "DB", id: cfg.d1_database_id },
      { type: "ai", name: "AI" },
      // Explicit, never inferred. The worker CAN guess its backend from which
      // bindings are present, but a guess that silently picks the wrong store
      // returns an empty brain rather than an error, so the manifest states it.
      { type: "plain_text", name: "STORAGE", text: cfg.storage || "d1" },
      ...(cfg.vectorize_index
        ? [{ type: "vectorize", name: "VECTORIZE", index_name: cfg.vectorize_index }]
        : []),
      { type: "plain_text", name: "BRAIN_NAME", text: m.client?.slug || "brain" },
      { type: "plain_text", name: "BRAIN_OWNER", text: m.client?.display_name || "the owner" },
      { type: "plain_text", name: "BRAIN_VERSION", text: PRODUCT_VERSION },
      {
        type: "plain_text",
        name: "DAILY_LLM_CAP_USD",
        text: String(m.safety?.daily_llm_spend_cap_usd ?? 10),
      },
      {
        type: "plain_text",
        name: "CREDENTIAL_SCANNER",
        text: m.safety?.credential_scanner?.enabled === false ? "off" : "on",
      },
    ],
    // Without this, every secret set by `brain secrets` is wiped on the next
    // deploy. It is the single most destructive omission in a Workers deploy
    // and it fails silently: the worker deploys fine and then 500s on use.
    keep_bindings: ["secret_text"],
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  if ((cfg.storage || "d1") === "d1" && !cfg.vectorize_index) {
    die(
      "storage is d1 but the manifest has no vectorize_index. Run `brain provision`\n" +
        "  first. Deploying now would produce a worker that answers by keyword only,\n" +
        "  and would look healthy while doing it."
    );
  }

  info(`uploading ${files.length} module(s) as "${scriptName}"`);
  await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}`, {
    method: "PUT",
    body: form,
    raw: true,
  });
  ok(`deployed "${scriptName}"`);

  // A deploy that is not verified is a belief. Enable the workers.dev route so
  // there is always a URL to prove it against, even before a custom domain.
  try {
    await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}/subdomain`, {
      method: "POST",
      body: { enabled: true },
    });
    ok("workers.dev route enabled");
  } catch (e) {
    warn(`could not enable the workers.dev route: ${e.message.slice(0, 120)}`);
  }

  // The cron that drains the vector outbox. Without it the D1 install writes
  // text that keyword search can find and vector search cannot, forever, and
  // reports itself healthy the whole time because both systems are up.
  if ((cfg.storage || "d1") === "d1") {
    const schedule = cfg.drain_cron || "*/5 * * * *";
    try {
      await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}/schedules`, {
        method: "PUT",
        body: [{ cron: schedule }],
      });
      ok(`vector drain scheduled (${schedule})`);
    } catch (e) {
      warn(
        `could not set the drain cron: ${e.message.slice(0, 120)}\n` +
          "        Ingested text will be keyword-searchable but NOT semantically\n" +
          "        searchable until this is set. Check it with `brain health`."
      );
    }
  }
  info("next: brain secrets <manifest>, then brain health <manifest>");
}

async function cmdSecrets(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  // What a D1 install actually reads. The worker embeds through the AI binding,
  // so there is no database credential to set: the brain's storage is D1 and
  // Vectorize inside the client's own account, reachable only by their worker.
  const needed = ["ADMIN_KEY", "ANTHROPIC_API_KEY"];
  // Only for an install pointed at Postgres. Set when present, never demanded.
  const optional = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const provided = [...needed, ...optional].filter((n) => process.env[n]);
  const missing = needed.filter((n) => !process.env[n]);

  if (!provided.length) {
    die(
      "no secrets found in the environment. Export the ones you want to set, then re-run:\n" +
        needed.map((n) => `        export ${n}='...'`).join("\n") +
        "\n      They are read from the environment, never from a file and never from argv."
    );
  }

  for (const name of provided) {
    try {
      await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}/secrets`, {
        method: "PUT",
        body: { name, text: process.env[name], type: "secret_text" },
      });
    } catch (e) {
      // A secret is set ON a script, so the script has to exist. The raw 404
      // says "This Worker does not exist on your account", which sends people
      // looking at their account rather than at the order they ran things in.
      if (/does not exist/i.test(e.message) || /\(404\)/.test(e.message)) {
        die(
          `the worker "${scriptName}" has not been deployed yet, so there is nothing to set secrets on.\n` +
            "  Run `brain deploy <manifest>` first, then `brain secrets`. Deploying without\n" +
            "  secrets is safe: the deploy carries keep_bindings, so setting them afterwards\n" +
            "  sticks and later deploys preserve them."
        );
      }
      throw e;
    }
    ok(`secret ${name} set`);
  }
  // ADMIN_KEY absent means every authenticated route stays shut; ANTHROPIC_API_KEY
  // absent means search still works but nothing writes an answer. Both are worth
  // naming precisely rather than as a bare list.
  for (const name of missing) {
    warn(
      name === "ADMIN_KEY"
        ? "ADMIN_KEY was not set. Every route except /health will return 401 until it is."
        : name === "ANTHROPIC_API_KEY"
          ? "ANTHROPIC_API_KEY was not set. Search will return sources, but /think will return no written answer."
          : `not set (absent from the environment): ${name}`
    );
  }
}

async function cmdHealth(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
  const base = m.brain?.domain
    ? `https://${m.brain.domain}`
    : sub?.subdomain
      ? `https://${scriptName}.${sub.subdomain}.workers.dev`
      : null;
  if (!base) die("could not determine a URL for this install.");

  info(`probing ${base}`);

  // A freshly deployed worker is not instantly routable: the workers.dev route
  // 404s for a few seconds while it propagates. Failing immediately turns a
  // normal wait into a false alarm, and during an upgrade that false alarm
  // reads as "the release is broken", which is the worst possible wrong
  // conclusion to hand someone mid-deploy. Same lag class as secret
  // propagation, and as a deleted worker still answering 200.
  let res, body;
  const healthAttempts = 6;
  for (let i = 1; i <= healthAttempts; i++) {
    res = await http(`${base}/health?cb=${i}`, {}, { timeoutMs: 20_000, what: "the health check" });
    body = await res.text();
    if (res.ok) break;
    if (i < healthAttempts && (res.status === 404 || res.status >= 500)) {
      info(`${res.status} on attempt ${i}/${healthAttempts}, waiting for the route to propagate`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    break;
  }
  if (!res.ok) die(`/health returned ${res.status} after ${healthAttempts} attempts: ${body.slice(0, 200)}`);
  ok(`/health ${res.status} ${body.slice(0, 160)}`);

  const key = resolveAdminKey(manifestPath);
  if (!key) {
    warn("ADMIN_KEY not in the environment, so authenticated routes were not probed.");
    return;
  }

  // Secrets take a few seconds to reach every edge location. Running `secrets`
  // and `health` back to back therefore races, and the failure looks exactly
  // like a wrong key: a flat 401. Retrying turns a confusing false alarm into
  // a short wait. Measured on a real install: ready between 5 and 10 seconds.
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    const docs = await http(`${base}/api/admin/brain/documents`, {
      headers: { "X-Admin-Key": key },
    });
    const dbody = await docs.text();
    if (docs.ok) {
      ok(`documents endpoint ${docs.status} ${dbody.slice(0, 160)}`);

      // The one failure this install has that Postgres did not: text written to
      // D1 whose vector never reached Vectorize. Both systems are up, every
      // probe passes, and semantic search quietly answers from a subset. The
      // backlog is the only place that shows.
      try {
        const j = JSON.parse(dbody);
        const backlog = j.vector_backlog;
        if (backlog && Number(backlog.pending) > 0) {
          const oldest = backlog.oldest_queued_at
            ? Math.floor((Date.now() - Number(backlog.oldest_queued_at)) / 60000)
            : null;
          const stalled = oldest !== null && oldest > 30;
          (stalled ? warn : info)(
            `${backlog.pending} chunk(s) awaiting embedding` +
              (oldest !== null ? `, oldest queued ${oldest} min ago` : "") +
              (stalled
                ? ".\n        Older than 30 minutes means the drain cron is NOT running. Those\n" +
                  "        chunks are findable by keyword and invisible to semantic search.\n" +
                  "        Check the schedule on the worker in the Cloudflare dashboard."
                : " (the drain cron will clear these).")
          );
        } else if (backlog) {
          ok("vector index is caught up with the text");
        }
      } catch {
        // A body that will not parse is not a health failure on its own.
      }
      return;
    }
    if (docs.status === 401 && i < attempts) {
      info(`401 on attempt ${i}/${attempts}, waiting for secret propagation`);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    warn(`documents endpoint ${docs.status}: ${dbody.slice(0, 200)}`);
    if (docs.status === 401) {
      warn("still 401 after retries. Check that ADMIN_KEY here matches the deployed secret.");
    }
    return;
  }
}

/* ---------------------------------------------------------- migrations */


async function d1Query(acctId, dbId, sql, params = []) {
  const res = await cf(`/accounts/${acctId}/d1/database/${dbId}/query`, {
    method: "POST",
    body: { sql, params },
  });
  return Array.isArray(res) ? res[0] : res;
}

function loadMigrations() {
  const dir = join(HERE, "migrations", "d1");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf-8");
      return {
        version: parseInt(f.split("_")[0], 10),
        name: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    });
}

/**
 * Split a migration file into statements.
 *
 * D1's query endpoint takes one statement at a time, so a migration file has to
 * be split. Two things make that harder than `split(";")`.
 *
 * A semicolon inside a STRING LITERAL is not a statement boundary, so the scan
 * below tracks quote state (including the '' escape).
 *
 * A semicolon inside a TRIGGER BODY is not one either, and this is the case that
 * actually bit. `CREATE TRIGGER ... BEGIN <stmt>; <stmt>; END;` is ONE statement
 * containing several. Splitting naively yields a truncated trigger with no END
 * plus an orphan `END`, and D1 rejects the first with "incomplete input". The
 * migration then aborts partway, which is the worst possible outcome: the tables
 * exist, the triggers do not, and keyword search returns nothing forever while
 * every health probe passes.
 *
 * So fragments opening a CREATE TRIGGER are re-joined until their END arrives.
 * An unterminated one is emitted as-is rather than swallowed, so SQLite reports
 * the real error instead of this function hiding it.
 */
export function splitStatements(sql) {
  const src = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const fragments = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      if (inString && src[i + 1] === "'") {
        buf += "''";
        i++;
        continue;
      }
      inString = !inString;
      buf += c;
      continue;
    }
    if (c === ";" && !inString) {
      fragments.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) fragments.push(buf);

  const endsWithEnd = (t) => /\bEND\s*$/i.test(t.trim());
  const out = [];
  let pending = null;
  for (const frag of fragments) {
    if (pending !== null) {
      pending += ";" + frag;
      if (endsWithEnd(frag)) {
        out.push(pending);
        pending = null;
      }
      continue;
    }
    const t = frag.trim();
    if (!t) continue;
    if (/\bCREATE\s+TRIGGER\b/i.test(t) && !endsWithEnd(t)) {
      pending = frag;
      continue;
    }
    out.push(frag);
  }
  if (pending !== null) out.push(pending);

  return out.map((s) => s.trim()).filter(Boolean);
}

async function appliedVersions(acctId, dbId) {
  try {
    const r = await d1Query(acctId, dbId, "SELECT version, checksum, name FROM schema_migrations");
    return r?.results || [];
  } catch {
    return []; // table does not exist yet, so nothing is applied
  }
}

async function cmdMigrate(manifestPath, { silent = false } = {}) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const all = loadMigrations();
  if (!all.length) die("no migrations found.");
  const applied = await appliedVersions(acct.id, dbId);
  const appliedMap = new Map(applied.map((a) => [a.version, a]));

  // A migration whose content changed after being applied is a hard stop.
  // Editing an applied migration means two installs silently have different
  // schemas under the same version number, which is the worst possible state
  // to debug: everything reports as up to date and nothing matches.
  for (const mig of all) {
    const prev = appliedMap.get(mig.version);
    if (prev && prev.checksum !== mig.checksum) {
      die(
        `migration ${mig.name} was already applied but its content has changed.\n` +
          `      applied checksum ${prev.checksum}, file checksum ${mig.checksum}\n` +
          "      Never edit an applied migration. Add a new one instead."
      );
    }
  }

  const pending = all.filter((mig) => !appliedMap.has(mig.version));
  if (!pending.length) {
    if (!silent) ok(`schema up to date (${all.length} migration(s) applied)`);
    return { applied: 0, schemaVersion: Math.max(...all.map((x) => x.version)) };
  }

  for (const mig of pending) {
    if (!silent) info(`applying ${mig.name}`);
    for (const stmt of splitStatements(mig.sql)) {
      await d1Query(acct.id, dbId, stmt);
    }
    await d1Query(
      acct.id,
      dbId,
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)",
      [mig.version, mig.name, new Date().toISOString(), mig.checksum]
    );
    if (!silent) ok(`applied ${mig.name}`);
  }

  const schemaVersion = Math.max(...all.map((x) => x.version));

  // Seed or refresh the single install_state row.
  //
  // NOTE: product_version is set on INSERT only, never on UPDATE. Migrating is
  // not the same as shipping: if a later step of the upgrade fails, the
  // database must not already claim the new version. Only `upgrade` advances
  // it, and only after verification passes.
  const now = new Date().toISOString();
  await d1Query(
    acct.id,
    dbId,
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       client_slug = excluded.client_slug,
       schema_version = excluded.schema_version,
       gate_version = excluded.gate_version`,
    [
      m.client?.slug || "unknown",
      PRODUCT_VERSION,
      schemaVersion,
      m.safety?.credential_scanner?.gate_version ?? 2,
      now,
      m.brain?.ring || "stable",
    ]
  );
  if (!silent) ok(`schema at version ${schemaVersion}`);
  return { applied: pending.length, schemaVersion };
}

async function cmdStatus(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest.");

  const st = await d1Query(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1").catch(
    () => null
  );
  const row = st?.results?.[0];
  if (!row) {
    warn("no install_state row. This install has never been migrated.");
  } else {
    console.log(`  client          ${row.client_slug}`);
    console.log(`  product version ${row.product_version}`);
    console.log(`  schema version  ${row.schema_version}`);
    console.log(`  gate version    ${row.gate_version}`);
    console.log(`  ring            ${row.ring}`);
    console.log(`  installed       ${row.installed_at}`);
    console.log(`  last upgraded   ${row.last_upgraded_at || "never"}`);
  }

  const runs = await d1Query(
    acct.id,
    dbId,
    "SELECT started_at, from_version, to_version, status FROM upgrade_runs ORDER BY started_at DESC LIMIT 5"
  ).catch(() => null);
  const rows = runs?.results || [];
  if (rows.length) {
    console.log("\n  recent upgrades:");
    for (const r of rows) {
      const mark = r.status === "verified" ? "ok" : r.status === "rolled_back" ? "!!" : "  ";
      console.log(`    ${mark} ${r.started_at.slice(0, 19)}  ${r.from_version || "?"} -> ${r.to_version || "?"}  ${r.status}`);
    }
  }

  const local = loadMigrations();
  const applied = await appliedVersions(acct.id, dbId);
  const pending = local.filter((l) => !applied.some((a) => a.version === l.version));
  console.log(
    `\n  migrations: ${applied.length} applied, ${pending.length} pending${pending.length ? " (" + pending.map((p) => p.name).join(", ") + ")" : ""}`
  );
}

/**
 * Full upgrade: snapshot, migrate, deploy, verify.
 *
 * ROLLBACK IS DELIBERATELY NOT AUTOMATIC.
 *
 * The obvious design restores the D1 bookmark on any failed check. But a
 * restore is itself destructive and irreversible, and running one unattended
 * against a client's only copy of their data trades a broken deploy for
 * potential data loss. So this captures the bookmark, prints it, and stops.
 * Recovery is one explicit command away and stays a human decision.
 */
async function cmdUpgrade(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const before = await d1Query(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1").catch(
    () => null
  );
  const fromVersion = before?.results?.[0]?.product_version || "unknown";
  // The version being upgraded TO is the code in the client's hands right now.
  const toVersion = PRODUCT_VERSION;

  // Snapshot first. A bookmark taken after a migration is worthless.
  let bookmark = null;
  try {
    const bm = await cf(`/accounts/${acct.id}/d1/database/${dbId}/time_travel/bookmark`);
    bookmark = bm?.bookmark || null;
    ok(`snapshot bookmark ${bookmark}`);
  } catch (e) {
    warn(`could not capture a D1 bookmark, continuing without a restore point: ${e.message.slice(0, 100)}`);
  }

  const startedAt = new Date().toISOString();
  const logRun = async (status, detail) => {
    try {
      await d1Query(
        acct.id,
        dbId,
        `INSERT INTO upgrade_runs (started_at, finished_at, from_version, to_version, status, d1_bookmark, detail)
         VALUES (?,?,?,?,?,?,?)`,
        [startedAt, new Date().toISOString(), fromVersion, toVersion, status, bookmark, detail || null]
      );
    } catch {
      /* the run log must never be the reason an upgrade fails */
    }
  };

  info(`upgrading ${fromVersion} -> ${toVersion}`);

  try {
    await cmdMigrate(manifestPath);
    await cmdDeploy(manifestPath);
  } catch (e) {
    await logRun("failed", e.message.slice(0, 400));
    die(
      `upgrade failed: ${e.message}\n` +
        (bookmark
          ? `      A restore point was captured BEFORE any change:\n` +
            `        brain rollback ${manifestPath} ${bookmark}\n` +
            `      Rollback is not automatic on purpose: a restore is destructive and\n` +
            `      unattended data loss is worse than a broken deploy.`
          : "      No restore point was captured.")
    );
  }

  // Verify. An upgrade that is not verified is a belief.
  try {
    await cmdHealth(manifestPath);
  } catch (e) {
    await logRun("failed", `verification: ${e.message}`.slice(0, 400));
    die(`upgrade deployed but verification failed: ${e.message}`);
  }

  await d1Query(
    acct.id,
    dbId,
    "UPDATE install_state SET last_upgraded_at = ?, product_version = ? WHERE id = 1",
    [new Date().toISOString(), toVersion]
  ).catch(() => {});
  await logRun("verified", null);
  ok(`upgrade verified, now at ${toVersion}`);
}

async function cmdRollback(manifestPath, bookmarkArg) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  const bookmark = bookmarkArg || process.argv[4];
  if (!bookmark) die("usage: brain rollback <manifest> <bookmark>");

  warn("restoring a D1 bookmark is DESTRUCTIVE: everything written since is lost.");
  info(`database ${dbId}, bookmark ${bookmark}`);
  await cf(`/accounts/${acct.id}/d1/database/${dbId}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`, {
    method: "POST",
  });
  ok("restored");
  // A rolled-back run must never become the baseline for the next upgrade.
  await d1Query(
    acct.id,
    dbId,
    "UPDATE upgrade_runs SET status = 'rolled_back' WHERE id = (SELECT MAX(id) FROM upgrade_runs)"
  ).catch(() => {});
  info("the most recent upgrade run is marked rolled_back so it cannot become the next baseline.");
}

/* ------------------------------------------------------------ acceptance */

async function cmdTest(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const key = resolveAdminKey(manifestPath);
  if (!key) die("no admin key found: not in the environment, and no .brain-admin-key file next to the manifest.");

  let base = m.brain?.domain ? `https://${m.brain.domain}` : null;
  let installState = null;

  // Cloudflare is OPTIONAL here, and that is the whole point.
  //
  // The acceptance suite is the artifact the client runs themselves after we
  // are gone, and the kickoff ends by revoking our token live and re-running
  // it to prove custody. Both are impossible if this command demands a
  // Cloudflare token: the moment the token dies, the proof dies with it.
  //
  // So with a domain in the manifest, tiers 1 through 4 run over plain HTTPS
  // with nothing but the admin key. Cloudflare buys exactly one thing, the
  // install_state row behind tier 5, and its absence degrades that tier to
  // skip rather than failing the run.
  const haveCfToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  if (!base || (haveCfToken && m.infrastructure?.cloudflare?.d1_database_id)) {
    if (!base && !haveCfToken) {
      die(
        "no brain.domain in the manifest and no CLOUDFLARE_API_TOKEN to look one up.\n" +
          "      Add the domain to the manifest so this runs without Cloudflare access:\n" +
          '        "brain": { "domain": "brain.yourcompany.com" }'
      );
    }
    const acct = await resolveAccount(m);
    const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
    if (!base) {
      const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
      if (sub?.subdomain) base = `https://${scriptName}.${sub.subdomain}.workers.dev`;
    }
    const dbId = m.infrastructure?.cloudflare?.d1_database_id;
    if (dbId) {
      const st = await d1Query(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1").catch(
        () => null
      );
      installState = st?.results?.[0] || null;
    }
  }
  if (!base) die("could not determine a URL for this install.");
  if (!haveCfToken) {
    info("no Cloudflare token present, so tier 5 will skip. Tiers 1 to 4 are unaffected.");
  }

  // --report writes the single self-contained HTML artifact instead of
  // printing to the terminal. This is the thing a client actually reads, and
  // the thing they can re-run and re-open after the engagement ends.
  const reportFlag = parseFlags(process.argv.slice(4)).report;
  if (reportFlag) {
    const out =
      typeof reportFlag === "string"
        ? reportFlag
        : `brain-report-${m.client?.slug || "install"}-${new Date().toISOString().slice(0, 10)}.html`;
    const { buildHtmlReport } = await import("./report-html.mjs");
    info(`building report against ${base}`);
    const { html, data } = await buildHtmlReport({
      base,
      adminKey: key,
      manifest: m,
      installState,
    });
    writeFileSync(out, html);
    const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
    ok(`report written to ${out} (${kb} kb, opens offline, no external assets)`);
    const acc = data?.acceptance;
    if (acc?.counts) {
      console.log(
        `  ${acc.counts.pass} passed, ${acc.counts.fail} failed, ${acc.counts.warn} warnings`
      );
    }
    return;
  }

  const { Acceptance } = await import("./acceptance.mjs");
  const suite = new Acceptance({ base, adminKey: key, manifest: m });
  info(`acceptance suite against ${base}`);
  const out = await suite.run({
    probes: m.testing?.probe_questions || [],
    installState,
  });

  let tier = null;
  for (const r of out.results) {
    if (r.tier !== tier) {
      tier = r.tier;
      console.log(`\n  ${c.bold("tier " + tier)}`);
    }
    const mark =
      r.status === "pass"
        ? c.green("pass")
        : r.status === "fail"
          ? c.red("FAIL")
          : r.status === "warn"
            ? c.yellow("warn")
            : c.dim("skip");
    console.log(`    ${mark}  ${r.name}${r.detail ? c.dim("  — " + r.detail) : ""}`);
  }

  const { pass, fail, warn: w, skip } = out.counts;
  console.log(`\n  ${pass} passed, ${fail} failed, ${w} warnings, ${skip} skipped`);
  if (out.stoppedAtTier) {
    console.log(`  ${c.red(`stopped after tier ${out.stoppedAtTier}: later tiers would be noise`)}`);
  }
  if (!out.passed) {
    throw new Fatal("acceptance suite FAILED");
  }
  ok("acceptance suite passed");
}

/* ----------------------------------------------------------- mcp-config */

/**
 * Print the config a client pastes into their own AI tools.
 *
 * This is an hour of work with the best return on the list. The moment a
 * client's own Claude answers a question from their own brain, in their own
 * terminal, is the highest perceived-value second in the whole engagement.
 * Before that it is a system they were shown; after it, it is a thing they own.
 *
 * The admin key is printed here on purpose: it is THEIR key, for THEIR brain,
 * on their machine. Refusing to show it would be security theatre that just
 * makes them go dig it out of a dashboard.
 */
async function cmdMcpConfig(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const key = resolveAdminKey(manifestPath);

  let base = m.brain?.domain ? `https://${m.brain.domain}` : null;
  if (!base) {
    const acct = await resolveAccount(m);
    const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
    const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
    if (sub?.subdomain) base = `https://${scriptName}.${sub.subdomain}.workers.dev`;
  }
  if (!base) die("could not determine a URL for this install.");

  const name = m.client?.slug || "brain";
  const owner = m.client?.display_name || "the owner";
  const serverPath = join(HERE, "components", "brain-mcp.mjs");

  const block = {
    mcpServers: {
      [name]: {
        command: "node",
        args: [serverPath],
        env: {
          BRAIN_URL: base,
          BRAIN_NAME: name,
          BRAIN_KEY: key || "<your admin key>",
        },
      },
    },
  };

  console.log(`\n${c.bold(`Connect ${owner}'s brain to your AI tools`)}\n`);
  console.log(`Your brain lives at ${c.bold(base)}\n`);

  // -e per variable. An env prefix like `BRAIN_KEY=... claude mcp add ...` is
  // silently DISCARDED: the server registers with an empty environment and fails
  // on the first question. Verified against Claude Code 2.1.63 on 2026-08-17.
  console.log(`${c.bold("Claude Code")} — run this once, then it works in every folder:\n`);
  console.log(
    `  claude mcp add --scope user ${name} \\\n` +
      `    -e BRAIN_URL=${base} \\\n` +
      `    -e BRAIN_NAME=${name} \\\n` +
      `    -e BRAIN_KEY=${key || "<your admin key>"} \\\n` +
      `    -- node ${JSON.stringify(serverPath)}\n`
  );
  console.log(`  Confirm the credentials landed: claude mcp get ${name}\n`);

  console.log(`${c.bold("Claude Desktop")} — add this to your config file:\n`);
  console.log(
    JSON.stringify(block, null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  console.log(`\n  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
  console.log(`  Windows: %APPDATA%\\Claude\\claude_desktop_config.json`);
  console.log(`\n  Restart Claude Desktop after saving.\n`);

  // Codex. Verified against `codex mcp add --help` on 2026-08-17: the form is
  // `codex mcp add <NAME> --env K=V -- <COMMAND>...`, and the `--` separator is
  // REQUIRED or the launch command is parsed as codex's own flags.
  console.log(`${c.bold("Codex")} — run this once:\n`);
  console.log(
    `  codex mcp add ${name} \\\n` +
      `    --env BRAIN_URL=${base} \\\n` +
      `    --env BRAIN_NAME=${name} \\\n` +
      `    --env BRAIN_KEY=${key || "<your admin key>"} \\\n` +
      `    -- node ${JSON.stringify(serverPath)}\n`
  );
  console.log(`  Confirm with: codex mcp list\n`);
  console.log(`  Or write it into ~/.codex/config.toml by hand:\n`);
  console.log(
    `  [mcp_servers.${name}]\n` +
      `  command = "node"\n` +
      `  args = [${JSON.stringify(serverPath)}]\n\n` +
      `  [mcp_servers.${name}.env]\n` +
      `  BRAIN_URL = ${JSON.stringify(base)}\n` +
      `  BRAIN_NAME = ${JSON.stringify(name)}\n` +
      `  BRAIN_KEY = ${JSON.stringify(key || "<your admin key>")}\n`
  );

  console.log(`${c.bold("Then try asking it")}:\n`);
  const probes = m.testing?.probe_questions || [];
  if (probes.length) {
    // Their own intake questions, not a generic demo. This is the difference
    // between "impressive technology" and "it knows my business".
    for (const q of probes.slice(0, 3)) console.log(`  "${q}"`);
  } else {
    console.log(`  "what did we decide about ..."`);
    console.log(`  "what is still outstanding from ..."`);
  }
  console.log("");

  if (!key) {
    warn("ADMIN_KEY was not in the environment, so the config above has a placeholder.");
  }
}

/* ----------------------------------------------------------- sources */

/**
 * Named ingest sources.
 *
 * A first import a client cannot roll back is one they will hesitate to
 * authorise at full size, which means the hesitation lands on the import that
 * would prove the most. Naming every ingest and giving it its own undo is what
 * removes that: a bad import becomes one command instead of hand-written SQL
 * against their only copy of their data.
 *
 * The name is the scope key, not a label. Documents from a source carry the
 * source name as their `source_type` in the store, so removal is one equality
 * match rather than a prefix or a LIKE. On the single operation that cannot be
 * undone, the matching rule should be the one with nothing subtle in it.
 */

// Mirrors the CHECK in migration 0003. Validated twice on purpose: the database
// is the guarantee, this is the one that produces a sentence instead of
// "CHECK constraint failed" when someone types a capital letter.
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function assertSourceName(name) {
  if (!name || typeof name !== "string") die("a source name is required.");
  if (name.length > 64) die(`source name "${name}" is longer than 64 characters.`);
  if (!SOURCE_NAME_RE.test(name)) {
    die(
      `"${name}" is not a usable source name.\n` +
        "      Lowercase letters, digits, hyphen and underscore only, starting with a letter\n" +
        "      or digit. The name is used verbatim as the scope key for deletion, so a name\n" +
        "      carrying a quote or a wildcard could reach outside its own scope."
    );
  }
  return name;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Levenshtein distance, so a typo gets a suggestion rather than a shrug. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

async function resolveBase(m, acct) {
  if (m.brain?.domain) return `https://${m.brain.domain}`;
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
  return sub?.subdomain ? `https://${scriptName}.${sub.subdomain}.workers.dev` : null;
}

/**
 * What the document store actually holds, per source.
 *
 * The registry's own document_count is a receipt from the last ingest, not the
 * truth. Reading the store is what turns "the brain has 1,204 documents from
 * this source" from a claim into an observation, and the gap between the two
 * numbers is the cheapest signal available that an ingest died halfway.
 *
 * Returns null rather than throwing: a listing that works without the admin key
 * is more useful than one that refuses to print anything.
 */
async function liveSourceCounts(base, adminKey) {
  if (!base || !adminKey) return null;
  try {
    const res = await http(`${base}/api/admin/brain/documents`, {
      headers: { "X-Admin-Key": adminKey },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const map = new Map();
    for (const r of body.rows || []) map.set(r.source_type, r);
    return map;
  } catch {
    return null;
  }
}

async function readSources(acctId, dbId) {
  const r = await d1Query(acctId, dbId, "SELECT * FROM sources ORDER BY name").catch(() => null);
  if (!r) {
    die(
      "no `sources` table in this install.\n" +
        "      Run `brain migrate <manifest>` to apply migration 0003, then try again."
    );
  }
  return r.results || [];
}

const num = (n) => Number(n || 0).toLocaleString("en-US");

async function cmdSources(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const flags = parseFlags(process.argv.slice(4));

  // Registering by hand exists because the connectors are still being written.
  // When an ingest driver lands it registers its own source on first run and
  // this stays as the escape hatch for a corpus that has no connector.
  if (flags.add) {
    const name = assertSourceName(flags.add === true ? null : flags.add);
    const kind =
      (flags.kind !== true && flags.kind) ||
      Object.keys(m.corpora || {}).find((k) => k.replace(/_/g, "-") === name) ||
      "upload";
    const now = new Date().toISOString();
    const res = await d1Query(
      acct.id,
      dbId,
      "INSERT INTO sources (name, kind, status, created_at) VALUES (?,?,'pending',?) ON CONFLICT(name) DO NOTHING",
      [name, String(kind), now]
    );
    if (res?.meta?.changes) {
      await d1Query(
        acct.id,
        dbId,
        "INSERT INTO source_events (source_name, event, at, detail) VALUES (?,'registered',?,?)",
        [name, now, `kind=${kind}`]
      );
      ok(`registered source "${name}" (kind ${kind})`);
    } else {
      info(`source "${name}" is already registered, leaving it alone`);
    }
  }

  const rows = await readSources(acct.id, dbId);
  const base = await resolveBase(m, acct);
  const live = await liveSourceCounts(base, resolveAdminKey(manifestPath));

  if (!rows.length) {
    warn("no named sources registered in this install.");
    info(`register one with: brain sources ${manifestPath} --add <name> --kind <drive|gmail|calendar|upload>`);
  } else {
    const w = (key, min) => Math.max(min, ...rows.map((r) => String(r[key] || "").length));
    const wName = w("name", 4);
    const wKind = w("kind", 4);
    const wStat = w("status", 6);
    console.log(
      `\n  ${"name".padEnd(wName)}  ${"kind".padEnd(wKind)}  ${"status".padEnd(wStat)}  ${"documents".padStart(11)}  last ingest`
    );
    for (const r of rows) {
      // Compare DOCUMENTS to documents. The store also reports a chunk count,
      // which is always larger, and comparing against that showed drift on every
      // healthy install.
      const liveRow = live?.get(r.name);
      const shown = liveRow?.documents ?? liveRow?.total;
      const drift =
        shown !== undefined && Number(shown) !== Number(r.document_count)
          ? c.yellow(`  (store says ${num(shown)})`)
          : "";
      const chunks = liveRow?.chunks !== undefined ? c.dim(`  ${num(liveRow.chunks)} chunks`) : "";
      console.log(
        `  ${r.name.padEnd(wName)}  ${String(r.kind).padEnd(wKind)}  ${String(r.status).padEnd(wStat)}  ${num(r.document_count).padStart(11)}  ${r.last_ingest_at ? r.last_ingest_at.slice(0, 19) : c.dim("never")}${drift}${chunks}`
      );
    }
  }

  if (!live) {
    console.log(
      `\n  ${c.dim("counts above are the registry's own last receipt. Set ADMIN_KEY in the")}`
    );
    console.log(`  ${c.dim("environment to cross-check them against what the brain actually holds.")}`);
  } else {
    // Everything ingested before this feature existed, or by a path that never
    // registered itself, lands here. It is the honest version of the listing:
    // these documents exist, and `brain forget` cannot take them back out.
    const orphans = [...live.entries()].filter(([k]) => !rows.some((r) => r.name === k));
    if (orphans.length) {
      console.log(`\n  ${c.yellow("in the store but not registered")}, so \`brain forget\` cannot remove them:`);
      for (const [k, v] of orphans) console.log(`    ${k.padEnd(16)} ${num(v.total).padStart(9)} documents`);
    }
  }

  const events = await d1Query(
    acct.id,
    dbId,
    "SELECT source_name, event, at, documents FROM source_events ORDER BY at DESC LIMIT 5"
  ).catch(() => null);
  const evs = events?.results || [];
  if (evs.length) {
    console.log("\n  recent source events:");
    for (const e of evs) {
      const n = e.documents === null || e.documents === undefined ? "" : `  ${num(e.documents)} documents`;
      const mark = e.event === "forget" ? c.yellow("forget") : e.event;
      console.log(`    ${e.at.slice(0, 19)}  ${String(mark).padEnd(18)} ${e.source_name}${n}`);
    }
  }
  console.log("");
}

/**
 * Remove every document belonging to one named source.
 *
 * Two channels, deliberately in this order.
 *
 * The worker route is the correct one: the client's worker already holds the
 * service-role credential, so the deletion happens where the data lives and the
 * CLI never needs a second god-mode key. The direct PostgREST path is the
 * fallback for installs whose worker predates that route.
 *
 * If NEITHER channel is available this refuses and changes nothing. Deleting
 * the registry row on its own would be worse than doing nothing: the documents
 * would survive, unreachable by name, and the next `brain sources` would report
 * them as unregistered with no way left to remove them. A rollback that half
 * works is the specific failure this whole feature exists to prevent.
 */
async function purgeDocuments(base, adminKey, name) {
  const warnings = [];

  if (!base || !adminKey) {
    warnings.push(
      "the worker could not be addressed (no URL or no ADMIN_KEY), so the store was edited directly"
    );
  } else {
    const res = await http(`${base}/api/admin/brain/forget`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      // confirm:true is REQUIRED. The route dry-runs by default, so omitting it
      // returns a perfectly well-formed receipt having deleted nothing, which is
      // exactly the "reported success, removed nothing" failure this function
      // spends fifty lines guarding against everywhere else.
      body: JSON.stringify({ source: name, confirm: true }),
    }).catch((e) => ({ ok: false, status: 0, netError: e.message }));

    if (res.ok) {
      // A 200 is NOT proof of removal. Cloudflare Access interstitials, SSO
      // login pages and misrouted requests all answer 200 with HTML, and the
      // previous version parsed that into {} and reported a successful purge.
      // Only a well-formed receipt naming how many rows went counts as done.
      const raw = await res.text().catch(() => "");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      // The D1 route reports `documents`; the older Supabase-era route reported
      // `removed`. Accept either, but never invent one.
      const removed =
        body && typeof body.documents === "number"
          ? body.documents
          : body && typeof body.removed === "number"
            ? body.removed
            : null;
      // A route that dry-ran deleted nothing, whatever else it said.
      if (body && body.dry_run === true) {
        die(
          "the worker ran a DRY RUN and removed nothing. This build of brain.mjs is older than\n" +
            "      the worker it is talking to. Update it, or remove by hand with:\n" +
            `        curl -X POST "$BRAIN/api/admin/brain/forget" -H "X-Admin-Key: $ADMIN_KEY" \\\n` +
            `          -H 'content-type: application/json' -d '{"source":"${name}","confirm":true}'`
        );
      }
      if (removed === null) {
        const looksLikeHtml = /^\s*</.test(raw);
        die(
          `the worker returned 200 but not a removal receipt, so nothing is confirmed removed.\n` +
            (looksLikeHtml
              ? "      The response is HTML, which usually means an Access or SSO interstitial\n" +
                "      answered instead of the worker. Check that the route is not behind Access.\n"
              : `      Expected JSON with a numeric "removed". Got: ${raw.slice(0, 120)}\n`) +
            "      The source has been left registered so it can be removed once this is fixed."
        );
      }
      return { channel: "worker route", removed, warnings };
    }
    // 404/405 means this worker has no such route, which is expected on an
    // older install and is the one case worth falling through on. Anything
    // else is a real failure and must not be downgraded into a weaker path:
    // a 500 from the worker says the removal was attempted and went wrong,
    // and retrying it through a different door is how you delete twice.
    if (res.status && res.status !== 404 && res.status !== 405) {
      const detail = await res.text().catch(() => "");
      die(
        `the worker's forget route returned ${res.status}: ${String(detail).slice(0, 200)}\n` +
          "      Nothing was removed."
      );
    }
    warnings.push(
      res.netError
        ? `the worker at ${base} could not be reached (${res.netError}), so the store was edited directly`
        : "this worker has no /api/admin/brain/forget route, so the store was edited directly"
    );
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    die(
      `no way to reach the document store, so nothing was removed.\n` +
        `      Either deploy a worker that serves POST /api/admin/brain/forget, or export the\n` +
        `      store credentials for a one-off direct removal:\n` +
        `        export SUPABASE_URL='...'\n` +
        `        export SUPABASE_SERVICE_ROLE_KEY='...'\n` +
        `      The registry row was left in place on purpose: removing it while the documents\n` +
        `      survive would leave them in the brain with no name left to remove them by.`
    );
  }

  const root = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const filter = `source_type=eq.${encodeURIComponent(name)}`;

  const countRows = async (profile) => {
    const res = await http(`${root}/rest/v1/${profile.table}?${filter}&select=source_type&limit=1`, {
      headers: { ...headers, Prefer: "count=exact", ...(profile.schema ? { "Accept-Profile": profile.schema } : {}) },
    });
    if (!res.ok) return null;
    const range = res.headers.get("content-range") || "";
    const n = Number(range.split("/")[1]);
    return Number.isFinite(n) ? n : null;
  };

  const del = async (profile) => {
    const res = await http(`${root}/rest/v1/${profile.table}?${filter}`, {
      method: "DELETE",
      headers: {
        ...headers,
        Prefer: "return=minimal",
        ...(profile.schema ? { "Content-Profile": profile.schema } : {}),
      },
    });
    return res;
  };

  // The searchable mirror. This is the one that decides whether the source is
  // still findable, so it is the one that must succeed.
  const before = await countRows({ table: "notes_rag_documents" });
  const res = await del({ table: "notes_rag_documents" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`the store refused the removal (${res.status}): ${body.slice(0, 200)}\n      Nothing was removed.`);
  }

  // Verify rather than assume. A DELETE that reports success and leaves rows
  // behind is exactly the shape of failure a rollback promise cannot survive,
  // and the check costs one request.
  const after = await countRows({ table: "notes_rag_documents" });
  if (after !== null && after > 0) {
    die(
      `removal reported success but ${num(after)} document(s) for "${name}" are still in the store.\n` +
        "      Do not treat this source as removed."
    );
  }

  // The canonical table lives in the `brain` schema, which PostgREST only
  // exposes if the client's project was configured to. When it is not, say so
  // and hand over the exact statement rather than reporting a clean removal
  // that left the source's spine in place.
  const canonical = await del({ table: "documents", schema: "brain" });
  if (!canonical.ok) {
    warnings.push(
      `the canonical rows in brain.documents were NOT removed (PostgREST returned ${canonical.status} for the brain schema).\n` +
        `        The source is gone from retrieval, but finish the job in the SQL editor:\n` +
        `          DELETE FROM brain.documents WHERE source_type = '${name}';`
    );
  }

  return { channel: "direct store access", removed: before, warnings };
}

async function cmdForget(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  if (!flags.source || flags.source === true) {
    die("usage: brain forget <manifest> --source <name> [--yes]");
  }
  const name = assertSourceName(flags.source);

  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const rows = await readSources(acct.id, dbId);
  const row = rows.find((r) => r.name === name);

  // A typo must never look like a success. Silently reporting "removed" for a
  // source that was never there teaches the client that forget works, right up
  // until the day they check and the documents are all still present.
  if (!row) {
    const names = rows.map((r) => r.name);
    const near = names
      .map((n) => [n, editDistance(n, name)])
      .filter(([, d]) => d <= 3)
      .sort((a, b) => a[1] - b[1])[0];
    die(
      `no source named "${name}" in this install.\n` +
        (names.length
          ? `      registered: ${names.join(", ")}\n`
          : "      no sources are registered at all.\n") +
        (near ? `      did you mean "${near[0]}"?\n` : "") +
        "      Nothing was removed."
    );
  }

  const base = await resolveBase(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  const live = await liveSourceCounts(base, adminKey);
  const liveCount = live?.get(name)?.total;

  // Print the damage BEFORE anything happens, every time, --yes or not.
  console.log(`\n  ${c.bold(`forget "${name}"`)} from ${m.client?.display_name || m.client?.slug || "this install"}\n`);
  console.log("  this removes:");
  if (liveCount !== undefined) {
    console.log(`    ${num(liveCount).padStart(9)}  documents in the brain (source_type = "${name}")`);
  } else {
    console.log(`    ${num(row.document_count).padStart(9)}  documents, per the registry's last receipt`);
    console.log(`    ${c.dim("           the live count could not be read, so this number may be stale")}`);
  }
  console.log(`    ${"1".padStart(9)}  registry row in sources`);
  if (row.sync_cursor) {
    console.log(`    ${"1".padStart(9)}  sync cursor (a later ingest of "${name}" starts from the beginning)`);
  }
  console.log(`\n  kind ${row.kind}, status ${row.status}, registered ${String(row.created_at).slice(0, 19)}`);
  if (row.scope) console.log(`  scope ${String(row.scope).slice(0, 160)}`);
  if (row.status === "indexing") {
    warn(
      `"${name}" is mid-ingest. Stop the ingest first, or it will keep writing\n` +
        "        documents back in under the same name after this finishes."
    );
  }

  if (!flags.yes) {
    console.log(`\n  ${c.bold("Nothing has been removed.")} Re-run with --yes to actually do it:\n`);
    console.log(`    node brain.mjs forget ${manifestPath} --source ${name} --yes\n`);
    return;
  }

  console.log("");
  const out = await purgeDocuments(base, adminKey, name);

  // Never substitute an expectation for an observation.
  //
  // This previously fell back to the count we HOPED to remove when the channel
  // could not confirm one, so an unconfirmed purge printed "removed 412
  // documents" having removed nothing. The number a destructive command reports
  // must be something it watched happen.
  if (out.removed === null || out.removed === undefined) {
    die(
      `the removal channel (${out.channel}) did not report how many documents went,\n` +
        "      so this cannot be called done. The registry row was left in place,\n" +
        `      so "${name}" is still addressable and you can retry once the channel\n` +
        "      reports a count."
    );
  }
  const removed = out.removed;
  ok(`removed ${num(removed)} document(s) via ${out.channel}`);

  // Confirm against the live brain before freeing the name. Freeing it while
  // documents survive is the one outcome with no recovery: they stay in the
  // index with no name left to address them by, which is precisely what this
  // feature exists to prevent.
  const post = await liveSourceCounts(base, adminKey);
  const stillThere = post?.get(name)?.total;
  if (stillThere) {
    die(
      `${num(stillThere)} document(s) for "${name}" are STILL in the brain after the purge.\n` +
        "      The registry row was left in place. Do not treat this source as removed."
    );
  }
  if (post === null || post === undefined) {
    warn(
      "the live count could not be re-read, so removal is reported but not independently\n" +
        "        confirmed. Run `brain sources` once the worker is reachable."
    );
  }

  // The event is written BEFORE the registry row is deleted, so a failure
  // between the two leaves the source visible and retryable rather than
  // silently gone. Same reason upgrade_runs records the failures.
  await d1Query(
    acct.id,
    dbId,
    "INSERT INTO source_events (source_name, event, at, documents, detail) VALUES (?,'forget',?,?,?)",
    [name, new Date().toISOString(), removed, `channel=${out.channel}`]
  ).catch(() => {});

  await d1Query(acct.id, dbId, "DELETE FROM sources WHERE name = ?", [name]);
  ok(`registry row for "${name}" removed, the name is free to reuse`);

  for (const wmsg of out.warnings) warn(wmsg);
  console.log("");
}


/**
 * brain ingest — load a folder into the brain.
 *
 * The command the product did not have. Everything before it could stand up an
 * empty brain and prove it was healthy.
 *
 * Resumable by design: state is keyed by content hash and written after every
 * batch, so re-running is how a large import finishes rather than a recovery
 * step. Nothing is ever skipped silently; the run ends with a breakdown by
 * reason, and those reasons are kept in the state file.
 */
async function cmdIngest(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  // Remote sources reuse everything below the envelope: splitting, batching,
  // the credential gate, resume state and the skip report. Only the producer
  // differs.
  if (flags.from) return cmdIngestRemote(m, manifestPath, flags);

  const root = flags.path;
  if (!root) {
    die(
      "brain ingest needs --path <folder>.\n" +
        "  Optional: --source <name> (default \"upload\"), --limit <n>, --dry-run,\n" +
        "            --reset to ignore previous progress and re-send everything."
    );
  }
  if (!existsSync(root)) die(`no such folder: ${root}`);
  const { walk, prepare, batchStream, loadState, saveState } = await ingestLib();

  const sourceName = assertSourceName(flags.source === true ? null : flags.source || "upload");
  // A dry run sends nothing, so it must not demand credentials it will never
  // use. Requiring a Cloudflare token to preview what WOULD be loaded turns the
  // safest command in the tool into one of the hardest to reach.
  const dry = !!flags["dry-run"];
  const acct = dry ? null : await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  const base = dry ? null : await resolveBaseUrl(m, acct);
  const adminKey = dry ? null : resolveAdminKey(manifestPath);
  if (!adminKey && !flags["dry-run"]) {
    die("no admin key found: not in the environment, and no .brain-admin-key file next to the manifest. Export ADMIN_KEY or re-run `brain setup`.");
  }

  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);
  const state = flags.reset ? { version: 1, done: {}, skipped: {} } : loadState(statePath);
  const alreadyDone = Object.keys(state.done).length;
  if (alreadyDone && !flags.reset) info(`resuming: ${alreadyDone} file(s) already loaded`);

  const privatePrefixes = m.safety?.private_path_prefixes || [];
  info(`walking ${root}`);
  const { files, skipped: walkSkips } = walk(root, { privatePrefixes });
  info(`${files.length} candidate file(s), ${walkSkips.length} skipped during the walk`);
  if (privatePrefixes.length) {
    info(`private prefixes enforced: ${privatePrefixes.join(", ")}`);
  }

  const limited = flags.limit ? files.slice(0, parseInt(flags.limit, 10)) : files;
  if (flags.limit) warn(`--limit ${flags.limit}: only the first ${limited.length} file(s) will be considered`);

  const skips = [...walkSkips];
  const notes = [];
  let unchanged = 0;
  let split = 0;
  let scanned = 0;

  // One file at a time, sent as each batch fills. Building the whole corpus
  // first cost 584MB of live strings for 250 files, so a real folder OOMs with
  // a raw V8 abort no handler can catch, and an interrupt during that silent
  // phase threw away every minute of extraction. Peak memory here is one batch.
  const prepareOne = async (f) => {
    const r = await prepare(f, { sourceName });
    if (r.note) notes.push({ path: f.rel, note: r.note });
    const key = r.envelope ? r.envelope.source_id : f.rel;
    if (r.hash && state.done[key] === r.hash) {
      unchanged++;
      return { unchanged: true };
    }
    if (r.skip) {
      state.skipped[r.skip.path] = r.skip.reason;
      return { skip: r.skip };
    }
    return { hash: r.hash, envelope: r.envelope, rel: f.rel };
  };

  if (flags["dry-run"]) {
    // A dry run streams too, so it exercises the same code path rather than a
    // parallel one that could quietly diverge.
    const preview = [];
    for await (const group of batchStream(limited, prepareOne, {
      onSkip: (sk) => skips.push(sk),
      onProgress: (n) => { if (n % 250 === 0) process.stdout.write(`\r  scanned ${n}/${limited.length}...   `); },
    })) {
      for (const item of group) if (preview.length < 5) preview.push(item);
      scanned += group.length;
    }
    process.stdout.write("\r");
    info(`${scanned} document(s) would be sent; ${unchanged} unchanged; ${skips.length} skipped`);
    reportNotes(notes);
    console.log("");
    ok("dry run, nothing was sent");
    await reportSkips(skips);
    if (preview.length) {
      console.log(`\n  first few that WOULD be sent:`);
      for (const r of preview) {
        const d = r.envelope.occurred_at ? r.envelope.occurred_at.slice(0, 10) : "no date";
        console.log(`    ${r.rel}  (${d}, ${r.envelope.content.length} chars)`);
      }
    }
    return;
  }

  if (dbId) await recordSourceStart(acct.id, dbId, sourceName, "upload");

  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  let batchNo = 0;
  for await (const group of batchStream(limited, prepareOne, {
    onSkip: (sk) => skips.push(sk),
    onProgress: (n) => {
      if (n % 100 === 0) process.stdout.write(`\r  scanned ${n}/${limited.length}, sent ${tally.created + tally.updated}   `);
    },
  })) {
    batchNo++;
    const t = await sendBatches({ base, adminKey, groups: [group], state, statePath, skips, quiet: true });
    for (const k of Object.keys(tally)) tally[k] += t[k] || 0;
    process.stdout.write(`\r  batch ${batchNo}  loaded ${tally.created + tally.updated}  refused ${tally.refused}  failed ${tally.failed}   `);
  }
  process.stdout.write("\n");
  reportNotes(notes);

  if (dbId) {
    await recordSourceFinish(acct.id, dbId, sourceName, {
      documents: Object.keys(state.done).length,
      added: tally.created + tally.updated,
      skipped: skips.length,
      failed: tally.failed,
    });
  }

  ok(`${tally.created} created, ${tally.updated} updated, ${unchanged + tally.unchanged} unchanged`);
  if (tally.refused) warn(`${tally.refused} file(s) refused for carrying live credentials. They were NOT indexed.`);
  if (tally.failed) warn(`${tally.failed} file(s) failed. Re-running will retry them.`);
  await reportSkips(skips);

  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  info("the vector index trails the text by a few minutes; check with `brain health`");
}


/** Mark a source as being loaded. Registers it on first run. */
async function recordSourceStart(acctId, dbId, name, kind) {
  const now = new Date().toISOString();
  await d1Query(
    acctId, dbId,
    "INSERT INTO sources (name, kind, status, created_at) VALUES (?,?,'indexing',?) " +
      "ON CONFLICT(name) DO UPDATE SET status='indexing'",
    [name, kind, now]
  ).catch(() => {});
}

/**
 * Close out a load.
 *
 * `document_count` is written as a RECEIPT, not as the authority — the store is
 * the authority, and `brain sources` prints both so drift is visible instead of
 * being quietly believed.
 */
async function recordSourceFinish(acctId, dbId, name, { documents, added, skipped, failed }) {
  const now = new Date().toISOString();
  await d1Query(
    acctId, dbId,
    "UPDATE sources SET status=?, last_ingest_at=?, document_count=? WHERE name=?",
    [failed ? "error" : "ready", now, documents, name]
  ).catch(() => {});
  await d1Query(
    acctId, dbId,
    "INSERT INTO source_events (source_name, event, at, documents, detail) VALUES (?,'ingest',?,?,?)",
    [name, now, added, `skipped=${skipped} failed=${failed}`]
  ).catch(() => {});
}


/**
 * Ingest from a connected remote source.
 *
 * Deliberately shares sendBatches() with the local walker, so a Drive document
 * and a folder document are refused, split, batched and reported by identical
 * code. The producers differ; the pipeline does not.
 */
async function cmdIngestRemote(m, manifestPath, flags) {
  const which = String(flags.from).toLowerCase();
  if (!["drive", "gmail"].includes(which)) {
    die(`--from ${which} is not a source. Available: drive, gmail.`);
  }

  const sourceName = flags.source === true || !flags.source ? which : flags.source;
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey && !flags["dry-run"]) die("no admin key found: not in the environment, and no .brain-admin-key file next to the manifest.");

  const { batches, splitOversized, loadState, saveState } = await ingestLib();
  const getToken = googleAuth(which === "gmail" ? "gmail" : "drive");
  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);
  const state = flags.reset ? { version: 1, done: {}, skipped: {} } : loadState(statePath);
  const limit = flags.limit ? parseInt(flags.limit, 10) : Infinity;

  const ready = [];
  const skips = [];
  let unchanged = 0;
  let scanned = 0;
  // Held back until every batch has been accepted. See the note at its
  // assignment: advancing a sync cursor early loses documents silently.
  let pendingCursor = null;

  if (which === "drive") {
    const drive = await import("./connectors/google-drive.mjs");
    // Taken BEFORE the walk. Taken after, anything changed during the walk
    // would be missed forever, because the next run starts from a token that
    // already claims to include it.
    let nextSync = null;
    try {
      nextSync = await drive.startPageToken(getToken);
    } catch (e) {
      warn(`could not get a change token, so the next run will be a full walk: ${e.message.slice(0, 100)}`);
    }

    const incremental = !flags.reset && state.sync_token;
    let files = [];
    if (incremental) {
      info("incremental sync from the saved change token");
      const ch = await drive.listChanges(getToken, state.sync_token);
      files = ch.changed;
      nextSync = ch.nextToken || nextSync;
      // Deletions are APPLIED, not merely recorded. A brain that keeps
      // answering from a document the client deleted in Drive is worse than one
      // that never had it: they believe it is gone.
      if (ch.removed.length) {
        const uids = ch.removed.map((id) => `drive:${id}`);
        if (flags["dry-run"]) {
          warn(`${uids.length} file(s) were deleted or trashed in Drive and WOULD be removed from the brain`);
        } else {
          const res = await http(`${base}/api/admin/brain/forget`, {
            method: "POST",
            headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
            body: JSON.stringify({ doc_uids: uids, confirm: true }),
          });
          const out = await res.json().catch(() => ({}));
          if (!res.ok || out.dry_run) {
            // Left in the state file so the next run retries rather than losing
            // the fact that these should be gone.
            state.removed = { ...(state.removed || {}), ...Object.fromEntries(uids.map((u) => [u, new Date().toISOString()])) };
            warn(`${uids.length} Drive deletion(s) could NOT be applied (${res.status}). They are recorded in ${relative(process.cwd(), statePath)} and will be retried.`);
          } else {
            for (const u of uids) delete state.done[u];
            if (state.removed) for (const u of uids) delete state.removed[u];
            ok(`${out.documents || 0} document(s) removed to match Drive deletions`);
          }
        }
      }
      // Anything recorded as pending on an earlier run gets retried here.
      const pending = Object.keys(state.removed || {});
      if (pending.length && !flags["dry-run"]) {
        const res = await http(`${base}/api/admin/brain/forget`, {
          method: "POST",
          headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
          body: JSON.stringify({ doc_uids: pending, confirm: true }),
        });
        if (res.ok) {
          const out = await res.json().catch(() => ({}));
          if (!out.dry_run) {
            for (const u of pending) { delete state.removed[u]; delete state.done[u]; }
            ok(`${out.documents || 0} previously-pending deletion(s) applied`);
          }
        }
      }
    } else {
      info("full walk of Drive");
      for await (const f of drive.listFiles(getToken)) {
        files.push(f);
        if (files.length >= limit) break;
      }
    }

    for (const f of files.slice(0, limit)) {
      scanned++;
      const key = `drive:${f.id}`;
      const r = await drive.toEnvelope(getToken, f, { sourceName });
      if (!r) continue;
      if (r.skip) { skips.push(r.skip); state.skipped[key] = r.skip.reason; continue; }
      if (state.done[key] === r.version) { unchanged++; continue; }
      for (const envelope of splitOversized(r.envelope)) ready.push({ hash: r.version, envelope, rel: f.name });
      if (scanned % 200 === 0) process.stdout.write(`\r  scanned ${scanned}...   `);
    }
    // NOT saved yet. Advancing the cursor before the batches it covers have
    // been accepted means a mid-send failure permanently skips those documents:
    // the next run starts after them and no error is ever raised. It is written
    // only once every batch has landed.
    pendingCursor = { key: "sync_token", value: nextSync };
  } else {
    const gmail = await import("./connectors/gmail.mjs");
    let nextHistory = null;
    try {
      nextHistory = await gmail.currentHistoryId(getToken);
    } catch { /* a full list still works without it */ }

    let ids = [];
    if (!flags.reset && state.history_id) {
      const h = await gmail.listHistory(getToken, state.history_id);
      if (h.expired) {
        warn("the saved Gmail history id is too old to answer from, so this is a full pass");
        for await (const id of gmail.listMessages(getToken, { max: limit })) ids.push(id);
      } else {
        info(`incremental: ${h.ids.length} new message(s)`);
        ids = h.ids;
      }
    } else {
      for await (const id of gmail.listMessages(getToken, { max: limit })) ids.push(id);
    }

    for (const id of ids.slice(0, limit)) {
      scanned++;
      const key = `gmail:${id}`;
      if (state.done[key]) { unchanged++; continue; }
      const r = await gmail.toEnvelope(getToken, id, { sourceName });
      if (r.skip) { skips.push(r.skip); state.skipped[key] = r.skip.reason; continue; }
      for (const envelope of splitOversized(r.envelope)) ready.push({ hash: r.version, envelope, rel: id });
      if (scanned % 200 === 0) process.stdout.write(`\r  fetched ${scanned}...   `);
    }
    pendingCursor = { key: "history_id", value: nextHistory || state.history_id };
  }
  process.stdout.write("\r");

  const groups = batches(ready);
  info(`${scanned} scanned; ${ready.length} document(s) to send in ${groups.length} batch(es); ${unchanged} unchanged; ${skips.length} skipped`);

  if (flags["dry-run"]) {
    ok("dry run, nothing was sent");
    await reportSkips(skips);
    return;
  }

  if (dbId) await recordSourceStart(acct.id, dbId, sourceName, which);
  const tally = await sendBatches({ base, adminKey, groups, state, statePath, skips });

  // Every batch landed, so it is now safe to say "we have everything up to
  // here". sendBatches dies rather than returning on a failure, so reaching
  // this line is the proof.
  if (pendingCursor) {
    state[pendingCursor.key] = pendingCursor.value;
    saveState(statePath, state);
  }
  if (dbId) {
    await recordSourceFinish(acct.id, dbId, sourceName, {
      documents: Object.keys(state.done).length,
      added: tally.created + tally.updated,
      skipped: skips.length,
      failed: tally.failed,
    });
  }

  ok(`${tally.created} created, ${tally.updated} updated, ${unchanged + tally.unchanged} unchanged`);
  if (tally.refused) warn(`${tally.refused} document(s) refused for carrying live credentials.`);
  if (tally.failed) warn(`${tally.failed} failed. Re-running will retry them.`);
  await reportSkips(skips);
  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  info("the vector index trails the text by a few minutes; check with `brain health`");
}

/** POST every batch, recording progress after each so a stop is resumable. */
async function sendBatches({ base, adminKey, groups, state, statePath, skips, quiet = false }) {
  // Loaded here rather than closed over: sendBatches is top-level and shared by
  // both ingest paths, so it cannot rely on a caller's destructured import.
  const { saveState } = await ingestLib();
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  let n = 0;
  for (const group of groups) {
    n++;
    const res = await http(`${base}/api/admin/brain/ingest/batch`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ docs: group.map((g) => g.envelope) }),
    // A batch is up to 50 documents to chunk, hash and queue, so it is allowed
    // materially longer than a health probe before it is called dead.
    }, { timeoutMs: 180_000, what: "the ingest batch" });
    // A 200 is NOT proof anything was ingested. Cloudflare Access pages, SSO
    // interstitials and misrouted requests all answer 200 with HTML, and
    // parsing that into {} produced a green "ok  0 created" with exit 0. A load
    // that silently did nothing, reported as success, is the worst outcome this
    // command has, so a real receipt is required before anything is believed.
    const raw = await res.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch { /* handled immediately below */ }

    if (!res.ok) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} failed with ${res.status}: ${raw.slice(0, 200)}\n` +
          "      Progress was saved. Fix the cause and re-run the same command to continue."
      );
    }
    if (!body || !Array.isArray(body.results)) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} returned ${res.status} but not an ingest receipt, so nothing is confirmed loaded.\n` +
          (/^\s*</.test(raw)
            ? "      The response is HTML, which usually means an Access or SSO page answered\n" +
              "      instead of the brain. Check that the worker route is not behind Access.\n"
            : `      Expected JSON with a results array. Got: ${raw.slice(0, 120)}\n`) +
          "      Nothing was marked as loaded."
      );
    }
    for (const k of Object.keys(tally)) tally[k] += body[k] || 0;
    for (const r of body.results || []) {
      const item = group.find((g) => g.envelope.source_id === r.source_id);
      if (!item) continue;
      const base_id = item.envelope.metadata?.part_of || r.source_id;
      if (["created", "updated", "unchanged"].includes(r.status)) state.done[base_id] = item.hash;
      else {
        const reason = r.status === "refused" ? `refused: carries ${(r.labels || []).join(", ")}` : `failed: ${r.error || "unknown"}`;
        state.skipped[r.source_id] = reason;
        skips.push({ path: r.source_id, reason });
      }
    }
    saveState(statePath, state);
    if (!quiet) {
      process.stdout.write(`\r  batch ${n}/${groups.length}  loaded ${tally.created + tally.updated}  refused ${tally.refused}  failed ${tally.failed}   `);
    }
  }
  if (!quiet) process.stdout.write("\n");
  return tally;
}

/** Caveats worth seeing: the file IS indexed, it is just thinner than it looks. */
function reportNotes(notes) {
  if (!notes.length) return;
  const byNote = new Map();
  for (const n of notes) byNote.set(n.note, (byNote.get(n.note) || 0) + 1);
  for (const [note, count] of byNote) warn(`${count} file(s) indexed with a caveat: ${note}`);
}

/** Group skips by reason. A flat list of 40,000 lines tells a client nothing. */
async function reportSkips(skips) {
  if (!skips.length) return;
  const byReason = new Map();
  for (const s of skips) {
    // Collapse the variable part so counts aggregate meaningfully.
    const key = String(s.reason).replace(/\d+(\.\d+)?/g, "N");
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(s.path);
  }
  console.log(`\n  ${skips.length} file(s) not indexed:`);
  for (const [reason, paths] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${String(paths.length).padStart(6)}  ${reason}`);
    for (const p of paths.slice(0, 2)) console.log(`            e.g. ${p}`);
  }
  try {
    const { supported } = await import("./ingest/extract.mjs");
    console.log(`\n  Supported today: ${supported().join(" ")}`);
  } catch { /* purely informational */ }
}

/** The install's URL, from the manifest or the workers.dev subdomain. */
async function resolveBaseUrl(m, acct) {
  if (m.brain?.domain) return `https://${m.brain.domain}`;
  acct = acct || (await resolveAccount(m));
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) die("could not determine the brain's URL. Set brain.domain in the manifest.");
  return `https://${scriptName}.${sub.subdomain}.workers.dev`;
}


/**
 * brain connect google — the client authorises their OWN Google account.
 *
 * They register the OAuth client in their own Google Cloud project, and the
 * refresh token is written to their machine. We never see any of it. That is
 * not only a custody preference: every Drive and Gmail read scope is RESTRICTED,
 * so one vendor-owned OAuth client serving many customers would require Google
 * verification plus a paid annual CASA security assessment.
 */
async function cmdConnect(target) {
  const flags = parseFlags(process.argv.slice(3));
  const which = (target || "").toLowerCase();
  if (which !== "google") {
    die("only `brain connect google` exists today.\n  Usage: brain connect google --scopes drive,gmail,calendar");
  }

  const names = String(flags.scopes === true || !flags.scopes ? "drive" : flags.scopes).split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = names.filter((n) => !SCOPES[n]);
  if (unknown.length) die(`unknown scope(s): ${unknown.join(", ")}. Choose from: ${Object.keys(SCOPES).join(", ")}`);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) {
    die(
      "GOOGLE_CLIENT_ID is not set.\n\n" +
        "  You create this in YOUR OWN Google Cloud account, and it never leaves your machine:\n" +
        "    1. console.cloud.google.com, create a project\n" +
        "    2. Enable the APIs you want: Google Drive API, Gmail API, Google Calendar API\n" +
        "    3. OAuth consent screen. On Google Workspace choose INTERNAL. On a personal\n" +
        "       gmail.com account choose External and then click PUBLISH APP, because an\n" +
        "       app left in Testing is issued refresh tokens that expire after 7 DAYS.\n" +
        "    4. Credentials, Create credentials, OAuth client ID, type Desktop app\n" +
        `    5. Add the redirect URI: http://127.0.0.1:${flags.port || DEFAULT_PORT}\n\n` +
        "  Then:\n" +
        "    export GOOGLE_CLIENT_ID='...'\n" +
        "    export GOOGLE_CLIENT_SECRET='...'\n" +
        "    node brain.mjs connect google --scopes drive,gmail"
    );
  }

  const port = flags.port ? parseInt(flags.port, 10) : DEFAULT_PORT;
  info(`requesting: ${names.join(", ")}`);
  const tokens = await authorize({
    clientId,
    clientSecret,
    scopes: names.map((n) => SCOPES[n]),
    port,
  });

  const store = loadTokens();
  store.google = {
    client_id: clientId,
    client_secret: clientSecret || null,
    refresh_token: tokens.refresh_token,
    scopes: names,
    connected_at: new Date().toISOString(),
  };
  saveTokens(store);
  ok(`connected. Token stored at ${tokenPath()} (mode 0600, on this machine only)`);
  info(`now run: brain ingest <manifest> --from ${names[0]}`);
}

/** The token provider for a stored Google connection, or a clear refusal. */
function googleAuth(needed) {
  const store = loadTokens().google;
  if (!store?.refresh_token) {
    die("no Google connection on this machine. Run `brain connect google --scopes drive,gmail` first.");
  }
  if (needed && !store.scopes?.includes(needed)) {
    die(
      `the stored Google connection does not include the "${needed}" scope (it has: ${(store.scopes || []).join(", ")}).\n` +
        `  Reconnect with: brain connect google --scopes ${[...new Set([...(store.scopes || []), needed])].join(",")}`
    );
  }
  return createTokenProvider({
    clientId: store.client_id,
    clientSecret: store.client_secret,
    refreshToken: store.refresh_token,
  });
}


/**
 * brain doctor — everything that must be true before an install, checked up front.
 *
 * Non-destructive: it creates nothing. Its whole value is finding in advance the
 * problems that otherwise appear live, in front of a client, in the first ten
 * minutes of a session.
 */
async function cmdDoctor(manifestPath) {
  let accountId;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      accountId = loadManifest(manifestPath).m?.infrastructure?.cloudflare?.account_id;
    } catch { /* doctor must work without a valid manifest */ }
  }

  console.log(`\n  ${c.bold("brain doctor")}${accountId ? c.dim(`  account ${accountId}`) : ""}\n`);
  info("checking your machine. The Cloudflare checks download a tool on first run,");
  info("so the first time can take a couple of minutes. Each line appears as it finishes.\n");

  // Printed as each check completes, not collected and dumped at the end.
  // Otherwise a first run sits silent for minutes while npx fetches wrangler,
  // and silence is indistinguishable from a hang to the person watching.
  const checks = await doctorRunAll({
    accountId,
    onResult: (x) => {
      const mark = x.status === D_OK ? c.green("ok  ") : x.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
      console.log(`  ${mark}  ${x.name.padEnd(18)}  ${x.detail}`);
    },
  });

  const s = doctorSummarize(checks);
  console.log("");
  const needFix = checks.filter((x) => x.status !== D_OK && x.fix);
  if (needFix.length) {
    console.log(`  ${c.bold("What to do")}\n`);
    for (const x of needFix) {
      console.log(`  ${x.status === D_FAIL ? c.red(x.name) : c.yellow(x.name)}`);
      console.log(`    ${x.fix.split("\n").join("\n    ")}\n`);
    }
  }

  if (s.fatal) {
    // Non-zero exit, so a setup script or a CI step can gate on this.
    die(`${s.fatal} blocking problem(s). Fix those and re-run \`brain doctor\`.`);
  }
  ok(`ready to install${s.warnings ? ` (${s.warnings} optional item(s) not set up)` : ""}`);
}


/**
 * Prompting that works on a terminal AND on piped input.
 *
 * `rl.question` is NOT usable here. With a non-TTY stdin it fires exactly once:
 * the stream is consumed, "close" is emitted, and every subsequent question
 * hangs forever. Node exits 13 with "unsettled top-level await" partway through
 * setup, which reads as a crash on a live call and is worse than an error.
 *
 * Reading lines through the interface's async iterator behaves identically on a
 * terminal and on a pipe, and it gives the one behaviour a non-interactive run
 * needs: when stdin ends, take the default rather than block.
 */
let _rl = null;
let _lines = null;
function prompts() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    _lines = _rl[Symbol.asyncIterator]();
  }
  return _lines;
}
function closePrompts() {
  if (_rl) {
    _rl.close();
    _rl = null;
    _lines = null;
  }
}

/** Ask a question. Returns the trimmed answer, or the default when blank or absent. */
async function ask(question, fallback = "") {
  const lines = prompts();
  process.stdout.write(`  ${question}${fallback ? c.dim(` [${fallback}]`) : ""}: `);
  const { value, done } = await lines.next();
  if (done) {
    // stdin ended. Taking the default is right: an unattended run should
    // complete on defaults rather than hang waiting for a person.
    process.stdout.write(`${c.dim(fallback || "(none)")}\n`);
    return fallback;
  }
  return (String(value || "").trim()) || fallback;
}

/**
 * Ask for a secret without echoing it.
 *
 * Not theatre. A key typed as a command argument lands in shell history and in
 * screenshare scrollback, and setup runs live with someone watching. On a pipe
 * there is nothing to hide from, so it reads the line plainly rather than
 * pretending.
 */
async function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);
  const lines = prompts();
  process.stdout.write(`  ${question}: `);
  const mute = () => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`  ${question}: `);
  };
  process.stdin.on("data", mute);
  const { value, done } = await lines.next();
  process.stdin.removeListener("data", mute);
  process.stdout.write("\n");
  return done ? "" : String(value || "").trim();
}

/**
 * brain setup — nothing to a working brain, in one command.
 *
 * The step ORDER here is not cosmetic. A clean-room rehearsal established that
 * secrets must come after deploy (a secret is set ON a worker script, so the
 * script has to exist) and that provisioning needs wrangler's own session
 * because no API token can reach Vectorize. Running these by hand in the
 * obvious order fails on both counts.
 *
 * Every step is idempotent and the manifest is written after each, so an
 * interrupted setup is resumed by re-running the same command.
 */
async function cmdSetup(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  console.log(`\n  ${c.bold("brain setup")}  ${c.dim("nothing to a working brain")}\n`);

  /* --- 1. preflight, because everything below assumes it --- */
  console.log(`  ${c.bold("Step 1 of 6")}  checking this machine\n`);
  const checks = await doctorRunAll({ accountId: undefined });
  for (const x of checks) {
    const mark = x.status === D_OK ? c.green("ok  ") : x.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
    console.log(`    ${mark}  ${x.name}  ${c.dim(x.detail)}`);
  }
  const fatal = checks.filter((x) => x.status === D_FAIL);
  if (fatal.length) {
    console.log("");
    for (const x of fatal) console.log(`  ${c.red(x.name)}\n    ${x.fix.split("\n").join("\n    ")}\n`);
    closePrompts();
    die("setup cannot continue until the blocking items above are fixed. Re-run when they are.");
  }

  /* --- 2. the manifest, asked for once --- */
  const target = manifestPath || flags.manifest || "./brain.manifest.json";
  let m;
  if (existsSync(target)) {
    m = loadManifest(target).m;
    ok(`resuming from ${relative(process.cwd(), target)}`);
  } else {
    console.log(`\n  ${c.bold("Step 2 of 6")}  about this install\n`);
    const display = await ask("What is this brain for? (a person or a company)", "My Brain");
    const slug = (await ask(
      "Short name, lowercase, no spaces (names the worker and the database)",
      display.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "brain"
    )).toLowerCase();

    const tmpl = JSON.parse(readFileSync(join(HERE, "templates", "brain.manifest.json"), "utf-8"));
    tmpl.client = { slug, display_name: display, primary_contact: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    tmpl.brain = { version: tmpl.brain?.version || "0.1.0", worker_name: `${slug}-brain` };
    const cf = tmpl.infrastructure.cloudflare;
    for (const k of ["d1_database_id", "vectorize_index", "kv_namespace_id"]) delete cf[k];
    delete cf.r2_bucket; // not wired to anything, so do not provision it
    cf.d1_database_name = `${slug}-brain`;
    cf.storage = "d1";
    delete tmpl.infrastructure.supabase;

    // Resolved from the wrangler session rather than asked for: people paste the
    // wrong id, and the session already knows which account it is.
    const who = wrangler(["whoami"], { accountId: undefined });
    const ids = [...(who.out.matchAll(/\b([0-9a-f]{32})\b/g) || [])].map((x) => x[1]);
    if (ids.length === 1) {
      cf.account_id = ids[0];
      ok(`Cloudflare account ${ids[0]}`);
    } else {
      if (ids.length > 1) {
        console.log(`\n  ${c.yellow("This login can see several Cloudflare accounts.")}`);
        console.log(`  ${c.dim("Pick carefully: this creates real resources in whichever one you name.")}\n`);
        for (const id of [...new Set(ids)]) console.log(`    ${id}`);
        console.log("");
      }
      // NO DEFAULT when the login can see more than one account. Offering the
      // first one means a person pressing enter provisions a brain into someone
      // else's business, and the resources look identical afterwards.
      cf.account_id = await ask("Cloudflare account id", ids.length === 1 ? ids[0] : "");
      if (!cf.account_id && ids.length > 1) {
        closePrompts();
        die("no account id given, and this login can see several. Re-run and name the one you mean.");
      }
    }
      if (!cf.account_id) {
      closePrompts();
      die("a Cloudflare account id is required.");
    }

    writeFileSync(target, JSON.stringify(tmpl, null, 2) + "\n");
    m = tmpl;
    ok(`wrote ${relative(process.cwd(), target)}`);
  }

  /* --- 3. the install sequence, in the ONLY order that works --- */
  console.log(`\n  ${c.bold("Step 3 of 6")}  creating the brain in your Cloudflare account\n`);
  await cmdVerify(target);
  await cmdProvision(target);
  await cmdMigrate(target);
  await cmdDeploy(target);

  /* --- 4. secrets, AFTER deploy --- */
  console.log(`\n  ${c.bold("Step 4 of 6")}  keys\n`);
  if (!process.env.ADMIN_KEY) {
    // Generated, never asked for. It protects this brain and nothing else, so
    // there is no reason to make a person invent or manage one.
    // randomBytes, not Math.random. This key is the only thing between the open
    // internet and the client's entire corpus, and the previous version derived
    // it from a timestamp, Math.random and the pid, all of which are low-entropy
    // and partly guessable by anyone who knows roughly when the install ran.
    process.env.ADMIN_KEY = randomBytes(24).toString("hex");
    ok("generated an admin key for this brain");
  }
  {
    // PERSIST it, or the client is locked out of their own brain tomorrow. The
    // first version generated the key inside this process, pushed it to the
    // worker and into the MCP registrations, and exited. Nothing on disk held
    // it, so `brain ingest` and `brain test` died the next morning asking for a
    // key the client had never seen.
    const keyPath = join(dirname(resolve(target)), ".brain-admin-key");
    writeFileSync(keyPath, process.env.ADMIN_KEY + "\n");
    try { chmodSync(keyPath, 0o600); } catch { /* Windows has no POSIX mode */ }
    info(`admin key saved to ${relative(process.cwd(), keyPath)} (commands read it from there automatically)`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      `\n    The brain writes its answers with Claude, on ${c.bold("your own")} API key, so the\n` +
        "    cost and the data both stay yours. Get one at console.anthropic.com.\n" +
        "    Leave this blank to skip: search still works, but you get sources with\n" +
        "    no written answer.\n"
    );
    const k = await askSecret("Anthropic API key (hidden, not echoed)");
    if (k) process.env.ANTHROPIC_API_KEY = k;
  }
  await cmdSecrets(target);
  await cmdHealth(target);

  /* --- 5. wire it into the tools people actually use --- */
  console.log(`\n  ${c.bold("Step 5 of 6")}  connecting it to your AI tools\n`);
  const wired = await wireAgents(m, target);

  /* --- 6. the first thing worth looking at --- */
  console.log(`\n  ${c.bold("Step 6 of 6")}  loading something in\n`);
  const folder = flags.path || (await ask("A folder to load now (blank to skip)", ""));
  if (folder && existsSync(folder)) {
    process.argv = [process.argv[0], process.argv[1], "ingest", target, "--path", folder, "--source", "documents"];
    await cmdIngest(target);
  } else if (folder) {
    warn(`no such folder: ${folder}. Load one later with: brain ingest ${relative(process.cwd(), target)} --path <dir>`);
  } else {
    info(`load one later with: brain ingest ${relative(process.cwd(), target)} --path <dir>`);
  }

  closePrompts();
  console.log(`\n  ${c.green(c.bold("Your brain is live."))}\n`);
  if (wired.length) {
    console.log(`  It is connected to: ${wired.join(", ")}.`);
    console.log(`  ${c.dim("Restart them, then ask a question about your own material.")}\n`);
  } else {
    console.log(`  Connect it to Claude Code or Codex with:\n    node brain.mjs mcp-config ${relative(process.cwd(), target)}\n`);
  }
}

/**
 * Register the brain with whichever agent tools are actually installed.
 *
 * Registering is not the same as working, so each one is checked afterwards by
 * listing what the tool now knows about. A registration that silently did not
 * take means the client opens Claude Code and their brain is simply not there,
 * which is the failure worth catching here rather than tomorrow.
 */
async function wireAgents(m, manifestPath) {
  const name = m.client?.slug || "brain";
  const scriptName = m.brain?.worker_name || `${name}-brain`;
  const acct = await resolveAccount(m).catch(() => null);
  const base = await resolveBaseUrl(m, acct).catch(() => null);
  const key = resolveAdminKey(manifestPath);
  const serverPath = join(HERE, "components", "brain-mcp.mjs");
  const wired = [];
  if (!base || !key) {
    warn("could not determine the brain URL or admin key, so the AI tools were not wired up");
    return wired;
  }

  const env = { BRAIN_URL: base, BRAIN_NAME: name, BRAIN_KEY: key };

  if (run("claude", ["--version"]).ok) {
    // --scope user so it works in every folder, not just the one they happen to
    // be standing in during the install.
    // -e for EVERY variable. Verified 2026-08-17 against Claude Code 2.1.63:
    // ambient environment on the `claude mcp add` process is DISCARDED, and the
    // server is written with an empty env block. It registers, it appears in
    // `claude mcp list`, and it fails on the client's first question with no
    // credential. Registration is not the same as working.
    const claudeArgs = ["mcp", "add", "--scope", "user", name];
    for (const [k, v] of Object.entries(env)) claudeArgs.push("-e", `${k}=${v}`);
    claudeArgs.push("--", "node", serverPath);
    const r = run("claude", claudeArgs);
    // Check the CREDENTIAL landed, not just the name. A registration with an
    // empty env is the exact failure this is guarding against.
    const got = run("claude", ["mcp", "get", name]);
    if (got.ok && got.out.includes("BRAIN_URL=")) {
      ok(`Claude Code: "${name}" registered with credentials`);
      wired.push("Claude Code");
    } else if (r.ok || got.ok) {
      warn(
        `Claude Code registered "${name}" but WITHOUT credentials, so it will fail on the first question.\n` +
          `        Remove it and re-add by hand:\n` +
          `          claude mcp remove --scope user ${name}\n` +
          `          claude mcp add --scope user ${name} -e BRAIN_URL=${base} -e BRAIN_NAME=${name} -e BRAIN_KEY=<key> -- node ${JSON.stringify(serverPath)}`
      );
    } else {
      warn(`Claude Code registration did not take: ${r.out.slice(-160)}`);
    }
  } else {
    info("Claude Code is not installed, skipping");
  }

  if (run("codex", ["--version"]).ok) {
    const args = ["mcp", "add", name];
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    args.push("--", "node", serverPath);
    const r = run("codex", args);
    const listed = run("codex", ["mcp", "list"]);
    if (r.ok || new RegExp(`\\b${name}\\b`).test(listed.out)) {
      ok(`Codex: "${name}" registered`);
      wired.push("Codex");
    } else {
      warn(`Codex registration did not take: ${r.out.slice(-160)}`);
    }
  } else {
    info("Codex is not installed, skipping");
  }

  return wired;
}


/**
 * The admin key, from the environment or from the file setup wrote.
 *
 * The env var wins so a rotation can be tested without touching the file. The
 * file is what makes tomorrow work: a client who ran `brain setup` never saw
 * the key and should never have needed to.
 */
function resolveAdminKey(manifestPath) {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try {
    const p = join(dirname(resolve(manifestPath)), ".brain-admin-key");
    if (existsSync(p)) {
      const k = readFileSync(p, "utf-8").trim();
      if (k) return k;
    }
  } catch { /* fall through to the callers' own error text */ }
  return undefined;
}


/* ------------------------------------------------------- failure handling */

/**
 * Nothing raw ever reaches a client's terminal.
 *
 * Install number one runs live on someone's machine while they watch. A Node
 * stack trace in that moment tells them nothing they can act on and costs more
 * trust than the underlying bug does. This says three things instead: what
 * happened, that it is not their fault, and that re-running is safe, which is
 * true because every command here is idempotent.
 *
 * The stack is still one environment variable away for whoever has to fix it.
 */
function crash(err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`\n${c.red("unexpected error")}  ${msg}`);
  console.error("  This is a bug in the installer, not something you did wrong.");
  console.error("  Every command here is safe to run again: nothing is left half-written that");
  console.error("  a re-run cannot finish.");
  if (process.env.BRAIN_DEBUG) {
    console.error("\n" + (err && err.stack ? err.stack : String(err)));
  } else {
    console.error(`\n  For the technical detail to send on: ${c.bold("BRAIN_DEBUG=1")} <the same command>`);
  }
  process.exit(1);
}

/**
 * fetch with a deadline, because a hang is worse than a failure.
 *
 * A request with no timeout leaves the client staring at a frozen terminal with
 * no output and no idea whether to wait or interrupt. Every network call here
 * now either answers, fails with a reason, or gives up out loud.
 */
const HTTP_TIMEOUT_MS = 60_000;

async function http(url, opts = {}, { timeoutMs = HTTP_TIMEOUT_MS, what = "the request" } = {}) {
  let host = "the server";
  try {
    host = new URL(String(url)).host;
  } catch { /* a relative or odd URL still deserves a real error below */ }
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e?.name || "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(
        `${what} timed out after ${Math.round(timeoutMs / 1000)}s (${host}).\n` +
          "      Nothing is stuck: whatever had already completed is saved, and re-running\n" +
          "      the same command continues from there. Check the connection, a VPN, or a\n" +
          "      corporate proxy, then try again."
      );
    }
    const code = e?.cause?.code || e?.code || "";
    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
      throw new Error(`${host} could not be resolved (${code}). Check the network connection or a DNS/VPN setting.`);
    }
    if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(code)) {
      throw new Error(`the connection to ${host} failed (${code}). This is usually a network blip; re-running the command is safe.`);
    }
    if (/certificate|self-signed|CERT_/i.test(String(e?.message))) {
      throw new Error(
        `the TLS certificate for ${host} was rejected.\n` +
          "      On a corporate network this usually means an inspecting proxy. Ask IT for the\n" +
          "      root certificate, or run this from a different network."
      );
    }
    throw new Error(`${what} failed talking to ${host}: ${e?.message || String(e)}`);
  }
}


/**
 * brain whatsnew — what changed, in the client's own terminal.
 *
 * A client who receives an upgrade has no way to know what arrived. Telling
 * them in an email works once and is lost by the second release; a changelog
 * the tool itself reads is the version that keeps working. It also shows what
 * they are running against what is installed, because "am I on the new one" is
 * the first question an upgrade raises.
 */
async function cmdWhatsnew(manifestPath) {
  console.log("");
  let installed = null;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const { m } = loadManifest(manifestPath);
      installed = m.brain?.version || null;
    } catch { /* the changelog is worth showing regardless */ }
  }
  if (installed && installed !== PRODUCT_VERSION) {
    warn(
      `this brain is recorded at ${installed}, and you have ${PRODUCT_VERSION} installed.\n` +
        `        Bring it up to date with: brain upgrade ${relative(process.cwd(), manifestPath)}`
    );
    console.log("");
  } else if (installed) {
    ok(`up to date, running ${PRODUCT_VERSION}`);
    console.log("");
  }

  const path = join(HERE, "CHANGELOG.md");
  if (!existsSync(path)) {
    info(`no changelog shipped with this version (${PRODUCT_VERSION}).`);
    return;
  }
  // Printed rather than paged: a client on Windows should not meet a pager.
  console.log(readFileSync(path, "utf-8").trimEnd());
  console.log("");
}

/* ---------------------------------------------------------------- main */

// Only run the CLI when this file IS the program. Without this guard, importing
// brain.mjs to test any of its logic runs the whole command dispatcher and exits
// the process, which is why no test had ever imported it and why a broken SQL
// splitter shipped undetected.
// realpathSync on BOTH sides. npm installs the bin as a SYMLINK, so argv[1] is
// /prefix/bin/brain while import.meta.url is the real file under node_modules.
// Compared without resolving, IS_MAIN is false and the installed CLI runs and
// does NOTHING, exit 0 — the worst possible failure, because it looks like
// success to every script that checks the exit code.
const IS_MAIN = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const [, , cmd, manifestPath] = process.argv;
const commands = {
  setup: cmdSetup,
  doctor: cmdDoctor,
  whatsnew: cmdWhatsnew,
  verify: cmdVerify,
  provision: cmdProvision,
  deploy: cmdDeploy,
  secrets: cmdSecrets,
  health: cmdHealth,
  test: cmdTest,
  "mcp-config": cmdMcpConfig,
  migrate: cmdMigrate,
  ingest: cmdIngest,
  connect: cmdConnect,
  status: cmdStatus,
  sources: cmdSources,
  forget: cmdForget,
  upgrade: cmdUpgrade,
  rollback: cmdRollback,
};

if (IS_MAIN && (!cmd || !commands[cmd])) {
  console.log(`${c.bold("brain")} — provision and manage a client-owned brain install

  install
    brain setup      [manifest]            nothing to a working brain, one command
    brain doctor     [manifest]            check this machine has everything it needs
    brain verify     <manifest>            check the token and resolve the account
    brain provision  <manifest>            create D1 (and R2), write IDs back
    brain secrets    <manifest>            set worker secrets from the environment
    brain migrate    <manifest>            apply pending schema migrations
    brain deploy     <manifest>            upload the worker with its bindings
    brain health     <manifest>            prove the install actually works
    brain test       <manifest>            full acceptance suite (5 tiers)
    brain connect google --scopes drive,gmail  authorise the client's own Google account
    brain ingest     <manifest> --path <dir>  load a folder into the brain
    brain ingest     <manifest> --from drive  load from a connected remote source
    brain mcp-config <manifest>            config to connect the client's AI tools

  operate
    brain whatsnew   [manifest]            what changed in this version, and are you on it
    brain status     <manifest>            versions, pending migrations, upgrade history
    brain sources    <manifest>            named ingest sources, counts, last ingest
    brain forget     <manifest>            remove one named source (destructive)
    brain upgrade    <manifest>            snapshot, migrate, deploy, verify
    brain rollback   <manifest> <bookmark> restore a D1 snapshot (destructive)

  brain ingest takes --source <name>, --limit <n>, --dry-run, and --reset. It is
  resumable: re-run the same command to continue an interrupted load.

  brain sources takes --add <name> [--kind <drive|gmail|calendar|upload>] to register one.
  brain forget needs --source <name>, and --yes before it removes anything. Without
  --yes it prints exactly what would go and stops.

  Requires CLOUDFLARE_API_TOKEN in the environment.
`);
  process.exit(cmd ? 1 : 0);
}

if (IS_MAIN) {
  // A throw that escapes the command promise entirely, from a stray listener or
  // a background task, would otherwise print a raw stack trace and exit 1 with
  // no explanation. These two make that impossible.
  process.on("unhandledRejection", (e) => crash(e));
  process.on("uncaughtException", (e) => crash(e));

  commands[cmd](manifestPath).catch((e) => {
    // Fatal is a failure this code ANTICIPATED and already explained: a missing
    // token, a free-tier account, a typo'd source name. Its message is the whole
    // point, so print it plainly. Anything else is a bug, and crash() says so
    // rather than dressing it up as the client's problem.
    if (e instanceof Fatal) {
      console.error(`${c.red("fail")}  ${e.message}`);
      process.exit(1);
    }
    crash(e);
  });
}
