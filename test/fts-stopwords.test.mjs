// FTS keyword search drops stopwords before they reach FTS5.
//
// Measured on a 900,000 chunk corpus with this exact schema:
//   selective single term                 0.2 ms
//   a question OR'd as-is             2,034 ms
//   the same question, stopwords gone 1,046 ms
//
// The cost is structural. Each term is a posting list to walk, and a stopword's
// list is most of the corpus, while BM25 scores it at near zero because it
// appears everywhere. So the walk buys no ranking and costs the whole scan.
//
// At the first install's ~1,000 chunks this is invisible, which is exactly why
// it shipped. It grows with the corpus and presents as "retrieval feels slow"
// rather than as a fault, which is the failure shape this product exists to
// avoid.
//
// Run against real SQLite, because the whole thing is a claim about SQL.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchKeyword } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const MIG = fileURLToPath(new URL("../migrations/d1/", import.meta.url));

function corpus(n) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIG, f), "utf-8"));
  const seen = [];
  for (let i = 0; i < n; i++) {
    const d = `d${i}`;
    // Every document contains the stopwords. Only a few contain the real terms.
    const text = i === 7  ? "the depreciation schedule for that entity was agreed with the accountant"
               : i === 21 ? "we did say the entity would hold the vehicle for tax reasons"
               : "the and for with that this our on in to a of is what did we say about";
    db.prepare(`INSERT INTO documents (doc_uid,source,source_id,title,uri,ingested_at,content_hash) VALUES (?,?,?,?,?,?,?)`)
      .run(d, "documents", d, `Doc ${i}`, `/${i}`, 1, `h${i}`);
    db.prepare(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title) VALUES (?,?,?,?,?,?)`)
      .run(`${d}#0`, d, 0, text, "documents", `Doc ${i}`);
    seen.push(d);
  }
  return {
    DB: { prepare(sql) {
      const mk = (p = []) => ({
        bind: (...b) => mk(b),
        all: async () => ({ results: db.prepare(sql).all(...p) }),
        first: async () => db.prepare(sql).get(...p) ?? null,
        run: async () => db.prepare(sql).run(...p),
      });
      return mk();
    } },
    _db: db,
  };
}

const env = corpus(500);

/* ---- the content words still find the right document ---- */
{
  const r = await searchKeyword(env, "what did we say about the depreciation on that entity", { limit: 5 });
  check("a natural-language question still returns results", r.length > 0, JSON.stringify(r.length));
  check("and the document that actually contains the content words ranks first",
    r[0]?.doc_uid === "d7", JSON.stringify(r.slice(0, 3).map((x) => x.doc_uid)));
}

/* ---- a query of ONLY stopwords must not return nothing ---- */
{
  const r = await searchKeyword(env, "what did we say about the", { limit: 5 });
  check("an all-stopword query falls back rather than returning nothing", r.length > 0,
    "it returned zero results, which is worse than being slow");
}

/* ---- the stopwords are genuinely not in the query sent to FTS5 ---- */
{
  const sent = [];
  const spy = {
    DB: { prepare(sql) {
      const mk = (p = []) => ({
        bind: (...b) => { if (/chunks_fts MATCH/.test(sql)) sent.push(b[0]); return mk(b); },
        all: async () => ({ results: [] }), first: async () => null, run: async () => ({}),
      });
      return mk();
    } },
  };
  await searchKeyword(spy, "what did we say about the depreciation on that entity", { limit: 5 });
  const q = sent[0] || "";
  check("stopwords are removed before FTS5 sees them", !/"the"|"what"|"did"|"we"|"about"|"on"|"that"/.test(q), q);
  check("and the content words survive", /"depreciation"/.test(q) && /"entity"/.test(q), q);
  // Assert the PROPERTY, not a magic number. An exact count breaks every time the
  // list is tuned, which invites tuning the code to suit the test.
  const kept = (q.match(/"/g) || []).length / 2;
  check(`the 10-word question becomes materially fewer terms (got ${kept})`, kept <= 4, q);
}

/* ---- words a person might actually search FOR are never dropped ---- */
{
  const sent = [];
  const spy = {
    DB: { prepare(sql) {
      const mk = (p = []) => ({
        bind: (...b) => { if (/chunks_fts MATCH/.test(sql)) sent.push(b[0]); return mk(b); },
        all: async () => ({ results: [] }), first: async () => null, run: async () => ({}),
      });
      return mk();
    } },
  };
  await searchKeyword(spy, "tax account pay cost deposit trust entity car buy sell", { limit: 5 });
  const q = sent[0] || "";
  for (const w of ["tax", "account", "pay", "cost", "deposit", "trust", "entity", "car", "buy", "sell"])
    check(`"${w}" is kept, because someone might be searching for it`, q.includes(`"${w}"`), q);
}

console.log(`\nfts stopwords: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
