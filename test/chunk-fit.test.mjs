// Chunks that FIT the embedding window, the repair for the ones that never did,
// and an owner-visible number that does not round an unknown up to "fine".
//
// THE DEFECT, as measured rather than described.
//
// The embedding model reads 512 tokens. Everything this product measured was
// counted in CHARACTERS, and the two only agree on ordinary English prose. On a
// real field install 951 of 1,001 chunks were past the ceiling; the head of each
// one embedded, the tail was stored and never searchable by meaning, and every
// count, probe and health check passed while it happened. The diagnostic that
// was supposed to catch it compared `length(text)` to 1,800, which after the
// chunker was capped at 1,500 characters could not fire at all — while a
// 1,500-character chunk of transaction rows, JSON, or Japanese was still 800 to
// 1,500 tokens and still being cut in half.
//
// So the three things below are the three things that were missing:
//   1. chunking that fits the window, measured in the window's own unit;
//   2. a repair for every corpus already loaded under the old behaviour;
//   3. a number an owner can read that says how much of their corpus is whole.
//
// Real SQLite for anything that touches storage. A mock would return whatever
// this file asked it to and prove only that the JavaScript runs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMBED_CONTENT_LIMIT, EMBED_TOKEN_BUDGET, basicTokenFloor, chunkFit, chunkText,
  estimateEmbedTokens,
} from "../worker/src/lib/chunking.js";
import { refitChunks, searchableCoverage } from "../worker/src/lib/store-d1.js";
import { renderSearchability } from "../acceptance.mjs";
import { splitStatements } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const MIG = fileURLToPath(new URL("../migrations/d1/", import.meta.url));

/* ----------------------------------------------------------------- corpora */

// Invented material. Nothing in this repository may carry a real name.
const PROSE =
  "Alex Rivera opened by restating the quarter goal and asked Priya Nair to walk " +
  "the room through the renewal list. We agreed to defer the pricing decision " +
  "until the second week, mostly because the support load has not settled and " +
  "nobody wants to answer a pricing question with a queue that deep. Sam Osei " +
  "will pull the ticket ages and bring them back. Jordan Lee raised the " +
  "onboarding gap again and we all agreed it is the same gap from the last two " +
  "reviews. Morgan Diaz offered to write the summary. ";

// Same shape of business record, none of it prose: identifiers, amounts, dates.
// This is where a character cap and a token cap stop agreeing.
const LEDGER =
  "2026-07-02 | TXN-8841-A3F9 | 4,182.00 | posted | acct 5241 | ref 90218447\n" +
  "2026-07-03 | TXN-8842-B7C1 | 12,904.55 | pending | acct 6195 | ref 90218451\n";

const JAPANESE = "四半期の目標を確認し、更新リストを一緒に見直しました。価格の決定は来週まで先送りします。";

/**
 * Repeat `unit` to `chars`, tagging each repetition so no two stretches of the
 * document are identical. Without the tag a coverage check cannot tell which
 * occurrence of a repeated passage a chunk came from, and would report holes
 * that are not there.
 */
