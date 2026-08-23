> **TEMPLATE NOTE, delete before sending:** fill in `[INSTALLER CONTACT]`
> everywhere it appears, and replace `[WORKER_NAME]` with this install's worker
> name from the manifest. A runbook that says "call me" with no name or number
> is a dead end at 2am.

# Runbook: the ten things most likely to go wrong

Written so you can fix it yourself. Every entry has what you see, why it happens, and the exact command.

---

## Before anything else

Two things need to be in your shell. Nothing else.

```
export CLOUDFLARE_API_TOKEN='<your token, for your own account>'
export ADMIN_KEY="$(cat .brain-admin-key)"   # setup saved it next to your manifest
```

**The one command that answers "is it broken":**

```
node brain.mjs test <manifest>
```

It runs five layers in order and tells you which one broke. If an early layer fails it stops and says `stopped after tier 1: later tiers would be noise`, because everything downstream would just be echoes of the same problem. Fix the tier it names, then run it again.

A quicker check, when you only want to know if it is up:

```
node brain.mjs health <manifest>
```

And the one that answers "what is actually in there, and is each part current":

```
node brain.mjs sources <manifest>
```

That prints one line per source with its status (pending, indexing, ready, or error), how many documents it holds, and when it last took anything in. When your admin key is in the shell it also cross-checks those counts against what your brain actually holds and flags any gap, because the registry's number is its last receipt and the brain is the authority. **A drift of thousands is the cheapest signal available that a load died halfway.**

---

## Stop and call [INSTALLER CONTACT]: two results that are emergencies

These two are different from everything below. Do not work around them.

### `THE BRAIN IS ANSWERING WITHOUT A KEY`

Appears in tier 1, on the check named "unauthenticated request is refused".

It means anyone who knows your brain's address can read your business records without a password. This is the single worst outcome this system can produce. Call [INSTALLER CONTACT] the moment you see it, at any hour.

### Tier 4 reports `THE GATE IS NOT ACTIVE`

The credential protection is not running, and the test probe that should have been refused was stored instead. The failure message prints the exact two lines of SQL needed to remove what it wrote. Run those, then call me, because the protection needs to be turned back on before anything else is ingested.

---

## The ten

### 1. Everything returns 401, right after setting up or changing a key

**You see:** every request refused. `{"error":"unauthorized"}`. During a health check: `401 on attempt 1/5, waiting for secret propagation`.

**Why:** keys take a few seconds to reach every location that serves your brain. Measured on a real install: ready between 5 and 10 seconds. Running the key change and the check back to back is a race, and losing the race looks exactly like a wrong password.

**Fix:** wait ten seconds and run it again.

```
node brain.mjs health <manifest>
```

It already retries five times on your behalf, so if the first run reported the wait and then succeeded, nothing is wrong.

**If it is still 401 after the retries:** the message says `still 401 after retries. Check that ADMIN_KEY here matches the deployed secret.` That is the real cause. The key in your shell is not the key on the server. Set both again:

```
export ADMIN_KEY='<the correct key>'
node brain.mjs secrets <manifest>
node brain.mjs health <manifest>
```

**Who:** you.

---

### 2. The brain's address returns nothing, right after an update

**You see:** a 404, or `404 on attempt 1/6, waiting for the route to propagate`.

**Why:** a freshly deployed brain is not routable for a few seconds. The address exists before it answers.

**Fix:** nothing. `health` retries six times with a five second wait between each. Let it finish.

**If it still fails after a full minute:** the deployment did not land at all. Check your Cloudflare dashboard, Workers and Pages, and confirm `[WORKER_NAME]` is in the list. If it is missing, redeploy:

```
node brain.mjs deploy <manifest>
node brain.mjs health <manifest>
```

**Note:** this cuts both ways. A **deleted** brain can also keep answering for a few seconds. Never confirm a deletion by visiting the URL. Confirm it against the list of workers in your account.

**Who:** you.

---

### 3. "Refusing to provision into a different account"

**You see:**

```
the manifest declares account 1a2b3c..., but this token can only see:
        4d5e6f...  Some Other Account
Refusing to provision into a different account than the manifest names.
```

Or, when the token can see several:

```
this token can see more than one account and the manifest does not say which:
```

**Why:** the token in your shell belongs to a different Cloudflare account than the one your brain lives in. This is the one mistake with no clean undo, so the tool stops rather than guessing.

**Fix:** issue a token from the correct account, or, if the account ID in the manifest is genuinely wrong, correct that instead.

```
export CLOUDFLARE_API_TOKEN='<token from the right account>'
node brain.mjs verify <manifest>
```

**Never fix this by deleting the account line from the manifest.** That does not solve the mismatch, it removes the guard that caught it.

**Who:** you.

---

### 4. `R2 is NOT enabled`

**You see:** during verification:

```
warn  R2 is NOT enabled (or the token lacks R2 scope). The client must enable it
        in the dashboard, which requires a payment method even on the free tier.
```

