# Brain Install: Intake

Before we build anything, I need about 45 minutes of your answers. Most of this is quick. One section at the end takes real thought and it is the section that decides whether the finished thing feels useful or merely impressive.

Everything you tell me here shapes what gets built. Nothing here is a form for its own sake.

---

## 1. The business

**1.1** What does the business do, in the way you would explain it to a competent stranger?

**1.2** How many people work in it, and who are they?

**1.3** What do you personally spend the most time looking for? Files, past conversations, numbers, decisions, something else?

---

## 2. What it should know

Your brain reads what you already have. It does not need you to write anything new.

**2.1** Where does your work actually live? Check everything that applies and name it specifically.

- [ ] Google Drive (which folders, or all of it?)
- [ ] Email (which account?)
- [ ] Meeting recordings or transcripts (which tool?)
- [ ] Calendar
- [ ] Text messages or WhatsApp
- [ ] A CRM (which one?)
- [ ] Accounting or bookkeeping (which one?)
- [ ] Notion, Dropbox, or something else: ______

**2.2** For each one you checked: who owns that account? You, or someone else?

**2.3** How far back is worth reading? Everything, or the last N years?

> Why I ask: older material is often the most valuable, because it holds decisions nobody remembers making. But it can also be noise. You know which.

**2.4** Is there a single folder, drive, or mailbox that, if the brain understood only that, would already be worth it?

---

## 3. What it must never see

This matters as much as what goes in. The brain only ever reads what you point it at, and anything you name here is excluded at the source.

**3.1** Any folders, drives, or accounts that are off limits? Personal, medical, legal, HR, anything.

**3.2** Anything involving other people's confidential information you are not free to index? Client files under NDA, patient records, applicant data.

**3.3** Is there anything in your files you would be uncomfortable having answered back to you in a search result?

> There is no wrong answer. It is far cheaper to exclude it now than to remove it later.

---

## 4. Who will use it

**4.1** Who will actually ask it questions? Just you, or others?

**4.2** **If others: does everyone who will use it have the right to see everything it will read?**

> This one is a genuine yes or no, and it decides whether I can build this for you at all.
>
> As built today, the brain has one level of access. Anyone who can ask it questions can reach anything it has read. If your bookkeeper should not see the HR folder, or a contractor should not see client contracts, then the honest answer is that this version is not right for you yet, and I would rather tell you that now than take your money and discover it in week three.
>
> If it is just you, or a team where everyone already sees everything, we are fine.

---

## 5. Your accounts

The brain runs entirely inside accounts you own. I never hold a copy of your data, and my access is revoked when the work is done.

**5.1** Is your email on **Google Workspace** (a business account on your own domain) or a regular **@gmail.com** address?

> Why I ask: this genuinely changes the setup. On Workspace the connection is registered inside your own organisation and simply works. On a personal Gmail address there is an extra publishing step, and if it is skipped the connection silently expires after seven days and the brain quietly stops updating without telling anyone. I would rather handle it on day one than have you discover it in week two.

**5.2** Do you already have a Cloudflare account? If not, you will create one.

**5.3** Is that account on the **Workers Paid plan**? It has a 5 USD monthly minimum, and it is our required production baseline. Cloudflare now lets a Free account create the meaning-search index, but Free has prototype-scale vector capacity, daily database writes, and Worker CPU. A real corpus can hard-stop during its first load. Check under Workers and Pages, then Plans. Send a screenshot of that page rather than answering from memory.

> Why I ask: this is the single most common way an install session dies in its first ten minutes. Two minutes and a card fix it in advance; discovering it live costs the session.

**5.4** Are you the administrator of your own accounts, or does an IT person or agency control them?

> Why I ask: if someone else controls access, they need to be in the loop from the start, and their response time becomes part of the timeline.

**5.5** Do you have a domain you would like this to live on? Something like brain.yourcompany.com.

**5.6** What computer will you run the install from: Windows or Mac? And do you already use **Claude Code** or **Codex** on it? Either works, both is fine, and the brain will be wired into whichever you have.

**5.7** Before our session, run the preflight on that machine and send me what it prints. It takes two minutes and checks Node, your Cloudflare sign-in, Vectorize access, and your AI tools. The Paid-plan proof is the dashboard screenshot from 5.3. The exact commands are in the setup sheet I will send with the installer; the last line should say "ready to install".

> Why I ask: every answer above can also be checked by the preflight, and the preflight does not misremember. When 5.7 comes back green, the install session is boring, which is the goal.

---

## 6. The questions (the important part)

This section is what separates a brain that impresses you from one that is actually useful. Take your time here.

**6.1 Ten questions you would ask a perfect assistant.**

Not questions about your files. Questions about your business. The things you actually want to know and currently have to go digging for, or ask someone, or reconstruct from memory.

Good examples of the shape:
- What did we agree to deliver for [client] and by when?
- Why did we stop working with [vendor]?
- What has [person] asked for more than once?
- What did we quote the last three jobs like this one?
- What is still outstanding from the meeting in March?

Write ten. They can be messy.

1.
2.
3.
4.
5.
6.
7.
8.
9.
10.

**6.2 Three things only you know.**

Facts about your business that live in your head, not in any file. Context a new hire would take a year to absorb.

> Why I ask: these tell me whether your brain will be able to answer well, or whether the important things were never written down anywhere. That is worth knowing before we start, not after.

1.
2.
3.

**6.3 Two questions you expect it to get wrong.**

Genuinely. What do you think it will fumble?

> Why I ask: I would rather calibrate your expectations honestly than oversell. When we sit down together, I will show you these two alongside the ones it answered well. A tool that tells you what it does not know is worth more than one that always sounds confident.

1.
2.

---

## 7. What I need from you, and when

| When | What you do | How long it takes you |
|---|---|---|
| This week | Return this document | 45 minutes |
| Before we start | Create the Cloudflare account, grant access to the sources above | 30 minutes |
| Build week | Nothing. I build | 0 |
| Kickoff | 60 minutes together, looking at your own questions answered | 60 minutes |
| A week later | 30 minutes, reviewing what it missed | 30 minutes |

**Total time from you: under three hours.**

If access is late, the whole timeline moves. That is the single thing that delays these builds.

---

## 8. Costs you should expect

Beyond what you are paying me, you will pay two vendors directly, on your own card, because these are your accounts and not mine.

- Hosting and database: roughly **$5 to $25 a month** depending on volume
- AI provider usage: roughly **$20 to $100 a month** depending on how much you use it

I set a hard daily ceiling on the AI spend so a runaway process cannot produce a surprise bill.

I would rather you see these numbers now than find them on a statement later.

---

## 9. Anything else

**9.1** Is there anything about how your business works that would make this harder than I am assuming?

**9.2** What would make you say, three months from now, that this was clearly worth it?
