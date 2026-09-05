# Handoff and revocation

Template. Fill every bracket before sending. Delivered at the end of the kickoff session, immediately after the revocation is performed live.

---

**To:** [CLIENT NAME]
**From:** [IMPLEMENTATION OWNER / ORGANIZATION]
**Date:** [DATE]
**Subject:** Your brain is yours. Here is what was removed, what you own, and how to run it without me.

---

## 1. What was revoked, and when

At **[TIME] on [DATE]**, with you watching:

| What | Action | Result |
|---|---|---|
| My Cloudflare API token for your account | Deleted | I can no longer see, deploy to, or delete anything in your Cloudflare account |
| The stored copy of that token on my computer | Removed with `brain token <manifest> --forget`, with you watching | My machine's keychain holds nothing for your account — a revoked token must also stop existing locally, not linger as clutter |
| The pinned Wrangler session on my computer, if setup announced one | Removed with `npx wrangler@4.73.0 logout`; `npx wrangler@4.73.0 whoami` then confirms no authenticated account | No account-wide Cloudflare browser session remains on my machine |
| My access to your [Google Drive folders / source] | Removed by you | I can no longer read any of your source material |
| Your admin key | Rotated by you, to a value I have never seen | I cannot query your brain, even at its public address |

The Cloudflare and admin credentials used during the build are rotated, revoked,
or removed at handoff. If setup announced a Wrangler session, its logout row
must be completed before claiming access is gone. Written answers use the
Cloudflare AI binding, so there is no separate model-provider key to transfer or
revoke.

Once those steps are done I hold **no credential of any kind** to your infrastructure, your material, or your brain.

This is not a policy I am promising to follow. It is a fact about what keys exist. There is no support account, no vendor backdoor, and no copy of your data on any machine I control, because there never was one. Your material was read in your account, indexed into your account, and answered from your account.

### Verify it yourself, today

Do not take my word for any of the above. All three areas are checkable in about five minutes:

1. **Cloudflare.** Log in, go to **My Profile, then API Tokens**. The token named `[TOKEN NAME]` should not be listed. If it is, delete it now and tell me. If setup announced a Wrangler session on my computer, `npx wrangler@4.73.0 whoami` there must also report no authenticated account.
2. **Google.** Open the sharing settings on the folders you granted, or the service account list at [LOCATION]. My access should not appear.
3. **Your admin key.** You rotated it during our session. I was not shown the new value and it exists only in your own store.
After all three, run `node brain.mjs test <manifest>` yourself. If the brain
still answers, the remaining credentials and Cloudflare AI binding are working.

If any of those three does not check out, that is a real problem and I want to hear about it the same day.

---

## 2. What you own now

Everything. Here it is written down, because "you own it" is worthless if nobody can find it.

| Thing | Where it lives | What it is |
|---|---|---|
| Cloudflare account | [ACCOUNT EMAIL], account ID `[ACCOUNT_ID]` | Everything below sits inside it |
| Your brain (the worker) | `[WORKER_NAME]`, at `[BRAIN URL]` | The service that answers questions |
| Database | Cloudflare D1, `[D1_NAME]`, ID `[D1_ID]` | Version tracking and spend accounting |
| File storage | Cloudflare R2 bucket `[R2_BUCKET]` | Stored files |
| Search index | Cloudflare Vectorize index `[VECTORIZE_INDEX]`, in YOUR account | The meaning of your material, as vectors |
| Text and keywords | Cloudflare D1 database `[D1_NAME]`, in YOUR account | Your material itself, and the keyword index over it |
| Answer model | Cloudflare Workers AI in [ACCOUNT EMAIL] | Writes the answers in the same account, capped at $[CAP] per day |
| Source access | [GOOGLE SERVICE ACCOUNT / OAUTH CLIENT] | Read-only access to every Drive file this Google account can access; manifest folder IDs limit what content is downloaded and ingested |
| Admin key | [WHERE YOU STORED IT] | The password to your brain. Treat it like one |
| Your manifest | `[PATH / REPO]` | The one file that describes your install. Contains no secrets |
| The installer and its tools | `[PATH / REPO]` | Everything needed to verify, update, or rebuild |

**The manifest is the important one.** It is the single file that differs between one install and another. Anyone competent, holding that file and your own credentials, can rebuild or move this. That is deliberate: it means you are not dependent on me existing.

---

## 3. How to run it without me

Routine checks use the admin key from the manifest's durable local storage, so
you do not need to copy it into your shell. For account-changing work, run the
supported `brain setup` or `brain update` path. A scoped token deliberately
injected by an approved launcher has first priority. Otherwise the command
announces and uses an existing pinned Wrangler 4.73.0 session. If neither is
available, it asks for the scoped token in a hidden prompt. Prefer the scoped
token when least-privilege access is appropriate. Never paste a token into a
shell command or leave it in shell history.

Then, from the installer folder:

| You want to | Run |
|---|---|
| Prove the whole thing works, all five layers | `node brain.mjs test <manifest>` |
| Quick "is it up" check | `node brain.mjs health <manifest>` |
| See what it holds, per source, and when each last updated | `node brain.mjs sources <manifest>` |
| Remove one source and everything it brought in | `node brain.mjs forget <manifest> --source <name>` |
| See what version you are on, and the update history | `node brain.mjs status <manifest>` |
| Reconnect your AI tools, or add a new machine | `node brain.mjs mcp-config <manifest>` |
| Change a key or password | `node brain.mjs secrets <manifest>` |