**Why:** Cloudflare's file storage needs separate activation and a card on file, even on the free tier. It is the most common mid-install surprise.

**Fix:** Cloudflare dashboard, R2, then enable it and add a payment method. Then:

```
node brain.mjs verify <manifest>
```

**This is a warning, not a stop.** Your brain runs without R2. Do not let it block anything else.

**Who:** you, in the dashboard.

---

### 5. Every question 401s right after a deploy

**You see:** searches that worked yesterday now return `unauthorized`. The
health check passes. The brain is up, but it cannot authenticate.

**Why:** the stored secrets were wiped by a deployment. Cloudflare erases every
secret on deploy **unless the deployment explicitly says to keep them.**
`node brain.mjs deploy` always says so. A deploy done by hand with another tool
usually does not, and it fails silently: the worker deploys perfectly and then
breaks on first use.

**Fix:** put them back.

```
export ADMIN_KEY='...'
node brain.mjs secrets <manifest>
node brain.mjs health <manifest>
```

**Prevention:** deploy with `node brain.mjs deploy`. That is what it is for.

**Who:** you.

---

### 5b. Search finds a document by its exact words but not by meaning

**You see:** searching a phrase lifted verbatim out of a document finds it.
Asking the same thing in your own words finds nothing, or finds the wrong
document. Nothing errors. Health passes. Both systems report up.

**This is the most likely failure this design has, and the least visible.**

**Why:** the text and its meaning live in two places. Ingest writes the text to
D1 immediately and puts the vector in a queue; a cron empties that queue every
five minutes. Until it does, the chunk is findable by keyword and invisible to
meaning-based search. Nothing reports this on its own, because neither system
is broken. The usual cause is that the cron is not running at all, which happens
when the worker was deployed by hand without its schedule.

**Check it:**

```
node brain.mjs health <manifest>
```

It reads the backlog and tells you how long the oldest item has been waiting.
**Anything older than about 30 minutes means the cron is not running.**

**Fix, in order:**

1. Empty the queue by hand right now, which is safe to run at any time:
   `curl -X POST https://<your-brain>/api/admin/brain/drain -H "X-Admin-Key: $ADMIN_KEY"`
2. Then fix the cause, or it silently refills: redeploy with
   `node brain.mjs deploy`, which restores the schedule. Confirm it in the
   Cloudflare dashboard under the worker, Settings, Triggers, where a Cron
   Trigger should be listed.

**Prevention:** run `brain health` after every deploy, not just after the first
one. This is the failure that looks fine from every angle except the answers.

**Who:** you.

---

### 6. Search works, but there are no written answers

**You see:** results come back with sources, but no written answer. The response carries an `answer_error` naming one of two things.

**`no LLM key configured`**

The Worker is missing its Cloudflare AI binding. The standard install does not
need an external provider key. Redeploy from the installer so the binding is
restored:

```
node brain.mjs deploy <manifest>
node brain.mjs health <manifest>
```

**`daily LLM spend cap reached`**

Working as designed. You hit the daily ceiling written into your install, which exists so a runaway process cannot produce a surprise bill. It resets at midnight UTC.

If it is happening regularly and legitimately, the ceiling is too low for how you use it. Raise `safety.daily_llm_spend_cap_usd` in the manifest and redeploy:

```
node brain.mjs deploy <manifest>
```

Before raising it, check **why** you hit it. A cap hit on a quiet day is a loop, not a busy day.

**Who:** you.

---

### 7. It stopped learning anything new

**You see:** the acceptance suite's freshness check moves from pass to warn to fail: `newest ingest 9 day(s) ago`. Nothing errors. Answers still come back, still cite sources, still sound confident. They are just made of old material.

**First, find out which source stopped:**

```
node brain.mjs sources <manifest>
```

One line per source. Look at the `last ingest` column. A source that is days behind while the others are current tells you where to look, and a source stuck on `indexing` has stalled mid-load rather than finished.

**Why, most likely first:**

1. **Your Google connection expired.** If you are on a personal gmail.com address and the app was left in Testing status, its access is revoked every seven days. This is the failure that looks like the product broke by itself about a week after handoff.
2. **A folder got un-shared.** Somebody tidied up permissions, and the read-only access no longer reaches a folder it used to.
3. **The scheduled run has not been firing.**

**Fix:**

For cause 1, publish the app to production in the Google Cloud console. Under Testing status, this will keep happening every seven days forever.

For cause 2, re-share the folder with the same read-only account, then run:

```
node brain.mjs test <manifest>
```

and confirm the freshness line returns to pass on the next scheduled run.

**This is the most dangerous failure in this document**, because it is the only one with no error message. A stale brain does not warn you mid-answer. It answers with old information in exactly the same confident voice. **The freshness line is the number to watch every month.**

**Who:** you for the re-share, me for the Google publishing step if it is still within the engagement.

---

### 8. It cannot find a document you know exists

