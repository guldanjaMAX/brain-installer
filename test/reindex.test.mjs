// brain reindex: rebuild the vector store from D1.
//
// The point of this command is recovery, so the property that matters most is
// that it is NON-DESTRUCTIVE. It must never delete a document, a chunk, or a
// vector. If it ever does, it is not a recovery tool, it is a second way to
// lose the corpus.

import { reindex } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

// A fake D1 that answers the three shapes reindex uses and records every
// statement, so a destructive one cannot pass unnoticed.
const mkEnv = ({ chunks = 0, outbox = 0, inserted = 0 } = {}) => {
  const sql = [];
  let outboxNow = outbox;
  return {
    sql,
    DB: {
      prepare(q) {
        sql.push(q.replace(/\s+/g, " ").trim());
        const shape = (b = []) => ({
          bind: (...bb) => shape(bb),
          first: async () => {
            if (/FROM chunks c JOIN documents/.test(q)) return { n: chunks };
            if (/FROM vector_outbox/.test(q)) return { n: outboxNow };
            return {};
          },
          run: async () => { outboxNow += inserted; return {}; },
          all: async () => ({ results: [] }),
        });
        return shape();
      },
    },
  };
};

/* ---- it never destroys anything ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 0, inserted: 500 });
  await reindex(env, { dryRun: false });
  const destructive = env.sql.filter((q) => /\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i.test(q));
  check("reindex issues NO destructive statement", destructive.length === 0, JSON.stringify(destructive));
  check("and does not touch documents or chunks except to read them",
    env.sql.every((q) => !/INSERT INTO (documents|chunks)|DELETE FROM (documents|chunks)/i.test(q)), JSON.stringify(env.sql));
}

/* ---- dry run is the default and changes nothing ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 3 });
  const r = await reindex(env);
  check("dry run is the DEFAULT", r.dry_run === true, JSON.stringify(r));
  check("it reports what would happen", r.chunks === 500, JSON.stringify(r));
  check("and queues nothing", r.queued === 0 && !env.sql.some((q) => /INSERT/i.test(q)), JSON.stringify(env.sql));
}

/* ---- armed, it queues every chunk ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 0, inserted: 500 });
  const r = await reindex(env, { dryRun: false });
  check("armed, it queues every chunk", r.queued === 500, JSON.stringify(r));
  check("via INSERT OR IGNORE, so a second run cannot double up",
    env.sql.some((q) => /INSERT OR IGNORE INTO vector_outbox/i.test(q)), JSON.stringify(env.sql));
  check("and it re-queues as an upsert", env.sql.some((q) => /'upsert'/.test(q)));
}

/* ---- running it twice is safe ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 500, inserted: 0 });
  const r = await reindex(env, { dryRun: false });
  check("a second run adds nothing new", r.queued === 0, JSON.stringify(r));
  check("and says how many were already waiting", r.already_queued === 500, JSON.stringify(r));
}

/* ---- scoped to one source ---- */
{
  const env = mkEnv({ chunks: 40, outbox: 0, inserted: 40 });
  const r = await reindex(env, { source: "documents", dryRun: false });
  check("a source filter reaches the SQL", env.sql.some((q) => /WHERE d\.source = \?/.test(q)), JSON.stringify(env.sql));
  check("and is reported back", r.source === "documents", JSON.stringify(r));
}

/* ---- an empty brain is not an error ---- */
{
  const r = await reindex(mkEnv({ chunks: 0 }), { dryRun: false });
  check("an empty brain returns zero rather than failing", r.chunks === 0 && r.queued === 0, JSON.stringify(r));
}

console.log(`\nreindex: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
