package outbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func testRow(chat, id string) Row {
	return Row{
		ChatJID:    chat,
		MessageID:  id,
		TS:         time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC),
		Direction:  "in",
		Body:       "hello",
		SenderJID:  "15550001111@s.whatsapp.net",
		SenderName: "Test Sender",
		Source:     "live",
	}
}

func open(t *testing.T) *Outbox {
	t.Helper()
	o, err := Open(filepath.Join(t.TempDir(), "outbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { o.Close() })
	return o
}

func TestInsertIsIdempotentOnMessageID(t *testing.T) {
	o := open(t)
	ctx := context.Background()

	ins, err := o.Insert(ctx, testRow("chat1@s.whatsapp.net", "MSG-A"))
	if err != nil || !ins {
		t.Fatalf("first insert: inserted=%v err=%v", ins, err)
	}
	// Same message again (reconnect replay / history overlap): no new row.
	ins, err = o.Insert(ctx, testRow("chat1@s.whatsapp.net", "MSG-A"))
	if err != nil {
		t.Fatal(err)
	}
	if ins {
		t.Fatal("duplicate (chat, id) must not insert a second row")
	}
	n, _ := o.Count(ctx)
	if n != 1 {
		t.Fatalf("want 1 row, got %d", n)
	}

	// Same stanza ID in a DIFFERENT chat is a different message.
	ins, err = o.Insert(ctx, testRow("chat2@g.us", "MSG-A"))
	if err != nil || !ins {
		t.Fatalf("same id different chat should insert: inserted=%v err=%v", ins, err)
	}
	n, _ = o.Count(ctx)
	if n != 2 {
		t.Fatalf("want 2 rows, got %d", n)
	}
}

func TestInsertBatchDedupesInsideAndAcrossBatches(t *testing.T) {
	o := open(t)
	ctx := context.Background()

	// A history chunk with an internal duplicate.
	rows := []Row{
		testRow("chat1@s.whatsapp.net", "H-1"),
		testRow("chat1@s.whatsapp.net", "H-2"),
		testRow("chat1@s.whatsapp.net", "H-1"), // dup inside the chunk
	}
	for i := range rows {
		rows[i].Source = "history_sync"
	}
	inserted, err := o.InsertBatch(ctx, rows)
	if err != nil {
		t.Fatal(err)
	}
	if inserted != 2 {
		t.Fatalf("want 2 inserted from first chunk, got %d", inserted)
	}

	// A second chunk overlapping the first (WhatsApp re-delivers freely).
	rows2 := []Row{
		testRow("chat1@s.whatsapp.net", "H-2"),
		testRow("chat1@s.whatsapp.net", "H-3"),
	}
	for i := range rows2 {
		rows2[i].Source = "history_sync"
	}
	inserted, err = o.InsertBatch(ctx, rows2)
	if err != nil {
		t.Fatal(err)
	}
	if inserted != 1 {
		t.Fatalf("want 1 inserted from overlapping chunk, got %d", inserted)
	}
	n, _ := o.Count(ctx)
	if n != 3 {
		t.Fatalf("want 3 total rows, got %d", n)
	}
}

func TestLiveThenHistoryIsOneRow(t *testing.T) {
	o := open(t)
	ctx := context.Background()

	live := testRow("chat1@s.whatsapp.net", "X-9")
	if _, err := o.Insert(ctx, live); err != nil {
		t.Fatal(err)
	}
	hist := testRow("chat1@s.whatsapp.net", "X-9")
	hist.Source = "history_sync"
	ins, err := o.Insert(ctx, hist)
	if err != nil {
		t.Fatal(err)
	}
	if ins {
		t.Fatal("history replay of a live-captured message must not duplicate")
	}
}

func TestValidationRejectsMalformedRows(t *testing.T) {
	o := open(t)
	ctx := context.Background()
	bad := []Row{
		func() Row { r := testRow("c", "m"); r.ChatJID = ""; return r }(),
		func() Row { r := testRow("c", "m"); r.MessageID = ""; return r }(),
		func() Row { r := testRow("c", "m"); r.Direction = "sideways"; return r }(),
		func() Row { r := testRow("c", "m"); r.Source = "guess"; return r }(),
		func() Row { r := testRow("c", "m"); r.TS = time.Time{}; return r }(),
		func() Row { r := testRow("c", "m"); r.Body = ""; return r }(),
	}
	for i, r := range bad {
		if _, err := o.Insert(ctx, r); err == nil {
			t.Fatalf("bad row %d accepted", i)
		}
	}
	n, _ := o.Count(ctx)
	if n != 0 {
		t.Fatalf("no bad rows should persist, got %d", n)
	}
}

func TestReopenIsIdempotentAndKeepsRows(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.db")
	ctx := context.Background()

	o, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.Insert(ctx, testRow("chat1@s.whatsapp.net", "KEEP-1")); err != nil {
		t.Fatal(err)
	}
	if err := o.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: schema creation must be idempotent, data must survive.
	o2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer o2.Close()
	n, err := o2.Count(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("row lost across reopen: got %d", n)
	}
	// And the dedupe constraint still holds on the reopened database.
	ins, err := o2.Insert(ctx, testRow("chat1@s.whatsapp.net", "KEEP-1"))
	if err != nil {
		t.Fatal(err)
	}
	if ins {
		t.Fatal("constraint lost across reopen")
	}
}

func TestCountUndrainedReflectsDrainMarks(t *testing.T) {
	o := open(t)
	ctx := context.Background()
	for _, id := range []string{"D-1", "D-2", "D-3"} {
		if _, err := o.Insert(ctx, testRow("chat1@s.whatsapp.net", id)); err != nil {
			t.Fatal(err)
		}
	}
	n, err := o.CountUndrained(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("want 3 undrained, got %d", n)
	}
	// Simulate the Node-side drain marking one row consumed (the daemon
	// itself never writes drained_at; this exercises the contract).
	if _, err := o.db.ExecContext(ctx,
		"UPDATE outbox_messages SET drained_at = ? WHERE message_id = 'D-2'",
		time.Now().UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	n, err = o.CountUndrained(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("want 2 undrained after one drain mark, got %d", n)
	}
}
