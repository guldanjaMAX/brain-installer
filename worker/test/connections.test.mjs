/**
 * The owner-facing list of connected apps, against a REAL SQLite database.
 *
 * The property worth proving here is the one that is easy to get wrong and
 * impossible to see: a token dies three different ways, and only one of them
 * writes anything to its row. "Sign out everywhere" bumps a counter elsewhere
 * and leaves every token looking pristine. A list built the obvious way keeps
 * showing those grants as live, on the one page whose entire job is telling an
 * owner who can reach their material.
 *
 * So this applies the actual migrations and drives the exported functions,
 * rather than asserting against a hand-built mock that would simply agree with
 * whatever the query happened to say.
 *
 * Every fixture app and identifier here is invented.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../brain.mjs";
import { listConnections, revokeConnection } from "../src/lib/connections.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const HOUR = 3_600_000;
const now = Date.now();

function env() {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) {
      db.exec(statement);
    }
  }
  const shim = {
    DB: {
      prepare(sql) {
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => {
            const result = db.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes || 0) } };
          },
        });
        return shape();
      },
    },
  };
  shim.raw = (sql, ...params) => db.prepare(sql).run(...params);
  shim.generation = (n) => db.exec(`UPDATE install_state SET session_generation = ${n}`);
  return shim;
}

/** A grant, live by default; each named field is a way of being dead. */
function grant(e, {
  client = "c1", name = "An Assistant", scope = "read", generation = 1,
  created = now - 4 * HOUR, used = null, expires = now + HOUR, revoked = null,
  hash = Math.random().toString(36).slice(2),
} = {}) {
  e.raw(
    "INSERT OR IGNORE INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?,?,?,?)",
    client, name, "https://example.invalid/cb", created,
  );
  e.raw(
    `INSERT INTO oauth_tokens
       (token_hash, client_id, scope, session_generation, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    hash, client, scope, generation, created, expires, used, revoked,
  );
}

// install_state must carry its single row (id = 1 is a CHECK) before a
// generation means anything. Its NOT NULL columns are why this is spelled out
// rather than inserted bare.
const seedState = (e) => e.raw(
  `INSERT INTO install_state (id, client_slug, product_version, installed_at, session_generation)
   VALUES (1, 'fixture', '0.0.0-test', '2020-01-01T00:00:00Z', 1)`,
);

/* ------------------------------------------------------------- the basics */
{
  const e = env(); seedState(e);
  grant(e, { name: "An Assistant", scope: "librarian", used: now - HOUR });
  const [one, ...rest] = await listConnections(e);
  check("a live grant is listed", !!one, JSON.stringify(one));
  check("carries the app name", one?.name === "An Assistant", one?.name);
  check("read scope is not write", one?.can_write === false, String(one?.can_write));
  check("the exact profile is visible", one?.profiles?.join(",") === "librarian", JSON.stringify(one));
  check("only one row", rest.length === 0, String(rest.length));
}

/* --------------------------------------------------- the three ways to die */
{
  const e = env(); seedState(e);
  grant(e, { client: "revoked", revoked: now - 60_000 });
  check("a revoked grant is not listed", (await listConnections(e)).length === 0);
}
{
  const e = env(); seedState(e);
  grant(e, { client: "expired", expires: now - 60_000 });
  check("an expired grant is not listed", (await listConnections(e)).length === 0);
}
{
  // The one that leaves no trace on the row. This is the whole point.
  const e = env(); seedState(e);
  grant(e, { client: "stale", generation: 1 });
  check("live before signing out everywhere", (await listConnections(e)).length === 1);
  e.generation(2);
  check(
    "a grant from an older session generation is not listed",
    (await listConnections(e)).length === 0,
    "sign-out-everywhere must disconnect apps, not just people",
  );
}

/* ------------------------------------------------- one row per app, not token */
{
  const e = env(); seedState(e);
  grant(e, { client: "refresher", scope: "librarian", created: now - 5 * HOUR, hash: "a" });
  grant(e, { client: "refresher", scope: "librarian", created: now - 2 * HOUR, used: now, hash: "b" });
  const rows = await listConnections(e);
  check("several tokens collapse to one app", rows.length === 1, String(rows.length));
  check("connected_at is the earliest", rows[0]?.connected_at === now - 5 * HOUR);
  check("last_used_at is the most recent", rows[0]?.last_used_at === now);
}
{
  // An app that reconnects with another profile may hold both through separate
  // tokens. Settings shows both rather than inventing a combined token role.
  const e = env(); seedState(e);
  grant(e, { client: "upgraded", scope: "librarian", hash: "a" });
  grant(e, { client: "upgraded", scope: "structured-contributor", hash: "b" });
  const [row] = await listConnections(e);
  check("separate live profiles are reported", row?.profiles?.join(",") === "librarian,structured-contributor", JSON.stringify(row));
  check("structured-contributor reports curated write", row?.can_write === true, JSON.stringify(row));
}

/* ------------------------------------------------------------ presentation */
{
  const e = env(); seedState(e);
  grant(e, { client: "nameless", name: null });
  const [row] = await listConnections(e);
  check("an unnamed client still renders", !!row?.name && row.name.length > 0, row?.name);
}
{
  const e = env(); seedState(e);
  grant(e, { client: "old", used: now - 9 * HOUR, hash: "a" });
  grant(e, { client: "new", used: now - 1 * HOUR, hash: "b" });
  const rows = await listConnections(e);
  check("most recently used first", rows[0]?.client_id === "new", rows.map((r) => r.client_id).join(","));
}

/* ---------------------------------------------------------------- revoking */
{
  const e = env(); seedState(e);
  grant(e, { client: "goodbye", hash: "a" });
  grant(e, { client: "goodbye", hash: "b" });
  grant(e, { client: "stays", hash: "c" });
  const out = await revokeConnection(e, "goodbye");
  check("revoking reports how many tokens it ended", out.tokens === 2, JSON.stringify(out));
  const rows = await listConnections(e);
  check("the revoked app is gone", !rows.some((r) => r.client_id === "goodbye"));
  check("the other app survives", rows.some((r) => r.client_id === "stays"));
  const again = await revokeConnection(e, "goodbye");
  check("revoking twice is harmless", again.revoked === true && again.tokens === 0, JSON.stringify(again));
}
{
  const e = env(); seedState(e);
  const out = await revokeConnection(e, "never-existed");
  check("revoking an unknown app is harmless", out.revoked === true && out.tokens === 0);
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
