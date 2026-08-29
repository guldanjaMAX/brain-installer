# The privacy gate

`test/package-privacy.test.mjs` is the automated check that stops a private
identity reaching this public repository. It reads **every file tracked by
git**, plus every file `npm pack` would ship, plus the **paths** themselves,
and fails if any of them contains a name, personal domain, or real
infrastructure identifier belonging to the owner, a collaborator, or one of
their clients.

The values it looks for are stored as SHA-256 digests, not plaintext, so the
denylist is not itself a directory of the people it protects. The file's own
header explains what that does and does not buy.

## Running it

```sh
node test/package-privacy.test.mjs               # full gate, about 4 seconds
node test/package-privacy.test.mjs --scan-only   # identity scan, about 2 seconds
```

The full gate also verifies the npm packlist against its reviewed allowlist and
builds a real tarball to import a module out of it. `npm test` runs the full
gate. `--scan-only` is the identity half on its own, which is the half a commit
can get wrong.

## Installing it as a pre-commit hook

This repository ships **no** git hooks and this document does not install one
for you. Hooks live in `.git/hooks`, which is not versioned, so this is a
per-clone, per-machine decision for whoever owns the machine. If you want it,
run this once from the repository root:

```sh
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/sh
# Privacy gate: refuse a commit that would put a private identity in a public
# repo. Delete this file to uninstall. `git commit --no-verify` skips it once.
exec node "$(git rev-parse --show-toplevel)/test/package-privacy.test.mjs" --scan-only
HOOK
chmod +x .git/hooks/pre-commit
```

To check it took effect, stage anything and commit: you should see a `PASS` or
`FAIL` line from the gate before the commit is written.

To uninstall: `rm .git/hooks/pre-commit`.

If two seconds per commit is too much, the same line works as
`.git/hooks/pre-push`, which runs once per push instead of once per commit. It
catches the same leaks a moment later, before anything becomes public.

## What it costs

| | |
|---|---|
| Time | About 2 seconds per commit today: 427 tracked files, roughly 7 MB of text. It grows about linearly with the amount of tracked text, not with the size of your change. |
| Scope | It rescans **all** tracked files every time, not only the staged ones. That is deliberate. A leak arrives through a merge, a rebase, or a file someone else staged just as often as through the diff you are looking at. |
| Requirements | `node` and `git` on `PATH`. Nothing is installed, downloaded, or sent anywhere. |
| Blind spot | It enumerates with `git ls-files`, so a brand-new file is scanned once it is staged, which is the normal `git add` then `git commit` order. It then reads content from the **working tree**, not from the staged blob: stage a clean version, edit the file dirty, and the hook judges the dirty copy. In practice that makes it stricter, not looser. |
| Bypass | `git commit --no-verify` skips it, and hooks are not shared between clones. This is a guard against accidents, which is what almost every leak is. It is not a control against someone who means to commit the thing. |
| Not covered | It cannot fix a leak that is already pushed. A name in a commit stays readable in git history after a later commit removes it; that needs a history rewrite and a human decision, not a hook. |

## Adding a value to the denylist

Never type the value into a file. Pipe it in and paste the row that comes back
into `RULES` in `test/package-privacy.test.mjs`:

```sh
printf %s 'the value' | node test/package-privacy.test.mjs --hash word ci 'label'
```

* `word` matches whole words after normalisation, which is what `\bName\b` used
  to mean. Use it for anything short. A three-letter first name occurs inside
  ordinary English words such as "timeline" and "delivery", and substring
  matching on it produces nothing but noise.
* `any` matches a substring anywhere, so a value glued into a larger identifier
  is still caught. Use it only for long, distinctive values: a host, a token, a
  32-character identifier.
* `ci` folds case. `cs` does not, and is for a short name that collides with an
  everyday lowercase word.

Piping from `printf` rather than passing an argument keeps the value out of
shell history. `label` is what gets printed on a failure, so make it describe
the category rather than the person: "client first name", not the name.

Prefer a category that already exists. Nineteen rows cover the identities that
have actually reached this tree; the list is deliberately evidence-driven
rather than a roster of everyone in the owner's address book, because every row
added is one more value an outsider can test a guess against.

## When it fails

The failure names the file, the line, and the category. It never prints the
matched text, because a failure report that quoted the match would republish
the exact string the gate exists to keep out.

Fix it by **replacing** the identity, not by deleting the sentence. These are
evidence records; a role word ("the owner", "the collaborator", "the client")
or one of the approved invented personas keeps the meaning intact. Real
infrastructure identifiers get a clearly-synthetic replacement of the same
shape, so format assertions still hold.

Do not loosen a rule to get back to green. A hit is a finding.
