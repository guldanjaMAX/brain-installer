// From Jay's second field report, 2026-08-19.
//
// `brain upgrade` probed /health, got a 200 from the worker it was REPLACING,
// printed that worker's version, and declared the new one verified:
//
//     ok deployed "bhakta-brain"
//     ok /health 200 {"ok":true,"version":"0.1.1", ...}
//     ok upgrade verified, now at 0.1.2
//
// Sixteen seconds later /health returned 0.1.2, so nothing was harmed that time.
// But the check would pass green on a deploy that genuinely failed, which makes
// it worse than no check: it converts an unknown into a false assurance.

import { healthProbeVerdict } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const V = (o) => healthProbeVerdict(o);
const body = (v) => JSON.stringify({ ok: true, brain: "x", version: v });

/* ---- the exact failure Jay saw ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("a 200 from the OLD worker is not accepted as the new one", v !== "accept", `got ${v}`);
  check("it retries instead, because propagation is normal", v === "retry", `got ${v}`);
}

/* ---- it must eventually give up rather than pass ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("if the old version is STILL serving on the last attempt, it FAILS", v === "fail", `got ${v}`);
}

/* ---- the happy path still works ---- */
{
  check("the expected version is accepted immediately",
    V({ ok: true, body: body("0.1.2"), expectVersion: "0.1.2", attempt: 1, attempts: 6 }) === "accept");
  check("a plain health check with no expectation still accepts any 200",
    V({ ok: true, body: body("0.1.1"), expectVersion: null, attempt: 1, attempts: 6 }) === "accept");
}

/* ---- a body that cannot be parsed must not be read as success ---- */
{
  const v = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("an unparseable body is not treated as the right version", v !== "accept", `got ${v}`);
  const last = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("and fails once the attempts are spent", last === "fail", `got ${last}`);
}

/* ---- a version-less body is not a pass either ---- */
{
  const v = V({ ok: true, body: JSON.stringify({ ok: true }), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("a 200 carrying no version at all fails rather than passing", v === "fail", `got ${v}`);
}

/* ---- non-200s keep the old retry behaviour ---- */
{
  check("a 404 retries while attempts remain", V({ ok: false, body: "", attempt: 1, attempts: 6 }) === "retry");
  check("and fails when they are spent", V({ ok: false, body: "", attempt: 6, attempts: 6 }) === "fail");
}

console.log(`\nupgrade verification: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