const fill = (unit, chars) => {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${unit}~${i} `;
  return out.slice(0, chars);
};

/* ------------------------------------------------------------------------- */
/* 1. THE MEASUREMENT IS TOKENS, NOT A CHARACTER PROXY                       */
/* ------------------------------------------------------------------------- */

// The discriminating pair. Identical character length by construction, so a
// character threshold is blind to the difference between them. If the product's
// measurement is a proxy for the constraint rather than the constraint, these
// two look the same and one of them is being cut in half.
{
  const CHARS = 1500;
  const prose = fill(PROSE, CHARS);
  const dense = fill(JAPANESE, CHARS);
  check("the discriminating pair is the same length in characters",
    prose.length === dense.length && prose.length === CHARS, `${prose.length} vs ${dense.length}`);

  const proseFloor = basicTokenFloor(prose);
  const denseFloor = basicTokenFloor(dense);
  check("and radically different in tokens, which is the unit that binds",
    denseFloor > proseFloor * 3, `prose ${proseFloor} vs dense ${denseFloor}`);
  check("the dense half is PROVABLY past the model's window at that length",
    denseFloor > EMBED_CONTENT_LIMIT, String(denseFloor));
  check("the prose half is comfortably inside it",
    proseFloor < EMBED_CONTENT_LIMIT, String(proseFloor));

  // The chunker must respond to the difference the character count cannot see.
  const proseChunks = chunkText(prose);
  const denseChunks = chunkText(dense);
  check("so the chunker cuts the dense document into more pieces than the prose one",
    denseChunks.length > proseChunks.length, `${denseChunks.length} vs ${proseChunks.length}`);
}

// The estimate is an estimate and is labelled one everywhere it surfaces. What
// it must never be is BELOW the true count, so it is pinned against a provable
// lower bound rather than against another guess: BERT's BasicTokenizer splits on
// whitespace and isolates punctuation and CJK, and WordPiece only ever expands
// those pieces further, so the floor can never exceed the truth.
{
  const samples = [
    "", " ", "\n\n\t", "a", "the", "onboarding", "internationalisation",
    PROSE, LEDGER, JAPANESE,
    '{"ts":"2026-07-02T14:05:11Z","lvl":"warn","doc":"a3f9-2211","chunks":14}',
    "418000 5241 6195 90218447 12904.55", "!!!???...---___",
    "Ωμέγα ΔΕΛΤΑ кириллица مرحبا नमस्ते 🙂🙂🙂",
    "MiXeD-CaSe_ID.v2/path?query=1&other=2#frag",
  ];
  let violations = 0;
  for (const sample of samples) {
    if (estimateEmbedTokens(sample) < basicTokenFloor(sample)) violations += 1;
  }
  // Random adversarial strings, so this is a property and not a curated pass.
  let seed = 20260828;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = [..."abcdefghijklmnopqrstuvwxyz0123456789 .,;:!?-_/\\'\"()[]{}\n\t四半期の目標ΩΔкм🙂"];
  for (let i = 0; i < 500; i++) {
    const length = 1 + Math.floor(rand() * 400);
    let s = "";
    for (let j = 0; j < length; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    if (estimateEmbedTokens(s) < basicTokenFloor(s)) violations += 1;
  }
  check("the estimate never sits below the provable token floor", violations === 0, `${violations} violation(s)`);
}

// "Truncated" is only ever claimed where it is proven. Being over the budget is
// a judgement made with margin; being over the model's real ceiling by the
// floor alone is a fact.
{
  const proven = chunkFit(fill(JAPANESE, 2000));
  const nearly = chunkFit(fill(PROSE, 1800));
  check("a chunk whose floor clears the ceiling is reported as PROVEN cut",
    proven.truncated === true && proven.floor_tokens > EMBED_CONTENT_LIMIT, JSON.stringify(proven));
  check("a chunk merely over the safety budget is not called proven",
    nearly.over_budget === true && nearly.truncated === false, JSON.stringify(nearly));
}

/* ------------------------------------------------------------------------- */
/* 2. A DOCUMENT LONGER THAN THE WINDOW IS FULLY REACHABLE, NOT HEAD-ONLY    */
/* ------------------------------------------------------------------------- */

for (const [name, unit] of [["prose", PROSE], ["ledger rows", LEDGER], ["japanese", JAPANESE]]) {
  // Long enough to need many windows, in three materials whose token density
  // differs by a factor of five.
  const body = fill(unit, 12_000);
  const header = "[Q3 renewal review]";
  const chunks = chunkText(body, { header });

  const worstFloor = Math.max(...chunks.map(basicTokenFloor));
  const worstEstimate = Math.max(...chunks.map(estimateEmbedTokens));
  check(`${name}: no chunk is past the model's window, provably`,
    worstFloor <= EMBED_CONTENT_LIMIT, `worst floor ${worstFloor} of ${EMBED_CONTENT_LIMIT}`);
  // The header is embedded with every chunk, so it spends the same budget the
  // body does. Adding it AFTER the slice is what turned a "1,500 character"
  // chunk into a 1,521 character embed.
  check(`${name}: the header is inside the budget, not added on top of it`,
    worstEstimate <= EMBED_TOKEN_BUDGET, `worst estimate ${worstEstimate} of ${EMBED_TOKEN_BUDGET}`);
  check(`${name}: every chunk still carries the document's identity`,
    chunks.every((c) => c.startsWith(header)), String(chunks.filter((c) => !c.startsWith(header)).length));

  // Coverage: the point of fitting the window is that the WHOLE document is
  // reachable, not that the pieces are small. Nothing may fall between two
  // windows, or a sentence that spans the boundary is retrievable from neither.
  const stripped = chunks.map((c) => c.slice(header.length + 2));
  let reach = 0;
  let from = 0;
  let gap = null;
  for (const piece of stripped) {
    const at = body.indexOf(piece, from);
    if (at < 0) { gap = "a chunk is not a slice of the document"; break; }
    // Windows are emitted in order and overlap, so each must start at or before
    // the point the previous one reached. Anything else is a hole.
    if (at > reach && body.slice(reach, at).trim() !== "") { gap = `hole at ${reach}..${at}`; break; }
    reach = Math.max(reach, at + piece.length);
    from = at;
  }
  check(`${name}: the windows cover the document end to end`,
    gap === null && reach === body.length, gap || `${reach} of ${body.length}`);

  // And the specific failure this closes: the TAIL. Under the old cut the end
  // of a dense document sat past the model's ceiling inside its chunk, so it
  // was stored, keyword-findable, and invisible to meaning-based search.
  const tailMarker = body.slice(-60);
  const holder = chunks.find((c) => c.includes(tailMarker));
  check(`${name}: the end of the document lands in a chunk the model can read whole`,
    Boolean(holder) && basicTokenFloor(holder) <= EMBED_CONTENT_LIMIT,
    holder ? String(basicTokenFloor(holder)) : "no chunk holds the tail");
}

