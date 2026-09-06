import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { computeAnswerConfidence } from "../src/lib/confidence.js";
import {
  answerUsesOperativeValue,
  answerUsesSupersededValue,
  agreementVerdict,
  authorityFor,
  bestTier,
  operativeSectionForQuery,
  ownerConfirmedRecord,
  tierOf,
} from "../src/lib/evidence-authority.js";
import { hasExplicitCurrentIntent, queryEntityAnchors } from "../src/lib/query-intent.js";
import { search } from "../src/lib/store-d1.js";

const ownerRow = ({
  day = "2026-09-01",
  id = "confirmation-1",
  value = "100 New Avenue",
  supersedes = "50 Old Road",
  fact = "Mailing address",
} = {}) => ({
  chunk_uid: `curated:owner-confirmed/${day}/${id}#0`,
  doc_uid: `curated:owner-confirmed/${day}/${id}`,
  source: "curated",
  source_id: `owner-confirmed/${day}/${id}`,
  title: `Confirmed by the owner, ${day}`,
  category: "owner-confirmed",
  client: "Taylor",
  document_date: Date.parse(`${day}T12:00:00.000Z`),
  date_source: "owner_confirmation",
  date_reliable: 1,
  text_source: "native",
  text_reliable: 1,
  authority_meta: JSON.stringify({
    authority: "T1", operative: true, subject: "Taylor", client_name: "Taylor",
  }),
  text: [
    `# Confirmed by the owner, ${day}`,
    "",
    "Subject: Taylor",
    "",
    `## ${fact}`,
    `Operative value: ${value}`,
    `As of: ${day}, confirmed by the owner`,
    `Supersedes: ${supersedes}`,
  ].join("\n"),
});

test("the complete D1 tuple identifies one section-specific owner operative record", () => {
  const row = ownerRow();
  assert.deepEqual(ownerConfirmedRecord(row), { valid: true, day: "2026-09-01" });
  assert.deepEqual(operativeSectionForQuery(row, "What is Taylor's current mailing address?"), {
    name: "Mailing address",
    value: "100 New Avenue",
    as_of: "2026-09-01",
    supersedes: ["50 Old Road"],
  });
  const authority = authorityFor(row, {
    query: "What is Taylor's current mailing address?",
    current: true,
  });
  assert.equal(authority.tier, "T1");
  assert.equal(authority.operative, true);
  assert.equal(authority.authoritative, true);

  const unrelated = authorityFor(row, {
    query: "What is Taylor's current phone number?",
    current: true,
  });
  assert.equal(unrelated.operative, false);
  assert.equal(unrelated.operative_section, undefined);
  assert.equal(unrelated.eligible, false);
  assert.equal(unrelated.authoritative, false);

  for (const mutation of [
    { authority_meta: JSON.stringify({ authority: "T1", operative: false }) },
    { authority_meta: JSON.stringify({ authority: "T1", operative: true, subject: "Taylor", client_name: "Other" }) },
    { authority_meta: JSON.stringify({ authority: "T1", operative: true, subject: "Other", client_name: "Taylor" }) },
    { client: "Other" },
    { authority_document_head: row.text.replace("Subject: Taylor", "Subject: Other") },
    { authority_document_head: row.text.replace("Subject: Taylor\n\n", "") },
    { date_source: "file_mtime" },
    { date_reliable: 0 },
    { text_source: "ocr", text_reliable: 0 },
    { source_id: "owner-confirmed/2026-09-01" },
  ]) {
    assert.equal(ownerConfirmedRecord({ ...row, ...mutation }).valid, false);
  }

  const laterChunk = {
    ...row,
    client: "  TAYLOR  ",
    authority_meta: JSON.stringify({
      authority: "T1", operative: true, subject: "Taylor", client_name: "taylor",
    }),
    authority_document_head: row.text.replace("Subject: Taylor", "Subject: TAYLOR"),
    text: row.text.slice(row.text.indexOf("## Mailing address")),
  };
  assert.equal(ownerConfirmedRecord(laterChunk).valid, true);
});

test("a multi-section owner record receives operative authority only for an unambiguous matching section", () => {
  const row = ownerRow();
  row.text += [
    "",
    "## Mobile number",
    "Operative value: (555) 123-4567",
    "As of: 2026-09-01, confirmed by the owner",
    "Supersedes: (555) 765-4321",
  ].join("\n");
  assert.equal(operativeSectionForQuery(row, "What is the current value?") , null);
  assert.equal(
    operativeSectionForQuery(row, "What is Taylor's current phone number?")?.value,
    "(555) 123-4567",
  );

  const taxId = ownerRow({ fact: "Tax identification number" });
  assert.equal(operativeSectionForQuery(taxId, "What is Taylor's current phone number?"), null);
});

