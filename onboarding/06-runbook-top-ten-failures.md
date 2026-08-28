> **TEMPLATE NOTE, delete before sending:** fill in `[INSTALLER CONTACT]`
> everywhere it appears, and replace `[WORKER_NAME]` with this install's worker
> name from the manifest. A runbook that says "call me" with no name or number
> is a dead end at 2am.
>
> An unfilled copy of this file also ships inside the installed package, so
> somebody will eventually read it with the placeholders still in it. If you are
> that reader: `[INSTALLER CONTACT]` is whoever set your brain up, and
> `[WORKER_NAME]` is the `worker_name` in your manifest. Every command below
> works as written either way.

# Runbook: the ten things most likely to go wrong

Written so you can fix it yourself. Every entry has what you see, why it happens, and the exact command.

---

## Before anything else

The installer reads the brain admin key from its durable local storage. Do not
copy `.brain-admin-key` into your shell. On Windows that file is a DPAPI
CurrentUser ciphertext envelope, not the key itself. A Cloudflare token is
needed only for account-changing commands such as verify, provision, deploy,
and secrets. The supported `brain setup` and `brain update` paths ask for it in
a hidden terminal prompt. Low-level automation must inject it through an
approved secret manager. Never paste a token or key into a shell command.

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

That prints one line per source with its status (pending, indexing, ready, or error), how many documents it holds, and when it last took anything in. When the durable admin key is available it also cross-checks those counts against what your brain actually holds and flags any gap, because the registry's number is its last receipt and the brain is the authority. **A drift of thousands is the cheapest signal available that a load died halfway.**

And the one that checks the parts of the install that are not questions and answers at all:

```
node brain.mjs doctor <manifest>
```

Given a manifest it goes past this machine and reads your brain's own state: whether it is paused partway through an upgrade, and whether every applied database change still matches the file it came from. That second check is the only thing that catches entry 9 before an update walks into it.

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

**You see:** every request refused. `{"error":"unauthorized"}`. During a health check: `401 on attempt 1/15, waiting for secret propagation`.

**Why:** keys take a few seconds to reach every location that serves your brain. Measured on a real install: ready between 5 and 10 seconds. Running the key change and the check back to back is a race, and losing the race looks exactly like a wrong password.

**Fix:** wait ten seconds and run it again.

```
node brain.mjs health <manifest>
```

It already retries fifteen times on your behalf, so if the first run reported the wait and then succeeded, nothing is wrong.

**If it is still 401 after the retries:** the message says `documents endpoint is still unauthorized after 15 attempts.` The durable local key does not match the deployed secret. Reapply the reviewed durable value through the supported setup path:

```
brain setup <manifest>
brain health <manifest>
```

`brain setup` prompts for the Cloudflare token without echo, reuses the
manifest's verified durable admin key, and applies that durable value to the
Worker. Do not update the Worker secret separately in the dashboard.

