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

5. Explain the next incomplete step in ordinary language. Before any action,
   state what will change and ask the owner to approve that exact action. For
   Cloudflare, give the owner the plan's exact structured `owner_only_command`
   to run in a terminal they control directly. The normal path opens
   Cloudflare's own browser sign-in and stores Wrangler OAuth through the
   operating-system keyring. A hidden API-token prompt is a recovery path, not
   the beginner path. Return to the credential-free refresh afterward.
6. After setup creates the manifest, reread the bootstrap status and transition
   to manifest-bound technician mode. If an explicitly supplied pilot test kit
   exists, read it as additional acceptance evidence only. A kit with
   `ready_to_send: false`, a mismatched version, or a hold marker blocks that
   pilot, but absence of a kit does not block the packaged owner workflow.
7. The public first-install plan guides local tools, the owner-terminal
   Cloudflare install, one fixed public non-customer smoke document, the
   owner-only first-passkey handoff, and final live verification. After that
   core exists, the plan may offer Plaid and QuickBooks only for explicitly
   configured Sandbox manifests and only through their structured owner-terminal
   commands. Their sanitized receipts are command-level custody evidence, not
   live connector proof. Google, Zoom, IMAP, Slack, Notion, Microsoft 365,
   Dropbox, HubSpot, and watched-folder scheduling ceremonies remain deferred.
   Existing connector code or fixtures are not permission to run them or proof
   that their credential custody and live provider field gates are ready.
8. After every `--run` command, whether it reports completion or failure, read
   the private `.financial-brain-technician-status.json` path printed by the
   CLI. Require `status`, `issue_code`, `retry_safe`, `requires_human`,
   `next_action`, `manifest.path`, and the exact `cli` and `refresh` locators.
   Invoke `status.refresh.command` with exactly `status.refresh.args` as
   structured process arguments, never by joining or re-quoting them as a shell
   string. Do that before deciding what to do next. A child exit code, a
   `completed` field, or a static manifest is not proof that live state matches
   the plan. `live_proof_recorded` is valid only for the deployed smoke or final
   verifier. `handoff_complete` is terminal and requests no further mutation.

## Credential boundary

- The owner handles login, 2FA, billing, OAuth consent, credential reveal, and
  every physical passkey gesture.
- Keep Cloudflare tokens, Brain keys, OAuth secrets, app passwords,
  authentication codes, passkey identifiers, and invite links out of chat,
  commands, logs, screenshots, and files.
- When a step needs a hidden prompt, use its `execution_boundary:
  owner_direct_terminal` command. Do not launch it in Claude's Bash tool and do
  not ask the owner to paste the value into Claude.
- Never run `brain invite` or copy an enrollment link through an AI-controlled
  or captured terminal. The owner mints and opens the one-time link in a
  terminal and display they control directly. Final verification must observe
  an enrolled device through the deployed data plane.
- For a first Cloudflare account, help the owner open Cloudflare's official
  sign-up page, verify their email, and complete 2FA and Workers Paid billing.
  If they already have an account, use that branch instead. One Cloudflare
  account can own several separate Brains. The API account list and the
  owner's exact selection remain authoritative before provisioning.
- Prefer the installer's named-profile Wrangler browser sign-in. Do not run
  `wrangler auth token`, print a broad Cloudflare token, or switch to Wrangler's
  default profile. An unrestricted local shell can technically reach the
  current user's credential stores, so leave Claude's normal approval prompts
  enabled and use the package-local Brain CLI for control-plane work.
- Prefer the exact `<brain-cli>` launcher over direct Wrangler commands because the Brain CLI
  applies account pinning, migration safety, protected key lookup, and proof
  checks. Use Wrangler directly only for a named diagnostic the owner approves.

## Source and file boundary

- The public smoke step is the only clean-install source action before owner
  handoff. After explicit approval, it sends one fixed public non-customer
  document through the deployed authenticated ingest path, requires its exact
  receipt, records the `install-smoke` source ready, and drains vector work.
  Never substitute an empty source row or private owner material.

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

## Plaid boundary

- Confirm the bank feed is enabled with provider `plaid`, environment
  `sandbox`, the final Brain hostname, and the exact registered return address.
  Refuse Production or any `api_base`, `link_sdk_url`, or `link_global` override
  before a hidden prompt.
- Give the owner the plan's exact structured Plaid command to run in their
  direct terminal. The client ID, secret, and independent version-2 wrapping
  key stay in hidden prompts. The second Link-page child receives none of them.
- Do not append `--json` to that owner command. Read the private status path it
  prints, then use its separate credential-free structured refresh. QuickBooks
  is the only Sandbox owner ceremony that returns a JSON result directly.
- Connection is still pending after that command. The account holder must sign
  in with a Brain passkey, finish Plaid Link, and assign every masked account to
  its owning entity. Preserve `live_provider_proof: false` until the deployed
  route, D1, webhook, reconciliation, recovery, and disconnect gates pass.

## QuickBooks boundary

- The client creates and owns the Intuit app and authorizes their own company.
  Financial Brain has no shared Intuit account and does not take credential
  custody.
- Confirm `corpora.quickbooks.enabled`, the explicit `sandbox` environment, and
  the exact registered localhost callback in the manifest before running
  `<brain-cli> technician <manifest> --run quickbooks --json`.
- Explain that Intuit's Accounting consent can authorize reads and writes even
  though Financial Brain performs query/read calls only. Keep that broader
  permission visible before the owner consents.
- Hand the terminal to the owner for both hidden app-value prompts, then let the
  owner complete Intuit consent in the browser. Never ask for either value in
  chat.
- If the manifest selects production, preserve
  `quickbooks_production_callback_unavailable` and stop. The client-owned HTTPS
  callback core is implemented but is not connected to this installer ceremony
  or field-approved yet. An API key cannot replace Intuit OAuth.
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

- When the owner says that Financial Brain failed, stopped, or "did nothing,"
  begin with the private local issue journal instead of asking them to copy a
  terminal error into chat. Run the exact package-local equivalents of:

  ```bash
  <brain-cli> support --preview
  <brain-cli> support --explain <ISSUE_CODE> --json
  ```

  `--preview` sends nothing. Read the newest safe event, use its `error_code`
  with `--explain`, and translate the reviewed recovery into ordinary language.
  Then run only the relevant read-only check, such as `doctor`, `health`,
  `sources`, `schedule`, or the technician plan. Never ask the owner to email or
  paste raw logs, provider responses, filenames, paths, source content, or
  authentication details. Do not export or transmit the journal unless the
  owner reviews the exact preview and approves that specific share.
- A useful first response is: "I found the local Financial Brain issue note. I
  will check what stayed protected and whether retrying is safe before changing
  anything." Report the stable issue code, the plain-language cause, what was
  protected, and the next action. If no safe event exists, say that clearly and
  use read-only checks rather than inventing a diagnosis.
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
