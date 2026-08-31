# Technician setup and local rehearsal

The owner should not have to understand OAuth, webhook validation, terminal
environment variables, or passkey relying-party rules. The technician workflow
turns those details into a small first-install ceremony. It does not hide the parts only
the account owner can do.

## Try the owner experience with no accounts

From a source checkout:

```bash
npm run rehearse:onboarding
```

The command installs only the local UI test dependencies when needed, builds
the real owner-workspace bundle, starts a loopback-only fixture, and opens a
safety page. Every screen says `LOCAL REHEARSAL`, uses invented data, and keeps
the following states one click away:

- populated owner workspace
- first passkey screen
- healthy empty Brain
- partial and unavailable reads
- conflict and lost-response retry
- exact-document guest access
- guest search with the scoped vector gap stated explicitly

Stop it with Control-C. Nothing is deployed, no manifest or credential store is
read, and no account is contacted.

This proves local layout, navigation, API response handling, access-surface
separation, and empty-versus-unavailable language. It does not prove Cloudflare,
Google consent, a real mailbox, Zoom delivery, or a physical passkey ceremony.

## Rehearse the customer hiccups

From the same source checkout:

```bash
npm run rehearse:hiccups
```

This offline lab deliberately tries the situations most likely to make an
install day feel difficult: an interrupted setup, a missing watched folder, a
partial connector, a lost save response, a paused migration, a search backlog,
a stale or out-of-scope access request, and a technician step that needs help.
It runs the product's real recovery, cursor, migration, deletion, authorization,
and idempotency tests with synthetic data and a credential-scrubbed environment.

The result names what passed automatically and the exact live field check that
still remains. Use `npm run rehearse:hiccups -- --list` to see the scenarios or
`npm run rehearse:hiccups -- --only folder-safety` to repeat one.

Provider expansion has a narrower credential-free rehearsal:

```bash
brain connectors
brain connectors --rehearse
brain connectors --rehearse --provider quickbooks
```

It runs the real QuickBooks, Slack, Notion, Microsoft 365, Dropbox, and HubSpot
adapters against invented responses with global network access trapped. It does
not open a credential store, read a manifest, contact a provider, or prove a
real account. The catalog also names LinkedIn export and browser-upload proof,
plus the deliberately absent Salesforce, QuickBooks Desktop, live LinkedIn,
official Facebook, and official WhatsApp paths.

## The one technician command

After installing the released CLI, start with the read-only plan:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json"
```

For a local coding agent, use the JSON form:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --json
```

The JSON contains workflow state, dashboard links, proof boundaries, and
structured command locators. It contains no credentials and its command plus
argument arrays must never be joined into a shell string. An agent may guide
the browser and explain each page, but the owner enters every token or secret
into the provider page or hidden terminal prompt.

The public first-install path covers local tools, the owner-terminal Cloudflare
install, one fixed public smoke document, an owner-only passkey handoff, and
live final verification. Plaid, Google,
QuickBooks, Zoom, and IMAP sections below are retained as implementation and
field-gate references only. Their technician commands fail closed in the public
path until secure credential custody and real-provider acceptance are complete.

## Public first-install steps and deferred field references

### 1. Local tools

Use the owner-facing `/install` page to install Node.js, Claude Code, and the
released Brain CLI. The owner signs in to Claude in their own browser. Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run tools
```

This proves the Claude CLI version and sign-in, installs and reads back the
personal `/financial-brain-technician` skill, runs Anthropic's interactive
doctor, and verifies profile-capable pinned Wrangler 4.127.1. Claude Code's normal approval prompts
stay enabled.

Open Claude Code and type `/skills`. Confirm `financial-brain-technician`
appears, then start the reviewed guide with:

```text
/financial-brain-technician
```

If Claude Code was already open before its first personal skill directory was
created, close and reopen it once. The skill contains no credential and does
not authorize deployment, account connection, upload, deletion, or access
changes. It begins by reading the release packet and printing the read-only
technician plan.

### 2. Cloudflare install

The JSON plan supplies an exact structured `owner_only_command` for this step.
The owner pastes and runs that package-local command in a terminal they control
directly. Claude must not launch it through its Bash tool. If attempted without
a real TTY, the step records `OWNER_DIRECT_TERMINAL_REQUIRED` before starting a
child. The owner signs in, confirms Workers Paid, creates the scoped installation
token, and enters it into the hidden prompt. The existing setup command performs
the account check, provisioning, migrations, deploy, key persistence, and
health proof. After it returns, Claude uses only the credential-free structured
refresh from the status receipt.

### 3. Fixed public smoke proof

After explicit owner approval for one tiny Workers AI embedding cost, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run smoke
```

