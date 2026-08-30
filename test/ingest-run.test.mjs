import { walk, prepare, batches, batchStream, splitOversized, estimatedStatements, loadState, saveState, MAX_FILE_BYTES, MAX_DOC_CHARS } from "../ingest/run.mjs";
import { estimateD1IngestStatements } from "../worker/src/lib/store.js";
import { extract, isBinaryFormat, register, supported } from "../ingest/extract.mjs";
import { extractPdf, pdfPassIsolated } from "../ingest/formats.mjs";
import {
  linkSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync,
  symlinkSync,
} from "node:fs";
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

/* ---- local path authority survives hostile filesystem changes ---- */
const makeDirectoryLink = (target, linkPath) => {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
};

{
  const actualRoot = mkdtempSync(join(tmpdir(), "brain-ingest-real-root-"));
  writeFileSync(join(actualRoot, "inside.md"), "This ordinary file is inside the real approved root.");
  const linkedRoot = `${actualRoot}-linked`;
  makeDirectoryLink(actualRoot, linkedRoot);
  const result = walk(linkedRoot, {});
  check("a symlink or junction ingest root is refused before enumeration",
    result.complete === false && result.files.length === 0 &&
      result.skipped.some((skip) => /ingest root is a symbolic link or junction/.test(skip.reason)),
    JSON.stringify(result));
  rmSync(linkedRoot, { recursive: true, force: true });
  rmSync(actualRoot, { recursive: true, force: true });
}

