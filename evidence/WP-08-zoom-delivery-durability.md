# A Zoom transcript that fails after the acknowledgement is now a debt, not a rumour

Branch `fix/zoom-delivery-durability`, worktree branched from
`wave0/connector-gaps` at `ca61e51`.

## The defect

Zoom treats a slow webhook response as a failure and disables an endpoint that
keeps failing, so the connector answers `200` first and does the real work
afterwards. Everything expensive lives on the far side of that acknowledgement:
the OAuth token exchange, the recording lookup, the transcript download, the
credential gate and the store write. This was the entire failure handler:

```js
    } catch (error) {
      console.error(`[zoom] transcript ingest failed: ${String(error?.message || error).slice(0, 300)}`);
    }
```

Zoom considers an acknowledged delivery finished and will never send it again.
So the call was not in the brain, nothing counted it, nothing reported it, and
the only trace was a line in a log inside the client's own Cloudflare account
that nobody tails. `brain sources` could not help: the source receipt is written
only on success, and there is deliberately no refresh expectation, so a broken
connector and a quiet week looked identical. The owner would go looking for a
call weeks later, not find it, and have no way to learn when it had stopped.

Two smaller versions of the same thing sat beside it. A recording whose
transcript file was not there yet warned `Zoom may still be writing it` and then
never tried again. And a comment in the pause branch reassured that nothing is
lost that "a later delivery or a manual re-fetch cannot recover" — there has
never been a manual re-fetch. That sentence is corrected in this branch rather
than left standing.

## The mechanism, and why this one

**One D1 row, written synchronously before the acknowledgement.** From that
instant the transcript is owed by this brain rather than hoped for by a
background promise. `migrations/d1/0020_zoom_delivery_ledger.sql` adds
`zoom_deliveries`, keyed on the per-occurrence recording uuid — the same key the
document is stored under (`zoom:<uuid>`), so the ledger and the corpus cannot
disagree about which call is which.

It satisfies the four constraints as follows.

| Constraint | How |
|---|---|
| The acknowledgement must stay fast | One INSERT on a binding the worker already holds. No provider call, no embedding, no second service. |
| A post-acknowledgement failure must be RECORDED | The row is written **before** the 200. The background attempt then settles it (`stored` / `refused`) or leaves it `owed` with its error and a scheduled next attempt. If the INSERT itself cannot be made, the webhook answers **503** instead of 200, keeping the delivery on Zoom's own retry schedule — an unrecorded obligation must never be acknowledged. That is the same trade the existing paused-for-upgrade branch already makes. |
| It must be retried, or at minimum surfaced | Both. `sweepZoomDeliveries` runs on the `*/5` cron every D1 install is already required to have (`brain deploy` refuses to leave a D1 install without it), with exponential backoff and six attempts before write-off. |
| The owner must learn without suspecting | A debt older than one hour sets `sources.stale_reason` on the `zoom` row. That is the field the freshness surface already owns, so it appears in `brain sources`, in `brain health`, as an acceptance FAIL, and — the important one — as a `sync_broken` coverage gap attached to **every answer** through `coverageGaps`, which `/api/rag/think` already calls on every query. |

**Existing machinery, not a parallel one.** The deferred-work pattern in this
codebase is an outbox table drained by a scheduled tick (`vector_outbox`,
`drainOutbox`), and the honest-reporting surface is `sources.stale_reason` read
by `freshnessReport` and `coverageGaps` — the same one that recently learned to
call an unsupervised capture source `unscheduled` rather than `manual`. This
change is those two patterns applied to a second kind of owed work. No new cron,
no new binding, no new endpoint, no new dashboard, and nothing for a client to
provision.

