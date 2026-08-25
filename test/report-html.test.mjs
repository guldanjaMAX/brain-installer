/**
 * Tests for the HTML verification report.
 *
 * The report is the one artifact that leaves our hands and lives in the
 * client's, so the properties tested here are the ones that would be
 * embarrassing or dangerous to get wrong in a file we cannot recall:
 *
 *   it renders untrusted document content as text, never as markup
 *   it never carries a credential out of the install and into a file
 *   it never depends on anything it would have to fetch
 *   it says "failing" when something is failing
 *   it degrades into a useful document when the interesting data is missing
 *
 * The last block runs the real Acceptance class against a stubbed fetch, so
 * the input shape here is the shape acceptance.mjs actually produces rather
 * than the shape this renderer wishes it produced.
 *
 * Run: node test/report-html.test.mjs
 */

import {
  renderReportHtml,
  collectReportData,
  escapeHtml,
  redactSecrets,
} from "../report-html.mjs";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  " + detail));
  if (!cond) failures++;
};
const has = (html, needle) => html.includes(needle);

/* ------------------------------------------------------------- fixtures */

const cleanManifest = {
  client: { display_name: "Acme Consulting", slug: "acme" },
  brain: { version: "0.2.0", domain: "brain.acme.com" },
  corpora: {
    _comment: "ignored",
    google_drive: { enabled: true, exclude_paths: ["Legal/Sealed"] },
    gmail: { enabled: false },
    calendar: { enabled: false },
    upload: { enabled: true },
  },
  safety: { private_path_prefixes: ["_private"], daily_llm_spend_cap_usd: 10 },
  testing: {
    probe_questions: ["why did we stop using those guys", "what did we promise the Ridgeline people"],
    expected_to_fail: ["what is our headcount plan for 2028"],
  },
};

const passingAcceptance = {
  counts: { pass: 12, fail: 0, warn: 0, skip: 0 },
  passed: true,
  stoppedAtTier: null,
  results: [
    { tier: 1, name: "health responds", status: "pass", detail: "version 0.2.0" },
    { tier: 1, name: "unauthenticated request is refused", status: "pass", detail: "HTTP 401" },
    { tier: 2, name: "corpus is not empty", status: "pass", detail: "4,102 document(s)" },
    { tier: 3, name: "probe coverage", status: "pass", detail: "2/2 probes returned sources" },
    { tier: 4, name: "credential gate refuses a token", status: "pass", detail: "HTTP 422" },
    { tier: 5, name: "schema is migrated", status: "pass", detail: "schema version 2" },
  ],
};

const goodSeeds = [
  {
    question: "why did we stop using those guys",
    answer:
      "The contract was ended in March after two missed delivery windows [1]. Billing disputes over the second invoice were the trigger [2].\n\nHeads up: the newest source here is 41 days old.",
    citations: [
      { n: 1, title: "Vendor review call", source: "meeting", ref: "meetings/2026-03-04", ts: "2026-03-04T00:00:00Z" },
      { n: 2, title: "Invoice dispute thread", source: "message", ref: "gmail/18f2", ts: "2026-03-11T00:00:00Z" },
    ],
    gaps: [{ type: "stale", detail: "Newest source is 41 days old." }],
    resultCount: 6,
  },
  {
    question: "what did we promise the Ridgeline people",
    answer: "Two workshops before the end of Q3 [1].",
    citations: [{ n: 1, title: "Ridgeline SOW", source: "drive", ref: "1AbC", ts: "2026-05-02T00:00:00Z" }],
    gaps: [{ type: "stale", detail: "Newest source is 41 days old." }],
    resultCount: 4,
  },
];

const cleanCorpus = {
  rows: [
    { source_type: "drive_file", total: 2915, embedded: 2915, last_ingested: new Date().toISOString() },
    { source_type: "message", total: 1187, embedded: 1100, last_ingested: new Date(Date.now() - 40 * 864e5).toISOString() },
  ],
};

