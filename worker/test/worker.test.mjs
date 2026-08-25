import { demoteScaffolding, computeGaps } from "../src/index.js";
let fail = 0;
const check = (n, c, d = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* ---- demoteScaffolding: the end-anchor bug that let CLAUDE.md hold #1 ---- */
const withScaffold = [
  { title: "CLAUDE.md", ref_key: "repo/CLAUDE.md" },
  { title: "Q3 strategy memo", ref_key: "docs/q3.md" },
  { title: "package-lock.json", ref_key: "app/package-lock.json" },
  { title: "Client retainer terms", ref_key: "legal/retainer.md" },
];
const demoted = demoteScaffolding(withScaffold);
check("substantive first", demoted[0].title === "Q3 strategy memo", demoted[0].title);
check("scaffolding last", demoted[demoted.length - 1].title.match(/CLAUDE|package-lock/) !== null);
check("nothing dropped", demoted.length === 4, String(demoted.length));

// The original bug: concatenating title+ref_key defeats the $ anchor.
const anchored = demoteScaffolding([
  { title: "CLAUDE.md", ref_key: "some/path/CLAUDE.md" },
  { title: "Real doc", ref_key: "a.md" },
]);
check("end-anchor still fires with ref_key set", anchored[0].title === "Real doc");

check("single result untouched", demoteScaffolding([{ title: "x" }]).length === 1);
check("no scaffolding = identity", demoteScaffolding([{ title: "a" }, { title: "b" }])[0].title === "a");

/* ---- computeGaps: the differentiator ---- */
const fresh = new Date().toISOString();
const old = new Date(Date.now() - 90 * 864e5).toISOString();

let g = computeGaps([
  { ts: fresh, source: "drive", date_reliable: true }, { ts: fresh, source: "message", date_reliable: true }, { ts: fresh, source: "curated", date_reliable: true },
]);
check("fresh multi-corpus = no gaps", g.length === 0, JSON.stringify(g.map(x => x.type)));

g = computeGaps([{ ts: old, source: "curated", date_reliable: true }, { ts: old, source: "message", date_reliable: true }, { ts: old, source: "drive", date_reliable: true }]);
check("stale detected", g.some(x => x.type === "stale"), JSON.stringify(g.map(x => x.type)));
check("stale reports days", g.find(x => x.type === "stale").days_since_newest >= 89);

g = computeGaps([{ ts: old, source: "drive", date_reliable: true }, { ts: old, source: "drive", date_reliable: true }, { ts: old, source: "drive", date_reliable: true }]);
check("drive mtime qualifier present", g.find(x => x.type === "stale").detail.includes("sync touch"));
check("single_corpus detected", g.some(x => x.type === "single_corpus"));

g = computeGaps([{ ts: fresh, source: "drive", date_reliable: true }]);
check("thin coverage detected", g.some(x => x.type === "thin_coverage"));
check("thin coverage counts", g.find(x => x.type === "thin_coverage").count === 1);

g = computeGaps([{ source: "drive" }, { source: "message" }, { source: "curated" }]);
check("undated detected", g.some(x => x.type === "undated"));

check("empty input does not throw", Array.isArray(computeGaps([])));



/* ---- partially_undated: the common case the original engine missed ---- */
{
  const fresh2 = new Date().toISOString();
  let g = computeGaps([
    { ts: fresh2, source: "drive", date_reliable: true }, { ts: fresh2, source: "curated", date_reliable: true },
    { source: "drive" }, { source: "drive" },
  ]);
  check("partially undated fires at 50%", g.some(x => x.type === "partially_undated"),
        JSON.stringify(g.map(x => x.type)));
  const p = g.find(x => x.type === "partially_undated");
  check("reports the counts", p && p.undated_count === 2 && p.total === 4, JSON.stringify(p));

  // All dated: must NOT fire.
  g = computeGaps([{ ts: fresh2, source: "drive", date_reliable: true }, { ts: fresh2, source: "curated", date_reliable: true }, { ts: fresh2, source: "message", date_reliable: true }]);
  check("does not fire when all dated", !g.some(x => x.type === "partially_undated"));

  // All undated: the original `undated` gap owns that case, not this one.
  g = computeGaps([{ source: "drive" }, { source: "drive" }, { source: "curated" }]);
  check("all-undated stays 'undated'", g.some(x => x.type === "undated") && !g.some(x => x.type === "partially_undated"));

  // One in eight is below threshold and would just be noise.
  g = computeGaps(Array.from({length: 7}, () => ({ ts: fresh2, source: "drive", date_reliable: true })).concat([{ source: "drive" }]));
  check("below threshold stays quiet", !g.some(x => x.type === "partially_undated"),
        JSON.stringify(g.map(x => x.type)));
}

g = computeGaps([
  { ts: old, source: "message", date_reliable: true },
  { ts: fresh, source: "drive", date_reliable: false },
  { ts: old, source: "curated", date_reliable: true },
]);
check("an unreliable fresh timestamp cannot hide reliably stale evidence",
  g.some((gap) => gap.type === "stale"), JSON.stringify(g));

console.log(fail ? `\n${fail} FAILURES` : "\nworker: all tests passed");
process.exit(fail ? 1 : 0);