test("financial authority is claim-specific and cannot establish a relationship", () => {
  const stripe = {
    source: "stripe", title: "Taylor active subscription", text_source: "native", text_reliable: true,
    ts: "2026-09-01T00:00:00.000Z", date_reliable: true,
  };
  assert.equal(tierOf(stripe).tier, "T1", "the feed is primary for its own facts");
  const relationship = authorityFor(stripe, {
    query: "Is Taylor a client?", claimText: "Taylor is an active client.", current: true,
  });
  assert.equal(relationship.eligible, false);
  assert.equal(relationship.authoritative, false);
  assert.match(relationship.reason, /not a relationship/);

  const subscription = authorityFor(stripe, {
    query: "Is Taylor's subscription active?", claimText: "Taylor's subscription is active.", current: true,
  });
  assert.equal(subscription.eligible, true);
  assert.equal(subscription.authoritative, true);

  for (const query of ["Is Taylor my vendor?", "Is Taylor still my partner?"]) {
    const relationshipRole = authorityFor(stripe, { query, current: true });
    assert.equal(relationshipRole.claim, "relationship_status");
    assert.equal(relationshipRole.eligible, false);
    assert.equal(relationshipRole.authoritative, false);
  }
});

test("operative-value matching respects numeric and phone boundaries", () => {
  assert.equal(answerUsesOperativeValue("The amount is $100.", { value: "$100" }), true);
  assert.equal(answerUsesOperativeValue("The amount is $1000.", { value: "$100" }), false);
  assert.equal(answerUsesOperativeValue("The amount is 11 000.", { value: "1 000" }), false);
  assert.equal(answerUsesOperativeValue("Call 555-123-4567.", { value: "(555) 123-4567" }), true);

  assert.equal(answerUsesSupersededValue("The amount is $1000.", { supersedes: ["$100"] }), false);
  assert.equal(answerUsesSupersededValue("The old amount was $100.", { supersedes: ["$100"] }), false);
  assert.equal(answerUsesSupersededValue(
    "The old amount was $100. The current amount is $100.",
    { supersedes: ["$100"] },
  ), true);
  assert.equal(answerUsesSupersededValue("The amount is $100.", { supersedes: ["$100"] }), true);
  assert.equal(answerUsesSupersededValue("Call 555.765.4321.", { supersedes: ["(555) 765-4321"] }), true);
});

test("plain present relationship and owner-fact questions activate current intent", () => {
  assert.equal(hasExplicitCurrentIntent("Is Taylor a client?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Acme an active customer?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor my vendor?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor still my partner?"), true);
  assert.equal(hasExplicitCurrentIntent("What is my mailing address?"), true);
  assert.equal(hasExplicitCurrentIntent("What is our phone number?"), true);
  assert.equal(hasExplicitCurrentIntent("What is my email address?"), true);
  assert.equal(hasExplicitCurrentIntent("Is Taylor a client in May 2025?"), false);
  assert.equal(hasExplicitCurrentIntent("Is Taylor a former client?"), false);
  assert.equal(hasExplicitCurrentIntent("Was Taylor a client?"), false);
  assert.equal(hasExplicitCurrentIntent("What was our mailing address during 2024?"), false);
  assert.deepEqual(queryEntityAnchors("Is ACME Holdings a customer?"), ["acme holdings"]);
});

test("confidence rewards only claim-authoritative agreement and names the strongest tier", () => {
  const base = { ts: "2026-09-01T00:00:00.000Z", date_reliable: true };
  const recollections = ["a", "b", "c"].map((ref) => ({
    ...base,
    ref,
    authority: {
      tier: "T4", rank: 4, name: "recollection", reason: "a meeting note",
      claim: "relationship_status", eligible: true, authoritative: false, current: true,
    },
  }));
  const primary = ["p1", "p2"].map((ref) => ({
    ...base,
    ref,
    authority: {
      tier: "T1", rank: 1, name: "primary", reason: "an owner confirmation",
      claim: "relationship_status", eligible: true, authoritative: true, current: true,
    },
  }));
  const low = computeAnswerConfidence({ approvedDocs: recollections });
  const historical = computeAnswerConfidence({
    approvedDocs: recollections.map((doc) => ({
      ...doc, authority: { ...doc.authority, current: false },
    })),
  });
  const high = computeAnswerConfidence({ approvedDocs: primary });
  assert.ok(high.percent > low.percent);
  assert.ok(historical.percent > low.percent, "T4-only evidence is penalized only for a current claim");
  assert.ok(low.basis.some((line) => /no high-authority agreement bonus/.test(line)));
  assert.ok(low.basis.some((line) => /historical recollection/.test(line)));
  assert.ok(high.basis.some((line) => /strongest evidence is T1 primary/.test(line)));
});

