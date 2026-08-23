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

console.log(fail ? `\n${fail} FAILURES` : `\nstore: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