This sends one fixed public non-customer document through the real deployed
authenticated ingest path. It requires the exact document receipt, records the
`install-smoke` source ready, drains vector work, and is idempotent after a lost
response. It reads no owner folder or customer material.

### 4. Plaid bank feed

Enable `corpora.bank_feed` with provider `plaid` and explicitly select Sandbox
or Production. The client owns the Plaid account and Link configuration.
Financial Brain has no shared Plaid account and no central bank-data custody.

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run plaid
```

The Plaid client ID, secret, and independent version-2 bank wrapping key are
entered only at hidden prompts. The technician step writes the named Worker
secrets without exposing their values. Once `brain doctor` confirms the exact
return address is recorded, hand the browser to the owner with:

```bash
brain connect bank "$HOME/Financial Brain/brain.manifest.json"
```

For a Claude-guided session, add `--print`; Claude can explain the next step
without opening the page or receiving a credential. The account holder signs
in, completes Plaid Link, and assigns every masked account to its business.
A configured connection is not reconciliation proof and never makes Plaid or
QuickBooks financial authority.

### 5. Google

Leave Drive disabled until the owner has selected the folders it may read. To
enable it, set `google_drive.enabled` to true and put the exact reviewed folder
ids in `google_drive.root_folder_ids`. Enable Gmail and Calendar only when they
are also in scope, then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run google
```

The owner creates a Desktop OAuth client in their Google Cloud project. The
client ID and optional client secret are entered at hidden prompts. Google
consent stays in the owner's browser. The launcher passes the values only to the
short-lived connector process and clears its input buffers afterward.

### 6. QuickBooks Online

Set `corpora.quickbooks.enabled` to `true`, select `sandbox` in
`corpora.quickbooks.environment`, and leave `redirect_host` at `localhost`
unless the exact Intuit sandbox registration uses the reviewed loopback
alternative. The client creates and owns the Intuit app and authorizes their own
sandbox company. Financial Brain has no shared Intuit account and does not
receive the app values or OAuth grant.

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run quickbooks
```

Both Intuit app values are entered at hidden prompts. Register the exact
callback printed by the command, normally `http://localhost:47812/`. The browser
consent page grants Intuit's broad Accounting permission, which can authorize
reads and writes. Financial Brain explains that scope clearly and performs
query/read calls only. The connector binds the credential and imported document
identities to the authorized company, so selecting a different company cannot
quietly replace an existing source. The command then prints the exact dry-run
and first-ingest commands. A successful connection or ingest means the
QuickBooks reference loaded. It does not prove the books are correct.

If this computer has a QuickBooks credential from an earlier release, run this
same sandbox connection once before ingest. That reconnect creates the company
binding; until then the ingest pauses with `source_binding_missing` instead of
guessing which company the older token belongs to.

Production connection is not available in this release. Selecting `production`
returns `quickbooks_production_callback_unavailable` before the credential store
or browser is opened. Intuit production OAuth needs the reviewed client-owned
HTTPS callback described in `docs/QUICKBOOKS.md`; an API key is not a substitute.
Disconnecting revokes provider access and leaves imported documents in place.
If the owner wants those documents removed, review a separate `brain forget`
preview together.

After the owner approves the real ingest and the matching bank account is
loaded, run one explicit Books Reality Check. Replace each example selector
with the reviewed account and period:

