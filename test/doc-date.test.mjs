import { documentDate, parseDateFrom } from "../ingest/doc-date.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };
const iso = (v) => (v === null ? null : new Date(v).toISOString().slice(0, 10));

/* ---- the formats real files actually use ---- */
check("ISO in a filename", iso(parseDateFrom("2026-08-14 Jay install review.md")?.value) === "2026-08-14");
check("compact ISO", iso(parseDateFrom("IMG_20240304_note.txt")?.value) === "2024-03-04");
check("underscored", iso(parseDateFrom("2024_03_04 minutes")?.value) === "2024-03-04");
check("named month, US order", iso(parseDateFrom("Signed March 4, 2024 by both")?.value) === "2024-03-04");
check("named month, day first", iso(parseDateFrom("dated 4 Mar 2024")?.value) === "2024-03-04");
check("abbreviated with a period", iso(parseDateFrom("Sep. 9, 2023")?.value) === "2023-09-09");

/* ---- ambiguity must be FLAGGED, not resolved silently ---- */
{
  const a = parseDateFrom("invoice 03/04/2024");
  check("slashed date parses", iso(a?.value) === "2024-03-04", JSON.stringify(a));
  check("and is marked unreliable, because D/M order is a guess", a.reliable === false);
  const b = parseDateFrom("invoice 13/04/2024");
  check("when the order cannot be ambiguous it is reliable", b && b.reliable === true && iso(b.value) === "2024-04-13", JSON.stringify(b));
}
{
  const m = parseDateFrom("Q1 report, March 2024");
  check("a bare month anchors to the 1st", iso(m?.value) === "2024-03-01");
  check("and says day precision was never there", m.reliable === false && /month precision/.test(m.note));
}

/* ---- what must NOT be read as a date ---- */
check("an invoice number is not a date", parseDateFrom("Invoice 84521") === null);
check("a dollar amount is not a date", parseDateFrom("total was 376107 dollars") === null);
check("an impossible day is rejected, not rolled forward", parseDateFrom("2024-02-31") === null);
check("a year outside the plausible range is rejected", parseDateFrom("part number 9999-13-40") === null);
check("empty input", parseDateFrom("") === null);

/* ---- the ladder, most trustworthy first ---- */
{
  const r = documentDate({ filename: "2026-08-14 review.md", relPath: "2019/old/", contentHead: "dated 1999-01-01" });
  check("filename beats path and content", iso(r.value) === "2026-08-14" && r.source === "filename", JSON.stringify(r));
}
{
  const r = documentDate({ filename: "statement.pdf", relPath: "Bank/2023-11/", contentHead: "no date here" });
  check("path is used when the filename has none", iso(r.value) === "2023-11-01" && r.source === "path", JSON.stringify(r));
}
{
  const r = documentDate({ filename: "notes.txt", relPath: "misc/", contentHead: "Meeting held March 4, 2024 at the office" });
  check("content is the last resort", iso(r.value) === "2024-03-04" && r.source === "content", JSON.stringify(r));
  check("and content-derived dates are never called reliable", r.reliable === false);
}
{
  const r = documentDate({ filename: "notes.txt", relPath: "misc/", contentHead: "nothing dateable here at all" });
  check("no date is a real answer, not a fallback to today", r.value === null && r.source === "none", JSON.stringify(r));
}
{
  // A date 900 chars in is as likely a deadline or a birth date as the doc's own.
  const r = documentDate({ filename: "x.txt", relPath: "", contentHead: "z".repeat(1300) + " March 4, 2024" });
  check("a date past the head window is ignored", r.value === null, JSON.stringify(r));
}

/* ---- the guard that makes the original bug impossible ---- */
{
  let threw = false;
  try { documentDate({ filename: "x.txt" }, { mtime: Date.now() }); } catch (e) { threw = e instanceof TypeError; }
  check("passing an mtime throws rather than being accepted", threw);
  let threw2 = false;
  try { documentDate({ filename: "x.txt" }, { modified_time: 1 }); } catch (e) { threw2 = e instanceof TypeError; }
  check("and so does modified_time", threw2);
}

console.log(fail ? `\n${fail} FAILURES` : `\ndoc-date: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