test("a changing fact does not become confident from an undated T1 record", () => {
  const undatedPrimary = {
    source: "drive", title: "Taylor signed agreement.pdf",
    text_source: "native", text_reliable: true,
  };
  const best = bestTier([undatedPrimary], {
    query: "What is Taylor's current mailing address?", current: true,
  });
  assert.equal(best.tier, "T1");
  assert.equal(best.authoritative, false);
  assert.match(best.reason, /no reliable as-of date/);

  const verdict = agreementVerdict([undatedPrimary], {
    query: "What is Taylor's current mailing address?", changes: true,
  });
  assert.equal(verdict.confident, false);
  assert.equal(verdict.caution, true);
  assert.match(verdict.line, /nothing authoritative/);

  const malformedDate = authorityFor({
    ...undatedPrimary,
    ts: "September 1, 2026",
    date_reliable: true,
  }, { query: "What is Taylor's current mailing address?", current: true });
  assert.equal(malformedDate.authoritative, false);
  assert.match(malformedDate.reason, /no reliable as-of date/);
});

test("a current owner operative value outranks a newer soft record", async () => {
  const operative = ownerRow();
  const newerSoft = {
    chunk_uid: "message:newer#0", doc_uid: "message:newer", source: "message", source_id: "newer",
    title: "Taylor address note", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor may still receive mail at 50 Old Road.",
  };
  const rows = [newerSoft, operative];
  const env = {
    BRAIN_OWNER: "Taylor",
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
  };
  const result = await search(env, {
    query: "What is Taylor's current mailing address?", embedding: null, limit: 5,
  });
  assert.equal(result.results[0].source_id, operative.source_id);
  assert.equal(result.results[0].authority.operative, true);
  assert.equal(Object.hasOwn(result.results[0], "authority_meta"), false);
  assert.equal(Object.hasOwn(result.results[0], "authority_document_head"), false);
});

test("an unrelated single owner section receives no operative retrieval boost", async () => {
  const unrelatedOwnerRecord = ownerRow();
  const currentPhone = {
    chunk_uid: "message:phone#0", doc_uid: "message:phone", source: "message", source_id: "phone",
    title: "Taylor phone number", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's phone number is (555) 123-4567.",
  };
  const env = {
    BRAIN_OWNER: "Taylor",
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [currentPhone, unrelatedOwnerRecord] }) }) }) },
  };
  const result = await search(env, {
    query: "What is Taylor's current phone number?", embedding: null, limit: 5,
  });
  assert.equal(result.results[0].source_id, currentPhone.source_id);
  const returnedOwnerRecord = result.results.find((row) => row.source_id === unrelatedOwnerRecord.source_id);
  assert.equal(returnedOwnerRecord?.authority?.operative, false);
});

function routeEnv(answerText, { rows: suppliedRows = null, verifierEvidence = [1] } = {}) {
  const operative = ownerRow();
  const newerSoft = {
    chunk_uid: "message:newer#0", doc_uid: "message:newer", source: "message", source_id: "newer",
    title: "Taylor address note", client: "Taylor", category: "message",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "message_timestamp", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor may still receive mail at 50 Old Road.",
  };
  const rows = suppliedRows || [newerSoft, operative];
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    BRAIN_OWNER: "Taylor",
    DB: {
      exec: async () => {},
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => ({ results: /FROM chunks_fts/.test(sql) ? rows : [] }),
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 33, mutation_id: null, mutation_submitted_at: null,
                projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                bootstrap_high_water: null, expected_vectors: 0, pending: 0, submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/SUM\(est_cost_usd_micros\)/.test(sql)) return { m: 0 };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch: async () => [],
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
    AI: {
      run: async (model, input) => {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        const system = String(input?.messages?.[0]?.content || "");
        if (/verify a proposed answer/.test(system)) {
          return { response: { supported: true, complete: true, evidence: verifierEvidence, reason: "owner operative value" }, usage: {} };
        }
        return { response: answerText, usage: {} };
      },
    },
  };
}