```bash
brain reconcile quickbooks "$HOME/Financial Brain/brain.manifest.json" \
  --account operating-checking --qbo-account 35 \
  --from 2026-07-01 --to 2026-07-31 --direction outflow --json
```

The command preserves the QuickBooks document and bank transaction as separate
evidence. It reports exact unique pairs, ambiguous duplicates, amount or date
conflicts, and one-sided records. It never resolves an exception or promotes
QuickBooks to financial authority. A company identity mismatch, changed account
pairing, missing source document, or incomplete evidence fails closed with a
stable `error_code` and `recovery`. Use the same command with `--status` for a
read-only check and `--retry` only after transport or lost-response uncertainty.

For a Claude or Codex-guided visit, copy this prompt exactly and replace only
the manifest path:

```text
Guide me through connecting my client-owned QuickBooks Online sandbox company to Financial Brain using /absolute/path/to/brain.manifest.json. First read the manifest and confirm corpora.quickbooks.enabled is true, corpora.quickbooks.environment says sandbox, and the registered callback exactly matches the command's localhost URL. If the manifest says production, explain the quickbooks_production_callback_unavailable boundary and stop before credential or browser access. Explain that I own the Intuit app and company authorization, Financial Brain has no shared Intuit account or credential custody, and QuickBooks will remain a reference rather than financial authority. Explain that Intuit's Accounting consent is broader than Financial Brain's read-only runtime queries. Ask before running brain technician with --run quickbooks --json. Hand the terminal to me for both hidden prompts and keep both app values out of chat, printed output, logs, and commands. Let me complete Intuit consent in the browser. Then show the exact dry-run and first-ingest commands and stop before the real ingest until I approve it. After a reviewed ingest and bank import, ask me to select exactly one Brain account slug, QuickBooks account ID, date range, and inflow or outflow direction. Show brain reconcile quickbooks with those selectors and --json, then ask before running it. Never expose the Intuit realm ID or credential. Explain that matched, mismatched, ambiguous, one-sided, unavailable, and insufficient-evidence results are review states, never financial authority. Preserve both sources, every exact citation, error_code, and recovery instruction. Never resolve an exception or treat a successful comparison as proof that the books are correct.
```

#### Optional human-confirmed tax review bridge

This is a manual evidence-recording workflow, not tax extraction. Use it only
when the exact tax record and exact annual QuickBooks profit-and-loss report are
already stored, readable, registered in `fin_documents`, and bound to the same
legal entity and period. The QuickBooks report document itself must come from
the `quickbooks` source and carry the reviewed company fingerprint.

Prepare a private JSON file outside the source repository and any synced folder.
Replace every placeholder only after a person has visually checked it:

```json
{
  "schema_version": 1,
  "confirmation": "owner_confirmed_from_document",
  "scope_kind": "single_entity",
  "entity_slug": "replace-with-reviewed-entity-slug",
  "legal_entity": "Replace with exact legal name",
  "tax_year": 2025,
  "period_start": "2025-01-01",
  "period_end": "2025-12-31",
  "currency": "USD",
  "tax_accounting_method": "cash",
  "tax_document": {
    "doc_uid": "replace-with-stored-tax-document-uid",
    "form_name": "Replace with exact form name",
    "form_version": "Replace with exact form version",
    "page": 1,
    "line_label": "Replace with exact gross receipts line label",
    "measure": "gross_receipts",
    "amount_minor": 0,
    "source_locator": "Replace with exact form, page, and line locator"
  },
  "quickbooks_report": {
    "doc_uid": "replace-with-stored-qbo-report-document-uid",
    "company_evidence_doc_uid": "replace-with-stored-qbo-company-document-uid",
    "report_name": "Profit and Loss",
    "total_label": "Replace with exact gross receipts total label",
    "measure": "gross_receipts",
    "period_start": "2025-01-01",
    "period_end": "2025-12-31",
    "accounting_basis": "cash",
    "currency": "USD",
    "amount_minor": 0,
    "source_locator": "Replace with exact report and total locator",
    "coverage": "complete_exact_report"
  }
}
```