**You see:** a question that should work returns nothing, or returns the wrong things.

**Check in this order:**

**a. Is it actually in there?**

```
node brain.mjs sources <manifest>
```

If the source you expected is missing, or its count is zero, or its status is still `pending`, the file never arrived. That is a loading problem, not a search problem, and no amount of rephrasing the question will fix it.

For the raw numbers straight from the brain, bypassing the registry entirely:

```
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://<your brain>/api/admin/brain/documents
```

**b. Is it still being processed?** The acceptance suite reports this as "embedding backlog". A backlog is normal for a few minutes after new material lands. A large one means processing is stuck, and the symptom you experience is exactly this: search does not find your document.

**c. Is the file type readable at all?** Images, video, audio, and scanned PDFs with no text layer are not read. There is no text recognition on scanned documents. See `07-ingest-source-matrix.md` for the full list of what is and is not read.

**d. Is it in an excluded folder?** Anything you excluded at intake was excluded at the source and was never read.

**Fix:** depends which of the four it is, and (a) is the one to check first because it is the most common and takes ten seconds.

**Who:** check (a) yourself, then send me the result.

---

### 9. "This migration was already applied but its content has changed"

**You see:**

```
migration 0002_llm_call_log was already applied but its content has changed.
      applied checksum a1b2c3d4, file checksum e5f6a7b8
      Never edit an applied migration. Add a new one instead.
```

**Why:** somebody edited a database change file after it had already run. This is a hard stop on purpose. If it were allowed, two installs would silently have different databases while both reporting the same version, which is the worst possible state to debug: everything reports as up to date and nothing matches.

**Fix:** restore that file to its original content, then add a **new** file with the next number for whatever change you actually wanted.

```
git checkout migrations/d1/0002_llm_call_log.sql
node brain.mjs migrate <manifest>
```

**Who:** me, or whoever is maintaining the code.

---

### 10. An update failed partway through

**You see:**

```
fail  upgrade failed: <reason>
      A restore point was captured BEFORE any change:
        node brain.mjs rollback <manifest> <bookmark>
```

**Why:** anything can fail mid-update. What matters is what the system did about it. A snapshot was taken **before** anything was touched, the failure was recorded, and **the recorded version was not advanced**, so your install correctly still reports the version it is actually running rather than the one it tried to become.

**Fix, in order:**

1. Read what happened.

```
node brain.mjs status <manifest>
```

That prints your current version and the recent update history, including the failures. A line marked `rolled_back` is one that was reverted, and it is deliberately marked so it can never become the starting point for the next update.

2. Fix the underlying cause (usually one of items 1 through 6 above), then run the update again.

```
node brain.mjs upgrade <manifest>
```

3. **Only if step 2 cannot work**, restore the snapshot:

```
node brain.mjs rollback <manifest> <bookmark>
```

**Restoring is destructive and irreversible.** Everything written since that snapshot is lost. It is deliberately not automatic, because doing it unattended against your only copy trades a broken update for possible data loss. Prefer fixing forward. Use the snapshot when fixing forward is not available.

**Who:** me, during the engagement. After handoff, the commands above are complete and the snapshot ID is printed at the time of failure. Keep it.

---

## If a load brought in the wrong material

Not a failure exactly, but the thing people most fear before authorizing a big import, so it is worth knowing the answer before you need it.

Every load runs under a **name**. That name is the undo. If a load pulled in a folder you did not want, or duplicated something, or reached further than intended, you remove that one load without touching anything else:

```
node brain.mjs forget <manifest> --source <name>
```

**Without `--yes` it removes nothing.** It prints exactly what would go: how many documents, whether a resume position is being cleared, when that source was registered and what it was told to cover. Read that, then run it again with `--yes` if it is right.

If you get the name wrong it stops and suggests the closest match rather than reporting a cheerful success for a source that was never there.

A bad import being one command instead of a support call is the reason you can authorize the big one.

---

## Two things that look like failures and are not

### `refused: content carries live credential(s)`

A document was refused because it contains a live password or API key. The response names the kind of credential without ever quoting its value, so the message itself cannot become a second leak.

**Nothing was written.** This is the protection working exactly as intended.

**What to do:** rotate the named credential, because it has been sitting in a document. Then remove it from the file and load the document again. Do not turn the protection off to get the document in.

### "The documents do not answer this"

Not a failure. It is the feature. A tool that always produces something has taught you nothing about when to believe it. An honest "nothing recorded on this" is a real answer, and it is the reason the other answers can be trusted.

---

## What to send me when you need help

There is no telemetry in your install. It reports nothing to me, ever, which means I cannot see your problem unless you show it to me. That is a real cost of your owning this outright, and it is the trade I would make again.

So send:

1. The output of `node brain.mjs test <manifest>`, whole thing, including the passes.
2. The exact question you asked, copied and pasted, not paraphrased.
3. What came back.
4. What you expected instead.

Those four get most problems diagnosed in one reply instead of four.
