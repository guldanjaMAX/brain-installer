/**
 * report-html: the one file we hand a client.
 *
 *   brain test <manifest> --report brain-report.html
 *
 * This is four things at once, which is why it gets the care it gets.
 *
 *   As a GATE it is what the operator reads at T-2 before anything ships. Not the
 *   pass/fail line: the actual answers to the client's actual questions.
 *   A green suite over answers nobody read is a green suite over nothing.
 *
 *   As a KICKOFF it replaces the terminal. The client opens a browser and the
 *   first thing they see is their own ten questions answered with sources,
 *   which is the difference between "impressive technology" and "it knows my
 *   business".
 *
 *   As an ACCEPTANCE DELIVERABLE it is the record of what was true on handoff
 *   day, including what was missing.
 *
 *   As the ANSWER TO "is it installed yet" it is proof they can re-run
 *   themselves, forever, after our token is revoked.
 *
 * Constraints that follow from that last sentence, and are not negotiable:
 *
 *   ONE FILE. No CDN, no webfont, no image host, no script. It has to open
 *   from a thumb drive, on a plane, in five years, on a machine that has never
 *   heard of us. Everything here is inline and static.
 *
 *   EVERY INTERPOLATION IS REDACTED THEN ESCAPED. The content is the client's
 *   own documents, which means it is untrusted input to this renderer. A
 *   document titled with a script tag must render as text, and a document that
 *   somehow carries an API key must not put it in a file that then gets
 *   emailed around. The ingest gate is the first defense and this is the
 *   second, implemented separately on purpose: two independent checks fail
 *   independently, one shared helper fails once for both.
 *
 * The rendering half is pure and synchronous so it can be tested without a
 * live install. Collection is separate and does the network.
 */

import { Acceptance } from "./acceptance.mjs";
import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";

/* ------------------------------------------------------------- escaping */

/**
 * The single quote matters as much as the double: an attribute written with
 * single quotes is just as breakable, and a renderer that is only safe when
 * you remember which quote style you used is not safe.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Credential shapes, deliberately duplicated rather than imported from the
 * worker's ingest gate. See the header: independent defenses.
 *
 * Only .replace() is used with these. A global regex carries lastIndex between
 * calls, so .test() on one of these would pass every other time, which is the
 * bug that already bit the scanner port once.
 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "openai key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, "api key"],
  [/\bcfut_[A-Za-z0-9_-]{20,}/g, "cloudflare token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws key id"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google api key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "slack token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "github token"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "stripe key"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g, "resend key"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "signed token"],
  [/\b(?:bearer|authorization:)\s+[A-Za-z0-9._-]{20,}/gi, "bearer token"],
  [
    /\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9._+/-]{16,}["']?/gi,
    "secret",
  ],
];

/**
 * Replace anything credential-shaped with a label naming the kind.
 *
 * Naming the kind rather than dropping it silently is the point: the reader
 * needs to know a secret is sitting in that document so they can go remove it
 * from the source, and they cannot act on a blank.
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  for (const [re, label] of SECRET_PATTERNS) text = text.replace(re, `[redacted ${label}]`);
  return text;
}

/** Every piece of data that reaches the page goes through this. No exceptions. */
const h = (value) => escapeHtml(redactSecrets(value));

/* -------------------------------------------------------------- helpers */

const num = (n) => Number(n || 0).toLocaleString("en-US");
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 864e5);
}