If the remote update fails, the durable value stays as the desired state.
Rerun `brain setup <manifest>` and it will apply that same durable value again.
If the intended replacement is not already in durable storage, stop and use the
installer/operator's approved no-history credential launcher with `brain
secrets`; that command does not provide a safe prompt for a new admin-key value.
If local persistence fails, the Worker was not changed. Never copy the Windows
`.brain-admin-key` envelope into another credential field.

**Who:** you.

---

### 1b. Every command is refused, but the same address opens fine in a browser

**You see:** commands against the brain fail with something that is not the brain's own answer. Instead of JSON you get an HTML page, or a body containing `error code: 1010`. It tends to start all at once, across every command, and it survives rotating the key. Then you paste the same address into a browser and it answers normally. That contradiction is the whole signature, and it is why this reads as a broken install rather than a blocked client.

**Why:** something in front of your brain is refusing programs. Cloudflare's bot protection decides per request, and it can turn away a client that does not look like a browser before your brain ever sees it. The refusal happens above your brain, so your key is never read and is never at fault. The installer's own commands identify themselves as `node`, which is exactly the kind of client such a rule is written to stop.

**Tell it apart in ten seconds.** The `/health` endpoint needs no key, so this probe carries no credential at all. Run both lines:

```
curl -sS -i https://<your brain's address>/health
curl -sS -i -A "Mozilla/5.0" https://<your brain's address>/health
```

If the first returns an HTML page or `error code: 1010` and the second returns JSON, you have your answer: your client was blocked, your brain is up. If both return the same thing, this is not your failure and entry 1 or entry 2 is the one to read.

**Fix:** stop the rule from applying to your brain's hostname. In the Cloudflare dashboard, open the zone that holds that hostname, then Security, and look at both the bot settings and any WAF custom rule that matches on user agent. Your brain is an API that your own tools call. It is not a public website that needs bot filtering, and filtering it blocks only you.

**This applies only when your brain is on your own domain.** An address ending in `.workers.dev` does not sit inside a zone you configure, so no zone rule of yours is refusing it, and the cause is somewhere else.

**One useful asymmetry:** the MCP server that connects your AI tools sends a browser User-Agent on every call already, and says so by name if it is refused anyway. So if your AI tools still answer while your terminal commands are refused, that gap points here. It is a signal and not a proof, because a rule matching on anything other than the user agent refuses both.

**Who:** you, in the dashboard.

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

Run `brain setup <manifest>` or `brain update <manifest>` in an interactive
terminal and enter the replacement token at the hidden prompt. If you need the
low-level `verify` command by itself, use an approved secret-manager-backed
launcher; never paste the token into a shell command.

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

**Fix:** reapply the verified durable key through the supported setup path.

```
brain setup <manifest>
brain health <manifest>
```

Setup prompts for the Cloudflare token without echo and reuses the durable
admin key. If that durable copy is missing or is not the intended value, stop
and use the installer/operator's approved no-history credential launcher with
`brain secrets`; never paste the admin key into a shell command.

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
   `node brain.mjs drain <manifest>`
2. Then fix the cause, or it silently refills: redeploy with
   `node brain.mjs deploy`, which restores the schedule. Confirm it in the
   Cloudflare dashboard under the worker, Settings, Triggers, where a Cron
   Trigger should be listed.

**Prevention:** run `brain health` after every deploy, not just after the first
one. This is the failure that looks fine from every angle except the answers.

**Who:** you.

---

### 5c. An update stopped during `accelerated legacy vector bootstrap`

**You see:** update reports a network interruption, a six-hour safety limit, or
an aggregate bootstrap failure. The Worker says corpus writes are paused.

**Why:** a pre-0.1.15 corpus must receive an exact generation receipt for every
legacy vector. The updater stores each accepted and confirmed 1,000-row batch
in D1. It keeps the write barrier active when the run stops because activating
the Worker would make an incomplete semantic projection look finished.

**Fix:** run the same supported update again:

```
brain update <manifest>
```

It waits out the writer boundary again, then resumes the saved D1 batch and
epoch. Do not run `brain deploy`, edit D1, or reset the projection cursor by
hand. Existing retrieval remains available while source and corpus writes are
paused.

After update succeeds, require both checks:

```
brain health <manifest>
brain test <manifest>
```

Both must report zero pending and submitted vector work with exact expected and
actual counts.

**Who:** you. Call [INSTALLER CONTACT] if the same aggregate failure repeats.

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

For cause 3, inspect and reinstall the local schedule, then confirm the source
freshness reported by the Worker:

```
node brain.mjs schedule <manifest> --status
node brain.mjs schedule <manifest> --install
node brain.mjs sources <manifest>
```

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

The same command cross-checks the registry against the authenticated live
document store whenever the install's durable admin key is available:

```
node brain.mjs sources <manifest>
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

Every `migrate`, `update`, and `upgrade` stops there, and stays stopped until this is reconciled.

**Why:** the bytes of a database change file are no longer the bytes that ran. The most common cause is not somebody rewriting the SQL, it is a line-ending change made by a different editor or a different machine. The stop is deliberate. If it were allowed through, two installs would silently have different databases while both reporting the same version, which is the worst possible state to debug: everything reports as up to date and nothing matches.

**Fix:** reconcile the recorded checksum. Nothing about your database is wrong, so nothing needs to be re-run or restored. The schema is already in the state the current file describes. Only the fingerprint recorded next to it is stale, and that is the one thing this changes.

First look at what changed. This reads and prints, and changes nothing:

```
node brain.mjs doctor <manifest> --repair-checksum
```

