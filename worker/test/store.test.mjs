import {
  backendOf, chunkGeometry, chunkText, estimateD1IngestStatements, storeFor,
  CHUNK_SIZE, D1, D1_INGEST_STATEMENT_BUDGET, SUPABASE,
} from "../src/lib/store.js";
import { sanitizeEnvelope } from "../src/lib/secret-scan.js";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* ---- backend selection: explicit wins, inference is a fallback ---- */
check("explicit d1 wins", backendOf({ STORAGE: "d1", SUPABASE_URL: "x" }) === D1);
check("explicit supabase wins", backendOf({ STORAGE: "supabase", VECTORIZE: {} }) === SUPABASE);
check("case insensitive", backendOf({ STORAGE: "D1" }) === D1);
check("vectorize and no supabase infers d1", backendOf({ VECTORIZE: {} }) === D1);
check("supabase creds infer supabase", backendOf({ SUPABASE_URL: "x" }) === SUPABASE);
check("a nonsense value does not silently pick d1", backendOf({ STORAGE: "mongo", SUPABASE_URL: "x" }) === SUPABASE);

/* ---- chunking: geometry must match the Drive indexer ---- */
{
  const body = "x".repeat(5000);
  const c = chunkText(body);
  check("chunks are capped at the embedding-safe window", c.every(p => p.length <= CHUNK_SIZE), String(Math.max(...c.map(p=>p.length))));
  // The properties that matter are coverage and overlap, not chunk count.
  // Nothing may fall between two windows, and consecutive windows must share
  // text or a sentence spanning a boundary is retrievable from neither.
  const body2 = Array.from({length: 5000}, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const c2 = chunkText(body2);
  check("every character is covered", c2.join("").length >= body2.length, `${c2.join("").length} vs ${body2.length}`);
  check("the last chunk reaches the end", body2.endsWith(c2[c2.length-1].slice(-50)));
  const shares = c2.length < 2 || c2.slice(1).every((piece, i) => {
    const tail = c2[i].slice(-200);
    return piece.includes(tail.slice(0, 100));
  });
  check("consecutive chunks overlap", shares);
  check("empty text yields nothing", chunkText("").length === 0);
  check("whitespace only yields nothing", chunkText("   \n  ").length === 0);
  check("short text is one chunk", chunkText("hello there").length === 1);

  // The header must be on EVERY chunk, not just the first. A fragment that says
  // only "we agreed to defer it" is useless without knowing what "it" was.
  const withH = chunkText(body, { header: "[Q3 Strategy]" });
  check("header rides every chunk", withH.every(p => p.startsWith("[Q3 Strategy]")), String(withH.filter(p=>!p.startsWith("[")).length));

  // A pathological window must not loop forever.
  check("overlap >= size does not hang", chunkText("abcdefghij", { size: 4, overlap: 9 }).length > 0);

  check("the default body stays below the diagnostic truncation threshold", CHUNK_SIZE < 1800, String(CHUNK_SIZE));
  check("per-install chunk geometry is honored", JSON.stringify(chunkGeometry({ CHUNK_SIZE: "1200", CHUNK_OVERLAP: "240" })) === JSON.stringify({ size: 1200, overlap: 240 }));
  check("unsafe manifest geometry is clamped", JSON.stringify(chunkGeometry({ CHUNK_SIZE: "9000", CHUNK_OVERLAP: "9000" })) === JSON.stringify({ size: 1800, overlap: 1799 }));
}

/* ---- D1 request budgeting happens before the first database statement ---- */
{
  const messages = Array.from({ length: 50 }, (_, index) => ({
    source_type: "message", source_id: `m-${index}`, content: "ordinary one-chunk message",
  }));
  const messageEstimate = estimateD1IngestStatements({}, messages);
  check("the conservative budget preserves the 50-message replay shape",
    messageEstimate === 550 && messageEstimate <= D1_INGEST_STATEMENT_BUDGET,
    `${messageEstimate}/${D1_INGEST_STATEMENT_BUDGET}`);
  const wideEstimate = estimateD1IngestStatements({}, [{ content: "x".repeat(900_000) }]);
  check("a byte-valid 900KB document exceeds the pre-write statement budget",
    wideEstimate > D1_INGEST_STATEMENT_BUDGET, `${wideEstimate}/${D1_INGEST_STATEMENT_BUDGET}`);
  const pathological = estimateD1IngestStatements(
    { CHUNK_SIZE: "1800", CHUNK_OVERLAP: "1799" },
    [{ content: "x".repeat(5_000) }],
  );
  check("the budget uses deployed chunk geometry rather than default assumptions",
    pathological > D1_INGEST_STATEMENT_BUDGET, String(pathological));
}

/* ---- the D1 backend honours the shape contract ---- */
{
  const env = {
    STORAGE: "d1",
    VECTORIZE: { query: async () => ({ matches: [] }) },
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
      { chunk_uid: "curated:x#0", doc_uid: "curated:x", source_id: "x", text: "body", source: "curated", title: "T", document_date: 1750000000000 },
    ] }), first: async () => null, run: async () => ({}) }) }), batch: async () => {} },
  };
  const s = storeFor(env);
  const r = await s.search(env, { query: "hello", limit: 5 });
  const hit = r.results[0];
  check("search returns the contract shape",
    hit && "chunk_uid" in hit && "source" in hit && "title" in hit && "snippet" in hit && "ts" in hit,
    JSON.stringify(hit));
  check("the public ref is document-stable", hit.ref_key === "x" && hit.chunk_uid === "curated:x#0", JSON.stringify(hit));
  check("ts is an ISO document date, not an mtime", typeof hit.ts === "string" && hit.ts.startsWith("2025-"), String(hit.ts));
}

