// Guards from Jay's field test, 2026-08-18.
//
// Two of his findings were about provisioning reaching something that is not
// ours, and both are tested here by CALLING the real functions, not by grepping
// the source. A source assertion cannot tell a working guard from a deleted one.

import { chooseDbName, assertAdoptable, ensureMetadataIndex, VECTOR_METADATA_INDEXES } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e.message || String(e); } };

/* ---- the name must never be one that could belong to somebody else ---- */
{
  check("a slug-scoped name is accepted", chooseDbName({ d1_database_name: "bhakta-brain" }, "bhakta") === "bhakta-brain");
  check("no name falls back to <slug>-brain", chooseDbName({}, "bhakta") === "bhakta-brain");

  const bare = await throws(() => chooseDbName({ d1_database_name: "brain" }, "bhakta"));
  check("the bare name \"brain\" is REFUSED", bare !== null, "it was accepted");
  check("and the refusal says what to use instead", /bhakta-brain/.test(bare || ""), bare);

  check("the shipped placeholder is refused", (await throws(() => chooseDbName({ d1_database_name: "REPLACE-WITH-slug-brain" }, "x"))) !== null);
  check("no slug and no name is refused rather than defaulted", (await throws(() => chooseDbName({}, undefined))) !== null);
}

/* ---- adopting: a name match is not proof of ownership ---- */
{
  const db = { uuid: "u-1" };
  const q = (tables, slug) => async (_a, _b, sql) =>
    /sqlite_master/.test(sql)
      ? { results: tables.map((name) => ({ name })) }
      : { results: slug === undefined ? [] : [{ client_slug: slug }] };

  check("an EMPTY database is adoptable (a normal provision re-run)",
    (await throws(() => assertAdoptable("a", db, "n", "bhakta", q([])))) === null);

  check("OUR OWN brain is adoptable",
    (await throws(() => assertAdoptable("a", db, "n", "bhakta", q(["install_state", "chunks"], "bhakta")))) === null);

  // Jay's actual case: a production D1 that merely shares the name.
  const stranger = await throws(() => assertAdoptable("a", db, "brain", "bhakta", q(["ledger", "accounts", "postings"])));
  check("a STRANGER's database is refused", stranger !== null, "it was adopted");
  check("and the refusal names what it found, so the operator can tell", /ledger/.test(stranger || ""), stranger);
  check("and says nothing was changed", /Nothing has been changed/.test(stranger || ""), stranger);

  // Worse than co-tenancy: migrate's client_slug upsert would relabel their install.
  const other = await throws(() => assertAdoptable("a", db, "n", "bhakta", q(["install_state"], "someone-else")));
  check("ANOTHER CLIENT's brain is refused", other !== null, "it was adopted");
  check("and the refusal names the real owner", /someone-else/.test(other || ""), other);

  const blind = await throws(() => assertAdoptable("a", db, "n", "bhakta", async () => { throw new Error("no access"); }));
  check("an UNREADABLE database is refused rather than adopted blind", blind !== null, "it was adopted");
}