It reads your database, so like `brain setup` and `brain update` it asks for the Cloudflare token at a hidden prompt, or reuses the one this machine already remembers.

For every migration that no longer matches, it prints when it was applied, both checksums, the current file's size in lines and bytes, and whether the difference is only line endings. That last line is a proof rather than a guess: it converts the current file to LF and to CRLF and checks each against the recorded checksum. If neither reproduces it, it says `not confirmable as a pure line-ending change` and tells you to review the file by hand, because the bytes that originally ran were never kept, only their checksum was.

When the preview is right, confirm it:

```
node brain.mjs doctor <manifest> --repair-checksum --yes
```

That records the current file's checksum for each drifted migration and does nothing else. No migration SQL runs. Then confirm normal work is unblocked:

```
node brain.mjs status <manifest>
node brain.mjs migrate <manifest>
```

**`--repair` will not fix this, and it is the wrong reach.** It replays the same update path, which runs the same check and stops in the same place. `--rollback` does not fit either, because there is no bad change to restore away from.

**You do not need Git for this, and you do not need this file's history.** Your install is an unpacked release rather than a checkout, so there is nothing to check out and nothing to revert. Reconciliation is the whole fix, on the machine where the brain actually runs.

**With one honest exception.** When the preview says `not confirmable as a pure line-ending change`, it is telling you the truth about its own limits. The bytes that originally ran were never kept, so it cannot show you what changed, and on an install with no history of that file neither can anything else. Confirming is still narrow in what it touches, but you would be accepting a difference nobody has read. Send that preview to [INSTALLER CONTACT] before you add `--yes`. A drift that is confirmed as line endings needs no such call.

**Prevention:** plain `node brain.mjs doctor <manifest>`, with no flags at all, now checks this on its own and reports `migration checksums` as a FAIL naming the exact migration. That is on purpose: it is meant to find this before an update walks into it, not after.

**If it was an update that hit this, check whether your brain is also paused.** An update can reach the migration step after it has already deployed the paused build, so this stop can leave writes paused as well. `brain health <manifest>` reporting `accepting_documents: false` is that state, and entry 10 covers it. Reconcile the checksum first either way, because `--repair` keeps hitting the same stop until you do, then finish the update.

**Who:** you.

**If you maintain the source repository** and the file was edited there by mistake, restoring it in your own checkout and adding a **new** migration with the next number is the right fix in that repository. That is a separate job from the install above, and doing it there does not repair an install that has already stopped.

---

### 10. An update failed partway through

**You see:**

```
fail  upgrade failed: <reason>
      A restore point was captured BEFORE any change:
        D1 recovery bookmark: <bookmark>
```

**Why:** anything can fail mid-update. What matters is what the system did about it. A snapshot was taken **before** anything was touched, the failure was recorded, and **the recorded version was not advanced**, so your install correctly still reports the version it is actually running rather than the one it tried to become.

**A specific version of this is worth naming on its own: the update died AFTER pausing your corpus for the schema migration, and never reached the step that resumes writes.** If so, `brain health <manifest>` reports `accepting_documents: false`, and ingest, forget, and reindex all return 503 until it is fixed. This is deliberate (writing over a half-migrated schema is worse than staying paused) but it used to be silent: nothing told the operator this had happened, and the only way back was reconstructing "run brain update again" from the failure message by hand. It no longer is:

```
node brain.mjs doctor <manifest>
```

now checks the DEPLOYED brain's own live state, not just this machine's, as one more line in its output. A paused install shows up as a `FAIL` for "upgrade state" with the exact stage it stopped at, how long it has been stuck, and the D1 recovery bookmark, instead of silently reporting "ready to install" while your brain sits unable to accept a document.

**Fix, in order:**

1. Read what happened.

```
node brain.mjs status <manifest>
```

That prints your current version and the recent update history, including the failures. A line marked `rolled_back` is one that was reverted, and it is deliberately marked so it can never become the starting point for the next update.

2. Diagnose precisely, then resume. This replays the same verified update path from wherever it stopped, which is safe because every stage of it is already restart-safe by design:

```
node brain.mjs doctor <manifest> --repair
```

Previews only — nothing changes yet. It prints the exact stage, elapsed time, and bookmark. Once that looks right, confirm it:

```
node brain.mjs doctor <manifest> --repair --yes
```

This is equivalent to fixing the underlying cause (usually one of items 1 through 6 above) and running `node brain.mjs upgrade <manifest>` again by hand; `--repair` exists so that reconstructing the right command is not something you have to do while your brain cannot accept documents.

3. **Only if step 2 cannot work**, preview the snapshot restore. `--rollback` reads the exact bookmark straight out of the failed run instead of requiring you to have copied it down:

```
node brain.mjs doctor <manifest> --rollback
```

Confirm it the same way, with `--yes`, once the previewed bookmark is the right one. Or, with the bookmark already in hand from the failure message or `brain status`, the original manual path still works unchanged:

```
node brain.mjs rollback <manifest> <bookmark>
```

The preview changes nothing and names the exact D1 database and bookmark. It also
warns that Vectorize is not restored. If that reviewed target is correct,
perform the D1 restore explicitly:

```
node brain.mjs rollback <manifest> <bookmark> --yes
```

The Worker remains paused after restore. Reindex alone cannot enumerate vectors
written after the D1 bookmark. Under supervised recovery, create and bind a
clean Vectorize index, recreate every metadata index, then run reindex, drain,
health, and test to exact readiness before returning active mode.

**Restoring is destructive and irreversible.** Everything written since that snapshot is lost. It is deliberately not automatic, because doing it unattended against your only copy trades a broken update for possible data loss. Prefer fixing forward. Use the snapshot when fixing forward is not available, and do not return the brain to use until the supervised rebuild completes.

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

## Things that look like failures and are not

### Cleanup says `review required`

This is an intentional safety stop, not an installer crash. The proposed cleanup
crossed 100 documents or 10% of what that source had loaded. Nothing in the plan
was removed, and the source cursor was not advanced.

Review the aggregate reason counts in the message. If the change is expected,
rerun with the exact `--approve-removals <fingerprint>` value it printed. If the
change is surprising, do not approve it. Check the connection and source policy,
then rerun so a fresh source comparison produces a new plan.

**On a watched local folder this most often means the folder was not there.** A
cloud folder that had not finished syncing, an external drive that was not
mounted, a path that moved: all three look exactly like every file being
deleted. Confirm the folder really does hold what you expect before approving
anything. The local
issue note records only `SAFETY_REVIEW_REQUIRED`; it does not retain the
fingerprint, document identifiers, filenames, or message text.

### `refused: content carries live credential(s)`

A document was refused because it contains a live password or API key. The response names the kind of credential without ever quoting its value, so the message itself cannot become a second leak.

**Nothing was written.** This is the protection working exactly as intended.

**What to do:** rotate the named credential, because it has been sitting in a document. Then remove it from the file and load the document again. Do not turn the protection off to get the document in.

### "The documents do not answer this"

Not a failure. It is the feature. A tool that always produces something has taught you nothing about when to believe it. An honest "nothing recorded on this" is a real answer, and it is the reason the other answers can be trusted.

---

## What to send me when you need help

There is no telemetry in your install. It reports nothing to me, ever. Recognized installer failures attempt to keep a small private issue journal on your own machine whenever its local storage is writable, so useful technical facts are less likely to be lost. The original failure is never hidden if the journal itself is unavailable. It stores only typed metadata such as installer version, operating system, command, and failure category. It does not store document contents, filenames, paths, account details, URLs, questions, answers, logs, stack traces, or credentials.

After a successful note write, the installer makes a best-effort cleanup of
safe expired and overflow notes. Fresh or concurrently written notes are left
alone, and cleanup failure never changes the command's original result.

For an installer or scheduled-refresh problem, review the exact sanitized record first:

```bash
brain support --preview
brain support --export brain-support-review.jsonl
```

The installer does not upload or send the export. A sync service may upload it
when the chosen destination is in a synced folder. Share it only after you have
reviewed it.

For an answer-quality problem, the journal deliberately knows nothing about what you asked. Send:

1. The output of `node brain.mjs test <manifest>`, whole thing, including the passes.
2. The exact question you asked, copied and pasted, not paraphrased.
3. What came back.
4. What you expected instead.

Those four get most answer problems diagnosed in one reply instead of four.
