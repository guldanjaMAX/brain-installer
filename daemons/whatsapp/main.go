// wa-daemon — WhatsApp capture daemon for a client-owned brain install.
//
// What it does, and all it does:
//
//   - Pairs with WhatsApp as a linked device. On first run it prints a QR
//     code to the terminal (WhatsApp on the phone → Settings → Linked
//     Devices → Link a Device). The session persists locally, so later
//     startups reconnect silently.
//   - Captures the history WhatsApp transfers at link time plus every live
//     message afterward, one row per message, into a local SQLite outbox.
//   - Nothing else. No network output of any kind: no HTTP server, no
//     message sending, no transcription service, no database besides the
//     two local SQLite files. A separate Node-side drain (a later work
//     package) sessionizes the outbox through the installer's existing
//     pipeline and pushes it to the client's own worker.
//
// Configuration (all optional; see internal/paths):
//
//	WA_DATA_DIR     directory for both databases
//	WA_DB_PATH      explicit whatsmeow session store path (always honored)
//	WA_OUTBOX_PATH  explicit outbox path (always honored)
//
// Flags, for supervisors that cannot set an environment variable — a Windows
// Scheduled Task action has no way to do it, and wrapping the command in a
// shell to work around that would put a console window in the supervision path:
//
//	--data-dir <dir>   same meaning as WA_DATA_DIR, and wins over it
//	--log-file <path>  append the log here instead of stderr, because Task
//	                   Scheduler cannot redirect a child's output
//	--version          print the build stamp and exit
//
// Exit is graceful on SIGINT/SIGTERM.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/mdp/qrterminal/v3"
	_ "modernc.org/sqlite" // registers database/sql driver "sqlite" (pure Go, no cgo)

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	"github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/capture"
	"github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/outbox"
	"github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/paths"
)

const logPrefix = "[wa-daemon] "

// version is stamped by build.sh via -ldflags "-X main.version=...".
var version = "dev"

// options are the two things a supervisor has to be able to tell this process
// that a launchd plist could pass in the environment and a Windows Scheduled
// Task cannot.
//
// Task Scheduler's XML schema has no way to set an environment variable for an
// action. Wrapping the command in `cmd /c set WA_DATA_DIR=... && wa-daemon.exe`
// would work and would also put a shell and a visible console window into the
// supervision path, so the knobs are command-line flags instead. Environment
// variables keep working exactly as before; a flag simply wins over one, which
// is the same precedence rule the paths package already applies to explicit
// configuration.
type options struct {
	dataDir string
	logFile string
	rest    []string
}

// parseOptions reads the flags this daemon accepts. It is deliberately a small
// hand-rolled parser rather than the flag package: the daemon takes no other
// arguments, and an unknown argument must be a named refusal rather than a
// usage dump from a library.
func parseOptions(argv []string) (options, error) {
	var out options
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--data-dir", "--log-file":
			if i+1 >= len(argv) || argv[i+1] == "" {
				return out, fmt.Errorf("%s needs a path", argv[i])
			}
			if argv[i] == "--data-dir" {
				out.dataDir = argv[i+1]
			} else {
				out.logFile = argv[i+1]
			}
			i++
		default:
			out.rest = append(out.rest, argv[i])
		}
	}
	if len(out.rest) > 0 {
		return out, fmt.Errorf("unrecognised argument %q (this daemon takes --data-dir, --log-file, --version)", out.rest[0])
	}
	return out, nil
}