const cleanReport = renderReportHtml({
  manifest: cleanManifest,
  acceptance: passingAcceptance,
  seedAnswers: goodSeeds,
  expectedToFail: [
    { question: "what is our headcount plan for 2028", answer: "The documents do not contain a headcount plan for 2028.", citations: [{ n: 1, title: "Board deck", source: "drive" }], gaps: [], resultCount: 3 },
  ],
  corpus: cleanCorpus,
  installState: { product_version: "0.2.0", schema_version: 2, gate_version: 2 },
  base: "https://brain.acme.com",
  generatedAt: new Date("2026-08-16T12:00:00Z"),
});

/* ---------------------------------------------------- 1. escaping works */

const XSS = '<script>alert(1)</script>';
const ATTR = '" onload="alert(2)';

const hostileReport = renderReportHtml({
  manifest: {
    client: { display_name: `Acme ${XSS}` },
    corpora: { google_drive: { enabled: true, exclude_paths: [XSS] } },
    safety: { private_path_prefixes: [ATTR] },
  },
  acceptance: {
    counts: { pass: 0, fail: 1, warn: 0, skip: 0 },
    passed: false,
    stoppedAtTier: null,
    results: [{ tier: 4, name: `check ${XSS}`, status: "fail", detail: `detail ${ATTR} ${XSS}` }],
  },
  seedAnswers: [
    {
      question: `question ${XSS}`,
      answer: `answer ${XSS} and <img src=x onerror=alert(3)> and 'quoted'`,
      citations: [{ n: 1, title: `title ${XSS}`, source: `src${ATTR}`, ref: `ref ${XSS}` }],
      gaps: [{ type: "stale", detail: `gap ${XSS}` }],
      resultCount: 2,
    },
  ],
  expectedToFail: [{ question: `predicted ${XSS}`, resultCount: 0 }],
  corpus: { rows: [{ source_type: `kind ${XSS}`, total: 3, embedded: 3, last_ingested: null }] },
  base: `https://evil${XSS}`,
});

check("escapeHtml handles the five dangerous characters",
  escapeHtml(`<&>"'`) === "&lt;&amp;&gt;&quot;&#39;", escapeHtml(`<&>"'`));
check("escapeHtml tolerates null and undefined",
  escapeHtml(null) === "" && escapeHtml(undefined) === "");
check("escapeHtml ampersand runs first, no double escaping",
  escapeHtml("&lt;") === "&amp;lt;", escapeHtml("&lt;"));

check("no live script tag survives from any field",
  !/<\s*script/i.test(hostileReport));
check("no live img tag survives from the answer body",
  !/<\s*img/i.test(hostileReport));
check("the payload is present as visible text",
  has(hostileReport, "&lt;script&gt;alert(1)&lt;/script&gt;"));
check("attribute breaking payload is neutralised",
  !hostileReport.includes('" onload="') && has(hostileReport, "&quot; onload=&quot;"));
check("single quotes in an answer are escaped",
  has(hostileReport, "&#39;quoted&#39;"));

// Every interpolation site, proven individually rather than by one lucky hit.
for (const [site, marker] of [
  ["client name", "Acme &lt;script&gt;"],
  ["question text", "question &lt;script&gt;"],
  ["answer body", "answer &lt;script&gt;"],
  ["citation title", "title &lt;script&gt;"],
  ["citation ref", "ref &lt;script&gt;"],
  ["gap detail", "gap &lt;script&gt;"],
  ["check name", "check &lt;script&gt;"],
  ["check detail", "detail &quot; onload=&quot;"],
  ["corpus source type", "kind &lt;script&gt;"],
  ["excluded path", "&lt;script&gt;alert(1)&lt;/script&gt;"],
  ["expected to fail question", "predicted &lt;script&gt;"],
  ["base url", "evil&lt;script&gt;"],
]) {
  check(`escaped at the ${site}`, has(hostileReport, marker));
}

/* ------------------------------------------ 2. no external references */

const EXTERNAL_TAGS = /<\s*(script|link|img|iframe|object|embed|source|video|audio|frame|applet)\b/i;
check("clean report loads no external tag", !EXTERNAL_TAGS.test(cleanReport));
check("hostile report loads no external tag", !EXTERNAL_TAGS.test(hostileReport));