async function askRoute(env) {
  const response = await worker.fetch(new Request("https://brain.invalid/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "What is Taylor's current mailing address?", limit: 5 }),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  return response.json();
}

test("the answer route selects the operative value and keeps superseded history out of the answer", async () => {
  const body = await askRoute(routeEnv("Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1]."));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.doesNotMatch(body.answer || "", /50 Old Road/);
  assert.equal(body.citations[0]?.authority?.tier, "T1");
  assert.equal(body.citations[0]?.authority?.operative, true);
  assert.ok(body.confidence?.basis?.some((line) => /strongest evidence is T1 primary/.test(line)));
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_nonoperative_evidence"), true);
});

test("the answer route fails closed when a draft substitutes the superseded value", async () => {
  const body = await askRoute(routeEnv("Taylor's mailing address is 50 Old Road [1]."));
  assert.equal(body.answer, "The documents do not answer the question.");
  assert.match(body.evidence_gate?.reason || "", /did not use the matching owner-confirmed operative value|superseded value/);
});

test("equally newest disagreeing owner confirmations fail as an operative conflict", async () => {
  const first = ownerRow({ id: "same-time-a", value: "100 New Avenue", supersedes: "50 Old Road" });
  const second = ownerRow({ id: "same-time-b", value: "200 Other Avenue", supersedes: "50 Old Road" });
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [first, second] },
  ));
  assert.equal(body.answer, "The documents do not answer the question.");
  assert.equal(body.evidence_gate?.reason, "equally current owner-confirmed operative records disagree");
  assert.equal(body.gaps?.some((gap) => gap.type === "operative_conflict"), true);
});

test("equally newest matching owner confirmations select one deterministic record", async () => {
  const first = ownerRow({ id: "same-value-a" });
  const second = ownerRow({ id: "same-value-b" });
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [2].",
    { rows: [second, first], verifierEvidence: [2] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.citations.length, 1);
  assert.equal(body.citations[0]?.ref, first.source_id);
  assert.equal(body.gaps?.some((gap) => gap.type === "operative_conflict"), false);
});

test("newer claim-authoritative evidence fails closed against an older operative value", async () => {
  const operative = ownerRow();
  const newerPrimary = {
    chunk_uid: "drive:newer-lease#0", doc_uid: "drive:newer-lease", source: "drive", source_id: "newer-lease",
    title: "Taylor signed lease agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's mailing address is 200 Other Avenue.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, newerPrimary] },
  ));
  assert.equal(body.answer, "The documents do not answer the question.");
  assert.equal(body.evidence_gate?.reason, "newer authoritative evidence may supersede the older owner-confirmed operative value");
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), true);
  assert.equal(body.evidence_authority, undefined, "a refusal does not present retrieved authority as its approved basis");
});

test("a newer unrelated authoritative record does not create a false operative conflict", async () => {
  const operative = ownerRow();
  const unrelatedPrimary = {
    chunk_uid: "drive:newer-vendor#0", doc_uid: "drive:newer-vendor", source: "drive", source_id: "newer-vendor",
    title: "Taylor signed vendor agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor is the vendor for equipment maintenance.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, unrelatedPrimary] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), false);
});

test("a newer authoritative record that repeats the operative value does not create a conflict", async () => {
  const operative = ownerRow();
  const agreeingPrimary = {
    chunk_uid: "drive:newer-lease#0", doc_uid: "drive:newer-lease", source: "drive", source_id: "newer-lease-agrees",
    title: "Taylor signed lease agreement", client: "Taylor", category: "contract",
    document_date: Date.parse("2026-09-05T12:00:00.000Z"), date_source: "document_date", date_reliable: 1,
    text_source: "native", text_reliable: 1, text: "Taylor's mailing address is 100 New Avenue.",
  };
  const body = await askRoute(routeEnv(
    "Taylor's mailing address is 100 New Avenue as of 2026-09-01 [1].",
    { rows: [operative, agreeingPrimary] },
  ));
  assert.match(body.answer || "", /100 New Avenue/);
  assert.equal(body.gaps?.some((gap) => gap.type === "newer_authoritative_evidence"), false);
});
