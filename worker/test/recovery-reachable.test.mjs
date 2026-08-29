/**
 * A way back in that nobody can find is not a way back in.
 *
 * The recovery ceremony works — worker/test/recovery-codes.test.mjs proves it
 * against a real database with every passkey row deleted. What it did not
 * prove is that the person it was built for can REACH it. Until this file, the
 * only route to /app/recover was typing the URL, which is precisely what
 * somebody standing at a sign-in button their phone can no longer satisfy
 * cannot do. This file asserts the two halves of reachability:
 *
 *   1. The signed-out screen says a way back exists and links to it, and says
 *      the two things about passkeys that decide whether a locked-out person
 *      even NEEDS recovery: that Apple and Google sync a passkey across their
 *      own devices, and that a strange computer signs in by QR from the phone
 *      that already has one. Both were documented only in a CHANGELOG entry no
 *      client can reach.
 *   2. The recovery page answers in the auth state that person is actually in:
 *      no session cookie, no admin key, no invite, and not one passkey row
 *      left in the database. A page that requires a session before it will
 *      help you get a session is furniture.
 *
 * The first half is asserted against the SHIPPED bundle in
 * worker/src/lib/app-assets.js, not against frontend/src. That file is
 * generated, and a rebuild that dropped the link while the source kept it
 * would otherwise pass — which is the exact failure this file exists to catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { APP_JS, APP_BUNDLE_ID } from "../src/lib/app-assets.js";
import { makeCredential, clientData, attestationObject } from "./webauthn-fixtures.mjs";
import { splitStatements } from "../../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const GATE_SOURCE = join(HERE, "..", "..", "frontend", "src", "components", "Gate.tsx");
const ORIGIN = "https://brain.example.test";
const RP = "brain.example.test";
const ADMIN = "admin-key-fixture-value-000";

const RECOVERY_ROUTE = "/app/recover";

/* ------------------------------------------------------------ the fixture */

/** Real SQLite behind D1's prepare/bind/first/all/run shape. */
function realDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
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
  SESSION_SIGNING_KEY: "a".repeat(64),
  BRAIN_NAME: "fixture", BRAIN_OWNER: "Priya Nair",
});

const post = (path, payload, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(payload || {}),
});

/** Invite -> enrol one device, so the brain is a real install, then lose it. */
async function installThenLoseEveryDevice(testEnv, db) {
  const invite = await (await worker.fetch(post("/api/admin/auth/invite", {}, { "X-Admin-Key": ADMIN }), testEnv)).json();
  const code = invite.url.split("#enroll=")[1];
  const options = await (await worker.fetch(post("/auth/register/options", { code }), testEnv)).json();
  const credential = await makeCredential({ rpId: RP });
  const enrolled = await worker.fetch(post("/auth/register/verify", {
    code,
    nickname: "phone",
    credentialId: credential.credentialId,
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
  }), testEnv);
  assert.equal(enrolled.status, 200, "the fixture install must actually enrol a device");
  // The phone is gone: the rows with it, and the cookie is simply not sent.
  db.raw.prepare("DELETE FROM owner_passkeys").run();
}

/* ----------------------------------------- 1. the signed-out screen says so */

test("the signed-out screen carries a route to recovery, in words, not as a bare URL", () => {
  assert.ok(
    APP_JS.includes(RECOVERY_ROUTE),
    "the shipped bundle has no link to " + RECOVERY_ROUTE + ": a locked-out owner can only reach " +
    "the ceremony by typing a URL they were never given",
  );
  // A route is not an invitation. The link needs a label a frightened person
  // reads as "this is for me", and an opener that describes their situation
  // rather than naming a feature.
  assert.ok(
    APP_JS.includes("Trouble signing in on this device?"),
    "nothing on the signed-out screen invites somebody who cannot sign in to look further",
  );
  assert.ok(
    APP_JS.includes("Use a recovery code"),
    "the link to " + RECOVERY_ROUTE + " must be labelled in human words",
  );
  assert.ok(
    APP_JS.includes("recovery card"),
    "the card is a physical object the owner was handed; the screen has to name it as one",
  );
});

test("it also says the two things that mean recovery is not needed at all", () => {
  // Both were true and both were documented only in a CHANGELOG entry that
  // ships to operators, not to the person standing at a strange computer.
  assert.ok(
    /Apple and Google copy it/.test(APP_JS),
    "a passkey syncing across the owner's own devices is the FIRST thing to try, and the screen never said it",
  );
  assert.ok(
    /scan the QR code/.test(APP_JS),
    "signing in on a brand-new computer by scanning a QR with the enrolled phone was unfindable",
  );
  assert.ok(
    /use a phone when/.test(APP_JS),
    "the QR instruction is useless without naming the browser choice that produces the QR",
  );
});

test("the shell points at the bundle that carries the link, not at a stale one", async () => {
  // app-assets.js is generated. Regenerating it from a source that lost the
  // link, or shipping a shell pinned to the previous build, both strand the
  // same person; this catches either.
  const response = await worker.fetch(new Request(ORIGIN + "/app"), env(realDb()));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(
    html.includes(`/app/assets/app.js?v=${APP_BUNDLE_ID}`),
    "the served shell asks for a different bundle than the one asserted above",
  );
});

