/**
 * LinkedIn Download Your Data export reader.
 *
 * This path is export-only. It does not scrape LinkedIn, use a browser cookie,
 * or claim live API coverage. Every archive entry shares the common streaming
 * ZIP bounds before any selected CSV is retained.
 */

import { ArchiveSafetyError, extractZipEntries } from "./archive.mjs";

const KNOWN = new Map([
  ["connections.csv", "Connections"], ["positions.csv", "Positions"],
  ["education.csv", "Education"], ["recommendations_received.csv", "Recommendations received"],
  ["recommendations_given.csv", "Recommendations given"], ["messages.csv", "Messages"],
  ["invitations.csv", "Invitations"], ["skills.csv", "Skills"],
  ["projects.csv", "Projects"], ["certifications.csv", "Certifications"],
  ["learning.csv", "Learning"], ["profile.csv", "Profile"],
  ["company_follows.csv", "Company follows"], ["saved_jobs.csv", "Saved jobs"],
  ["job_applications.csv", "Job applications"], ["articles.csv", "Articles"],
  ["comments.csv", "Comments"], ["shares.csv", "Shares"],
]);

export const LINKEDIN_MAX_ROWS_PER_CSV = 50_000;
const keyFor = (name) => String(name || "").replace(/\\/g, "/").split("/").at(-1)
  .toLowerCase().replace(/\s+/g, "_");

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((candidate) => candidate.some((value) => String(value).trim()));
}

function selectedEntries(bytes) {
  return extractZipEntries(bytes, {
    select: (name) => KNOWN.has(keyFor(name)),
    label: "LinkedIn export",
  }).entries;
}

export function detectLinkedInArchive(bytes) {
  try { return selectedEntries(new Uint8Array(bytes)).size > 0; }
  catch { return false; }
}

const safeIso = (value) => {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function renderCsv(label, rows) {
  if (rows.length < 2) return null;
  const headers = rows[0].map((header, index) => String(header || `Column ${index + 1}`).trim());
  const dataRows = rows.slice(1);
  const shown = dataRows.slice(0, LINKEDIN_MAX_ROWS_PER_CSV);
  const rendered = [];
  for (const values of shown) {
    const fields = headers.map((header, index) => {
      const value = String(values[index] ?? "").replace(/\r\n/g, "\n").trim();
      return value ? `${header}: ${value}` : null;
    }).filter(Boolean);
    if (fields.length) rendered.push(fields.join("\n"));
  }
  if (!rendered.length) return null;
  const omitted = Math.max(0, dataRows.length - shown.length);
  return {
    content: [
      `LinkedIn ${label}`, `Rows indexed: ${rendered.length}`,
      omitted ? `Rows not indexed beyond the limit: ${omitted}` : null,
      "", rendered.join("\n\n---\n\n"),
    ].filter((value) => value !== null).join("\n"),
    indexed: rendered.length,
    total: dataRows.length,
    omitted,
  };
}

export function parseLinkedInArchive(bytes, { sourceName = "linkedin", archivePath = "linkedin-export.zip" } = {}) {
  let entries;
  try { entries = selectedEntries(new Uint8Array(bytes)); }
  catch (error) {
    const reason = error instanceof ArchiveSafetyError && error.code === "invalid_archive"
      ? "the file is not a readable ZIP archive"
      : error instanceof ArchiveSafetyError
      ? `the LinkedIn ZIP failed archive safety validation (${error.code})`
      : "the file is not a readable ZIP archive";
    return { envelopes: [], skipped: [], error: reason };
  }
  if (!entries.size) {
    return { envelopes: [], skipped: [], error: "the ZIP contains no recognized LinkedIn Download Your Data CSV files" };
  }
  const normalizedArchivePath = String(archivePath).replace(/\\/g, "/");
  const envelopes = [];
  const skipped = [];
  const recognizedKeys = [...entries.keys()].map(keyFor);
  const duplicateKey = recognizedKeys.find((key, index) => recognizedKeys.indexOf(key) !== index);
  if (duplicateKey) {
    return { envelopes: [], skipped: [], error: `the ZIP contains duplicate recognized LinkedIn file name ${duplicateKey}` };
  }
  for (const [name, bytesValue] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = keyFor(name);
    const label = KNOWN.get(key);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytesValue); }
    catch { skipped.push({ file: name, reason: "the CSV is not readable as UTF-8" }); continue; }
    let rows;
    try { rows = parseCsv(text); }
    catch { skipped.push({ file: name, reason: "the CSV is malformed" }); continue; }
    const rendered = renderCsv(label, rows);
    if (!rendered) { skipped.push({ file: name, reason: "the CSV has no populated data rows" }); continue; }
    const first = rows[1] || [];
    const headers = rows[0].map((header) => String(header).toLowerCase());
    const dateIndex = headers.findIndex((header) => /(?:date|time|started on|ended on|connected on)/.test(header));
    const occurredAt = dateIndex >= 0 ? safeIso(first[dateIndex]) : null;
    envelopes.push({
      source_type: sourceName,
      source_id: `linkedin:${normalizedArchivePath}:${key}`,
      title: `LinkedIn ${label}`,
      content: rendered.content,
      occurred_at: occurredAt,
      date_source: occurredAt ? "linkedin:export_row" : "none",
      date_reliable: Boolean(occurredAt),
      uri: `${normalizedArchivePath}#${name}`,
      metadata: {
        category: "linkedin_export", platform: "linkedin", access_mode: "account_owner_export",
        export_file: name, row_count: rendered.total, indexed_row_count: rendered.indexed,
        omitted_row_count: rendered.omitted,
      },
    });
  }
  return envelopes.length
    ? { envelopes, skipped, error: null }
    : { envelopes: [], skipped, error: "the recognized LinkedIn CSV files contained no readable data rows" };
}