/* ---- a null document date must survive as null, never as "now" ---- */
{
  const env = {
    STORAGE: "d1",
    VECTORIZE: { query: async () => ({ matches: [] }) },
    AI: { run: async () => ({ data: [[0.1]] }) },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
      { chunk_uid: "a#0", text: "t", source: "drive", title: null, document_date: null },
    ] }) }) }) },
  };
  const r = await storeFor(env).search(env, { query: "q", limit: 5 });
  check("undated stays null", r.results[0].ts === null, String(r.results[0].ts));
}

/* ---- the public D1 rrf_k control must reach the fusion arithmetic ---- */
{
  const keyword = [
    { chunk_uid: "c", doc_uid: "c", source_id: "c", text: "c", source: "drive" },
    { chunk_uid: "d", doc_uid: "d", source_id: "d", text: "d", source: "drive" },
  ];
  const vectors = [
    { chunk_uid: "a", doc_uid: "a", source_id: "a", text: "a", source: "drive" },
    { chunk_uid: "b", doc_uid: "b", source_id: "b", text: "b", source: "drive" },
    keyword[0],
  ];
  const env = {
    STORAGE: "d1",
    AI: { run: async () => ({ data: [[0.1]] }) },
    VECTORIZE: { query: async () => ({ matches: vectors.map((row) => ({ id: row.chunk_uid })) }) },
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? keyword
              : ids.map((id) => vectors.find((row) => row.chunk_uid === id)).filter(Boolean),
          }),
        }),
      }),
    },
  };
  const r = await storeFor(env).search(env, { query: "c", limit: 10, rrfK: 1 });
  const c = r.results.find((row) => row.chunk_uid === "c");
  check("D1 honors rrf_k instead of silently using its default",
    Math.abs(c.score - (1 / 4 + 1 / 2)) < 1e-9,
    String(c.score));
}

