// Package capture maps whatsmeow events to outbox rows.
//
// Two shapes arrive from WhatsApp and they are mapped by two separate
// functions on purpose, mirroring how the protocol actually delivers them:
//
//   - RowFromLive: one *events.Message per live message. Sender identity is
//     first-class (Info.Sender), and a push name is usually present.
//   - RowFromHistory: one *waWeb.WebMessageInfo per message inside a
//     history-sync conversation chunk. Sender identity must be
//     reconstructed: own messages from the daemon's own JID, group messages
//     from the message key's participant field, 1:1 messages from the chat
//     JID itself.
//
// Both produce the same Row shape, deduped downstream by (chat, message id).
package capture

import (
	"time"

	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	waHistorySync "go.mau.fi/whatsmeow/proto/waHistorySync"
	waWeb "go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/guldanjaMAX/brain-installer/daemons/whatsapp/internal/outbox"
)

const groupServer = "g.us"

// MessageText extracts a text body from a WhatsApp message payload.
//
// Media arrives as a bracketed marker plus any caption. A caption-less
// marker like "[audio]" is stored as-is; the Node-side sessionizer's
// media-marker filter (isMediaMarkerOnly in ingest/message-session.mjs)
// drops marker-only lines from session documents, so media without text
// degrades to "not captured" rather than noise. There is deliberately no
// audio transcription in this daemon: the reference implementation posted
// audio to a personal transcription service, which is exactly the kind of
// dependency a client build must not carry.
func MessageText(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if msg.GetConversation() != "" {
		return msg.GetConversation()
	}
	if e := msg.GetExtendedTextMessage(); e != nil {
		return e.GetText()
	}
	if i := msg.GetImageMessage(); i != nil {
		return withCaption("[image]", i.GetCaption())
	}
	if v := msg.GetVideoMessage(); v != nil {
		return withCaption("[video]", v.GetCaption())
	}
	if d := msg.GetDocumentMessage(); d != nil {
		title := d.GetTitle()
		if title != "" {
			return withCaption("[document "+title+"]", d.GetCaption())
		}
		return withCaption("[document]", d.GetCaption())
	}
	if msg.GetAudioMessage() != nil {
		return "[audio]"
	}
	return ""
}

func withCaption(marker, caption string) string {
	if caption == "" {
		return marker
	}
	return marker + " " + caption
}

// RowFromLive maps a live message event to an outbox row.
// ok=false means the event carries nothing worth storing (no text body,
// no ID) — not an error, just protocol noise (receipts, reactions, etc.
// arrive as different event types and never reach here anyway).
func RowFromLive(ev *events.Message) (row outbox.Row, ok bool) {
	if ev == nil || ev.Info.ID == "" {
		return outbox.Row{}, false
	}
	body := MessageText(ev.Message)
	if body == "" {
		return outbox.Row{}, false
	}
	if ev.Info.Timestamp.IsZero() {
		return outbox.Row{}, false
	}

	direction := "in"
	if ev.Info.IsFromMe {
		direction = "out"
	}

	senderName := ev.Info.PushName
	if senderName == "" {
		senderName = fallbackLabel(ev.Info.Sender)
	}

	// Thread title: a 1:1 chat is best labeled by the counterparty's push
	// name (only known from their incoming messages). Groups need a
	// separate metadata fetch the capture path deliberately does not do;
	// the drain can enrich titles later without touching capture.
	title := ""
	if !ev.Info.IsGroup && !ev.Info.IsFromMe {
		title = ev.Info.PushName
	}

	return outbox.Row{
		ChatJID:     ev.Info.Chat.String(),
		MessageID:   ev.Info.ID,
		TS:          ev.Info.Timestamp,
		Direction:   direction,
		Body:        body,
		SenderJID:   ev.Info.Sender.String(),
		SenderName:  senderName,
		ThreadTitle: title,
		IsGroup:     ev.Info.IsGroup,
		Source:      "live",
	}, true
}

// RowFromHistory maps one history-sync WebMessageInfo to an outbox row.
// ownJID is the paired device's JID (sender identity for from-me messages).
// threadTitle is the conversation's display name from the history chunk,
// when WhatsApp provided one.
func RowFromHistory(ownJID types.JID, chatJID types.JID, threadTitle string, wmi *waWeb.WebMessageInfo) (row outbox.Row, ok bool) {
	if wmi == nil {
		return outbox.Row{}, false
	}
	key := wmi.GetKey()
	if key == nil || key.GetID() == "" {
		return outbox.Row{}, false
	}
	fromMe := key.GetFromMe()

	var senderJID types.JID
	switch {
	case fromMe:
		if ownJID.IsEmpty() {
			return outbox.Row{}, false
		}
		senderJID = ownJID
	case chatJID.Server == groupServer:
		participant := key.GetParticipant()
		if participant == "" {
			return outbox.Row{}, false
		}
		parsed, err := types.ParseJID(participant)
		if err != nil {
			return outbox.Row{}, false
		}
		senderJID = parsed
	default:
		senderJID = chatJID
	}

	body := MessageText(wmi.GetMessage())
	if body == "" {
		return outbox.Row{}, false
	}
	tsSec := int64(wmi.GetMessageTimestamp())
	if tsSec == 0 {
		return outbox.Row{}, false
	}

	direction := "in"
	if fromMe {
		direction = "out"
	}
	senderName := wmi.GetPushName()
	if senderName == "" {
		senderName = fallbackLabel(senderJID)
	}

	return outbox.Row{
		ChatJID:     chatJID.String(),
		MessageID:   key.GetID(),
		TS:          time.Unix(tsSec, 0).UTC(),
		Direction:   direction,
		Body:        body,
		SenderJID:   senderJID.String(),
		SenderName:  senderName,
		ThreadTitle: threadTitle,
		IsGroup:     chatJID.Server == groupServer,
		Source:      "history_sync",
	}, true
}

// RowsFromHistoryConversation maps every usable message in one history-sync
// conversation. Unusable messages (no key, no body, zero timestamp, stub
// notices) are counted as skipped, matching the reference daemon's
// per-message skip accounting.
func RowsFromHistoryConversation(ownJID types.JID, conv *waHistorySync.Conversation) (rows []outbox.Row, skipped int) {
	if conv == nil || conv.GetID() == "" {
		return nil, 0
	}
	chatJID, err := types.ParseJID(conv.GetID())
	if err != nil {
		return nil, 0
	}
	title := conv.GetName()
	for _, hsmsg := range conv.GetMessages() {
		wmi := hsmsg.GetMessage()
		if wmi == nil {
			skipped++
			continue
		}
		row, ok := RowFromHistory(ownJID, chatJID, title, wmi)
		if !ok {
			skipped++
			continue
		}
		rows = append(rows, row)
	}
	return rows, skipped
}

// fallbackLabel renders a sender JID as a human-usable label when no push
// name is known. For phone-number JIDs this is an E.164-ish "+15551234567";
// for LID or other servers it is the bare user part, which is at least
// stable and greppable.
func fallbackLabel(jid types.JID) string {
	if jid.User == "" {
		return ""
	}
	if jid.Server == types.DefaultUserServer {
		return "+" + jid.User
	}
	return jid.User
}
