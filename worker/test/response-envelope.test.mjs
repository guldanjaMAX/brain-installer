import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  responseIncomplete, responseFailures, describeFailures, withCompleteness, subsystemFailure,
} from "../src/lib/failure.js";

/* HTTP 200 carrying an error in the body is not a success, and `response.ok`
   alone cannot tell the difference. A field probe of a half-migrated install
   pointed four read routes at it: all four answered 200 and three were lying,
   with two D1 "no such column" errors nested inside a /documents body that
   every ok-checking consumer read as a healthy brain.

   These tests pin the contract that replaced it:
     - a route that could not do its job answers with a failing STATUS;
     - a route that must keep answering 200 declares `complete: false` and
       names what failed in `failures`;
     - one predicate, responseIncomplete, works on both, and on a worker old
       enough to predate the field. */

let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}  ${error.message}`);
    process.exitCode = 1;
    throw error;
  }
};

/* ------------------------------------------------------- the envelope itself */

check("a whole body declares itself complete", () => {
  const body = withCompleteness({ rows: [] });
  assert.equal(body.complete, true);
  assert.equal(body.failures, undefined);
  assert.equal(responseIncomplete(body), false);
});

check("a body with a named failure is incomplete and says what failed", () => {
  const body = withCompleteness({ rows: [] }, [subsystemFailure("vector_backlog", new Error("no such column: submitted_mutation_id"))]);
  assert.equal(body.complete, false);
  assert.equal(responseIncomplete(body), true);
  assert.equal(responseFailures(body).length, 1);
  assert.match(describeFailures(body), /vector_backlog: no such column/);
});

check("a subsystem failure never grows unbounded", () => {
  const failure = subsystemFailure("vector_backlog", new Error("x".repeat(5000)));
  assert.equal(failure.error.length, 300);
});

/* --------------------------------------------- version skew: an older worker */

check("a pre-contract /documents body with a nested error still reads as incomplete", () => {
  // No `complete` field at all, exactly what a worker deployed before this
  // change sends. The nested error is the only signal, and it must be enough.
  const legacy = {
    backend: "d1",
    rows: [],
    vector_backlog: { error: "no such column: submitted_mutation_id" },
    vector_readiness: { ready: false, error: "no such column: vector_projection_mutation_id" },
  };
  assert.equal(responseIncomplete(legacy), true);
  assert.equal(responseFailures(legacy).length, 2);
  assert.match(describeFailures(legacy), /vector_readiness/);
});

check("a pre-contract /think body carrying answer_error reads as incomplete", () => {
  assert.equal(responseIncomplete({ mode: "think", answer: null, answer_error: "daily LLM spend cap reached" }), true);
});

check("a pre-contract batch body with a failed document reads as incomplete", () => {
  assert.equal(responseIncomplete({
    created: 1, failed: 1, total: 2,
    results: [{ status: "created" }, { status: "failed", error: "D1_ERROR" }],
  }), true);
});

check("a healthy pre-contract body is not called broken", () => {
  assert.equal(responseIncomplete({ backend: "d1", rows: [], vector_backlog: { pending: 0 } }), false);
  assert.equal(responseIncomplete({ mode: "think", answer: "yes", citations: [{ n: 1 }] }), false);
  assert.equal(responseIncomplete(null), false);
  assert.equal(responseIncomplete("nope"), false);
});

/* ------------------------------------------- /documents: the status must fail */

function documentsEnv({ backlogThrows = false, readinessThrows = false } = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => ({ results: [] }),
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              if (readinessThrows) throw new Error("no such column: vector_projection_mutation_id");
              return {
                schema_version: 12, mutation_id: null, mutation_submitted_at: null,
                projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                bootstrap_high_water: null, expected_vectors: 0, pending: 0, submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql)) {
              if (backlogThrows) throw new Error("no such column: submitted_mutation_id");
              return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
            }
            return { n: 0, stored_documents: 0, logical_documents: 0 };
          },
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
    VECTORIZE: { query: async () => ({ matches: [] }), describe: async () => ({ vectorCount: 0 }) },
  };
}

const documents = (env) => worker.fetch(
  new Request("https://b.example/api/admin/brain/documents", { headers: { "X-Admin-Key": "k" } }),
  env, {},
);

{
  const res = await documents(documentsEnv());
  const body = await res.json();
  check("a sound brain answers /documents 200 and complete", () => {
    assert.equal(res.status, 200);
    assert.equal(body.complete, true);
    assert.equal(responseIncomplete(body), false);
  });
}

{
  const res = await documents(documentsEnv({ backlogThrows: true }));
  const body = await res.json();
  check("a /documents subsystem failure is a failing STATUS, not a 200", () => {
    assert.equal(
      res.status, 503,
      "response.ok has to be false, or every ok-checking consumer reports a healthy brain",
    );
    assert.equal(res.ok, false, "Response.ok is derived from the status, and that is the point");
    assert.equal(body.complete, false);
    assert.equal(responseIncomplete(body), true);
    assert.match(describeFailures(body), /vector_backlog: no such column: submitted_mutation_id/);
  });
  check("the good half of a 503 /documents body is still delivered", () => {
    assert.equal(body.backend, "d1");
    assert.ok(Array.isArray(body.rows), "rows survive so a caller is not left with nothing");
  });
}

{
  const res = await documents(documentsEnv({ readinessThrows: true }));
  const body = await res.json();
  check("a readiness failure fails the status the same way", () => {
    assert.equal(res.status, 503);
    assert.match(describeFailures(body), /vector_readiness/);
    assert.equal(body.vector_readiness.ready, false, "the legacy nested shape is preserved");
  });
}

/* --------------------------- /think and /unified: 200, but honestly incomplete */

function degradedEnv() {
  // No AI binding and no embedding provider, so the semantic half cannot run
  // and the store reports a degraded retrieval rather than an empty corpus.
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
  };
}

{
  const res = await worker.fetch(new Request("https://b.example/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "what did we agree" }),
  }), degradedEnv(), {});
  const body = await res.json();
  check("a search that could not run stays 200 so its disclosure survives", () => {
    assert.equal(
      res.status, 200,
      "a non-2xx would make ok-checking clients discard the notice and print a status code",
    );
    assert.equal(body.status, "search_unavailable");
    assert.match(body.notice, /could not be completed/i);
  });
  check("...and it is still mechanically detectable as incomplete", () => {
    assert.equal(body.complete, false);
    assert.equal(responseIncomplete(body), true);
    assert.match(describeFailures(body), /retrieval/);
  });
  check("an incomplete /think never carries a refusal confidence", () => {
    assert.equal(body.confidence, undefined, "a percentage here would dress a failure as a finding");
  });
}

{
  const res = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "what did we agree" }),
  }), degradedEnv(), {});
  const body = await res.json();
  check("/unified declares the same incompleteness as /think", () => {
    assert.equal(res.status, 200);
    assert.equal(body.complete, false);
    assert.equal(responseIncomplete(body), true);
  });
}

/* ------------------------------------ source-receipt: a recorded failure is not a route failure */

{
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          all: async () => ({ results: [] }),
          first: async () => ({ stored_documents: 4, logical_documents: 4 }),
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
  };
  const res = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ source: "drive", kind: "drive", status: "error", error: "the folder walk did not finish" }),
  }), env, {});
  const body = await res.json();
  check("filing a connector's own failure is a COMPLETE response", () => {
    assert.equal(res.status, 200);
    assert.equal(body.status, "error", "the recorded status is where the failure belongs");
    assert.equal(body.error, "the folder walk did not finish");
    assert.equal(
      body.complete, true,
      "the route did what it was asked; only the connector failed, and the envelope must not conflate them",
    );
    assert.equal(responseIncomplete(body), false);
  });
}

console.log(`response envelope: ${ran} focused offline checks passed`);
