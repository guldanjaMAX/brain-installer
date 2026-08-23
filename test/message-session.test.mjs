import { emailEnvelope, MessageSessionizer } from "../ingest/message-session.mjs";
import { messageHighWaterSql, messagePageSql, sendMessageEnvelopes } from "../migration/supabase-message-sessions.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  ${String(detail).slice(0, 240)}`}`);
  if (!condition) fail++;
};

const row = (overrides = {}) => ({
  id: "m1", thread_id: "t1", platform: "imessage", thread_title: "Taylor",
  direction: "in", sender_name: "Taylor", category: "message",
  ts: "2026-08-23T10:00:00.000Z", body: "First note", ...overrides,
});

{
  const envelope = emailEnvelope(row({ id: "e1", platform: "email", direction: "out", body: "The proposal is attached." }), { ownerLabel: "James" });
  check("email keeps the original message identity", envelope.source_id === "e1", JSON.stringify(envelope));
  check("email stays one coherent document", /Email thread: Taylor/.test(envelope.content) && /From: James/.test(envelope.content));
  check("email date and thread metadata survive", envelope.date_reliable === true && envelope.metadata.thread_id === "t1");
}

{
  const s = new MessageSessionizer({ ownerLabel: "James" });
  check("the first chat message stays pending across a page", s.push(row()).length === 0);
  check("a nearby reply joins the same pending session", s.push(row({ id: "m2", direction: "out", sender_name: "", ts: "2026-08-23T10:05:00Z", body: "My reply" })).length === 0);
  const [envelope] = s.finish();
  check("one thread becomes one session document", envelope.metadata.message_count === 2, JSON.stringify(envelope));
  check("speaker and direction context become searchable", /Taylor: First note/.test(envelope.content) && /James: My reply/.test(envelope.content));
  check("the session citation is stable at its first message", envelope.source_id === "m1" && envelope.metadata.last_message_id === "m2");
}

{
  const a = new MessageSessionizer({ ownerLabel: "James" });
  a.push(row());
  const snapshot = a.snapshot();
  const b = new MessageSessionizer({ ownerLabel: "James", active: snapshot });
  b.push(row({ id: "m2", ts: "2026-08-23T10:10:00Z", body: "After restart" }));
  const [envelope] = b.finish();
  check("serialized pending state resumes without splitting the session", envelope.metadata.message_count === 2 && /After restart/.test(envelope.content));
}

{
  const s = new MessageSessionizer({ maxGapMs: 60 * 60 * 1000 });
  s.push(row());
  const closed = s.push(row({ id: "m2", ts: "2026-08-23T12:00:00Z", body: "Later" }));
  check("a long gap closes the earlier session", closed.length === 1 && closed[0].metadata.message_count === 1);
  check("the later message starts a new session", s.finish()[0].source_id === "m2");
}

{
  const s = new MessageSessionizer({ maxChars: 12 });
  s.push(row({ body: "12345678" }));
  const closed = s.push(row({ id: "m2", ts: "2026-08-23T10:01:00Z", body: "abcdefgh" }));
  check("the character ceiling closes a session before it grows unsafe", closed.length === 1 && closed[0].metadata.message_count === 1);
}

{
  const s = new MessageSessionizer();
  check("a media marker with no transcript is skipped", s.push(row({ body: "[audio]" })).length === 0 && s.finish().length === 0);
}

{
  const sql = messagePageSql(
    { ts: "2026-01-01T00:00:00Z", id: "00000000-0000-0000-0000-000000000001" },
    { ts: "2026-12-31T00:00:00Z", id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    1000,
    { from: "2026-01-01T00:00:00.000Z" },
  );
  check("message migration is keyset-paginated by the timestamp index", /\(m\.ts, m\.id::text\) >/.test(sql) && /ORDER BY m\.ts, m\.id/.test(sql));
  check("the fixed high-water mark bounds a live source", /\(m\.ts, m\.id::text\) <=/.test(sql) && /ORDER BY m\.ts DESC, m\.id DESC/.test(messageHighWaterSql()));
  check("a recent-first scope is explicit in both source queries", /m\.ts >=/.test(sql) && /m\.ts >=/.test(messageHighWaterSql({ from: "2026-01-01T00:00:00.000Z" })));
  check("sender, direction and thread context are read from the normalized source", /m\.direction/.test(sql) && /sender_name/.test(sql) && /messaging\.threads/.test(sql));
}

{
  const envelope = emailEnvelope(row({ id: "e2", platform: "email", body: "Body" }));
  const receipt = await sendMessageEnvelopes([envelope], async (items) => ({
    results: items.map(() => ({ status: "created", chunks: 2 })),
  }));
  check("message migration accounts for target receipts", receipt.created === 1 && receipt.target_chunks === 2, JSON.stringify(receipt));
}

{
  let posted = 0;
  const envelope = emailEnvelope(row({
    id: "secret-email", platform: "email",
    body: `CLOUDFLARE_API_TOKEN=cfut_${"A".repeat(48)}`,
  }));
  const receipt = await sendMessageEnvelopes([envelope], async () => { posted++; return { results: [] }; });
  check("a credential excludes the whole message before oversized splitting", receipt.refused === 1 && posted === 0, JSON.stringify(receipt));
  check("message refusal reports labels but never the value", receipt.refusals[0].labels.includes("cloudflare_token_new") && !JSON.stringify(receipt).includes("cfut_"));
}

console.log(`\nmessage sessions: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
