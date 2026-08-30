// PRIVACY GATE for a PUBLIC repository. One file, three jobs:
//
//   1. PACKAGE INVENTORY. `npm pack --dry-run` must produce exactly the
//      reviewed file list in `expected` below, plus the four reviewed bundled
//      dependencies. package.json has to use directory entries for npm's
//      packer, so this list is the real allowlist: a new file under one of
//      those directories fails here until a reviewer names it deliberately.
//   2. IDENTITY SCAN. Every file tracked by git, plus every file npm would
//      ship, is read and checked for private identity. Tracked and packed
//      PATHS are checked with the same rules, because a first name reached
//      this repo inside a FILENAME once, where no content scan could see it.
//   3. TARBALL SANITY. The tarball is really built, unpacked, and one module
//      imported out of it, so a packlist that names every file and still hides
//      a broken relative import fails.
//
// SCOPE OF THE IDENTITY SCAN, stated once and correctly: it covers ALL FILES
// TRACKED BY GIT, enumerated with `git ls-files`, union the npm packlist. It
// is deliberately NOT an allowlist of directories. The version this replaced
// walked only `test/` and `worker/test/` and was therefore blind to 125 of 427
// tracked files, `evidence/` being the largest unwatched block. Leaks were then
// found across `evidence/`, `docs/`, both test trees and a shipped source
// comment, every one of them by hand, because nothing automated was looking.
// Enumerating from git means a directory added tomorrow is covered the day it
// is committed, with nobody having to remember this file.
//
// WHY EVERY TRACKED FILE AND NOT JUST THE PACKAGE: this repo is public on
// GitHub. Every committed file is readable by anyone, and git history keeps it
// readable after a later commit deletes it. A private name reaching any
// tracked path is a real exposure the moment it is pushed, whether or not
// `npm install` would ever deliver it.
//
// WHEN THIS RUNS: only under `npm test`. There are no git hooks in this repo
// and this file does not install one, because that is the repository owner's
// call to make on his own machine. docs/privacy-gate.md has the exact opt-in
// command, and what it costs, for anyone who wants it on pre-commit.
//
// TWO MODES. Run with no arguments it does all three jobs above, in about four
// seconds, over half of it spent in two `npm pack` invocations. Run with
// `--scan-only` it does job 2 alone in about two seconds, which is the right
// shape for a pre-commit hook.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { IDENTITY_RULES, safeIdentifier } from "../scripts/privacy-identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// THE DENYLIST, AND THE PARADOX IT HAS TO SURVIVE
//
// To detect a private string you have to be able to recognise it, and the
// obvious way to do that is to write it down. That made the previous version
// of this file the single densest concentration of real identity in the whole
// repo: eight real names, an organisation and a personal email address, in
// plaintext, in a public repository, sitting under a comment explaining that
// they were private. It then had to exclude itself from its own scan to stay
// green, so the one file guaranteed to contain private identity was the one
// file never checked.
//
// The canonical values in scripts/privacy-identity.mjs are stored as SHA-256
// digests of their normalised form. The plaintext is not in that file, this
// file, or the current repository tip. Neither file is excluded from scanning,
// and there are no exemptions anywhere in this gate.
//
// WHAT HASHING ACTUALLY BUYS, honestly: it defeats reading, grepping, GitHub
// code search and search-engine indexing. Those are the realistic ways a name
// in a public repo gets found, so this is a real improvement and not a
// gesture. It does NOT defeat a guess. SHA-256 of a short lowercase first name
// is recoverable in seconds by anyone who hashes a name dictionary, so treat
// this as "you cannot read the list, you can only test a name you already
// suspect". A confirmation oracle is a much smaller leak than a printed list,
// and it is the best available trade here, because a denylist that cannot
// recognise the string cannot do its job at all.
//
// HOW A ROW IS MATCHED. Text is normalised by turning every run of
// non-alphanumeric characters into a single space, so `a.b.com`, `a/b`, `a_b`
// and `a b` all normalise identically. That is what lets a two-word rule catch
// a domain inside a URL and a one-word rule catch a name inside a filesystem
// path, which plain `\bName\b` word boundaries cannot do.
//
//   mode "word"  the match must be whole words in the normalised text. This is
//                what `\bName\b` used to mean. Short names need it: the
//                three-letter client first name below occurs as a substring of
//                ordinary English words such as "timeline" and "delivery".
//   mode "any"   the match may be any substring, so a value glued into a
//                larger identifier is still caught (a name inside a camelCase
//                variable, a host inside a longer host). Only long, distinctive
//                values are given this mode, where a coincidence is impossible.
//   cs true      the row is case-sensitive. Used for one short organisation
//                name that is also an everyday CSS property word in lowercase.
//
// WHY EXACT VALUES AND NOT SHAPES for the infrastructure ids. A rule matching
// "any 32 hex characters" would fire on this repo's own git SHAs, on dozens of
// deliberately synthetic fixtures, and on every content hash in
// docs/release-evidence/, i.e. it would be pure noise and would be switched off
// within a week. Hashing the handful of real ids that have actually leaked into
// this tree keeps a precise rule with a zero false-positive rate.
//
// ADDING OR ROTATING A ROW without ever typing the value into a file:
//   printf %s 'the value' | node test/package-privacy.test.mjs --hash word ci 'label'
// It prints the row to paste into IDENTITY_RULES. Piping from `printf` keeps
// the value out of shell history in a way an argument would not. Full notes in
// docs/privacy-gate.md.
const RULES = IDENTITY_RULES.map(({ kind: _kind, ...rule }) => rule);

