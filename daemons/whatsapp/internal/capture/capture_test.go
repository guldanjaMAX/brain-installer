package capture

import (
	"testing"
	"time"

	waCommon "go.mau.fi/whatsmeow/proto/waCommon"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	waHistorySync "go.mau.fi/whatsmeow/proto/waHistorySync"
	waWeb "go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

var (
	ownJID  = types.NewJID("15550000001", types.DefaultUserServer)
	peerJID = types.NewJID("15550002222", types.DefaultUserServer)
	grpJID  = types.NewJID("120363000000000001", types.GroupServer)
)

func textMsg(s string) *waE2E.Message {
	return &waE2E.Message{Conversation: proto.String(s)}
}

func liveEvent(id string, chat, sender types.JID, fromMe, isGroup bool, msg *waE2E.Message) *events.Message {
	ev := &events.Message{Message: msg}
	ev.Info.ID = id
	ev.Info.Chat = chat
	ev.Info.Sender = sender
	ev.Info.IsFromMe = fromMe
	ev.Info.IsGroup = isGroup
	ev.Info.PushName = ""
	ev.Info.Timestamp = time.Date(2026, 8, 27, 15, 4, 5, 0, time.UTC)
	return ev
}

// ── MessageText ──────────────────────────────────────────────────────────

func TestMessageTextShapes(t *testing.T) {
	cases := []struct {
		name string
		msg  *waE2E.Message
		want string
	}{
		{"nil", nil, ""},
		{"plain", textMsg("hello there"), "hello there"},
		{"extended", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("quoted reply text")}}, "quoted reply text"},
		{"image with caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("the invoice")}}, "[image] the invoice"},
		{"image no caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}, "[image]"},
		{"video with caption", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Caption: proto.String("walkthrough")}}, "[video] walkthrough"},
		{"document titled", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{Title: proto.String("lease.pdf")}}, "[document lease.pdf]"},
		{"audio is a bare marker", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}, "[audio]"},
		{"empty", &waE2E.Message{}, ""},
	}
	for _, c := range cases {
		if got := MessageText(c.msg); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// ── Live mapping ─────────────────────────────────────────────────────────

func TestRowFromLiveIncomingDM(t *testing.T) {
	ev := liveEvent("LIVE-1", peerJID, peerJID, false, false, textMsg("hi"))
	ev.Info.PushName = "Alex Peer"
	row, ok := RowFromLive(ev)
	if !ok {
		t.Fatal("expected a row")
	}
	if row.ChatJID != peerJID.String() || row.MessageID != "LIVE-1" {
		t.Fatalf("identity wrong: %+v", row)
	}
	if row.Direction != "in" {
		t.Fatalf("direction: %q", row.Direction)
	}
	if row.SenderName != "Alex Peer" || row.ThreadTitle != "Alex Peer" {
		t.Fatalf("names wrong: sender=%q title=%q", row.SenderName, row.ThreadTitle)
	}
	if row.Source != "live" || row.IsGroup {
		t.Fatalf("metadata wrong: %+v", row)
	}
	if !row.TS.Equal(time.Date(2026, 8, 27, 15, 4, 5, 0, time.UTC)) {
		t.Fatalf("ts wrong: %v", row.TS)
	}
}

func TestRowFromLiveOutgoing(t *testing.T) {
	ev := liveEvent("LIVE-2", peerJID, ownJID, true, false, textMsg("on my way"))
	row, ok := RowFromLive(ev)
	if !ok {
		t.Fatal("expected a row")
	}
	if row.Direction != "out" {
		t.Fatalf("direction: %q", row.Direction)
	}
	if row.ThreadTitle != "" {
		t.Fatalf("own messages must not set a 1:1 title (that is the peer's name): %q", row.ThreadTitle)
	}
	if row.SenderJID != ownJID.String() {
		t.Fatalf("sender: %q", row.SenderJID)
	}
}

func TestRowFromLiveGroup(t *testing.T) {
	ev := liveEvent("LIVE-3", grpJID, peerJID, false, true, textMsg("group note"))
	row, ok := RowFromLive(ev)
	if !ok {
		t.Fatal("expected a row")
	}
	if !row.IsGroup || row.ChatJID != grpJID.String() {
		t.Fatalf("group metadata wrong: %+v", row)
	}
	if row.ThreadTitle != "" {
		t.Fatalf("group titles need a metadata fetch, capture must leave them empty: %q", row.ThreadTitle)
	}
}

func TestRowFromLiveFallbackSenderLabel(t *testing.T) {
	ev := liveEvent("LIVE-4", peerJID, peerJID, false, false, textMsg("no push name"))
	row, ok := RowFromLive(ev)
	if !ok {
		t.Fatal("expected a row")
	}
	if row.SenderName != "+15550002222" {
		t.Fatalf("fallback label: %q", row.SenderName)
	}
}

func TestRowFromLiveSkips(t *testing.T) {
	// Empty body (e.g. a message type MessageText does not render).
	if _, ok := RowFromLive(liveEvent("LIVE-5", peerJID, peerJID, false, false, &waE2E.Message{})); ok {
		t.Fatal("empty body must be skipped")
	}
	// Missing ID.
	ev := liveEvent("", peerJID, peerJID, false, false, textMsg("x"))
	if _, ok := RowFromLive(ev); ok {
		t.Fatal("missing ID must be skipped")
	}
	// Zero timestamp.
	ev = liveEvent("LIVE-6", peerJID, peerJID, false, false, textMsg("x"))
	ev.Info.Timestamp = time.Time{}
	if _, ok := RowFromLive(ev); ok {
		t.Fatal("zero timestamp must be skipped")
	}
	// Nil event.
	if _, ok := RowFromLive(nil); ok {
		t.Fatal("nil event must be skipped")
	}
}

// ── History mapping ──────────────────────────────────────────────────────

func historyMsg(id string, fromMe bool, participant string, tsSec int64, msg *waE2E.Message) *waWeb.WebMessageInfo {
	key := &waCommon.MessageKey{
		ID:     proto.String(id),
		FromMe: proto.Bool(fromMe),
	}
	if participant != "" {
		key.Participant = proto.String(participant)
	}
	return &waWeb.WebMessageInfo{
		Key:              key,
		Message:          msg,
		MessageTimestamp: proto.Uint64(uint64(tsSec)),
	}
}

func TestRowFromHistoryIncomingDM(t *testing.T) {
	wmi := historyMsg("HIST-1", false, "", 1756300000, textMsg("history hello"))
	row, ok := RowFromHistory(ownJID, peerJID, "Alex Peer", wmi)
	if !ok {
		t.Fatal("expected a row")
	}
	if row.Direction != "in" || row.Source != "history_sync" {
		t.Fatalf("metadata wrong: %+v", row)
	}
	// 1:1 incoming: sender is the chat itself.
	if row.SenderJID != peerJID.String() {
		t.Fatalf("sender: %q", row.SenderJID)
	}
	if row.ThreadTitle != "Alex Peer" {
		t.Fatalf("conversation name must flow through: %q", row.ThreadTitle)
	}
	if !row.TS.Equal(time.Unix(1756300000, 0).UTC()) {
		t.Fatalf("ts wrong: %v", row.TS)
	}
}

func TestRowFromHistoryFromMe(t *testing.T) {
	wmi := historyMsg("HIST-2", true, "", 1756300100, textMsg("my old reply"))
	row, ok := RowFromHistory(ownJID, peerJID, "", wmi)
	if !ok {
		t.Fatal("expected a row")
	}
	if row.Direction != "out" {
		t.Fatalf("direction: %q", row.Direction)
	}
	if row.SenderJID != ownJID.String() {
		t.Fatalf("from-me sender must be own JID: %q", row.SenderJID)
	}
}

func TestRowFromHistoryGroupParticipant(t *testing.T) {
	wmi := historyMsg("HIST-3", false, peerJID.String(), 1756300200, textMsg("group history"))
	row, ok := RowFromHistory(ownJID, grpJID, "Planning Group", wmi)
	if !ok {
		t.Fatal("expected a row")
	}
	if !row.IsGroup {
		t.Fatal("group flag lost")
	}
	if row.SenderJID != peerJID.String() {
		t.Fatalf("group sender must come from participant: %q", row.SenderJID)
	}
	if row.ThreadTitle != "Planning Group" {
		t.Fatalf("group name lost: %q", row.ThreadTitle)
	}
}

func TestRowFromHistorySkips(t *testing.T) {
	// Group message with no participant: sender unresolvable.
	if _, ok := RowFromHistory(ownJID, grpJID, "", historyMsg("H-X", false, "", 1756300300, textMsg("x"))); ok {
		t.Fatal("group without participant must be skipped")
	}
	// From-me with no own JID (should never happen once paired, but must not panic or fabricate).
	if _, ok := RowFromHistory(types.EmptyJID, peerJID, "", historyMsg("H-Y", true, "", 1756300300, textMsg("x"))); ok {
		t.Fatal("from-me without own JID must be skipped")
	}
	// Zero timestamp.
	if _, ok := RowFromHistory(ownJID, peerJID, "", historyMsg("H-Z", false, "", 0, textMsg("x"))); ok {
		t.Fatal("zero timestamp must be skipped")
	}
	// No key.
	if _, ok := RowFromHistory(ownJID, peerJID, "", &waWeb.WebMessageInfo{Message: textMsg("x")}); ok {
		t.Fatal("missing key must be skipped")
	}
	// No body (stub/system notice).
	if _, ok := RowFromHistory(ownJID, peerJID, "", historyMsg("H-W", false, "", 1756300300, &waE2E.Message{})); ok {
		t.Fatal("empty body must be skipped")
	}
	// Nil.
	if _, ok := RowFromHistory(ownJID, peerJID, "", nil); ok {
		t.Fatal("nil must be skipped")
	}
}

func TestRowsFromHistoryConversation(t *testing.T) {
	conv := &waHistorySync.Conversation{
		ID:   proto.String(peerJID.String()),
		Name: proto.String("Alex Peer"),
		Messages: []*waHistorySync.HistorySyncMsg{
			{Message: historyMsg("C-1", false, "", 1756301000, textMsg("first"))},
			{Message: historyMsg("C-2", true, "", 1756301100, textMsg("second"))},
			{Message: historyMsg("C-3", false, "", 1756301200, &waE2E.Message{})}, // no body -> skip
			{Message: nil}, // nil -> skip
		},
	}
	rows, skipped := RowsFromHistoryConversation(ownJID, conv)
	if len(rows) != 2 || skipped != 2 {
		t.Fatalf("want 2 rows / 2 skipped, got %d / %d", len(rows), skipped)
	}
	for _, r := range rows {
		if r.ThreadTitle != "Alex Peer" || r.ChatJID != peerJID.String() || r.Source != "history_sync" {
			t.Fatalf("row metadata wrong: %+v", r)
		}
	}
	if rows[0].Direction != "in" || rows[1].Direction != "out" {
		t.Fatalf("directions wrong: %q %q", rows[0].Direction, rows[1].Direction)
	}

	// Unparseable conversation ID: nothing, quietly.
	bad := &waHistorySync.Conversation{ID: proto.String("")}
	rows, skipped = RowsFromHistoryConversation(ownJID, bad)
	if rows != nil || skipped != 0 {
		t.Fatalf("bad conversation must yield nothing, got %d/%d", len(rows), skipped)
	}
}
