/**
 * Recovery from a total device loss, proven end to end.
 *
 * The scenario this file exists for: every enrolled device is gone — lost,
 * destroyed or wiped — the session cookie died with it, and the person holding
 * the recovery card is not technical and cannot be handed a command line.
 *
 * Two deliberate choices about how it is tested.
 *
 * FIRST, the database is REAL SQLite with the REAL migrations applied, wrapped
 * in a D1-shaped adapter, rather than a hand-rolled mock that answers regexes.
 * Single use here is enforced by `UPDATE ... WHERE used_at IS NULL` and read
 * back from the row count the engine actually reports; a mock would be
 * asserting that the mock agrees with itself. It also means an install running
 * a Worker newer than its migrations can be reproduced exactly, by applying
 * every migration EXCEPT 0019.
 *
 * SECOND, the passkeys are really generated and really signed, so a recovered
 * device is put through the identical unskippable checklist as one enrolled at
 * setup. That is the claim being tested: recovery is not a second, weaker door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { NO_WAY_BACK } from "../src/lib/owner-auth.js";
import {
  generateRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT, RECOVERY_FAIL_LIMIT,
} from "../src/lib/auth-store.js";
import { makeCredential, signAssertion, clientData, attestationObject } from "./webauthn-fixtures.mjs";
import { splitStatements } from "../../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const ORIGIN = "https://brain.example.com";
const RP = "brain.example.com";
const ADMIN = "admin-key-fixture-value-000";
const RECOVERY_CODE_MISMATCH_TEXT =
  "That recovery code did not match. Check it for a typo, or try another code from your card.";

/** Real SQLite behind D1's prepare/bind/first/all/run shape. */
function realDb({ throughMigration = 9999 } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    if (Number(file.slice(0, 4)) > throughMigration) continue;
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 19, 0, '2026-01-01T00:00:00Z', 'test')`,
  ).run();
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
const cookieOf = (response) => (response.headers.get("Set-Cookie") || "").split(";")[0];
const json = async (response) => [response.status, await response.json()];

/** Invite -> enrol one device. Returns the codes the install ceremony printed. */
async function installWithOneDevice(testEnv) {
  const invite = await (await worker.fetch(post("/api/admin/auth/invite", {}, { "X-Admin-Key": ADMIN }), testEnv)).json();
  const code = invite.url.split("#enroll=")[1];
  const options = await (await worker.fetch(post("/auth/register/options", { code }), testEnv)).json();
  const credential = await makeCredential({ rpId: RP });
  const response = await worker.fetch(post("/auth/register/verify", {
    code,
    nickname: "phone",
    credentialId: credential.credentialId,
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
  }), testEnv);
  assert.equal(response.status, 200);
  const enrolled = await response.json();
  return { credential, cookie: cookieOf(response), codes: enrolled.recovery_codes };
}

/** Every enrolled device is gone: the rows and the session both. */
function loseEveryDevice(db) {
  db.raw.prepare("DELETE FROM owner_passkeys").run();
}

/** Run the recovery ceremony with `code`, optionally sabotaged. */
async function recoverWith(testEnv, code, { rpId = RP, origin = ORIGIN } = {}) {
  const [optionsStatus, options] = await json(await worker.fetch(post("/auth/recover/options", { code }), testEnv));
  if (optionsStatus !== 200) return { optionsStatus, options };
  const credential = await makeCredential({ rpId });
  const response = await worker.fetch(post("/auth/recover/verify", {
    code,
    nickname: "replacement laptop",
    credentialId: credential.credentialId,
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", options.challenge, origin),
  }), testEnv);
  return { optionsStatus, options, credential, response, cookie: cookieOf(response), body: await response.json() };
}

/* ------------------------------------------------------------------ shape */

test("a recovery code is high-entropy, transcribable, and normalises the way paper is typed", () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, code);
  // I, L, O, 0 and 1 are absent by construction, so a code read off paper
  // cannot be mistranscribed INTO a different valid code.
  assert.equal(/[ILO01]/.test(code), false, code);
  assert.equal(normalizeRecoveryCode(" " + code.toLowerCase() + "\n"), code.replace(/-/g, ""));
  const seen = new Set(Array.from({ length: 500 }, generateRecoveryCode));
  assert.equal(seen.size, 500, "codes must not repeat");
});

/* --------------------------------------------------- the scenario itself */

test("every device is gone: one code from the card puts the owner back in", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { codes, cookie: oldCookie } = await installWithOneDevice(testEnv);

  assert.equal(codes.length, RECOVERY_CODE_COUNT, "the install ceremony prints the card");
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);

  // The disaster.
  loseEveryDevice(db);
  const strandedLogin = await worker.fetch(post("/auth/login/options", {}), testEnv);
  assert.equal(strandedLogin.status, 200, "options are mintable; there is simply no credential to answer them");
  const [unknownStatus] = await json(await worker.fetch(post("/auth/login/verify", {
    credentialId: "anything", authenticatorData: "", clientDataJSON: "", signature: "",
  }), testEnv));
  assert.equal(unknownStatus, 403, "with no enrolled passkey, sign-in cannot succeed");

  // The way back.
  const recovered = await recoverWith(testEnv, codes[0]);
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.codes_remaining, RECOVERY_CODE_COUNT - 1);
  assert.match(recovered.cookie, /^brain_session=v1\./, "recovery earns the same session a sign-in does");

  // The new device really is enrolled, and is labelled as a recovery.
  const [meStatus, me] = await json(await worker.fetch(post("/api/app/me", {}, app(recovered.cookie)), testEnv));
  assert.equal(meStatus, 200);
  assert.equal(me.devices.length, 1);
  assert.match(me.devices[0].nickname, /recovered \d{4}-\d{2}-\d{2}$/, me.devices[0].nickname);
  assert.equal(me.recovery.unused, RECOVERY_CODE_COUNT - 1);

  // And the ordinary passkey path works from it afterwards.
  const loginOptions = await (await worker.fetch(post("/auth/login/options", {}), testEnv)).json();
  const assertion = await signAssertion({
    pair: recovered.credential.pair, rpId: RP, challenge: loginOptions.challenge, origin: ORIGIN,
  });
  const login = await worker.fetch(post("/auth/login/verify", {
    credentialId: recovered.credential.credentialId, ...assertion,
  }), testEnv);
  assert.equal(login.status, 200, "the recovered passkey is an ordinary passkey");

  // A cookie that was live on the lost device is dead: recovery assumes the
  // device was not merely mislaid.
  const [staleStatus] = await json(await worker.fetch(post("/api/app/me", {}, app(oldCookie)), testEnv));
  assert.equal(staleStatus, 401, "recovery signs out everywhere");
});

/* --------------------------------------------- it is not a weaker door */

test("recovery cannot be used by someone who should not have it", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { codes } = await installWithOneDevice(testEnv);
  loseEveryDevice(db);

  // A made-up code.
  const [invented, inventedBody] = await json(await worker.fetch(post("/auth/recover/options", { code: "AAAAA-BBBBB-CCCCC-DDDDD" }), testEnv));
  assert.equal(invented, 403);
  assert.equal(inventedBody.unrecoverable, false, "codes still exist, so this is a typo, not the end of the road");

  // No code at all.
  const [empty] = await json(await worker.fetch(post("/auth/recover/options", {}), testEnv));
  assert.equal(empty, 403);

  // A real code, from a DIFFERENT brain's database.
  const otherDb = realDb();
  const otherEnv = env(otherDb);
  const other = await installWithOneDevice(otherEnv);
  const [foreign] = await json(await worker.fetch(post("/auth/recover/options", { code: other.codes[0] }), testEnv));
  assert.equal(foreign, 403, "a card belonging to another install opens nothing here");

  // A valid code does NOT skip the passkey checklist: an attestation bound to
  // the wrong domain is refused, and no passkey is stored.
  const wrongDomain = await recoverWith(testEnv, codes[0], { rpId: "attacker.example.com" });
  assert.equal(wrongDomain.response.status, 400);
  assert.match(wrongDomain.body.error, /rpIdHash does not match/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM owner_passkeys").get().n, 0);
  // And a ceremony that failed did not cost the owner a code.
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL").get().n, RECOVERY_CODE_COUNT);

  // Same for an attestation signed against a different origin.
  const wrongOrigin = await recoverWith(testEnv, codes[0], { origin: "https://attacker.example.com" });
  assert.equal(wrongOrigin.response.status, 400);
  assert.match(wrongOrigin.body.error, /origin mismatch/);

  // The code is single use. The obvious version of this check — ask for
  // options again with the spent code — passes even if the single-use guard is
  // deleted, because options peeks at `used_at` before the guard is ever
  // reached. So it is checked BOTH ways, and the second way is the real one:
  // go straight to verify with a spent code and a challenge obtained under a
  // different, live one. That path reaches nothing but `UPDATE ... WHERE
  // used_at IS NULL`, which is the guard itself.
  const first = await recoverWith(testEnv, codes[1]);
  assert.equal(first.response.status, 200);
  const replay = await json(await worker.fetch(post("/auth/recover/options", { code: codes[1] }), testEnv));
  assert.equal(replay[0], 403, "a spent code is dead");

  const passkeysBefore = db.raw.prepare("SELECT count(*) AS n FROM owner_passkeys").get().n;
  const liveOptions = await (await worker.fetch(post("/auth/recover/options", { code: codes[2] }), testEnv)).json();
  const smuggled = await makeCredential({ rpId: RP });
  const [spentStatus, spentBody] = await json(await worker.fetch(post("/auth/recover/verify", {
    code: codes[1],
    nickname: "second helping",
    credentialId: smuggled.credentialId,
    attestationObject: attestationObject(smuggled.authData),
    clientDataJSON: clientData("webauthn.create", liveOptions.challenge, ORIGIN),
  }), testEnv));
  assert.equal(spentStatus, 403, "a spent code must not be spendable again, even skipping the options step");
  assert.equal(spentBody.error, RECOVERY_CODE_MISMATCH_TEXT);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM owner_passkeys").get().n, passkeysBefore,
    "and no passkey was stored on the way through");

  // What recovery earns is the read-only privilege class, exactly like a
  // sign-in. It never reaches an admin route.
  const [ingest] = await json(await worker.fetch(post("/api/admin/brain/ingest", { q: "x" }, app(first.cookie)), testEnv));
  assert.equal(ingest, 401, "a recovered session must never reach an admin route");
  const [noHeader] = await json(await worker.fetch(post("/api/rag/think", { q: "x" }, { Cookie: first.cookie }), testEnv));
  assert.equal(noHeader, 401, "the CSRF companion header is still required");
});