for (const bad of ["src=", "href=", "@import", "url(", "srcset", "integrity=", "crossorigin"]) {
  check(`no ${bad} anywhere in the clean report`, !cleanReport.includes(bad));
}
check("no protocol relative reference", !/["'(]\/\//.test(cleanReport));
check("no font or cdn host", !/fonts\.|cdn\.|googleapis|unpkg|jsdelivr/i.test(cleanReport));
check("styles are inline in a style block", has(cleanReport, "<style>") && has(cleanReport, "</style>"));

/* ------------------------------------------- 3. a failing tier fails */

const failing = renderReportHtml({
  manifest: cleanManifest,
  acceptance: {
    counts: { pass: 9, fail: 2, warn: 1, skip: 0 },
    passed: false,
    stoppedAtTier: 4,
    results: [
      { tier: 1, name: "health responds", status: "pass", detail: "version 0.2.0" },
      { tier: 3, name: "probe coverage", status: "warn", detail: "1/2 probes returned sources" },
      { tier: 4, name: "credential gate refuses a token", status: "fail", detail: "THE GATE IS NOT ACTIVE" },
      { tier: 4, name: "refusal does not echo the secret", status: "fail", detail: "the error response contained the credential value" },
    ],
  },
  seedAnswers: goodSeeds,
  corpus: cleanCorpus,
});

check("failing check renders a fail pill", has(failing, 'class="pill pill-fail"'));
check("failing tier is marked as a failing tier", has(failing, "tier tier-fail"));
check("the verdict block is the blocked state", has(failing, "verdict v-blocked"));
check("the verdict word says NOT READY", has(failing, ">NOT READY<"));
check("the verdict counts the failures", has(failing, "2 checks failed"));
check("a failing report never claims readiness", !has(failing, "Ready. Everything checked out."));
check("the failing detail text is rendered", has(failing, "THE GATE IS NOT ACTIVE"));
check("a passing report does claim readiness", has(cleanReport, "Ready. Everything checked out."));
check("a passing report shows no fail pill", !has(cleanReport, "pill pill-fail"));

// A tier 1 failure stops the run, and the verdict has to explain the silence
// rather than let a short results list read as a short list of problems.
const doorOpen = renderReportHtml({
  acceptance: {
    counts: { pass: 1, fail: 1, warn: 0, skip: 0 },
    passed: false,
    stoppedAtTier: 1,
    results: [
      { tier: 1, name: "health responds", status: "pass", detail: "version 0.2.0" },
      { tier: 1, name: "unauthenticated request is refused", status: "fail", detail: "HTTP 200" },
    ],
  },
});
// The phrase "answering without a key" also appears in the tier 1 explainer,
// so these assertions read the verdict line itself rather than the document.
const verdictLine = (html) => (html.match(/<p class="verdict-line">([^<]*)/) || [, ""])[1];

check("an open door is named as an open door, not as an outage",
  /answering without a key/.test(verdictLine(doorOpen)) && has(doorOpen, "verdict v-blocked"),
  verdictLine(doorOpen));

const unreachable = renderReportHtml({
  acceptance: {
    counts: { pass: 0, fail: 1, warn: 0, skip: 0 }, passed: false, stoppedAtTier: 1,
    results: [{ tier: 1, name: "health responds", status: "fail", detail: "ENOTFOUND brain.acme.com" }],
  },
});
check("an outage is named as an outage, not as an open door",
  /did not respond at all/.test(verdictLine(unreachable)) &&
  !/answering without a key/.test(verdictLine(unreachable)),
  verdictLine(unreachable));

// Warnings alone must not read as either green or broken.
const warned = renderReportHtml({
  manifest: cleanManifest,
  acceptance: { counts: { pass: 8, fail: 0, warn: 2, skip: 0 }, passed: true, stoppedAtTier: null,
    results: [{ tier: 2, name: "corpus is fresh", status: "warn", detail: "newest ingest 9 day(s) ago" }] },
  seedAnswers: goodSeeds,
  corpus: cleanCorpus,
});
check("warnings render the attention verdict", has(warned, "verdict v-attention") && has(warned, ">WORKING<"));

// Green machinery with zero answered questions is not a green install.
const hollow = renderReportHtml({
  manifest: cleanManifest,
  acceptance: passingAcceptance,
  seedAnswers: [{ question: "why did we stop using those guys", resultCount: 0, citations: [], gaps: [] }],
  corpus: cleanCorpus,
});
check("passing checks with no answered questions is not 'ready'",
  !has(hollow, "Ready. Everything checked out.") && has(hollow, "verdict v-attention"));
check("an unanswered question is named in the gap list", has(hollow, "No sources at all"));

/* ------------------------- 4. empty seed set degrades gracefully */

const noSeeds = renderReportHtml({
  manifest: { client: { display_name: "Acme Consulting" }, corpora: { google_drive: { enabled: true } } },
  acceptance: passingAcceptance,
  seedAnswers: [],
  expectedToFail: [],
  corpus: cleanCorpus,
});

check("empty seeds still renders the questions section", has(noSeeds, 'id="questions"'));
check("empty seeds explains what is missing",
  has(noSeeds, "No seed questions were captured"));
check("empty seeds says what to do about it",
  has(noSeeds, "probe_questions"));
check("empty seeds renders no empty question card", !has(noSeeds, 'class="qa"'));
check("empty seeds renders no empty citation list", !has(noSeeds, "<ol class=\"cite-list\"></ol>"));
check("empty seeds does not claim questions were answered",
  !/of your questions/.test(noSeeds));
check("empty seeds shows no hollow 0/0 tile",
  !has(noSeeds, ">0/0<") && has(noSeeds, "questions captured"));
check("empty seeds still renders coverage and checks",
  has(noSeeds, 'id="coverage"') && has(noSeeds, 'id="checks"'));
check("empty seeds keeps the verdict truthful", has(noSeeds, "verdict v-ready"));
check("empty expected-to-fail renders no prediction block", !has(noSeeds, "predicted it would miss"));

// Nothing at all should still produce a readable document rather than a stack trace.
let bareOk = true;
let bare = "";
try {
  bare = renderReportHtml();
} catch (e) {
  bareOk = false;
  bare = e.message;
}
check("renderReportHtml() with no arguments does not throw", bareOk, bare);
check("the empty document is still well formed",
  bareOk && bare.startsWith("<!doctype html>") && has(bare, "</html>"));
check("the empty document admits it was not verified",
  bareOk && has(bare, "verdict v-unknown") && has(bare, "were not run"));

for (const junk of [null, { seedAnswers: null, acceptance: undefined, corpus: null, manifest: null },
  { seedAnswers: [{}], expectedToFail: [""], corpus: { rows: null } },
  { seedAnswers: ["a raw string, not an object"] }]) {
  let ok = true;
  let msg = "";
  try {
    const out = renderReportHtml(junk);
    ok = typeof out === "string" && out.startsWith("<!doctype html>");
  } catch (e) {
    ok = false;
    msg = e.message;
  }
  check(`malformed input survives: ${JSON.stringify(junk)?.slice(0, 46)}`, ok, msg);
}

/* --------------------------------------------------- 5. no credentials */

const LEAKED = "sk-ant-api03-" + "A".repeat(40);
const leaky = renderReportHtml({
  manifest: { client: { display_name: "Acme" } },
  acceptance: {
    counts: { pass: 0, fail: 1, warn: 0, skip: 0 }, passed: false, stoppedAtTier: null,
    results: [{ tier: 4, name: "credential gate", status: "fail", detail: `stored value ${LEAKED}` }],
  },
  seedAnswers: [
    {
      question: `how do I connect, the key is ${LEAKED}`,
      answer: `Use the key ${LEAKED} and the token cfut_${"b".repeat(40)} [1].`,
      citations: [{ n: 1, title: `creds AKIA${"C".repeat(16)}`, source: "drive", ref: `xoxb-${"9".repeat(24)}` }],
      gaps: [{ type: "stale", detail: `seen in password: ${"z".repeat(24)}` }],
      resultCount: 1,
    },
  ],
  corpus: cleanCorpus,
});

check("an anthropic key in an answer is redacted", !has(leaky, LEAKED) && has(leaky, "[redacted anthropic key]"));
check("an anthropic key in a question is redacted", !has(leaky, LEAKED));
check("a cloudflare token is redacted", has(leaky, "[redacted cloudflare token]"));
check("an aws key id in a citation title is redacted", has(leaky, "[redacted aws key id]"));
check("a slack token in a citation ref is redacted", has(leaky, "[redacted slack token]"));
check("a credential in an acceptance detail is redacted", !has(leaky, LEAKED));
check("a password assignment in a gap detail is redacted", has(leaky, "[redacted secret]"));

check("redactSecrets leaves ordinary prose alone",
  redactSecrets("we agreed the password would be changed on Friday") ===
    "we agreed the password would be changed on Friday");
check("redactSecrets handles a private key block",
  redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----") ===
    "[redacted private key]");
check("redactSecrets is stable across repeated calls",
  redactSecrets(LEAKED) === redactSecrets(LEAKED) && redactSecrets(LEAKED) === "[redacted anthropic key]");
check("redactSecrets tolerates non strings", redactSecrets(null) === "" && redactSecrets(7) === "7");

/* ------------------------------------------------- 6. document shape */

check("starts with a doctype", cleanReport.startsWith("<!doctype html>"));
check("carries a title", /<title>Acme Consulting brain: verification report<\/title>/.test(cleanReport));
check("carries a viewport for phones", has(cleanReport, "width=device-width"));
check("has a dark scheme block", has(cleanReport, "prefers-color-scheme:dark"));
check("has a print block", has(cleanReport, "@media print"));
check("has a narrow screen block", has(cleanReport, "@media (max-width:34rem)"));
check("tables can scroll rather than push the page wide", has(cleanReport, "overflow-x:auto"));
check("asks not to be indexed if it ever lands on a server", has(cleanReport, "noindex"));

const balanced = (tag) =>
  (cleanReport.match(new RegExp(`<${tag}\\b`, "g")) || []).length ===
  (cleanReport.match(new RegExp(`</${tag}>`, "g")) || []).length;
for (const tag of ["html", "head", "body", "main", "section", "article", "ul", "ol", "li", "table", "p", "div"]) {
  check(`balanced <${tag}> tags`, balanced(tag));
}

/* ------------------------------------------ 7. the content that matters */

check("the client's own question is rendered verbatim",
  has(cleanReport, "why did we stop using those guys"));
check("citation markers become superscripts", has(cleanReport, '<sup class="cite">1</sup>'));
check("citations are listed with their titles", has(cleanReport, "Vendor review call"));
check("the heads up line gets its own treatment", has(cleanReport, 'class="headsup"'));

// A lead-in line followed by bullets is the shape an LLM actually returns, and
// it used to print the dashes as literal text.
const listy = renderReportHtml({
  seedAnswers: [
    { question: "what did we promise",
      answer: "Two things were committed [1]:\n- Delivery by week 6 [1]\n- One free revision [2]\n\nThen a closing line.",
      citations: [{ n: 1, title: "SOW", source: "drive" }], gaps: [], resultCount: 4 },
    { question: "what are the steps",
      answer: "1. Measure\n2. Cut\n3. Install", citations: [{ n: 1, title: "SOP", source: "drive" }], resultCount: 2 },
  ],
});
check("a lead-in line stays a paragraph", has(listy, "<p>Two things were committed"));
check("bullets after a lead-in become a list",
  has(listy, '<ul class="answer-list"><li>Delivery by week 6'));
check("no literal bullet dash leaks into the text", !has(listy, "<br>- Delivery"));
check("a numbered run renders as an ordered list", has(listy, '<ol class="answer-list"><li>Measure'));
check("prose after a list is its own paragraph", has(listy, "<p>Then a closing line.</p>"));
check("an answered question is labelled as answered", has(cleanReport, "Answered from your own documents"));

check("repeated gaps are listed once",
  (cleanReport.match(/Newest source is 41 days old\./g) || []).length === 1,
  String((cleanReport.match(/Newest source is 41 days old\./g) || []).length));
check("disconnected sources are named as gaps",
  has(cleanReport, "Not connected") && has(cleanReport, "Gmail"));

// Severity order. A question that found nothing must not sit below routine
// housekeeping where it gets skimmed past.
const ordered = renderReportHtml({
  manifest: cleanManifest,
  acceptance: passingAcceptance,
  seedAnswers: [
    { question: "a refused one", answer: "The documents do not contain that.", citations: [{ n: 1, title: "x", source: "drive" }], resultCount: 2, gaps: [] },
    { question: "an empty one", resultCount: 0, citations: [], gaps: [] },
  ],
  corpus: cleanCorpus,
});
check("the hardest gap is listed first",
  ordered.indexOf("No sources at all") < ordered.indexOf("Answered with an honest no"));
check("housekeeping gaps sink below the real ones",
  ordered.indexOf("No sources at all") < ordered.indexOf("Not connected"));
check("deliberate exclusions are stated",
  has(cleanReport, "Deliberately excluded") && has(cleanReport, "Legal/Sealed"));
check("a stale corpus is called out", has(cleanReport, "Behind on updates"));

check("the prediction block renders", has(cleanReport, "The ones you predicted it would miss"));
check("a correctly predicted miss is called out as predicted",
  has(cleanReport, "exactly as you predicted"));

const surprise = renderReportHtml({
  manifest: cleanManifest,
  acceptance: passingAcceptance,
  seedAnswers: goodSeeds,
  expectedToFail: [
    { question: "what is our headcount plan for 2028", answer: "Three hires in Q1 [1].",
      citations: [{ n: 1, title: "Board deck", source: "drive" }], gaps: [], resultCount: 4 },
  ],
  corpus: cleanCorpus,
});
check("a prediction that was wrong says so and shows the answer",
  has(surprise, "It answered anyway") && has(surprise, "Three hires in Q1"));

check("coverage totals are formatted for a human", has(cleanReport, "4,102"));
check("coverage names sources in the client's words",
  has(cleanReport, "Documents and files") && !has(cleanReport, ">drive_file<"));
check("partly embedded corpora are explained",
  has(cleanReport, "still being processed"));
check("the custody promise is stated", has(cleanReport, "no copy of your material leaves the accounts you own"));
check("re-running it is spelled out", has(cleanReport, "brain test &lt;manifest&gt; --report"));
check("tier headings explain why the tier matters", has(cleanReport, "answering without a key"));

/* ------------------------- 8. the real Acceptance shape, offline */

// The renderer's contract is with acceptance.mjs, not with a fixture I wrote.
// This runs the actual class against a stubbed transport so a change to its
// output shape breaks here rather than in front of a client.
const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => body,
});

