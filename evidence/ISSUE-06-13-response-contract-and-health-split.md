# Issues #6 and #13 evidence — `response.ok` is not a success signal, and `/health` stopped naming the client

Date: 2026-08-28. Branch `fix/worker-honesty-defects`, built in an isolated
worktree off `wave0/connector-gaps` (6985a91). Two reported defects, fixed
together because they meet on one route and pull in opposite directions: issue
13 wants `/health` to say less, and the honesty work that shipped just before it
needs `/health` to keep saying the one thing that matters.

No migration was added. The highest existing migration is `0018_extraction_provenance.sql`,
checked before starting because two branches recently collided on a number.

---

## Issue 6: the true scope

The report named two routes. The real scope is **five response sites and six
consumers**, and the consumers were the half that actually hurt.

### Routes that could return HTTP 200 carrying a failure

| Route | What was hidden in the body | Verdict |
|---|---|---|
| `/api/admin/brain/documents` | `vector_backlog.error`, `vector_readiness.error` — D1 errors | **Status now fails (503).** This route is only ever asked a health question. |
| `/api/rag/think` | `answer_error`, `degraded` | **Stays 200.** See below — this is deliberate. |
| `/api/rag/unified` | `degraded` (partial corpus read) | **Stays 200**, same reason. Found by scope work; not in the report. |
| `/api/admin/brain/ingest/batch` | per-document `status:"failed"` / `"refused"` | **Stays 200.** 49 of 50 documents genuinely landed and the caller must advance past them. |
| `/api/admin/brain/drain` | `r.failed` and `r.errors` were **computed and then dropped on the floor** | **Stays 200**, but the counts are now carried. Not in the report; found by reading the handler. |

One route was checked and deliberately **not** changed:
`/api/admin/brain/source-receipt` returns 200 with an `error` field, but that is
a connector's *own* reported failure being filed successfully. The route did
what it was asked. Marking it incomplete would teach every consumer that a
successfully recorded failure is a broken API call.

### Why not simply make every failure a non-2xx

`/api/rag/think` **must** keep answering 200 when retrieval could not run. The
disclosure explaining that the search did not complete *is the payload* — it is
what stops a model reporting "nothing recorded on this" about records it never
searched. A non-2xx makes every `ok`-checking client throw that sentence away
and print a bare status code, which is the exact defect the disclosure exists to
prevent. So the fix is two rules, not one:

1. When a route could not do the job it was asked to do, **the status says so**.
2. Every 2xx body that carries a failure declares **`complete: false`** and lists
   what failed in **`failures`**. One field, one meaning, every route.

`worker/src/lib/failure.js` is the single place that shape is defined, and both
the worker and the CLI import it so the two halves cannot drift.

### Consumers that checked `.ok` and nothing else

This is where the defect had teeth. Six were found; one was already safe.

| Consumer | Behaviour before | Now |
|---|---|---|
| `backlogCount` (brain.mjs) | **returned `0`** for a failed read — its own doc comment said "or 0 if it cannot be determined" | returns `null`; setup prints "was not verified" instead of a bare "Your brain is live." |
| `reportBacklog` (brain.mjs) | warned "Vectorize has not proven the same query-visible corpus" — a claim about Vectorize with no evidence, when the query never answered | names the failed read and says completeness is UNKNOWN |
| `acceptance.mjs` tier 2 | `{rows: []}` on failure | fails and names the subsystem (e.g. the missing column) |
| `acceptance.mjs` tier 1 auth | would have scored a 503 as **"correct key is accepted: FAIL"** | judges only 401/403, so a subsystem fault no longer reads as a bad credential |
| `report.mjs` | rendered "It currently holds **0 items**" from an unread corpus | says the count could not be read, in the same voice the searchability section already used |
| `report-html.mjs` | discarded the body entirely, or rendered an old worker's partial body as whole | keeps the rows and stamps them partial |
| `components/brain-mcp.mjs` `brain_health` | handed the model a body it would read as healthy | stamps `health_status: "incomplete"` and tells the model not to treat a low count as absence |
| `cmdHealth` (brain.mjs) | **already defended itself** — it checked `hasOwnProperty("error")` on the backlog | unchanged in spirit; now also names the failure via `describeFailures` |