`brain secrets` is the exact admin-key rotation command. It normally reads the
existing value from the manifest's durable local storage. A deliberate new
replacement must be supplied through the installer/operator's approved
no-history credential launcher; never paste it into a shell command. The
command reports success only after the durable local value reads back exactly
and the Worker accepts it. If the remote update fails, rerun the same command
without supplying the key again; the verified durable copy is the retry source.

Existing installer-owned Claude Code and Codex registrations are refreshed with
the non-secret manifest locator during rotation. Claude Desktop is not changed
automatically: replace its manual entry with the locator-only output from
`brain mcp-config <manifest>`, then restart Claude Desktop.

`test` is the one that matters. It runs five layers in order: is it reachable and locked down, is there anything in it and is it current, does a real question return real sources, does the credential protection actually refuse, and is the version and configuration right. It is read-only apart from one deliberate probe that must be refused.

**It is the same suite I ran in front of you with my access removed.** Nothing about it needs me.

### The monthly routine, five minutes

1. Run `node brain.mjs test <manifest>`.
2. Read the failures and warnings at the bottom. The freshness line is the one to watch: a brain that quietly stops taking in new material still answers confidently, using old information.
3. Run `node brain.mjs sources <manifest>` and check the last ingest date on each line.
4. Check your Cloudflare bill against the numbers in section 2.

### When something breaks

Use the runbook you were given: `06-runbook-top-ten-failures.md`. It covers the ten most likely failures with the symptom, the cause, and the exact command.

### If you want me back in

Issue a fresh scoped Cloudflare API token. At the start of the supported work,
you enter it yourself at the hidden `brain setup` or `brain update` prompt. For
low-level automation, your approved secret manager must launch the process and
inject the token without exposing it in a command, log, or shell history. Do
not send the credential to me or put it in a shared channel. **Delete it when
the work is done.** That is the cost of the custody model and I would rather it
be slightly inconvenient than have a standing key to your business sitting in
my password manager for years.

---

## 4. How to delete all of it

You should know how to do this before you ever want to. Nobody needs permission from me, and nothing here routes through me.

**If you only want to remove part of it**, you do not need any of this. Every load runs under a name, and removing one name removes everything it brought in and nothing else:

```
node brain.mjs forget <manifest> --source <name>
```

Without `--yes` it removes nothing and prints exactly what would go. That is the tool for "index everything except, on reflection, that folder".

The rest of this section is for removing **all** of it.

**Read this first: every step below is irreversible.** Deleting the database and the search index destroys your index permanently. It does not touch your original documents in Google Drive, which are untouched throughout and always have been.

In this order:

1. **Delete the search index.** In your own Cloudflare account: `npx wrangler@4 vectorize delete [VECTORIZE_INDEX]` removes the vectors, and Workers and Pages, D1, then delete `[D1_NAME]` removes the text and the keyword index. Both live in your account, so this is yours to do and needs nothing from me.
2. **Delete the database.** Cloudflare dashboard, Workers and Pages, D1, `[D1_NAME]`, Delete. This removes version history and spend records, including its time travel history.
3. **Delete the file storage.** Cloudflare dashboard, R2, bucket `[R2_BUCKET]`, Delete.
4. **Delete the brain.** Cloudflare dashboard, Workers and Pages, `[WORKER_NAME]`, Settings, Delete.
5. **Revoke source access.** Remove [SERVICE ACCOUNT / OAUTH CLIENT] from the folders it could read, and delete it in the Google Cloud console.

**Then verify, and do not verify by visiting the URL.** A deleted worker can keep answering for a few seconds after it is gone, so a 200 response proves nothing in the first minute. Check the **list of workers in your account** instead. If `[WORKER_NAME]` is not in that list, it is gone.

Cloudflare has its own internal retention and backup schedules after a delete, and D1 in particular keeps 30 days of point-in-time history. If you need certified deletion for a legal or compliance reason, ask each of them directly, in writing. I would be guessing, and this is not a place to guess.

---

## 5. What I still hold

Complete list. Nothing omitted.

| What | Contains | How long |
|---|---|---|
| Your intake answers and my notes | Your ten questions, your sources, your exclusions. No credentials | Until you ask me to delete them |
| A copy of your manifest | Resource names and IDs. **No secrets.** Every credential in it is a reference to a store, never a value | Until you ask me to delete it |
| Our email and message history | Whatever we wrote to each other | Normal business records |

**No copy of your documents. No copy of your index. No database. No keys.** Not as a matter of discipline, but because the architecture never routed your material through anything I own.

Ask me to delete the first two at any time, for any reason or none, and I will confirm in writing within one business day.

---

## 6. What is true a year from now

If I am unavailable, out of business, or you simply never want to speak to me again:

- Your brain keeps running. It does not check in with me, it does not phone home, and it has no license to expire.
- Your verification suite keeps working. It is a file in your possession that talks to your infrastructure.
- Your manifest plus the installer is a complete description of the system. Any competent developer can pick it up.

That was the point of building it this way.

---

[SIGNATURE]

[IMPLEMENTATION OWNER]
[IMPLEMENTATION ORGANIZATION]
[SUPPORT EMAIL]
