# WP-12 evidence — the client's own AI can now see the install it is setting up

Date: 2026-08-28. Branch `feat/onboarding-mcp-tools`, built in an isolated
worktree off `wave0/connector-gaps`. One shipped file edited, one test file
added, one line changed in the npm test chain. No version bump and no CHANGELOG
heading: a human is integrating several branches, so the owner-voice paragraph
is at the bottom of this file instead.

The onboarding design (Part One, "Needs a modest addition: four read-only
tools") makes the case: the interview is currently blind to the install it is
supposed to be configuring. Setup already registers this brain as an MCP server
inside the client's own Claude Code and Codex, so the conversational surface
exists. What it could not do was look. It could answer questions from the
corpus and write a lesson back, and it could not tell you whether a source was
registered, whether it was stale, what was stored wrong, or how much had
actually landed. So the interview asked the owner to describe an install the
program could already see.

---

## 1. The four tools, and the route each one maps to

No new server behaviour. Every route already existed and the resolved admin key
already reached all four.

| Tool | Route | What it is for |
|---|---|---|
| `brain_install_state` | `GET /health` | Version, status, and whether the brain is **accepting documents** |
| `brain_sources` | `GET /api/admin/brain/freshness` | Every registered source, its kind, document count, days since ingest, and whether that is on schedule |
| `brain_diagnose` | `GET /api/admin/brain/diagnose` | What is missing or stored wrong, each finding with its action |
| `brain_inventory` | `POST /api/admin/brain/source-families` | How many distinct real-world documents actually landed, counted as families |

`brain_sources` is the one that changes the conversation. It is the entire input
to a conversational onboarding: it lets the model say "you have no Gmail source
registered, here is what Gmail would add, here are the four browser steps, I
will wait", instead of asking the owner what they have.

Each tool is one entry in `TOOLS` and one `case` in `runTool`
(`components/brain-mcp.mjs`). Two constants were added for the inventory walk
(`INVENTORY_PAGE_LIMIT = 500`, `INVENTORY_MAX_PAGES = 10`).

---

## 2. The blind spot, and how it is closed

`/api/admin/brain/ingest` sits on `PAUSED_CORPUS_MUTATION_PATHS`
(`worker/src/index.js:1430-1442`). During a stalled upgrade every write path
returns 503, while `/api/admin/brain/documents` keeps returning the document
counts that were already there. So `brain_health`, whose own description read
"Is the wiring intact and the data fresh?", reported an entirely well brain
while that brain could not accept a single document. An assistant reading health
alone would tell a client everything was fine.

The test asserts both halves of that against the same paused fixture, which is
the only way to show a blind spot rather than assert it:

```
  ok  brain_health still looks entirely well while writes are paused
  ok  brain_install_state reports the pause honestly
  ok  the pause note names the consequence and the false reassurance
```

`brain_install_state` returns `accepting_documents: false`, `writes_paused:
true`, and a note that says what it means and warns off the false reassurance:

> This brain is NOT accepting documents. A paused upgrade refuses every write
> with HTTP 503, so anything loaded now is refused rather than stored. Say that
> before loading anything, and do NOT report this install healthy on the
> strength of brain_health: document counts read normally in exactly this state.

Three supporting changes make the tool actually get called rather than merely
exist:

- `brain_health`'s own description now ends "It CANNOT see whether the brain is
  accepting documents ... Call `brain_install_state` for that."
- The server `instructions` string gained a paragraph telling the host to call
  `brain_install_state` before reporting an install healthy and before loading
  anything.
- The instructions also state the boundary out loud: this server can diagnose,
  narrate, configure and verify an install, and it **cannot authorise** one.
  Every OAuth consent screen, bank login, QR pairing and system permission
  dialog needs the owner's own hand.

### A second honesty trap found while wiring `brain_sources`

`freshnessReport` returns `{ sources: [], unavailable: true }` when the source
table cannot be read (`worker/src/lib/store-d1.js:2392-2399`). A pass-through
tool would have handed the model an empty list, and the model would have told
the client nothing was connected — an absence we cannot prove, from a query that
never ran. The tool now separates the two zeros explicitly, and both directions
are tested:

```
  ok  an unreadable source table is not reported as an empty install
  ok  a readable but empty source table IS the finding
```

The same rule governs `brain_inventory`: the walk is bounded at ten pages, and a
truncated walk reports its number as a **floor**, never a total, with the
`next_cursor` to continue.

---

## 3. Where the read-only boundary is written down

A 34-line comment sits directly above `const TOOLS = [` in
`components/brain-mcp.mjs`, so the next person to add a tool meets the reasoning
before the temptation. It states, in this order:

1. This process resolves the **full** admin key, not a read-scoped one, and the
   `TOOLS` array is the only thing standing between the host model and `forget`,
   `reindex`, `drain`, `refit`, `bootstrap`, `ingest/batch` and `auth/invite`.
2. The fair objection, stated rather than dodged: a host agent with a shell can
   read the key off disk and curl those routes anyway, so this is not a
   privilege boundary.
3. Why it still holds: it is the **approval surface**. A shell `curl` to a
   destructive endpoint reads as a suspicious Bash call the owner can refuse; a
   tool named for the thing they were just asked to approve does not.
4. Prompt injection is live, not theoretical. `brain_search` returns 900
   character excerpts of the owner's own documents and mail straight into the
   host model's context. Give that model a delete tool and one hostile document
   becomes a delete primitive. `forget` dry-runs unless `confirm:true`, and that
   guard sits in the request **body**, where a tool wrapper can set it and
   silently defeat it.
5. What write tools are waiting on: an independently rotatable read-only
   credential this process cannot yet resolve (`operations/rag-proxy-key.mjs`
   names the same unfinished work). Until then the honest way to let the model
   act is to return the command as a string for the owner to run, which is the
   posture `cmdMcpConfig` already takes. `brain_forget` stays off the list
   permanently.

The comment is not the only enforcement. The test pins the tool list exactly and
rejects any name containing forget/delete/purge/reindex/drain/refit/bootstrap/
ingest/invite/provision/deploy/connect, with the reason in the assertion
message, so adding one fails in front of a reviewer.

---

## 4. What the tests actually drive

`test/mcp-tools.test.mjs`, 27 checks. Before this file there was **zero**
behavioural coverage of MCP tool dispatch: `test/mcp-rotation.test.mjs` imports
`wireAgents`, `cmdMcpConfig` and the credential resolver, and never touches
`runTool`.

It does not import `runTool` either, on purpose. It **spawns
`node components/brain-mcp.mjs` as a child process** and speaks
newline-delimited JSON-RPC over its stdin and stdout, exactly as Claude Code
does, against a loopback `node:http` server standing in for the client's Worker.
`components/brain-http.mjs` permits `http://` only for loopback, which is the
escape hatch this harness uses, so URL validation, `redirect: "error"`, the
origin equality check and the credential redactor all run for real. The child's
environment is narrowed and `HOME`/`USERPROFILE` point at an empty sandbox, so a
developer's own `~/.brain/config.json` cannot change a result.

What that buys, beyond "the function returns the right object":

- The exact JSON-RPC frames a host sends (`initialize`, `tools/list`,
  `tools/call`) are the thing under test, including the `content[0].text` JSON
  envelope and the `isError` flag.
- A tool name declared in `TOOLS` with no `case` in `runTool` would list fine and
  fail only in a client's session. One check calls **every** listed tool and
  asserts none comes back "unknown tool".
- Requests are recorded, so each tool is asserted to hit the route it claims,
  with the method and body it claims. `brain_inventory` is asserted to page with
  the returned cursor and to stop at its budget.
- The transport contract is exercised end to end: the admin key goes out in
  `X-Admin-Key` with the browser User-Agent, and when the fixture Worker echoes
  the key back inside a 500 body, the tool output contains
  `<credential redacted>` and the raw stdout does not contain the key.

Full run:

```
$ node test/mcp-tools.test.mjs
brain-mcp tool dispatch, driven over stdio
  ok  the server starts and exits cleanly
  ok  tools/list is exactly the reviewed set
  ok  no destructive or provisioning tool is exposed
  ok  every declared tool carries an input schema
  ok  initialize points the host at the install-state tool
  ok  no declared tool is missing a dispatch case
  ok  an undeclared tool name is refused rather than dispatched
  ok  brain_health still looks entirely well while writes are paused
  ok  brain_install_state reports the pause honestly
  ok  the pause note names the consequence and the false reassurance
  ok  brain_install_state reads /health, not the counts route
  ok  a healthy install reports writes accepted, with no alarm
  ok  an older Worker's write state is reported UNKNOWN, not healthy
  ok  brain_sources maps to GET /api/admin/brain/freshness
  ok  brain_sources summarises state and names what needs attention
  ok  an unreadable source table is not reported as an empty install
  ok  a readable but empty source table IS the finding
  ok  brain_diagnose maps to GET /api/admin/brain/diagnose
  ok  findings come back critical-first, with their actions intact
  ok  a clean diagnose does not claim the right material was loaded
  ok  brain_inventory POSTs source-families and pages with the cursor
  ok  a completed walk reports an exact count
  ok  a truncated walk is reported as a floor, never as a total
  ok  the walk is bounded, so a chat surface cannot run away
  ok  an empty source is named in the finding
  ok  the admin key is sent on the new read routes
  ok  an echoed credential is redacted before it reaches the host

all mcp tool dispatch checks passed
```

---

## 5. Proof the tests discriminate

A test that passes against the broken code proves nothing. Each of the three
load-bearing claims was broken deliberately, the suite re-run, and the code
restored. Verbatim output.

**Probe 1 — the blind spot.** `const paused = declared === false || pausedSignal;`
replaced with `const paused = false;`, i.e. a tool that relays the health fields
and never draws the conclusion:

```
  FAIL brain_install_state reports the pause honestly
       Expected values to be strictly equal:

false !== true

  FAIL the pause note names the consequence and the false reassurance
       The "string" argument must be of type string. Received type undefined (undefined)
  ok  brain_install_state reads /health, not the counts route
```

Exit code read from its own file: `1`.

**Probe 2 — the read-only boundary.** A `brain_forget` entry added to `TOOLS`:

```
  FAIL tools/list is exactly the reviewed set
       Expected values to be strictly deep-equal:
+ actual - expected

  FAIL no destructive or provisioning tool is exposed
       tool "brain_forget" looks like a write/destructive surface. The MCP process holds the FULL admin key; read the boundary comment above TOOLS in components/brain-mcp.mjs.
  FAIL no declared tool is missing a dispatch case
       brain_forget has no case in runTool
```

Exit code read from its own file: `1`.

**Probe 3 — the inventory overclaim.** `const complete = !next;` replaced with
`const complete = true;`, i.e. a truncated walk presented as a total:

```
  FAIL a truncated walk is reported as a floor, never as a total
       Expected values to be strictly equal:

true !== false
```

Exit code read from its own file: `1`.

After each probe the file was restored from a byte copy and the suite re-run
green; `git diff --stat` confirms the same 236-line insertion as before the
probes, so nothing from a probe survived.

---

## 6. What this does NOT do, stated plainly

- **No write tools, and that is the design.** No ingest, no connector refresh,
  no reindex, no drain, no forget, no invite. They wait on the credential split.
- **A conversational onboarding still cannot authorise anything.** Google OAuth
  consent, the Google Cloud project, Full Disk Access, the Workers Paid upgrade,
  the scoped Cloudflare token, Zoom's paid seat, WhatsApp pairing and any bank
  login all terminate in a human hand on a browser or a system dialog. The
  server instructions now say so to the host model rather than leaving it to
  discover the wall.
- **`brain_remember` still returns a raw transport error when writes are
  paused.** The 503 body is relayed inside the error message, so the reason is
  visible, but it is not shaped into a friendly refusal. That was left alone
  deliberately: this branch is read-only, and reshaping a write tool's output is
  a separate change. The blind spot it was half of is closed from the read side.
- **Nothing here was run against a live brain.** Every result above is offline,
  against a loopback fixture Worker. The route shapes were read from
  `worker/src/index.js` and `worker/src/lib/store-d1.js` in this same tree, not
  guessed, but a field run against a real install is still owed.
- **`brain_inventory` counts, it does not verify.** A family count says what
  landed. It cannot say the right material was loaded; that is the corpus
  contract path, and `brain_diagnose`'s clean-result note says so out loud
  rather than letting a green result imply completeness.

---

## 7. Files

- `components/brain-mcp.mjs` — the read-only boundary comment, four tool
  declarations, four `runTool` cases, two inventory constants, one sentence
  added to `brain_health`'s description, one paragraph added to the server
  instructions.
- `test/mcp-tools.test.mjs` — new, 27 behavioural checks over stdio.
- `package.json` — `test/mcp-tools.test.mjs` added to the `npm test` chain,
  immediately after `test/mcp-rotation.test.mjs`.

No file was added under `onboarding/` and no migration was written, so no
package allowlist entry was required; `test/` and `evidence/` are not published.
`node test/package-privacy.test.mjs` passes unchanged: 358 reviewed files.

---

## For the owner

Your client's own AI can now look at the brain it is setting up, instead of
asking them to describe it. It can see which sources are connected and which are
missing, how current each one is, what is stored wrong and what to do about it,
and how much actually landed. That turns the install interview from a
questionnaire into a conversation where the program does the part it can already
answer for itself.

It can also now catch the failure that would have embarrassed us. If an upgrade
stalls, the brain refuses every document with a 503 while its document counts
look perfectly normal, and until today an assistant would have read those counts
and told a client their brain was healthy while it silently could not accept a
thing. It will now say that plainly, before it tries to load anything.

Deliberately, none of these four tools can change anything. They read. The
process that runs them holds the full admin key, so the list of tools is the
only thing between an AI and the command that erases a corpus, and a tool the
client is invited to approve is a much easier thing to say yes to than a
suspicious terminal command. Write tools wait for a separate, weaker key that
does not exist yet. The reasoning is written above the list in the code, so
whoever is tempted next reads it first.

One limit worth repeating on a sales call: this can diagnose, narrate, configure
and verify an install. It cannot authorise one. Every consent screen, bank login
and permission dialog still needs your client's own hand, and the assistant now
knows to stop and hand those back rather than pretend.