// Punctuation becomes a separator. Everything downstream depends on this being
// applied identically to a rule's value and to the text being searched.
const normalize = (text) => text.replace(/[^A-Za-z0-9]+/g, " ").trim();

// FNV-1a, 32-bit. A cheap non-cryptographic hash used ONLY to decide which of
// the ~30 million candidate windows in this repo are worth a SHA-256. It never
// decides a match by itself; SHA-256 is always the authority, so an FNV
// collision costs one wasted hash and nothing else. Without it the substring
// pass alone takes about fifteen seconds; with it the whole scan takes two.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// Turns one plaintext value into a stored row. Used at runtime by the canaries
// below, and by `--hash` to mint a real row without the value touching a file.
function compileRule(label, mode, cs, value) {
  const normalized = cs ? normalize(value) : normalize(value).toLowerCase();
  return {
    label, mode, cs,
    words: normalized.split(" ").length,
    len: normalized.length,
    fnv: fnv1a(normalized),
    sha: sha256(normalized),
  };
}

if (process.argv.includes("--hash")) {
  const [mode, sensitivity, label] = process.argv.slice(process.argv.indexOf("--hash") + 1);
  const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value || !["word", "any"].includes(mode) || !["ci", "cs"].includes(sensitivity) || !label) {
    console.error("usage: printf %s 'value' | node test/package-privacy.test.mjs --hash word|any ci|cs 'label'");
    process.exit(2);
  }
  const rule = compileRule(label, mode, sensitivity === "cs", value);
  console.log(`  { label: ${JSON.stringify(rule.label)}, kind: "privacy", mode: "${rule.mode}", cs: ${rule.cs}, ` +
    `words: ${rule.words}, len: ${rule.len}, fnv: ${rule.fnv},\n    sha: "${rule.sha}" },`);
  process.exit(0);
}

// `--scan-only` runs the identity half and nothing else: no `npm pack`, no
// tarball build, no import probe. It is what a pre-commit hook should call,
// because it costs about two seconds instead of about six and it checks the
// thing a commit can actually get wrong. `npm test` runs the full gate.
const SCAN_ONLY = process.argv.includes("--scan-only");

