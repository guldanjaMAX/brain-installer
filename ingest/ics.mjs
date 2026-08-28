/**
 * iCalendar (.ics) to readable event text.
 *
 * WHY THIS DOES NOT RENDER ITS OWN EVENTS. `connectors/google-calendar.mjs`
 * already decided, at length and with reasons written down, how a meeting
 * should read once it is inside a brain: the "When" line that carries both the
 * spelled date and the ISO one, rooms separated from people, declined
 * attendees separated from attendees, a recurrence rule spelled out in English
 * because nobody searches for "FREQ=WEEKLY;BYDAY=TU", and conference URLs
 * stripped of the query string that is really the meeting password.
 *
 * An .ics file is the same meeting arriving through a different door. If it
 * rendered differently, the brain would answer the same question two ways
 * depending on which door a meeting came in through, and the second renderer
 * would drift from the first the moment either was touched. So this module's
 * whole job is to turn iCalendar into the shape `renderEvent` already accepts,
 * and then get out of the way.
 *
 * The connector is imported LAZILY, inside the extractor, so that ingesting a
 * folder with no calendar export in it never loads the Google connector at
 * all.
 */

/** Rendered per file. An exported calendar is a corpus; a document is not. */
export const MAX_EVENTS = 500;

/**
 * Undo RFC 5545 line folding.
 *
 * A continuation line begins with a space or tab and belongs to the previous
 * line. Real exports fold aggressively — a long description is dozens of
 * fragments — so joining them wrong is the difference between a sentence and a
 * column of syllables.
 */
export function unfoldIcsLines(text) {
  const raw = String(text || "").split(/\r?\n/);
  const lines = [];
  for (const line of raw) {
    if (lines.length && /^[ \t]/.test(line)) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

/** `DTSTART;TZID=America/Phoenix:20260612T180000` → name, params, value. */
function parseProperty(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const pieces = head.split(";");
  const name = pieces[0].trim().toUpperCase();
  if (!name) return null;
  const params = {};
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    params[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** RFC 5545 escapes: \n \, \; \\ . Everything else is literal. */
function unescapeText(value) {
  return String(value || "").replace(/\\([nN,;\\])/g, (_, ch) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/**
 * An iCalendar timestamp into the Calendar API's start/end shape.
 *
 * The literal local fields are kept as text and NOT normalized to UTC, for the
 * reason `readEventTime` documents: 6pm with an offset attached is already
 * local truth, and converting it moves a late-evening meeting to the next day
 * in every date filter and every "what did I do in June" answer.
 */
export function icsTimeToSlot(property) {
  if (!property) return null;
  const value = String(property.value || "").trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || property.params.VALUE === "DATE") {
    if (!dateOnly) return null;
    return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}` };
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!stamp) return null;
  const local = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}`;
  const slot = { dateTime: stamp[7] ? `${local}Z` : local };
  if (property.params.TZID) slot.timeZone = property.params.TZID;
  return slot;
}

const personOf = (property) => {
  if (!property) return null;
  const email = String(property.value || "").replace(/^mailto:/i, "").trim();
  const name = property.params.CN ? unescapeText(property.params.CN) : null;
  if (!email && !name) return null;
  return { email: email || null, displayName: name || null };
};

/**
 * One VEVENT into the object `renderEvent` expects.
 *
 * The mapping is deliberately narrow. iCalendar carries a great deal that is
 * never an answer to a question (SEQUENCE, TRANSP, CLASS, alarms), and the
 * connector already dropped the Google equivalents of all of it.
 */
function eventFromLines(lines) {
  const event = { attendees: [], recurrence: [] };
  let uid = null;
  for (const line of lines) {
    const property = parseProperty(line);
    if (!property) continue;
    switch (property.name) {
      case "UID": uid = String(property.value || "").trim(); break;
      case "SUMMARY": event.summary = unescapeText(property.value); break;
      case "DESCRIPTION": event.description = unescapeText(property.value); break;
      case "LOCATION": event.location = unescapeText(property.value); break;
      case "DTSTART": event.start = icsTimeToSlot(property); break;
      case "DTEND": event.end = icsTimeToSlot(property); break;
      case "RRULE": event.recurrence.push(`RRULE:${property.value}`); break;
      case "LAST-MODIFIED": {
        const slot = icsTimeToSlot(property);
        if (slot?.dateTime) event.updated = slot.dateTime;
        break;
      }
      case "ORGANIZER": {
        const person = personOf(property);
        if (person) event.organizer = person;
        break;
      }
      case "ATTENDEE": {
        const person = personOf(property);
        if (!person) break;
        const type = String(property.params.CUTYPE || "").toUpperCase();
        // A room is an attendee in both formats and a person in neither.
        if (type === "ROOM" || type === "RESOURCE") person.resource = true;
        if (String(property.params.PARTSTAT || "").toUpperCase() === "DECLINED") {
          person.responseStatus = "declined";
        }
        event.attendees.push(person);
        break;
      }
      default: break;
    }
  }
  // DTEND is optional; an event with neither an end nor a duration still has a
  // start, and describeWhen handles a missing end without inventing one.
  if (!event.start) return null;
  if (!event.recurrence.length) delete event.recurrence;
  return { uid, event };
}

/**
 * Split a calendar into its VEVENT blocks.
 *
 * Only VEVENT. A VTODO, VJOURNAL, VFREEBUSY or VTIMEZONE block is either not a
 * meeting or is the timezone definitions supporting one, and reading the
 * timezone table as if it were content is exactly the kind of confident
 * nonsense this product exists to avoid.
 */
export function parseIcs(text) {
  const lines = unfoldIcsLines(text);
  const isCalendar = lines.some((line) => /^BEGIN:VCALENDAR\s*$/i.test(line.trim()));
  const events = [];
  let calendarName = null;
  let current = null;
  let malformed = 0;
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (current) {
      // A VEVENT can contain a VALARM, and a VALARM has its own DESCRIPTION.
      // Reading nested blocks as event properties overwrites the meeting's own
      // description with "Reminder", which looks like a working extractor and
      // is a lie about the meeting.
      if (/^BEGIN:/i.test(trimmed)) { depth++; continue; }
      if (/^END:VEVENT$/i.test(trimmed) && depth === 0) {
        const parsed = eventFromLines(current);
        if (parsed) events.push(parsed);
        else malformed++;
        current = null;
        continue;
      }
      if (/^END:/i.test(trimmed)) { depth = Math.max(depth - 1, 0); continue; }
      if (depth === 0) current.push(line);
      continue;
    }
    if (/^BEGIN:VEVENT$/i.test(trimmed)) {
      current = [];
      depth = 0;
      continue;
    }
    if (/^X-WR-CALNAME[;:]/i.test(trimmed)) {
      const property = parseProperty(trimmed);
      if (property) calendarName = unescapeText(property.value);
    }
  }
  // An unterminated final VEVENT is a truncated file, not an event.
  if (current) malformed++;

  return { isCalendar, events, malformed, calendarName };
}
