# WP-07 (Go-daemon half): WhatsApp capture daemon — evidence

Scope deliberately limited to the Go daemon productization. The CLI wizard
(`brain connect whatsapp`), LaunchAgent/Windows-service installers, and the
Node-side outbox drain are a follow-up package that reuses the persistent-
daemon patterns WP-06 is establishing; `brain.mjs` was not touched at all
in this package (zero edits — that is what makes the two parallel builds
collision-free).

Built on branch `wave1/wp07-whatsapp-go` (worktree
`/private/tmp/brain-wp07-whatsapp`), forked from `wave0/connector-gaps`.

## What was built

New directory `daemons/whatsapp/` — its own Go module
(`github.com/guldanjaMAX/brain-installer/daemons/whatsapp`), outside the
npm chain. Why `daemons/` and not `connectors/`: `connectors/` ships inside
the public npm package (it is in package.json `files`) and holds Node code
the CLI imports; a Go module does not belong in the shipped JS tree, and
the name `daemons/` states the runtime shape honestly — a persistent
background process, not a run-to-completion connector. Future daemons
(WP-06's iMessage capture is a sibling shape) have a home.

- `main.go` — pairing (terminal QR only), silent reconnect, event loop,
  graceful shutdown. Ported from the reference implementation with the
  entire persistence/output layer replaced: **stripped** the Postgres
  output layer and its connection-string requirement, the hardcoded
  personal transcription endpoint (audio now lands as the literal
  `[audio]` marker, which the sessionizer already filters), and the whole
  HTTP admin surface (`/qr`, `/qr.png`, `/send`, `/healthz`, `/`) — a
  client-machine background process has no business opening a listen port.
- `internal/paths` — path resolution with the reference's WA_DB_PATH bug
  fixed: an explicitly-set env path is ALWAYS honored (the reference
  silently overrode it to cwd-relative `wa.db` whenever a
  deployment-specific mount dir was absent, i.e. on every client machine);
  defaults go to platform app-data dirs (macOS Application Support,
  Windows LOCALAPPDATA, XDG elsewhere); with nothing resolvable it errors
  rather than falling back to the working directory.
- `internal/outbox` — the local SQLite outbox: one row per message,
  `UNIQUE(chat_jid, message_id)` with `INSERT ... DO NOTHING`, columns
  mapped 1:1 to the sessionizer input shape (`chat_jid→thread_id`,
  `message_id→id`, plus ts/direction/body/sender_name/thread_title),
  `drained_at` reserved for the Node drain, `source` marking
  live vs history_sync provenance.
- `internal/capture` — event-to-row mapping for both delivery shapes:
  `*events.Message` (live) and history-sync `WebMessageInfo` (sender
  reconstructed from own-JID / group participant / chat JID, exactly the
  three cases the reference handled), plus the media-marker text
  extraction. History conversations' `GetName()` now flows through as
  thread_title (the reference dropped it).
- `build.sh` — vet + test + both release builds, `CGO_ENABLED=0`.
- `README.md` — carries the ToS gray-area/ban-risk disclosure and the
  history-depth-at-link-time disclosure in the product voice, states
  plainly that this is half a feature with no installer, documents the
  outbox contract for the future drain, and names what cannot be tested
  without a phone.

## The modernc.org/sqlite dialect finding (the brief's one flagged unknown)

Confirmed against the pinned whatsmeow
`v0.0.0-20260427122815-7514259253a7` in the module cache, then proven
empirically. Three legs:

1. `sqlstore.New(ctx, dialect, address, log)` passes the dialect string
   straight to `sql.Open(dialect, address)` — so it must be a registered
   database/sql driver name
   (`store/sqlstore/container.go:46-51`).
2. The same string is parsed by `go.mau.fi/util@v0.9.8/dbutil`'s
   `ParseDialect`, which accepts ANY string prefixed `"sqlite"`
   (`dbutil/database.go:45`: `strings.HasPrefix(engine, "sqlite")`).
3. `modernc.org/sqlite@v1.37.1` registers its driver as exactly
   `"sqlite"` (`sqlite.go:54` `driverName = "sqlite"`, `sqlite.go:131`
   `sql.Register(driverName, newDriver())`).

So dialect `"sqlite"` satisfies both consumers. One DSN caveat found and
handled: whatsmeow's `Container.Upgrade` hard-fails unless
`PRAGMA foreign_keys` is on (`container.go:100-108`), and modernc does not
understand mattn's `?_foreign_keys=on` — its syntax is
`?_pragma=foreign_keys(1)` (`modernc sqlite.go:1977-1980`). The daemon's
DSN uses the modernc form plus `journal_mode(WAL)` and
`busy_timeout(10000)`, with `SetMaxOpenConns(1)` for single-writer safety.
The swap works; no mingw fallback needed.

Empirical proof: the smoke run below shows whatsmeow's full schema
migration suite running successfully on the pure-Go driver (all
`whatsmeow_*` tables created in a fresh session store).

## Command evidence

### go vet + go test (fresh cache, CGO_ENABLED=0)

```
$ go clean -testcache && go vet ./...
go vet: clean (no output, exit 0)
$ CGO_ENABLED=0 go test ./...
?   	github.com/guldanjaMAX/brain-installer/daemons/whatsapp	[no test files]
ok  	github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/capture	0.607s
ok  	github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/outbox	0.396s
ok  	github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/paths	0.791s
```

Tests cover: outbox idempotency on (chat, message id) including the
live-then-history-replay case and cross-batch history overlap; schema
reopen idempotency and data survival; validation rejecting malformed rows;
drained_at accounting; path resolution (explicit env always honored even
with no home dir — the exact reference bug — platform defaults for
darwin/windows/linux, XDG, refusal with nothing resolvable, never a
relative default); event-to-row mapping for live (in/out, group, push-name
fallback, skip cases) and history (from-me, group participant, 1:1,
conversation-name flow-through, skip cases) using constructed whatsmeow
structs.

### Both compile proofs (CGO_ENABLED=0, this machine, no C toolchain)

```
$ ./build.sh
== build darwin-arm64 ==
== build windows-amd64 ==
== artifacts ==
-rwxr-xr-x@ 1 jamesguldan  staff  19452578 Aug 27 19:18 wa-daemon-darwin-arm64
-rwxr-xr-x@ 1 jamesguldan  staff  20315136 Aug 27 19:18 wa-daemon-windows-amd64.exe
dist/wa-daemon-darwin-arm64:      Mach-O 64-bit executable arm64
dist/wa-daemon-windows-amd64.exe: PE32+ executable (console) x86-64, for MS Windows

$ shasum -a 256 dist/*
d0dbab1bd08a2cdf4d0d4d76d3fd3fd082e84f01740798a0a8c9625463f27bd3  dist/wa-daemon-darwin-arm64
92db606822653458c384dad62a71b4fc8a65ef1ad9ac50801ca8eba72f9c53b7  dist/wa-daemon-windows-amd64.exe
```

`dist/` is gitignored; binaries are build outputs, not repo contents.

### Smoke run (darwin binary, temp data dir, 6 seconds, no pairing)

```
$ WA_DATA_DIR=$SMOKE ./dist/wa-daemon-darwin-arm64
[wa-daemon] session store: $SMOKE/wa-session.db
[wa-daemon] outbox:        $SMOKE/wa-outbox.db
[wa-daemon] outbox has 0 undrained message(s) waiting for the drain
[wa-daemon] scan this QR with WhatsApp on the phone (Settings → Linked
            Devices → Link a Device); it rotates every ~60s
<ASCII QR rendered>
[wa-daemon] shutting down
$ sqlite3 $SMOKE/wa-session.db ".tables"
whatsmeow_app_state_mutation_macs  whatsmeow_lid_map ... (full whatsmeow schema)
$ sqlite3 $SMOKE/wa-outbox.db ".schema outbox_messages"   # outbox schema present
```

This proves: WA_DATA_DIR honored, both databases created under it (not
cwd), whatsmeow migrations run on modernc, a REAL pairing QR received from
WhatsApp's servers, graceful SIGTERM shutdown. No pairing was performed.

### npm test (the JS world is untouched and green)

```
$ npm test; echo "npm test exit code: $?"
... full chain ...
secret-scan v4 (js): all tests passed
npm test exit code: 0
```

Exit code captured to the session scratchpad
(`npm-test-exit.txt`: `npm test exit code: 0`); full 2,872-line log
retained there as `npm-test-wp07.log`.

### npm package does not grow

`daemons/` is not in package.json `files` (an allowlist), and:

```
$ npm pack --dry-run | grep -ci daemons
0
$ npm pack --dry-run | tail -2
npm notice total files: 331
brain-installer-0.1.21.tgz
```

### Privacy grep of the new tree

```
$ grep -rniE "jamesguldan|notes\.|supabase|fly\.io|flycast|jg-whatsapp|POSTGRES|transcribe-audio|supavisor" \
    --include="*.go" --include="*.md" --include="*.sh" --include="*.mod" daemons/whatsapp/
README.md:58:purpose: the Postgres output layer, the hardcoded personal transcription
```

The single hit is the README describing what was REMOVED, with no
hostname, schema name, or identifier. No personal infrastructure survives
in the ported tree. (The module path contains the repo's own public GitHub
org, which is already in package.json.)

## Binary distribution: recommendation (decide, not built)

**Recommendation: download-on-connect from a GitHub release asset, with a
pinned SHA-256 check — do not bundle.** Tradeoffs: bundling both binaries
adds ~40MB to an npm package that is currently lean, on every client and
every version bump, for a connector most clients will never opt into
(D-2 is undecided and the posture is explicit opt-in) — that is the wrong
default for a public package clients `npm install`. Download-on-connect
costs a hosting decision and an integrity story, but both are nearly free
here: the repo is already public on GitHub, releases are the natural home,
and the installer pinning the expected SHA-256 per version (checked before
first run) gives integrity without a signing infrastructure. It also keeps
`npm install` working offline/air-gapped for everything except the one
connector that inherently needs the network anyway. The real remaining
cost is macOS Gatekeeper / Windows SmartScreen on an unsigned downloaded
binary — that friction exists for a bundled binary too (macOS quarantine
applies to npm-fetched artifacts executed later in some paths, and
SmartScreen keys off the download regardless), so signing/notarization is
its own line item for the installer package either way, not an argument
for bundling. Interim for tester zero: hand the .exe over directly and
document the SmartScreen click-through.

## Matrix honesty

The WhatsApp matrix row still says export-only — correct, since nothing is
installable today. The "what it does not do" paragraph was updated in the
same spirit it already had: it now says the daemon half exists in this
codebase with installer wiring pending, keeps the ToS gray-area/ban-risk
disclosure, and adds the history-depth-at-link-time disclosure the plan
requires. No capability claim was added. No CHANGELOG entry: nothing a
client can touch changed.

## Unprovable here, and why

- **Live pairing, history sync, and live-message capture end to end**
  require a phone scanning the QR with a test WhatsApp account. No
  automated proof is possible on a build machine; faking it would violate
  the repo's own rules. The smoke run gets as close as possible without an
  account (real QR from real WhatsApp servers).
- **The Windows binary running on Windows.** It cross-compiles and
  `file(1)` confirms a valid PE32+ console executable, but this machine
  cannot execute it. Jay's PC is tester zero per the plan, in the
  follow-up package.
- **Behavior under WhatsApp's server-side throttling of history sync**
  (chunk cadence, total depth) is only observable on a real pairing.
