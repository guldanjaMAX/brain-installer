# Your Financial Brain journey

This packet takes you from the first conversation to an accepted, supportable
Financial Brain. It is written for the owner and the technician to use together.
The owner keeps control of every account, login, billing choice, permission,
passkey gesture, source connection, and private-data load.

## The whole journey

| Stage | Owner time | Finish line |
|---|---:|---|
| Pre-interview | 45 to 75 minutes, one or two sittings | Approved sources, exclusions, key documents, and draft Golden 20 questions |
| Readiness and install | 60 to 90 minutes | The exact reviewed release is installed and reports healthy |
| First source | 45 to 90 minutes | One useful source is previewed, approved, loaded, and checked for freshness |
| Remaining sources | 30 to 90 minutes each, depending on provider | Each source has its own receipt and honest proof level |
| Initial meaning index | 30 minutes to many hours | The vector backlog reaches zero; the command can resume after interruption |
| Golden 20 | 60 to 90 minutes | Twenty owner-written cases are reviewed and saved |
| Acceptance and handoff | 30 to 45 minutes | Ownership, access, recovery, support, and the next update path are confirmed |

These are planning ranges, not promises. A large corpus, a provider review,
slow internet, an account controlled by another person, or a missing export can
extend the schedule. The technician records the actual time and remaining gates.

## What to have nearby

- The computer that will host the Brain. A current desktop browser is enough;
  the guide identifies the operating system before it shows commands.
- A passkey-capable phone, tablet, or computer for physical sign-in approval.
- The owner's Cloudflare and Claude accounts. The owner, not the technician,
  completes login, 2FA, plan selection, consent, and passkey gestures.
- One valuable folder or source that can be safely previewed first.
- The pre-interview answers and the twenty questions the owner wrote before
  retrieval was available.

Node.js 22 or newer is a behind-the-scenes technician prerequisite. The owner
does not need to learn Node.js or use it directly. The technician installs it
from the official source when the readiness check says it is missing.

## Start the pre-interview in Claude

Copy this prompt into Claude. It contains no secret and asks Claude to keep the
ceremonies that do involve secrets outside the conversation.

```text
Read onboarding/00-pre-install-interview.md from my reviewed Financial Brain packet. Interview me one question at a time. Build four lists as we go: questions my Brain must answer, sources I approve, sources or topics I exclude, and gaps that need a human or export. Do not ask me to paste a password, token, authentication code, private key, app password, invite link, passkey detail, or private file content. Stop before any login, account connection, upload, deployment, deletion, or billing change.
```

## Start install or update in Claude

For a new install, open `https://financialbrain.ai/install` on the host
computer. For an existing Brain, paste this into Claude Code:

```text
Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain. Begin read-only, explain one step at a time, and stop for my approval before any Cloudflare change, provider connection, private-data load, deletion, revocation, billing change, or invite. Keep every secret in its provider page or hidden terminal prompt, never in this conversation.
```

The public page pins one immutable release and gives both the person and Claude
the same commands. It does not deploy, connect, upload, or update anything by
itself.

## What counts as proof

The technician reports each item with one of these labels:

1. **Configured:** settings exist, but behavior has not been exercised.
2. **Locally validated:** the real local command or browser path worked without
   touching a live provider.
3. **Scripted or fixture proof:** deterministic tests passed with synthetic data.
4. **Live tested:** the named provider, account, device, or Cloudflare resource
   completed the stated action and returned a dated receipt.
5. **Accepted:** the owner reviewed the live result and signed the acceptance
   record.
6. **Blocked:** a named prerequisite is missing; the next safe action is stated.

A green test suite, a visible button, a packaged file, or a fixture is never
reported as live provider proof.

## Continue through the packet

- [Technician runbook](./TECHNICIAN-RUNBOOK.md) covers install, the app, and
  source onboarding.
- [Acceptance and handoff](./ACCEPTANCE-AND-HANDOFF.md) covers the Golden 20,
  ownership transfer, and future updates.
- [Support and offline recovery](./SUPPORT-AND-OFFLINE.md) covers interrupted
  work and the private support preview.
- [Data protection draft](./DATA-PROTECTION-DRAFT.md) is a factual product draft
  for privacy and legal review. It is not legal approval.
- `support-profile.example.json` is the single configurable support contact and
  response-target record. Replace it with the approved engagement profile
  before delivery.
