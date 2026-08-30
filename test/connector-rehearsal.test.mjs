// test/connector-rehearsal.test.mjs
//
// The end-to-end connector rehearsal required by the Wave 0 execution plan,
// section 5 ("verification protocol"), item 4:
//
//   "The end-to-end rehearsal must pass: a fresh synthetic manifest, connect
//   Drive plus Gmail plus Calendar, load the WhatsApp and SMS fixtures plus
//   one fixture bank statement (native and scanned), then `brain eval
//   --golden-20` style questions covering each new source, each returning a
//   cited answer, including at least one answered from the structured
//   ledger (WP-14) rather than from text retrieval. Script it as
//   test/connector-rehearsal.test.mjs or a documented manual runbook."
//
// WHAT THIS FILE ACTUALLY PROVES, AND HOW, READ THIS BEFORE TRUSTING A PASS:
//
// Scope. Wave 0 shipped Drive, Gmail (connector code only, never run live —
// see evidence/WP-01.md), Calendar, the WhatsApp export parser (WP-02), and
// the SMS Backup & Restore / Google Voice Takeout parsers (WP-03), OCR, and
// the structured financial ledger. OCR is exercised here. Bank exports have a
// separate deterministic file-to-ledger test, but no scanned-statement-to-rows
// extractor exists, and this rehearsal has no ledger-backed answer route. It
// marks both acceptance steps NOT DONE for those precise reasons instead of
// claiming the ledger itself is absent. Search this file for "N/A" to find
// every such marker.
//
// No live OAuth. Nothing here performs an interactive Google consent flow —
// that needs a real browser and a human, which is why WP-01's own evidence
// file says every Gmail command was prepared, never executed. Each connector
// is instead driven through its OWN real, exported functions (syncAll for
// Calendar, toEnvelope for Drive and Gmail) against a scripted HTTP
// transport, exactly the pattern test/calendar-ingest.test.mjs,
// test/google-drive.test.mjs and the gm.toEnvelope block inside that same
// file already use to test these connectors offline. This proves the
// connector code genuinely runs end to end on realistic API responses; it
// does not prove a real Google account will hand back exactly this shape,
// which is what a live run (WP-01's own commands, run by a human) is for.
//
// "Cited answer" without a deployed brain. The plan's acceptance criterion
// is a real Cloudflare account running a real deployed brain with real
// Vectorize embeddings and a real LLM call, which this environment cannot
// stand up (no live Cloudflare credentials, same constraint every other
// Wave 0 evidence file names). Rather than skip the requirement, this file
// drives the REAL worker route handler (worker/src/index.js, in-process,
// zero network) with D1, Vectorize and Workers AI scripted at the boundary
// -- the exact same class of fakery worker/test/routes.test.mjs already uses
// to test this same route on every other change to this codebase. Be
// precise about what that does and does not prove:
//   - PROVEN: the real ingest code for each source turns a realistic input
//     into a correctly-shaped, correctly-tagged document; those documents,
//     loaded together into one D1-shaped corpus, are stored and hydrated
//     distinguishably (the right content comes back for the right question,
//     never a neighboring source's content); the real retrieval route
//     (auth, D1 hydration, evidence gate, citation numbering) operates
//     correctly end to end on that corpus and returns a citation that
//     traces back to the real ingested content, not a hardcoded fixture
//     string.
//   - NOT PROVEN: real embedding-based semantic relevance (VECTORIZE.query
//     is scripted to return exactly the intended match, not a genuine
//     nearest-neighbor search) and real LLM answer quality (Workers AI's
//     response is a scripted string, not a live model call). Those two are
//     exactly what a live deployed brain would add, and this file cannot
//     substitute for that -- it proves the pipeline's plumbing is coherent,
//     not that a real embedding model will rank these documents highly or
//     that a real LLM will phrase a correct answer.
//
// Keyword/FTS search is deliberately not modeled here (see mkCorpusEnv
// below): every chunks_fts query returns zero rows, so every result in this
// file comes from the scripted Vectorize path alone. That keeps each
// question's outcome fully deterministic and traceable to one document.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectSmsBackupXml, parseSmsBackupXml,
  detectGoogleVoiceTakeout, parseGoogleVoiceTakeout,
} from "../ingest/sms-backup.mjs";
import { detectWhatsAppExport, parseWhatsAppExport } from "../ingest/whatsapp-export.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";
import { TOKEN_URL, createTokenProvider, syncAll } from "../connectors/google-calendar.mjs";
import { toEnvelope as driveToEnvelope } from "../connectors/google-drive.mjs";
import { toEnvelope as gmailToEnvelope } from "../connectors/gmail.mjs";
import { cmdIngestCalendar } from "../brain.mjs";
import worker from "../worker/src/index.js";

