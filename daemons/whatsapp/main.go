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

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix(logPrefix)

	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("wa-daemon " + version)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Where everything lives ────────────────────────────────────────
	home, _ := os.UserHomeDir()
	resolved, err := paths.Resolve(paths.Env{Getenv: os.Getenv, GOOS: runtime.GOOS, Home: home})
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