`cmdHealth` is worth calling out: it was already doing the right thing, by hand,
for one route. That is the precedent this change generalises.

---

## Compatibility conclusion

**Changing `/api/admin/brain/documents` from 200 to 503 does not break a deployed
pairing, in either direction.** The reasoning, since the question is a real one:

- **Old CLI → new worker.** Every consumer of this route treats a non-2xx as a
  failure already (`if (!res.ok) return`, `if (!docs.ok) FAIL`). The worst case
  is an old CLI reporting "documents endpoint 503" instead of a nested D1 error.
  That is strictly better than reporting a healthy brain, which is what it does
  today. The rows and the nested `error` keys are still in the 503 body, so
  nothing an old client parsed has been removed.
- **New CLI → old worker.** This is the case that needed real work. An old
  worker reports the identical failure as a 200 with the error nested in the
  body, and `response.ok` is `true`. So `responseIncomplete` does **not** rely on
  the new `complete` field alone: it also recognises the legacy shapes directly
  (`vector_backlog.error`, `vector_readiness.error`, `answer_error`, per-document
  `failed`/`refused` receipts). A client machine is routinely newer than the
  brain it points at, so it defends itself rather than trusting the wire.
- **Absence is not treated as failure.** A worker that predates this contract
  never sets `complete`, so a missing field means "this worker cannot tell me
  either way", never "broken". `complete: true` is emitted even on success
  precisely so a caller can detect that the contract is implemented at all.

The additive fields (`failed`, `errors` on `/drain`; `complete`/`failures`
everywhere) are pure additions to JSON bodies, which no consumer schema rejects.

---

## Issue 13: the `/health` design, and the caller that would have broken

The reporter proposed splitting `/health` into an unauthenticated liveness probe
and an authenticated detail route. **The split is right; two separate paths are
not.** What shipped is one route with two tiers.

### What each caller actually needs, and whether it can authenticate

| Caller | Has a credential at that moment? | Needs |
|---|---|---|
| Client-facing runbook triage (`curl -sS -i .../health`) | **No** — it exists to tell a bot-protection block from a refused credential | liveness only |
| `probeUpgradePause` (brain.mjs, feeds `brain doctor`) | **No** — deliberately runs before/without key resolution | the paused fact |
| `cmdHealth` (brain.mjs) | Yes | version + drain mode |
| `acceptance.mjs` tier 1 | Holds the key, but probes **`{auth: false}` on purpose** | liveness publicly, version somehow |
| `worker/test/routes.test.mjs` paused-cutover check | Holds the key | writer protocol + drain mode |
| MCP `brain_health` | Yes (reads `/documents`, not `/health`) | unaffected |

Two callers have **no credential at the point they call**. Both need the
*honesty* fields and neither needs identity. So the tiers fall out cleanly:

- **Tier 1, no credential:** `ok`, `status`, `accepting_documents`, `reason`.
  The paused truth stays fully public. This is the honesty work from 0.1.19 and
  it is not traded away.
- **Tier 2, admin key:** `brain` (client slug), `version`,
  `vector_writer_protocol`, `vector_drain_mode`.

`identified: true|false` is always present, so a caller can distinguish "this
worker withholds identity unless you authenticate" from "this worker is too old
to have identity fields" — the version-skew tell.

**Why not a separate path.** A new path 404s on every worker deployed before it,
and the callers that need the detail already know this URL.
`GET /api/admin/brain/health` is registered inside the key gate as a named alias
for scripts that prefer an explicit admin route, but it is an alias, not the
mechanism.

### The caller the split genuinely broke

`acceptance.mjs` tier 1 asserted `h.json.version === expectVersion` against a
deliberately unauthenticated probe. Reproduced before fixing:

```
anonymous /health body: {"ok":true,"status":"ok","accepting_documents":true,"identified":false,"ts":"..."}
acceptance would compute observedVersion = null
acceptance verdict: FAIL — expected version 0.1.18, received none
```

It **can** authenticate — it holds the admin key and only omits it to prove the
worker answers publicly. So the liveness probe stays unauthenticated and the
version assertion moves to an authenticated read, falling back to the public
body when `identified` is absent so it still works against an older worker.

