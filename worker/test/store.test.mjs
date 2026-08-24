import { backendOf, chunkGeometry, chunkText, storeFor, CHUNK_SIZE, D1, SUPABASE } from "../src/lib/store.js";
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

/* ---- a failed revision cannot commit its hash before its chunks ---- */
{
  const rows = { document: null, chunks: new Map() };
  let failAfterDocumentWrite = true;
  let documentWrites = 0;
  let batches = 0;

  const execute = (sql, binds) => {
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
    } else if (/UPDATE documents SET content_hash/i.test(sql)) {
      rows.document.content_hash = binds[1];
    } else if (/DELETE FROM chunks WHERE doc_uid/i.test(sql)) {
      for (const [uid, chunk] of rows.chunks) if (chunk.doc_uid === binds[0]) rows.chunks.delete(uid);
    } else if (/INSERT INTO chunks/i.test(sql)) {
      rows.chunks.set(binds[0], { chunk_uid: binds[0], doc_uid: binds[1], text: binds[3] });
    }
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
              run: async () => { execute(sql, binds); return {}; },
            };
          },
        };
      },
      async batch(statements) {
        batches++;
        if (failAfterDocumentWrite) {
          failAfterDocumentWrite = false;
          throw new Error("simulated failure after document row write");
        }
        for (const statement of statements) execute(statement.sql, statement.binds);
        return [];
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
}

console.log(fail ? `\n${fail} FAILURES` : `\nstore: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