test("guessing is braked, and the brake clears for whoever holds a real code", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { codes } = await installWithOneDevice(testEnv);
  loseEveryDevice(db);

  for (let attempt = 0; attempt < RECOVERY_FAIL_LIMIT - 1; attempt++) {
    const [status] = await json(await worker.fetch(post("/auth/recover/options", { code: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ" }), testEnv));
    assert.equal(status, 403);
  }
  // A real code still works while attempts remain, and clears the brake.
  const [okStatus] = await json(await worker.fetch(post("/auth/recover/options", { code: codes[0] }), testEnv));
  assert.equal(okStatus, 200);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM recovery_attempts").get().n, 0, "a live code proves the owner is the owner");

  for (let attempt = 0; attempt < RECOVERY_FAIL_LIMIT; attempt++) {
    await worker.fetch(post("/auth/recover/options", { code: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ" }), testEnv);
  }
  const [locked, lockedBody] = await json(await worker.fetch(post("/auth/recover/options", { code: codes[0] }), testEnv));
  assert.equal(locked, 429, "the brake holds even against a valid code");
  assert.match(lockedBody.error, /Too many failed recovery attempts/);
  assert.ok(lockedBody.retry_after_ms > 0);
});

/* ------------------------------------------- what we deliberately cannot do */

test("with every device AND every code gone, the page says so instead of implying safety", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { codes } = await installWithOneDevice(testEnv);

  // Spend the whole card, then lose everything.
  for (const code of codes) {
    loseEveryDevice(db);
    const used = await recoverWith(testEnv, code);
    assert.equal(used.response.status, 200, JSON.stringify(used.body));
  }
  loseEveryDevice(db);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL").get().n, 0);

  const [status, payload] = await json(await worker.fetch(post("/auth/recover/options", { code: codes[0] }), testEnv));
  assert.equal(status, 403);
  assert.equal(payload.unrecoverable, true);
  assert.equal(payload.error, NO_WAY_BACK);
  // The exact promises the message must make and must not make.
  assert.match(payload.error, /nobody can open this page for you/);
  assert.match(payload.error, /not whoever installed it, and not us/);
  assert.match(payload.error, /still in your own\s+Cloudflare account/);
});

test("an install whose worker is newer than its migrations says which command fixes it", async () => {
  const db = realDb({ throughMigration: 18 });
  const testEnv = env(db);
  const [status, payload] = await json(await worker.fetch(post("/auth/recover/options", { code: "AAAAA-BBBBB-CCCCC-DDDDD" }), testEnv));
  assert.equal(status, 503, "not a 500, and not a silent 403 that reads as a wrong code");
  assert.match(payload.error, /migration 0019/);
  assert.equal(payload.unrecoverable, false, "this is a missing upgrade, not a lost brain");
});

/* ------------------------------------------------- the surrounding promises */

test("the last enrolled passkey still cannot be revoked, card or no card", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { credential, cookie } = await installWithOneDevice(testEnv);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL").get().n, RECOVERY_CODE_COUNT);

  const [, verdict] = await json(await worker.fetch(post("/api/app/devices/revoke", {
    credential_id: credential.credentialId,
  }, app(cookie)), testEnv));
  assert.equal(verdict.removed, false, "a recovery card is a break-glass, not a licence to leave zero devices");
  assert.match(verdict.reason, /refusing to remove the last passkey/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM owner_passkeys").get().n, 1);
});

test("printing a new card kills the old one, and only someone already inside can print", async () => {
  const db = realDb();
  const testEnv = env(db);
  const { codes, cookie } = await installWithOneDevice(testEnv);

  // No session, no card.
  const [anonymous] = await json(await worker.fetch(post("/api/app/recovery-codes", {}, { "X-Brain-App": "1" }), testEnv));
  assert.equal(anonymous, 401);

  const [status, fresh] = await json(await worker.fetch(post("/api/app/recovery-codes", {}, app(cookie)), testEnv));
  assert.equal(status, 200);
  assert.equal(fresh.recovery_codes.length, RECOVERY_CODE_COUNT);
  assert.equal(fresh.recovery_codes.some((code) => codes.includes(code)), false);

  loseEveryDevice(db);
  const [dead] = await json(await worker.fetch(post("/auth/recover/options", { code: codes[0] }), testEnv));
  assert.equal(dead, 403, "the old card is dead the moment a new one is printed");
  const [alive] = await json(await worker.fetch(post("/auth/recover/options", { code: fresh.recovery_codes[0] }), testEnv));
  assert.equal(alive, 200);
});

test("the operator can print a card at install, and only with the admin key", async () => {
  const db = realDb();
  const testEnv = env(db);
  await installWithOneDevice(testEnv);

  const [refused] = await json(await worker.fetch(post("/api/admin/auth/recovery-codes", {}), testEnv));
  assert.equal(refused, 401, "the admin route is behind the key gate like every other admin route");

  const [status, payload] = await json(await worker.fetch(
    post("/api/admin/auth/recovery-codes", {}, { "X-Admin-Key": ADMIN }), testEnv));
  assert.equal(status, 200);
  assert.equal(payload.recovery_codes.length, RECOVERY_CODE_COUNT);
  // No new power: the same key can already mint an invite that enrols a device.
  const invite = await worker.fetch(post("/api/admin/auth/invite", {}, { "X-Admin-Key": ADMIN }), testEnv);
  assert.equal(invite.status, 200);
});

/* ------------------------------------------------ the owner-facing surface */

test("the page carries the escape hatch and the honest limits, and its script parses", async () => {
  const page = await worker.fetch(new Request(ORIGIN + "/app"), env(realDb()));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Lost the device you sign in with\?/);
  assert.match(html, /id="rcode"/, "somewhere to type the code, on the screen of someone locked out");
  assert.match(html, /shown once and cannot be shown again/);
  assert.match(html, /no recovery codes left/);

  // The page is one inline script under a CSP that forbids fetching another.
  // A syntax error would take the whole owner surface down with no server-side
  // signal at all, so the shipped bytes are parsed here.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script);
});