**Rejected, deliberately:** Cloudflare Queues (a second binding to provision in
the client's account, for a handful of rows a day); a Durable Object per
recording (same objection plus a migration class to maintain forever); doing the
work before the 200 (Zoom's timeout rules it out); and a polling sweep of Zoom's
recordings list, which is a different feature — see the section on
never-delivered recordings below.

### Two judgement calls, stated because they are trade-offs rather than facts

**A one-hour grace before the alarm.** Zoom announces transcripts it is
sometimes still writing, so the first attempt failing is ordinary and
self-correcting. Alarming on it would put a red line on `brain sources` and a
gap on every answer several times a week for something that fixes itself in five
minutes, and a warning that fires for nothing is how a client learns to ignore
the warning that matters.

**A written-off delivery drives the alarm for fourteen days, then stops.** The
row is kept forever; only its effect on the SOURCE's state expires. A permanent
alarm for a call that can no longer be recovered is a nag nobody can clear. The
record stays in `zoom_deliveries`, and a new failure raises the alarm again.
This is the one place where a real, unrecoverable loss stops being shouted
about, and it is a choice rather than an oversight.

## What the owner actually sees

Real output, from a run where the recording lookup returns `403` (the
missing-scope case, one of the four failures that live entirely past the 200):

```
--- zoom_deliveries row ---
{
  "uuid": "aB3/xY9z+Qw==",
  "state": "owed",
  "attempts": 1,
  "last_error": "transcript ingest failed: Zoom refused the recording read. The Server-to-Server OAuth app needs the cloud_recording:read:admin scope."
}

--- brain sources / brain health line ---
{
  "name": "zoom",
  "kind": "zoom",
  "state": "broken",
  "source_status": "error",
  "documents": 0,
  "days_since_ingest": null,
  "expected_every_days": null,
  "last_complete_sweep_at": null,
  "indexing_started_at": null,
  "hours_indexing": null,
  "reason": "1 Zoom transcript(s) that Zoom reported ready are not in the brain. The oldest is \"Quarterly review with the partnership team\" from 2026-08-20, last failing with: transcript ingest failed: Zoom refused the recording read. The Server-to-Server OAuth app needs the cloud_recording:read:admin scope. They are retried automatically every few minutes",
  "automatable": false
}

--- the gap attached to every answer ---
[
  {
    "type": "sync_broken",
    "source": "zoom",
    "days_since_ingest": null,
    "detail": "The \"zoom\" source stopped updating: 1 Zoom transcript(s) that Zoom reported ready are not in the brain. The oldest is \"Quarterly review with the partnership team\" from 2026-08-20, last failing with: transcript ingest failed: Zoom refused the recording read. The Server-to-Server OAuth app needs the cloud_recording:read:admin scope. They are retried automatically every few minutes. Anything added since is not in the brain."
  }
]
```

That third block is the one that matters. It rides on an answer to an unrelated
question, so the owner learns a call is missing without having gone looking for
it. The sentence names the count, the meeting, the date and the cause, because
a count on its own is an alarm and a named meeting is something a person can act
on.

**A defect found while writing this evidence, and fixed:** the first version cut
Zoom's error at a fixed width and produced `needs the cloud_recording:read.` — a
scope name that reads as complete and is wrong. A clipped value now ends in
`...` so it looks clipped, and there is a test for it.

## Recordings that were never delivered at all

**Not detectable, and not claimed to be.** The ledger records deliveries Zoom
made and this worker verified. If the webhook never arrives — the worker was
down long enough to exhaust Zoom's own retries, the Secret Token had drifted so
verification 401'd, the Event Subscription was removed, or the call predates the
connection — then no row is written here, no document is written anywhere, and
nothing in this brain knows the meeting happened. Its absence is
indistinguishable from a week with no meetings. There is a test that asserts
exactly this rather than leaving it to be discovered.

**What it would take.** A scheduled poll of the client's own recordings list
(`GET /v2/users/me/recordings?from=&to=`), diffed against `zoom_deliveries` and
against the `documents` rows under `zoom:<uuid>`. This change supplies the half
of that comparison that did not exist before: a durable record of what Zoom told
us about. The half still missing needs two things that are decisions rather than
code. First, a Zoom **listing** scope this connector deliberately does not
request today, which changes what a client is asked to grant. Second, a second
writer racing the webhook, which is the exact duplication the reference
implementation needed claim rows and three partial unique indexes to survive.
Not built here, because the brief was durability of what Zoom did deliver, and
because smuggling a permission change into a durability fix would be the wrong
way to make that decision.

## Tests

`worker/test/zoom-durability.test.mjs`, registered in the `package.json` chain
after `worker/test/zoom.test.mjs`. It runs against a **real SQLite database**
with the real migrations applied, drives the real route through `worker.fetch`,
and uses the **real D1 store** — so "the retry completed the delivery" means a
`documents` row and a `chunks` row exist, not that a stub was called. The
owner-visible half is proven through `freshnessReport` and `coverageGaps`, the
same two functions `brain sources`, `brain health`, `acceptance.mjs` and every
`/api/rag/think` answer read, rather than through an assertion invented for the
test.

```
PASS  the webhook still acknowledges Zoom fast, with a 200
PASS  and states that the delivery was written down as durable
PASS  a post-acknowledgement failure leaves a ledger row, not just a log line
PASS  the row says the transcript is still OWED
PASS  it counts the attempt that just failed
PASS  it records WHY, naming the Zoom scope rather than a bare status
PASS  it names the meeting, so the debt can be looked up later
PASS  and it schedules the next attempt in the future
PASS  no document was written for a transcript that was never fetched
PASS  the failure is still logged at full volume as well as recorded
PASS  inside the grace window the source is NOT called broken (a retry in flight is not a fault)
PASS  past the grace window the zoom source reads BROKEN in `brain sources` and `brain health`
PASS  and the reason names the meeting the owner is missing
PASS  the reason says how many transcripts are missing
PASS  the SAME condition becomes a coverage gap, which rides on every answer the brain gives
PASS  so the owner learns a call is missing while asking about something else entirely
PASS  the sweep found the owed delivery and attempted it
PASS  the retry stored the transcript
PASS  a real document now exists under the recording's own uuid
PASS  with the meeting topic as its title
PASS  and the parsed transcript text really landed in a chunk
PASS  the ledger row is settled as stored, so it is never retried again
PASS  the source stops reading broken once the debt is paid
PASS  the stale reason is cleared rather than left to nag
PASS  and the coverage gap disappears from answers
PASS  a healthy delivery is acknowledged and marked durable
PASS  the delivery settles as stored on the first attempt
PASS  nothing is owed
PASS  nothing was abandoned or refused
PASS  a working connector never reports itself broken
PASS  and adds no gap to any answer
PASS  the document is in the brain
PASS  a redelivered webhook does not reopen a settled delivery
PASS  and does not write a second document
PASS  a delivery this brain cannot write down is refused with 503, so Zoom retries it
PASS  the refusal says plainly that the delivery was not recorded
PASS  and no Zoom API call was made for a delivery that was refused
PASS  nothing is logged as a silent drop
PASS  with the ledger table missing the delivery is still processed
PASS  but the acknowledgement does NOT claim durability it does not have
PASS  and the operator is told exactly which command closes the hole
PASS  the sweep reports the missing table rather than throwing on every tick
PASS  a recording with no transcript file is owed rather than dropped
PASS  after 6 attempts the delivery is written off, not retried forever
PASS  and the write-off keeps the reason, which names the Zoom setting to fix
PASS  a written-off transcript still reports the source as broken
PASS  and the sentence tells the owner retries are exhausted
PASS  after the alert window the alarm clears but the ledger row is kept as the record
PASS  a 500 from Zoom burns one attempt
PASS  with Zoom unconfigured the attempt is recorded but the budget is not spent
PASS  and the reason says Zoom is not configured on this brain
PASS  a disconnected brain says the owed transcripts cannot be fetched until it is reconnected
PASS  the first claim on a due delivery succeeds
PASS  a second claim inside the lease is refused, so the retry runs once
PASS  a claim that is never settled becomes available again after the lease expires
PASS  and an unfinished claim leaves the attempt count untouched
PASS  a recording whose webhook never arrived leaves NO ledger row
PASS  and the backlog therefore reports nothing missing, because it cannot know
PASS  a delivery that was never made is indistinguishable from a week with no meetings
PASS  which the module states in its own words rather than leaving to be discovered
PASS  a transcript stored by the retry is byte-identical to one stored inline
PASS  both record a source receipt, so `brain sources` sees either path
PASS  a delivery is owed before the tick
zoom deliveries: 1 retried, 1 stored, 0 still owed
PASS  the cron tick that already drains the vector outbox also settles the Zoom debt
PASS  and the Zoom sweep still ran even though the vector drain on the same tick failed
PASS  a paused install leaves the debt owed rather than writing behind the pause
PASS  a delivery that is not due yet is not attempted by the sweep
PASS  and its schedule is untouched
PASS  after a second failure the next attempt is further out than the first was
PASS  the attempt count advanced with it
PASS  a transcript refused by the credential gate is settled as refused, not retried
PASS  the ledger names the credential kind and never stores its value
PASS  no document was written
PASS  and the refusal is still logged
PASS  a refusal does not make the source read broken: the gate did its job
PASS  but it stays countable in the ledger
PASS  a redelivery does not reopen a refused delivery
PASS  deferring a delivery with no ledger row does not throw and does not invent one
PASS  the reason names the count, the meeting, the date and the cause
PASS  it never doubles a full stop where it splices Zoom's own sentence in
PASS  and it carries no trailing stop, because coverageGaps composes it into a longer sentence
PASS  a clipped topic or error is visibly clipped rather than silently wrong
PASS  nothing is reported missing when nothing is

zoom durability: all 83 tests passed
```

### One existing test was changed, and why

`worker/test/zoom.test.mjs`'s credential-gate case rigged the DB binding to
throw on **any** use, as a sentinel for "a refused transcript never reaches the
store". The webhook now legitimately writes one `zoom_deliveries` row before it
acknowledges Zoom and one `sources` row after, so that sentinel became too
coarse. It now throws on any statement touching `documents`, `chunks`,
`chunks_fts` or `vector_outbox`, which is what the test was actually asserting
and is **stricter** than "the binding was untouched" — the old version would
have passed a write to the wrong table. A new assertion in the same block checks
that the refusal is written down as a settled delivery rather than only logged.

### Proving the tests discriminate

Each defect was reintroduced, the suite run, the matching assertions confirmed
to fail, and the code restored. Verbatim first failing lines:

**Break A — do not record the debt before acknowledging (the original design).**
Replaced the pre-acknowledgement `recordZoomDeliveryOwed` call with
`durable = false`.

```
FAIL  and states that the delivery was written down as durable  {"ok":true,"event":"recording.transcript_completed","accepted":true,"durable":false}
FAIL  a post-acknowledgement failure leaves a ledger row, not just a log line  []
FAIL  the row says the transcript is still OWED  null
FAIL  it counts the attempt that just failed
FAIL  it records WHY, naming the Zoom scope rather than a bare status  undefined
```

Exit code `1`, 20 assertions failing.

**Break B — record and retry the debt, but never tell the owner.** Disabled the
`stale_reason` write in `reconcileZoomSourceState`.

```
FAIL  past the grace window the zoom source reads BROKEN in `brain sources` and `brain health`
FAIL  and the reason names the meeting the owner is missing  undefined
FAIL  the reason says how many transcripts are missing  undefined
FAIL  the SAME condition becomes a coverage gap, which rides on every answer the brain gives  []
FAIL  so the owner learns a call is missing while asking about something else entirely  undefined
FAIL  a written-off transcript still reports the source as broken
FAIL  and the sentence tells the owner retries are exhausted  undefined
FAIL  a disconnected brain says the owed transcripts cannot be fetched until it is reconnected  null
```

Exit code `1`, 8 assertions failing — and note that only the *reporting*
assertions failed, which is the discrimination working: the ledger tests still
passed because the ledger still worked.

**Break C — record and report the debt, but never retry it.** Made the sweep
`continue` past every claimed row and the scheduled tick skip it.

```
FAIL  the sweep found the owed delivery and attempted it  {"available":true,"due":1,"attempted":0,...,"source_state":"broken",...}
FAIL  the retry stored the transcript  {"available":true,"due":1,"attempted":0,...}
FAIL  a real document now exists under the recording's own uuid  []
FAIL  the ledger row is settled as stored, so it is never retried again  {...,"state":"owed","attempts":1,...}
FAIL  the cron tick that already drains the vector outbox also settles the Zoom debt  {"row":"owed","docs":0}
```

Exit code `1`, 19 assertions failing.

**Break D — a success that never settles its own row.** Disabled the `stored`
branch of `applyZoomDeliveryOutcome`, so a healthy connector keeps reporting a
debt it does not have.

```
FAIL  the delivery settles as stored on the first attempt  {...,"state":"owed","attempts":1,...,"settled_at":null}
FAIL  nothing is owed  {"owed":1,"overdue":1,...}
FAIL  a working connector never reports itself broken  {...,"state":"broken",...}
FAIL  and adds no gap to any answer
FAIL  a redelivered webhook does not reopen a settled delivery  {...,"state":"owed",...}
```

Exit code `1`, 12 assertions failing.

After each restore: `zoom durability: all 83 tests passed`.

## What could NOT be proven, and why

**There is no paid (Licensed) Zoom account in this environment, and nothing
below was faked to look otherwise.** No test in this repository has ever spoken
to Zoom, and this change does not alter that. Everything above is fixture-level
truth about this brain's behaviour given scripted Zoom responses.

Specifically unproven here:

1. **A real failed delivery.** No real Zoom webhook has ever arrived, so no real
   post-acknowledgement failure has ever been recorded, retried or reported.
2. **That a real Zoom retry after a 503 behaves as documented.** The 503 path
   for an unrecordable delivery depends on Zoom retrying it, which is Zoom's
   documented behaviour and has not been observed.
3. **Zoom's real failure modes.** The four scripted here (403 scope, 500, a
   recording with no transcript file, a download failure) are the ones the API
   documents and the reference implementation handles. What Zoom actually does
   when a transcript is half-written is unknown, and it is the case the
   five-minute retry is most likely to meet first.
4. **Timing under a real Cloudflare invocation.** The ledger INSERT is one D1
   statement, but its real latency against Zoom's real timeout has not been
   measured. If it ever proved slow enough to matter, the fix is a shorter
   statement, not skipping it.
5. **The `no such table` string.** The deploy-before-migrate branch keys on D1
   surfacing SQLite's `no such table` wording. That is what SQLite emits and
   what `node:sqlite` emits in these tests, and it is what D1 has emitted in
   this project's own logs, but it is a string comparison against a provider
   message and it is worth knowing that it is one.

**Also worth naming: the ledger is D1-only.** On a Supabase-backed install there
is no `zoom_deliveries` table, so this connector remains exactly as durable as
it was before, which is not durable. The webhook says so in its own response
(`durable: false`) rather than implying otherwise. That backend exists as a
migration and rollback path; refusing every Zoom delivery on it would be a worse
answer than processing it and stating the limit.

## The owner-voice paragraph, for the integrator

> Zoom gives your brain one shot at a transcript. It sends a notification, your
> brain has a couple of seconds to answer, and once it has answered Zoom
> considers the job done and never sends that call again. Until now, if anything
> went wrong after that answer — a permission changed in your Zoom app, Zoom was
> still writing the file, the download failed — the transcript simply was not in
> your brain, and the only trace was a line in a log nobody reads. You would
> find out weeks later, when you went looking for a call and it was not there.
> Now, the moment your brain answers Zoom, it writes down that it owes you that
> transcript. If the fetch fails, it keeps trying on its own. If it is still
> missing an hour later, your brain tells you: `brain sources` shows the Zoom
> source as broken, the acceptance checklist fails, and every answer your brain
> gives carries a line naming the meeting that is missing. You find out because
> you asked your brain something else, not because you thought to check. One
> thing this still cannot see, and it is worth knowing: if the notification
> never reaches your brain at all, nothing knows the meeting happened. Catching
> that would mean asking Zoom for a permission this connector deliberately does
> not ask for, so it is not built and it is not claimed.

## Files

New:

- `migrations/d1/0020_zoom_delivery_ledger.sql`
- `worker/test/zoom-durability.test.mjs`
- `evidence/WP-08-zoom-delivery-durability.md`

Modified:

- `worker/src/lib/zoom.js` — the durability section, the ledger-first route, one
  shared delivery body for both callers, and the corrected pause comment
- `worker/src/index.js` — the sweep on the existing `scheduled` tick, in its own
  `waitUntil` with its own catch
- `operations/cloudflare-recovery-adapter.mjs` — `zoom_deliveries` added to
  `RECOVERY_DURABLE_TABLES` and to a new `SCHEMA_20_TABLES` gate, and
  `RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION` bumped 19 → 20. Required: the
  adapter refuses to export a database whose table inventory does not match its
  reviewed list, and it is exported because a recovered brain that came back
  without the ledger would silently forget every transcript it still owed
- `worker/test/zoom.test.mjs` — the credential-gate sentinel narrowed to the
  corpus tables, plus one new assertion
- `test/package-privacy.test.mjs` — the new migration added to the reviewed
  package allowlist
- `onboarding/07-ingest-source-matrix.md` — the Zoom row and section say what
  happens when a transcript does not load, and what still cannot be seen
- `package.json` — one test file added to the chain. **No version bump and no
  `CHANGELOG.md` heading**, per the parallel-branch merge discipline

## Migration number

`0020`. The highest existing migration on the branch point was `0019`
(`0019_recovery_codes.sql`); checked before writing rather than assumed, given
that two branches recently collided on `0017`.
