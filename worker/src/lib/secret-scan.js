/**
 * secret-scan v2 — credential detection for the ingest endpoint.
 *
 * Port of ~/CocoIndex/secret_scan.py v2. The two must stay in step: the
 * indexer and this Worker are two doors into the same index, and a gate on one
 * door only is not a gate.
 *
 * TIERING
 *   CONFIRMED  known provider key shape, or a credential in a structural
 *              position (connection string, env assignment, PEM block).
 *              Refuse the ingest.
 *   SUSPECTED  generic shapes that also occur in documentation. Flag, accept.
 *   CLEAN      everything else.
 *
 * THE ALLOWLIST RULE THAT MATTERS
 * Allowlisting (placeholder words, entropy floor, hex/UUID shapes) applies
 * ONLY to the generic and structural tiers. A 108-character string starting
 * `sk-ant-api03-` is a key regardless of which letters appear inside it, so
 * running a "contains the word 'here'" check against it only creates a way for
 * real keys to escape. This was the largest structural flaw in v1.
 *
 * Allowlist context is measured from the CAPTURED SECRET, not the start of the
 * match: `?token=<32 hex>` puts the proving word between the two, so anchoring
 * at the match start hides the evidence that it is a credential rather than an
 * account id.
 *
 * Measured against a live 540k-chunk corpus 2026-08-15: 99.7% recall against
 * known credentials, 0.025% false refusals over 4,000 ordinary chunks.
 */

export const CONFIRMED = "confirmed";
export const SUSPECTED = "suspected";
export const CLEAN = "clean";
export const GATE_VERSION = 2;

// Anchors that respect the token alphabet rather than JS's word definition. A
// trailing \b cannot fire after '-', which made Google keys ending in '-'
// invisible; a leading \b cannot fire after '_'.
const L = "(?<![A-Za-z0-9_\\-])";
const R = "(?![A-Za-z0-9_\\-])";
const re = (body, flags = "g") => new RegExp(L + body + R, flags);

// [label, pattern, severity, group, applyAllowlist]
const PROVIDER = [
  ["anthropic_api_key", re("sk-ant-[A-Za-z0-9_\\-]{24,}")],
  ["openai_api_key", re("sk-proj-[A-Za-z0-9_\\-]{24,}")],
  ["openai_legacy_key", re("sk-[A-Za-z0-9]{32,}")],
  ["supabase_pat", re("sbp_[A-Za-z0-9]{36,}")],
  ["supabase_publishable", re("sb_(?:secret|publishable)_[A-Za-z0-9_\\-]{20,}")],
  ["jwt", new RegExp(L + "eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}", "g")],
  ["cloudflare_token_new", re("cfut_[A-Za-z0-9_\\-]{40,}")],
  // Resend keys carry an underscore INSIDE the body. Excluding it truncated
  // the match below the length floor and every real key fell through.
  ["resend_api_key", re("re_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{10,}")],
  ["resend_api_key", re("re_[A-Za-z0-9]{24,}")],
  ["gohighlevel_key", re("pit-[A-Za-z0-9\\-]{30,}")],
  ["replicate_token", re("r8_[A-Za-z0-9]{30,}")],
  ["gemini_proxy_token", re("gp_[A-Za-z0-9]{30,}")],
  ["github_pat", re("(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}")],
  ["github_fine_grained", re("github_pat_[A-Za-z0-9_]{50,}")],
  ["slack_token", re("xox[baprs]-[A-Za-z0-9\\-]{10,}")],
  ["aws_access_key", re("(?:AKIA|ASIA)[A-Z0-9]{16}")],
  ["google_api_key", re("AIza[A-Za-z0-9_\\-]{35}")],
  ["google_oauth_secret", re("GOCSPX-[A-Za-z0-9_\\-]{20,}")],
  ["google_refresh_token", re("1//0[A-Za-z0-9_\\-]{40,}")],
  ["google_access_token", re("ya29\\.[A-Za-z0-9_\\-]{20,}")],
  ["sendgrid_key", re("SG\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}")],
  ["stripe_secret_key", re("(?:sk|rk)_live_[A-Za-z0-9]{20,}")],
  ["stripe_webhook_secret", re("whsec_[A-Za-z0-9+/=_\\-]{24,}")],
  ["twilio_sid", re("AC[0-9a-f]{32}")],
  ["twilio_key", re("SK[0-9a-f]{32}")],
  ["fly_token", new RegExp("FlyV1\\s+fm2_[A-Za-z0-9+/=_\\-]{40,}", "g")],
  ["notion_token", re("ntn_[A-Za-z0-9]{40,}")],
  ["notion_legacy", re("secret_[A-Za-z0-9]{43}")],
  ["linear_key", re("lin_api_[A-Za-z0-9]{40,}")],
  ["hubspot_token", re("pat-(?:na1|eu1)-[0-9a-f\\-]{36}")],
  ["mailgun_key", re("key-[0-9a-f]{32}")],
  ["plaid_access_token", re("access-(?:production|sandbox|development)-[0-9a-f\\-]{36}")],
].map(([label, pattern]) => ({ label, pattern, severity: CONFIRMED, group: 0, allowlist: false }));

