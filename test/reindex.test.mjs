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
  let bootstrapStatus = "verified";
  let bootstrapEpoch = 0;
  const bootstrapHighWater = chunks > 0 ? "fixture:high-water#0" : null;
  return {
    sql,
    DB: {
      prepare(q) {
        sql.push(q.replace(/\s+/g, " ").trim());
        const shape = (b = []) => ({
          bind: (...bb) => shape(bb),
          first: async () => {
            if (/SELECT schema_version FROM install_state/.test(q)) return { schema_version: 13 };
            if (/FROM chunks c JOIN documents/.test(q)) return { n: chunks };
            if (/vector_projection_bootstrap_epoch AS epoch/.test(q)) {
              return {
                status: bootstrapStatus,
                epoch: bootstrapEpoch,
                cursor: null,
                high_water: bootstrapHighWater,
                chunks,
                pending: outboxNow,
              };
            }
            if (/FROM vector_outbox/.test(q)) return { n: outboxNow };
            return {};
          },
          run: async () => {
            if (/UPDATE install_state/.test(q)) {
              if (bootstrapStatus === "bootstrap_required") {
                return { meta: { changes: 0 } };
              }
              bootstrapStatus = chunks > 0 ? "bootstrap_required" : "verified";
              bootstrapEpoch += 1;
              return { meta: { changes: 1 } };
            }
            outboxNow += inserted;
            return { meta: { changes: inserted } };
          },
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
  const destructive = env.sql.filter((q) =>
    /\b(?:DELETE|DROP|TRUNCATE)\b/i.test(q) ||
    /\bUPDATE\s+(?:documents|chunks|vector_outbox)\b/i.test(q));
  check("reindex issues no destructive corpus or queue statement", destructive.length === 0, JSON.stringify(destructive));
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

/* ---- armed, whole-corpus work starts one durable bounded bootstrap ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 0, inserted: 500 });
  const r = await reindex(env, { dryRun: false });
  check("armed, it records a durable bootstrap instead of materializing 500 queue rows",
    r.queued === 0 && r.pending === 0 && r.bootstrap_required === true && r.bootstrap_epoch === 1,
    JSON.stringify(r));
  check("whole-corpus reindex performs no corpus-sized outbox insert",
    !env.sql.some((q) => /INSERT (?:OR REPLACE )?INTO vector_outbox/i.test(q)), JSON.stringify(env.sql));
}

/* ---- running it twice resumes the same epoch and existing queue ---- */
{
  const env = mkEnv({ chunks: 500, outbox: 500, inserted: 0 });
  const first = await reindex(env, { dryRun: false });
  const second = await reindex(env, { dryRun: false });
  check("a second run preserves the durable bootstrap epoch",
    first.bootstrap_epoch === 1 && second.bootstrap_epoch === 1 && second.bootstrap_resumed === true,
    JSON.stringify({ first, second }));
  check("and preserves the already waiting queue instead of duplicating it",
    second.queued === 0 && second.already_queued === 500 && second.pending === 500,
    JSON.stringify(second));
}

/* ---- scoped to one source ---- */
{
  const env = mkEnv({ chunks: 40, outbox: 0, inserted: 40 });
  const r = await reindex(env, { source: "documents", dryRun: false });
  check("a source filter reaches the SQL", env.sql.some((q) => /WHERE d\.source = \?/.test(q)), JSON.stringify(env.sql));
  check("and is reported back", r.source === "documents", JSON.stringify(r));
  check("scoped repair still queues current D1 state as upserts",
    r.queued === 40 && env.sql.some((q) => /INSERT OR REPLACE INTO vector_outbox/i.test(q)) &&
      env.sql.some((q) => /'upsert'/.test(q)), JSON.stringify({ receipt: r, sql: env.sql }));
}

/* ---- an empty brain is not an error ---- */
{
  const r = await reindex(mkEnv({ chunks: 0 }), { dryRun: false });
  check("an empty brain returns zero rather than failing", r.chunks === 0 && r.queued === 0, JSON.stringify(r));
}

console.log(`\nreindex: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