test("the way out is secondary and never shown mid-enrolment", () => {
  // Almost everybody who sees this screen is signing in normally. Recovery
  // sits below the button, and a client enrolling for the first time has no
  // card yet, so offering them one would only frighten them.
  const source = readFileSync(GATE_SOURCE, "utf8");
  const button = source.indexOf('onClick={go}');
  const disclosure = source.indexOf("Trouble signing in on this device?");
  assert.ok(button > 0 && disclosure > 0, "both the sign-in button and the disclosure must exist");
  assert.ok(disclosure > button, "recovery must sit after the primary action, not compete with it");
  assert.match(
    source.slice(0, disclosure).split("\n").reverse().join("\n"),
    /\{!enrolling &&/,
    "the disclosure must be withheld from someone enrolling their first device",
  );
});

/* -------------------------- 2. reachable in the state a locked-out person is in */

test("every public owner-surface path reaches its handler, recovery included", async () => {
  // The router matches "/app" exactly and lists its siblings by hand, so a new
  // public path added inside the handler falls through to the admin-key gate
  // and 401s. That has now happened three times. /app/recover is the third,
  // and it is the one where the 401 lands on somebody already locked out.
  const testEnv = env(realDb());
  for (const path of ["/app", RECOVERY_ROUTE, "/brand/og.svg", "/app/assets/app.js", "/app/assets/app.css"]) {
    const response = await worker.fetch(new Request(ORIGIN + path), testEnv);
    assert.notEqual(response.status, 401, `${path} is behind the key gate; a client holds no admin key`);
    assert.equal(response.status, 200, `${path} should serve`);
  }
});

test("recovery answers with no session, no key, and not one passkey left", async () => {
  const db = realDb();
  const testEnv = env(db);
  await installThenLoseEveryDevice(testEnv, db);
  assert.equal(
    db.raw.prepare("SELECT COUNT(*) AS n FROM owner_passkeys").get().n, 0,
    "the fixture must really be a brain with nothing left to sign in with",
  );

  // Exactly what that person's browser sends: a GET, and nothing else.
  const response = await worker.fetch(new Request(ORIGIN + RECOVERY_ROUTE), testEnv);
  assert.equal(response.status, 200, "the page that undoes a lockout must not require being un-locked-out");
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  const html = await response.text();
  assert.match(html, /Lost the device you sign in with\?/);
  assert.match(html, /id="rcode"/, "somewhere to type the code off the card");
});

test("the recovery ceremony's own door is open to the same unauthenticated caller", async () => {
  // A page that renders for a locked-out owner but whose only button 401s is
  // the same dead end one click later.
  const db = realDb();
  const testEnv = env(db);
  await installThenLoseEveryDevice(testEnv, db);
  const response = await worker.fetch(
    post("/auth/recover/options", { code: "AAAAA-BBBBB-CCCCC-DDDDD" }, { "X-Brain-App": "1" }),
    testEnv,
  );
  assert.notEqual(response.status, 401, "the recovery ceremony must not sit behind the admin key");
  // A wrong code is refused on its own merits, which is a different answer
  // from "who are you": the caller got as far as being judged.
  const body = await response.json();
  assert.ok(body.error, "a bogus code should be refused with a reason");
  assert.ok(!/unauthorized/i.test(body.error), `refusal read as an auth gate: ${body.error}`);
});

/* -------------------------------- 3. the ordinary sign-in path is unchanged */

test("the ordinary visitor's path is exactly what it was", async () => {
  // Everything the 99% touch: the greeting, the one button, the ceremony the
  // button runs. None of it moved to make room for the disclosure.
  for (const phrase of ["Welcome back", "Sign in", "Set up with Face ID", "Waiting for your device…"]) {
    assert.ok(APP_JS.includes(phrase), `the ordinary sign-in copy lost: ${phrase}`);
  }
  for (const route of ["/auth/login/options", "/auth/login/verify", "/auth/register/options", "/auth/register/verify"]) {
    assert.ok(APP_JS.includes(route), `the sign-in ceremony lost its call to ${route}`);
  }

  const testEnv = env(realDb());
  const response = await worker.fetch(new Request(ORIGIN + "/app"), testEnv);
  const csp = response.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("unsafe-inline"), "the disclosure is markup, and must not have loosened the policy");
  assert.match(response.headers.get("Cache-Control") || "", /no-store/);
  assert.match(await response.text(), /data-owner="Priya Nair"/);
});

test("a link scanner opening the recovery page still burns nothing", async () => {
  // The link now appears on a page clients forward to each other. Fetching it
  // must stay free of side effects, as GET /app already is.
  const db = realDb();
  const testEnv = env(db);
  await installThenLoseEveryDevice(testEnv, db);
  const before = db.raw.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL").get().n;
  await worker.fetch(new Request(ORIGIN + RECOVERY_ROUTE), testEnv);
  const after = db.raw.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL").get().n;
  assert.equal(after, before, "GET on the recovery page must not consume a code");
});
