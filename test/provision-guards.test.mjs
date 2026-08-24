// Guards from Jay's field test, 2026-08-18.
//
// Two of his findings were about provisioning reaching something that is not
// ours, and both are tested here by CALLING the real functions, not by grepping
// the source. A source assertion cannot tell a working guard from a deleted one.

import {
  chooseDbName, assertAdoptable, documentCountOf, ensureMetadataIndex, VECTOR_METADATA_INDEXES,
  driveExclusionIdsOf, driveConnectorConfig, completedDriveFamilyPlans, sourceCursorCanAdvance,
  remoteFamilyOutcomes, assertDriveLimitSafe, assertRemoteLimitSafe, validateBatchReceipt, postSourceReceipt,
  validateForgetReceipt, assertNoPendingRemovals, credentialRefusalOf, drivePolicyFingerprint,
  driveSyncDecision, listStoredSourceFamilies, credentialScannerFingerprint, postSourceExpectation,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e.message || String(e); } };

check("destructive previews report documents rather than chunks", documentCountOf({ documents: 981, chunks: 14753, total: 14753 }) === 981);
check("older document receipts still have a count", documentCountOf({ total: 42 }) === 42);

/* ---- Drive transition policy is portable but never silently optional ---- */
{
  const receipt = { lanes: { drive: { migration_policy: { excluded_drive_file_ids: ["dup-2", "bad-1", "dup-2"] } } } };
  check("a migration receipt yields a unique exact Drive exclusion list",
    driveExclusionIdsOf(receipt).join(",") === "bad-1,dup-2", JSON.stringify(driveExclusionIdsOf(receipt)));
  const cfg = driveConnectorConfig({
    corpora: { google_drive: { exclude_file_ids: ["inline-1"], exclude_file_ids_file: "receipt.json", exclude_paths: ["Legal/Sealed"] } },
    safety: { private_path_prefixes: ["_private"] },
  }, "/tmp/client/brain.manifest.json", () => JSON.stringify(receipt));
  check("inline and receipt exclusions are combined", cfg.excludeFileIds.join(",") === "bad-1,dup-2,inline-1", JSON.stringify(cfg));
  check("Drive receives path and private-prefix policy from the standard manifest",
    cfg.excludePaths[0] === "Legal/Sealed" && cfg.privatePrefixes[0] === "_private", JSON.stringify(cfg));

  const policyFingerprint = drivePolicyFingerprint(cfg);
  check("credential scanner mode is part of Drive policy identity",
    drivePolicyFingerprint(cfg, true) !== drivePolicyFingerprint(cfg, false));
  check("credential scanner version is a durable rescan marker",
    credentialScannerFingerprint(true, 2) !== credentialScannerFingerprint(true, 3));
  const freshDecision = driveSyncDecision({
    syncToken: "cursor", policyFingerprint, savedPolicyFingerprint: policyFingerprint,
    lastFullSweepAt: "2026-08-22T12:00:00.000Z", now: Date.parse("2026-08-23T12:00:00.000Z"),
  });
  check("a recent full sweep with unchanged policy may use the Drive change feed", freshDecision.incremental === true,
    JSON.stringify(freshDecision));
  check("a Drive policy change forces a complete comparison",
    driveSyncDecision({ syncToken: "cursor", policyFingerprint, savedPolicyFingerprint: "old", lastFullSweepAt: "2026-08-23T00:00:00Z" }).incremental === false);
  check("a weekly Drive truth sweep is forced even when the change token still exists",
    driveSyncDecision({
      syncToken: "cursor", policyFingerprint, savedPolicyFingerprint: policyFingerprint,
      lastFullSweepAt: "2026-08-01T00:00:00Z", now: Date.parse("2026-08-23T00:00:00Z"),
    }).incremental === false);

  const boundarySecret = `sk-proj-${"A7".repeat(16)}`;
  const logicalEnvelope = { content: `${"x".repeat(399_990)} ${boundarySecret}` };
  const refusal = credentialRefusalOf(logicalEnvelope, true);
  check("credential refusal scans the complete logical document before size splitting",
    refusal?.labels?.includes("openai_api_key") && !refusal.reason.includes(boundarySecret), JSON.stringify(refusal));

  const plans = [
    { stateKey: "drive:a", expectedParts: 2 },
    { stateKey: "drive:b", expectedParts: 1 },
  ];
  const complete = completedDriveFamilyPlans(plans, new Map([["drive:a", 1], ["drive:b", 1]]));
  check("split-family cleanup waits for every replacement part", complete.length === 1 && complete[0].stateKey === "drive:b", JSON.stringify(complete));
  check("a document-level failure keeps the source cursor retryable", sourceCursorCanAdvance({ failed: 1 }) === false);
  check("a fully accepted batch may advance its source cursor", sourceCursorCanAdvance({ failed: 0 }) === true);

  const crossing = [{ stateKey: "drive:large", expectedParts: 3 }];
  let outcome = remoteFamilyOutcomes(crossing, new Map([["drive:large", 2]]), new Map([["drive:large", 2]]));
  check("a split family crossing batches remains pending", outcome.completed.length === 0 && outcome.incomplete.length === 0,
    JSON.stringify(outcome));
  outcome = remoteFamilyOutcomes(crossing, new Map([["drive:large", 3]]), new Map([["drive:large", 3]]));
  check("a streamed family completes only after every part is accepted", outcome.completed.length === 1 && outcome.incomplete.length === 0,
    JSON.stringify(outcome));
  outcome = remoteFamilyOutcomes(crossing, new Map([["drive:large", 3]]), new Map([["drive:large", 2]]));
  check("a sent family with a failed part remains retryable", outcome.completed.length === 0 && outcome.incomplete.length === 1,
    JSON.stringify(outcome));

  check("a limited first Drive sync is safe as a preview",
    (await throws(() => assertDriveLimitSafe({ limit: 10, dryRun: true, incremental: false }))) === null);
  const unsafeIncrementalLimit = await throws(() => assertDriveLimitSafe({ limit: 10, dryRun: false, incremental: true }));
  check("a real limited incremental Drive sync is refused too",
    /complete result window/.test(unsafeIncrementalLimit || ""), unsafeIncrementalLimit);
  const unsafeLimit = await throws(() => assertDriveLimitSafe({ limit: 10, dryRun: false, incremental: false }));
  check("a real limited first Drive walk is refused", /permanently/.test(unsafeLimit || ""), unsafeLimit);
  const unsafeGmailLimit = await throws(() => assertRemoteLimitSafe({ source: "Gmail", limit: 10, dryRun: false, incremental: true }));
  check("a real limited Gmail sync is refused before its history marker can skip messages",
    /Gmail sync/.test(unsafeGmailLimit || "") && /history marker/.test(unsafeGmailLimit || ""), unsafeGmailLimit);

  const group = [
    { envelope: { source_id: "one" } },
    { envelope: { source_id: "two" } },
  ];
  check("a complete per-document ingest receipt is accepted",
    validateBatchReceipt({ results: [
      { source_id: "one", status: "created" },
      { source_id: "two", status: "unchanged" },
    ] }, group).length === 2);
  const missingReceipt = await throws(() => validateBatchReceipt({
    failed: 0,
    results: [{ source_id: "one", status: "created" }],
  }, group));
  check("a top-level zero-failure counter cannot hide an unacknowledged document",
    /not acknowledged/.test(missingReceipt || ""), missingReceipt);
  const falseSuccess = await throws(() => validateBatchReceipt({
    failed: 0,
    results: [
      { source_id: "one", status: "created" },
      { source_id: "two", status: "failed" },
    ],
  }, group));
  check("an explicit failed result remains a valid receipt that the cursor tally can see", falseSuccess === null, falseSuccess);

  check("a real forget receipt is accepted", validateForgetReceipt({
    dry_run: false, documents: 1, chunks: 3, vectors: 3, targets: ["drive:one"],
  }).documents === 1);
  for (const [label, receipt] of [
    ["HTML-shaped absence", null],
    ["empty JSON", {}],
    ["dry run", { dry_run: true, documents: 1, chunks: 1, vectors: 1, targets: [] }],
    ["missing counts", { dry_run: false, targets: [] }],
    ["missing targets", { dry_run: false, documents: 0, chunks: 0, vectors: 0 }],
  ]) {
    const invalid = await throws(() => validateForgetReceipt(receipt));
    check(`${label} cannot masquerade as a confirmed deletion`, invalid !== null, invalid);
  }
  const pendingRemoval = await throws(() => assertNoPendingRemovals({ pending: 2 }, "test removal"));
  check("an unconfirmed cleanup withholds the source cursor", /not advanced/.test(pendingRemoval || ""), pendingRemoval);
}

