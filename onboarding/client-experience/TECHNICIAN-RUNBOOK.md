# Technician runbook

Use this with the owner present for every human ceremony. Start read-only and
complete one stage before opening the next one.

## 1. Readiness

1. Confirm the host computer, a current browser, internet access, and a separate
   passkey-capable device if the owner wants one.
2. Confirm Node.js 22 or newer. This is technician plumbing, not an owner task.
3. Confirm the owner can sign in to Claude Code in their own browser.
4. Ask whether this is the owner's first Cloudflare account or an account they
   already control. Confirm the Workers Paid plan and possible usage charges.
5. Run `brain tools`. It verifies Claude Code, Claude sign-in, the installed
   `financial-brain-technician` skill, Anthropic's doctor, and pinned Wrangler 4.
6. In Claude Code, run `/skills` and confirm
   `financial-brain-technician` appears. Then start
   `/financial-brain-technician` with the reviewed packet and manifest paths.

The skill must begin with a read-only plan. Skill presence proves that the
instructions are installed, not that Cloudflare, a provider, or a passkey works.

## 2. Cloudflare account and browser approval

For most owners, choose **Create my first Cloudflare account**. The installer
opens Cloudflare's official sign-up page so the owner can create the account,
verify the email address, and complete Cloudflare's own sign-in protection. If
the owner already has Cloudflare, choose **Use a Cloudflare account I already
have** and sign in normally. When a login can reach more than one account, pause
while the owner confirms the exact account by both name and ID.

One Cloudflare account may hold several Brains. Each one still receives a
separate Worker, D1 database, Vectorize index, secrets, hostname, and saved
resource IDs. Recommend another Cloudflare account only when separate billing
or administrators would help.

Wrangler opens Cloudflare in the owner's browser and keeps this Brain's named
profile in the Mac or Windows OS keyring. The installer uses the short-lived
access value only in memory and clears it after the exact-account action. The
owner does not need to copy any Cloudflare token into chat, Claude, Codex, or a
command.

An expiring account-scoped API token remains available for a reviewed legacy,
automation, or recovery path. If that exact plan calls for one, use only its
required permissions: Workers Scripts Edit, D1 Edit, Vectorize Edit, and Workers
AI Read, plus R2 Storage Edit only when this manifest uses R2. Set a short
expiry, normally two days. Let the owner enter the value only through the Brain
CLI's hidden prompt, or let reviewed automation use an approved no-history
launcher. It stays out of the command line, chat, environment files,
screenshots, and support notes.

The named-profile and keyring contract passes deterministic local tests. A real
browser callback on the final Mac and Windows machines, plus live Vectorize
access under the exact Wrangler approval, remain field gates. Record those
results before describing the path as production-proven.

## 3. Install and app acceptance

Follow `https://financialbrain.ai/install`. Use only the pinned commands on the
page. Before setup, state which Cloudflare resources will be created and wait
for the owner's approval.

The install stage is complete only when all of these are recorded:

- exact installer version and package digest;
- Cloudflare account identifier and final owner-approved hostname, without a
  secret or raw credential;
- D1, Worker, Vectorize, and optional R2 checks;
- `brain doctor <manifest>` result;
- owner passkey enrollment on the final hostname;
- sign-out and sign-in with the physical passkey;
- app load on desktop and mobile width with keyboard-accessible controls;
- unknown or unavailable states presented plainly, without false empty states;
- no outstanding vector backlog before semantic-search acceptance.

Automated app tests do not replace the final-hostname passkey ceremony.

## 4. Source onboarding

Connect one source at a time. For every source:

1. Name the account, mailbox, folder, drive, export, or human custodian in
   ordinary language. Do not place credentials in the record.
2. Confirm who owns it, what is approved, what is excluded, and whether another
   person or organization controls access.
3. Run the source's dry run or preview. A preview is read-only and sends no
   private content.
4. Show the owner the proposed scope, exclusions, estimated size, and whether
   the path is native, export-based, watched, scheduled, or manual.
5. Ask for exact approval to connect or ingest that source.
6. Load it. If interrupted, rerun the same supported command so the source can
   resume from its own state.
7. Record created, updated, unchanged, refused, partial, unavailable, and failed
   outcomes separately.
8. Verify freshness, provenance, and one known item from the real source.
9. Run the applicable exclusion or leak tripwires from the pre-interview.
10. Record the proof level and the next missing live acceptance step.

An API is not required. A named human custodian, portal download, or periodic
export is a valid source when its owner, cadence, provenance, and gap state are
explicit.

### Source onboarding prompt

```text
Read onboarding/07-ingest-source-matrix.md and the current manifest. Begin read-only. Show me the sources that are configured, released but not connected, partial, unavailable, or export-only. Recommend one valuable low-risk source to preview first. Do not log in, connect, ingest, delete, schedule, or change a provider until I approve that exact action. Keep credentials and private source content out of this conversation. After each approved source, report its counts, freshness, provenance, proof level, and remaining live acceptance test.
```

## 5. Before Golden 20

Do not start the Golden 20 while a required source is unavailable, the initial
vector backlog is nonzero, a known exclusion leaks, or the owner has not written
the twenty questions from memory. Fix or explicitly accept each gap first.