/* ---- the metadata index cannot be added later, so provision must not continue without it ---- */
{
  const noSleep = async () => {};

  check("the full retrieval contract is provisioned before ingest",
    JSON.stringify(VECTOR_METADATA_INDEXES) === JSON.stringify([
      { propertyName: "source", indexType: "string" },
      { propertyName: "client", indexType: "string" },
      { propertyName: "category", indexType: "string" },
      { propertyName: "top_folder", indexType: "string" },
      { propertyName: "platform", indexType: "string" },
      { propertyName: "document_date", indexType: "number" },
    ]), JSON.stringify(VECTOR_METADATA_INDEXES));
  check("the contract stays within Vectorize's ten-index limit", VECTOR_METADATA_INDEXES.length <= 10);
  check("metadata index names are unique", new Set(VECTOR_METADATA_INDEXES.map((x) => x.propertyName)).size === VECTOR_METADATA_INDEXES.length);

  let created = 0;
  const okRes = await ensureMetadataIndex({ create: async () => { created++; }, sleep: noSleep, log: () => {} });
  check("a clean create succeeds on the first attempt", okRes === true && created === 1, `created=${created}`);

  let n = 0;
  const flaky = await ensureMetadataIndex({
    create: async () => { if (++n < 3) throw new Error("500 upstream"); }, sleep: noSleep, log: () => {},
  });
  check("a transient failure is RETRIED rather than fataled", flaky === true && n === 3, `attempts=${n}`);

  let fatal = null, tries = 0;
  await ensureMetadataIndex({
    create: async () => { tries++; throw new Error("500 upstream"); },
    sleep: noSleep, log: () => {}, onFatal: (m) => { fatal = m; },
  });
  check("a persistent failure is FATAL, it does not warn and continue", fatal !== null, "it continued");
  check("and only after exhausting the retries", tries === 3, `tries=${tries}`);
  check("and the message says it cannot be added later", /CANNOT be added later/.test(fatal || ""), fatal);
  check("and tells the operator re-running provision is free", /costs nothing/.test(fatal || ""), fatal);

  let f2 = null;
  const already = await ensureMetadataIndex({
    create: async () => { throw new Error("metadata index already exists"); },
    sleep: noSleep, log: () => {}, onFatal: (m) => { f2 = m; },
  });
  check("an already-present index is success, not a failure", already === true && f2 === null);

  let polls = 0;
  const activated = await ensureMetadataIndex({
    propertyName: "platform", create: async () => {},
    exists: async () => ++polls === 3, verifyAttempts: 3,
    sleep: noSleep, log: () => {},
  });
  check("an asynchronous metadata index is polled until active", activated === true && polls === 3, `polls=${polls}`);

  let inactiveFatal = null;
  await ensureMetadataIndex({
    propertyName: "document_date", indexType: "number", create: async () => {},
    exists: async () => false, verifyAttempts: 2,
    sleep: noSleep, log: () => {}, onFatal: (m) => { inactiveFatal = m; },
  });
  check("provision refuses an index that was requested but never active", /never became active/.test(inactiveFatal || ""), inactiveFatal);
}

/* ---- every install asks for the Vectorize permission proven live on 2026-08-23 ---- */
{
  const fs = await import("node:fs/promises");
  const u = (f) => new URL("../" + f, import.meta.url);
  const brain = await fs.readFile(u("brain.mjs"), "utf-8");
  const readme = await fs.readFile(u("README.md"), "utf-8");
  const tmpl = await fs.readFile(u("templates/brain.manifest.json"), "utf-8");
  const doctor = await fs.readFile(u("doctor.mjs"), "utf-8");

  for (const [name, txt] of [["README.md", readme], ["templates/brain.manifest.json", tmpl]])
    check(`${name} includes Vectorize Edit in the scoped token`, /Vectorize(?::)?\s+(?:Edit|edit)/.test(txt), `${name} omitted it`);

  check("the installer does not claim tokens cannot reach Vectorize", !/no API token can reach Vectorize/i.test(brain));

  check("the Vectorize remedy exists in exactly one place", (doctor.match(/export const VECTORIZE_REMEDY/g) || []).length === 1);
  check("and brain.mjs uses that constant rather than its own copy", /VECTORIZE_REMEDY/.test(brain));
  check("the token scope list is a shared constant too", /export const CF_TOKEN_SCOPES/.test(doctor));
  check("deploy sends the manifest chunk size to every Worker", /name: "CHUNK_SIZE"[\s\S]{0,160}m\.retrieval\?\.chunk_size/.test(brain));
  check("deploy sends the manifest overlap to every Worker", /name: "CHUNK_OVERLAP"[\s\S]{0,160}m\.retrieval\?\.chunk_overlap/.test(brain));
}