function buildIndex(rules) {
  const index = {
    wordPrefilter: new Set(), wordDigests: new Map(), wordSizes: new Set(),
    anyPrefilter: new Set(), anyDigests: new Map(), anyLengths: new Set(),
  };
  for (const rule of rules) {
    // A case-sensitive substring rule would silently never fire, because the
    // substring pass folds case. Fail loudly rather than pretend to cover it.
    if (rule.mode === "any" && rule.cs) throw new Error(`rule "${rule.label}" cannot be both "any" and case-sensitive`);
    if (!/^[0-9a-f]{64}$/.test(rule.sha) || !Number.isInteger(rule.fnv) || rule.len < 1 || rule.words < 1) {
      throw new Error(`rule "${rule.label}" is malformed`);
    }
    const prefilter = rule.mode === "word" ? index.wordPrefilter : index.anyPrefilter;
    const digests = rule.mode === "word" ? index.wordDigests : index.anyDigests;
    const sizes = rule.mode === "word" ? index.wordSizes : index.anyLengths;
    prefilter.add(rule.fnv);
    digests.set(rule.sha, [...(digests.get(rule.sha) || []), rule.label]);
    sizes.add(rule.mode === "word" ? rule.words : rule.len);
  }
  index.wordSizes = [...index.wordSizes].sort((a, b) => a - b);
  index.anyLengths = [...index.anyLengths].sort((a, b) => a - b);
  return index;
}

// Returns the set of rule LABELS present in `text`. Never returns, logs or
// stores the matched text itself: a failure report that quotes the match would
// republish the very string this gate exists to keep out of the repo.
function scanText(text, index) {
  const found = new Set();
  const normal = normalize(text);
  if (!normal) return found;
  const words = normal.split(" ");
  for (let start = 0; start < words.length; start++) {
    for (const size of index.wordSizes) {
      if (start + size > words.length) break;
      const phrase = words.slice(start, start + size).join(" ");
      const folded = phrase.toLowerCase();
      for (const candidate of folded === phrase ? [phrase] : [phrase, folded]) {
        if (!index.wordPrefilter.has(fnv1a(candidate))) continue;
        for (const label of index.wordDigests.get(sha256(candidate)) || []) found.add(label);
      }
    }
  }
  if (index.anyLengths.length) {
    const lower = normal.toLowerCase();
    for (const length of index.anyLengths) {
      for (let start = 0; start + length <= lower.length; start++) {
        const window = lower.slice(start, start + length);
        if (!index.anyPrefilter.has(fnv1a(window))) continue;
        for (const label of index.anyDigests.get(sha256(window)) || []) found.add(label);
      }
    }
  }
  return found;
}

// Only ever called for a file that already failed, so the second pass costs
// nothing in the normal case. A match can straddle a line break in wrapped
// prose, in which case no single line reproduces it and the report says so
// rather than inventing a line number.
function locateLines(text, index, labels) {
  const lines = text.split(/\r?\n/);
  const located = new Map(labels.map((label) => [label, []]));
  lines.forEach((line, offset) => {
    for (const label of scanText(line, index)) {
      if (located.has(label)) located.get(label).push(offset + 1);
    }
  });
  return located;
}

// SELF-TEST. The dangerous failure of a hashed denylist is silence: normalise
// or index it wrongly and it matches nothing, stays green forever, and leaks
// the whole time. These canaries are invented strings, safe in plaintext, and
// their digests are computed here at runtime rather than pinned, so they prove
// the live machinery rather than a copy of it. They run before any real file
// is read.
const canaryIndex = buildIndex([
  compileRule("canary word", "word", false, "Zzqcanary"),
  compileRule("canary phrase", "word", false, "Zzqcanary Holdings"),
  compileRule("canary domain", "word", false, "zzqcanary.example.test"),
  compileRule("canary cased", "word", true, "ZzqCased"),
  compileRule("canary glued", "any", false, "zzqglued"),
]);
const canaryFailures = [
  ["a whole word is matched", "the zzqcanary file", ["canary word"]],
  ["a word glued inside a longer word is not", "prezzqcanarypost here", []],
  ["punctuation between words is normalised away", "ZZQCANARY-HOLDINGS, inc", ["canary phrase", "canary word"]],
  ["a domain is matched inside a url", "see https://mail.zzqcanary.example.test/x now", ["canary domain", "canary word"]],
  ["a name is matched inside a filesystem path", "instances/zzqcanary/notes.json", ["canary word"]],
  ["a case-sensitive rule matches its own casing", "the ZzqCased row", ["canary cased"]],
  ["a case-sensitive rule ignores other casing", "the zzqcased row", []],
  ["a substring rule matches a glued value", "prefixzzqgluedsuffix", ["canary glued"]],
  ["ordinary prose matches nothing", "a perfectly ordinary sentence about nothing", []],
].filter(([, sample, want]) =>
  [...scanText(sample, canaryIndex)].sort().join("|") !== [...want].sort().join("|")
).map(([name]) => name);