/* ---- a failed revision cannot commit its hash before its chunks ---- */
{
  const rows = { document: null, chunks: new Map() };
  let failAfterDocumentWrite = true;
  let documentWrites = 0;
  let batches = 0;

  const execute = (sql, binds) => {
    let changes = 0;
    if (/INSERT INTO documents/i.test(sql)) {
      documentWrites++;
      const incoming = {
        doc_uid: binds[0], source: binds[1], source_id: binds[2], title: binds[3],
        uri: binds[4], document_date: binds[5], date_source: binds[6],
        date_reliable: binds[7], client: binds[8], category: binds[9],
        top_folder: binds[10], platform: binds[11], ingested_at: binds[12],
        content_hash: binds[13], meta: binds[14],
      };
      rows.document = rows.document
        ? { ...rows.document, ...incoming }
        : incoming;
      changes = 1;
    } else if (/UPDATE documents SET content_hash/i.test(sql)) {
      if (rows.document?.content_hash === binds[2]) {
        rows.document.content_hash = binds[1];
        changes = 1;
      }
    } else if (/DELETE FROM chunks WHERE doc_uid/i.test(sql)) {
      for (const [uid, chunk] of rows.chunks) if (chunk.doc_uid === binds[0]) rows.chunks.delete(uid);
    } else if (/INSERT INTO chunks/i.test(sql)) {
      rows.chunks.set(binds[0], { chunk_uid: binds[0], doc_uid: binds[1], text: binds[3] });
      changes = 1;
    } else if (/INSERT INTO corpus_stats/i.test(sql)) {
      const candidates = JSON.parse(binds[1] || "[]");
      changes = candidates.some(([docUid, marker]) =>
        rows.document?.doc_uid === docUid &&
        rows.document?.source === binds[0] &&
        rows.document?.content_hash === marker
      ) ? 1 : 0;
    }
    return { changes };
  };

  const env = {
    STORAGE: "d1",
    VECTORIZE: { deleteByIds: async () => {} },
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              sql, binds,
              first: async () => {
                if (/SELECT content_hash/i.test(sql)) return rows.document ? { ...rows.document } : null;
                if (/SELECT client, category/i.test(sql)) return rows.document ? { ...rows.document } : null;
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => {
                const result = execute(sql, binds);
                return { success: true, meta: { changes: result.changes } };
              },
            };
          },
        };
      },
      async batch(statements) {
        if (statements.every((statement) => /SELECT content_hash/i.test(statement.sql))) {
          return statements.map(() => ({ results: rows.document ? [{ ...rows.document }] : [] }));
        }
        batches++;
        if (failAfterDocumentWrite) {
          failAfterDocumentWrite = false;
          throw new Error("simulated failure after document row write");
        }
        return statements.map((statement) => {
          const result = execute(statement.sql, statement.binds);
          return { success: true, meta: { changes: result.changes } };
        });
      },
    },
  };

  const envelope = {
    source_type: "drive", source_id: "retry-file", title: "Retry file",
    content: "A complete document body that must be rebuilt after an interrupted write.",
    metadata: { platform: "drive" },
  };
  let firstError = null;
  try {
    await storeFor(env).ingest(env, envelope);
  } catch (error) {
    firstError = error;
  }
  check("the simulated write fails only after the document row exists",
    /simulated failure/.test(firstError?.message || "") && documentWrites === 1 && rows.document !== null,
    `${firstError?.message || "no error"}; writes=${documentWrites}`);
  check("an interrupted revision retains a non-committed hash",
    rows.document.content_hash.startsWith("pending:") && rows.chunks.size === 0,
    `${rows.document.content_hash}; chunks=${rows.chunks.size}`);

  const repaired = await storeFor(env).ingest(env, envelope);
  check("retry repairs chunks instead of returning unchanged",
    repaired.action !== "unchanged" && repaired.chunks > 0 && rows.chunks.size === repaired.chunks,
    `${JSON.stringify(repaired)}; stored=${rows.chunks.size}`);
  check("the real content hash commits only after repair completes",
    /^[a-f0-9]{64}$/.test(rows.document.content_hash), rows.document.content_hash);

  const batchesAfterRepair = batches;
  const stable = await storeFor(env).ingest(env, envelope);
  check("a fully committed retry becomes unchanged normally",
    stable.action === "unchanged" && batches === batchesAfterRepair, JSON.stringify(stable));

  failAfterDocumentWrite = true;
  const renamed = { ...envelope, title: "Renamed retry file" };
  let renameError = null;
  try {
    await storeFor(env).ingest(env, renamed);
  } catch (error) {
    renameError = error;
  }
  check("a failed metadata-only revision also clears the commit marker",
    /simulated failure/.test(renameError?.message || "") && rows.document.content_hash.startsWith("pending:"),
    `${renameError?.message || "no error"}; ${rows.document.content_hash}`);
  const renamedRepair = await storeFor(env).ingest(env, renamed);
  check("retry rebuilds title-bearing chunks after a metadata-only failure",
    renamedRepair.action === "updated" && [...rows.chunks.values()].every((chunk) => chunk.text.startsWith("[Renamed retry file]")),
    JSON.stringify(renamedRepair));

  const paymentToken = "Jk7Wp4".repeat(8);
  const invoiceUrl = `https://invoice.stripe.com/i/acct_fixture123/live_${paymentToken}?s=em`;
  const portalUrl = `https://billing.stripe.com/p/session/live_${paymentToken}`;
  const checkoutUrl = `https://checkout.stripe.com/c/pay/cs_live_${paymentToken}#fidfixture`;
  rows.document.uri = invoiceUrl;
  rows.document.document_date = Date.parse("2026-08-01T00:00:00Z");
  rows.document.date_source = portalUrl;
  rows.document.date_reliable = 1;
  rows.document.meta = JSON.stringify({
    keep: "billing context",
    nested: { [checkoutUrl]: "private key", link: invoiceUrl },
  });

  const sanitizedRevision = sanitizeEnvelope({
    ...renamed,
    uri: invoiceUrl,
    date_source: portalUrl,
    date_reliable: false,
    metadata: {
      platform: "drive",
      keep: "billing context",
      nested: { [checkoutUrl]: "private key", link: invoiceUrl },
    },
  });
  const backend = storeFor(env);
  const [safetyPreflight] = await backend.preflightIngestBatch(env, [sanitizedRevision]);
  check("D1 preflight rejects unchanged when URI, date source, or full metadata need sanitization",
    safetyPreflight.unchanged === false, JSON.stringify(safetyPreflight));
  const safetyRepair = await backend.ingest(env, sanitizedRevision, { prepared: safetyPreflight.prepared });
  const durableSafetyFields = JSON.stringify({
    uri: rows.document.uri,
    date_source: rows.document.date_source,
    meta: rows.document.meta,
  });
  check("same-content v4 ingest rewrites old sensitive URI and arbitrary metadata",
    safetyRepair.action === "updated" && !durableSafetyFields.includes(paymentToken), durableSafetyFields);
  check("v4 rewrite preserves useful metadata while sanitizing nested values and keys",
    durableSafetyFields.includes("billing context") &&
      durableSafetyFields.includes("[REDACTED:sensitive_payment_url]") &&
      !durableSafetyFields.includes("invoice.stripe.com") &&
      !durableSafetyFields.includes("checkout.stripe.com"), durableSafetyFields);
}

/* ---- completion inventory must recount live documents, not trust its cache ---- */
{
  let statsSql = "";
  const env = {
    STORAGE: "d1",
    DB: {
      prepare(sql) {
        statsSql = sql;
        return { all: async () => ({ results: [{
          source_type: "message",
          stored_documents: 7,
          logical_documents: 6,
          total: 12,
          embedded: 12,
          last_ingest_at: 1750000000000,
        }] }) };
      },
    },
  };
  const inventory = await storeFor(env).stats(env);
  const row = inventory.rows[0];
  check("D1 inventory discovers live-document sources even when corpus_stats is absent",
    /SELECT source FROM documents WHERE deleted_at IS NULL/.test(statsSql), statsSql);
  check("D1 inventory derives physical and logical counts from live documents",
    /COUNT\(\*\) AS stored_documents/.test(statsSql) && /GROUP BY source/.test(statsSql) &&
      row.stored_documents === 7 && row.logical_documents === 6 && row.document_counts_exact === true,
    JSON.stringify(row));
}

console.log(fail ? `\n${fail} FAILURES` : `\nstore: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