/* ------------------------------------------------------------------------- */
/* 3. STORAGE, THE REPAIR, AND THE OWNER-VISIBLE NUMBER                      */
/* ------------------------------------------------------------------------- */

/** A D1-shaped facade over real SQLite, including batch(). */
function makeEnv(extra = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIG, f), "utf-8"))) db.exec(statement);
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 17, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();
  const prepare = (sql) => {
    const mk = (params = []) => ({
      _sql: sql,
      _params: params,
      bind: (...p) => mk(p),
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes || 0) } };
      },
    });
    return mk();
  };
  return {
    _db: db,
    DB: {
      prepare,
      batch: async (statements) => {
        const out = [];
        for (const st of statements) out.push(await st.run());
        return out;
      },
    },
    ...extra,
  };
}

const seedDoc = (db, docUid, { title = "Renewal review", hash = null } = {}) =>
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, uri, document_date, ingested_at, content_hash)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(docUid, "documents", docUid, title, `/${docUid}.md`, Date.now(), Date.now(), hash || `h-${docUid}`);

/** Written the way a corpus loaded before this version was: no token count. */
const seedLegacyChunk = (db, docUid, ix, text, title = "Renewal review") =>
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title) VALUES (?,?,?,?,?,?)`
  ).run(`${docUid}#${ix}`, docUid, ix, text, "documents", title);

/** Written the way the current worker writes: the token count is recorded. */
const seedChunk = (db, docUid, ix, text, title = "Renewal review") =>
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, embed_tokens) VALUES (?,?,?,?,?,?,?)`
  ).run(`${docUid}#${ix}`, docUid, ix, text, "documents", title, estimateEmbedTokens(text));

const legacyBody = (title, unit, chars) => `[${title}]\n\n${fill(unit, chars)}`;

/* ---- the owner-visible figure, on a MIXED corpus ---- */
{
  const env = makeEnv();
  const db = env._db;
  // Four fitting, three cut, three never measured. Nothing about this corpus is
  // uniform, which is the only interesting case: a figure that is only honest
  // on an all-good or all-bad corpus is not a figure.
  seedDoc(db, "good");
  for (let i = 0; i < 4; i++) seedChunk(db, "good", i, `[Renewal review]\n\n${fill(PROSE, 900)}`);
  seedDoc(db, "cut");
  for (let i = 0; i < 3; i++) seedChunk(db, "cut", i, legacyBody("Renewal review", JAPANESE, 2000));
  seedDoc(db, "old");
  for (let i = 0; i < 3; i++) seedLegacyChunk(db, "old", i, legacyBody("Renewal review", PROSE, 900));

  const coverage = await searchableCoverage(env);
  check("the three states are counted separately",
    coverage.chunks === 10 && coverage.fitting === 4 && coverage.over_budget === 3 &&
      coverage.unmeasured === 3, JSON.stringify(coverage));
  // The unknown is never rounded up into the good half. This percentage is a
  // FLOOR, and the room above it is reported alongside it.
  check("the headline percentage is a floor, and the unknown is stated beside it",
    coverage.fully_searchable_pct === 40 && coverage.unmeasured_pct === 30,
    JSON.stringify({ pct: coverage.fully_searchable_pct, unknown: coverage.unmeasured_pct }));
  check("and the cut chunks are PROVEN cut, not merely estimated",
    coverage.proven_truncated === 3 && coverage.proof_sample === 3, JSON.stringify(coverage));

  const sentence = renderSearchability(coverage);
  check("the owner sentence says the number is estimated", /estimated/.test(sentence), sentence);
  check("and names the consequence rather than the metric",
    /found by keyword and never by meaning/.test(sentence), sentence);
  check("and refuses to fold the unmeasured part into the good half",
    /never been measured/.test(sentence) && !/^100%/.test(sentence), sentence);
  check("and never claims a corpus with cut chunks is whole",
    !/^at least 100%/.test(sentence), sentence);
}

