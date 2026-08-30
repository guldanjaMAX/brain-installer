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
