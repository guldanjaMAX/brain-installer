/**
 * report — the monthly health report for a brain install.
 *
 *   brain report <manifest> [--out report.md]
 *
 * This is the artifact the monthly fee buys. It exists because "the brain is
 * running" is invisible: a knowledge system that quietly stops ingesting looks
 * exactly like one that is working until someone asks a question it should
 * have answered. The report makes the invisible thing visible once a month.
 *
 * It is deliberately written FOR THE CLIENT, not for us. Every line has to
 * mean something to a business owner who does not know what a vector is. A
 * report they cannot read is a report that justifies nothing.
 *
 * It also states what is NOT working. A monthly report that only ever says
 * "all good" trains the reader to stop opening it, and then it stops being
 * worth paying for. Bad news is the reason it has value.
 */

import { Acceptance, renderSearchability } from "./acceptance.mjs";
import { fetchBrainWithAdminKey } from "./components/brain-http.mjs";
import { responseIncomplete } from "./worker/src/lib/failure.js";

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const num = (n) => Number(n || 0).toLocaleString("en-US");

function daysAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 864e5);
}

/**
 * Turn corpus rows into a sentence a business owner understands.
 * "message" and "drive_file" are our words, not theirs.
 */
const FRIENDLY = {
  drive_file: "documents and files",
  message: "messages and email",
  meeting: "meeting transcripts",
  curated: "notes and lessons",
  lead: "contacts",
  email_track: "tracked emails",
  calendar_event: "calendar events",
  custom: "other documents",
};