// getenvWith returns a lookup where an explicitly-passed flag beats the ambient
// environment for exactly the one name it overrides, and everything else falls
// through unchanged.
func getenvWith(base func(string) string, name, value string) func(string) string {
	if value == "" {
		return base
	}
	return func(key string) string {
		if key == name {
			return value
		}
		return base(key)
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix(logPrefix)

	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("wa-daemon " + version)
		return
	}

	opts, err := parseOptions(os.Args[1:])
	if err != nil {
		log.Fatalf("arguments: %v", err)
	}

	// A supervised process on Windows has nowhere to write: Task Scheduler
	// cannot redirect stdio, so without this the only record of why capture
	// stopped is gone. Opened append-only; the supervisor caps the file at the
	// two moments this process is provably stopped.
	if opts.logFile != "" {
		if err := os.MkdirAll(filepath.Dir(opts.logFile), 0o700); err != nil {
			log.Fatalf("log directory %s: %v", filepath.Dir(opts.logFile), err)
		}
		handle, err := os.OpenFile(opts.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			log.Fatalf("log file %s: %v", opts.logFile, err)
		}
		defer handle.Close()
		log.SetOutput(handle)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Where everything lives ────────────────────────────────────────
	home, _ := os.UserHomeDir()
	resolved, err := paths.Resolve(paths.Env{
		Getenv: getenvWith(os.Getenv, paths.EnvDataDir, opts.dataDir),
		GOOS:   runtime.GOOS,
		Home:   home,
	})
	if err != nil {
		log.Fatalf("paths: %v", err)
	}
	for _, dir := range []string{resolved.DataDir, filepath.Dir(resolved.SessionDB), filepath.Dir(resolved.OutboxDB)} {
		if dir == "" || dir == "." {
			continue
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			log.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	log.Printf("session store: %s", resolved.SessionDB)
	log.Printf("outbox:        %s", resolved.OutboxDB)

	// ── Outbox ────────────────────────────────────────────────────────
	box, err := outbox.Open(resolved.OutboxDB)
	if err != nil {
		log.Fatalf("outbox: %v", err)
	}
	defer box.Close()
	if undrained, err := box.CountUndrained(ctx); err == nil {
		log.Printf("outbox has %d undrained message(s) waiting for the drain", undrained)
	}

	// ── whatsmeow session store (modernc SQLite, no cgo) ──────────────
	// Dialect "sqlite" is both the modernc driver's registered name for
	// database/sql AND accepted by whatsmeow's dbutil dialect parser
	// (any "sqlite"-prefixed string). Foreign keys must be ON via DSN
	// pragma or whatsmeow's Upgrade refuses to run.
	dsn := "file:" + resolved.SessionDB +
		"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)"
	sessionDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatalf("session db open: %v", err)
	}
	// One writer connection: avoids SQLITE_BUSY between whatsmeow's
	// internal goroutines on the pure-Go driver.
	sessionDB.SetMaxOpenConns(1)
	storeContainer := sqlstore.NewWithDB(sessionDB, "sqlite", waLog.Stdout("Database", "WARN", true))
	if err := storeContainer.Upgrade(ctx); err != nil {
		log.Fatalf("session store upgrade: %v", err)
	}
	deviceStore, err := storeContainer.GetFirstDevice(ctx)
	if err != nil {
		log.Fatalf("GetFirstDevice: %v", err)
	}

	cli := whatsmeow.NewClient(deviceStore, waLog.Stdout("Client", "INFO", true))
	d := &daemon{cli: cli, box: box}
	cli.AddEventHandler(d.handleEvent)

	// ── Connect: QR pairing on first run, silent reconnect after ──────
	if cli.Store.ID == nil {
		// GetQRChannel must be called before Connect (whatsmeow contract).
		qrChan, _ := cli.GetQRChannel(ctx)
		if err := cli.Connect(); err != nil {
			log.Fatalf("connect: %v", err)
		}
		go func() {
			for evt := range qrChan {
				switch evt.Event {
				case "code":
					log.Printf("scan this QR with WhatsApp on the phone (Settings → Linked Devices → Link a Device); it rotates every ~60s")
					qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				default:
					log.Printf("QR event: %s", evt.Event)
				}
			}
		}()
	} else {
		if err := cli.Connect(); err != nil {
			log.Fatalf("reconnect: %v", err)
		}
	}

	// ── Wait for shutdown ─────────────────────────────────────────────
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs
	log.Printf("shutting down")
	cli.Disconnect()
	// Give in-flight history-sync writes a moment to land; the outbox is
	// idempotent, so anything cut off here is re-captured next pairing or
	// already safe.
	time.Sleep(500 * time.Millisecond)
}

// daemon holds the two things event handlers need. Explicit rather than
// package globals so the wiring is testable and single-purpose.
type daemon struct {
	cli *whatsmeow.Client
	box *outbox.Outbox
}

func (d *daemon) ownJID() types.JID {
	if d.cli != nil && d.cli.Store != nil && d.cli.Store.ID != nil {
		return *d.cli.Store.ID
	}
	return types.EmptyJID
}

func (d *daemon) handleEvent(e any) {
	switch ev := e.(type) {
	case *events.Connected:
		log.Printf("connected as %s", d.ownJID())
	case *events.PairSuccess:
		// The reliable "pairing worked" signal; the future connect wizard
		// watches for this line.
		log.Printf("paired with %s", ev.ID)
	case *events.Message:
		d.ingestLive(ev)
	case *events.HistorySync:
		// History chunks are large; process off the event loop so live
		// capture is never delayed. The outbox's unique constraint makes
		// concurrent, unordered chunks safe.
		go d.ingestHistory(ev)
	case *events.LoggedOut:
		log.Printf("logged out by the phone or by WhatsApp; delete the session store and restart to re-pair")
	case *events.Disconnected:
		log.Printf("disconnected (whatsmeow will reconnect automatically)")
	}
}

func (d *daemon) ingestLive(ev *events.Message) {
	row, ok := capture.RowFromLive(ev)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	inserted, err := d.box.Insert(ctx, row)
	if err != nil {
		log.Printf("outbox insert err for %s: %v", row.MessageID, err)
		return
	}
	if inserted {
		log.Printf("captured live %s message (%d chars)", row.Direction, len(row.Body))
	}
}

func (d *daemon) ingestHistory(ev *events.HistorySync) {
	if ev == nil || ev.Data == nil {
		return
	}
	convs := ev.Data.GetConversations()
	own := d.ownJID()

	var rows []outbox.Row
	skipped := 0
	for _, conv := range convs {
		convRows, convSkipped := capture.RowsFromHistoryConversation(own, conv)
		rows = append(rows, convRows...)
		skipped += convSkipped
	}
	if len(rows) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	inserted, err := d.box.InsertBatch(ctx, rows)
	if err != nil {
		log.Printf("history chunk insert err (%s, %d rows): %v",
			ev.Data.GetSyncType().String(), len(rows), err)
		return
	}
	log.Printf("history chunk %s: convs=%d inserted=%d duplicate=%d skipped=%d",
		ev.Data.GetSyncType().String(), len(convs), inserted, len(rows)-inserted, skipped)
}
