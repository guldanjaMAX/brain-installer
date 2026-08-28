/**
 * remember-contract — the rules a correction has to satisfy before it is
 * allowed to change what the brain believes.
 *
 * Lifted verbatim out of the local MCP server so the REMOTE connector, which
 * the Claude and ChatGPT apps reach, enforces exactly the same discipline. Two
 * surfaces writing to one brain under two different standards is how a record
 * quietly becomes untrustworthy: the strict one looks broken by comparison and
 * everyone routes around it.
 *
 * What it refuses, and why each refusal exists:
 *
 *   A body under 40 characters. A lesson too short to state its own conditions
 *   cannot be applied later; it is a note to nobody.
 *
 *   "verified" without saying how you know. If you cannot say how, the honest
 *   value is "inferred", and the difference is the whole point of recording a
 *   confidence at all.
 *
 *   A single observation claiming a pattern. "always", "every time", "keeps
 *   failing" are claims about a population that one occurrence cannot support,
 *   so confidence is capped rather than the write being rejected.
 *
 *   A figure with no date anchor. Prices, counts and balances rot. Tagged
 *   volatile and stamped, so staleness is visible instead of silent.
 *
 * Corrections SUPERSEDE rather than overwrite: `supersedes` carries the id of
 * what is being corrected, so the record keeps the why instead of erasing it.
 *
 * Pure and dependency-free, because it runs in a Worker and in Node.
 */

export const CONFIDENCE = ["verified", "inferred", "unverified"];
const MIN_BODY = 40;
const OVERGENERALISED =
  /\b(always|every ?time|never fails?|keeps? failing|invariably|in every case|without fail)\b/i;
const VOLATILE =
  /(\$[\d,]+|\b\d[\d,._]*\s*(%|users?|customers?|clients?|leads?|per month|\/mo|per day|\/day)\b)/i;
const DATE_ANCHOR = /\bas of\b|\b\d{4}-\d{2}-\d{2}\b/i;

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
  "lesson";
const today = () => new Date().toISOString().slice(0, 10);

export function validateLesson(input) {
  const errors = [];
  const warnings = [];
  const title = String(input?.title ?? "").trim();
  const body = String(input?.body ?? "").trim();
  if (!title) errors.push("title is required");
  if (body.length < MIN_BODY)
    errors.push(
      `body must be at least ${MIN_BODY} characters. A lesson too short to state its own conditions cannot be applied later.`
    );

  let confidence = String(input?.confidence ?? "").trim();
  if (!CONFIDENCE.includes(confidence))
    errors.push(`confidence must be one of: ${CONFIDENCE.join(" | ")}`);

  const verification = input?.verification ? String(input.verification).trim() : null;
  if (confidence === "verified" && !verification)
    errors.push(
      'confidence is "verified" but no verification was given. Say how you know. If you cannot, the honest value is "inferred".'
    );

  if (errors.length) return { ok: false, errors, warnings, value: null };

  const claimed = confidence;
  if (OVERGENERALISED.test(body) && confidence === "verified") {
    confidence = "inferred";
    warnings.push(
      'body generalises over occurrences, and one session sees one occurrence. Confidence capped at "inferred".'
    );
  }
  let volatile = false;
  if (VOLATILE.test(body) && !DATE_ANCHOR.test(body)) {
    volatile = true;
    warnings.push(
      `body states a figure that rots with no date anchor. Tagged volatile and stamped "as of ${today()}".`
    );
  }

  const slug = slugify(input?.slug || title);
  return {
    ok: true,
    errors,
    warnings,
    value: {
      slug,
      source_id: `lesson/${slug}`,
      title,
      body,
      confidence,
      claimed_confidence: claimed === confidence ? null : claimed,
      verification,
      volatile,
      supersedes: input?.supersedes ? String(input.supersedes).trim() : null,
      tags: Array.isArray(input?.tags) ? input.tags.map(String).filter(Boolean) : [],
    },
  };
}

export function renderLesson(v) {
  const lines = [`# ${v.title}`, "", v.body, "", "---", `Confidence: ${v.confidence}`];
  if (v.claimed_confidence)
    lines.push(`Claimed confidence: ${v.claimed_confidence} (downgraded at write time)`);
  if (v.verification) lines.push(`Verification: ${v.verification}`);
  if (v.volatile) lines.push(`Volatile: yes, as of ${today()}`);
  if (v.supersedes) lines.push(`Supersedes: ${v.supersedes}`);
  if (v.tags.length) lines.push(`Tags: ${v.tags.join(", ")}`);
  lines.push(`Recorded: ${today()}`);
  return lines.join("\n");
}
