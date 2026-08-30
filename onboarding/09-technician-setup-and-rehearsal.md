# Technician setup and local rehearsal

The owner should not have to understand OAuth, webhook validation, terminal
environment variables, or passkey relying-party rules. The technician workflow
turns those details into seven small ceremonies. It does not hide the parts only
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

The JSON contains workflow state, dashboard links, proof boundaries, and the
next reviewed command. It contains no credentials. An agent may guide the
browser and explain each page, but the owner enters every token or secret into
the provider page or hidden terminal prompt.

## Seven steps

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

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run cloudflare
```

The owner signs in, confirms Workers Paid, creates the scoped installation
token, and enters it into the hidden prompt. The existing setup command performs
the account check, provisioning, migrations, deploy, key persistence, and
health proof. It is safe to rerun after an interruption.

### 3. Plaid bank feed

Enable `corpora.bank_feed` with provider `plaid` and explicitly select Sandbox
or Production. The client owns the Plaid account and Link configuration.
Financial Brain has no shared Plaid account and no central bank-data custody.

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run plaid
```

The Plaid client ID, secret, and independent version-2 bank wrapping key are
entered only at hidden prompts. The technician step writes the named Worker
secrets without exposing their values. The account holder later completes
Plaid Link in the browser. A configured connection is not reconciliation proof
and never makes Plaid or QuickBooks financial authority.

### 4. Google

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

### 5. QuickBooks Online

Set `corpora.quickbooks.enabled` to `true` and explicitly select `sandbox` or
`production` in `corpora.quickbooks.environment`. The client creates and owns
the Intuit app and authorizes their own company. Financial Brain has no shared
Intuit account and does not receive the app values or OAuth grant.

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run quickbooks
```

Both Intuit app values are entered at hidden prompts. The existing loopback
OAuth flow opens the browser for owner consent and stores the connection in the
existing local provider credential store. The command then prints the exact
dry-run and first-ingest commands. A successful connection or ingest means the
QuickBooks reference loaded. It does not prove the books are correct.

For a Claude or Codex-guided visit, copy this prompt exactly and replace only
the manifest path:

```text
Guide me through connecting my client-owned QuickBooks Online company to Financial Brain using /absolute/path/to/brain.manifest.json. First read the manifest and confirm corpora.quickbooks.enabled is true and corpora.quickbooks.environment explicitly says sandbox or production. Explain that I own the Intuit app and company authorization, Financial Brain has no shared Intuit account or credential custody, and QuickBooks will remain a reference rather than financial authority. Ask before running brain technician with --run quickbooks --json. Hand the terminal to me for both hidden prompts and never ask me to paste, print, log, or put either app value in a command. Let me complete Intuit consent in the browser. Then show the exact dry-run and first-ingest commands, stop before the real ingest until I approve it, and preserve any error_code and recovery text without exposing company identifiers or credentials.
```

### 6. Zoom

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

### 7. IMAP

Enable `imap` in the manifest. Use the provider's IMAP host and an app password,
not the normal mailbox password:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run imap \
  --host imap.example.com --user owner@example.com
```

The app password is requested by the connector's hidden prompt. It is stored
only after a real mailbox read succeeds.

### 8. Owner passkey

Settle the final Brain hostname first. With the owner and intended device
present, run:

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run passkey \
  --confirm-host brain.example.com
```

The confirmation exactly matches `brain.domain`. The command creates one
single-use link that expires in 15 minutes. The owner opens it on their device
and completes Face ID, fingerprint, or device PIN. This is the first point where
a physical passkey becomes proven.

### 9. Handoff checks

```bash
brain technician "$HOME/Financial Brain/brain.manifest.json" --run verify
```

This runs doctor, health, source freshness, and enrolled-device checks in order.
It stops on the first failure and does not mark anything complete. Record a
connector as live-proven only after its exact acceptance event occurs.

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