Amounts are integer minor units, so 123.45 USD is `12345`. Zero is valid only
when the person verified that exact zero on the cited line or total. On macOS or
Linux, set the file to owner-only mode before running the bridge:

```bash
chmod 600 /private/path/reviewed-tax-qbo-claim.json
brain reconcile tax-quickbooks "$HOME/Financial Brain/brain.manifest.json" \
  --claim-file /private/path/reviewed-tax-qbo-claim.json \
  --confirm-reviewed-claims --json
```

For a Claude or Codex-guided review, copy this prompt and replace only the paths:

```text
Help me prepare a human-confirmed tax-to-QuickBooks review claim for /absolute/path/to/brain.manifest.json and save it only at /private/path/reviewed-tax-qbo-claim.json. Do not use OCR, retrieval snippets, bank deposits, transaction aggregation, or guessed mappings as proof. First verify that one exact tax document and one exact annual QuickBooks profit-and-loss report are already stored, readable, registered to the same single legal entity and exact period, and that the report document itself is QuickBooks-sourced and carries the same company fingerprint as the reviewed QuickBooks company evidence. If any custody, entity, tax year, period, currency, accounting basis, report coverage, company, or source fact is missing or ambiguous, stop and name it. Help me visually locate the tax form name and version, page, exact gross-receipts line label, and amount, then the QuickBooks report name, date range, cash or accrual basis, exact gross-receipts total label, and amount. Convert amounts to integer USD minor units only after I verify each conversion. Use gross_receipts as the measure on both sides only after I confirm those exact document labels are intended to represent that same measure. Write confirmation as owner_confirmed_from_document and scope_kind as single_entity. Keep the JSON file owner-only and never put its private contents in a command argument, chat, summary, log, repository, or synced folder. Open the local file for my private inspection instead of pasting it into chat, ask me to verify every field, then ask separately before running brain reconcile tax-quickbooks with --claim-file, --confirm-reviewed-claims, and --json. Explain that the CLI receipt omits the legal name, amounts, document IDs, and locators; matched, mismatched, and insufficient_evidence are review states; equal amounts prove no tax treatment; and the command never extracts, selects a winner, resolves a tax question, or changes either source document.
```

### 7. Zoom

Enable `zoom` in the manifest. A paid Zoom seat with cloud recording is
required. Then run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run zoom
```

The Zoom admin creates a Server-to-Server OAuth app with
`cloud_recording:read:admin`. `user:read:admin` is used only to prove the plan.
The event subscription includes both `recording.completed` and
`recording.transcript_completed`. The first creates durable delivery debt early;
the second wakes it when the transcript is ready. The command probes the account,
writes the four Worker secrets, and proves the live validation challenge before
it prints the webhook URL to save in Zoom.

### 8. IMAP

Enable `imap` in the manifest. Use the provider's IMAP host and an app password,
not the normal mailbox password:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run imap \
  --host imap.example.com --user owner@example.com
```

The app password is requested by the connector's hidden prompt. It is stored
only after a real mailbox read succeeds.

### 9. Owner passkey

Settle the final Brain hostname first. With the owner and intended device
present, the owner opens a terminal and display they control directly and runs
the package-local `brain invite <manifest>` command there. Do not run invite
creation through Claude, Codex, an agent tool, a captured terminal, or a shared
screen. The one-time URL must stay out of chat, logs, screenshots, and status
files.

Use the JSON plan's exact structured `owner_only_command`. It invokes the
package-local `invite` command directly and never routes the one-time link
through an agent. After the owner completes Face ID, fingerprint, or device PIN
on the final hostname, use the plan's structured continuation to run final
verification. That verifier must observe the enrolled device through the
deployed data plane.