const index = buildIndex(RULES);
const scanPath = (path) => [...scanText(path, index)];

// ---------------------------------------------------------------------------
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
const reviewedBundles = new Map([
  ["@e965/xlsx", "0.20.3"],
  ["fflate", "0.8.3"],
  ["postal-mime", "3.0.0"],
  ["unpdf", "1.8.1"],
]);
const packed = SCAN_ONLY ? { status: 0, stdout: "[]" } : spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
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

// Structural path denials, plus the identity rules applied to the path itself.
// The identity half used to be a literal first name in this regex; it is now
// the hashed denylist, which covers every identity rather than one, and leaves
// no plaintext in this file.
const forbidden = files.filter((path) =>
  /(^|\/)(instances|eval\/baselines)(\/|$)/i.test(path) ||
  (/^eval\/golden\//i.test(path) && path !== "eval/golden/TEMPLATE.golden.json") ||
  /readiness|\.brain-(?:migration|ingest|drive-live-fixture)|brain-support-|support-bundle/i.test(path) ||
  scanPath(path).length
);
const expected = [
  "CHANGELOG.md",
  "README.md",
  "acceptance.mjs",
  "brain.mjs",
  "components/brain-mcp.mjs",
  "components/brain-mcp-runtime.mjs",
  "components/brain-http.mjs",
  "connectors/gmail.mjs",
  "connectors/catalog.mjs",
  "connectors/dropbox.mjs",
  "connectors/hubspot.mjs",
  "connectors/imap.mjs",
  "connectors/imessage.mjs",
  "connectors/iphone-backup.mjs",
  "connectors/google-auth.mjs",
  "connectors/google-calendar.mjs",
  "connectors/google-drive.mjs",
  "connectors/keychain-write.exp",
  "connectors/microsoft-graph.mjs",
  "connectors/notion.mjs",
  "connectors/offline-rehearsal.mjs",
  "connectors/provider-file.mjs",
  "connectors/provider-oauth.mjs",
  "connectors/provider-runtime.mjs",
  "connectors/provider-sync.mjs",
  "connectors/quickbooks-online.mjs",
  "connectors/slack.mjs",
  "connectors/zoom.mjs",
  "connectors/whatsapp.mjs",
  "docs/ARCHITECTURE.md",
  "docs/COMPETITIVE-BENCHMARK.md",
  "docs/CONNECTOR-BACKLOG.md",
  "docs/ENGINEERING-STANDARDS.md",
  "docs/EVALUATION.md",
  "docs/MAINTAINER.md",
  "docs/OWNER-WORKSPACE-API.md",
  "docs/PLAID.md",
  "docs/RECOVERY.md",
  "docs/RECOVERY-BANK-SAFETY-ACCEPTANCE.md",
  "docs/RELEASE-GOVERNANCE.md",
  "docs/SUPPORT-ACCESS.md",
  "docs/LEGACY-SUPABASE-EXIT.md",
  "docs/README-developer.md",
  "docs/decisions/000-template.md",
  "docs/decisions/001-cloudflare-native-standard.md",
  "docs/decisions/002-paused-bootstrap-acceleration.md",
  "docs/decisions/003-temporary-support-sessions.md",
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
  "ingest/archive.mjs",
  "ingest/doc-date.mjs",
  "ingest/envelope-batching.mjs",
  "ingest/extract.mjs",
  "ingest/facebook-messenger-export.mjs",
  "ingest/ics.mjs",
  "ingest/linkedin-export.mjs",
  "ingest/formats.mjs",
  "ingest/mbox.mjs",
  "ingest/ocr.mjs",
  "ingest/outcome.mjs",
  "ingest/message-session.mjs",
  "ingest/page-image.mjs",
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
  "migrations/d1/0015_grants.sql",
  "migrations/d1/0016_zones.sql",
  "migrations/d1/0017_financial_ledger.sql",
  "migrations/d1/0018_bank_feed.sql",
  "migrations/d1/0019_mcp_connector_oauth.sql",
  "migrations/d1/0020_extraction_provenance.sql",
  "migrations/d1/0021_owner_workspace.sql",
  "migrations/d1/0022_document_access_passkey_observability.sql",
  "migrations/d1/0023_support_sessions.sql",
  "migrations/d1/0024_agent_action_receipts.sql",
  "migrations/d1/0025_zoom_deliveries.sql",
  "migrations/d1/0026_plaid_durability.sql",
  "migrations/pending/operational_reliability_v021.sql",
  "onboarding/00-pre-install-interview.md",
  "onboarding/01-intake-RUNBOOK.md",
  "onboarding/01-intake-questionnaire.md",
  "onboarding/02-client-effort-and-timeline.md",
  "onboarding/03-kickoff-and-checkins.md",
  "onboarding/04-what-it-can-and-cannot-answer.md",
  "onboarding/05-handoff-and-revocation.md",
  "onboarding/06-runbook-top-ten-failures.md",
  "onboarding/07-ingest-source-matrix.md",
  "onboarding/08-provisioning-prerequisites.md",
  "onboarding/09-technician-setup-and-rehearsal.md",
  "onboarding/client-experience/ACCEPTANCE-AND-HANDOFF.md",
  "onboarding/client-experience/DATA-PROTECTION-DRAFT.md",
  "onboarding/client-experience/README.md",
  "onboarding/client-experience/SUPPORT-AND-OFFLINE.md",
  "onboarding/client-experience/TECHNICIAN-RUNBOOK.md",
  "onboarding/client-experience/support-profile.example.json",
  "onboarding/client-experience/support-profile.schema.json",
  "operations/admin-key-file.mjs",
  "operations/admin-key-persistence.mjs",
  "operations/claude-workspace.mjs",
  "operations/claude-skill.mjs",
  "operations/cloudflare-token-store.mjs",
  "operations/session-signing-key.mjs",
  "operations/technician-setup.mjs",
  "operations/rag-proxy-key.mjs",
  "operations/curated-dual-sync.mjs",
  "operations/curated-sync-scheduler.mjs",
  "operations/current-user-file.mjs",
  "operations/drive-removal-plan.mjs",
  "operations/drive-scheduler.mjs",
  "operations/folder-scheduler.mjs",
  "operations/imessage-scheduler.mjs",
  "operations/provider-scheduler.mjs",
  "operations/whatsapp-daemon.mjs",
  "operations/whatsapp-drain-scheduler.mjs",
  "operations/installed-manifest.mjs",
  "operations/cloudflare-recovery-adapter.mjs",
  "operations/bank-access-wrapping-key.mjs",
  "operations/plaid-sandbox-runner.mjs",
  "operations/recovery-artifact-crypto.mjs",
  "operations/verified-recovery.mjs",
  "operations/off-provider-backup.mjs",
  "operations/windows-dpapi.ps1",
  "operations/windows-dpapi-bridge.mjs",
  "operations/windows-dpapi.cs",
  "package.json",
  "report-html.mjs",
  "report.mjs",
  "skills/financial-brain-technician/SKILL.md",
  "support-journal.mjs",
  "support-recovery.mjs",
  "templates/brain.manifest.json",
  "worker/src/index.js",
  "worker/src/lib/agent-action-receipts.js",
  "worker/src/lib/agent-authority.js",
  "worker/src/lib/answer-render.js",
  "worker/src/lib/app-assets.js",
  "worker/src/lib/app-page.js",
  "worker/src/lib/auth-store.js",
  "worker/src/lib/bank-feed.js",
  "worker/src/lib/bank-feed-profiles.js",
  "worker/src/lib/confidence.js",
  "worker/src/lib/connections.js",
  "worker/src/lib/core.js",
  "worker/src/lib/document-access.js",
  "worker/src/lib/fin-api.js",
  "worker/src/lib/fin-d1.js",
  "worker/src/lib/fin-import.js",
  "worker/src/lib/fin-upload.js",
  "worker/src/lib/grants.js",
  "worker/src/lib/ingestion-outcome.js",
  "worker/src/lib/mcp-endpoint.js",
  "worker/src/lib/oauth.js",
  "worker/src/lib/plaid-bank-feed.js",
  "worker/src/lib/plaid-protocol.js",
  "worker/src/lib/provider-sync.js",
  "worker/src/lib/public-request-guard.js",
  "worker/src/lib/reliability-alerts.js",
  "worker/src/lib/remember-contract.js",
  "worker/src/lib/ocr.js",
  "worker/src/lib/owner-auth.js",
  "worker/src/lib/support-access.js",
  "worker/src/lib/owner-actions.js",
  "worker/src/lib/owner-activity.js",
  "worker/src/lib/sessions.js",
  "worker/src/lib/webauthn.js",
  "worker/src/lib/query-intent.js",
  "worker/src/lib/retrieval-status.js",
  "worker/src/lib/secret-scan.js",
  "worker/src/lib/store-d1.js",
  "worker/src/lib/store.js",
  "worker/src/lib/system-status.js",
  "worker/src/lib/update-status.js",
  "worker/src/lib/supabase.js",
  "worker/src/lib/upload-extract.js",
  "worker/src/lib/vtt.js",
  "worker/src/lib/zoom.js",
  "worker/src/lib/zoom-deliveries.js",
];
const allowed = new Set(expected);
const missing = SCAN_ONLY ? [] : expected.filter((path) => !files.includes(path));
const bundledPathAllowed = (path) => [...reviewedBundles.keys()].some(
  (name) => path.startsWith(`node_modules/${name}/`),
);
const unexpected = SCAN_ONLY ? [] : files.filter((path) => !allowed.has(path) && !bundledPathAllowed(path));
const bundledConfig = Array.isArray(packageJson.bundleDependencies)
  ? [...packageJson.bundleDependencies].sort()
  : [];
const expectedBundles = [...reviewedBundles.keys()].sort();
const bundleConfigMismatch = !SCAN_ONLY && JSON.stringify(bundledConfig) !== JSON.stringify(expectedBundles);
const dependencyMismatch = SCAN_ONLY ? [] : [...reviewedBundles].filter(([name, version]) =>
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
  ".brain-recovery-export.sql.fbrenc",
  ".brain-recovery-encrypted.tmp-deadbeef",
  ".brain-recovery-plaintext.tmp-deadbeef",
  "brain.corpus-contract.json",
  ".brain-recovery-field-gate.lock",
];
const gitIgnoreFailures = requiredGitIgnored.filter((path) =>
  spawnSync("git", ["check-ignore", "--quiet", "--no-index", path], {
    cwd: ROOT,
    encoding: "utf-8",
  }).status !== 0
);
// Enumerate from git rather than from a hand-maintained directory list. This is
// the whole point of the rewrite: a scan driven by an allowlist of directories
// is only ever as complete as somebody's memory, and it was not complete.
// -z survives spaces and newlines in filenames; git is already a hard
// dependency of this test through the check-ignore probe above.
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
const trackedFiles = tracked.status === 0 ? tracked.stdout.split("\0").filter(Boolean) : [];
const trackedEnumerationFailed = tracked.status !== 0 || trackedFiles.length === 0;

// "Is this text?" instead of "is this one of the extensions somebody thought
// of?". The extension allowlist this replaces missed 27 tracked fixtures -
// .vtt .csv .ofx .qfx .mbox .ics .srt .rtf - which are precisely the formats
// real exported personal data arrives in.
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) control++;
  }
  return control / sample.length > 0.1;
}

