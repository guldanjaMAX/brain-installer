// WHAT THIS FILE COVERS, PLAINLY: it npm-packs the repo (`npm pack --dry-run`)
// and checks the resulting file LIST against a reviewed allowlist (`expected`,
// below), plus a private-identity text scan (`privateIdentityRules`) run only
// over those same `expected` (npm-shipped) files. That scan exists to stop a
// real name from reaching every future `npm install` of this public package.
//
// WHAT THIS FILE DOES NOT COVER: this repo (guldanjaMAX/brain-installer) is a
// PUBLIC GitHub repo, and its full git history — every commit, on every
// branch, including files npm never ships — is publicly readable regardless
// of what `npm pack` includes. This file does NOT scan `test/`, `evidence/`,
// `docs/release-evidence/`, `planning/` (though planning/ is gitignored), or
// any other non-shipped path for the same real-name leak. A name landing in
// ANY committed file is a real exposure the moment it is pushed, not only a
// name that ships via npm install.
//
// Why the scan was not widened to cover test/+evidence/ when this comment was
// added (2026-08-27, see evidence/WP-00-closeout.md): `privateIdentityRules`
// already matches collaborator names (Jay, Bhakta) that appear intentionally
// and by design in dozens of already-committed test/evidence files describing
// real product usage (Jay Bhakta co-owns this venture and his own install is
// a running example throughout the suite) — at last count, 33+ lines across
// 10+ files outside `expected`. Applying the same denylist to test/+evidence/
// as-is would fail the whole suite on those pre-existing, accepted mentions,
// not on anything this pass introduced. Fixing that correctly needs either a
// second, narrower denylist (only truly-private third-party names, e.g. an
// end client's name like the one this pass just scrubbed) with its own
// allowlist for legitimate collaborator mentions, or a per-file review pass —
// both real design decisions, not a mechanical extension of this test. That
// is left for a human to decide and scope deliberately, not bundled into an
// unrelated fix. Until then: treat every commit to test/, evidence/, and any
// other non-shipped path as needing the SAME manual "does this name a real
// third party" check this pass just did by hand, before it is pushed.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
const reviewedBundles = new Map([
  ["@e965/xlsx", "0.20.3"],
  ["fflate", "0.8.3"],
  ["postal-mime", "3.0.0"],
  ["unpdf", "1.8.1"],
]);
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: ROOT,
  encoding: "utf-8",
  // Windows resolves npm through npm.cmd. Current Node releases require batch
  // files to run through the platform shell; every argument here is fixed.
  shell: process.platform === "win32",
  timeout: 60_000,
});

let files = [];
try {
  files = JSON.parse(packed.stdout)?.[0]?.files?.map((entry) => entry.path) || [];
} catch {
  // The failure below includes npm's own diagnostic without inventing a second
  // parse error that hides the useful cause.
}

