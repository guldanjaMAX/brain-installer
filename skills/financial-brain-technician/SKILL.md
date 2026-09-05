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

1. Ask whether this is a fresh install, an update, or a checkup. Ask for the
   absolute `brain.manifest.json` path, creating no file yet when this is fresh.
2. Run `brain --version` and the packaged read-only preflight. Use the full
   installed command path from the install page if `brain` is not on PATH.
   Stop on any preflight `STOP` line.
3. If a private test kit was supplied, read its `release.json`. Stop if
   `ready_to_send` is not `true`, its version or archive digest differs from the
   installed package, or its intended hostname is empty. A test kit is helpful
   for a supervised client handoff, but is not required for a fresh install.
4. Run the read-only plan, even before the manifest exists:

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

- For an existing brain, start with `brain doctor`. When the installed package
  and Worker versions differ, use `brain update`, which resumes from its saved
  bookmark. Setup on an already current brain only reconciles keys, health, and
  local tool wiring; it does not repeat the migration cutover.
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
  `npx wrangler@4.73.0 login` right before `brain update`, and again before
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
  kit when one was supplied. Otherwise rerun the packaged preflight directly:

  ```bash
  bash "$HOME/.financial-brain/lib/node_modules/brain-installer/tools/preflight.sh"
  ```

  On Windows PowerShell:

  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\FinancialBrain\node_modules\brain-installer\tools\preflight.ps1"
  ```

  Record counts, timestamps, proof level, and sanitized evidence. Keep
  credentials and raw private source content out of that record.
- Report anything that still requires Cloudflare, provider, operating-system,
  physical-device, or real-export proof. Fixture success does not close a live
  connector gate.
