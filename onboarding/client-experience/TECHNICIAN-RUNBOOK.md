# Technician runbook

Use this with the owner present for every human ceremony. Start read-only and
complete one stage before opening the next one.

## 1. Readiness

1. Confirm the host computer, a current browser, internet access, and a separate
   passkey-capable device if the owner wants one.
2. Confirm Node.js 22 or newer. This is technician plumbing, not an owner task.
3. Confirm the owner can sign in to Claude Code in their own browser.
4. Confirm the owner controls the intended Cloudflare account and has reviewed
   the Workers Paid plan and possible usage charges.
5. Run `brain tools`. It verifies Claude Code, Claude sign-in, the installed
   `financial-brain-technician` skill, Anthropic's doctor, and pinned Wrangler 4.
6. In Claude Code, run `/skills` and confirm
   `financial-brain-technician` appears. Then start
   `/financial-brain-technician` with the reviewed packet and manifest paths.

The skill must begin with a read-only plan. Skill presence proves that the
instructions are installed, not that Cloudflare, a provider, or a passkey works.

## 2. Cloudflare login and temporary permission

The supported setup and update commands require an account-scoped Cloudflare
token. The owner creates it with exactly these permissions:

- Account, Workers Scripts, Edit
- Account, D1, Edit
- Account, Vectorize, Edit
- Account, Workers AI, Read
- Account, Workers R2 Storage, Edit only when the manifest enables R2

Set a short expiry, normally two days. The owner enters the value only in the
hidden `brain setup` or `brain update` prompt. Never put it in chat, a command,
an environment file, a screenshot, or a support note. On a supported Mac, the
CLI may offer to remember the account-bound token in Keychain. The owner can
remove it later with `brain token <manifest> --forget`.

If an older token cannot reach Vectorize, the temporary compatibility path is:

```text
npx wrangler@4 login
```

Wrangler opens the owner's browser for approval and keeps its OAuth session on
the local computer. Provisioning can use that session only as the documented
Vectorize fallback. New installs should use the correctly scoped token because
the rest of provisioning still requires the hidden token ceremony.

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
