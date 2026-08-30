# Running the intake (internal, not for the client)

The questionnaire does three jobs. Only one of them is obvious to the client.

| Job | Where it happens | What it protects |
|---|---|---|
| Sources the **seed questions** | §6 | The first session. Without these there is nothing to show at kickoff, and the reveal becomes a demo of our technology instead of an answer about their business |
| Asks the **Workspace vs Gmail** question | §5.1 | A consumer-Gmail client whose OAuth app is left in Testing has refresh tokens revoked every 7 days. The brain silently stops updating about a week after handoff and looks like it broke on its own |
| **Disqualifies** the wrong client | §4.2 | An engagement we cannot deliver. Document-level permissions are a genuine auth model change, not a sprint |

---

## How to run it

**Live on a call, not async.** Async returns thin answers to §6, and §6 is the section that decides whether the kickoff lands. Send it ahead so they can think, then walk it together.

**45 minutes.** Sections 1 through 5 take fifteen. Budget the remaining thirty for section 6 and do not rush it.

**Take their words verbatim in §6.** Do not tidy the questions into better English. "Why did we stop using those guys" retrieves differently than "vendor termination rationale", and theirs is the one that has to work.

---

## The three answers that change everything

### §4.2, the permission question

If the answer is that some users must not see some content: **stop**. Do not scope, do not estimate, do not promise a later phase with a date on it.

Say it plainly: the current version has one level of access, that is not right for their situation, and you would rather say so now than discover it in week three. Offer to come back when permissions ship.

Losing this deal costs nothing. Taking it costs the fee, the reference, and a month.

### §5.1, Workspace or consumer Gmail

**Workspace:** register the OAuth client as user type Internal inside their own organisation. No Google verification, no security assessment, no warning screen, no expiry. Confirm they are a real Workspace or Cloud Identity org, since Internal is only selectable if so.

**Consumer Gmail:** Internal is not available. The app must be **published to production**, not left in Testing. Testing status expires refresh tokens after seven days, and that is the failure that looks like the product broke by itself.

`calendar.events.readonly` is a sensitive scope, not a restricted one, so no CASA assessment applies. The client will see a one-time "Google hasn't verified this app" screen during setup. Tell them it is coming so it does not read as a red flag mid-install.

If they refuse both the warning screen and verification, the durable fix is a Workspace account on their own domain at roughly $7 to $14 per user per month. The iCal-address fallback works without OAuth but loses incremental sync, deletions, and most attendee detail, so it is materially worse for a brain.

### §2.4, the single highest-value folder

This sets the **priority slice**. It goes in first, gets proven, and everything else streams in behind it.

Do not ingest chronologically. Ingest by likely answer value, which is usually the last 12 to 24 months plus every meeting transcript. A default tuned for steady state quietly ruins the first impression.

---

## After the call

1. Copy §6.1 into the manifest as `testing.probe_questions`. These become the acceptance suite's retrieval probes and the kickoff script.
2. Copy §2.1 and §3 into the manifest as sources and exclusions.
3. Record the §5.1 answer in the manifest. It determines the OAuth path.
4. Set the priority slice from §2.4.
5. Send the client the effort table from §7 as a standalone one-pager, so their commitments are in writing and separate from the questionnaire.

---

## What to listen for beyond the answers

**"It's all in my head."** If §6.2 comes back thin, the material may not be written down anywhere, and the brain can only read what exists. Say so during intake, not at kickoff. It is not a reason to decline, but it changes what you promise.

**Hesitation on §3.** Someone who cannot name a single exclusion has usually not thought about what is in their files. Push gently. It is nearly always a personal folder, an HR folder, or a legal matter.

**Someone else controls the accounts (§5.3).** An outsourced IT provider or agency becomes a dependency you do not control, and it can stall an install for weeks or refuse it outright. Either get that person on the kickoff, or quote the access work separately.

**They cannot answer §9.2.** If they cannot say what "worth it" looks like, neither of you can tell whether it worked, and the renewal conversation in month three has nothing to stand on.
