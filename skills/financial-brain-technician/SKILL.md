---
name: financial-brain-technician
description: Guide a Financial Brain install, update, connector test, passkey ceremony, or owner handoff from the reviewed local CLI and its package-local bootstrap status. Use when the owner asks Claude Code to set up or check their Brain.
---

<!-- financial-brain-installer:claude-skill:v1 -->

# Financial Brain technician

Help the owner complete one reviewed step at a time. Begin with a read-only
plan. A request for guidance is not approval to deploy, connect an account,
upload private data, delete anything, revoke access, change billing, or create
an invite.

Invoke this guide as `/financial-brain-technician`, optionally followed by the
absolute bootstrap-status and intended manifest paths. A client-specific test
kit is an optional supervised-pilot overlay, not a universal prerequisite.

## Start here

1. Read the owner workspace's `CLAUDE.md` and the absolute
   `.financial-brain-bootstrap-status.json` named in `$ARGUMENTS`. The status
   file is the package-local source of truth for this handoff and contains no
   credential. Stop if its schema is unsupported, its CLI locator is absent, or
   its recorded package version differs from the CLI's own reported version.
2. Use the exact Brain CLI invocation in `CLAUDE.md`. If that guide is not
   installer-owned, construct the invocation from `status.cli.command` followed
   by `status.cli.args`. Never use a bare `brain` command and never broaden PATH
   to find it.
3. If the intended `brain.manifest.json` does not exist, do not ask for an
   installed manifest or an external test kit. Run the read-only plan against
   the intended path. It will report `BOOTSTRAP_READY_NO_MANIFEST` and the exact
   reviewed setup step that can create it after owner approval.
4. Run the read-only plan with the exact CLI launcher:

   ```bash
   <brain-cli> technician "/absolute/path/to/brain.manifest.json" --json
   ```

5. Explain the next incomplete step in ordinary language. Before running its
   `--run` command, state what will change and ask the owner to approve that
   exact action. On a clean machine this is the manifest-creating Cloudflare
   setup command. The permission pass stays in the terminal's hidden prompt.
6. After setup creates the manifest, reread the bootstrap status and transition
   to manifest-bound technician mode. If an explicitly supplied pilot test kit
   exists, read it as additional acceptance evidence only. A kit with
   `ready_to_send: false`, a mismatched version, or a hold marker blocks that
   pilot, but absence of a kit does not block the packaged owner workflow.
7. The public first-install plan guides local tools, the core Cloudflare install,
   the owner-only first-passkey handoff, and final live verification. Plaid,
   Google, QuickBooks, Zoom, IMAP, Slack, Notion, Microsoft 365, Dropbox,
   HubSpot, and watched-folder scheduling ceremonies are deferred from this
   public path. Existing connector code or fixtures are not permission to run
   them or proof that their credential custody and live provider field gates are
   ready.
8. After every `--run` command, whether it reports completion or failure, read
   the private `.financial-brain-technician-status.json` path printed by the
   CLI. Require `status`, `issue_code`, `retry_safe`, `requires_human`,
   `next_action`, `manifest.path`, and the exact `cli` and `refresh` locators.
   Invoke `status.refresh.command` with exactly `status.refresh.args` as
   structured process arguments, never by joining or re-quoting them as a shell
   string. Do that before deciding what to do next. A child exit code, a `completed` field, or a static
   manifest is not proof that live state matches the plan.

## Credential boundary

- The owner handles login, 2FA, billing, OAuth consent, credential reveal, and
  every physical passkey gesture.
- Keep Cloudflare tokens, Brain keys, OAuth secrets, app passwords,
  authentication codes, passkey identifiers, and invite links out of chat,
  commands, logs, screenshots, and files.
- When the CLI displays a hidden prompt, hand control to the owner. Do not ask
  the owner to paste the value into Claude.
- Never run `brain invite` or copy an enrollment link through an AI-controlled
  or captured terminal. The owner mints and opens the one-time link in a
  terminal and display they control directly. Final verification must observe
  an enrolled device through the deployed data plane.