const forbidden = files.filter((path) =>
  /(^|\/)(instances|eval\/baselines)(\/|$)/i.test(path) ||
  (/^eval\/golden\//i.test(path) && path !== "eval/golden/TEMPLATE.golden.json") ||
  /james|readiness|\.brain-(?:migration|ingest|drive-live-fixture)|brain-support-|support-bundle/i.test(path)
);
// Exact package inventory. package.json must use directory entries for npm's
// packer, but this test is the real allowlist: adding any file under one of
// those directories fails until a reviewer names it here deliberately.
const expected = [
  "CHANGELOG.md",
  "README.md",
  "acceptance.mjs",
  "brain.mjs",
  "components/brain-mcp.mjs",
  "components/brain-mcp-runtime.mjs",
  "components/brain-http.mjs",
  "connectors/gmail.mjs",
  "connectors/imessage.mjs",
  "connectors/iphone-backup.mjs",
  "connectors/google-auth.mjs",
  "connectors/google-calendar.mjs",
  "connectors/google-drive.mjs",
  "connectors/keychain-write.exp",
  "connectors/zoom.mjs",
  "connectors/whatsapp.mjs",
  "docs/ARCHITECTURE.md",
  "docs/COMPETITIVE-BENCHMARK.md",
  "docs/ENGINEERING-STANDARDS.md",
  "docs/EVALUATION.md",
  "docs/MAINTAINER.md",
  "docs/RECOVERY.md",
  "docs/LEGACY-SUPABASE-EXIT.md",
  "docs/README-developer.md",
  "docs/decisions/000-template.md",
  "docs/decisions/001-cloudflare-native-standard.md",
  "docs/decisions/002-paused-bootstrap-acceleration.md",
  "docs/decisions/README.md",
  "doctor.mjs",
  "eval/brain-client.mjs",
  "eval/corpus-contract.mjs",
  "eval/eval.config.json",
  "eval/golden/TEMPLATE.golden.json",
  "eval/golden-20.mjs",
  "eval/golden-validation.mjs",
  "eval/profile.mjs",
  "eval/run.mjs",
  "eval/schema/corpus-contract-v1.schema.json",
  "eval/schema/eval-suite-v2.schema.json",
  "eval/schema/gate-policy-v1.schema.json",
  "eval/schema/run-artifact-v2.schema.json",
  "eval/scorer.mjs",
  "ingest/bank-export.mjs",
  "ingest/doc-date.mjs",
  "ingest/envelope-batching.mjs",
  "ingest/extract.mjs",
  "ingest/ics.mjs",
  "ingest/formats.mjs",
  "ingest/mbox.mjs",
  "ingest/message-session.mjs",
  "ingest/pdf-child.mjs",
  "ingest/quality.mjs",
  "ingest/rtf.mjs",
  "ingest/run.mjs",
  "ingest/sms-backup.mjs",
  "ingest/whatsapp-export.mjs",
  "manifest.schema.json",
  "migrations/d1/0001_install_state.sql",
  "migrations/d1/0002_llm_call_log.sql",
  "migrations/d1/0003_sources.sql",
  "migrations/d1/0004_corpus.sql",
  "migrations/d1/0005_vector_id.sql",
  "migrations/d1/0006_freshness.sql",
  "migrations/d1/0007_filter_metadata.sql",
  "migrations/d1/0008_vector_delete_outbox.sql",
  "migrations/d1/0009_document_content_hash_index.sql",
  "migrations/d1/0010_vector_outbox_generation.sql",
  "migrations/d1/0011_vector_drain_lease.sql",
  "migrations/d1/0012_vector_visibility_receipts.sql",
  "migrations/d1/0013_accelerated_vector_bootstrap.sql",
  "migrations/d1/0014_owner_passkeys.sql",
  "migrations/d1/0015_financial_ledger.sql",
  "migrations/d1/0016_bank_feed.sql",
  "onboarding/01-intake-RUNBOOK.md",
  "onboarding/01-intake-questionnaire.md",
  "onboarding/02-client-effort-and-timeline.md",
  "onboarding/03-kickoff-and-checkins.md",
  "onboarding/04-what-it-can-and-cannot-answer.md",
  "onboarding/05-handoff-and-revocation.md",
  "onboarding/06-runbook-top-ten-failures.md",
  "onboarding/07-ingest-source-matrix.md",
  "onboarding/08-provisioning-prerequisites.md",
  "operations/admin-key-file.mjs",
  "operations/admin-key-persistence.mjs",
  "operations/cloudflare-token-store.mjs",
  "operations/session-signing-key.mjs",
  "operations/rag-proxy-key.mjs",
  "operations/curated-dual-sync.mjs",
  "operations/curated-sync-scheduler.mjs",
  "operations/drive-removal-plan.mjs",
  "operations/drive-scheduler.mjs",
  "operations/folder-scheduler.mjs",
  "operations/imessage-scheduler.mjs",
  "operations/whatsapp-daemon.mjs",
  "operations/whatsapp-drain-scheduler.mjs",
  "operations/installed-manifest.mjs",
  "operations/cloudflare-recovery-adapter.mjs",
  "operations/verified-recovery.mjs",
  "operations/windows-dpapi.ps1",
  "operations/windows-dpapi-bridge.mjs",
  "operations/windows-dpapi.cs",
  "package.json",
  "report-html.mjs",
  "report.mjs",
  "support-journal.mjs",
  "templates/brain.manifest.json",
  "worker/src/index.js",
  "worker/src/lib/app-page.js",
  "worker/src/lib/auth-store.js",
  "worker/src/lib/bank-feed.js",
  "worker/src/lib/confidence.js",
  "worker/src/lib/core.js",
  "worker/src/lib/fin-d1.js",
  "worker/src/lib/fin-import.js",
  "worker/src/lib/owner-auth.js",
  "worker/src/lib/sessions.js",
  "worker/src/lib/webauthn.js",
  "worker/src/lib/query-intent.js",
  "worker/src/lib/retrieval-status.js",
  "worker/src/lib/secret-scan.js",
  "worker/src/lib/store-d1.js",
  "worker/src/lib/store.js",
  "worker/src/lib/supabase.js",
  "worker/src/lib/vtt.js",
  "worker/src/lib/zoom.js",
];
const allowed = new Set(expected);
const missing = expected.filter((path) => !files.includes(path));
const bundledPathAllowed = (path) => [...reviewedBundles.keys()].some(
  (name) => path.startsWith(`node_modules/${name}/`),
);
const unexpected = files.filter((path) => !allowed.has(path) && !bundledPathAllowed(path));
const bundledConfig = Array.isArray(packageJson.bundleDependencies)
  ? [...packageJson.bundleDependencies].sort()
  : [];
const expectedBundles = [...reviewedBundles.keys()].sort();
const bundleConfigMismatch = JSON.stringify(bundledConfig) !== JSON.stringify(expectedBundles);
const dependencyMismatch = [...reviewedBundles].filter(([name, version]) =>
  packageJson.dependencies?.[name] !== version ||
  lock.packages?.[`node_modules/${name}`]?.version !== version ||
  !files.includes(`node_modules/${name}/package.json`)
);
const requiredGitIgnored = [
  ".brain-admin-key",
  ".brain-admin-key.tmp-deadbeef",
  ".brain-curated-sync-plan.json",
  ".brain-curated-sync-ledger.json",
  ".brain-curated-sync-ledger.json.tmp-deadbeef",
  ".brain-recovery-plan.json",
  ".brain-recovery-state.json",
  ".brain-recovery-state.json.tmp-deadbeef",
  ".brain-recovery-export.sql",
  "brain.corpus-contract.json",
  ".brain-recovery-field-gate.lock",
];
const gitIgnoreFailures = requiredGitIgnored.filter((path) =>
  spawnSync("git", ["check-ignore", "--quiet", "--no-index", path], {
    cwd: ROOT,
    encoding: "utf-8",
  }).status !== 0
);
// These are source-instance identities, not product concepts. Scan only the
// package's own reviewed files so a bundled dependency cannot create noise.
// Report the file and rule, never the matched text itself.
const privateIdentityRules = [
  ["owner first name", /\bJames(?:'s)?\b/i],
  ["owner surname", /\bGuldan(?:'s)?\b/i],
  ["owner organization", /\bAlign Growth(?: LLC)?\b/i],
  ["owner organization short name", /\bAlign\b/],
  ["owner email", /\bjames@jamesguldan\.com\b/i],
  ["collaborator first name", /\bJay(?:'s)?\b/i],
  ["collaborator surname", /\bBhakta(?:'s)?\b/i],
  ["collaborator client first name", /\bChet(?:'s)?\b/i],
];
const privateTextMatches = expected.flatMap((path) => {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  return privateIdentityRules
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => `${path} (${label})`);
});

// A packlist can name every file and still hide a broken relative import.
// Build and unpack the actual tarball, then import the recovery adapter from
// that isolated package tree. The probe invokes no CLI entry point or network.
let packedAdapterImportFailed = false;
const packageProbeDirectory = mkdtempSync(join(tmpdir(), "brain-package-probe-"));
try {
  const actualPack = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packageProbeDirectory],
    {
      cwd: ROOT,
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 60_000,
    },
  );
  let filename = null;
  try { filename = JSON.parse(actualPack.stdout)?.[0]?.filename || null; } catch { /* fixed failure below */ }
  if (actualPack.status !== 0 || !filename) {
    packedAdapterImportFailed = true;
  } else {
    const extracted = spawnSync("tar", [
      "-xzf", join(packageProbeDirectory, filename), "-C", packageProbeDirectory,
    ], {
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 60_000,
    });
    const adapterPath = join(
      packageProbeDirectory,
      "package",
      "operations",
      "cloudflare-recovery-adapter.mjs",
    );
    const importProbe = extracted.status === 0
      ? spawnSync(process.execPath, [
          "--input-type=module",
          "--eval",
          "const {pathToFileURL}=await import('node:url');await import(pathToFileURL(process.env.PACK_IMPORT_PATH).href)",
        ], {
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH || "",
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
            PACK_IMPORT_PATH: adapterPath,
          },
          timeout: 60_000,
        })
      : { status: null };
    packedAdapterImportFailed = extracted.status !== 0 || importProbe.status !== 0;
  }
} finally {
  rmSync(packageProbeDirectory, { recursive: true, force: true });
}

if (packed.status !== 0 || !files.length || forbidden.length || missing.length || unexpected.length ||
    bundleConfigMismatch || dependencyMismatch.length || gitIgnoreFailures.length || privateTextMatches.length ||
    packedAdapterImportFailed) {
  console.error("FAIL  published package privacy allowlist");
  if (packed.status !== 0) {
    console.error(
      String(packed.stderr || packed.stdout || packed.error?.message || "npm pack failed without a diagnostic").trim()
    );
  }
  if (!files.length) console.error("npm returned no packlist");
  if (forbidden.length) console.error(`private paths would ship: ${forbidden.join(", ")}`);
  if (missing.length) console.error(`required product paths are missing: ${missing.join(", ")}`);
  if (unexpected.length) console.error(`unreviewed package files would ship: ${unexpected.join(", ")}`);
  if (bundleConfigMismatch) console.error("bundleDependencies does not match the reviewed dependency set");
  if (dependencyMismatch.length) {
    console.error(`bundled dependency version or package mismatch: ${dependencyMismatch.map(([name]) => name).join(", ")}`);
  }
  if (gitIgnoreFailures.length) {
    console.error(`private admin-key paths are not ignored by Git: ${gitIgnoreFailures.join(", ")}`);
  }
  if (privateTextMatches.length) {
    console.error(`source-instance identity appears in packaged product text: ${privateTextMatches.join(", ")}`);
  }
  if (packedAdapterImportFailed) console.error("packed recovery adapter import probe failed");
  process.exit(1);
}

console.log(`PASS  published package contains ${files.length} reviewed files and no client-private paths`);
