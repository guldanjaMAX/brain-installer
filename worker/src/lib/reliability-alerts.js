import { freshnessReport, vectorRetrySummary } from "./store-d1.js";

const SOURCE_ATTENTION_STATES = new Set(["stale", "broken", "never_synced"]);

/**
 * Owner-safe operational alerts.
 *
 * This output is deliberately aggregate-only. It never forwards connector
 * errors, source names, paths, document ids, chunk ids, queue errors, tokens,
 * or provider response bodies. The detailed operator diagnostics stay behind
 * their existing admin-only route.
 */
export async function ownerReliabilityAlerts(env, { now = Date.now() } = {}) {
  const alerts = [];
  let freshness;
  try {
    freshness = await freshnessReport(env, { now });
    if (freshness?.unavailable) throw new Error("freshness unavailable");
    const stale = (freshness?.sources || []).filter((source) => SOURCE_ATTENTION_STATES.has(source.state));
    if (stale.length) {
      const broken = stale.filter((source) => source.state === "broken").length;
      alerts.push({
        id: "sources_need_attention",
        severity: broken ? "critical" : "warning",
        count: stale.length,
        broken,
        message: `${stale.length} source${stale.length === 1 ? " needs" : "s need"} attention before the Brain can claim current coverage.`,
      });
    }
  } catch {
    alerts.push({
      id: "source_freshness_unavailable",
      severity: "warning",
      count: 1,
      message: "Source freshness could not be checked.",
    });
  }

  try {
    const queue = await vectorRetrySummary(env, now);
    if (queue.quarantined > 0) {
      alerts.push({
        id: "vector_queue_quarantined",
        severity: "critical",
        count: queue.quarantined,
        message: `${queue.quarantined} semantic-index operation${queue.quarantined === 1 ? " is" : "s are"} quarantined after bounded retries.`,
      });
    } else if (queue.delayed > 0) {
      alerts.push({
        id: "vector_queue_retrying",
        severity: "warning",
        count: queue.delayed,
        message: `${queue.delayed} semantic-index operation${queue.delayed === 1 ? " is" : "s are"} waiting for a scheduled retry.`,
      });
    }
  } catch {
    alerts.push({
      id: "vector_queue_status_unavailable",
      severity: "warning",
      count: 1,
      message: "Semantic-index retry status could not be checked.",
    });
  }

  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    alerts.push({
      id: "update_incomplete",
      severity: "critical",
      count: 1,
      message: "An update left document writes paused. Finish or roll back the update before adding material.",
    });
  }

  return {
    status: alerts.some((alert) => alert.severity === "critical")
      ? "action_required"
      : alerts.length
        ? "attention"
        : "ok",
    alerts,
    privacy: "Aggregate operational counts only. No content, names, paths, identifiers, credentials, or raw errors.",
    checked_at: new Date(now).toISOString(),
  };
}