- Prefer browser-based `wrangler login` or `gh auth login` for optional local
  developer access. Do not create or print a broad Cloudflare or GitHub token.
- Prefer the exact `<brain-cli>` launcher over direct Wrangler commands because the Brain CLI
  applies account pinning, migration safety, protected key lookup, and proof
  checks. Use Wrangler directly only for a named diagnostic the owner approves.

## Source and file boundary

- Search only a folder or external-drive root the owner names. Use
  `claude --add-dir <approved-folder>` for that exact root.
- Preview scope with the connector's dry run before the first ingest. Finding a
  file is not permission to upload it.
- Run one connector at a time and record automated, synthetic-field,
  real-source, and production proof separately.
- A partial, unavailable, stale, refused, or interrupted source is not
  complete. A healthy empty result and an unavailable result must remain visibly
  different.
- Preview every deletion or forget plan and wait for exact approval before the
  command that mutates data.

## QuickBooks boundary

- The client creates and owns the Intuit app and authorizes their own company.
  Financial Brain has no shared Intuit account and does not take credential
  custody.
- Confirm `corpora.quickbooks.enabled`, the explicit `sandbox` environment, and
  the exact registered localhost callback in the manifest before running
  `<brain-cli> technician <manifest> --run quickbooks`.
- Explain that Intuit's Accounting consent can authorize reads and writes even
  though Financial Brain performs query/read calls only. Keep that broader
  permission visible before the owner consents.
- Hand the terminal to the owner for both hidden app-value prompts, then let the
  owner complete Intuit consent in the browser. Never ask for either value in
  chat.
- If the manifest selects production, preserve
  `quickbooks_production_callback_unavailable` and stop. The client-owned HTTPS
  callback is not implemented, and an API key cannot replace Intuit OAuth.
- Confirm that the returned company binding matches the explicit source. A
  different company needs a separate source and cannot silently replace the
  existing one.
- Explain that disconnect revokes provider access but keeps imported documents.
  Any removal is a separate reviewed `<brain-cli> forget` preview and approval.
- Treat a successful connection or ingest only as a loaded accounting-team
  reference. QuickBooks is not financial authority and must be compared with
  bank evidence and other provenance-bearing records.
- After a reviewed ingest and bank import, use `<brain-cli> reconcile quickbooks`
  only for one owner-reviewed account pairing, period, and direction. Prefer
  `--json` and preserve its status, citations, `error_code`, and `recovery`.
- Never treat an exact pair as a ruling, resolve a generated exception, expose
  the Intuit realm id, or continue past a company-identity or pairing refusal.
- The tax-to-QuickBooks bridge is human-confirmed document claim entry only.
  Never use OCR, retrieval text, bank deposits, transaction aggregation, or an
  inferred mapping to populate it. Require the private claim file and the
  separate `--confirm-reviewed-claims` approval after visual verification.
- Stop on any missing document custody, single-entity scope, tax year, exact
  period, USD currency, cash/accrual basis, `gross_receipts` measure, complete
  report coverage, QuickBooks source, or company fingerprint. Equal amounts are
  still not a tax conclusion.

## Recovery and completion

- A failed technician step is ready to retry after its named prerequisite is
  fixed only when its durable status says `retry_safe: true`. Always run the
  credential-free exact `refresh` command first. If it says false, uncertain,
  or `requires_human: true`, stop for owner review rather than improvising or
  blindly retrying a provider response.
- Explain a stable issue code with:

  ```bash
  <brain-cli> support --explain <ISSUE_CODE>
  ```

- Finish with the package-local bootstrap status and manifest-bound verification
  steps. When a supervised-pilot test kit is supplied, also complete its
  preflight and results template. Record counts, timestamps, proof level, and
  sanitized evidence. Keep credentials and raw private source content out of
  that record.
- Report anything that still requires Cloudflare, provider, operating-system,
  physical-device, or real-export proof. Fixture success does not close a live
  connector gate.
