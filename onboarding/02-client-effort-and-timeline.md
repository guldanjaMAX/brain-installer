# Your part: what I need, when, and what it costs you in time

One page. Every single thing you have to do, how long it takes you, and what happens if it slips.

**Your total time is about three hours, spread across a month.** Most of that is two conversations. The build itself is mine.

---

## The schedule

| Day | What you do | Your time | What it holds up |
|---|---|---|---|
| **Day 1** | Intake call with me | 45 min | Everything. Nothing starts before this |
| **Day 2** | Create three accounts and grant access to your sources | 30 min | Everything after it. This is the gate |
| **Day 2** | Add your own AI provider key (I send exact steps) | 10 min | Written answers. Search works without it, answers do not |
| **Days 3 to 4** | Nothing | 0 | I build and deploy |
| **Days 5 to 6** | Nothing. I may send one or two short questions | 5 min | I load your material, most valuable first |
| **Day 7** | Nothing | 0 | I read the actual answers to your ten questions and fix what is wrong before you see any of it |
| **Day 8** | Kickoff | 60 min | |
| **Day 15** | Check-in 1 | 15 min | |
| **Day 22** | Check-in 2 | 15 min | |
| **Day 29** | Check-in 3, you take the controls | 15 min | |

The intake sheet said under three hours. That covered the install. The three check-ins after kickoff add another 45 minutes across three weeks.

---

## The one thing that decides the timeline

**Access.** It is the only step where I am waiting on you, and everything after it runs in sequence. I cannot provision infrastructure I have no key to, I cannot load material I cannot read, and I cannot review answers that do not exist yet. There is nothing I can usefully do in parallel while I wait.

So the slip is not proportional. It compounds:

| Access arrives | Kickoff lands | Why |
|---|---|---|
| Day 2, as planned | Day 8 | |
| Day 3 | Day 9 | Straight one day slip |
| Day 5 | Day 12 | The load and the review each need a full working day and cannot overlap |
| Day 8 or later | Rebooked, not shifted | By then the calendar has moved and we are picking new dates for both sessions |

I am telling you this because late access is the single most common reason one of these installs stalls. It is almost never a technical problem. It is a credential that took eleven days to arrive.

---

## The three accounts you create

These are yours. I never own them, and that is the entire point: your material lives in infrastructure you control, and when the work is done my access is removed. I cannot hand over what I never held.

| # | Account | Your time | What it is for |
|---|---|---|---|
| 1 | **Cloudflare** | 10 min | The brain itself, its database, and its file storage. Free to create |
| 2 | **Workers Paid, on that same Cloudflare account** | 2 min | 5 USD/month. Vectorize holds the search index and CANNOT be created on the free tier. See `08-provisioning-prerequisites.md` |
| 3 | **Anthropic** (API key) | 10 min | The engine that writes answers. Billed on usage, capped by me |

Plus one grant, not an account:

| | What | Your time |
|---|---|---|
| 4 | **Read-only access** to the folders you named at intake | 10 min |

That access is genuinely read-only. It can look at documents. It cannot change, move, or delete anything.

**Do all four in one sitting.** They take 40 minutes together and about three days apart, because each one you leave half done becomes a thing to re-find.

---

## One decision that cannot wait until later

At intake I asked whether your email runs on Google Workspace (a business account on your own domain) or a regular gmail.com address. That answer decides how your Google connection is registered, and it has to be made on day 2.

**On Workspace:** the connection is registered inside your own organization. It works, and it keeps working. Nothing else to think about.

**On a personal gmail.com address:** there is an extra publishing step. If it is skipped, the connection expires **seven days after we finish**, and the brain quietly stops taking in anything new. It does not announce this. It keeps answering questions, using material that stops getting fresher, and it looks like the product broke by itself two weeks later.

I would rather spend ten minutes on this on day 2 than have you discover it in week three. If you are on a personal address you will also see a one-time Google screen that says the app is not verified. That is expected, and I will be on the call when it appears.

---

## What I am doing while you wait

So the quiet days are not a mystery:

- **Days 3 to 4.** Create your database and storage, deploy the brain into your account, set the keys, prove it responds.
- **Days 5 to 6.** Load your material, most useful first. Not oldest first. The folder you named as "if it only understood this, it would already be worth it" goes in ahead of everything else and gets proven before the rest streams in behind it.
- **Day 7.** The gate. I sit down and read the real answers to your ten questions, not a pass or fail summary, and fix what is wrong. You never see a first draft. This is the step that decides whether kickoff feels like your business or like a technology demo, and it is why I need the full day.

---

## What this costs you beyond my fee

You pay two vendors directly, on your own card, because these are your accounts:

- **Hosting and database: roughly $5 to $25 a month**, depending on volume.
- **AI provider usage: roughly $20 to $100 a month**, depending on how much you use it.

I set a hard daily ceiling on the AI spend, so a runaway process cannot produce a surprise bill. The ceiling is written into your install and you can see it and change it.

You will see these charges on your own statement next to my invoice. I would rather you see the numbers here than find them later.

---

## If someone else controls your accounts

If an IT person, an agency, or a partner holds the keys to your Google account or your domain, **their response time becomes your timeline**, and I have no way to speed it up.

Two options, both fine:

1. Get that person on the day 2 call. Fifteen minutes of their time removes the whole risk.
2. We treat the access work as separate, and I do not quote a kickoff date until it is done.

What does not work is assuming they will be quick.

---

## Checklist before day 2

Print this, or forward it to whoever is doing the setup.

- [ ] Intake sheet returned, including all ten questions in section 6
- [ ] Cloudflare account created, and I have been told which email it is under
- [ ] Cloudflare account upgraded to Workers Paid (verify with `node brain.mjs doctor`, which actually checks it via Vectorize, NOT by asking)
- [ ] Anthropic account created and a payment method added
- [ ] Read-only access granted to the folders named at intake
- [ ] Workspace or personal gmail.com question answered, and if personal, the publishing step scheduled
- [ ] Anything from section 3 (what it must never see) confirmed in writing
- [ ] Kickoff booked for day 8, 60 minutes, both of us

When every line is ticked, the build starts that day.
