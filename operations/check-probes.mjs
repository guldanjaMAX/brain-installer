/**
 * The facts worth asking a corpus about, because they CHANGE.
 *
 * A probe is a retrieval query plus a way to pull candidate values out of the
 * text that comes back. Everything here is generic: no client's details appear
 * in this file, and none should. A brain that knows nothing about insurance
 * simply reports that category as absent, which is itself worth knowing.
 *
 * Extraction is deliberately regex, not a model. A sweep that costs money is a
 * sweep nobody runs twice, and these categories have shapes. Where a category
 * has no reliable shape (who is a client, which accountant), `freeform: true`
 * says so and the owner reads the records themselves rather than being shown
 * a machine's guess at a value.
 */

const money = /(?:\$\s?)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
const usPhone = /(?:\+1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/g;
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const usStreet = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}\s+(?:Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Pkwy)\b\.?/g;
const zip = /\b\d{5}(?:-\d{4})?\b/g;

/** Pull every match, de-duplicated, capped so one chatty document cannot flood a group. */
const all = (rx) => (text) => {
  const seen = new Set();
  for (const m of String(text || "").matchAll(rx)) {
    const v = (m[0] || "").trim();
    if (v) seen.add(v);
    if (seen.size >= 4) break;
  }
  return [...seen];
};

export const PROBES = Object.freeze([
  { name: "Mailing address", changes: true, extract: all(usStreet),
    query: "current mailing address home address where they live street address" },
  { name: "Postal code", changes: true, extract: all(zip),
    query: "zip code postal code city state address" },
  { name: "Mobile number", changes: true, extract: all(usPhone),
    query: "mobile number cell phone number best number to reach" },
  { name: "Primary email", changes: true, extract: all(email),
    query: "email address contact email primary email" },
  { name: "Recurring monthly amounts", changes: true, extract: all(money),
    query: "monthly retainer subscription premium recurring payment per month" },

  // No dependable shape, so show the records and let the owner read them.
  { name: "Who currently pays them", changes: true, freeform: true,
    query: "current client active retainer who pays us engagement ongoing" },
  { name: "Bank and card accounts", changes: true, freeform: true,
    query: "bank account checking savings credit card issuer where money is held" },
  { name: "Insurance", changes: true, freeform: true,
    query: "insurance policy carrier health auto home liability coverage" },
  { name: "Accountant, lawyer, doctor", changes: true, freeform: true,
    query: "accountant CPA attorney lawyer physician doctor advisor who we use" },
  { name: "Medications and conditions", changes: true, freeform: true,
    query: "medication prescription dose diagnosis condition treatment" },
  { name: "Household and dependants", changes: true, freeform: true,
    query: "spouse partner children dependants who lives in the household marital status" },
  { name: "Entities and ownership", changes: true, freeform: true,
    query: "LLC entity ownership percentage member manager shareholder" },

  // Stable facts, included as a control: agreement here is genuinely fine, and
  // a conflict means a records error rather than a change.
  { name: "Date of birth", changes: false, freeform: true,
    query: "date of birth born birthday" },
  { name: "Education", changes: false, freeform: true,
    query: "degree university college major graduated" },
]);

/** Turn search rows into candidates for one probe. */
export function candidatesFrom(probe, rows = []) {
  const out = [];
  for (const r of rows) {
    const doc = {
      source: r.source, title: r.title, uri: r.uri,
      date: r.document_date || r.date || null,
      text: r.text,
    };
    if (probe.freeform) { out.push({ value: null, doc }); continue; }
    for (const value of probe.extract(r.text)) out.push({ value, doc });
  }
  return out;
}
