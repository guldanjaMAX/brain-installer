# Credential-free field preparation

`npm run field:prepare` turns one clean source commit into a private offline
receipt, an exact package digest, and a human field checklist. It is a source
maintainer command. It is not installed as a `brain` command.

The default profile runs the complete offline product suite, the owner app
tests and production-bundle parity check, the customer hiccup lab, the fake
Plaid rehearsal, local D1 auth atomicity, the passkey protocol self-test,
source and history privacy, an offline dependency audit, package creation,
SHA-256, and a clean-prefix installed CLI smoke.

```bash
npm ci --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm run field:prepare -- --expect-sha <reviewed-40-character-git-sha>
```

Artifacts are written under the ignored `.field-prepare/` directory unless a
new output directory is supplied. The directory is owner-only on POSIX. It
contains:

- `field-prepare-receipt.json`, with aggregate status and no raw child output;
- `HUMAN-FIELD-CHECKLIST.md`, with the exact candidate identity, package
  digest, and the remaining physical and provider checks;
- the packed tarball when packaging succeeds.

The command refuses a dirty or shallow checkout. It checks the same source
identity again at the end. A source or test failure stops later test and package
checks, leaves their state as `not_run_after_failure`, still runs the closing
read-only identity check and private-home cleanup, writes the receipt, and exits
nonzero. A selected or fast run can help during development but ends as
`partial_source_preparation`. Only the complete default profile can end as
`source_preparation_passed`, and that status still says
`ready_for_live_accounts: false`.

## Faster iteration

```bash
npm run field:prepare -- --fast
npm run field:prepare -- --only plaid-fake,passkey-protocol
npm run field:prepare -- --plan --json
```

Fast mode replaces the complete suite, complete hiccup lab, and full package
privacy gate with focused checks. It still packages and smokes the local
candidate, but it is not release proof.

## Safety boundary

The orchestrator accepts no manifest and no credential. Child processes receive
an allowlisted environment and a temporary home, so the current desktop home,
provider variables, Cloudflare variables, `NODE_OPTIONS`, npm user config, and
Git user config do not cross into the checks. The command list statically
refuses live or execute flags, manifest arguments, provisioning, deployment,
and real Cloudflare field runners.

The local D1 atomicity check uses the exact Wrangler version pinned in
`package.json`, `package-lock.json`, and the installed dependency tree. The
preparation command runs npm in offline mode and refuses a mismatch. It removes
every Cloudflare and Wrangler credential variable and binds only a disposable
local D1 database. It does not contact the npm registry or a Cloudflare account.

The owner app steps also run offline after its separate dependency install.
They execute the React interaction suite, rebuild the production UI, and rely
on the closing clean-tree check to prove that `worker/src/lib/app-assets.js`
already matches the exact reviewed frontend source.

The generated checklist keeps the work that cannot be automated explicit:
clean Windows installation, a disposable Cloudflare deployment and cleanup,
physical passkeys, Plaid Sandbox through the deployed Brain, QuickBooks Online
Sandbox, watched-folder disruption, and reviewed bank exports. Each still needs
separate approval and a human owner at the relevant ceremony.