/* ---- an entirely unmeasured corpus reads as UNKNOWN, never as healthy ---- */
{
  const env = makeEnv();
  seedDoc(env._db, "old");
  for (let i = 0; i < 5; i++) seedLegacyChunk(env._db, "old", i, legacyBody("Renewal review", PROSE, 900));
  const coverage = await searchableCoverage(env);
  const sentence = renderSearchability(coverage);
  check("a corpus loaded before this version reports UNKNOWN",
    /UNKNOWN/.test(sentence) && /Unknown is not the same as fine/.test(sentence), sentence);
}

/* ---- the repair: a legacy corpus becomes fully reachable ---- */
{
  const env = makeEnv();
  const db = env._db;
  seedDoc(db, "ledger");
  // Exactly the field shape: chunks written under the old 2,000-character
  // geometry, dense enough that the model read roughly the first third.
  for (let i = 0; i < 4; i++) seedLegacyChunk(db, "ledger", i, legacyBody("Renewal review", LEDGER, 2000));
  const before = await searchableCoverage(env);
  const beforeText = [...Array(4)].map((_, i) =>
    db.prepare("SELECT text FROM chunks WHERE chunk_uid = ?").get(`ledger#${i}`).text).join("");

  const dry = await refitChunks(env, { dryRun: true });
  const afterDryRun = db.prepare("SELECT count(*) n FROM chunks").get().n;
  check("dry run is the DEFAULT and writes nothing",
    dry.dry_run === true && afterDryRun === 4 &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0, JSON.stringify(dry));
  check("and it still reports what is wrong", dry.coverage.unmeasured === 4, JSON.stringify(dry.coverage));

  const done = await refitChunks(env, { dryRun: false });
  check("armed, it repairs the document", done.documents_refitted === 1, JSON.stringify(done));
  check("and the walk reports itself finished", done.complete === true, JSON.stringify(done));

  const rows = db.prepare("SELECT chunk_uid, chunk_ix, text, embed_tokens FROM chunks ORDER BY chunk_ix").all();
  check("the repair produced more pieces than it started with",
    rows.length > 4 && done.chunks_added === rows.length - 4, `${rows.length} rows, added ${done.chunks_added}`);
  check("every repaired piece is inside the model's window, provably",
    rows.every((r) => basicTokenFloor(r.text) <= EMBED_CONTENT_LIMIT),
    String(Math.max(...rows.map((r) => basicTokenFloor(r.text)))));
  check("and every piece now carries its measurement",
    rows.every((r) => Number.isInteger(r.embed_tokens) && r.embed_tokens <= EMBED_TOKEN_BUDGET));

  // NOTHING MAY BE LOST. The repair works from stored text with no access to
  // the original file, so a boundary bug here destroys the only copy.
  const header = "[Renewal review]\n\n";
  const afterText = rows.map((r) => r.text.startsWith(header) ? r.text.slice(header.length) : r.text).join("");
  const beforeStripped = beforeText.split(header).join("");
  check("no text was lost in the split", afterText === beforeStripped,
    `${afterText.length} vs ${beforeStripped.length}`);
  check("and the chunk indexes are contiguous from zero",
    rows.every((r, i) => r.chunk_ix === i && r.chunk_uid === `ledger#${i}`));

  const queued = db.prepare("SELECT count(*) n FROM vector_outbox WHERE op = 'upsert'").get().n;
  check("every repaired piece is queued for embedding", queued === rows.length, String(queued));

  const after = await searchableCoverage(env);
  check("the owner-visible figure moves from unknown to whole",
    before.fully_searchable_pct === 0 && before.unmeasured === 4 &&
      after.fully_searchable_pct === 100 && after.unmeasured === 0 && after.over_budget === 0,
    JSON.stringify({ before, after }));

  // Idempotent: a second pass finds nothing to do and queues no further work.
  db.prepare("DELETE FROM vector_outbox").run();
  const again = await refitChunks(env, { dryRun: false, restart: true });
  check("a second run repairs nothing and queues nothing",
    again.documents_refitted === 0 && again.documents_examined === 0 &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0, JSON.stringify(again));
}

