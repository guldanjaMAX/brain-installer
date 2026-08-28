# wa-daemon — WhatsApp live capture (the Go half of `brain connect whatsapp`)

A small Go daemon that pairs with WhatsApp as a linked device and captures
messages — the history the phone transfers at link time, plus every live
message afterward — into a local SQLite outbox. One row per message,
idempotent, nothing sent anywhere.

**This is half of a feature, and says so.** There is no `brain connect
whatsapp` yet: no installer wiring, no LaunchAgent or Windows service, no
Node-side drain that moves the outbox into the brain. Those are a follow-up
work package. What exists today is the capture daemon itself, its tests,
and a reproducible cross-platform build. A client cannot install this by
running anything in the CLI, and the ingest source matrix does not claim
otherwise.

## Read this before pairing anything

**Terms-of-service gray area, honestly stated.** This works by joining your
WhatsApp account as a linked device using a reimplementation of WhatsApp's
own multi-device protocol (the `whatsmeow` library) rather than an official
API. WhatsApp's terms do not bless unofficial clients, and accounts using
them carry a real, if historically small, risk of being warned or banned.
Nobody can quantify that risk for you, and anyone who tells you it is zero
is selling something. If losing this WhatsApp account would hurt, do not
pair it. This capability ships behind an explicit opt-in, never as a
default.

**History depth is what the phone gives, not what you ask for.** At link
time WhatsApp's servers push whatever history window the phone decides to
transfer — typically weeks to a few months of recent chats, not your full
archive. There is no knob in this daemon to demand more. If the full
archive matters, the per-chat "Export chat" path (already shipped in the
installer as the WhatsApp export parser) is the honest way to get it.

**Audio, images, video:** captured as markers (`[audio]`, `[image]` plus
any caption). Voice notes are not transcribed — the reference
implementation this was ported from posted audio to a personal
transcription service, which is exactly the kind of third-party dependency
a client build must not carry. A caption-less marker never becomes a
document downstream; the sessionizer filters it.

## Architecture: the daemon is deliberately dumb

```
WhatsApp servers ──(whatsmeow websocket)──▶ wa-daemon ──▶ wa-outbox.db (SQLite)
                                                              │
                                     (later work package)     ▼
                                     Node drain ──▶ message-session.mjs ──▶ client worker
```

The daemon captures and stores locally. It does not sessionize, does not
batch envelopes, and does not speak HTTP — the grouping logic that turns a
message stream into retrieval-safe documents already exists once, in
`ingest/message-session.mjs`, and reimplementing it in Go would create two
copies that drift. The Node-side drain reuses that code verbatim.

Compared to the reference implementation, the following are gone on
purpose: the Postgres output layer, the hardcoded personal transcription
endpoint, and the entire HTTP admin surface (`/qr`, `/qr.png`, `/send`,
`/healthz`) — a local background process has no business opening a listen
port on a client's machine. The terminal QR render stays; it is the
pairing UX.

## Outbox contract (what the future drain reads)

`outbox_messages` in `wa-outbox.db`, one row per message,
`UNIQUE(chat_jid, message_id)`. Column mapping to the sessionizer's input
shape:

| column        | sessionizer field | note                              |
|---------------|-------------------|-----------------------------------|
| `platform`    | `platform`        | always `whatsapp`                 |
| `chat_jid`    | `thread_id`       | WhatsApp chat JID                 |
| `message_id`  | `id`              | WhatsApp stanza ID                |
| `ts`          | `ts`              | ISO-8601 UTC                      |
| `direction`   | `direction`       | `in` / `out`                      |
| `body`        | `body`            | text or media marker              |
| `sender_name` | `sender_name`     | push name, else `+<number>`       |
| `thread_title`| `thread_title`    | chat name when WhatsApp sends one |

Drain protocol: read `WHERE drained_at IS NULL ORDER BY seq`, push through
the standard ingest contract, then set `drained_at`. The daemon never
touches `drained_at`. Rows also carry `source` (`live` or `history_sync`),
`sender_jid`, `is_group`, and `received_at` for provenance.

## Where files live

Defaults are per-user application data, never the working directory:

- macOS: `~/Library/Application Support/financial-brain/whatsapp/`
- Windows: `%LOCALAPPDATA%\financial-brain\whatsapp\`
- other: `$XDG_DATA_HOME` or `~/.local/share`, same suffix

Files: `wa-session.db` (whatsmeow device identity and encryption keys —
deleting it un-pairs you) and `wa-outbox.db` (captured messages).

Overrides, always honored when set: `WA_DATA_DIR` (move both),
`WA_DB_PATH` (session store), `WA_OUTBOX_PATH` (outbox). The reference
implementation had a bug where an explicitly set `WA_DB_PATH` was silently
overridden to a cwd-relative path whenever a deployment-specific mount
directory was absent; that heuristic is deleted, not patched, and
`internal/paths/paths_test.go` pins the fix.

## Build

```
./build.sh
```

Runs `go vet`, the test suite, then builds `dist/wa-daemon-darwin-arm64`
and `dist/wa-daemon-windows-amd64.exe`, both with `CGO_ENABLED=0`. No C
toolchain is needed for either target: the SQLite driver is
`modernc.org/sqlite` (pure Go). whatsmeow's `sqlstore` accepts it as
dialect `"sqlite"` — its dialect parser matches any `sqlite`-prefixed
string, and the string doubles as the `database/sql` driver name. The one
DSN difference from the cgo driver: foreign keys are enabled with
`?_pragma=foreign_keys(1)` (modernc syntax), which matters because
whatsmeow refuses to run its migrations when that pragma is off.

Neither binary is code-signed or notarized yet. Expect Gatekeeper friction
on macOS and a SmartScreen warning on Windows for a downloaded copy; that
is a distribution problem for the installer work package, noted there, not
solved here.

## Running it by hand (development only)

```
go run .            # or ./dist/wa-daemon-darwin-arm64
```

First run prints a QR code in the terminal: WhatsApp on the phone →
Settings → Linked Devices → Link a Device, scan it. The code rotates every
~60 seconds and reprints. After `paired with <jid>` appears, history-sync
chunks land over the next minutes (`history chunk ... inserted=N` log
lines) and live messages append as they arrive. Subsequent startups
reconnect silently. Stop with Ctrl-C; capture is idempotent across
restarts.

## What is tested, and what cannot be

`go test ./...` covers the outbox schema and idempotency (including the
live-then-history-replay dedupe), path resolution (explicit env always
honored, platform defaults, refusal to fall back to the working
directory), and the event-to-row mapping for both live and history-sync
shapes using constructed whatsmeow structs.

What is deliberately not claimed: nothing here proves a real pairing, a
real history sync, or a real live message end to end — that requires a
phone scanning the QR with a test WhatsApp account, which no automated
test on a build machine can do. A smoke run does prove the daemon starts,
creates both databases, runs whatsmeow's schema migrations on the pure-Go
driver, reaches WhatsApp's servers, and receives a genuine pairing QR.
The full live-capture acceptance run happens when the installer half
exists, on a test account, and its evidence gets written then.