// Every tracked file, union everything npm would ship. Bundled dependency
// files are excluded from the CONTENT scan (they are third-party code and
// would only add noise), but their PATHS still go through `forbidden` above.
const privateScanPaths = [...new Set([...trackedFiles, ...expected])].sort();
const skippedBinary = [];
const privateTextMatches = [];
const privatePathMatches = [];
for (const path of privateScanPaths) {
  for (const label of scanPath(path)) {
    privatePathMatches.push(`${safeIdentifier(path, "redacted-path")} (path names: ${label})`);
  }
  let buffer;
  try {
    buffer = readFileSync(resolve(ROOT, path));
  } catch {
    continue; // listed in `expected` but not on disk: `missing` already reports it
  }
  if (looksBinary(buffer)) {
    skippedBinary.push(path);
    continue;
  }
  const text = buffer.toString("utf8");
  const labels = [...scanText(text, index)];
  if (!labels.length) continue;
  const located = locateLines(text, index, labels);
  for (const label of labels) {
    const lines = located.get(label) || [];
    const displayPath = safeIdentifier(path, "redacted-path");
    privateTextMatches.push(lines.length
      ? `${displayPath}:${lines.join(",")} (${label})`
      : `${displayPath} (${label}, spans a line break)`);
  }
}

// A packlist can name every file and still hide a broken relative import.
// Build and unpack the actual tarball, then import the recovery adapter from
// that isolated package tree. The probe invokes no CLI entry point or network.
let packedAdapterImportFailed = false;
const packageProbeDirectory = SCAN_ONLY ? null : mkdtempSync(join(tmpdir(), "brain-package-probe-"));
if (packageProbeDirectory) try {
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

if (packed.status !== 0 || (!SCAN_ONLY && !files.length) || forbidden.length || missing.length || unexpected.length ||
    bundleConfigMismatch || dependencyMismatch.length || gitIgnoreFailures.length ||
    canaryFailures.length || trackedEnumerationFailed ||
    privateTextMatches.length || privatePathMatches.length ||
    packedAdapterImportFailed) {
  console.error("FAIL  published package privacy allowlist");
  if (packed.status !== 0) {
    console.error(
      String(packed.stderr || packed.stdout || packed.error?.message || "npm pack failed without a diagnostic").trim()
    );
  }
  if (!SCAN_ONLY && !files.length) console.error("npm returned no packlist");
  if (canaryFailures.length) {
    console.error(`the identity matcher itself is broken and would miss real names: ${canaryFailures.join("; ")}`);
  }
  if (trackedEnumerationFailed) {
    console.error(`git ls-files returned no tracked files, so nothing was scanned: ${String(tracked.stderr || "").trim()}`);
  }
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
  if (privatePathMatches.length) {
    console.error(`source-instance identity appears in a tracked path: ${privatePathMatches.join(", ")}`);
  }
  if (privateTextMatches.length) {
    console.error(`source-instance identity appears in tracked text: ${privateTextMatches.join(", ")}`);
    console.error("replace the identity with a role word or an approved persona. Do not delete the sentence,");
    console.error("and do not remove the rule: a hit here is a finding, not a false alarm to be tuned away.");
  }
  if (packedAdapterImportFailed) console.error("packed recovery adapter import probe failed");
  process.exit(1);
}

const binaryNote = skippedBinary.length
  ? ` (${skippedBinary.length} binary skipped: ${skippedBinary.join(", ")})`
  : "";
console.log(SCAN_ONLY
  ? `PASS  ${privateScanPaths.length} tracked files and paths carry no private identity${binaryNote}`
  : `PASS  published package contains ${files.length} reviewed files, and ${privateScanPaths.length} tracked ` +
    `files and paths carry no private identity${binaryNote}`);