const privateQueryCalls = [];
const fetchStub = async (url, init = {}) => {
  const u = new URL(url);
  const key = (init.headers || {})["X-Admin-Key"];
  const authed = key === "the-real-key";

  if (u.pathname === "/health") return reply(200, { ok: true, version: "0.2.0" });
  if (!authed) return reply(401, { error: "unauthorized" });
  if (u.pathname === "/api/admin/brain/documents") return reply(200, cleanCorpus);
  if (u.pathname === "/api/admin/brain/ingest") {
    return reply(422, {
      error: "refused: content carries live credential(s)",
      labels: ["cloudflare_token_new", "env_assignment"],
      detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written.",
    });
  }
  if (u.pathname === "/api/rag/unified") {
    privateQueryCalls.push({ url: u, init, body: JSON.parse(init.body || "{}") });
    return reply(200, { results: [{ title: "a doc", ts: "2026-07-01T00:00:00Z", source: "drive" }] });
  }
  if (u.pathname === "/api/rag/think") {
    privateQueryCalls.push({ url: u, init, body: JSON.parse(init.body || "{}") });
    return reply(200, {
      answer: "They were let go after two missed windows [1].",
      gaps: [{ type: "thin_coverage", detail: "Only 2 sources matched." }],
      citations: [{ n: 1, title: "Vendor review call", source: "meeting", ref: "m/1", ts: "2026-03-04T00:00:00Z" }],
      results: [{ title: "a doc" }, { title: "another" }],
    });
  }
  return reply(404, { error: "not found" });
};