{
  const linkRoot = mkdtempSync(join(tmpdir(), "brain-ingest-file-link-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "brain-ingest-file-target-"));
  const outside = join(outsideRoot, "outside.md");
  const linked = join(linkRoot, "linked.md");
  writeFileSync(outside, "Outside-only material must never become an ingest envelope.");
  let fileLink = true;
  try {
    symlinkSync(outside, linked, "file");
  } catch (error) {
    // Some Windows hosts reserve file symlinks even though directory junctions
    // are available to ordinary users. A final junction exercises the same
    // reparse-point refusal without weakening that platform's test lane.
    if (process.platform !== "win32" || !["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
    fileLink = false;
    makeDirectoryLink(outsideRoot, linked);
  }
  const result = walk(linkRoot, {});
  check("an initial symlink file or Windows reparse entry is a visible refusal",
    result.complete === false && result.files.length === 0 &&
      result.skipped.some((skip) => skip.path === "linked.md" && /symbolic links and junctions/.test(skip.reason)),
    JSON.stringify(result));
  const direct = await prepare({
    full: linked, rel: "linked.md", name: "linked.md", size: fileLink ? statSync(outside).size : 1,
  }, { sourceName: "docs" });
  check("prepare also refuses an initial link when called directly",
    !!direct.skip && !direct.envelope && /symbolic links and junctions/.test(direct.skip.reason),
    JSON.stringify(direct));
  rmSync(linkRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

{
  const swapRoot = mkdtempSync(join(tmpdir(), "brain-ingest-swap-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "brain-ingest-swap-target-"));
  const original = join(swapRoot, "approved.md");
  const outside = join(outsideRoot, "outside.md");
  const outsideOnly = "OUTSIDE_SWAP_SENTINEL must never be extracted.";
  writeFileSync(original, "The approved file has enough ordinary words to pass text quality safely.");
  writeFileSync(outside, outsideOnly);
  const approved = walk(swapRoot, {}).files[0];
  rmSync(original);
  let usedLink = true;
  try {
    symlinkSync(outside, original, "file");
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
    usedLink = false;
    writeFileSync(original, outsideOnly);
  }
  const swapped = await prepare(approved, { sourceName: "docs" });
  check("a walk-to-read replacement is refused before replacement bytes are used",
    !!swapped.skip && !swapped.envelope &&
      /symbolic links and junctions|changed after the folder was scanned/.test(swapped.skip.reason) &&
      !JSON.stringify(swapped).includes("OUTSIDE_SWAP_SENTINEL"),
    `${usedLink ? "link" : "identity"}: ${JSON.stringify(swapped)}`);
  rmSync(swapRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

{
  // Keep the approved inode but make its path escape through a parent link.
  // Matching identity alone is insufficient here, so this proves canonical
  // root containment is checked independently before the descriptor read.
  const containedRoot = mkdtempSync(join(tmpdir(), "brain-ingest-contained-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "brain-ingest-contained-target-"));
  const slot = join(containedRoot, "slot");
  mkdirSync(slot);
  const approvedPath = join(slot, "same.md");
  writeFileSync(approvedPath, "The approved inode begins within the selected folder boundary.");
  const approved = walk(containedRoot, {}).files[0];
  linkSync(approvedPath, join(outsideRoot, "same.md"));
  rmSync(slot, { recursive: true, force: true });
  makeDirectoryLink(outsideRoot, slot);
  const escaped = await prepare(approved, { sourceName: "docs" });
  check("a matching file identity reached through an outside-root junction is still refused",
    !!escaped.skip && !escaped.envelope && /outside the approved ingest root/.test(escaped.skip.reason),
    JSON.stringify(escaped));
  rmSync(containedRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

{
  const growthRoot = mkdtempSync(join(tmpdir(), "brain-ingest-growth-"));
  const growing = join(growthRoot, "growing.md");
  writeFileSync(growing, "This initially small document is approved by the folder walk.");
  const approved = walk(growthRoot, {}).files[0];
  // writeFileSync truncates and rewrites the same regular-file identity. The
  // descriptor gate must therefore enforce the byte ceiling independently of
  // the walk's stale size metadata.
  writeFileSync(growing, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  const oversized = await prepare(approved, { sourceName: "docs" });
  check("the actual descriptor read rechecks the 8MB ceiling after the walk",
    !!oversized.skip && !oversized.envelope && /over the 8MB limit/.test(oversized.skip.reason),
    JSON.stringify(oversized));
  rmSync(growthRoot, { recursive: true, force: true });
}

/* ---- prepare: every rejection carries a legible reason ---- */
const one = (rel) => walk(root, {}).files.find((f) => f.rel.split(/[\\/]/).join("/") === rel);

function textPdf() {
  const stream = "BT\n/F1 12 Tf\n72 720 Td\n(Brain PDF child process works) Tj\nET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

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
  const productionPdf = await pdfPassIsolated(textPdf(), { timeoutMs: 5_000 });
  check("the packaged PDF child extracts a real text PDF",
    productionPdf.body?.includes("Brain PDF child process works") && productionPdf.totalPages === 1,
    JSON.stringify(productionPdf));

  const previousSecret = process.env.BRAIN_PDF_TEST_SECRET;
  process.env.BRAIN_PDF_TEST_SECRET = "must-not-reach-the-child";
  let isolated;
  try {
    isolated = await pdfPassIsolated(new Uint8Array([1, 2, 3, 4]), {
      childPath: new URL("./fixtures/pdf-success-child.mjs", import.meta.url),
      timeoutMs: 2_000,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.BRAIN_PDF_TEST_SECRET;
    else process.env.BRAIN_PDF_TEST_SECRET = previousSecret;
  }
  check("PDF bytes cross an isolated process without inherited secrets",
    isolated.body === "isolated 4 bytes clean" && isolated.totalPages === 1, JSON.stringify(isolated));

  const late = await pdfPassIsolated(new Uint8Array([1]), {
    childPath: new URL("./fixtures/pdf-late-rejection-child.mjs", import.meta.url),
    timeoutMs: 2_000,
  });
  check("a delayed PDF process rejection becomes a reasoned file error without killing ingest",
    late.text === null && /could not be opened/.test(late.error || ""), JSON.stringify(late));

  const falseSuccess = await pdfPassIsolated(new Uint8Array([1]), {
    childPath: new URL("./fixtures/pdf-success-then-rejection-child.mjs", import.meta.url),
    timeoutMs: 2_000,
  });
  check("a rejection after a staged PDF result overrides that false success",
    falseSuccess.text === null && /could not be opened/.test(falseSuccess.error || ""), JSON.stringify(falseSuccess));

  let invalidProtocolFatal = false;
  try {
    await pdfPassIsolated(new Uint8Array([1]), {
      childPath: new URL("./fixtures/pdf-invalid-result-child.mjs", import.meta.url),
      timeoutMs: 2_000,
    });
  } catch (error) {
    invalidProtocolFatal = error?.fatal === true && error?.name === "ExtractorSystemError";
  }
  check("an invalid PDF process protocol aborts instead of omitting every PDF",
    invalidProtocolFatal, String(invalidProtocolFatal));

  let missingChildFatal = false;
  try {
    await pdfPassIsolated(new Uint8Array([1]), {
      childPath: new URL("./fixtures/pdf-does-not-exist.mjs", import.meta.url),
      timeoutMs: 2_000,
    });
  } catch (error) {
    missingChildFatal = error?.fatal === true && error?.name === "ExtractorSystemError";
  }
  check("a missing PDF helper aborts instead of marking every PDF unreadable",
    missingChildFatal, String(missingChildFatal));

  register(".fataltest", () => {
    const error = new Error("systemic extractor failure");
    error.fatal = true;
    throw error;
  }, "fatal test");
  let fatalEscapedExtract = false;
  try {
    await extract(new Uint8Array([1]), "system.fataltest");
  } catch (error) {
    fatalEscapedExtract = error?.fatal === true;
  }
  check("the generic extraction boundary preserves systemic fatal errors",
    fatalEscapedExtract, String(fatalEscapedExtract));

  let fatalEscapedPdf = false;
  try {
    await extractPdf(new Uint8Array([1]), {}, {
      pdfPassImpl: async () => {
        const error = new Error("PDF helper is unavailable");
        error.fatal = true;
        throw error;
      },
    });
  } catch (error) {
    fatalEscapedPdf = error?.fatal === true;
  }
  check("the registered PDF boundary preserves systemic fatal errors",
    fatalEscapedPdf, String(fatalEscapedPdf));

  const oversizedOutput = await pdfPassIsolated(new Uint8Array([1]), {
    childPath: new URL("./fixtures/pdf-success-child.mjs", import.meta.url),
    timeoutMs: 2_000,
    maxOutputBytes: 8,
  });
  check("PDF process output is bounded before it can exhaust ingest memory",
    oversizedOutput.text === null && /safe output limit/.test(oversizedOutput.error || ""), JSON.stringify(oversizedOutput));

  const timedOut = await pdfPassIsolated(new Uint8Array([1]), {
    childPath: new URL("./fixtures/pdf-hang-child.mjs", import.meta.url),
    // A cold Node process can take hundreds of milliseconds to start on CI,
    // especially on Windows. Leave enough time for the ready handshake so
    // this exercises a parser that hangs after startup, not a startup failure.
    timeoutMs: 2_000,
  });
  check("a stuck PDF process times out as a reasoned file error",
    timedOut.text === null && /timed out/.test(timedOut.error || ""), JSON.stringify(timedOut));
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

  // The statement ceiling: fifty chunky documents fit the doc and byte
  // ceilings while estimating far beyond the worker's 900-statement budget —
  // the exact shape a two-day Drive catch-up refused live with a 413.
  const chunky = mk(50, 40_000); // ~34 chunks -> ~77 statements per document
  const byStatements = batches(chunky);
  check("splits on estimated D1 statements", byStatements.length >= 5, String(byStatements.length));
  check("no batch exceeds the statement ceiling",
    byStatements.every((b) => b.reduce((n, x) => n + estimatedStatements(x.envelope), 0) <= 810));
  check("nothing is lost across statement splits", byStatements.flat().length === 50);
  // The local mirror must never drift from the worker's real estimator.
  for (const size of [0, 10, 1500, 1501, 40_000, MAX_DOC_CHARS]) {
    const envelope = { source_id: "probe", content: size ? "x".repeat(size) : "" };
    check(`statement estimate matches the worker at ${size} chars`,
      estimatedStatements(envelope) === estimateD1IngestStatements({}, [envelope]),
      `${estimatedStatements(envelope)} != ${estimateD1IngestStatements({}, [envelope])}`);
  }
  check("a maximally split part still fits one batch alone",
    estimatedStatements({ source_id: "p", content: "x".repeat(MAX_DOC_CHARS) }) <= 810);

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

  // The streaming path is the one Drive and Gmail actually use, and it is
  // where the second live 413 came from: the statement ceiling landed in
  // batches() first while this loop kept packing chunky documents blind.
  const chunkyStream = batchStream(
    Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` })),
    async (file) => ({ hash: `h-${file.id}`, rel: file.id, envelope: { source_id: file.id, content: "x".repeat(40_000) } }),
    { maxBytes: 1e9 },
  );
  const chunkyBatches = [];
  for await (const group of chunkyStream) chunkyBatches.push(group);
  check("the stream splits on estimated D1 statements", chunkyBatches.length >= 5, String(chunkyBatches.length));
  check("no streamed batch exceeds the statement ceiling",
    chunkyBatches.every((b) => b.reduce((n, x) => n + estimatedStatements(x.envelope), 0) <= 810));
  check("nothing is lost across streamed statement splits", chunkyBatches.flat().length === 50);
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
