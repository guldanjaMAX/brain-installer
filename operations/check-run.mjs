/**
 * `brain check`: run every probe, group what comes back, and hand the owner
 * one decision per conflict.
 *
 * Every side effect is injected. The whole run is testable without a brain,
 * a network, or a person, which matters because the one thing this must never
 * do is decide something on the owner's behalf, and that is a property you
 * prove by test rather than by reading.
 */

import { PROBES, candidatesFrom } from "./check-probes.mjs";
import { defaultNormalise, renderSweep, sweep } from "./contradiction-sweep.mjs";
import { OWNER_CONFIRMED_SOURCE } from "./provenance.mjs";

const readableError = (error, fallback) => {
  const text = String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return text || fallback;
};

const comparable = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

export function normalizeCheckSubject(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * A global search can return another person's similarly shaped fact. Keep only
 * rows that explicitly carry the requested subject in their visible evidence
 * or projected metadata. Losing an ambiguous row is safer than presenting one
 * person's address or account as a contradiction in another person's record.
 */
export function rowMatchesSubject(row, subject) {
  const needle = comparable(subject);
  if (!needle) return false;
  return [row?.client, row?.entity_slug, row?.title, row?.snippet, row?.text]
    .some((value) => ` ${comparable(value)} `.includes(` ${needle} `));
}

/** Ask the brain for each probe's records. A probe that errors is reported, never silently dropped. */
export async function gather(search, { probes = PROBES, limit = 25, subject = "" } = {}) {
  const scopedSubject = normalizeCheckSubject(subject);
  const results = [];
  for (const probe of probes) {
    let rows = [];
    let error = null;
    try {
      const body = await search({
        q: scopedSubject ? `Records about ${scopedSubject}. ${probe.query}` : probe.query,
        limit,
      });
      if (body?.status === "unavailable" || body?.status === "partial" || body?.degraded) {
        const state = body?.degraded || body?.status || "partial";
        error = readableError(
          body?.notice || body?.degraded_reason,
          `search was ${state}; this category was not checked completely`,
        );
      } else if (Array.isArray(body?.results)) {
        rows = scopedSubject ? body.results.filter((row) => rowMatchesSubject(row, scopedSubject)) : body.results;
      } else if (Array.isArray(body)) {
        // Legacy Workers returned the result array directly.
        rows = scopedSubject ? body.filter((row) => rowMatchesSubject(row, scopedSubject)) : body;
      } else {
        error = "search returned no results list; this category was not checked";
      }
    } catch (e) {
      error = readableError(e, "search failed; this category was not checked");
    }
    results.push({
      name: probe.name, changes: probe.changes, freeform: Boolean(probe.freeform),
      error, rows,
      candidates: error ? [] : candidatesFrom(probe, rows),
    });
  }
  return results;
}

const countFrom = (row, field) => {
  const value = row?.[field];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const zoneRowsFrom = (zones) => {
  if (!Array.isArray(zones)) return null;
  const seen = new Set();
  const rows = [];
  for (const raw of zones) {
    const zone = typeof raw?.zone === "string" ? raw.zone.trim() : "";
    const sources = countFrom(raw, "sources");
    const documents = countFrom(raw, "documents");
    const chunks = countFrom(raw, "chunks");
    if (!zone || seen.has(zone) || sources === null || documents === null || chunks === null) return null;
    seen.add(zone);
    rows.push({ zone, sources, documents, chunks });
  }
  return rows;
};

const readinessCountsFrom = (readiness) => {
  const sources = readiness?.counts?.sources;
  const documents = readiness?.counts?.documents;
  const chunks = readiness?.counts?.chunks;
  const counts = {
    sources: {
      registered: countFrom(sources, "registered"),
      zoned: countFrom(sources, "zoned"),
      unzoned: countFrom(sources, "unzoned"),
    },
    documents: {
      total: countFrom(documents, "total"),
      unregistered: countFrom(documents, "unregistered"),
      projection_drift: countFrom(documents, "projection_drift"),
    },
    chunks: {
      total: countFrom(chunks, "total"),
      unregistered: countFrom(chunks, "unregistered"),
      projection_drift: countFrom(chunks, "projection_drift"),
    },
  };
  return Object.values(counts).every((group) => Object.values(group).every((value) => value !== null))
    ? counts
    : null;
};

const expectedReadinessState = (counts) => {
  const { sources, documents, chunks } = counts;
  const empty = sources.registered === 0 && documents.total === 0 && chunks.total === 0;
  const projectionGap = documents.unregistered > 0 || documents.projection_drift > 0 ||
    chunks.unregistered > 0 || chunks.projection_drift > 0;
  if (empty) return "empty";
  if (projectionGap) return "needs_review";
  if (sources.zoned === 0) return "not_configured";
  if (sources.unzoned > 0 || sources.zoned !== sources.registered) return "needs_review";
  return "ready";
};

/**
 * Validate the aggregate returned by GET /api/admin/brain/zones.
 *
 * A malformed or incomplete response is unavailable, never an empty or ready
 * brain. The check command is read-only and does not infer a zone assignment.
 */
export function assessZoneReadiness(body) {
  if (!body || typeof body !== "object") {
    return { checked: false, error: "the Brain did not return access-zone readiness" };
  }
  const rows = zoneRowsFrom(body.zones);
  const readiness = body.readiness;
  const states = new Set(["empty", "not_configured", "needs_review", "ready"]);
  const counts = readinessCountsFrom(readiness);
  const rowTotals = rows?.reduce((totals, row) => ({
    sources: totals.sources + row.sources,
    documents: totals.documents + row.documents,
    chunks: totals.chunks + row.chunks,
    unzoned: totals.unzoned + (row.zone === "(unzoned)" ? row.sources : 0),
  }), { sources: 0, documents: 0, chunks: 0, unzoned: 0 });
  if (!rows || !readiness || typeof readiness !== "object" ||
      !states.has(readiness.state) ||
      typeof readiness.ready !== "boolean" ||
      readiness.ready !== (readiness.state === "ready") ||
      readiness.authorization_authority !== "source_registry" ||
      !counts ||
      counts.sources.zoned + counts.sources.unzoned !== counts.sources.registered ||
      counts.documents.unregistered > counts.documents.total ||
      counts.documents.projection_drift > counts.documents.total ||
      counts.chunks.unregistered > counts.chunks.total ||
      counts.chunks.projection_drift > counts.chunks.total ||
      rowTotals.sources !== counts.sources.registered ||
      rowTotals.unzoned !== counts.sources.unzoned ||
      rowTotals.documents !== counts.documents.total - counts.documents.unregistered ||
      rowTotals.chunks !== counts.chunks.total - counts.chunks.unregistered ||
      expectedReadinessState(counts) !== readiness.state) {
    return { checked: false, error: "the Brain returned ambiguous access-zone readiness" };
  }
  return {
    checked: true,
    rows,
    state: readiness.state,
    ready: readiness.state === "ready",
    authorization_authority: readiness.authorization_authority,
    counts,
  };
}

export function unavailableZoneReadiness(error) {
  return {
    checked: false,
    error: readableError(error, "the access-zone inventory could not be read"),
  };
}

export function renderZoneReadiness(readiness) {
  const out = ["## Access zones"];
  if (!readiness?.checked) {
    out.push(`  Could not check: ${readiness?.error || "zone status was not provided"}`,
      "  Access zones were NOT checked. Do not treat this Brain as ready for named-zone sharing.");
    return out.join("\n");
  }
  for (const row of readiness.rows) {
    const label = row.zone === "(unzoned)" ? "owner-only (no named zone)" : row.zone;
    out.push(`  • ${label}: ${row.documents} document(s), ${row.chunks} chunk(s) from ${row.sources} source(s)`);
  }
  const { sources, documents, chunks } = readiness.counts;
  if (readiness.state === "empty") {
    out.push("  No registered sources or corpus records were found. Access-zone readiness starts after a source is loaded.");
  } else if (readiness.state === "not_configured") {
    out.push(
      `  Named access zones have not been configured for ${sources.registered} registered source(s). They remain owner-only.`,
    );
  } else if (readiness.state === "ready") {
    out.push(`  Ready: all ${sources.registered} registered source(s) have a named access zone, with no registry or projection gaps.`);
  } else {
    out.push("  Needs review. Named-zone sharing is not ready.");
    if (sources.unzoned) out.push(`  • ${sources.unzoned} registered source(s) still have no named zone.`);
    if (documents.unregistered || chunks.unregistered) {
      out.push(`  • Corpus rows outside the source registry: ${documents.unregistered} document(s), ${chunks.unregistered} chunk(s).`);
    }
    if (documents.projection_drift || chunks.projection_drift) {
      out.push(`  • Zone projection mismatches: ${documents.projection_drift} document(s), ${chunks.projection_drift} chunk(s).`);
    }
  }
  out.push("  The source registry is the authorization authority for this status.");
  out.push("  This command never assigns a zone. Use `brain zone` only after the owner decides the boundary.");
  return out.join("\n");
}

/**
 * A freeform probe has no extracted values, so it cannot be grouped and must
 * not pretend to be. It is reported as reading for the owner rather than as a
 * conflict, because inventing a value here is exactly the confident-and-wrong
 * behaviour the whole pass exists to remove.
 */
export function partition(gathered = []) {
  return {
    structured: gathered.filter((g) => !g.freeform && !g.error),
    freeform: gathered.filter((g) => g.freeform && !g.error),
    failed: gathered.filter((g) => g.error),
  };
}

export function renderReport(gathered = [], { zoneReadiness = null, subject = "" } = {}) {
  const { structured, freeform, failed } = partition(gathered);
  const assessed = sweep(structured.map((s) => ({ name: s.name, changes: s.changes, candidates: s.candidates })));
  const scopedSubject = normalizeCheckSubject(subject);
  const out = [scopedSubject ? `# Brain check for ${scopedSubject}` : "# Brain check", "", renderSweep(assessed)];

  if (freeform.length) {
    out.push("", "## Worth your own eyes",
      "These change, and they have no dependable shape for a machine to read, so",
      "nothing here is grouped or guessed. Skim the records and tell me what is current.");
    for (const f of freeform) {
      const withRecords = f.rows.length;
      out.push(`  • ${f.name}: ${withRecords} matching record(s) returned`);
    }
  }
  if (failed.length) {
    out.push("", "## Could not check");
    for (const f of failed) out.push(`  • ${f.name}: ${f.error}`);
    out.push("These were NOT checked. Do not read the rest as a clean bill for them.");
  }
  out.push("", renderZoneReadiness(zoneReadiness));
  out.push("", "Nothing has been written. Run the same command with --set to record your answers.");
  return { text: out.join("\n"), assessed, freeform, failed };
}

/**
 * The document a confirmation becomes.
 *
 * `Operative value`, `As of` and `Supersedes` are the load-bearing parts: they
 * are what lets a later answer say "you confirmed this in September" instead
 * of "four documents agree". Written as one dated file per pass, never
 * overwriting the last one, so the brain can show its work.
 */
export function renderConfirmations(answers = [], {
  today = new Date().toISOString().slice(0, 10), subject = "",
} = {}) {
  if (!answers.length) return null;
  const confirmedSubject = normalizeCheckSubject(subject);
  const lines = [
    `# Confirmed by the owner, ${today}`,
    "",
    ...(confirmedSubject ? [`Subject: ${confirmedSubject}`, ""] : []),
    "Each entry below was stated by the owner on the date shown, after being",
    "shown every returned value that disagreed. Each Supersedes line keeps the old values as history.",
    "",
  ];
  for (const a of answers) {
    lines.push(`## ${a.name}`, `Operative value: ${a.value}`, `As of: ${today}, confirmed by the owner`);
    if (a.supersedes?.length) lines.push(`Supersedes: ${a.supersedes.join("; ")}`);
    if (a.note) lines.push(`Note: ${a.note}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** A unique, dated ingest envelope for one owner-confirmation pass. */
export function confirmationEnvelope(markdown, {
  confirmedAt = new Date().toISOString(),
  confirmationId = crypto.randomUUID(),
  subject = "",
} = {}) {
  const instant = new Date(confirmedAt);
  if (!Number.isFinite(instant.getTime())) throw new Error("confirmedAt must be a valid timestamp");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(confirmationId)) {
    throw new Error("confirmationId must contain only letters, numbers, underscores, or hyphens");
  }
  const timestamp = instant.toISOString();
  const today = timestamp.slice(0, 10);
  const confirmedSubject = normalizeCheckSubject(subject);
  return {
    source_type: "curated",
    source_id: `${OWNER_CONFIRMED_SOURCE}/${today}/${confirmationId}`,
    title: `Confirmed by the owner, ${today}`,
    occurred_at: timestamp,
    date_source: "owner_confirmation",
    date_reliable: true,
    text_source: "native",
    text_reliable: true,
    content: markdown,
    metadata: {
      category: OWNER_CONFIRMED_SOURCE,
      authority: "T1",
      operative: true,
      ...(confirmedSubject ? { subject: confirmedSubject, client_name: confirmedSubject } : {}),
    },
  };
}

/** Accept only the exact single-document ingest receipt for this envelope. */
export function validateConfirmationReceipt(receipt, envelope) {
  const expected = `${envelope.source_type}:${envelope.source_id}`;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.doc_uid !== expected || !["created", "unchanged"].includes(receipt.action)) {
    throw new Error("the Brain did not confirm the exact unique owner-confirmation record");
  }
  return receipt;
}

/**
 * Ask one question per conflict and collect the answers.
 *
 * `ask` returns the owner's typed reply. An empty reply means "I do not know",
 * which is recorded as unresolved rather than resolved by silence.
 */
export async function collectAnswers(assessed = [], ask) {
  const answers = [];
  const unresolved = [];
  for (const a of assessed.filter((x) => x.conflict)) {
    const options = a.groups.map((g, i) => `  ${i + 1}. ${g.value}  (${g.count} record(s), strongest ${g.best.name})`);
    const reply = String(await ask(
      `${a.name}\n${a.verdict.line}\n${options.join("\n")}\n` +
      `Which is current? Type the number, or the correct value if none of these is right, or press enter if you are not sure.`,
    ) ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    if (!reply) { unresolved.push(a.name); continue; }
    const numbered = /^\d+$/.test(reply);
    const picked = numbered
      ? a.groups[Number(reply) - 1]
      : a.groups.find((group) => defaultNormalise(group.value) === defaultNormalise(reply)) || null;
    if (numbered && !picked) { unresolved.push(a.name); continue; }
    answers.push({
      name: a.name,
      value: picked ? picked.value : reply,
      supersedes: a.groups.filter((g) => g !== picked).map((g) => g.value),
      note: picked ? null : "value supplied by the owner; none of the records had it",
    });
  }
  return { answers, unresolved };
}