function isoDay(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return String(value).slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

function longDate(value) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const arr = (v) => (Array.isArray(v) ? v : []);

/** Our words for a corpus are not the client's words for their own files. */
const FRIENDLY = {
  drive_file: "Documents and files",
  drive_chunk: "Documents and files",
  message: "Messages and email",
  meeting: "Meeting transcripts",
  curated: "Notes and lessons",
  lead: "Contacts",
  email_track: "Tracked emails",
  calendar_event: "Calendar events",
  custom: "Other documents",
};

const CORPUS_LABEL = {
  google_drive: "Google Drive",
  gmail: "Gmail",
  calendar: "Google Calendar",
  slack: "Slack",
  notion: "Notion",
  upload: "Manual uploads",
};

const TIER_NAMES = {
  1: "Reachable and access controlled",
  2: "Data present and current",
  3: "Search and answers working",
  4: "Credential protection active",
  5: "Version and configuration",
};

/** Why a business owner should care that this tier is green. */
const TIER_WHY = {
  1: "If this fails the brain is either down or, worse, answering without a key, which would make your records public.",
  2: "An empty or stale brain does not warn you. It answers from old information and sounds just as sure.",
  3: "This runs on your own questions rather than generic ones, because passing a generic search proves nothing about yours.",
  4: "Anything shaped like a password or an API key is refused at the door instead of being stored and later quoted back.",
  5: "The install is on the version we shipped, and a daily ceiling means a runaway process cannot become a surprise bill.",
};

/**
 * A refusal is the brain saying it does not know. That is the product working,
 * not failing, and the report has to tell the two apart or the honest answer
 * gets counted as a miss.
 */
// The adverb slot is the part that was missing. Every refusal sampled from the
// live brain used "the documents do not contain ...", which the original
// pattern caught, but the model also writes "do not ACTUALLY answer" and "do
// not DIRECTLY address", and an adverb between the negation and the verb made
// those read as confident answers. One optional word closes it.
//
// Widened only as far as observed output justifies. Every phrasing here was
// either sampled from this brain or seen in this session; none was invented,
// because a refusal detector tuned to imagined language mislabels real language.
// Anchored to the SUBJECT, because the verb alone is ambiguous. "Eli does not
// answer the phone on weekends [4]" is a real cited answer, and the earlier
// unanchored pattern read it as the brain refusing. A refusal is always ABOUT
// the sources, so the sources have to be the thing doing the not-containing.
const REFUSAL_SUBJECTED =
  /\b(documents?|sources?|records?|files?|notes?|transcripts?|materials?|brain|context)\b[^.!?]{0,40}?\bdo(es)? not (?:\w+ly )?(contain|answer|address|specify|mention|state|say|indicate)\b/i;

// Phrasings that need no subject because nothing else says them.
const REFUSAL_STANDALONE =
  /\b(there (?:is|are) no (?:information|record|mention|details?|evidence)|nothing (?:recorded|found|on this)|cannot be answered|not (?:enough|sufficient) (?:information|detail)|i (?:do not|don't) have (?:enough )?(?:information|any record))\b/i;

/**
 * A refusal cites nothing, because it makes no claim to support. So an answer
 * carrying [n] markers is an answer even when it contains hedging language,
 * which is the cheapest and most reliable discriminator available.
 */
const REFUSAL = {
  test(s) {
    const text = String(s || "");
    if (/\[\d+\]/.test(text)) return false;
    return REFUSAL_SUBJECTED.test(text) || REFUSAL_STANDALONE.test(text);
  },
};

function classifyAnswer(a) {
  if (!a || typeof a !== "object") return "error";
  if (a.error) return "error";
  const count = Number(
    a.resultCount ?? a.results_count ?? (Array.isArray(a.results) ? a.results.length : 0)
  );
  const cites = arr(a.citations).length;
  if (!count && !cites) return "no_sources";
  if (!a.answer) return "unavailable";
  if (REFUSAL.test(String(a.answer))) return "refused";
  return "answered";
}

const STATUS_COPY = {
  answered: ["pass", "Answered from your own documents"],
  refused: ["warn", "The brain said it does not know"],
  no_sources: ["fail", "Nothing found"],
  unavailable: ["warn", "Sources found, answer could not be generated"],
  error: ["fail", "This check could not run"],
};

/* -------------------------------------------------------------- verdict */

function computeVerdict({ acceptance, acceptanceError, seeds }) {
  const counts = acceptance?.counts || null;
  const answered = seeds.filter((s) => classifyAnswer(s) === "answered").length;
  const sourced = seeds.filter((s) => classifyAnswer(s) !== "no_sources" && classifyAnswer(s) !== "error").length;

  const parts = [];
  if (counts) {
    const total = counts.pass + counts.fail + counts.warn + counts.skip;
    parts.push(`${counts.pass} of ${total} checks passed.`);
  }
  if (seeds.length) {
    parts.push(
      `${answered} of ${seeds.length} of your questions ${plural(seeds.length, "was", "were")} answered from your own documents.`
    );
  }

  // An incomplete run can never read as green, whatever the tiers that did
  // finish happened to say.
  if (acceptanceError) {
    return {
      state: counts && counts.fail > 0 ? "blocked" : "attention",
      line: "The verification run did not finish, so this report cannot confirm the install is working.",
      detail: `It stopped with: ${acceptanceError}. ${parts.join(" ")}`.trim(),
    };
  }
  if (!acceptance) {
    return {
      state: "unknown",
      line: "The verification checks were not run, so this report cannot tell you whether the brain is working.",
      detail: parts.join(" "),
    };
  }
  if (acceptance.stoppedAtTier === 1) {
    // Down and wide open are both tier 1 failures and they could not be more
    // different to the person reading this. One is an outage. The other is
    // their private records being served to anyone who asks.
    const broken = arr(acceptance.results).filter((r) => r.tier === 1 && r.status === "fail");
    const unreachable = broken.some((r) => /health/i.test(r.name));
    const openDoor = broken.some((r) => /unauthenticated|wrong key/i.test(r.name));
    return {
      state: "blocked",
      line: unreachable
        ? "Not ready. The brain did not respond at all."
        : openDoor
          ? "Not ready. The brain is answering without a key, so anyone who finds the address can read it."
          : "Not ready. The install failed the first checks.",
      detail: "Everything after this was skipped on purpose. Until it is fixed, the later results would be noise rather than signal.",
    };
  }
  if (counts.fail > 0) {
    return {
      state: "blocked",
      line: `Not ready. ${counts.fail} ${plural(counts.fail, "check", "checks")} failed.`,
      detail: parts.join(" "),
    };
  }
  if (seeds.length && answered === 0) {
    return {
      state: "attention",
      line: "The checks pass, but none of your questions came back with an answer from your documents yet.",
      detail: parts.join(" "),
    };
  }
  if (counts.warn > 0 || sourced < seeds.length) {
    const n = counts.warn + (seeds.length - sourced);
    return {
      state: "attention",
      line: `Working, with ${n} ${plural(n, "thing", "things")} worth knowing about.`,
      detail: parts.join(" "),
    };
  }
  return {
    state: "ready",
    line: "Ready. Everything checked out.",
    detail: parts.join(" "),
  };
}

const VERDICT_WORD = {
  ready: "READY",
  attention: "WORKING",
  blocked: "NOT READY",
  unknown: "NOT VERIFIED",
};

/* ------------------------------------------------------- answer rendering */

const withCitationMarkers = (escaped) =>
  escaped.replace(/\[(\d{1,2})\]/g, '<sup class="cite">$1</sup>');

/**
 * The answer arrives as loose text from an LLM. Escape first, then add the
 * only markup we introduce, so nothing in the source text can become a tag.
 */
function renderAnswerBody(raw) {
  const text = redactSecrets(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const BULLET = /^([-*•]|\d+[.)])\s+/;
  const out = [];

  for (const block of text.split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    // A model answering "what did we promise" usually writes a lead-in line
    // and then bullets, in one block. Treating the block as all-or-nothing
    // printed the dashes as literal text, so runs are grouped instead.
    let prose = [];
    let bullets = [];

    const flushProse = () => {
      if (!prose.length) return;
      const body = withCitationMarkers(escapeHtml(prose.join("\n")).replace(/\n/g, "<br>"));
      // The worker asks for a trailing "Heads up:" line only when a real gap
      // affects trust in the answer above it. That earns its own styling.
      out.push(/^heads up:/i.test(prose[0]) ? `<p class="headsup">${body}</p>` : `<p>${body}</p>`);
      prose = [];
    };
    const flushBullets = () => {
      if (!bullets.length) return;
      const ordered = bullets.every((l) => /^\d+[.)]\s+/.test(l));
      const items = bullets
        .map((l) => `<li>${withCitationMarkers(escapeHtml(l.replace(BULLET, "")))}</li>`)
        .join("");
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="answer-list">${items}</${tag}>`);
      bullets = [];
    };

    for (const line of lines) {
      if (BULLET.test(line)) {
        flushProse();
        bullets.push(line);
      } else {
        flushBullets();
        prose.push(line);
      }
    }
    flushProse();
    flushBullets();
  }
  return out.join("");
}

function renderCitations(citations) {
  const list = arr(citations);
  if (!list.length) return "";
  const items = list
    .map((c) => {
      const meta = [c.source, isoDay(c.ts)].filter(Boolean).join(", ");
      const ref = c.ref ? `<span class="cite-ref">${h(c.ref)}</span>` : "";
      return (
        `<li><span class="cite-n">${h(c.n)}</span>` +
        `<span class="cite-body"><span class="cite-title">${h(c.title || "untitled")}</span>` +
        (meta ? `<span class="cite-meta">${h(meta)}</span>` : "") +
        ref +
        `</span></li>`
      );
    })
    .join("");
  return `<div class="cites"><p class="cites-head">Sources</p><ol class="cite-list">${items}</ol></div>`;
}

function renderQuestionCard(seed, index) {
  const kind = classifyAnswer(seed);
  const [tone, label] = STATUS_COPY[kind];
  const question = seed?.question ?? seed?.q ?? "";

  let body;
  if (kind === "error") {
    body = `<p class="muted">${h(seed.error || "the request did not complete")}</p>`;
  } else if (kind === "no_sources") {
    body = `<p class="muted">Nothing in the indexed material matched this question. It is listed again under what your brain does not know.</p>`;
  } else if (kind === "unavailable") {
    body =
      `<p class="muted">Sources were found, but no written answer was produced` +
      (seed.answer_error ? `: ${h(seed.answer_error)}` : ".") +
      `</p>`;
  } else {
    body = renderAnswerBody(seed.answer);
  }

  return (
    `<article class="qa">` +
    `<div class="qa-head"><span class="qa-n">${index + 1}</span>` +
    `<h3 class="qa-q">${h(question)}</h3></div>` +
    `<span class="pill pill-${tone}">${h(label)}</span>` +
    `<div class="qa-a">${body}</div>` +
    renderCitations(seed?.citations) +
    `</article>`
  );
}

/* ------------------------------------------------------------- gap list */

function buildGaps({ seeds, corpus, manifest }) {
  const items = [];

  for (const s of seeds) {
    const kind = classifyAnswer(s);
    const q = s?.question ?? s?.q ?? "";
    if (kind === "no_sources") {
      items.push({
        tone: "fail",
        title: "No sources at all",
        detail: `Your question "${q}" matched nothing in the indexed material. Either the source that answers it is not connected yet, or it is not written down anywhere.`,
      });
    } else if (kind === "refused") {
      items.push({
        tone: "warn",
        title: "Answered with an honest no",
        detail: `Documents matched "${q}", but the brain would not claim an answer from them. That is the intended behaviour: it refuses rather than guessing.`,
      });
    }
  }

  // The computed gaps travel with each answer. The same one usually fires on
  // several questions, and repeating it five times reads as five problems.
  const seen = new Set();
  for (const s of seeds) {
    for (const g of arr(s?.gaps)) {
      const detail = String(g?.detail || "").trim();
      if (!detail || seen.has(detail)) continue;
      seen.add(detail);
      // A search that could not run outranks every housekeeping note in this
      // list. It is the one gap that means an answer on this page may be
      // absent rather than merely thin.
      const tone = g?.type === "search_unavailable" ? "fail" : "warn";
      items.push({ tone, title: gapTitle(g?.type), detail });
    }
  }

  const corpora = manifest?.corpora || {};
  const off = Object.keys(corpora)
    .filter((k) => !k.startsWith("_") && corpora[k] && corpora[k].enabled === false)
    .map((k) => CORPUS_LABEL[k] || k);
  if (off.length) {
    items.push({
      tone: "info",
      title: "Not connected",
      detail: `Nothing from ${off.join(", ")} is in the brain, so it cannot answer from any of it. Connecting a source is a change we make on request, not something the brain does on its own.`,
    });
  }

  const excluded = [
    ...arr(manifest?.safety?.private_path_prefixes),
    ...arr(manifest?.corpora?.google_drive?.exclude_paths),
    ...arr(manifest?.corpora?.google_drive?.exclude_name_parts),
  ];
  if (excluded.length) {
    items.push({
      tone: "info",
      title: "Deliberately excluded",
      detail: `These were held back at your instruction and were never indexed: ${excluded.join(", ")}.`,
    });
  }

  for (const row of arr(corpus?.rows)) {
    const d = daysSince(row?.last_ingested);
    if (d !== null && d > 14) {
      const label = FRIENDLY[row.source_type] || row.source_type;
      items.push({
        tone: "warn",
        title: "Behind on updates",
        detail: `${label}: nothing new has come in for ${d} days. Anything added since then will not appear in an answer, and the brain will not mention that mid answer.`,
      });
    }
  }

  // Severity first. A question that returned nothing at all is a different
  // order of problem than a source nobody asked us to connect, and burying it
  // under the housekeeping is how a real gap gets skimmed past.
  const rank = { fail: 0, warn: 1, info: 2 };
  return items.sort((a, b) => (rank[a.tone] ?? 3) - (rank[b.tone] ?? 3));
}

const GAP_TITLES = {
  stale: "Newest source is old",
  undated: "No dates on the sources",
  partially_undated: "Some sources carry no date",
  thin_coverage: "Very few matching sources",
  single_corpus: "Everything came from one place",
  no_results: "Nothing matched",
  // Not the same thing as "nothing matched", and the report must not let a
  // reader collapse the two.
  search_unavailable: "The search could not be completed",
};
const gapTitle = (type) => GAP_TITLES[type] || "Worth knowing";

function renderGapList(items) {
  if (!items.length) {
    return `<p class="empty">No gaps were detected on this run. That is a statement about these questions on this day, not a promise that the brain knows everything.</p>`;
  }
  return (
    `<ul class="gaps">` +
    items
      .map(
        (g) =>
          `<li class="gap gap-${g.tone}"><span class="gap-title">${h(g.title)}</span>` +
          `<span class="gap-detail">${h(g.detail)}</span></li>`
      )
      .join("") +
    `</ul>`
  );
}

function renderExpectedToFail(expected) {
  if (!expected.length) return "";
  const rows = expected
    .map((e) => {
      const q = typeof e === "string" ? e : (e?.question ?? e?.q ?? "");
      const kind = typeof e === "string" ? null : classifyAnswer(e);
      let outcome;
      let tone;
      if (kind === null || kind === "error") {
        outcome = "Not re-run for this report.";
        tone = "info";
      } else if (kind === "answered") {
        outcome = "It answered anyway, with sources. Read that answer carefully before trusting it: you expected this one to be beyond the material.";
        tone = "pass";
      } else if (kind === "refused") {
        outcome = "It said it does not know, exactly as you predicted.";
        tone = "warn";
      } else if (kind === "unavailable") {
        outcome = "Sources matched, but no written answer was produced.";
        tone = "warn";
      } else {
        outcome = "Nothing matched, exactly as you predicted.";
        tone = "warn";
      }
      return (
        `<li class="predict predict-${tone}">` +
        `<span class="predict-q">${h(q)}</span>` +
        `<span class="predict-o">${h(outcome)}</span>` +
        (kind === "answered" && !(typeof e === "string") && e.answer
          ? `<div class="predict-a">${renderAnswerBody(e.answer)}</div>`
          : "") +
        `</li>`
      );
    })
    .join("");

  return (
    `<div class="subsection">` +
    `<h3>The ones you predicted it would miss</h3>` +
    `<p class="lede">You named these at intake, before anything was indexed. Calling the misses in advance is what turns this list into a calibration rather than a failure report.</p>` +
    `<ul class="predicts">${rows}</ul></div>`
  );
}

/* ------------------------------------------------------------- coverage */

function renderCoverage(corpus, manifest) {
  const rows = arr(corpus?.rows).slice().sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
  if (!rows.length) {
    return `<p class="empty">No corpus summary was available when this report ran, so what is indexed could not be listed.</p>`;
  }

  const total = rows.reduce((a, r) => a + Number(r.total || 0), 0);
  const embedded = rows.reduce((a, r) => a + Number(r.embedded || 0), 0);

  const body = rows
    .map((r) => {
      const label = FRIENDLY[r.source_type] || r.source_type;
      const t = Number(r.total || 0);
      const e = Number(r.embedded || 0);
      const readyPct = t ? Math.round((e / t) * 100) : 0;
      const d = daysSince(r.last_ingested);
      const fresh =
        d === null
          ? "not reported"
          : d === 0
            ? "today"
            : `${d} ${plural(d, "day", "days")} ago`;
      const toneClass = d === null ? "" : d <= 2 ? " fresh-ok" : d <= 14 ? " fresh-warn" : " fresh-bad";
      return (
        `<tr><td>${h(label)}</td>` +
        `<td class="n">${h(num(t))}</td>` +
        `<td class="n">${h(readyPct)}%</td>` +
        `<td class="${toneClass.trim()}">${h(fresh)}</td></tr>`
      );
    })
    .join("");

  const pending = total - embedded;
  const note = pending > 0
    ? `<p class="note">${h(num(pending))} ${plural(pending, "item is", "items are")} still being processed. Until that finishes they will not turn up in an answer.</p>`
    : "";

  const on = Object.keys(manifest?.corpora || {})
    .filter((k) => !k.startsWith("_") && manifest.corpora[k] && manifest.corpora[k].enabled === true)
    .map((k) => CORPUS_LABEL[k] || k);
  const connected = on.length
    ? `<p class="note">Connected sources: ${h(on.join(", "))}.</p>`
    : "";

  return (
    `<p class="big-number">${h(num(total))} <span>${plural(total, "item", "items")} indexed</span></p>` +
    connected +
    `<div class="table-wrap"><table><thead><tr><th>Kind</th><th class="n">How many</th><th class="n">Searchable</th><th>Last update</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    note
  );
}

/* ------------------------------------------------------------ the checks */

function renderChecks(acceptance, acceptanceError) {
  const notice = acceptanceError
    ? `<div class="empty"><p><b>The run stopped before it finished.</b></p>` +
      `<p>It ended with: ${h(acceptanceError)}</p>` +
      `<p>Any tier missing below was never reached, so treat its absence as unknown rather than as passing.</p></div>`
    : "";
  if (!acceptance) {
    return notice || `<p class="empty">The verification suite did not run for this report.</p>`;
  }
  const results = arr(acceptance.results);
  if (!results.length) return notice || `<p class="empty">The verification suite produced no results.</p>`;

  const tiers = [];
  let current = null;
  for (const r of results) {
    if (!current || current.tier !== r.tier) {
      current = { tier: r.tier, rows: [] };
      tiers.push(current);
    }
    current.rows.push(r);
  }

  return notice + tiers
    .map((t) => {
      const worst = t.rows.some((r) => r.status === "fail")
        ? "fail"
        : t.rows.some((r) => r.status === "warn")
          ? "warn"
          : t.rows.every((r) => r.status === "skip")
            ? "skip"
            : "pass";
      const rows = t.rows
        .map(
          (r) =>
            `<li class="check check-${h(r.status)}">` +
            `<span class="pill pill-${h(r.status)}">${h(String(r.status).toUpperCase())}</span>` +
            `<span class="check-body"><span class="check-name">${h(r.name)}</span>` +
            (r.detail ? `<span class="check-detail">${h(r.detail)}</span>` : "") +
            `</span></li>`
        )
        .join("");
      return (
        `<div class="tier tier-${worst}">` +
        `<h3><span class="tier-n">Tier ${h(t.tier)}</span>${h(TIER_NAMES[t.tier] || "Checks")}</h3>` +
        (TIER_WHY[t.tier] ? `<p class="tier-why">${h(TIER_WHY[t.tier])}</p>` : "") +
        `<ul class="checks">${rows}</ul></div>`
      );
    })
    .join("");
}

/* ------------------------------------------------------------------ css */

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --bg:#faf9f7;--panel:#fff;--panel2:#f4f2ee;--ink:#1b1a18;--muted:#5f5b55;--line:#e2ddd4;
  --accent:#8a4b22;
  --pass-fg:#14572f;--pass-bg:#e6f2ea;--pass-line:#b4d6c1;
  --fail-fg:#8a1c1c;--fail-bg:#fbe9e9;--fail-line:#e6b9b9;
  --warn-fg:#7a5210;--warn-bg:#fdf2df;--warn-line:#e7d1a4;
  --skip-fg:#54514c;--skip-bg:#efedea;--skip-line:#dad5cd;
  --info-fg:#1f4a63;--info-bg:#e7f0f5;--info-line:#b9d2e0;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#131417;--panel:#1b1d21;--panel2:#212429;--ink:#e9e6e1;--muted:#a5a099;--line:#31343a;
    --accent:#e0965d;
    --pass-fg:#8fe0ae;--pass-bg:#16281d;--pass-line:#2c4a37;
    --fail-fg:#ffa5a5;--fail-bg:#2b1717;--fail-line:#563030;
    --warn-fg:#f2ce8a;--warn-bg:#2a2214;--warn-line:#544628;
    --skip-fg:#adaaa4;--skip-bg:#232528;--skip-line:#3b3e43;
    --info-fg:#9dcbe6;--info-bg:#16242c;--info-line:#2c4453;
  }
}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:54rem;margin:0 auto;padding:2.5rem 1.15rem 5rem}
h1,h2,h3{line-height:1.25;letter-spacing:-0.01em}
h1{font-size:2rem;margin:.2rem 0 .35rem}
h2{font-size:1.3rem;margin:0 0 .35rem}
h3{font-size:1.02rem;margin:0 0 .4rem}
p{margin:0 0 .8rem}
.eyebrow{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
.sub{color:var(--muted);font-size:.92rem}
.lede{color:var(--muted);margin-bottom:1.1rem}
.muted{color:var(--muted)}
.empty{color:var(--muted);background:var(--panel2);border:1px solid var(--line);
  border-radius:10px;padding:.9rem 1rem;margin:0}
.note{color:var(--muted);font-size:.9rem}

.verdict{border:1px solid var(--line);border-left-width:6px;border-radius:12px;
  background:var(--panel);padding:1.1rem 1.2rem;margin:1.3rem 0 1.6rem}
.verdict-word{font-size:.72rem;letter-spacing:.16em;font-weight:700;text-transform:uppercase;display:block;margin-bottom:.3rem}
.verdict-line{font-size:1.22rem;font-weight:650;margin:0 0 .35rem}
.verdict-detail{margin:0;color:var(--muted);font-size:.93rem}
.v-ready{border-left-color:var(--pass-line);background:var(--pass-bg)}
.v-ready .verdict-word{color:var(--pass-fg)}
.v-attention{border-left-color:var(--warn-line);background:var(--warn-bg)}
.v-attention .verdict-word{color:var(--warn-fg)}
.v-blocked{border-left-color:var(--fail-line);background:var(--fail-bg)}
.v-blocked .verdict-word{color:var(--fail-fg)}
.v-unknown{border-left-color:var(--skip-line);background:var(--skip-bg)}
.v-unknown .verdict-word{color:var(--skip-fg)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.6rem;margin:0 0 2.2rem}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.75rem .85rem}
.stat b{display:block;font-size:1.45rem;line-height:1.2;font-weight:650}
.stat span{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

section{margin:0 0 2.6rem}
.section-head{border-top:1px solid var(--line);padding-top:1.4rem;margin-bottom:1.1rem}
.subsection{margin-top:2rem}

.qa{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:1.05rem 1.15rem;margin:0 0 .85rem}
.qa-head{display:flex;gap:.6rem;align-items:baseline}
.qa-n{color:var(--accent);font-weight:700;font-size:.9rem;flex:0 0 auto}
.qa-q{font-size:1.05rem;font-weight:650;margin:0}
.qa-a{margin-top:.6rem}
.qa-a p{margin:0 0 .65rem}
.qa-a p:last-child{margin-bottom:0}
.answer-list{margin:.2rem 0 .65rem;padding-left:1.1rem}
.answer-list li{margin-bottom:.25rem}
.headsup{border-left:3px solid var(--warn-line);background:var(--warn-bg);color:var(--warn-fg);
  padding:.5rem .7rem;border-radius:0 8px 8px 0;font-size:.92rem}
.cite{color:var(--accent);font-weight:700;font-size:.7em;padding:0 .08em}

.pill{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.07em;
  text-transform:uppercase;padding:.16rem .5rem;border-radius:999px;border:1px solid;margin-top:.5rem}
.pill-pass{color:var(--pass-fg);background:var(--pass-bg);border-color:var(--pass-line)}
.pill-fail{color:var(--fail-fg);background:var(--fail-bg);border-color:var(--fail-line)}
.pill-warn{color:var(--warn-fg);background:var(--warn-bg);border-color:var(--warn-line)}
.pill-skip{color:var(--skip-fg);background:var(--skip-bg);border-color:var(--skip-line)}

.cites{margin-top:.85rem;border-top:1px dashed var(--line);padding-top:.65rem}
.cites-head{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .4rem}
.cite-list{list-style:none;margin:0;padding:0}
.cite-list li{display:flex;gap:.55rem;margin-bottom:.4rem;font-size:.88rem}
.cite-n{flex:0 0 1.35rem;height:1.35rem;border-radius:50%;background:var(--panel2);border:1px solid var(--line);
  color:var(--accent);font-weight:700;font-size:.72rem;display:flex;align-items:center;justify-content:center}
.cite-body{display:flex;flex-direction:column;min-width:0}
.cite-title{font-weight:550;overflow-wrap:anywhere}
.cite-meta{color:var(--muted);font-size:.8rem}
.cite-ref{color:var(--muted);font-size:.74rem;overflow-wrap:anywhere;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.gaps{list-style:none;margin:0;padding:0}
.gap{background:var(--panel);border:1px solid var(--line);border-left-width:5px;border-radius:10px;
  padding:.75rem .9rem;margin-bottom:.55rem;display:flex;flex-direction:column;gap:.15rem}
.gap-title{font-weight:650;font-size:.95rem}
.gap-detail{color:var(--muted);font-size:.92rem}
.gap-fail{border-left-color:var(--fail-line)}
.gap-fail .gap-title{color:var(--fail-fg)}
.gap-warn{border-left-color:var(--warn-line)}
.gap-warn .gap-title{color:var(--warn-fg)}
.gap-info{border-left-color:var(--info-line)}
.gap-info .gap-title{color:var(--info-fg)}

.predicts{list-style:none;margin:0;padding:0}
.predict{background:var(--panel2);border:1px solid var(--line);border-radius:10px;
  padding:.8rem .95rem;margin-bottom:.55rem;display:flex;flex-direction:column;gap:.3rem}
.predict-q{font-weight:650}
.predict-o{color:var(--muted);font-size:.92rem}
.predict-a{border-top:1px dashed var(--line);padding-top:.5rem;font-size:.93rem}
.predict-pass{border-left:5px solid var(--pass-line)}
.predict-warn{border-left:5px solid var(--warn-line)}
.predict-info{border-left:5px solid var(--skip-line)}

.big-number{font-size:1.9rem;font-weight:650;margin:0 0 .5rem}
.big-number span{font-size:1rem;font-weight:400;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--line)}
th{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.fresh-ok{color:var(--pass-fg)}
.fresh-warn{color:var(--warn-fg)}
.fresh-bad{color:var(--fail-fg);font-weight:600}

.tier{background:var(--panel);border:1px solid var(--line);border-left-width:5px;
  border-radius:12px;padding:.95rem 1.05rem;margin-bottom:.75rem}
.tier-pass{border-left-color:var(--pass-line)}
.tier-warn{border-left-color:var(--warn-line)}
.tier-fail{border-left-color:var(--fail-line)}
.tier-skip{border-left-color:var(--skip-line)}
.tier-n{display:block;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}
.tier-why{color:var(--muted);font-size:.88rem;margin:0 0 .7rem}
.checks{list-style:none;margin:0;padding:0}
.check{display:flex;gap:.6rem;align-items:flex-start;padding:.4rem 0;border-top:1px solid var(--line)}
.check .pill{margin-top:.1rem;flex:0 0 auto;min-width:3.4rem;text-align:center}
.check-body{display:flex;flex-direction:column;min-width:0}
.check-name{font-size:.95rem}
.check-detail{color:var(--muted);font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}

footer{border-top:1px solid var(--line);padding-top:1.2rem;color:var(--muted);font-size:.88rem}
footer b{color:var(--ink)}
.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;
  background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:.1rem .4rem;overflow-wrap:anywhere}

@media (max-width:34rem){
  main{padding:1.6rem .85rem 3.5rem}
  h1{font-size:1.55rem}
  .verdict-line{font-size:1.08rem}
  .big-number{font-size:1.5rem}
  .check{flex-direction:column;gap:.2rem}
}
@media print{
  :root{--bg:#fff;--panel:#fff;--panel2:#fff;--ink:#000;--muted:#333;--line:#bbb}
  body{font-size:11pt}
  main{max-width:none;padding:0}
  .qa,.tier,.gap,.predict,.stat,.verdict{break-inside:avoid;page-break-inside:avoid}
  section{break-inside:auto}
  h2{break-after:avoid}
}
`;

/* ---------------------------------------------------------------- render */

/**
 * Pure. No network, no clock beyond generatedAt, no filesystem. That is what
 * makes the whole document testable from a fixture.
 */
export function renderReportHtml(data) {
  const d = data && typeof data === "object" ? data : {};
  const manifest = d.manifest && typeof d.manifest === "object" ? d.manifest : {};
  const acceptance = d.acceptance || null;
  const acceptanceError = d.acceptanceError || null;
  const seeds = arr(d.seedAnswers);
  const expected = arr(d.expectedToFail);
  const corpus = d.corpus || null;
  const installState = d.installState || null;
  const generatedAt = d.generatedAt || new Date();

  const clientName = manifest.client?.display_name || manifest.client?.slug || "";
  const title = clientName ? `${clientName} brain: verification report` : "Brain verification report";

  const verdict = computeVerdict({ acceptance, acceptanceError, seeds });
  const gaps = buildGaps({ seeds, corpus, manifest });

  const counts = acceptance?.counts || { pass: 0, fail: 0, warn: 0, skip: 0 };
  const checkTotal = counts.pass + counts.fail + counts.warn + counts.skip;
  const answered = seeds.filter((s) => classifyAnswer(s) === "answered").length;
  const indexed = arr(corpus?.rows).reduce((a, r) => a + Number(r.total || 0), 0);
  const connectedCount = Object.keys(manifest.corpora || {}).filter(
    (k) => !k.startsWith("_") && manifest.corpora[k] && manifest.corpora[k].enabled === true
  ).length;

  const stats =
    `<div class="stats">` +
    `<div class="stat"><b>${h(counts.pass)}/${h(checkTotal)}</b><span>checks passed</span></div>` +
    (seeds.length
      ? `<div class="stat"><b>${h(answered)}/${h(seeds.length)}</b><span>questions answered</span></div>`
      : `<div class="stat"><b>none</b><span>questions captured</span></div>`) +
    `<div class="stat"><b>${h(num(indexed))}</b><span>items indexed</span></div>` +
    `<div class="stat"><b>${h(connectedCount)}</b><span>${plural(connectedCount, "source connected", "sources connected")}</span></div>` +
    `</div>`;

  /* section 2: their questions. The reason this document exists. */
  const questions = seeds.length
    ? seeds.map((s, i) => renderQuestionCard(s, i)).join("")
    : `<div class="empty"><p><b>No seed questions were captured for this install.</b></p>` +
      `<p>This section is the point of the report: your own questions, answered from your own material, ` +
      `with the sources named. Without them, everything below proves the machinery runs but not that it is useful to you.</p>` +
      `<p>Send us ten questions you would ask a perfect assistant who had read everything. ` +
      `They go in the manifest under testing.probe_questions, in your words rather than tidied up, ` +
      `and the next run of this report answers them.</p></div>`;

  const versionBits = [];
  if (installState?.product_version) versionBits.push(`Running version <b>${h(installState.product_version)}</b>.`);
  if (installState?.schema_version) versionBits.push(`Database schema ${h(installState.schema_version)}.`);
  if (manifest.safety?.daily_llm_spend_cap_usd) {
    versionBits.push(
      `A daily ceiling of $${h(manifest.safety.daily_llm_spend_cap_usd)} on answer generation is in force, so a runaway process cannot turn into a surprise bill.`
    );
  }

  const generatedLabel = longDate(generatedAt);
  const baseLabel = d.base ? String(d.base) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${h(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">Verification report</p>
<h1>${h(clientName ? clientName + " brain" : "Your brain")}</h1>
<p class="sub">${h(generatedLabel ? "Generated " + generatedLabel + "." : "")} Every line below came from running live checks against your own installation${baseLabel ? ", at " + h(baseLabel) : ""}.</p>
<div class="verdict v-${h(verdict.state)}">
<span class="verdict-word">${h(VERDICT_WORD[verdict.state])}</span>
<p class="verdict-line">${h(verdict.line)}</p>
<p class="verdict-detail">${h(verdict.detail)}</p>
</div>
${stats}
</header>

<section id="questions">
<div class="section-head"><h2>Your questions, answered</h2>
<p class="lede">These are the questions you gave us at intake, in your words. Each answer below was produced by your brain from your own material, and every claim it makes names the document it came from.</p></div>
${questions}
</section>

<section id="gaps">
<div class="section-head"><h2>What your brain does not know</h2>
<p class="lede">A tool that tells you where it is blind is worth more than one that always sounds sure. This list is generated from the same run as the answers above, not written by hand.</p></div>
${renderGapList(gaps)}
${renderExpectedToFail(expected)}
</section>

<section id="coverage">
<div class="section-head"><h2>What is indexed</h2>
<p class="lede">Everything the brain can currently draw on, and how current each part is. Anything not listed here is not in it.</p></div>
${renderCoverage(corpus, manifest)}
</section>

<section id="checks">
<div class="section-head"><h2>Verification checks</h2>
<p class="lede">Five tiers, run in order. An early failure stops the run because later results would be noise rather than signal.</p></div>
${renderChecks(acceptance, acceptanceError)}
</section>

<footer>
${versionBits.length ? `<p>${versionBits.join(" ")}</p>` : ""}
<p><b>You can run this yourself, at any time.</b> It is one command against your own infrastructure: <span class="cmd">brain test &lt;manifest&gt; --report</span>. Nothing in this report was collected by us and no copy of your material leaves the accounts you own.</p>
<p>This file is self contained. It has no links, no fonts and no code to load, so it will open in any browser, on any machine, with no internet connection, for as long as you keep it.</p>
</footer>
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------ collection */

/**
 * Ask the live install everything the report needs.
 *
 * Each seed question costs one answer generation on the CLIENT's own API key,
 * which is exactly why this is an explicit command rather than a cron. A
 * report that silently spends their money every night is a report they turn
 * off.
 */
export async function collectReportData({
  base,
  adminKey,
  manifest = {},
  installState = null,
  fetchImpl = fetch,
  answerLimit = 8,
}) {
  const root = String(base || "").replace(/\/+$/, "");
  const probes = arr(manifest?.testing?.probe_questions);
  const predicted = arr(manifest?.testing?.expected_to_fail);

  const suite = new Acceptance({ base: root, adminKey, manifest, fetchImpl });
  let acceptance = null;
  let acceptanceError = null;
  try {
    acceptance = await suite.run({ probes, installState });
  } catch (e) {
    // Only tier 1 catches its own transport errors, so one unreachable
    // endpoint anywhere after it throws out of the whole run. Losing the
    // entire document to that is the wrong trade: the tiers that did complete
    // are still true, and "the run stopped here, with this error" is itself a
    // finding worth handing over.
    acceptanceError = e.message;
    acceptance = suite.results?.length ? suite.summary() : null;
  }

  let corpus = null;
  try {
    const res = await fetchBrainWithAdminKey(
      fetchImpl,
      `${root}/api/admin/brain/documents`,
      {},
      () => adminKey,
    );
    if (res.ok) corpus = await res.json();
  } catch {
    // A missing corpus summary is reported as a blank section, never as a
    // crash. The rest of the document is still worth handing over.
  }

  const askOne = async (question) => {
    try {
      const res = await fetchBrainWithAdminKey(fetchImpl, `${root}/api/rag/think`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: question, limit: answerLimit }),
      }, () => adminKey);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        return { question, error: `the brain returned a non-JSON response (HTTP ${res.status})` };
      }
      if (!res.ok) return { question, error: json?.error || `HTTP ${res.status}` };
      return {
        question,
        answer: json.answer || null,
        answer_error: json.answer_error || null,
        citations: json.citations || [],
        gaps: json.gaps || [],
        resultCount: Array.isArray(json.results) ? json.results.length : 0,
      };
    } catch (e) {
      // One unreachable question must not cost the client the other nine.
      return { question, error: e.message };
    }
  };

  const seedAnswers = [];
  for (const q of probes) seedAnswers.push(await askOne(q));
  const expectedToFail = [];
  for (const q of predicted) expectedToFail.push(await askOne(q));

  return {
    manifest,
    acceptance,
    acceptanceError,
    seedAnswers,
    expectedToFail,
    corpus,
    installState,
    base: root,
    generatedAt: new Date(),
  };
}

/** Collect then render. The one call the CLI needs. */
export async function buildHtmlReport(options) {
  const data = await collectReportData(options);
  return { html: renderReportHtml(data), data };
}

export default renderReportHtml;