const STRUCTURAL = [
  {
    label: "connection_string",
    // Only group 2 (the password) is redacted, so host and user stay searchable.
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|https?|ftp|smtps?|mssql|clickhouse):\/\/([^:/\s@]{1,64}):([^@/\s]{6,})@[^\s/]+/gi,
    severity: CONFIRMED,
    group: 2,
    allowlist: true,
  },
  {
    label: "url_query_secret",
    pattern: /[?&](?:token|key|api[_-]?key|secret|access[_-]?token|password)=([A-Za-z0-9._\-]{16,})/gi,
    severity: CONFIRMED,
    group: 1,
    allowlist: true,
  },
  {
    // The leading \b in v1 could not fire inside RESEND_API_KEY=, so it missed
    // every .env and wrangler.toml line.
    label: "env_assignment",
    pattern:
      /(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_\-]){0,4}(?:password|passwd|pwd|secret|api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|admin[_-]?key|service[_-]?role)\s*[:=]\s*["'`]?([^\s"'`,;]{8,})/gi,
    severity: CONFIRMED,
    group: 1,
    allowlist: true,
  },
  {
    // The header alone must fire: chunking splits a PEM block so BEGIN lands in
    // one chunk and END in the next, and a rule requiring both matches neither.
    label: "private_key_header",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    severity: CONFIRMED,
    group: 0,
    allowlist: false,
  },
  {
    label: "service_account_private_key",
    pattern: /"private_key"\s*:\s*"-----BEGIN[^"]{200,8000}"/g,
    severity: CONFIRMED,
    group: 0,
    allowlist: false,
  },
  {
    // Classic Cloudflare tokens are 40 chars with NO prefix, which is what
    // wrangler and every deploy script actually use, and the highest blast
    // radius credential in this stack. Context-anchored so git SHAs cannot trip.
    label: "cloudflare_token_classic",
    pattern: new RegExp(
      "\\b(?:cloudflare|wrangler)\\b[^\\n]{0,60}?\\b(?:api[ _-]?token|api[ _-]?key|token|key)\\b[^\\n]{0,30}?[:=|]\\s*[\"'`]?([A-Za-z0-9_\\-]{40})" +
        R,
      "gi"
    ),
    severity: CONFIRMED,
    group: 1,
    allowlist: true,
  },
  {
    label: "cloudflare_global_key",
    pattern: /X-Auth-Key\s*[:=]\s*["']?([0-9a-f]{37})\b/gi,
    severity: CONFIRMED,
    group: 1,
    allowlist: false,
  },
  {
    label: "plaid_secret",
    pattern: new RegExp("plaid[_ -]?(?:secret|client[_ -]?id)\\s*[:=]\\s*[\"']?([0-9a-f]{24,32})" + R, "gi"),
    severity: CONFIRMED,
    group: 1,
    allowlist: true,
  },
  {
    label: "azure_storage_key",
    pattern: /AccountKey=([A-Za-z0-9+/]{86}==)/gi,
    severity: CONFIRMED,
    group: 1,
    allowlist: false,
  },
];

const GENERIC = [
  {
    label: "bearer_literal",
    pattern: /\bBearer\s+([A-Za-z0-9_\-.]{25,})/g,
    severity: SUSPECTED,
    group: 1,
    allowlist: true,
  },
  {
    // A bare 40-char token a git SHA cannot be: requires mixed case and a digit.
    label: "possible_bare_token_40",
    pattern: new RegExp(
      L + "(?=[A-Za-z0-9_\\-]{40}" + R + ")(?=[^\\s]*[a-z])(?=[^\\s]*[A-Z])(?=[^\\s]*[0-9])[A-Za-z0-9_\\-]{40}",
      "g"
    ),
    severity: SUSPECTED,
    group: 0,
    allowlist: true,
  },
];