/* ---- 6c: the admin key must not land somewhere hostile ---- */
{
  const { assertKeyDirSafe, VALUE_FLAGS } = await import("../brain.mjs");
  const bad = (d) => { try { assertKeyDirSafe(d); return null; } catch (e) { return e.message; } };

  // The literal directory the field test was run from.
  check("refuses C:\\Windows\\system32", bad("C:\\Windows\\system32") !== null, "allowed");
  check("refuses Program Files", bad("C:\\Program Files\\thing") !== null, "allowed");
  check("refuses /usr/local", bad("/usr/local") !== null, "allowed");
  check("refuses /etc", bad("/etc") !== null, "allowed");
  check("and says where to run it instead", /folder you own/.test(bad("C:\\Windows\\system32") || ""));
  check("allows an ordinary home folder", bad("/Users/someone/brain") === null, bad("/Users/someone/brain"));
  check("allows a Windows home folder", bad("C:\\Users\\evtra\\brain-install") === null);

  /* ---- 6f: a value-taking flag given bare must be refused at parse time ---- */
  for (const f of ["path", "limit", "from", "manifest", "port", "source"])
    check(`--${f} is known to need a value`, VALUE_FLAGS.has(f));
  check("--report is deliberately NOT in the set (bare means the default name)", !VALUE_FLAGS.has("report"));
}

/* ---- an anticipated failure is not a crash ---- */
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../brain.mjs", import.meta.url), "utf-8");
  const i = src.indexOf("if (e instanceof Fatal) {");
  const block = src.slice(i, i + 900);
  check("a Fatal prints on stdout, so PowerShell does not dress it up as a crash",
    /console\.log\(`\$\{c\.red\("fail"\)\}/.test(block), block.slice(0, 160));
  check("and still exits 1, because that is the machine-readable part", /process\.exit\(1\)/.test(block));
}


/* ---- custody: the commands that prove the brain works must outlive our token ---- */
{
  // The acceptance suite and the quality test exist so a client can verify their
  // own install AFTER our access is revoked at handoff. A command that proves
  // the brain works, but only while we still hold a key to their account, proves
  // the wrong thing.
  //
  // Sliced PER FUNCTION rather than grepped across the file. A whole-file
  // assertion is what let the dry-run regression pass while the remote path was
  // still broken: its slice spanned two functions and matched the fixed one.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../brain.mjs", import.meta.url), "utf-8");
  const bodyOf = (name) => {
    const i = src.indexOf(`async function ${name}(`);
    if (i === -1) return null;
    const nxt = src.indexOf("\nasync function ", i + 20);
    return src.slice(i, nxt === -1 ? src.length : nxt);
  };

  for (const name of ["cmdEval", "cmdDiagnose", "cmdDrain", "cmdReindex", "cmdHealth"]) {
    const b = bodyOf(name);
    check(`${name} exists`, b !== null);
    if (!b) continue;
    check(`${name} does not demand a Cloudflare token when the manifest has a domain`,
      !/^\s*const acct = await resolveAccount\(m\);/m.test(b),
      "it resolves the account unconditionally");
    check(`${name} resolves the account only as a fallback`,
      /m\.brain\?\.domain \? null : await resolveAccount\(m\)/.test(b));
  }

  // And the ones that genuinely need Cloudflare should NOT have been changed.
  for (const name of ["cmdProvision", "cmdDeploy", "cmdMigrate"]) {
    const b = bodyOf(name);
    check(`${name} still requires Cloudflare, as it must`,
      b !== null && /const acct = await resolveAccount\(m\);/.test(b));
  }
}

/* ---- the quality test must never ship someone else's questions ---- */
{
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf-8"));
  const files = pkg.files || [];
  check("the eval runner ships, so a client can actually run it",
    files.includes("eval/run.mjs") && files.includes("eval/scorer.mjs"));
  check("a blank question template ships", files.includes("eval/golden/TEMPLATE.golden.json"));
  check("no real golden set is in the allowlist",
    !files.some((f) => /eval\/golden\//.test(f) && !/TEMPLATE/.test(f)),
    JSON.stringify(files.filter((f) => /golden/.test(f))));
  check("no baselines are in the allowlist", !files.some((f) => /baselines/.test(f)));
  check("no local config is in the allowlist", !files.some((f) => /config\.local/.test(f)));
}

console.log(`\nprovision guards: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