let fail = 0, ran = 0, na = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };
const notDone = (n, reason) => { na++; console.log("N/A   " + n + "\n      -- " + reason); };

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (...parts) => readFileSync(join(HERE, "fixtures", ...parts), "utf8");

const sandbox = mkdtempSync(join(tmpdir(), "brain-connector-rehearsal-"));

try {
  /* ================================================================ *
   * 1. A fresh synthetic manifest, matching templates/brain.manifest.json's
   *    shape, for a wholly invented client. Written to disk (not just held
   *    in memory) so this is a real manifest a real `brain` command could
   *    load, the same way calendar-ingest.test.mjs writes one to a sandbox.
   * ================================================================ */
  const manifestPath = join(sandbox, "brain.manifest.json");
  const manifestBody = {
    manifest_version: 1,
    client: {
      slug: "acme", display_name: "Acme Consulting",
      primary_contact: "owner@acme-example.test", timezone: "America/Phoenix",
    },
    brain: { version: "0.1.20", domain: "brain.acme-example.test", worker_name: "acme-brain" },
    corpora: {
      google_drive: { enabled: true, root_folder_ids: ["reviewed-root"] },
      gmail: { enabled: true, oauth_secret: "secret://GMAIL_OAUTH" },
      calendar: { enabled: true, oauth_secret: "secret://GCAL_OAUTH" },
      upload: { enabled: true },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifestBody, null, 2) + "\n");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  check("the fresh synthetic manifest round-trips from disk", m.client.slug === "acme", JSON.stringify(m.client));

  /* ================================================================ *
   * 2. Calendar -- the real connector (syncAll), driven through the real
   *    `brain ingest --from calendar` command (cmdIngestCalendar), against
   *    a scripted Google Calendar API. Identical technique to
   *    test/calendar-ingest.test.mjs, which is WP-04's own proof that this
   *    command actually drives the real connector.
   * ================================================================ */
  function mkGoogleRes({ status = 200, body = {} }) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  }
  function fakeGoogleCalendar({ calendar = [] } = {}) {
    let ci = 0;
    return async (url) => {
      if (String(url).startsWith(TOKEN_URL)) return mkGoogleRes({ body: { access_token: "at-cal-1", expires_in: 3600 } });
      const next = calendar[ci];
      ci++;
      if (!next) throw new Error(`unscripted calendar request #${ci}: ${url}`);
      return mkGoogleRes(next);
    };
  }
  const RENEWAL_EVENT = {
    kind: "calendar#event", id: "evt_renewal_terms_01", status: "confirmed",
    summary: "Q4 renewal terms review", updated: "2026-08-20T16:00:00.000Z",
    description: "Confirm the Q4 renewal holds at the current monthly rate before signing, and walk through the updated services list.",
    start: { dateTime: "2026-09-02T14:00:00-07:00", timeZone: "America/Phoenix" },
    end: { dateTime: "2026-09-02T14:30:00-07:00", timeZone: "America/Phoenix" },
    organizer: { email: "owner@acme-example.test", displayName: "Acme Consulting" },
    attendees: [
      { email: "owner@acme-example.test", displayName: "Acme Consulting", self: true, responseStatus: "accepted" },
      { email: "morgan.diaz@acme-example.test", displayName: "Morgan Diaz", responseStatus: "accepted" },
    ],
    iCalUID: "evt_renewal_terms_01@google.com",
  };

  let calendarDoc = null;
  {
    const impl = fakeGoogleCalendar({ calendar: [{ status: 200, body: { nextSyncToken: "TOK_REHEARSAL_1", items: [RENEWAL_EVENT] } }] });
    const provider = createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt", fetchImpl: impl });
    const outcome = await cmdIngestCalendar(m, manifestPath, {}, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      resolveBaseUrl: async () => "https://fixture.invalid",
      resolveAdminKey: () => "fixture-admin-key",
      postSourceReceipt: async () => {},
      applyDriveRemovals: async ({ uids }) => ({ applied: uids.length, pending: 0 }),
      getAccessToken: provider.get,
      fetchImpl: impl,
      googleCalendar: {
        syncAll,
        ingestEnvelopes: async ({ envelopes }) => {
          calendarDoc = envelopes[0] || null;
          return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
        },
      },
    });
    check("connect Calendar: the real syncAll() ran against a scripted Google Calendar API and produced one event to upsert",
      outcome.sent.created === 1 && !!calendarDoc, JSON.stringify(outcome.sent));
    check("the real event content reached the sent envelope under the Calendar receipt namespace",
      /Q4 renewal holds at the current monthly rate/.test(calendarDoc?.content || "") &&
        calendarDoc?.source_type === "calendar",
      JSON.stringify({ source_type: calendarDoc?.source_type, content: calendarDoc?.content }));
  }

  /* ================================================================ *
   * 3. Drive -- the real connector function (toEnvelope), against a
   *    scripted Drive API. Same technique test/google-drive.test.mjs uses
   *    throughout; cmdIngestRemote itself is not exported for injection
   *    (it resolves Google auth and the network directly), so the
   *    connector's own real function is exercised instead, exactly as the
   *    package's existing Drive test suite already does.
   * ================================================================ */
  const driveBytes = (s, status = 200) => ({
    ok: status < 400, status, json: async () => ({}),
    arrayBuffer: async () => new TextEncoder().encode(s).buffer,
  });
  const DRIVE_FILE = {
    id: "drive-rehearsal-01", name: "2026 Client Services Agreement.txt", mimeType: "text/plain", size: "500",
    createdTime: "2026-01-05T00:00:00Z", webViewLink: "https://drive.acme-example.test/drive-rehearsal-01",
  };
  const DRIVE_BODY = "The services agreement renews automatically each January unless either party gives thirty days notice. The current monthly rate is locked through the end of the year.";
  const driveResult = await driveToEnvelope(async () => "at-drive-1", DRIVE_FILE, {}, {
    fetchImpl: async () => driveBytes(DRIVE_BODY), sleep: async () => {},
  });
  check("connect Drive: the real toEnvelope() turned a scripted Drive file into an envelope",
    !!driveResult.envelope, JSON.stringify(driveResult.skip));
  check("the real file content reached the envelope, not a placeholder",
    driveResult.envelope?.content === DRIVE_BODY, driveResult.envelope?.content);
  const driveDoc = driveResult.envelope;

  /* ================================================================ *
   * 4. Gmail -- the real connector function (toEnvelope), against a
   *    scripted transport. Same technique already used for gm.toEnvelope
   *    inside test/google-drive.test.mjs. This proves the connector's OWN
   *    message-to-envelope logic; it does NOT execute a live
   *    `brain connect google --scopes gmail` OAuth consent flow, which
   *    remains unrun this session, exactly as evidence/WP-01.md states.
   * ================================================================ */
  const gmailJson = (body, status = 200) => ({
    ok: status < 400, status, json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  });
  const rawEmail = Buffer.from(
    "From: Priya Nair <priya.nair@acme-example.test>\r\n" +
    "To: owner@acme-example.test\r\n" +
    "Subject: Signed engagement letter\r\n" +
    "Date: Mon, 24 Aug 2026 09:00:00 -0700\r\n\r\n" +
    "Attached is the signed engagement letter. Onboarding starts the third Monday in September."
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const gmailResult = await gmailToEnvelope(async () => "at-gmail-1", "gmail-rehearsal-01", {}, {
    fetchImpl: async () => gmailJson({ raw: rawEmail, internalDate: "1756040400000", threadId: "T-rehearsal", historyId: "H-rehearsal" }),
    sleep: async () => {},
  });
  check("connect Gmail: the real toEnvelope() turned a scripted raw message into an envelope",
    !!gmailResult.envelope, JSON.stringify(gmailResult.skip));
  check("the real message body reached the envelope, not a placeholder",
    /Onboarding starts the third Monday in September/.test(gmailResult.envelope?.content || ""), gmailResult.envelope?.content);
  const gmailDoc = gmailResult.envelope;

  /* ================================================================ *
   * 5. WhatsApp export (WP-02) -- the real parser plus the real
   *    sessionizer, against the package's own existing synthetic fixture
   *    (test/fixtures/whatsapp/ios-unambiguous.txt). Nothing new is
   *    invented here; this is the same fixture test/whatsapp-export.test.mjs
   *    already exercises in detail.
   * ================================================================ */
  const waText = loadFixture("whatsapp", "ios-unambiguous.txt");
  check("the WhatsApp fixture is detected as a real export", detectWhatsAppExport(waText) === true);
  const waParsed = await parseWhatsAppExport(waText, { threadId: "wa-rehearsal", threadTitle: "Alex Rivera" });
  const waSessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const waDocs = [];
  for (const row of waParsed.rows) waDocs.push(...waSessionizer.push(row));
  waDocs.push(...waSessionizer.finish());
  check("load WhatsApp fixtures: the real parser and sessionizer produced document(s)", waDocs.length > 0, String(waDocs.length));
  const waDoc = waDocs.find((d) => /partnership call/i.test(d.content));
  check("the session containing the partnership-call line landed as its own document",
    !!waDoc, JSON.stringify(waDocs.map((d) => d.title)));

  /* ================================================================ *
   * 6. SMS Backup & Restore XML (WP-03) -- the real parser plus the real
   *    sessionizer, against the package's own existing fixture
   *    (test/fixtures/sms-backup/sms-backup-restore.xml).
   * ================================================================ */
  const smsXml = loadFixture("sms-backup", "sms-backup-restore.xml");
  check("the SMS Backup & Restore fixture is detected", detectSmsBackupXml(smsXml) === true);
  const smsParsed = parseSmsBackupXml(smsXml, { sourceLabel: "sms-rehearsal" });
  const smsSessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const smsDocs = [];
  for (const row of smsParsed.rows) smsDocs.push(...smsSessionizer.push(row));
  smsDocs.push(...smsSessionizer.finish());
  check("load SMS fixtures: the real parser and sessionizer produced document(s)", smsDocs.length > 0, String(smsDocs.length));
  const smsInvoiceDoc = smsDocs.find((d) => /Invoice #4521/.test(d.content));
  check("the invoice thread (a different phone number from the WhatsApp fixture's contacts) landed as its own document",
    !!smsInvoiceDoc, JSON.stringify(smsDocs.map((d) => d.title)));

  /* ================================================================ *
   * 7. Google Voice Takeout (WP-03, the second of its two parsers, also
   *    platform `sms`) -- against the package's own existing fixture
   *    (test/fixtures/google-voice/). Distinct content from both the
   *    WhatsApp and SMS-XML fixtures above, so it doubles as a
   *    same-platform distinguishability check: two "sms"-tagged documents
   *    from two different real parsers must never merge.
   * ================================================================ */
  const gvHtml = loadFixture("google-voice", "Jordan Lee - Text - 2024-03-01T09_00_00Z.html");
  check("the Google Voice Takeout fixture is detected", detectGoogleVoiceTakeout(gvHtml) === true);
  const gvParsed = parseGoogleVoiceTakeout(gvHtml, { threadId: "gv-rehearsal", threadTitle: "Jordan Lee" });
  const gvSessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const gvDocs = [];
  for (const row of gvParsed.rows) gvDocs.push(...gvSessionizer.push(row));
  gvDocs.push(...gvSessionizer.finish());
  check("load SMS fixtures (Google Voice half): the real parser and sessionizer produced document(s)", gvDocs.length > 0, String(gvDocs.length));
  const gvDoc = gvDocs.find((d) => /store count/i.test(d.content));
  check("the Google Voice conversation landed as its own document, distinct from the SMS-XML invoice thread",
    !!gvDoc && gvDoc.content !== smsInvoiceDoc?.content, JSON.stringify(gvDocs.map((d) => d.title)));

  /* ================================================================ *
   * 8. One fixture bank statement, scanned. The OCR half of this step is
   *    now real: a synthetic image-only PDF goes through the SHIPPED
   *    extractor with a stubbed model, and comes out as a marked, indexed
   *    document. The model is stubbed because a real one needs a live
   *    Cloudflare account; everything between the PDF bytes and the stored
   *    envelope is production code.
   *
   *    The LEDGER half stays not-done. See the note under it.
   * ================================================================ */
  {
    const { scanPdf, textPdf } = await import("./fixtures/scan-pdf.mjs");
    const { extract } = await import("../ingest/extract.mjs");
    await import("../ingest/formats.mjs");

    const statementPage = [
      "RIVER ROAD COMMUNITY BANK    Statement period 01 Mar to 31 Mar",
      "Account ending 4417          Opening balance 2,410.55",
      "01 Mar  Card purchase HARDWARE SUPPLY   -142.10   2,268.45",
      "04 Mar  Deposit                        1,000.00   3,268.45",
      "09 Mar  Card purchase FUEL               -68.40   3,200.05",
      "18 Mar  Cheque 1042                     -450.00   2,750.05",
      "Closing balance 2,750.05",
    ].join("\n");

    const modelPages = [];
    const stub = Object.assign(async (image, meta) => {
      modelPages.push({ page: meta.page, bytes: image.png_base64.length });
      return { text: statementPage };
    }, { model: "@cf/google/gemma-4-26b-a4b-it", maxPages: 40 });

    const scanned = await extract(scanPdf(), "march-statement.pdf", { ocr: stub });
    check("fixture bank statement, scanned: OCR read it instead of refusing it",
      typeof scanned.text === "string" && !scanned.error, String(scanned.error));
    check("the shipped rasteriser handed the model a real page image, with no native module",
      modelPages.length === 1 && modelPages[0].bytes > 50, JSON.stringify(modelPages));
    check("the transcription is in the document and the figures survived",
      /2,750\.05/.test(scanned.text) && /HARDWARE SUPPLY/.test(scanned.text), scanned.text?.slice(0, 120));
    check("and it is MARKED as OCR, so a citation from it is not mistaken for real text",
      scanned.provenance?.text_source === "ocr" && scanned.provenance?.text_reliable === false,
      JSON.stringify(scanned.provenance));

    /* The control, in the same breath: a text-layer PDF must not be OCR'd. */
    const untouched = [];
    const watchdog = Object.assign(async (image, meta) => {
      untouched.push(meta.page);
      return { text: "should never be called" };
    }, { model: "@cf/x", maxPages: 40 });
    const native = await extract(textPdf(), "notes.pdf", { ocr: watchdog });
    check("a PDF that already has a text layer is never sent to the model",
      untouched.length === 0 && /text layer/.test(native.text || ""), JSON.stringify({ untouched, text: native.text?.slice(0, 80) }));
  }
  notDone(
    "fixture bank statement, native PDF, ingested and answered",
    "WP-14 (the structured financial ledger for EXTRACTED statements) is still Wave 2: there is " +
    "no statement-to-rows extraction pass, so a native-text statement PDF would only get plain " +
    "text retrieval here, which proves nothing WP-14 specific. Measured this build: OCR output " +
    "cannot reach the ledger either -- ingest/bank-export.mjs requires a delimited file with a " +
    "named date column and a sign convention established from the file itself, and it correctly " +
    "refuses OCR prose with 'no column is named as a date'. That refusal is the right behaviour " +
    "and the reason this stays not-done rather than being faked.",
  );

  /* ================================================================ *
   * 9. Build the combined multi-source corpus: every real document
   *    produced above, from all five shipped sources, landing together in
   *    one D1-shaped store the way one client install actually would after
   *    connecting everything in this manifest. Assert basic
   *    distinguishability at the document level BEFORE any retrieval code
   *    runs at all.
   * ================================================================ */
  function toRow(doc, { source, client = null, topFolder = null } = {}) {
    const src = source || doc.source_type;
    const docUid = `${src}:${doc.source_id}`;
    return {
      chunk_uid: `${docUid}#0`,
      doc_uid: docUid,
      text: doc.content,
      source: src,
      source_id: doc.source_id,
      uri: doc.uri || docUid,
      title: doc.title,
      document_date: doc.occurred_at ? Date.parse(doc.occurred_at) : null,
      client,
      category: doc.metadata?.category || src,
      date_reliable: doc.date_reliable === false ? 0 : 1,
      date_source: doc.date_source || "unspecified",
      top_folder: topFolder,
      platform: doc.metadata?.platform || null,
    };
  }

  const CLIENT = "Acme Consulting";
  const rows = [
    toRow(waDoc, { source: "message", client: CLIENT, topFolder: "Messaging" }),
    toRow(smsInvoiceDoc, { source: "message", client: CLIENT, topFolder: "Messaging" }),
    toRow(gvDoc, { source: "message", client: CLIENT, topFolder: "Messaging" }),
    toRow(calendarDoc, { client: CLIENT, topFolder: "Calendar" }),
    toRow(driveDoc, { source: "drive", client: CLIENT, topFolder: "Client Files" }),
    toRow(gmailDoc, { source: "email", client: CLIENT, topFolder: "Email" }),
  ];
  check("every source produced a real document (nothing null slipped through)",
    rows.every((r) => typeof r.text === "string" && r.text.length > 0), JSON.stringify(rows.map((r) => r.source)));
  check("every document has a distinct chunk_uid, so co-loading them cannot collide",
    new Set(rows.map((r) => r.chunk_uid)).size === rows.length, JSON.stringify(rows.map((r) => r.chunk_uid)));
  check("all six documents use the four intended stored namespaces (message x3, calendar, drive, email)",
    new Set(rows.map((r) => r.source)).size === 4 && rows.filter((r) => r.source === "message").length === 3,
    JSON.stringify(rows.map((r) => r.source)));

  /* ================================================================ *
   * 10. golden-20-style questions, one per source, against the REAL
   *     worker route (worker/src/index.js, /api/rag/think), all sharing
   *     ONE fake environment that holds the FULL combined corpus from
   *     step 9. D1 hydration is scripted to genuinely filter by the bound
   *     chunk_uid list (see mkCorpusEnv), so this proves the six documents
   *     coexisting in one store are still returned distinguishably, not
   *     merely that a single-row fixture round-trips.
   * ================================================================ */
  function mkCorpusEnv(corpusRows) {
    const byChunkUid = new Map(corpusRows.map((r) => [r.chunk_uid, r]));
    let vectorMatchIds = [];
    let scriptedAnswer = "";
    let spendReservationId = 0;
    const env = {
      STORAGE: "d1",
      ADMIN_KEY: "k",
      DB: {
        exec: async () => {},
        prepare(sql) {
          const call = { binds: [] };
          return {
            bind(...binds) { call.binds = binds; return this; },
            all: async () => {
              // Keyword/FTS deliberately not modeled -- see the file header.
              if (/chunks_fts/.test(sql)) return { results: [] };
              if (/c\.chunk_uid IN/.test(sql)) {
                const matched = call.binds.filter((v) => byChunkUid.has(v));
                return { results: matched.map((id) => byChunkUid.get(id)) };
              }
              return { results: [] };
            },
            first: async () => {
              if (/INSERT INTO llm_call_log/.test(sql)) return { id: ++spendReservationId };
              if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
                return {
                  schema_version: 12, mutation_id: null, mutation_submitted_at: null,
                  projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                  bootstrap_high_water: null, expected_vectors: corpusRows.length, pending: 0,
                  submitted: 0, oldest_queued_at: null,
                };
              }
              if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql)) {
                return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
              }
              return /count\(\*\)/i.test(sql)
                ? { n: corpusRows.length, stored_documents: corpusRows.length, logical_documents: corpusRows.length }
                : null;
            },
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
        batch: async () => {},
      },
      VECTORIZE: {
        query: async () => ({ matches: vectorMatchIds.map((id) => ({ id })) }),
        upsert: async () => {},
        describe: async () => ({ vectorCount: corpusRows.length, processedUpToMutation: null }),
      },
      AI: {
        run: async (model, input) => model.includes("bge-")
          ? { data: [[0.1, 0.2, 0.3]] }
          : String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "the top-ranked document directly supports the drafted answer" }, usage: { prompt_tokens: 100, completion_tokens: 12 } }
            : { response: scriptedAnswer, usage: { prompt_tokens: 100, completion_tokens: 12 } },
      },
    };
    return {
      env,
      setVectorMatch: (ids) => { vectorMatchIds = Array.isArray(ids) ? ids : [ids]; },
      setScriptedAnswer: (text) => { scriptedAnswer = text; },
    };
  }

  const callRoute = (env, path) => {
    const url = new URL("https://rehearsal.acme-example.test" + path);
    const body = Object.fromEntries(url.searchParams);
    url.search = "";
    return worker.fetch(new Request(url, {
      method: "POST",
      headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env, { waitUntil() {}, passThroughOnException() {} });
  };

  const { env: corpusEnv, setVectorMatch, setScriptedAnswer } = mkCorpusEnv(rows);

  // golden-20 style question set, shaped like eval/golden/TEMPLATE.golden.json's
  // question schema for continuity with how this brain's real acceptance
  // suite is written -- not literally run through `brain eval`, which needs
  // a live deployed brain and a live LLM judge that this environment cannot
  // provide either. This is the closest offline equivalent: the real
  // retrieval/citation route, asked the real question, over real content.
  const GOLDEN_QUESTIONS = [
    {
      id: "cr-01", kind: "single", risk: "normal", domains: ["messaging"], formats: ["whatsapp"],
      question: "What did Alex Rivera ask about, on WhatsApp?",
      row: rows[0], scriptedAnswer: "Alex Rivera asked if you were still on for the partnership call Tuesday [1].",
    },
    {
      id: "cr-02", kind: "single", risk: "normal", domains: ["messaging"], formats: ["sms"],
      question: "Is there an overdue invoice mentioned by text message?",
      row: rows[1], scriptedAnswer: "Yes, invoice #4521 was reported overdue by SMS [1].",
    },
    {
      id: "cr-03", kind: "single", risk: "normal", domains: ["messaging"], formats: ["sms"],
      question: "What did the Google Voice conversation with Jordan Lee mention about Q1?",
      row: rows[2], scriptedAnswer: "Jordan Lee gave a Q1 numbers and store count update [1].",
    },
    {
      id: "cr-04", kind: "single", risk: "critical", domains: ["scheduling"], formats: ["calendar"],
      question: "What is the Q4 renewal terms review meeting about?",
      row: rows[3], scriptedAnswer: "It is to confirm the Q4 renewal holds at the current monthly rate before signing [1].",
    },
    {
      id: "cr-05", kind: "single", risk: "critical", domains: ["contracts"], formats: ["drive"],
      question: "How does the client services agreement renew?",
      row: rows[4], scriptedAnswer: "It renews automatically each January unless either party gives thirty days notice [1].",
    },
    {
      id: "cr-06", kind: "single", risk: "normal", domains: ["correspondence"], formats: ["email"],
      question: "When does onboarding start, per the signed engagement letter email?",
      row: rows[5], scriptedAnswer: "Onboarding starts the third Monday in September [1].",
    },
  ];

  for (const q of GOLDEN_QUESTIONS) {
    setVectorMatch(q.row.chunk_uid);
    setScriptedAnswer(q.scriptedAnswer);
    const res = await callRoute(corpusEnv, `/api/rag/think?q=${encodeURIComponent(q.question)}&limit=5`);
    const body = await res.json();
    check(`[${q.id}] cited answer for "${q.question}" resolves to the real ${q.row.source} document`,
      res.status === 200 &&
      body.citations?.length === 1 &&
      body.citations[0].ref === q.row.source_id &&
      body.citations[0].source === q.row.source &&
      /\[1\]/.test(body.answer || ""),
      JSON.stringify(body));
    check(`[${q.id}] the underlying retrieved snippet is the real ingested content, not a fixture stand-in`,
      body.results?.[0]?.snippet === q.row.text, JSON.stringify(body.results?.[0]));
  }

  /* ================================================================ *
   * 11. Full-corpus distinguishability pass: ONE retrieval call with every
   *     document simultaneously matched by Vectorize, proving that six
   *     co-resident documents from five sources hydrate back as six
   *     distinct results with no cross-source mixing and no duplicates,
   *     via /api/rag/unified (no LLM/evidence-gate involved, so this
   *     isolates the retrieval/hydration layer specifically).
   * ================================================================ */
  {
    // /api/rag/unified returns the store's raw result shape (`ref_key`), not
    // the `/think` route's citation shape (`ref`) -- the rename to `ref`
    // happens only in the /think handler's own `docs` mapping. Both are
    // proven above (section 10 exercised /think's `ref`); this section
    // proves the underlying store-level identity distinctly.
    setVectorMatch(rows.map((r) => r.chunk_uid));
    const res = await callRoute(corpusEnv, "/api/rag/unified?q=Acme+Consulting&limit=10");
    const body = await res.json();
    const gotRefs = (body.results || []).map((r) => `${r.source}:${r.ref_key}`).sort();
    const wantRefs = rows.map((r) => `${r.source}:${r.source_id}`).sort();
    check("all six documents from five sources, loaded together, hydrate back distinguishably with no loss and no duplicates",
      res.status === 200 && JSON.stringify(gotRefs) === JSON.stringify(wantRefs),
      JSON.stringify({ got: gotRefs, want: wantRefs }));
    check("every result's snippet is its own real ingested text (no source's content bled into another's)",
      (body.results || []).every((r) => rows.some((row) => row.source_id === r.ref_key && row.text === r.snippet)),
      JSON.stringify((body.results || []).map((r) => ({ ref_key: r.ref_key, snippet: (r.snippet || "").slice(0, 40) }))));
  }

  /* ================================================================ *
   * 12. "including at least one answered from the structured ledger
   *     (WP-14) rather than from text retrieval" -- NOT DONE.
   * ================================================================ */
  notDone(
    "at least one golden question answered from the structured ledger (WP-14) rather than text retrieval",
    "The fin_* ledger and bank-export import path exist, but this connector rehearsal does not load " +
    "a bank export or call a ledger-backed answer route. Every citation proven above comes from text " +
    "retrieval. Faking a ledger row in this corpus would not prove the file-to-ledger contract; " +
    "test/bank-import-path.test.mjs owns that proof until a real composed answer path is exercised.",
  );

  console.log(
    fail
      ? `\n${fail} FAILURES`
      : `\nconnector-rehearsal: all ${ran} checks passed (${na} step(s) explicitly not done -- see N/A lines above and the file header)`
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
