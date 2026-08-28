# Issue #14 evidence — the product now names the refusal it never made

Date: 2026-08-28. Branch `fix/security-batch`, worktree off `wave0/connector-gaps`.
Files: `components/brain-http.mjs`, `components/brain-mcp.mjs`, `brain.mjs`,
`docs/README-developer.md`, `test/bot-protection.test.mjs` (new), and its
one-line registration.

## The runbook half was ALREADY DONE, and this branch did not redo it

The issue's minimum ask was "a line in the runbook". It is there, and it landed
today, before this branch existed:

```
$ git log --oneline -S"error code: 1010" -- onboarding/06-runbook-top-ten-failures.md
516f7a3 Runbook: replace a recovery step no client machine can run
$ git log -1 --format='%H %ci %s' 516f7a3
516f7a35e6c1e8ee4c4c093fcb5aeb8cac5e73ab 2026-08-28 06:47:01 -0700 Runbook: replace a recovery step no client machine can run
```

Entry 1b, "Every command is refused, but the same address opens fine in a
browser", carries the symptom, the mechanism, the two-line no-credential proof,
the zone-level fix, and the `.workers.dev` exception. It was not touched here
beyond a test that asserts it still exists, so the message the code prints and
the document it points at cannot drift apart.

## What was still missing: the code said nothing

Grepping the shipped tree, exactly one place knew about this and it was the MCP
server, with a private substring test:

```js
const hint = text.includes("1010") ? " (a bot-protection rule rejected ...)" : ...
```

`brain.mjs` had nothing. Its `/health` probe printed
`/health returned 403 after N attempts: <html>...`, and `brain ask` printed
`the Brain could not answer (HTTP 403)`. Both read as the brain's own refusal,
which is how an operator ends up rotating a key the edge never read. The
connection-reset branch of `translatedHttpFailure` was worse than silent: it
said "this is usually a network blip; re-running the command is safe", which is
confident, reassuring and wrong when a rule is resetting every attempt.

The MCP hint was also too narrow. Matching `"1010"` misses every interstitial
challenge page, which carries `cf-mitigated: challenge` and no error code at all.

## What changed

`describeBotProtection` in `components/brain-http.mjs` — the module every
credentialed Brain request already goes through. It returns null unless the
response really carries the signature: status 403, 429 or 503, AND a Cloudflare
edge fingerprint (an `error code: 1xxx`, a known block or challenge page, a
`cf-mitigated` header, or HTML with a `cf-ray`). A 401 is never claimed, because
the edge does not ask for the brain's key. A JSON refusal from the brain is
never claimed, because that IS the brain answering.

Being right matters more than being helpful here. A classifier that guesses
moves the operator from one dead end to a different one, with more confidence
than before, which is a net loss. The negative tests carry as much weight as the
positive ones.

The message it produces says the thing the operator most needs and would
otherwise never conclude: **your admin key was never read, so rotating it will
not help**. Then the two-command proof against their actual address, which
carries no credential because `/health` needs none, then the zone-level fix and
the runbook entry.

Wired into: `brain health` (the `/health` probe), `brain ask`, and the MCP server
— which now shares the one classifier and adds the fact that matters in its
context, that it already sends a browser User-Agent, so a refusal there means the
rule is matching on something else. The reset branch gains one honest sentence
that names the possibility without asserting it, because from inside the process
it is genuinely not knowable.

`brain`'s own commands still identify as `node`, deliberately. Spoofing a
browser in the CLI would destroy the asymmetry the runbook relies on: AI tools
answering while the terminal is refused is itself the diagnosis. The fix belongs
in the client's zone, not in a user-agent string that pretends the rule is not
there.

`docs/README-developer.md` gains the documented requirement the issue asked for:
anyone writing a client against a brain sends a browser User-Agent, with the
measured `curl` 200 / `urllib` 403 asymmetry, which of the shipped clients send
one, and which deliberately do not.

## Discrimination

Make the classifier eager — drop the fingerprint requirement so any 403 is
called bot protection:

```
FAIL  the brain's own 403 keeps its own message (a JSON refusal from the brain is not the edge refusing the client
FAIL  a 403 with an HTML page and no Cloudflare fingerprint is not claimed (a guess would send the operator to a different wrong place
2 failure(s)
```

Narrow it back to the substring test the MCP server used to carry
(`/error code:\s*1010/`):

```
FAIL  a challenge page carrying no error code is still recognised (matching on the error code alone misses every challenge page)
FAIL  a firewall-rule block (1020) and a rate refusal (429) are recognised (The expression evaluated to a falsy value:
2 failure(s)
```

Both restored: `all bot protection tests passed`.

## Owner's note

This one is not a bug in the brain. The brain is fine; something in front of it
is turning my own tools away, and the product's contribution to the problem was
that it described the refusal as though it had made it. That is the part worth
fixing. A client, or me at eleven at night, reads "HTTP 403" and starts rotating
a key that was never even read, and every fix appears to fail because the thing
being fixed was never broken. Now the tool says it was refused before it reached
the brain, says the key is not the cause, and hands over two commands that need
no credential and settle it in ten seconds. I kept the CLI identifying itself as
`node` on purpose. If the AI tools keep answering while my terminal is refused,
that gap is the answer, and I would rather keep the signal than paper over it
with a fake user agent.