const collected = await collectReportData({
  base: "https://brain.acme.com/",
  adminKey: "the-real-key",
  manifest: cleanManifest,
  installState: { product_version: "0.2.0", schema_version: 2, gate_version: 2 },
  fetchImpl: fetchStub,
});

check("collect runs the real acceptance suite", Array.isArray(collected.acceptance?.results) && collected.acceptance.results.length > 0);
check("collect reports the suite as passing on a healthy stub", collected.acceptance.passed === true,
  JSON.stringify(collected.acceptance.counts));
check("collect asks every probe question", collected.seedAnswers.length === 2);
check("collect asks the predicted misses too", collected.expectedToFail.length === 1);
check("report and acceptance questions use private JSON POST bodies",
  privateQueryCalls.length > 0 && privateQueryCalls.every((call) =>
    call.init.method === "POST" && call.url.search === "" && typeof call.body.q === "string"),
  JSON.stringify(privateQueryCalls.map((call) => ({ method: call.init.method, search: call.url.search, body: call.body }))));
check("collect normalises a trailing slash on the base", collected.base === "https://brain.acme.com");
check("collect keeps citations from think", collected.seedAnswers[0].citations.length === 1);

const live = renderReportHtml(collected);
check("the real shape renders", live.startsWith("<!doctype html>") && has(live, "Vendor review call"));
check("the real shape renders every tier name",
  ["Reachable and access controlled", "Data present and current", "Search and answers working",
   "Credential protection active", "Version and configuration"].every((t) => has(live, t)));
