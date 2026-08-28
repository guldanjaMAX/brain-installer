import assert from "node:assert/strict";
import worker from "../src/index.js";

/* Two findings meet on this one route, and both have to hold at once.

   HONESTY: a paused brain refuses ingest on nine write paths. Reporting ok:true
   through that is what turned one client's failed update into eight days of
   silence: they added nothing, and nothing told them anything was wrong.

   PRIVACY: the same route used to name WHOSE deployment it is and exactly what
   it runs, to anyone who found the URL and sent no credential. Identity and
   version now require the admin key. The honesty fields do not, because the
   callers that read them have no credential at the moment they call. */

const base = { BRAIN_NAME: "fixture-client", BRAIN_VERSION: "0.1.18", ADMIN_KEY: "fixture-admin-key" };
const health = async (env, { key = null } = {}) => {
  const res = await worker.fetch(new Request("https://b.example/health", {
    headers: key ? { "X-Admin-Key": key } : {},
  }), env, {});
  return { res, body: await res.json() };
};

/* ---------------- an active brain reports ok */

{
  const { res, body } = await health({ ...base });
  assert.equal(res.status, 200);
  assert.equal(body.ok, true, "an unpaused brain is ok");
  assert.equal(body.status, "ok");
  assert.equal(body.accepting_documents, true);
}

/* ---------------- a paused brain says so, WITHOUT a credential */

{
  const { res, body } = await health({ ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" });
  assert.equal(
    body.ok, false,
    "a brain that cannot accept a document must not report ok:true",
  );
  assert.equal(body.status, "paused-for-upgrade");
  assert.equal(
    body.accepting_documents, false,
    "brain doctor's stuck-upgrade probe reads this field and carries no key",
  );
  assert.match(body.reason, /cannot accept documents/i, "the reason is plain language");
  assert.match(body.reason, /did not finish/i, "it names the cause, a partial update");

  // Deliberate: update's own paused-mode probe must still succeed while the
  // pause is in force, so the HTTP status stays 200 and only the body tells
  // the truth. Changing this to 503 breaks brain update.
  assert.equal(
    res.status, 200,
    "HTTP stays 200 so update's paused-mode health probe still passes",
  );
}

/* ---------------- an unauthenticated probe does not name the install */

for (const env of [{ ...base }, { ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" }]) {
  const { body } = await health(env);
  assert.equal(body.brain, undefined, "the client slug is not disclosed without a key");
  assert.equal(body.version, undefined, "the exact version is not disclosed without a key");
  assert.equal(body.vector_drain_mode, undefined, "drain state is detail, not liveness");
  assert.equal(body.vector_writer_protocol, undefined, "the writer protocol is detail too");
  assert.equal(
    body.identified, false,
    "the body says it is withholding, so a caller can tell this from an older worker",
  );
  const serialised = JSON.stringify(body);
  assert.equal(
    serialised.includes("fixture-client"), false,
    "the slug must not reach an anonymous caller by any field",
  );
  assert.equal(
    serialised.includes("0.1.18"), false,
    "the version must not reach an anonymous caller by any field",
  );
}

/* ---------------- a wrong key gets the same anonymous body, not a 401 */

{
  const { res, body } = await health({ ...base }, { key: "not-the-key" });
  assert.equal(res.status, 200, "liveness stays answerable; a bad key is not an error here");
  assert.equal(body.identified, false);
  assert.equal(body.brain, undefined, "a guessed key discloses nothing");
}

/* ---------------- the admin key unlocks exactly the fields update depends on */

for (const [env, expectedMode] of [
  [{ ...base }, "active"],
  [{ ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" }, "paused-for-upgrade"],
]) {
  const { body } = await health(env, { key: "fixture-admin-key" });
  assert.equal(body.identified, true);
  assert.equal(body.brain, "fixture-client", "the operator may know whose brain this is");
  assert.equal(body.version, "0.1.18", "cmdHealth matches on version");
  assert.equal(body.vector_writer_protocol, "lease-v1", "cmdHealth matches on protocol");
  assert.equal(body.vector_drain_mode, expectedMode, "cmdHealth matches on drain mode");
  // The honesty fields are not traded away for the detail: an authenticated
  // reader sees the pause too.
  assert.equal(body.accepting_documents, expectedMode === "active");
}

/* ---------------- the admin route alias carries the same detail */

{
  const res = await worker.fetch(new Request("https://b.example/api/admin/brain/health", {
    headers: { "X-Admin-Key": "fixture-admin-key" },
  }), { ...base, VECTOR_DRAIN_MODE: "paused-for-upgrade" }, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.brain, "fixture-client");
  assert.equal(body.version, "0.1.18");
  assert.equal(body.vector_drain_mode, "paused-for-upgrade");
  assert.equal(body.accepting_documents, false, "the alias is honest about the pause too");

  const refused = await worker.fetch(
    new Request("https://b.example/api/admin/brain/health"), { ...base }, {},
  );
  assert.equal(refused.status, 401, "the named admin route is behind the key gate");
}

/* ---------------- an unknown drain mode is not treated as paused */

{
  const { body } = await health({ ...base, VECTOR_DRAIN_MODE: "something-else" });
  assert.equal(body.ok, true, "only the exact paused sentinel means paused");
  const { body: detail } = await health(
    { ...base, VECTOR_DRAIN_MODE: "something-else" }, { key: "fixture-admin-key" },
  );
  assert.equal(detail.vector_drain_mode, "active");
}

/* ---------------- the public probe is throttled, the authenticated one is not */

{
  const probe = (key) => worker.fetch(new Request("https://b.example/health", {
    headers: { "CF-Connecting-IP": "203.0.113.7", ...(key ? { "X-Admin-Key": key } : {}) },
  }), { ...base }, {});

  let anonymousStatus = 200;
  for (let i = 0; i < 65 && anonymousStatus === 200; i++) anonymousStatus = (await probe(null)).status;
  assert.equal(anonymousStatus, 429, "a single source hammering the public probe is slowed");

  const authorised = await probe("fixture-admin-key");
  assert.equal(
    authorised.status, 200,
    "an operator holding the key is never locked out of their own health route",
  );
}

console.log("health honesty: all focused offline tests passed");
