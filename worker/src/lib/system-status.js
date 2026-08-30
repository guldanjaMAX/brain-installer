/**
 * What the owner is allowed to know about their own brain's condition.
 *
 * WHY A PROJECTION AND NOT A PROXY
 *
 * `diagnose`, `freshness` and `vectorReadiness` are admin-key routes, and the
 * key that reads them can also ingest, purge, reindex and drain. A client-facing
 * page that asked for it would be training people to hand out that credential,
 * which is the same reasoning that put the bank feed and the ledger in front of
 * the key gate. So the owner gets a curated view, composed here, over their
 * passkey session.
 *
 * Three things are deliberately NOT passed through:
 *
 *  - `finding.action`. Every diagnose remedy is a `brain` CLI command the owner
 *    cannot run. Showing it as their to-do makes the product look broken and
 *    them look responsible. Each problem carries `fix_owner: "installer"`
 *    instead, which is the true answer.
 *  - `source.name`. It is a slug constrained to [a-z0-9_-], not a label. It is
 *    translated here so no surface has to guess.
 *  - `finding.samples`. The owner may see their own documents elsewhere; a
 *    status summary is not where a list of filenames belongs.
 *
 * THE INVARIANT, same as the ledger transport
 *
 * A sub-read that failed must not appear as a zero. `documents: 0` is the most
 * dangerous number in this file: an empty corpus and an unreachable diagnose
 * look identical once a failure is flattened, and "your brain holds nothing" is
 * a very different sentence from "we could not check". A failed read names
 * itself in `unavailable` and its keys are ABSENT.
 */

/** Slug to something a person can read. The slug is never rendered. */
const SOURCE_LABELS = {
  curated: "Files you uploaded",
  drive: "Google Drive",
  message: "Messages",
  gmail: "Email",
  calendar: "Calendar",
  zoom: "Meeting recordings",
  quickbooks: "QuickBooks Online",
  slack: "Slack",
  notion: "Notion",
  microsoft: "Microsoft 365",
  dropbox: "Dropbox",
  hubspot: "HubSpot",
};

/** Kinds are a small closed set and make a better fallback than a slug. */
const KIND_LABELS = {
  upload: "Files you uploaded",
  drive: "Google Drive",
  message: "Messages",
  email: "Email",
  calendar: "Calendar",
  quickbooks: "QuickBooks Online",
  slack: "Slack",
  notion: "Notion",
  microsoft: "Microsoft 365",
  dropbox: "Dropbox",
  hubspot: "HubSpot",
};

function labelFor(source) {
  // Slug first, then kind. A prettified slug would still be a slug, so an
  // unrecognised source is described rather than named.
  return SOURCE_LABELS[source.name] || KIND_LABELS[source.kind] || "Another source";
}

export async function ownerSystemStatus(env, deps) {
  const unavailable = [];
  const out = {};

  const [health, diag, fresh, vectors] = await Promise.all([
    (async () => deps.health(env))().catch(() => null),
    deps.diagnose(env).catch(() => null),
    deps.freshness(env).catch(() => null),
    deps.vectorReadiness(env).catch(() => null),
  ]);

  // `accepting_documents` absent is a third answer, not a default to yes. A
  // brain that cannot say whether it is accepting documents has not said yes.
  out.accepting_documents = typeof health?.accepting_documents === "boolean"
    ? health.accepting_documents
    : null;
  out.status = health?.status ?? null;
  out.drain_mode = health?.vector_drain_mode ?? null;
  if (!health) unavailable.push("health");

  if (diag) {
    out.documents = Number(diag.totals?.documents ?? 0);
    out.chunks = Number(diag.totals?.chunks ?? 0);
    out.problem_counts = {
      crit: Number(diag.summary?.crit || 0),
      warn: Number(diag.summary?.warn || 0),
      info: Number(diag.summary?.info || 0),
    };
    out.problems = (diag.findings || [])
      .filter((f) => f.severity === "crit" || f.severity === "warn")
      .map((f) => ({
        id: f.id,
        area: f.area,
        severity: f.severity,
        count: Number(f.count || 0),
        title: f.title,
        detail: f.detail,
        // Every diagnose remedy is an operator command. Saying so is the
        // difference between "you have a task" and "someone owes you a fix".
        fix_owner: "installer",
      }));
  } else {
    unavailable.push("diagnose");
  }

  if (fresh && fresh.unavailable !== true) {
    out.sources = (fresh.sources || []).map((s) => ({
      label: labelFor(s),
      kind: s.kind,
      state: s.state,
      documents: Number(s.documents || 0),
      days_since_ingest: s.days_since_ingest ?? null,
      reason: s.reason ?? null,
      automatable: !!s.automatable,
    }));
  } else {
    unavailable.push("freshness");
  }

  if (vectors) {
    const expected = Number(vectors.expected_vectors || 0);
    const visible = Number(vectors.actual_vectors || 0);
    out.vectors = {
      ready: !!vectors.ready,
      expected,
      visible,
      pending: Number(vectors.pending || 0),
      // The one number an owner actually asks for on install day.
      percent_visible: expected > 0 ? Math.floor((visible / expected) * 100) : null,
    };
  } else {
    unavailable.push("vectors");
  }

  out.unavailable = unavailable;
  return out;
}
