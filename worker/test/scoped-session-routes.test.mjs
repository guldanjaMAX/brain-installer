/**
 * A SCOPED SESSION, driven through the owner-only routes.
 *
 * WHY THIS FILE EXISTS. Every existing zone and capability test drives the
 * GRANT TOKEN path. None drives the scoped SESSION path — the cookie a person
 * gets after signing in with a scoped passkey. That is precisely where three
 * privilege escalations lived, and it is why every one of those suites stayed
 * green while they were present.
 *
 * The pattern is named in ownerSessionPrincipal's own docstring: "the gate was
 * reading it through a boolean, so a person signed in with a SCOPED passkey was
 * served as the unscoped owner." It was fixed for reads, and missed on three
 * write routes:
 *
 *   1. POST /api/app/recovery-codes       no owner check at all
 *   2. POST /api/app/connections/revoke   no owner check at all
 *   3. POST /oauth/authorize/decision     used validateOwnerSession(), a
 *                                         boolean that cannot tell an owner
 *                                         from a scoped person
 *
 * Why they were latent rather than exploitable: nothing in shipped code writes
 * grant_id onto an enrolment, so no scoped passkey exists yet. They would have
 * activated on the day someone added a grant-bound invite, which is a normal
 * feature to add and would not have looked like a security change.
 *
 * (1) is the sharpest. Minting a card also DESTROYS every unused code the owner
 * holds, and recovery restores the OWNER by design, so a scoped person who
 * could mint one could enrol themselves as the owner and take the brain.
 *
 * These tests assert on the SESSION path specifically. Do not "simplify" them
 * to use a grant token: the token path was always correct, and testing it here
 * would restore the exact blind spot this file was written to close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { mintSessionCookie } from "../src/lib/sessions.js";
import { splitStatements } from "../../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const ORIGIN = "https://brain.example.com";
const ADMIN = "admin-key-fixture-value-000";
const GRANT_ID = "g_bookkeeper";

/** Real SQLite behind D1's shape, built from the real migrations. */
function realDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 24, 0, '2026-01-01T00:00:00Z', 'test')`,
  ).run();
  // A live, scoped grant: real row, real columns, no expiry, not revoked.
  db.prepare(
    `INSERT INTO grants (grant_id, display_name, capabilities, expires_at, revoked_at, created_by, scope_include, scope_exclude, created_at)
     VALUES (?, 'Bookkeeper', ?, NULL, NULL, 'owner', ?, '[]', ?)`,
  ).run(GRANT_ID, JSON.stringify(["ask", "file"]), '{"zones":["books"]}', Date.now());
  return {
    raw: db,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() { return db.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bound) }; },
        async run() {
          const result = db.prepare(sql).run(...bound);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch() {},
  };
}

const env = (db) => ({
  STORAGE: "d1", DB: db, ADMIN_KEY: ADMIN,
  SESSION_SIGNING_KEY: "a".repeat(64), BRAIN_NAME: "fixture", BRAIN_OWNER: "Fixture Owner",
});

const post = (path, payload, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(payload || {}),
});
const app = (cookie) => ({ Cookie: cookie, "X-Brain-App": "1" });

/** A cookie for a scoped person, and one for the owner, on the same brain. */
async function cookies(testEnv) {
  const scoped = (await mintSessionCookie(testEnv, 1, { grantId: GRANT_ID })).split(";")[0];
  const owner = (await mintSessionCookie(testEnv, 1, { grantId: null })).split(";")[0];
  return { scoped, owner };
}

test("a scoped session cannot print recovery codes", async () => {
  const testEnv = env(realDb());
  const { scoped, owner } = await cookies(testEnv);

  const denied = await worker.fetch(post("/api/app/recovery-codes", {}, app(scoped)), testEnv);
  assert.equal(denied.status, 403, `scoped session got ${denied.status}`);
  const body = await denied.json();
  assert.ok(!body.recovery_codes, "no codes may be returned to a scoped session");

  // And the owner is still able to, so the fix is a gate and not a wall.
  const allowed = await worker.fetch(post("/api/app/recovery-codes", {}, app(owner)), testEnv);
  assert.notEqual(allowed.status, 403, "the owner must still be able to print a card");
});

test("a scoped session cannot destroy the owner's existing card", async () => {
  // The escalation is not only "gets codes". Minting DELETES every unused code
  // the owner holds, so an unchecked route is also a denial-of-recovery.
  const db = realDb();
  const testEnv = env(db);
  const { scoped, owner } = await cookies(testEnv);

  // Compare the code HASHES, not the count. Minting replaces five unused codes
  // with five different unused codes, so a count is identical either way and
  // would report the card as intact while it was silently swapped. This was
  // caught by probing the fix rather than by the test passing.
  const unused = () => db.raw
    .prepare("SELECT code_hash FROM recovery_codes WHERE used_at IS NULL ORDER BY code_hash")
    .all().map((r) => r.code_hash).join(",");

  await worker.fetch(post("/api/app/recovery-codes", {}, app(owner)), testEnv);
  const before = unused();
  assert.ok(before.length > 0, "the owner should hold a card at this point");

  await worker.fetch(post("/api/app/recovery-codes", {}, app(scoped)), testEnv);
  assert.equal(unused(), before,
    "a scoped session must not be able to invalidate or replace the owner's card");
});

test("a scoped session cannot revoke a connected app, nor read the list through the attempt", async () => {
  const testEnv = env(realDb());
  const { scoped } = await cookies(testEnv);

  const denied = await worker.fetch(
    post("/api/app/connections/revoke", { client_id: "anything" }, app(scoped)), testEnv);
  assert.equal(denied.status, 403, `scoped session got ${denied.status}`);
  const body = await denied.json();
  // The success response returns the full connector list, so a leaked list is
  // the second half of this one.
  assert.ok(!("connections" in body), "the connector list must not leak through a refused revoke");
});

test("a scoped session cannot approve a connector through the OAuth decision route", async () => {
  const testEnv = env(realDb());
  const { scoped } = await cookies(testEnv);

  const url = "/oauth/authorize/decision?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb" +
    "&code_challenge_method=S256&code_challenge=" + "a".repeat(43);
  const denied = await worker.fetch(post(url, {}, app(scoped)), testEnv);

  // 403 is the fix. 401 would also be safe but means something else went wrong
  // first, so this asserts the specific refusal rather than "not a redirect".
  assert.equal(denied.status, 403, `scoped session got ${denied.status}`);
  const body = await denied.json();
  assert.ok(!body.redirect, "no authorization code may be minted for a scoped session");
});

test("the owner session is still the owner on all three routes", async () => {
  // The control. If a fix ever hardens into "nobody can do this", these fail.
  const testEnv = env(realDb());
  const { owner } = await cookies(testEnv);

  for (const [path, payload] of [
    ["/api/app/recovery-codes", {}],
    ["/api/app/connections/revoke", { client_id: "not-a-real-client" }],
  ]) {
    const response = await worker.fetch(post(path, payload, app(owner)), testEnv);
    assert.notEqual(response.status, 403, `${path} refused the owner`);
  }
});
