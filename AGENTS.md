# Contributor rules

This repository ships one installer for every brain. Keep the shared product
generic. A person's manifest, source data, credentials, ingest state, golden
questions, and migration receipts are instance material, not product source.

Read `README.md` and `docs/README-developer.md` before changing behavior. Read
`docs/ARCHITECTURE.md` before changing storage, ingest, retrieval, credentials,
or lifecycle commands.

## Non-negotiable design rules

- The standard backend is D1 plus Vectorize in the owner's Cloudflare account.
  Supabase code exists for migration and temporary rollback compatibility, not
  as a premium or automatic large-corpus tier.
- The manifest is the only intended per-install product configuration. Do not
  put client names, paths, IDs, URLs, questions, or policy choices into shared
  code or defaults.
- Provisioning and upgrades must be idempotent and fail closed. Never adopt a
  resource based only on a name, advance a source cursor after incomplete work,
  or report success before exact readback proves the desired state.
- D1 is the durable text and metadata record. Vectorize is a derived semantic
  index fed through the D1 outbox. A healthy Worker with a pending outbox is not
  proof that semantic retrieval is complete.
- Nothing is skipped silently. Every ingest refusal, exclusion, extraction
  failure, and retryable write failure must remain visible and recoverable.
- Destructive operations preview first and require explicit confirmation.
- Keep comments that explain invariants, failure modes, and field evidence.
  Prefer a short explanation of why over a narration of what the next line does.
- New command logic should accept parsed arguments and injected dependencies.
  Do not add new global `process.argv` mutation or ambient credential access.
  Extract a focused module instead of making `brain.mjs` larger when practical.

## Source-of-truth boundaries

- `brain.mjs` is currently the CLI dispatcher and install orchestrator.
- `worker/src/` is the deployed data plane. There is no checked-in generated
  Worker bundle; deploy uploads these reviewed modules.
- `migrations/d1/` is the append-only D1 schema history. Never rewrite a shipped
  migration. Add the next numbered migration and test it through SQLite.
- `manifest.schema.json` documents the configuration contract, and
  `templates/brain.manifest.json` is the public starting shape. Runtime loading
  currently parses JSON and relies on command guards rather than applying the
  whole JSON Schema, so changes must keep schema, template, setup, command code,
  and documentation aligned.
- `package.json` `files` is the publication security boundary. It is an
  allowlist. Do not replace it with a denylist.
- `CHANGELOG.md` is public product copy read by `brain whatsnew`. Describe what
  changed for the owner and what they should verify.
- `support-journal.mjs`, the failure classifier in `brain.mjs`, support tests,
  and the troubleshooting runbook form one contract. A new issue category is
  incomplete until all four agree.
- Connector status must agree in the CLI, manifest schema and template,
  developer documentation, and `onboarding/07-ingest-source-matrix.md`.

## Credentials and privacy

- Never print, log, persist in source, place in argv, or include in test output
  any API token, admin key, OAuth record, recovery code, or source content.
- Treat a secret pasted into chat or a log as exposed. Do not reuse it.
- Cloudflare control-plane credentials are temporary. Routine data-plane work
  uses the brain URL and its own durable admin-key store.
- Durable admin keys use the declared macOS Keychain locator, Windows DPAPI
  CurrentUser protection, or an owner-only Linux file. Google OAuth follows its
  declared Keychain or protected-file backend. Do not create a second copy.
- Child processes receive allowlisted environments. Never spread the parent
  desktop environment into Wrangler, browser, Keychain, scheduler, MCP, eval,
  or helper processes.
- The support journal is local metadata, not telemetry. Its schema must remain
  unable to accept content, filenames, paths, URLs, account or document IDs,
  queries, answers, raw errors, logs, stacks, argv, environment, or credentials.
  Any future support upload must be opt-in, preview exact bytes, and use a
  separate write-only credential.
- Instance manifests and receipts may still identify an owner even when they
  contain no secret. Do not package, quote, or commit them as product fixtures.
  Tests use synthetic names and reserved invalid domains only.

## Local and generated artifacts

Do not hand-edit runtime artifacts to make a check pass. Fix the source or rerun
the owning command.

- Adjacent `.brain-ingest-<source>.json` files are resumable ingest state.
- Adjacent `.brain-admin-key` and its atomic-write residue are private key
  material. They must be ignored and must never be tracked by Git.
- `~/.brain/google-tokens.json`, `~/.brain/support/`, scheduler logs, and lock
  files are private machine-local state.
- LaunchAgent plists, MCP registrations, HTML reports, support exports, eval
  baselines, client golden sets, migration receipts, and readiness notes are
  generated or instance-specific outputs. Do not add them to the package.
- Only `eval/golden/TEMPLATE.golden.json` is a distributable golden-set file.

## Verification

Run the narrow test for the area you changed, then the full offline suite:

```bash
npm ci --ignore-scripts
npm test
```

Common focused tests:

- CLI failures and issue records: `node test/errors.test.mjs` and
  `node test/support-journal.test.mjs`
- provisioning and lifecycle: `node test/provision-guards.test.mjs` and
  `node test/upgrade-verify.test.mjs`
- ingest and extraction: `node test/ingest-run.test.mjs`,
  `node test/quality.test.mjs`, and connector-specific tests
- credentials: `node test/admin-key-rotation.test.mjs`,
  `node test/google-auth-storage.test.mjs`, and
  `node test/mcp-rotation.test.mjs`
- Worker routes and stores: `node worker/test/routes.test.mjs`,
  `node worker/test/store.test.mjs`, and `node worker/test/store-d1.test.mjs`
- package privacy: `node test/package-privacy.test.mjs`

Tests that need a real account or corpus are explicit field gates. Do not run
them against a live install or change production state without approval.

## Release checklist

1. Confirm no instance files, secrets, support exports, private golden sets, or
   unrelated working-tree changes are included.
2. Keep the version aligned in `package.json`, `package-lock.json`, the manifest
   template, the current-version test, and the newest `CHANGELOG.md` entry.
3. Run `npm test`, relevant `node --check` commands, and `git diff --check`.
4. Run `npm audit --offline` and
   `npm pack --dry-run --json --ignore-scripts`. Inspect the exact pack list.
5. Run `npm run privacy:history`. This clean lineage requires exactly zero
   finding objects in the candidate's reachable history. Before any new public
   release, `npm run privacy:history:strict` must also prove zero findings
   across every server-visible head and tag plus the checked-out candidate.
   Do not add a baseline or disposition to make a release green.
6. Install the packed tarball in a clean test location and prove the `brain`
   executable starts. Do not treat direct `node brain.mjs` execution as the
   package-install test.
7. Require the history-privacy job and all six CI jobs to pass: Windows, macOS,
   and Linux on Node 22 and 24.
8. Complete any named real-account field gate separately and record whether it
   was dev, shadow, or production. A CI pass is not a live deployment.
9. Tag the exact reviewed release commit so versioned support records can be
   traced back to the code that produced them.