const ALL_RULES = [...PROVIDER, ...STRUCTURAL, ...GENERIC];

/* ------------------------------------------------------------ allowlist */

const HEX32 = /^[0-9a-f]{32}$/i;
const HEX40 = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER =
  /(?:^|[^A-Za-z0-9])(your|xxx+|placeholder|example|redacted?|changeme|dummy|sample|fake|here|test)(?:$|[^A-Za-z0-9])|<[a-z_]+>|\.{3}|\*{3}/i;
const SHELL_SUBST = /^\$[({]|^\$[A-Z_]+$|^\{\{|^%[A-Z_]+%$/;
const ID_CONTEXT =
  /(account|zone|database|hyperdrive|namespace|bucket|commit|sha|d1|version|prod|product|price|location|folder|file|run|job)[_ ]?(id|hash)?\s*[:=|]?\s*$/i;
const SECRET_CONTEXT =
  /(auth|token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|bearer)/i;

// Total Shannon material, not bits per character. Per-char wrongly clears
// numeric secrets: "1234567890123456" scores 3.25/char but only 52 bits total.
function totalEntropyBits(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const n = s.length;
  let perChar = 0;
  for (const cnt of counts.values()) {
    const p = cnt / n;
    perChar -= p * Math.log2(p);
  }
  return perChar * n;
}

function isAllowlisted(value, contextBefore = "") {
  const v = String(value).trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!v) return true;
  if (SHELL_SUBST.test(v)) return true;
  if (PLACEHOLDER.test(v)) return true;
  if (HEX32.test(v) || HEX40.test(v) || UUID.test(v)) {
    const tail = contextBefore.slice(-48);
    if (SECRET_CONTEXT.test(tail) && !ID_CONTEXT.test(tail)) return false;
    return true;
  }
  if (totalEntropyBits(v) < 40) return true;
  return false;
}

function mask(value) {
  const v = String(value).trim();
  if (v.length <= 8) return "*".repeat(v.length) + `[len=${v.length}]`;
  return `${v.slice(0, 4)}...[len=${v.length}]`;
}

function matches(text) {
  const out = [];
  for (const rule of ALL_RULES) {
    // Global regexes carry lastIndex between calls; reset or every second scan
    // silently starts mid-string.
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      const val = rule.group ? m[rule.group] : m[0];
      if (val === undefined || val === null) continue;
      // Context measured from the SECRET, not the match start.
      const secretStart = rule.group ? text.indexOf(val, m.index) : m.index;
      if (rule.allowlist && isAllowlisted(val, text.slice(0, secretStart))) continue;
      out.push({ rule, value: val, start: secretStart, end: secretStart + val.length });
      if (m[0] === "") rule.pattern.lastIndex++; // zero-length guard
    }
  }
  return out;
}

export function scan(text) {
  const empty = { verdict: CLEAN, labels: [], findings: [], shouldRefuse: false, shouldFlag: false };
  if (!text || typeof text !== "string") return empty;

  const hits = matches(text);
  if (!hits.length) return empty;

  const findings = hits.map((h) => ({
    label: h.rule.label,
    severity: h.rule.severity,
    preview: mask(h.value),
  }));
  const hasConfirmed = findings.some((f) => f.severity === CONFIRMED);
  return {
    verdict: hasConfirmed ? CONFIRMED : SUSPECTED,
    labels: [...new Set(findings.map((f) => f.label))],
    findings,
    shouldRefuse: hasConfirmed,
    shouldFlag: true,
  };
}

function mergeSpans(spans) {
  if (!spans.length) return [];
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [spans[0]];
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

function redactTiers(text, severities, replacement) {
  if (!text || typeof text !== "string") return text;
  const spans = matches(text)
    .filter((h) => severities.has(h.rule.severity))
    .map((h) => ({ start: h.start, end: h.end, label: h.rule.label }));
  const merged = mergeSpans(spans);
  let out = text;
  for (const s of merged.reverse()) {
    out = out.slice(0, s.start) + replacement.replace("{label}", s.label) + out.slice(s.end);
  }
  return out;
}

/** Remove CONFIRMED secrets only. For the ingest path. */
export function redact(text, replacement = "[REDACTED:{label}]") {
  return redactTiers(text, new Set([CONFIRMED]), replacement);
}

/** Remove CONFIRMED and SUSPECTED. For anything writing a file to disk. */
export function redactAll(text, replacement = "[REDACTED:{label}]") {
  return redactTiers(text, new Set([CONFIRMED, SUSPECTED]), replacement);
}
