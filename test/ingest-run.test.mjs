import { walk, prepare, batches, batchStream, splitOversized, loadState, saveState, MAX_FILE_BYTES, MAX_DOC_CHARS } from "../ingest/run.mjs";
import { isBinaryFormat, supported } from "../ingest/extract.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 240))); if (!c) fail++; };

const root = mkdtempSync(join(tmpdir(), "brain-ingest-"));
const put = (rel, content) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
};

put("notes/2026-08-14 review.md", "The three lanes let a client hand over everything without ordering up years of homework.");
put("notes/plain.txt", "An ordinary note with enough words in it to clear the minimum length floor comfortably.");
put("_private/secrets.md", "must never be walked");
put("Private Client/file.md", "also must not be walked");
put("node_modules/pkg/index.js", "console.log(1)");
put(".hidden/x.md", "hidden dir");
put("notes/.hidden.md", "hidden file");
put("empty.md", "");
put("data/table.csv", "Account,Balance\nChecking,15234.11\n");
put("bin/logo.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x41, 0x42]));
put("docs/report.pdf", "%PDF-1.4 not really");

/* ---- the walk ---- */
{
  const { files, skipped, complete } = walk(root, { privatePrefixes: ["_private", "Private"] });
  const rels = files.map((f) => f.rel.split(/[\\/]/).join("/"));
  check("finds ordinary documents", rels.includes("notes/2026-08-14 review.md") && rels.includes("notes/plain.txt"), rels.join(", "));

  check("never walks a private prefix", !rels.some((r) => r.startsWith("_private")), rels.join(", "));
  check("prefix matching is per path SEGMENT, so 'Private Client' is caught too",
    !rels.some((r) => r.startsWith("Private Client")), rels.join(", "));
  check("and each exclusion is RECORDED, not silent",
    skipped.filter((s) => /private path prefix/.test(s.reason)).length >= 2, JSON.stringify(skipped));

  check("skips node_modules", !rels.some((r) => r.includes("node_modules")));
  check("skips dot directories", !rels.some((r) => r.includes(".hidden/")));
  check("skips dot files", !rels.some((r) => r.endsWith(".hidden.md")));
  check("an empty file is skipped WITH a reason", skipped.some((s) => /empty/.test(s.reason)), JSON.stringify(skipped));
  check("a fully readable folder walk is explicitly complete", complete === true, String(complete));
}
{
  const { files, skipped } = walk(root, { maxBytes: 10 });
  check("an oversized file is skipped and the size stated",
    skipped.some((s) => /over the/.test(s.reason)), JSON.stringify(skipped.slice(0, 3)));
  check("the limit is respected", files.every((f) => f.size <= 10));
}

/* ---- prepare: every rejection carries a legible reason ---- */
const one = (rel) => walk(root, {}).files.find((f) => f.rel.split(/[\\/]/).join("/") === rel);

{
  const r = await prepare(one("notes/2026-08-14 review.md"), { sourceName: "docs" });
  check("a good file becomes an envelope", !!r.envelope, JSON.stringify(r.skip));
  check("source_id is the relative path, POSIX-normalised", r.envelope.source_id === "notes/2026-08-14 review.md", r.envelope.source_id);
  check("the date comes from the filename", r.envelope.occurred_at?.startsWith("2026-08-14"), r.envelope.occurred_at);
  check("and it records HOW it was dated", r.envelope.date_source === "filename", r.envelope.date_source);
  check("a content hash is returned for resume", typeof r.hash === "string" && r.hash.length === 64);
  check("the source_type is the named source", r.envelope.source_type === "docs");
}
{
  const r = await prepare(one("data/table.csv"), { sourceName: "docs" });
  check("a CSV is rendered header-aware, not as a bare grid", /Account: Checking/.test(r.envelope.content), r.envelope?.content);
}
{
  const r = await prepare(one("bin/logo.bin"), { sourceName: "docs" });
  check("a binary file is skipped", !!r.skip && !r.envelope, JSON.stringify(r));
  check("and named as unsupported rather than failing the run", /no extractor/.test(r.skip.reason), r.skip.reason);
}
{
  // .pdf IS supported now, so a file that merely claims to be one must fail
  // with a legible parse error rather than being indexed as its own bytes.
  const r = await prepare(one("docs/report.pdf"), { sourceName: "docs" });
  check("a corrupt PDF is skipped with a legible reason", !!r.skip && /could not be opened|no text layer/.test(r.skip.reason), r.skip?.reason);
  check("and still returns a hash so a later run can detect the change", typeof r.hash === "string");
}
{
  const r = await prepare(one("bin/logo.bin"), { sourceName: "docs" });
  check("a genuinely unsupported extension is REPORTED, never silently dropped",
    /no extractor for "\.bin"/.test(r.skip.reason), r.skip.reason);
}
{
  const p = one("notes/plain.txt");
  const r1 = await prepare(p, { sourceName: "docs" });
  writeFileSync(p.full, "An ordinary note with enough words in it to clear the minimum length floor comfortably. Changed.");
  const r2 = await prepare(p, { sourceName: "docs" });
  check("editing a file changes its hash, so a resume re-sends it", r1.hash !== r2.hash);
}

/* ---- the binary guard must not eat the binary FORMATS ----
   Regression: PDF, docx, xlsx and pptx are binary containers by design. Running
   the "does this look like binary junk" check on them rejected every PDF and
   Word document in a real corpus with the reason "the file is binary, not text",
   which is true and completely useless. Caught only by an end-to-end run. */
{
  for (const f of ["report.pdf", "contract.docx", "budget.xlsx", "old.xls", "deck.pptx"]) {
    check(`${f.split(".").pop()} is exempt from the binary-junk guard`, isBinaryFormat(f), f);
  }
  for (const f of ["notes.md", "data.csv", "page.html", "mail.eml", "log.txt"]) {
    check(`${f.split(".").pop()} is NOT exempt, so real junk is still caught`, !isBinaryFormat(f), f);
  }
  check("an unknown extension is not exempt", !isBinaryFormat("thing.bin"));
  for (const ext of [".pdf", ".docx", ".xlsx", ".pptx", ".eml"]) {
    check(`${ext} is registered`, supported().includes(ext), supported().join(" "));
  }
}

/* ---- batching must respect BOTH ceilings ---- */
{
  const mk = (n, size) => Array.from({ length: n }, (_, i) => ({ envelope: { source_id: "d" + i, content: "x".repeat(size) } }));
  check("splits on the document count", batches(mk(120, 10), { maxDocs: 50, maxBytes: 1e9 }).length === 3);
  const byBytes = batches(mk(10, 200_000), { maxDocs: 50, maxBytes: 900_000 });
  check("splits on total bytes", byBytes.length >= 3, String(byBytes.length));
  check("no batch exceeds the byte ceiling",
    byBytes.every((b) => b.reduce((n, x) => n + x.envelope.content.length, 0) <= 900_000));
  check("nothing is lost across batches", byBytes.flat().length === 10);
  check("an empty input yields no batches", batches([]).length === 0);
  // WRONG BEFORE: this asserted that an oversized document is emitted as its own
  // batch. It is, and the Worker then 413s it and the document is LOST. It has
  // to be split before it ever reaches batching.
  const parts = splitOversized({ source_id: "big.txt", title: "Big", content: "x".repeat(1_000_000) });
  check("an oversized document is split into parts", parts.length === 3, String(parts.length));
  check("every part fits the request ceiling", parts.every((p) => p.content.length <= MAX_DOC_CHARS));
  check("no text is lost in the split", parts.reduce((n, p) => n + p.content.length, 0) === 1_000_000);
  check("parts keep the original identity in their ids", parts[1].source_id === "big.txt#part2of3", parts[1].source_id);
  check("and say which part they are, so a citation is legible", /part 2 of 3/.test(parts[1].title), parts[1].title);
  check("and record what they came from", parts[1].metadata.part_of === "big.txt");
  check("a normal document is passed through untouched", splitOversized({ source_id: "a", content: "short" }).length === 1);
  // batches() takes { envelope } wrappers, which is how the CLI feeds it.
  const grouped = batches(parts.map((envelope) => ({ envelope })), { maxBytes: 900_000 });
  check("split parts then batch within the ceiling",
    grouped.every((b) => b.reduce((n, x) => n + x.envelope.content.length, 0) <= 900_000), String(grouped.length));
  check("and every part survives batching", grouped.flat().length === parts.length);
}

/* ---- streaming accepts remote iterators and preserves their resume context ---- */
{
  let produced = 0;
  async function* remoteFiles() {
    for (let i = 0; i < 6; i++) {
      produced++;
      yield { id: `r${i}` };
    }
  }
  const stream = batchStream(remoteFiles(), async (file) => ({
    hash: `v-${file.id}`,
    rel: file.id,
    stateKey: `drive:${file.id}`,
    deferState: true,
    familyPlan: { stateKey: `drive:${file.id}`, expectedParts: 1 },
    envelope: { source_id: file.id, content: "bounded remote content" },
  }), { maxDocs: 2, maxBytes: 1e9 });
  const first = await stream.next();
  check("the remote stream yields before consuming the whole source",
    first.value.length === 2 && produced < 6, `batch=${first.value?.length} produced=${produced}`);
  check("remote resume and family context survives streaming",
    first.value[0].stateKey === "drive:r0" && first.value[0].deferState === true && first.value[0].familyPlan.expectedParts === 1,
    JSON.stringify(first.value[0]));
  const rest = [];
  for await (const group of stream) rest.push(group);
  check("the async source is consumed exactly once", produced === 6 && first.value.length + rest.flat().length === 6,
    `produced=${produced} emitted=${first.value.length + rest.flat().length}`);
}

/* ---- state ---- */
{
  const sp = join(root, "state", "s.json");
  check("missing state starts clean", loadState(sp).done && Object.keys(loadState(sp).done).length === 0);
  saveState(sp, { version: 1, done: { "a.md": "hash1" }, skipped: { "b.pdf": "no extractor" } });
  const s = loadState(sp);
  check("state round-trips", s.done["a.md"] === "hash1" && s.skipped["b.pdf"] === "no extractor", JSON.stringify(s));
  const stateMode = statSync(sp).mode & 0o777;
  const hasTemporaryState = readdirSync(dirname(sp)).some((n) => n.startsWith("s.json.tmp-"));
  if (process.platform === "win32") {
    check("Windows state round-trips atomically without POSIX mode bits",
      s.done["a.md"] === "hash1" && !hasTemporaryState, `mode=${stateMode.toString(8)}`);
  } else {
    check("state is owner-only", stateMode === 0o600, stateMode.toString(8));
  }
  check("atomic save leaves no temporary state behind", !hasTemporaryState);
  writeFileSync(sp, "{ this is not json");
  check("a corrupt state file does not abort the load", loadState(sp).done && Object.keys(loadState(sp).done).length === 0);
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILURES` : `\ningest-run: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