/* ---- full-sweep source inventory is authenticated, complete, and paged ---- */
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), key: options?.headers?.["X-Admin-Key"] });
    const cursor = new URL(String(url)).searchParams.get("cursor");
    const body = cursor
      ? { source: "drive", families: ["drive:c"], next_cursor: null }
      : { source: "drive", families: ["drive:a", "drive:b"], next_cursor: "drive:b" };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const families = await listStoredSourceFamilies({ base: "https://brain.example", adminKey: "admin-only", source: "drive" });
    check("a full source inventory follows every page", [...families].join(",") === "drive:a,drive:b,drive:c", [...families].join(","));
    check("source inventory uses only the brain admin credential", calls.length === 2 && calls.every((call) => call.key === "admin-only"), JSON.stringify(calls));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ---- connector lifecycle uses the brain admin route, not Cloudflare control ---- */
{
  let seen = null;
  const request = async (url, options, policy) => {
    seen = { url, options, policy, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ source: "drive", status: "indexing", run_id: "run_1" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const out = await postSourceReceipt("https://brain.example", "admin-only", {
    source: "drive", kind: "drive", status: "indexing", run_id: "run_1", lane: "incremental",
  }, request);
  check("source lifecycle posts to the authenticated Worker route",
    seen?.url === "https://brain.example/api/admin/brain/source-receipt" && seen.options.headers["X-Admin-Key"] === "admin-only", JSON.stringify(seen));
  check("source lifecycle never sends a Cloudflare bearer token",
    !seen.options.headers.Authorization && out.run_id === "run_1", JSON.stringify(seen.options.headers));
  check("source lifecycle uses a bounded request", seen.policy?.timeoutMs === 30000, JSON.stringify(seen.policy));

  const bad = await throws(() => postSourceReceipt("https://brain.example", "k", { status: "ready" }, async () =>
    new Response(JSON.stringify({ status: "error" }), { status: 200 })));
  check("a mismatched lifecycle acknowledgement is not believed", /not accepted/.test(bad || ""), bad);
  const wrongIdentity = await throws(() => postSourceReceipt("https://brain.example", "k", {
    source: "drive", status: "ready", run_id: "run_expected",
  }, async () => new Response(JSON.stringify({
    source: "other", status: "ready", run_id: "run_other",
  }), { status: 200 })));
  check("a lifecycle acknowledgement for another source or run is not believed",
    /not accepted/.test(wrongIdentity || ""), wrongIdentity);

  const expectation = await postSourceExpectation("https://brain.example", "admin-only", {
    source: "drive", kind: "drive", expected_refresh_seconds: 86_400,
  }, async () => new Response(JSON.stringify({
    source: "drive", kind: "drive", expected_refresh_seconds: 86_400,
  }), { status: 200 }));
  check("the scheduler can set its exact source freshness expectation",
    expectation.expected_refresh_seconds === 86_400, JSON.stringify(expectation));
  const wrongExpectation = await throws(() => postSourceExpectation("https://brain.example", "admin-only", {
    source: "drive", kind: "drive", expected_refresh_seconds: null,
  }, async () => new Response(JSON.stringify({
    source: "drive", kind: "drive", expected_refresh_seconds: 86_400,
  }), { status: 200 })));
  check("a mismatched freshness acknowledgement is not believed",
    /not accepted/.test(wrongExpectation || ""), wrongExpectation);
}

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

  for (const name of ["cmdEval", "cmdDiagnose", "cmdDrain", "cmdReindex", "cmdHealth", "cmdIngestRemote"]) {
    const b = bodyOf(name);
    check(`${name} exists`, b !== null);
    if (!b) continue;
    check(`${name} does not demand a Cloudflare token when the manifest has a domain`,
      !/^\s*const acct = await resolveAccount\(m\);/m.test(b),
      "it resolves the account unconditionally");
    check(`${name} resolves the account only as a fallback`,
      /m\.brain\?\.domain \? null : await resolveAccount\(m\)/.test(b));
  }

  const remote = bodyOf("cmdIngestRemote");
  const local = bodyOf("cmdIngest");
  check("an incomplete local walk aborts before any source-truth cleanup",
    /if \(!walkComplete\)[\s\S]*nothing was sent and no prior document was removed/.test(local || ""),
    String(local).slice(0, 1200));
  check("local cleanup is limited to explicit private policy and credential refusal",
    /privateRemovalKeys/.test(local || "") && /intentionalRemovalKeys/.test(local || "") &&
      !/vanishedLocalKeys/.test(local || ""), String(local).slice(0, 1800));
  check("a limited local run cannot falsely commit a scanner migration",
    /scannerPolicyChanged && limitedMissesPrior/.test(local || "") &&
      /--limit cannot be used/.test(local || ""), String(local).slice(0, 1800));
  const localCleanupConfirmed = String(local).indexOf('assertNoPendingRemovals(localRemoval');
  const localScannerCommitted = String(local).indexOf('state.credential_scanner_fingerprint = scannerFingerprint');
  check("local scanner policy commits only after confirmed refusal cleanup",
    localCleanupConfirmed !== -1 && localScannerCommitted > localCleanupConfirmed,
    `cleanup=${localCleanupConfirmed} commit=${localScannerCommitted}`);
  check("remote ingest opens freshness through the Worker before reading Google",
    /status: "indexing"/.test(remote || "") && /postSourceReceipt/.test(remote || ""), String(remote).slice(0, 200));
  check("a thrown Drive or Gmail fetch posts an error receipt",
    /catch \(error\)[\s\S]*status: "error"/.test(remote || ""), String(remote).slice(-500));
  check("remote ingest no longer writes source state through Cloudflare D1 control APIs",
    !/recordSource(?:Start|Finish)/.test(remote || ""), String(remote).slice(0, 200));
  check("remote dry-run skips account, base URL, and admin-key resolution",
    /const acct = dry \? null/.test(remote || "") &&
      /const base = dry \? null/.test(remote || "") &&
      /const adminKey = dry \? null/.test(remote || ""),
    String(remote).slice(0, 900));
  check("remote ingest streams bounded groups instead of retaining a ready corpus",
    /for await \(const group of batchStream/.test(remote || "") &&
      /await consumeGroup\(group\)/.test(remote || "") &&
      !/const ready = \[\]/.test(remote || ""),
    String(remote).slice(0, 900));
  const versionCheck = String(remote).indexOf("state.done[key] === listedVersion");
  const driveDownload = String(remote).indexOf("drive.toEnvelope");
  check("a Drive sweep checks listing metadata before downloading bytes",
    versionCheck !== -1 && driveDownload !== -1 && versionCheck < driveDownload,
    `version=${versionCheck} download=${driveDownload}`);

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