check("the real shape carries no external tag", !EXTERNAL_TAGS.test(live));
check("the real acceptance statuses map to pills",
  has(live, 'class="pill pill-pass"') && has(live, ">PASS<"));

// A transport that fails must cost one question, not the whole document.
const brokenThink = async (url, init) => {
  if (new URL(url).pathname === "/api/rag/think") throw new Error("connection reset");
  return fetchStub(url, init);
};
const degraded = await collectReportData({
  base: "https://brain.acme.com",
  adminKey: "the-real-key",
  manifest: cleanManifest,
  fetchImpl: brokenThink,
});
check("a dead think endpoint is recorded per question, not thrown",
  degraded.seedAnswers.every((s) => s.error === "connection reset"));

// acceptance.mjs only catches transport errors inside tier 1, so a throw in a
// later tier escapes run(). Losing the whole document to that is unacceptable:
// collection keeps the tiers that finished and names the error.
check("a mid-suite transport error does not throw out of collection",
  degraded.acceptanceError === "connection reset", String(degraded.acceptanceError));
check("the tiers that did finish are kept",
  Array.isArray(degraded.acceptance?.results) && degraded.acceptance.results.length > 0,
  String(degraded.acceptance?.results?.length));

const degradedHtml = renderReportHtml(degraded);
check("a dead think endpoint still produces a document",
  degradedHtml.startsWith("<!doctype html>") && has(degradedHtml, "This check could not run"));
check("an unfinished run is never reported as ready",
  !has(degradedHtml, "Ready. Everything checked out.") && has(degradedHtml, "did not finish"));
check("an unfinished run names the error that stopped it",
  has(degradedHtml, "connection reset"));
check("an unfinished run warns that missing tiers are unknown, not passing",
  has(degradedHtml, "unknown rather than as passing"));

// A suite that dies before writing a single result still has to render.
const deadOnArrival = renderReportHtml({
  manifest: cleanManifest,
  acceptance: null,
  acceptanceError: "fetch failed: getaddrinfo ENOTFOUND brain.acme.com",
  seedAnswers: [],
  corpus: null,
});
check("a suite that produced nothing still renders a document",
  deadOnArrival.startsWith("<!doctype html>") && has(deadOnArrival, "ENOTFOUND"));
check("a suite that produced nothing is not called ready",
  !has(deadOnArrival, "verdict v-ready"));

/* -------------------------------------------------------------- result */

console.log("");
if (failures) {
  console.log(`report-html: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("report-html: all tests passed");