/* ---- a healthy corpus is MEASURED, never silently re-embedded ---- */
{
  const env = makeEnv();
  const db = env._db;
  for (const id of ["a", "b", "c"]) {
    seedDoc(db, id);
    for (let i = 0; i < 3; i++) seedLegacyChunk(db, id, i, legacyBody("Renewal review", PROSE, 700));
  }
  const textBefore = db.prepare("SELECT group_concat(text) g FROM chunks").get().g;
  const done = await refitChunks(env, { dryRun: false });
  check("chunks that already fit are measured, not rewritten",
    done.documents_measured === 3 && done.documents_refitted === 0, JSON.stringify(done));
  check("so nothing is queued for embedding and nothing is billed",
    db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0 &&
      done.chunks_queued_for_embedding === 0);
  check("and the stored text is byte-for-byte what it was",
    db.prepare("SELECT group_concat(text) g FROM chunks").get().g === textBefore);
  check("the corpus is now measured rather than assumed",
    done.coverage.unmeasured === 0 && done.coverage.fully_searchable_pct === 100,
    JSON.stringify(done.coverage));
}

/* ---- resumable, and bounded to one page per call ---- */
{
  const env = makeEnv();
  const db = env._db;
  for (const id of ["doc-1", "doc-2", "doc-3"]) {
    seedDoc(db, id);
    seedLegacyChunk(db, id, 0, legacyBody("Renewal review", JAPANESE, 1600));
  }
  const first = await refitChunks(env, { dryRun: false, documents: 1 });
  const cursor = db.prepare("SELECT chunk_refit_cursor c FROM install_state WHERE id = 1").get().c;
  check("one page per call is honoured",
    first.documents_examined === 1 && first.complete === false, JSON.stringify(first));
  check("and the cursor is durable, so an interrupted run resumes",
    cursor === "doc-1", String(cursor));

  const second = await refitChunks(env, { dryRun: false, documents: 1 });
  check("the next call continues rather than starting over",
    second.documents_examined === 1 &&
      db.prepare("SELECT chunk_refit_cursor c FROM install_state WHERE id = 1").get().c === "doc-2",
    JSON.stringify(second));

  const third = await refitChunks(env, { dryRun: false, documents: 25 });
  check("and the last page reports the walk complete", third.complete === true, JSON.stringify(third));
  check("the cursor is cleared once the walk finishes",
    db.prepare("SELECT chunk_refit_cursor c FROM install_state WHERE id = 1").get().c === "",
    JSON.stringify(db.prepare("SELECT chunk_refit_cursor c FROM install_state WHERE id = 1").get()));
  check("every document was repaired across the three calls",
    (await searchableCoverage(env)).over_budget === 0);
}

/* ---- the spend guard is consulted BEFORE the first write ---- */
{
  // The refit does not call the model itself, it queues chunks the drain will
  // embed on the client's own account. Queueing work whose bill has already
  // been refused is still spending their money, just later.
  //
  // The lever here is the configured cap rather than a ledger row: the guard
  // caches the day's ledger sum per isolate for a minute, so writing a row
  // mid-file would not be seen. The ledger-sum path itself is covered by
  // worker/test/spend-cap.test.mjs.
  const env = makeEnv({ DAILY_LLM_CAP_USD: "0" });
  const db = env._db;
  seedDoc(db, "ledger");
  seedLegacyChunk(db, "ledger", 0, legacyBody("Renewal review", LEDGER, 2000));

  let refused = null;
  try { await refitChunks(env, { dryRun: false }); } catch (error) { refused = error; }
  check("a spent budget refuses the repair", refused?.spend_capped === true, String(refused?.message || "no refusal"));
  check("and says so rather than failing obscurely",
    /daily spend cap/.test(refused?.message || ""), refused?.message);
  check("nothing was written before the refusal",
    db.prepare("SELECT count(*) n FROM chunks").get().n === 1 &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0);

  // A preview must still work while the budget is spent: it writes nothing, and
  // an owner who cannot see the damage cannot decide to pay for the repair.
  const preview = await refitChunks(env, { dryRun: true });
  check("but the preview still reports the damage",
    preview.dry_run === true && preview.coverage.unmeasured === 1, JSON.stringify(preview.coverage));
}

console.log(`\nchunk fit: ${fail ? `${fail} of ${ran} FAILED` : `all ${ran} tests passed`}`);
process.exit(fail ? 1 : 0);
