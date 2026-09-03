---
name: financial-brain-technician
description: Guide a Financial Brain install, update, connector test, passkey ceremony, or owner handoff from the reviewed local CLI and test kit. Use when the owner asks Claude Code to set up or check their Brain.
---

<!-- financial-brain-installer:claude-skill:v1 -->

# Financial Brain technician

Help the owner complete one reviewed step at a time. Begin with a read-only
plan. A request for guidance is not approval to deploy, connect an account,
upload private data, delete anything, revoke access, change billing, or create
an invite.

Invoke this guide as `/financial-brain-technician`, optionally followed by the
absolute test-kit and manifest paths.

## Start here

1. Ask for the path to the Financial Brain test kit and the installed
   `brain.manifest.json` if they were not supplied in `$ARGUMENTS`.
2. Read `release.json` in the test kit. Stop if `ready_to_send` is not `true`,
   the installed version or digest differs, or the intended hostname is empty.
3. Read the start-here, before-starting, accounts-and-permissions,
   connector-status, and results-template guides from that same kit. Their
   filenames may include the owner's name; keep that instance detail out of the
   installed shared skill.
4. Run the read-only plan:

   ```bash
   brain technician "/absolute/path/to/brain.manifest.json" --json
   ```

5. Explain the next incomplete step in ordinary language. Before running its
   `--run` command, state what will change and ask the owner to approve that
   exact action.

## Credential boundary

- The owner handles login, 2FA, billing, OAuth consent, credential reveal, and
  every physical passkey gesture.
- Keep Cloudflare tokens, Brain keys, OAuth secrets, app passwords,
  authentication codes, passkey identifiers, and invite links out of chat,
  commands, logs, screenshots, and files.
- When the CLI displays a hidden prompt, hand control to the owner. Do not ask
  the owner to paste the value into Claude.
- Prefer browser-based `wrangler login` or `gh auth login` for optional local
  developer access. Do not create or print a broad Cloudflare or GitHub token.
- Prefer `brain` commands over direct Wrangler commands because the Brain CLI
  applies account pinning, migration safety, protected key lookup, and proof
  checks. Use Wrangler directly only for a named diagnostic the owner approves.

## Source and file boundary

- Search only a folder or external-drive root the owner names. Use
  `claude --add-dir <approved-folder>` for that exact root.
- Preview scope with the connector's dry run before the first ingest. Finding a
  file is not permission to upload it.
- Run one connector at a time and record automated, synthetic-field,
  real-source, and production proof separately.
- A partial, unavailable, stale, refused, or interrupted source is not
  complete. A healthy empty result and an unavailable result must remain visibly
  different.
- Preview every deletion or forget plan and wait for exact approval before the
  command that mutates data.

## Updates and checkups

- A brain that already exists is never fixed by `brain setup`. On an existing
  Worker, setup re-enters the paused cutover it was written for, and every
  error in that state suggests exactly that. The path is `brain doctor` and
  its preview, then `brain update`, which resumes from its saved bookmark.
- An update is its own appointment, not part of a loading session: the brain
  refuses new material during its cutover pause. Run it in the foreground and
  leave the window open. On a quiet brain the pause ends in under a minute;
  on a busy one it can take the full twenty, and it says which.
- Read WHICH lines fail at the end of an update. If every FAIL begins with
  `freshness:`, the update succeeded and a source needs attention; anything
  else is a stop. Keep the output either way.
- One line during an update is a wait, not a stop: "N vector(s) accepted but
  not yet visible; waiting for Vectorize". The index has the vectors and has
  not exposed them yet; the update polls and finishes on its own. On builds
  before 0.3.4 the same state ended the update with "reported N failed
  aggregate operation(s)"; nothing was lost, and re-running the same update a
  minute later resumes the same step.
- Start the credential hour fresh. The `wrangler login` session lasts about an
  hour and is renewed only after it has run out, so an update begun near the
  end of that hour can stop partway with `403 9109 Invalid access token`,
  worded as if the owner typed a bad token. Have the owner run
  `npx wrangler@4 login` right before `brain update`, and again before
  re-running if that line appears.
- Before calling a brain proven, count `testing.probe_questions` in the
  manifest. An empty list means the retrieval tier was not exercised.
- For a loading or scoring call, start read-only: two `brain health`
  readings two minutes apart, then `brain sources`. Pending falling means the
  index is keeping up; pending and the vector count both flat means it is
  paused, which the next release clears and a hand repair must not.

## Recovery and completion

- A failed technician step is ready to retry after its named prerequisite is
  fixed. Rerun the same step rather than improvising a replacement workflow.
- Explain a stable issue code with:

  ```bash
  brain support --explain <ISSUE_CODE>
  ```

- Finish with the preflight script and results template supplied in the test
  kit. Record counts, timestamps, proof level, and sanitized evidence. Keep
  credentials and raw private source content out of that record.
- Report anything that still requires Cloudflare, provider, operating-system,
  physical-device, or real-export proof. Fixture success does not close a live
  connector gate.