### 10. Handoff checks

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run verify
```

This runs authenticated deployed health, source-freshness, and enrolled-device
postconditions with the manifest-declared durable key. It requires the exact
ready `install-smoke` source with at least one stored document, acceptable live
freshness, and at least one enrolled passkey. It stores aggregate counts only
and fails closed when a check is unavailable. Success refreshes to terminal
`handoff_complete`. It does not use a temporary Cloudflare token or infer
completion from a child exit code.

## Optional provider connection ceremony

QuickBooks Online, Slack, Notion, Microsoft 365, Dropbox, and HubSpot are
sandbox-ready but have not completed a real provider acceptance run. For one
selected provider:

1. Enable its exact `corpora.<provider>` block in the manifest and review its
   source selection.
2. In the owner's provider account, create the correct OAuth app and register
   `http://127.0.0.1:47812`. Slack must be a PKCE public client. Microsoft and
   Dropbox also use public-client PKCE. QuickBooks, Notion, and HubSpot require
   a client secret.
3. Let the approved local launcher inject the provider client ID and, only
   where required, its secret. Never place either value in the manifest or a
   command argument.
4. Run `brain connect <provider> <manifest>`, then
   `brain ingest <manifest> --from <provider> --dry-run`.
5. After the dry-run scope is reviewed, run the real ingest and record the
   provider-specific acceptance receipt. On macOS, install the declared refresh
   with `brain schedule <manifest> --provider <provider> --install`.
6. Prove `brain disconnect <provider> <manifest>`. The schedule stops first,
   local custody is removed only after the supported remote revoke step, and
   any remaining owner-portal revocation is named. Loaded documents stay until
   the operator previews and runs `brain forget` for that source.

The exact sandbox gates and deletion limitations live in
`docs/CONNECTOR-BACKLOG.md`. Do not convert fixture completion into a provider
proof claim.

## What the owner does and what the technician does

| Action | Owner | Technician or agent |
|---|---:|---:|
| Sign in, 2FA, consent, billing | Yes | Guide only |
| Create a persistent token or OAuth app | Final click | Explain and verify fields |
| Read or retain a credential | Keep it in the provider or hidden prompt | Guide without seeing it |
| Enter a credential | Hidden terminal or provider UI | Hand control to the owner |
| Run installer and connector checks | May observe | Yes |
| Complete passkey gesture | Yes, on their device | Observe result only |
| Approve a named folder for Claude | Yes | Preview the named folder read-only |
| Record proof and unresolved gaps | Confirm result | Yes |

## Live acceptance events

The following are the shortest honest field gates:

- Cloudflare: fresh install, exact-version health, and one synthetic document
  survives a retry.
- Google Drive: complete root-bound sweep, nested folder, shortcut, add, edit,
  visible move into and out of scope, trash, permission loss, Shared Drive,
  refusal, and resumable refresh against reviewed test folders.
- Gmail: one known received message and one sent message appear with provenance,
  then an incremental rerun adds no duplicate.
- Calendar: one event with attendees and one cancellation appear; an unreadable
  calendar produces a partial result rather than a false empty result.
- Zoom: one new paid-seat cloud recording produces a transcript after the two
  configured recording delivery events, and a missed-webhook rehearsal leaves
  durable debt for reconciliation.
- IMAP: Inbox and Sent read successfully, excluded folders are named, and a
  second sync resumes from the UID watermarks.
- Passkey: enroll, sign out, sign back in, add a second device, revoke it, and
  confirm the owner-facing telemetry contains no credential or ceremony secret.

Fixture tests make these trials easier and safer. The events above are the live
proof that finishes each connector or device check.

## When a step pauses

Every saved issue note has a stable code and a matching plain-language recovery
guide. The code is safe to read aloud to a technician.

```bash
brain support --explain AUTH_REQUIRED
brain support --explain AUTH_REQUIRED --json
```

The guide says what happened, what stayed protected, whether the same command
is ready to retry, the next two steps, and when a technician can help. The JSON
form gives Claude Code or Codex the same reviewed recovery contract without
including private error text.