export async function buildReport({ base, adminKey, manifest, installState, upgradeRuns, spend }) {
  const suite = new Acceptance({ base, adminKey, manifest });
  const acc = await suite.run({
    probes: manifest.testing?.probe_questions || [],
    installState,
  });

  const docsRes = await fetchBrainWithAdminKey(
    fetch,
    `${base}/api/admin/brain/documents`,
    {},
    () => adminKey,
  );
  // A failed read produced `{ rows: [] }` here, and the report then stated the
  // brain holds 0 items. Reporting an unread corpus as an empty one is the
  // failure mode this whole report exists to prevent, so the two are separated:
  // a body that arrives is used even when it is a 503 (the rows survive the
  // failure and are still worth showing), and whether it was WHOLE is carried
  // separately so the count can be qualified rather than quietly invented.
  const docs = (await docsRes.json().catch(() => null)) || { rows: [] };
  const corpusUnreadable = !docsRes.ok || responseIncomplete(docs);
  const rows = docs.rows || [];
  const total = rows.reduce((a, r) => a + Number(r.total || 0), 0);
  const embedded = rows.reduce((a, r) => a + Number(r.embedded || 0), 0);

  const name = manifest.client?.display_name || manifest.client?.slug || "your";
  const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const L = [];
  L.push(`# ${name} Brain: ${month}`);
  L.push("");

  /* --------------------------------------------------------- the verdict */
  // Headline first. Someone who reads one line should get the true answer.
  const failures = acc.results.filter((r) => r.status === "fail");
  const warnings = acc.results.filter((r) => r.status === "warn");
  if (failures.length === 0 && warnings.length === 0) {
    L.push("**Everything is working.** No action needed.");
  } else if (failures.length === 0) {
    L.push(`**Working, with ${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth knowing about.** Details below.`);
  } else {
    L.push(`**${failures.length} problem${failures.length === 1 ? "" : "s"} need attention.** Details below.`);
  }
  L.push("");

  /* ------------------------------------------------------------ what is in it */
  L.push("## What your brain knows");
  L.push("");
  if (corpusUnreadable) {
    // Same discipline as the searchability section below: an unmeasured thing
    // is reported as unmeasured, never as a clean zero and never as fine.
    L.push(
      "**This month's count could not be read from your brain.** That is not the same as it " +
      "being empty: any figure below is partial, and this report cannot tell you how much " +
      "your brain currently holds."
    );
    L.push("");
  }
  L.push(`It ${corpusUnreadable ? "reported" : "currently holds"} **${num(total)} items**${corpusUnreadable ? ", which may be incomplete" : ""}.`);
  L.push("");
  if (rows.length) {
    L.push("| Kind | How many | Searchable |");
    L.push("|---|---:|---:|");
    for (const r of [...rows].sort((a, b) => Number(b.total) - Number(a.total))) {
      const label = FRIENDLY[r.source_type] || r.source_type;
      const ready = pct(Number(r.embedded || 0), Number(r.total || 0));
      L.push(`| ${label} | ${num(r.total)} | ${ready}% |`);
    }
    L.push("");
  }
  if (embedded < total) {
    const pending = total - embedded;
    L.push(
      `${num(pending)} item${pending === 1 ? " is" : "s are"} still being processed and will become searchable shortly.`
    );
    L.push("");
  }

  /* ------------------------------------------- how much of it is reachable */
  // The table above says how many items are in the brain and how many have been
  // processed. Neither of those can tell you whether the WHOLE of a document can
  // be found, and until this line existed nothing could: a corpus where most of
  // the text was cut before it was indexed looked exactly like a complete one,
  // and the answers looked plausible because the start of each piece was
  // indexed fine. This is the line that separates those two.
  const searchRes = await fetchBrainWithAdminKey(
    fetch,
    `${base}/api/admin/brain/searchability`,
    {},
    () => adminKey,
  );
  const coverage = searchRes.ok ? await searchRes.json().catch(() => null) : null;
  L.push("## How much of it can actually be found");
  L.push("");
  if (!coverage || !Number.isFinite(Number(coverage.chunks))) {
    L.push(
      "**This could not be measured this month.** That is not the same as it being fine: " +
      "it means this report cannot tell you whether your documents are fully searchable."
    );
  } else {
    L.push(capitalise(renderSearchability(coverage)));
    if (coverage.over_budget || coverage.unmeasured) {
      L.push("");
      L.push(
        "> Long documents are stored in pieces, and a piece that runs past what the search " +
        "index can read keeps its ending stored but unfindable by meaning. You would never " +
        "see this in an answer: the brain replies confidently from the part it did read. " +
        "The repair does not need your original files and is safe to run at any time."
      );
    }
  }
  L.push("");

  /* ------------------------------------------------------------- freshness */
  L.push("## Is it up to date");
  L.push("");
  const stale = [];
  for (const r of rows) {
    const d = daysAgo(r.last_ingested);
    const label = FRIENDLY[r.source_type] || r.source_type;
    if (d === null) continue;
    if (d <= 2) L.push(`- ${label}: current (last updated ${d === 0 ? "today" : d + " day(s) ago"})`);
    else {
      L.push(`- **${label}: ${d} days behind**`);
      stale.push(label);
    }
  }
  L.push("");
  if (stale.length) {
    // Say what it means, not just that a number is high. A stale corpus does
    // not announce itself when you ask a question; it just answers with old
    // information and sounds equally confident.
    L.push(
      `> Anything added to ${stale.join(" or ")} in that window will not appear in answers yet. ` +
        `The brain will not warn you mid-answer, so this is the number to watch.`
    );
    L.push("");
  }

  /* ---------------------------------------------------------------- checks */
  L.push("## Safety and health checks");
  L.push("");
  const tierNames = {
    1: "Reachable and access-controlled",
    2: "Data present and current",
    3: "Search and answers working",
    4: "Credential protection active",
    5: "Version and configuration",
  };
  let lastTier = null;
  for (const r of acc.results) {
    if (r.tier !== lastTier) {
      lastTier = r.tier;
      L.push(`**${tierNames[r.tier] || "Checks"}**`);
      L.push("");
    }
    const mark = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : r.status === "warn" ? "⚠️" : "➖";
    L.push(`- ${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  L.push("");

  /* ------------------------------------------------------------------ cost */
  if (spend && spend.length) {
    L.push("## What it cost to run");
    L.push("");
    const totalMicros = spend.reduce((a, r) => a + Number(r.micros || 0), 0);
    L.push(`Answer generation this period: **$${(totalMicros / 1e6).toFixed(2)}**.`);
    const cap = manifest.safety?.daily_llm_spend_cap_usd;
    if (cap) L.push(`A daily ceiling of $${cap} is in place, so a runaway process cannot produce a surprise bill.`);
    L.push("");
  }

  /* --------------------------------------------------------------- version */
  if (installState) {
    L.push("## Version");
    L.push("");
    L.push(`- Running version **${installState.product_version}**`);
    L.push(`- Last updated: ${installState.last_upgraded_at || "not since install"}`);
    if (upgradeRuns && upgradeRuns.length) {
      const bad = upgradeRuns.filter((r) => r.status !== "verified");
      if (bad.length) {
        L.push(`- ⚠️ ${bad.length} update(s) did not complete cleanly this period`);
      }
    }
    L.push("");
  }

  /* ----------------------------------------------------------- what to do */
  L.push("## What needs you");
  L.push("");
  if (!failures.length && !warnings.length) {
    L.push("Nothing. No action required this month.");
  } else {
    for (const f of failures) L.push(`- **${f.name}** — ${f.detail || "failed"}`);
    for (const w of warnings) L.push(`- ${w.name} — ${w.detail || "worth a look"}`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(
    `_This report was generated by running live checks against your own infrastructure. ` +
      `You can run it yourself at any time. Everything in your brain lives in accounts you own; ` +
      `we hold no copy of it._`
  );

  return { markdown: L.join("\n"), acceptance: acc, total, embedded };
}
