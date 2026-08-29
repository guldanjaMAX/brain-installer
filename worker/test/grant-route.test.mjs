/**
 * A grant token, through the REAL route, on the REAL worker.
 *
 * Why this file exists. `worker/test/grants.test.mjs` covers `resolvePrincipal`
 * in isolation and never passes a `lookupCredential`, so it proves the policy
 * and nothing about the wiring. That gap was found by probe: forcing the
 * credential lookup in `src/index.js` to throw on every call left the entire
 * grants suite green at 11/11. In other words, nothing anywhere proved that a
 * person the owner had actually named could reach anything at all, and nothing
 * would have noticed if a merge quietly denied every one of them.
 *
 * Two things are pinned here:
 *
 * 1. A live grant with `ask` reaches an `ask` route through `worker.fetch`.
 * 2. A brain whose Worker is NEWER than its migrations answers 401, not 500.
 *    That install has no `grants` table, so the lookup throws. It is an
 *    ordinary state during an upgrade rather than a fault, and letting it throw
 *    would 500 every request carrying an unrecognised key on exactly the
 *    installs that are mid-upgrade.
 */
import worker from "../src/index.js";
import { hashToken } from "../src/lib/grants.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++;
};

const GRANT_TOKEN = "grant-token-for-the-bookkeeper";

/** A D1 that answers the credential join, and nothing else of consequence. */
function mkEnv({ grantRow = null, grantsTableMissing = false } = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "the-owner-key",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => ({ results: [] }),
          first: async () => {
            if (/FROM grant_credentials/.test(sql)) {
              if (grantsTableMissing) throw new Error("D1_ERROR: no such table: grants");
              return grantRow;
            }
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 24, mutation_id: null, mutation_submitted_at: null,
                projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                bootstrap_high_water: null, expected_vectors: 0, pending: 0, submitted: 0,
                oldest_queued_at: null,
              };
            }
            return /count\(\*\)/i.test(sql) ? { n: 0, stored_documents: 0, logical_documents: 0 } : null;
          },
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      upsert: async () => {},
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
    AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
  };
}

const ask = (env, key) => worker.fetch(
  new Request("https://b.example/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "what did we agree?" }),
  }),
  env,
  { waitUntil() {}, passThroughOnException() {} },
);

const liveGrant = async () => ({
  grant_id: "g_bookkeeper",
  display_name: "Bookkeeper",
  capabilities: JSON.stringify(["ask"]),
  expires_at: null,
  revoked_at: null,
  credential_revoked_at: null,
  scope_include: '{"all":true}',
  scope_exclude: "[]",
  token_hash: await hashToken(GRANT_TOKEN),
});

/* ---- a named person actually reaches the route ---- */
{
  const res = await ask(mkEnv({ grantRow: await liveGrant() }), GRANT_TOKEN);
  check("a live grant with `ask` is authorised on an ask route", res.status !== 401,
    `status ${res.status}`);
}

/* ---- and an unknown token still is not ---- */
{
  const res = await ask(mkEnv({ grantRow: null }), "not-a-token-anybody-issued");
  check("an unknown token is refused", res.status === 401, `status ${res.status}`);
}

/* ---- revoked and expired grants are refused through the same path ---- */
{
  const revoked = { ...(await liveGrant()), revoked_at: Date.now() - 1000 };
  check("a revoked grant is refused", (await ask(mkEnv({ grantRow: revoked }), GRANT_TOKEN)).status === 401);

  const expired = { ...(await liveGrant()), expires_at: Date.now() - 1000 };
  check("an expired grant is refused", (await ask(mkEnv({ grantRow: expired }), GRANT_TOKEN)).status === 401);

  const credRevoked = { ...(await liveGrant()), credential_revoked_at: Date.now() - 1000 };
  check("a grant whose credential was revoked is refused",
    (await ask(mkEnv({ grantRow: credRevoked }), GRANT_TOKEN)).status === 401);
}

/* ---- the upgrade window: Worker newer than migrations ---- */
{
  const res = await ask(mkEnv({ grantsTableMissing: true }), GRANT_TOKEN);
  check("a brain with no grant tables yet answers 401 rather than 500",
    res.status === 401, `status ${res.status}`);
  check("and the owner key still works on that same brain",
    (await ask(mkEnv({ grantsTableMissing: true }), "the-owner-key")).status !== 401);
}

console.log(`\ngrant route: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
