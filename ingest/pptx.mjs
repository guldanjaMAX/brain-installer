/** Shared semantic ordering for local and owner-upload PowerPoint extraction. */

import { strFromU8 } from "fflate";

const SLIDE = /^ppt\/slides\/slide([1-9]\d*)\.xml$/;
const NOTES = /^ppt\/notesSlides\/notesSlide([1-9]\d*)\.xml$/;
const SLIDE_RELS = /^ppt\/slides\/_rels\/slide([1-9]\d*)\.xml\.rels$/;

export function isPptxSemanticEntry(name) {
  return SLIDE.test(name) || NOTES.test(name) || SLIDE_RELS.test(name);
}

function relationshipAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? "") : null;
}

/** Return the package path of the notes slide named by one slide relationship file. */
function notesTarget(xml) {
  for (const match of String(xml).matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi)) {
    const tag = match[0];
    const type = relationshipAttribute(tag, "Type");
    const target = relationshipAttribute(tag, "Target");
    const mode = relationshipAttribute(tag, "TargetMode");
    if (!type?.endsWith("/notesSlide") || !target || /^external$/i.test(mode || "")) continue;
    const notes = target.replaceAll("\\", "/").match(/(?:^|\/)notesSlide([1-9]\d*)\.xml$/i);
    if (notes) return `ppt/notesSlides/notesSlide${notes[1]}.xml`;
  }
  return null;
}

function compareNumericIds(a, b) {
  return a.length - b.length || a.localeCompare(b);
}

/**
 * Render selected PPTX package parts in numeric narrative order.
 *
 * ZIP entry order and lexical filename order are not slide order: slide10.xml
 * sorts ahead of slide2.xml. Notes are package parts too, but their slide
 * relationship makes them part of that slide's narrative rather than a
 * separate notes section. The caller supplies its existing XML-to-text
 * converter so local and Worker extraction keep their established whitespace
 * and entity behavior while sharing ordering and association semantics.
 */
export function renderPptxEntries(entries, xmlToText) {
  if (!(entries instanceof Map)) throw new TypeError("PPTX entries must be a Map");
  if (typeof xmlToText !== "function") throw new TypeError("PPTX XML converter is required");

  const slides = [];
  const notesByPath = new Map();
  const relationshipsBySlide = new Map();

  for (const [name, bytes] of entries) {
    let match = name.match(SLIDE);
    if (match) {
      slides.push({ number: match[1], name, xml: strFromU8(bytes) });
      continue;
    }
    match = name.match(NOTES);
    if (match) {
      notesByPath.set(name, { number: match[1], xml: strFromU8(bytes) });
      continue;
    }
    match = name.match(SLIDE_RELS);
    if (match) relationshipsBySlide.set(match[1], strFromU8(bytes));
  }

  slides.sort((a, b) => compareNumericIds(a.number, b.number) || a.name.localeCompare(b.name));
  const sections = [];
  const usedNotes = new Set();
  for (const slide of slides) {
    const slideText = String(xmlToText(slide.xml) || "").trim();
    const relatedPath = notesTarget(relationshipsBySlide.get(slide.number));
    // Older or minimal OOXML producers sometimes omit the relationship file.
    // In that case the conventional same-number notes slide is the only safe
    // association. Relationship metadata wins whenever it exists.
    const notesPath = relatedPath || `ppt/notesSlides/notesSlide${slide.number}.xml`;
    const notes = notesByPath.get(notesPath);
    const notesText = notes ? String(xmlToText(notes.xml) || "").trim() : "";
    if (notes) usedNotes.add(notesPath);

    if (slideText) sections.push(`Slide ${slide.number}\n${slideText}`);
    if (notesText) sections.push(`Notes for slide ${slide.number}\n${notesText}`);
  }

  // Do not silently discard a malformed producer's orphaned notes. Valid
  // notes remain beside their slide; unassociated notes keep a stable label at
  // the end so their text stays searchable without inventing an owner.
  const orphanedNotes = [...notesByPath]
    .filter(([path]) => !usedNotes.has(path))
    .sort((a, b) => compareNumericIds(a[1].number, b[1].number) || a[0].localeCompare(b[0]));
  for (const [, notes] of orphanedNotes) {
    const text = String(xmlToText(notes.xml) || "").trim();
    if (text) sections.push(`Unassociated notes ${notes.number}\n${text}`);
  }

  return Object.freeze({
    text: sections.join("\n\n").trim(),
    slideCount: slides.length,
    orphanedNotes: orphanedNotes.length,
  });
}