`worker/test/routes.test.mjs` broke for the same reason and was corrected the
same way, plus two added checks pinning that the paused barrier stays visible
with no credential at all.

### The honesty check, verified rather than assumed

```
paused, no credential: {"ok":false,"status":"paused-for-upgrade","reason":"This brain cannot accept
documents right now. An update paused its corpus writes and did not finish. ...",
"accepting_documents":false,"identified":false,"ts":"..."}
probeUpgradePause would report paused = true
```

The doctor's credential-free stuck-upgrade probe still sees the pause.

### Rate limiting, described honestly

The public tier is throttled at 60 requests/minute/IP. This is an in-memory
bucket inside **one Worker isolate**. Cloudflare runs many isolates in many
locations, so it slows one scanner hammering one colo and **cannot** bound a
distributed one. It is not a global rate limit and the code comment says so. It
is worth having because the cost is a `Map`. The authenticated tier is never
throttled, so an operator is never locked out of their own health route.

---

## Discrimination: proof the tests would catch a regression

Each fix was reverted to its pre-fix behaviour and the matching test re-run.

**1. Issue 6 — `/documents` returns 200 instead of 503**

```
FAIL  a /documents subsystem failure is a failing STATUS, not a 200  response.ok has to be false, or every ok-checking consumer reports a healthy brain
AssertionError [ERR_ASSERTION]: response.ok has to be false, or every ok-checking consumer reports a healthy brain
    at worker/test/response-envelope.test.mjs:144:12
  actual: 200,
  expected: 503,
```

**2. Issue 13 — `/health` discloses identity to everyone again**

```
AssertionError [ERR_ASSERTION]: the client slug is not disclosed without a key
+ actual - expected

+ 'fixture-client'
- undefined

    at worker/test/health-honesty.test.mjs:62:10
```

**3. Caller side — `null` backlog collapses back to `0`**

```
FAIL  an unread backlog is reported as unverified, not as zero
      The input did not match the regular expression /was not verified/i. Input:
      '  brain setup  nothing to a working brain ...'
```

All three restored and re-verified green afterwards. The caller suite also pins
the inverse: a genuine empty queue must print **no** warning, or the warning is
noise that fires on every healthy install and trains the owner to ignore it.

---

## Full suite

```
$ npm test > /tmp/worker-defects.log 2>&1; echo $? > /tmp/worker-defects-exit.txt
$ cat /tmp/worker-defects-exit.txt
0
```

Exit code read back from the file, not from a pipeline. 3419 `PASS` lines; every
remaining match for "fail" in the log is a test name or a `fail 0` counter.

One pre-existing red was found and **not** touched: `test/report-html.test.mjs`
("collect reports the suite as passing on a healthy stub") fails identically on
the pristine base commit — `{"pass":18,"fail":4,"warn":1,"skip":0}` with and
without this branch's changes. That suite is not wired into `scripts.test`,
which is why it rotted unnoticed. It is unrelated to these two issues and is
flagged for its own task rather than folded in here.

---

## In the owner's voice

Two things were true at once on this route, and the temptation was to pick one.
`/health` had just been taught to admit a paused upgrade, after that silence
cost an install eight days. Then the same route turned out to be telling anyone
who found the URL whose brain it was and exactly what it ran. Both findings are
right. What made them look like a conflict was the assumption that a route has
one audience.

It does not. The person running a ten-second triage curl has no key and needs to
know the brain is stuck. The person verifying a cutover has the key and needs
the version. Splitting by *credential* rather than by *path* gave both, and it
kept every deployed caller working, which a new path would not have.

The response-envelope half is the less visible fix and probably the more
important one. A route returning 200 with an error inside is not a formatting
problem, it is the same failure as reporting healthy what was never verified.
The worst line in the codebase tonight was a doc comment that said, plainly,
"Chunks still awaiting embedding, or 0 if it cannot be determined" — a function
that returned the same value for "nothing is queued" and "I could not find out",
feeding the sentence a client reads at the end of their install. Nobody was
deceived on purpose. It just was not written down anywhere that those are
different facts, so the code was free to conflate them. Now `null` is
unmistakable and the decision has to be made at the point of use.
