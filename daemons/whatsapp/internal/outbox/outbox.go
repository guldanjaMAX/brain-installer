// Package outbox is the daemon's only output: a local SQLite table holding
// one row per captured WhatsApp message.
//
// The daemon is deliberately dumb. It does NOT sessionize, does NOT batch
// envelopes, and does NOT talk HTTP to anything. A separate Node-side drain
// (a later work package, reusing the installer's existing
// ingest/message-session.mjs and ingest/envelope-batching.mjs verbatim)
// reads undrained rows in seq order, groups them into session documents,
// pushes them through the standard ingest contract, and marks them drained.
// Keeping the grouping logic in exactly one language is the point.
//
// Column-to-sessionizer mapping the drain relies on
// (ingest/message-session.mjs messageEnvelope/sessionizer input shape):
//
//	platform      -> "whatsapp" (constant)
//	chat_jid      -> thread_id
//	message_id    -> id
//	ts            -> ts        (ISO-8601 UTC)
//	direction     -> direction ("in" | "out")
//	body          -> body
//	sender_name   -> sender_name
//	thread_title  -> thread_title
//
// Idempotency: UNIQUE(chat_jid, message_id) with INSERT ... DO NOTHING.
// A WhatsApp message's identity is its stanza ID within its chat; the same
// message arriving twice (reconnect replay, or once live and again inside a
// history-sync chunk) inserts exactly one row. History chunks arrive on
// concurrent goroutines with no ordering guarantee — the constraint, not
// arrival order, is what makes capture idempotent.
package outbox

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registers as "sqlite"
)

// Row is one captured message.
type Row struct {
	ChatJID     string    // WhatsApp chat JID; the thread identity
	MessageID   string    // WhatsApp stanza ID; unique within the chat
	TS          time.Time // when the message was sent
	Direction   string    // "in" | "out"
	Body        string    // text, or a media marker like "[audio]"
	SenderJID   string    // JID of the sender
	SenderName  string    // push name when known, else best-effort label
	ThreadTitle string    // chat display name when known
	IsGroup     bool
	Source      string // "live" | "history_sync"
}

const schema = `
CREATE TABLE IF NOT EXISTS outbox_messages (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid     TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'whatsapp',
  ts           TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  body         TEXT NOT NULL,
  sender_jid   TEXT NOT NULL DEFAULT '',
  sender_name  TEXT NOT NULL DEFAULT '',
  thread_title TEXT NOT NULL DEFAULT '',
  is_group     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL CHECK (source IN ('live','history_sync')),
  received_at  TEXT NOT NULL,
  drained_at   TEXT,
  UNIQUE (chat_jid, message_id)
);
CREATE INDEX IF NOT EXISTS idx_outbox_undrained
  ON outbox_messages (seq) WHERE drained_at IS NULL;
`

// Outbox wraps the SQLite database.
type Outbox struct {
	db  *sql.DB
	now func() time.Time
}

// Open opens (creating if needed) the outbox database at path and ensures
// the schema exists. Safe to call on an existing database — schema creation
// is idempotent.
func Open(path string) (*Outbox, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open outbox: %w", err)
	}
	// Single writer connection: modernc/sqlite is happiest without
	// concurrent write connections, and this daemon has no need for them.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("outbox schema: %w", err)
	}
	return &Outbox{db: db, now: time.Now}, nil
}

// Close closes the underlying database.
func (o *Outbox) Close() error { return o.db.Close() }

func (o *Outbox) validate(r Row) error {
	if r.ChatJID == "" || r.MessageID == "" {
		return fmt.Errorf("outbox row missing identity (chat_jid=%q message_id=%q)", r.ChatJID, r.MessageID)
	}
	if r.Direction != "in" && r.Direction != "out" {
		return fmt.Errorf("outbox row bad direction %q", r.Direction)
	}
	if r.Source != "live" && r.Source != "history_sync" {
		return fmt.Errorf("outbox row bad source %q", r.Source)
	}
	if r.TS.IsZero() {
		return fmt.Errorf("outbox row missing timestamp")
	}
	if r.Body == "" {
		return fmt.Errorf("outbox row empty body")
	}
	return nil
}

const insertSQL = `
INSERT INTO outbox_messages
  (chat_jid, message_id, ts, direction, body, sender_jid, sender_name,
   thread_title, is_group, source, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (chat_jid, message_id) DO NOTHING
`

// Insert writes one row. Returns true when a row was actually inserted,
// false when the (chat_jid, message_id) pair already existed.
func (o *Outbox) Insert(ctx context.Context, r Row) (bool, error) {
	if err := o.validate(r); err != nil {
		return false, err
	}
	res, err := o.db.ExecContext(ctx, insertSQL,
		r.ChatJID, r.MessageID, r.TS.UTC().Format(time.RFC3339), r.Direction,
		r.Body, r.SenderJID, r.SenderName, r.ThreadTitle, boolInt(r.IsGroup),
		r.Source, o.now().UTC().Format(time.RFC3339))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// InsertBatch writes many rows in one transaction (history-sync chunks).
// Returns how many were newly inserted; duplicates count as skipped, not
// errors. A row failing validation aborts the whole batch — a malformed
// mapping is a bug to surface, not data to half-write.
func (o *Outbox) InsertBatch(ctx context.Context, rows []Row) (inserted int, err error) {
	tx, err := o.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()
	stmt, err := tx.PrepareContext(ctx, insertSQL)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	receivedAt := o.now().UTC().Format(time.RFC3339)
	for _, r := range rows {
		if err = o.validate(r); err != nil {
			return 0, err
		}
		var res sql.Result
		res, err = stmt.ExecContext(ctx,
			r.ChatJID, r.MessageID, r.TS.UTC().Format(time.RFC3339), r.Direction,
			r.Body, r.SenderJID, r.SenderName, r.ThreadTitle, boolInt(r.IsGroup),
			r.Source, receivedAt)
		if err != nil {
			return 0, err
		}
		if n, raErr := res.RowsAffected(); raErr == nil && n > 0 {
			inserted++
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

// CountUndrained reports rows the Node-side drain has not yet consumed.
func (o *Outbox) CountUndrained(ctx context.Context) (int64, error) {
	var n int64
	err := o.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM outbox_messages WHERE drained_at IS NULL").Scan(&n)
	return n, err
}

// Count reports total rows.
func (o *Outbox) Count(ctx context.Context) (int64, error) {
	var n int64
	err := o.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM outbox_messages").Scan(&n)
	return n, err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
