/**
 * Google Calendar connector.
 *
 * Turns a client's calendars into brain documents. Calendar is connective
 * tissue: the brain already holds transcripts and email but is INFERRING the
 * relationship graph from them. Calendar hands it over directly, with dates
 * and attendee lists that are structured rather than guessed.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED AGAINST GOOGLE'S DOCS, 2026-08-16. Each of these changed the design.
 * ---------------------------------------------------------------------------
 *
 * 1. `calendar.events.readonly` is SENSITIVE, not restricted, so no CASA
 *    assessment and no annual re-audit. Google's own sensitive-scope page uses
 *    "reading events stored in Google Calendar" as its worked example, and
 *    projects requesting only sensitive scopes are exempt from the third-party
 *    security assessment.
 *
 * 2. `calendar.events.readonly` does NOT authorize `calendarList.list`. That
 *    endpoint accepts only calendar.readonly, calendar, calendar.calendarlist
 *    and calendar.calendarlist.readonly. So at minimum scope the connector
 *    CANNOT discover which calendars exist. Calendars are therefore explicit
 *    config, defaulting to "primary". Asking for calendarList would widen the
 *    scope past the minimum for the sake of a convenience we do not need,
 *    since the intake call already establishes which calendars matter.
 *
 * 3. syncToken may not be combined with iCalUID, orderBy,
 *    privateExtendedProperty, q, sharedExtendedProperty, timeMin, timeMax or
 *    updatedMin. Sending one is a 400, and every other parameter must stay
 *    identical to the initial request or the behaviour is undefined. That is
 *    why config changes force a resync (see PARAM FINGERPRINT below).
 *
 * 4. syncToken forbids showDeleted=false outright: "All events deleted since
 *    the previous list request will always be in the result set and it is not
 *    allowed to set showDeleted to False." So showDeleted is pinned true on
 *    BOTH the full and the incremental sync. It is not a preference.
 *
 * 5. A 410 means the sync token is dead (reason `fullSyncRequired`) and the
 *    only correct response is to discard local state for that calendar and
 *    resync in full.
 *
 * 6. Refresh tokens die on: user revocation, SIX MONTHS of non-use, a password
 *    change when Gmail scopes are attached, exceeding the live-token cap, and
 *    admin policy. Separately, an OAuth app left in TESTING publishing status
 *    is issued refresh tokens that expire after SEVEN DAYS. That last one is
 *    the failure mode this product cannot survive quietly: the brain stops
 *    updating about a week after handoff and looks like it broke on its own.
 *    `invalid_grant` therefore raises an error that names the cause and the
 *    fix rather than a bare HTTP status.
 *
 * ---------------------------------------------------------------------------
 * WHY singleEvents IS FALSE BY DEFAULT
 * ---------------------------------------------------------------------------
 *
 * singleEvents=true expands a recurring event into one resource per instance.
 * For a calendar UI that is correct. For a retrieval brain it is actively
 * harmful, for three reasons:
 *
 *   a. Vector duplication. A weekly standup over two years becomes 104
 *      near-identical documents whose embeddings are nearly the same vector.
 *      Any query touching standups fills its top 5 with copies of one meeting
 *      and crowds out the one-off that actually answers the question. The
 *      product is sold on retrieval honesty, so this is a correctness issue
 *      wearing a performance costume.
 *
 *   b. No window to bound the expansion. timeMin and timeMax are forbidden
 *      alongside syncToken (see 3), so on every incremental sync there is no
 *      way to cap how far an unbounded "repeats forever" series expands.
 *
 *   c. Cost. Every instance is an embedding call and a stored row, paid by the
 *      client, for information that is by definition identical.
 *
 * With singleEvents=false the API still returns modified and cancelled
 * INSTANCES as their own resources carrying recurringEventId, so the
 * occurrences that genuinely differ are captured individually. The occurrences
 * that do not differ are exactly the ones that carry no new information.
 *
 * The cost of this choice is real and is paid in the renderer: a series master
 * carries only its first occurrence date, so "who did I meet about Henderson
 * in June" against a weekly Henderson series has to reason from the recurrence
 * rather than match a June date. `describeRecurrence` therefore renders the
 * RRULE into plain English with its span ("repeats weekly on Tuesday, from 7
 * April 2026 until 25 August 2026") so the span is in the embedded text rather
 * than locked inside an RRULE string that embeds as noise.
 *
 * Set singleEvents:true in config for a client who truly needs per-instance
 * records. It is supported, it is fingerprinted, and it will force a resync.
 */

import { fetchBrainWithAdminKey } from "../components/brain-http.mjs";

/* --------------------------------------------------------------- constants */

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_BASE = "https://www.googleapis.com/calendar/v3";

export const SOURCE_TYPE = "calendar_event";
export const SOURCE_SUBTYPE = "google_calendar";

// Sending any of these alongside syncToken is a 400.
export const SYNC_TOKEN_FORBIDDEN = Object.freeze([
  "iCalUID",
  "orderBy",
  "privateExtendedProperty",
  "q",
  "sharedExtendedProperty",
  "timeMin",
  "timeMax",
  "updatedMin",
]);

// workingLocation is one event per person per day saying "Home", and birthday
// recurs forever saying nothing. Both are pure index weight. The rest carry
// something a person might ask about, including outOfOffice, which is often
// the real answer to "why did nobody reply that week".
export const DEFAULT_EVENT_TYPES = Object.freeze(["default", "focusTime", "fromGmail", "outOfOffice"]);

const TOKEN_SKEW_MS = 60_000;
const MAX_BACKOFF_MS = 32_000;

// 403 is only retryable for quota reasons. A 403 for insufficient scope must
// fail on the first try: retrying it five times buries the one message that
// tells the installer the OAuth client is wrong.
const RETRYABLE_403_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
]);

/* ------------------------------------------------------------------ errors */

export class GoogleAuthError extends Error {
  constructor(message, { needsReconsent = false, status = 0, googleError = null } = {}) {
    super(message);
    this.name = "GoogleAuthError";
    this.needsReconsent = needsReconsent;
    this.status = status;
    this.googleError = googleError;
  }
}

export class CalendarApiError extends Error {
  constructor(message, { status = 0, reason = null } = {}) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.reason = reason;
  }
}

export class SyncTokenExpired extends Error {
  constructor(reason = "fullSyncRequired") {
    super(`sync token expired (${reason}); a full resync is required`);
    this.name = "SyncTokenExpired";
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------- auth */

/**
 * Access-token provider over a long-lived refresh token.
 *
 * Access tokens last an hour; refresh tokens last until something kills them.
 * The token is cached with a minute of skew so a token that expires in flight
 * does not produce a 401 on every call, and concurrent callers share one
 * in-flight refresh instead of racing N of them against the token endpoint
 * (which is itself a way to trip the live-token cap).
 */
export function createTokenProvider({
  clientId,
  clientSecret = null,
  refreshToken,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!clientId) throw new GoogleAuthError("clientId is required");
  if (!refreshToken) throw new GoogleAuthError("refreshToken is required");

  let accessToken = null;
  let expiresAt = 0;
  let inflight = null;
  let refreshes = 0;

  async function doRefresh() {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    // Optional: a native/PKCE client has no secret. A web client does.
    if (clientSecret) body.set("client_secret", clientSecret);

    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* a non-JSON error body is still an error, handled below */
    }

    if (!res.ok || !data.access_token) {
      const code = data.error || `http_${res.status}`;
      if (code === "invalid_grant") {
        throw new GoogleAuthError(
          "Google rejected the refresh token (invalid_grant). It has been revoked or has expired. " +
            "The three causes worth checking first, in order of likelihood for this install: " +
            "(1) the OAuth app is still in TESTING publishing status, which expires every refresh token after 7 days " +
            "and is the reason a brain silently stops updating about a week after handoff. Publish it to production, " +
            "or register it as an Internal app if the client is on Google Workspace. " +
            "(2) the token went unused for six months. " +
            "(3) the owner revoked access, or changed their password while Gmail scopes were attached. " +
            "In every case the fix is the same: the client re-runs the consent flow and a new refresh token is stored.",
          { needsReconsent: true, status: res.status, googleError: code }
        );
      }
      throw new GoogleAuthError(`token refresh failed: ${code}${data.error_description ? ` (${data.error_description})` : ""}`, {
        status: res.status,
        googleError: code,
      });
    }

    refreshes += 1;
    accessToken = data.access_token;
    expiresAt = now() + (Number(data.expires_in) || 3600) * 1000 - TOKEN_SKEW_MS;
    return accessToken;
  }

  return {
    async get({ force = false } = {}) {
      if (force) {
        accessToken = null;
        expiresAt = 0;
      }
      if (accessToken && now() < expiresAt) return accessToken;
      if (!inflight) {
        inflight = doRefresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    stats: () => ({ refreshes, expiresAt, cached: Boolean(accessToken) }),
  };
}

/* ------------------------------------------------------------------ config */

export function normalizeConfig(config = {}) {
  const calendars = (config.calendars && config.calendars.length ? config.calendars : ["primary"]).map((c) => {
    const entry = typeof c === "string" ? { id: c } : { ...c };
    const id = String(entry.id || "").trim();
    if (!id) throw new CalendarApiError("every calendar entry needs an id");
    // `key` is the IDENTITY used in source_ids; `id` is the ADDRESS sent to
    // Google. They are separate on purpose. "primary" and the owner's actual
    // calendar address are the same calendar, so a client who later swaps one
    // for the other in config would otherwise re-ingest every event under new
    // source_ids and duplicate the entire calendar. Pinning `key` at install
    // makes the address changeable without touching identity.
    const key = String(entry.key || id).trim().toLowerCase();
    return { id, key, label: entry.label || null };
  });

  const seen = new Set();
  for (const c of calendars) {
    if (seen.has(c.key)) throw new CalendarApiError(`duplicate calendar key "${c.key}"; keys must be unique`);
    seen.add(c.key);
  }

  return {
    calendars,
    // See the header block. Changing this is supported and forces a resync.
    singleEvents: config.singleEvents === true,
    eventTypes:
      config.eventTypes === null
        ? []
        : Array.isArray(config.eventTypes) && config.eventTypes.length
          ? [...config.eventTypes].sort()
          : [...DEFAULT_EVENT_TYPES],
    // timeMin on the FULL sync only. Google's own sync sample does exactly
    // this: restrict the initial sync to a window, then let the returned token
    // carry the restriction forward.
    fullSyncSince: config.fullSyncSince || null,
    // Not fingerprinted: page size changes which requests carry which events,
    // never which events exist. Forcing a full resync of every calendar over a
    // page-size tweak would be an expensive surprise for a harmless change.
    maxResults: Math.min(Math.max(parseInt(config.maxResults, 10) || 250, 1), 2500),
    ownerEmail: config.ownerEmail ? String(config.ownerEmail).toLowerCase() : null,
    maxAttendeesListed: Math.max(parseInt(config.maxAttendeesListed, 10) || 40, 1),
    maxDescriptionChars: Math.max(parseInt(config.maxDescriptionChars, 10) || 1500, 100),
    maxContentChars: Math.max(parseInt(config.maxContentChars, 10) || 6000, 500),
    skipEmpty: config.skipEmpty !== false,
    // Not `|| 5`. Zero is a meaningful value here ("do not retry") and the
    // falsy-zero idiom silently turns it back into five, which is how a test
    // asking for one attempt got six. Every other numeric above has no useful
    // zero, so the idiom is safe there.
    maxRetries: Number.isInteger(parseInt(config.maxRetries, 10)) ? Math.max(parseInt(config.maxRetries, 10), 0) : 5,
  };
}

/**
 * Fingerprint of every parameter that changes WHICH events a sync token
 * covers.
 *
 * Google's rule is that the parameter set must not change across an
 * incremental series, and that violating it is undefined behaviour rather than
 * an error. Undefined behaviour that silently returns the wrong set of events
 * is exactly the failure this product cannot ship, so the fingerprint is
 * stored next to the token and a mismatch discards the token and resyncs.
 * A slow correct resync beats a fast wrong delta.
 */
export function paramFingerprint(config, calendar) {
  const cfg = config.calendars ? config : normalizeConfig(config);
  return [
    `v1`,
    `cal=${calendar ? calendar.id : ""}`,
    `single=${cfg.singleEvents}`,
    `deleted=true`,
    `types=${cfg.eventTypes.join(",")}`,
    `since=${cfg.fullSyncSince || ""}`,
  ].join("|");
}

/**
 * Build the events.list query string.
 *
 * The syncToken branch omits every forbidden parameter rather than trusting
 * the caller not to pass one, because a 400 here presents as "the connector is
 * broken" and costs an afternoon.
 */
export function buildListParams({ syncToken = null, pageToken = null, config = {} } = {}) {
  const cfg = config.calendars ? config : normalizeConfig(config);
  const p = new URLSearchParams();

  p.set("singleEvents", String(cfg.singleEvents));
  // Pinned true. syncToken forbids false and the parameter set must match
  // between the full and the incremental sync, so this is the only legal
  // consistent value. Deleted events arriving on a full sync are turned into
  // no-op deletions rather than documents.
  p.set("showDeleted", "true");
  p.set("maxResults", String(cfg.maxResults));
  for (const t of cfg.eventTypes) p.append("eventTypes", t);

  if (syncToken) {
    p.set("syncToken", syncToken);
  } else if (cfg.fullSyncSince) {
    p.set("timeMin", cfg.fullSyncSince);
  }
  if (pageToken) p.set("pageToken", pageToken);
  return p;
}

/* ------------------------------------------------------------- text tidying */

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function htmlToText(input) {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n");
  s = s.replace(/<\s*li\s*[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);
  return s;
}

/**
 * Everything from one of these markers to the end of the description is
 * machine-generated join instructions.
 *
 * This matters more than it looks. A Zoom invite tail is ~1500 characters of
 * dial-in numbers for forty countries, and it is IDENTICAL across every Zoom
 * meeting in the corpus. Embed it and every Zoom meeting becomes similar to
 * every other Zoom meeting, which is a corpus-wide retrieval failure produced
 * by a field nobody would ever search. Truncation is at the FIRST marker
 * because the human-written part is always above it.
 */
const BOILERPLATE_MARKERS = [
  /^-::~:~/,
  /^~-~-~-~/,
  /^_{10,}\s*$/,
  /^-{20,}\s*$/,
  /^={20,}\s*$/,
  /^join zoom meeting\b/i,
  /^join with google meet\b/i,
  /^join by google meet\b/i,
  /^microsoft teams (meeting|need help)/i,
  /^join (on your computer|the meeting now)\b/i,
  /^(please )?do not edit this section/i,
  /^dial by your location\b/i,
  /^one tap mobile\b/i,
  /^meeting id:\s*[\d\s]/i,
  /^join by phone\b/i,
  /^or dial:/i,
  /^learn more about meet at\b/i,
  /^this meeting is being recorded\b/i,
];

const DIAL_LINE = /^\+?\d[\d\s().+-]{7,}(\s|$)/;
const PASSCODE_LINE = /^(passcode|password|pin|meeting id|phone conference id)\s*:/i;

export function stripBoilerplate(description, { maxChars = 1500 } = {}) {
  const text = htmlToText(description);
  if (!text.trim()) return "";

  const lines = text.split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (BOILERPLATE_MARKERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
  }

  const kept = lines
    .slice(0, cut)
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      // Residual dial-in or credential lines above the marker.
      if (DIAL_LINE.test(t)) return false;
      if (PASSCODE_LINE.test(t)) return false;
      return true;
    })
    .join("\n");

  let out = kept
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (out.length > maxChars) out = `${out.slice(0, maxChars).trimEnd()}...`;
  return out;
}

/* ------------------------------------------------------------------- dates */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Read a Calendar start/end object WITHOUT converting timezones.
 *
 * `2026-06-12T18:00:00-07:00` is already local time with its offset attached.
 * Normalising it to UTC turns a 6pm Phoenix meeting into the 13th, and every
 * downstream date filter and every "in June" question then answers off the
 * wrong day. The literal fields are the local truth, so they are read as text.
 */
export function readEventTime(slot) {
  if (!slot) return null;
  const raw = slot.dateTime || slot.date;
  if (!raw) return null;
  const m = RFC3339.exec(String(raw));
  if (!m) return { allDay: !slot.dateTime, date: String(raw).slice(0, 10), time: null, offset: null, tz: slot.timeZone || null, raw };
  return {
    allDay: !slot.dateTime,
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: m[4] ? `${m[4]}:${m[5]}` : null,
    offset: m[6] || null,
    tz: slot.timeZone || null,
    raw: String(raw),
  };
}

function shiftDate(ymd, days) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function humanDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return ymd || "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[mo - 1]} ${y}`;
}

export function humanTime(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return hhmm || "";
  const H = Number(m[1]);
  const suffix = H < 12 ? "AM" : "PM";
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/**
 * The "When" line.
 *
 * Both the spelled month and the ISO date go in, because a person asks "in
 * June" and a filter wants 2026-06-12, and the two forms cost one line
 * together. Google's all-day `end.date` is EXCLUSIVE, so a one-day all-day
 * event ends on the following date and rendering it raw reports every all-day
 * event as a day longer than it was.
 */
export function describeWhen(event) {
  const start = readEventTime(event.start);
  const end = readEventTime(event.end);
  if (!start) return "When: not recorded";

  const zone = start.tz || (end && end.tz) || null;
  const zoneLabel = zone ? ` (${zone})` : start.offset && start.offset !== "Z" ? ` (UTC${start.offset})` : "";

  if (start.allDay) {
    const lastDay = end && end.date ? shiftDate(end.date, -1) : start.date;
    if (!end || lastDay <= start.date) {
      return `When: ${humanDate(start.date)} (${start.date}), all day`;
    }
    return `When: ${humanDate(start.date)} (${start.date}) through ${humanDate(lastDay)} (${lastDay}), all day`;
  }

  const startBit = `${humanDate(start.date)} (${start.date}), ${humanTime(start.time)}`;
  if (!end || !end.time) return `When: ${startBit}${zoneLabel}`;
  if (end.date === start.date) return `When: ${startBit} to ${humanTime(end.time)}${zoneLabel}`;
  return `When: ${startBit} to ${humanDate(end.date)} (${end.date}), ${humanTime(end.time)}${zoneLabel}`;
}

/* -------------------------------------------------------------- recurrence */

const BYDAY_NAMES = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
const FREQ_UNIT = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
const FREQ_ADVERB = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

/**
 * Render an RRULE in English.
 *
 * "RRULE:FREQ=WEEKLY;BYDAY=TU" embeds as noise: no query anyone types looks
 * like that. Since singleEvents is false, this sentence is the ONLY thing in
 * the document that says when the series actually ran, so it carries the whole
 * temporal signal for every recurring meeting in the corpus.
 */
export function describeRecurrence(recurrence, startDate) {
  if (!Array.isArray(recurrence) || !recurrence.length) return null;
  const rule = recurrence.find((r) => String(r).toUpperCase().startsWith("RRULE"));
  if (!rule) return null;

  const parts = {};
  for (const kv of String(rule).replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) parts[k.toUpperCase()] = v;
  }

  const freq = (parts.FREQ || "").toUpperCase();
  const interval = Math.max(parseInt(parts.INTERVAL, 10) || 1, 1);
  const unit = FREQ_UNIT[freq];
  if (!unit) return "repeats on a recurring schedule";

  let s = interval === 1 ? `repeats ${FREQ_ADVERB[freq]}` : `repeats every ${interval} ${unit}s`;

  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",")
      .map((d) => BYDAY_NAMES[d.replace(/^[+-]?\d+/, "").toUpperCase()] || d)
      .filter(Boolean);
    if (days.length === 1) s += ` on ${days[0]}`;
    else if (days.length > 1) s += ` on ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
  } else if (parts.BYMONTHDAY) {
    s += ` on day ${parts.BYMONTHDAY} of the month`;
  }

  if (startDate) s += `, from ${humanDate(startDate)}`;
  if (parts.UNTIL) {
    const u = String(parts.UNTIL);
    const ymd = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    s += ` until ${humanDate(ymd)}`;
  } else if (parts.COUNT) {
    s += `, ${parts.COUNT} times`;
  } else {
    s += ", with no end date";
  }
  return s;
}

/* ---------------------------------------------------------------- people */

function personLabel(p) {
  if (!p) return null;
  const email = p.email ? String(p.email) : null;
  const name = p.displayName ? String(p.displayName) : null;
  if (name && email) return `${name} <${email}>`;
  return name || email || null;
}

/**
 * Split attendees into the four groups that mean different things.
 *
 * Rooms are attendees in the API (`resource: true`) and people in nothing
 * else, so leaving them in the attendee list answers "who did I meet with"
 * with "Conference Room B". Declined attendees are separated because they did
 * not attend, and a brain that lists them as participants is stating something
 * false with a citation attached.
 */
export function partitionAttendees(attendees, { maxListed = 40 } = {}) {
  const people = [];
  const declined = [];
  const rooms = [];
  for (const a of Array.isArray(attendees) ? attendees : []) {
    const label = personLabel(a);
    if (!label) continue;
    if (a.resource === true) {
      // Name only. A room's address is an opaque generated string
      // (acme.com_room_b@resource.calendar.google.com) that nobody will ever
      // search for, and it sits in a line that does carry meaning.
      rooms.push(a.displayName ? String(a.displayName) : label);
    } else if (a.responseStatus === "declined") declined.push(label);
    else people.push(label);
  }
  const truncated = Math.max(people.length - maxListed, 0);
  return { people: people.slice(0, maxListed), truncated, declined, rooms };
}

/**
 * Strip the query and fragment off a conference URL.
 *
 * A Zoom entry point is really `https://us02web.zoom.us/j/812...?pwd=<secret>`,
 * and that query string is the meeting password. Two independent reasons it
 * must not survive:
 *
 *   1. It is a credential. The connector already drops `Passcode:` lines out
 *      of descriptions; the same secret arriving inside a URL is the same
 *      secret. A brain sold on custody does not index the keys to the room.
 *
 *   2. The worker's own credential gate refuses it. `pwd=<long token>` trips
 *      the scanner's env_assignment rule and the ingest returns 422, so
 *      shipping the raw URI would silently drop EVERY Zoom meeting from every
 *      install while the connector reported success. Found by running a
 *      rendered document through worker/src/lib/secret-scan.js rather than by
 *      reading either file.
 *
 * The path survives, so the link still identifies the meeting for a human
 * reading a citation. Anyone actually joining clicks through from their own
 * calendar, which is where the password belongs.
 */
export function sanitizeConferenceUri(uri) {
  if (!uri) return null;
  const s = String(uri);
  const cut = Math.min(
    s.indexOf("?") === -1 ? s.length : s.indexOf("?"),
    s.indexOf("#") === -1 ? s.length : s.indexOf("#")
  );
  return s.slice(0, cut) || null;
}

export function conferenceInfo(event) {
  const entries = event?.conferenceData?.entryPoints;
  let uri = null;
  if (Array.isArray(entries)) {
    const video = entries.find((e) => e.entryPointType === "video" && e.uri);
    uri = video ? video.uri : null;
  }
  if (!uri && event?.hangoutLink) uri = event.hangoutLink;
  const solution = event?.conferenceData?.conferenceSolution?.name || null;
  return { uri: sanitizeConferenceUri(uri), solution };
}

/* ---------------------------------------------------------------- renderer */

/**
 * One event, rendered for an embedding model.
 *
 * The ordering is deliberate. What a person searches for goes first and in
 * plain language; what only a person reading the citation needs goes last in a
 * short provenance band where it contributes little to the vector.
 *
 * Included because it is searched: title, attendee names AND emails (the email
 * domain is often the strongest signal a meeting belongs to a given client),
 * organizer, the date in both spoken and ISO form, the cleaned description,
 * the location, and the recurrence in words.
 *
 * Demoted to the last line because it is an opaque token nobody searches for
 * but a reader may need: the conference URL, the htmlLink, the event id.
 *
 * Dropped entirely: etag, sequence, colorId, reminders, extendedProperties,
 * per-attendee accepted/needsAction flags, and iCalUID. None of it is ever the
 * answer to a question, and all of it dilutes the vector.
 */
export function renderEvent(event, { calendar, config } = {}) {
  const cfg = config && config.calendars ? config : normalizeConfig(config || {});
  const cal = calendar || { id: "primary", key: "primary", label: null };

  const summary = (event.summary || "").trim() || "(untitled event)";
  const lines = [`Meeting: ${summary}`, describeWhen(event)];

  const organizer = personLabel(event.organizer);
  if (organizer) lines.push(`Organizer: ${organizer}`);

  const { people, truncated, declined, rooms } = partitionAttendees(event.attendees, {
    maxListed: cfg.maxAttendeesListed,
  });
  if (people.length) {
    lines.push(`Attendees: ${people.join(", ")}${truncated ? `, and ${truncated} more` : ""}`);
  } else if (!declined.length) {
    lines.push("Attendees: none listed (a solo block or a personal entry)");
  }
  if (declined.length) lines.push(`Declined: ${declined.join(", ")}`);

  // The owner declining is the difference between a meeting they were at and a
  // meeting they were merely invited to. Stating it prevents the brain
  // answering "who did you meet" with someone they never saw.
  if (cfg.ownerEmail) {
    const self = (event.attendees || []).find((a) => String(a.email || "").toLowerCase() === cfg.ownerEmail);
    if (self && self.responseStatus === "declined") lines.push("The calendar owner declined this invitation.");
  }

  const where = [event.location, rooms.length ? `room: ${rooms.join(", ")}` : null].filter(Boolean).join(" | ");
  if (where) lines.push(`Where: ${where}`);

  const conf = conferenceInfo(event);
  if (conf.solution) lines.push(`Video call: ${conf.solution}`);

  const startInfo = readEventTime(event.start);
  const recurrenceWords = describeRecurrence(event.recurrence, startInfo ? startInfo.date : null);
  if (recurrenceWords) lines.push(`Recurring: this is a series that ${recurrenceWords}.`);
  if (event.recurringEventId) {
    const orig = readEventTime(event.originalStartTime);
    lines.push(
      `Part of a recurring series${orig ? `; this occurrence was originally scheduled for ${humanDate(orig.date)}` : ""}.`
    );
  }

  if (event.eventType && event.eventType !== "default") lines.push(`Event type: ${event.eventType}`);

  const notes = stripBoilerplate(event.description, { maxChars: cfg.maxDescriptionChars });
  if (notes) lines.push("", "Notes:", notes);

  const calLabel = cal.label || cal.id;
  const provenance = [
    `Calendar: ${calLabel}`,
    conf.uri ? `Video link: ${conf.uri}` : null,
    event.htmlLink ? `Event link: ${event.htmlLink}` : null,
    event.updated ? `Last modified: ${String(event.updated).slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  lines.push("", provenance);

  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length > cfg.maxContentChars) out = `${out.slice(0, cfg.maxContentChars).trimEnd()}...`;
  return out;
}

/* --------------------------------------------------------------- envelopes */

/**
 * source_id: `gcal:<calendar key>:<event id>`.
 *
 * Event ids are stable for the life of an event, so re-running any sync
 * produces the same id for the same event and the ingest upserts rather than
 * duplicating. calendarKey rather than calendarId is deliberate, see
 * normalizeConfig: the address a client puts in config can change without the
 * identity changing.
 *
 * iCalUID is NOT used even though it is the cross-calendar identifier, because
 * every instance of a recurring series shares one iCalUID and they would
 * collapse onto a single document. It travels in metadata for anyone who wants
 * to dedupe the same meeting across two ingested calendars.
 */
export function sourceIdFor(calendarKey, eventId) {
  return `gcal:${String(calendarKey).toLowerCase()}:${eventId}`;
}

/**
 * One event to one instruction: upsert, delete, or skip.
 *
 * Cancelled events always become deletions rather than tombstone documents. A
 * document saying "this meeting was cancelled" would compete in retrieval with
 * the meetings that happened, which is the opposite of the point. On a first
 * full sync a deletion for something never ingested is a harmless no-op; after
 * a 410 resync it is the only mechanism that cleans up events deleted while
 * the token was dead, which is why it fires unconditionally.
 */
export function buildEnvelope(event, { calendar, config } = {}) {
  const cfg = config && config.calendars ? config : normalizeConfig(config || {});
  const cal = calendar || { id: "primary", key: "primary", label: null };
  const eventId = event && event.id;
  if (!eventId) return { kind: "skip", reason: "event has no id", event_id: null };

  const source_id = sourceIdFor(cal.key, eventId);

  if (event.status === "cancelled") {
    return { kind: "delete", source_id, event_id: eventId, reason: "event is cancelled or deleted" };
  }

  const start = readEventTime(event.start);
  if (!start) return { kind: "skip", source_id, event_id: eventId, reason: "event has no start time" };

  const hasSubstance =
    (event.summary && event.summary.trim()) ||
    (event.attendees && event.attendees.length) ||
    stripBoilerplate(event.description, { maxChars: cfg.maxDescriptionChars });
  if (cfg.skipEmpty && !hasSubstance) {
    return { kind: "skip", source_id, event_id: eventId, reason: "no title, attendees or description; nothing to retrieve" };
  }

  const content = renderEvent(event, { calendar: cal, config: cfg });
  const { people, declined, rooms } = partitionAttendees(event.attendees, { maxListed: cfg.maxAttendeesListed });
  const emails = (event.attendees || [])
    .filter((a) => a.email && a.resource !== true)
    .map((a) => String(a.email).toLowerCase());
  const domains = [...new Set(emails.map((e) => e.split("@")[1]).filter(Boolean))];
  const end = readEventTime(event.end);
  const conf = conferenceInfo(event);

  // occurred_at keeps the ORIGINAL offset rather than a UTC normalisation, so
  // slicing the first ten characters yields the local calendar date. A 6pm
  // Phoenix meeting normalised to UTC would file itself under the next day.
  const occurred_at = start.allDay ? start.date : start.raw;

  return {
    kind: "upsert",
    source_id,
    event_id: eventId,
    envelope: {
      source_type: SOURCE_TYPE,
      source_id,
      source_subtype: SOURCE_SUBTYPE,
      occurred_at,
      title: `${(event.summary || "(untitled event)").trim()} — ${start.date}`,
      content,
      metadata: {
        category: "calendar",
        // The worker copies metadata.attendees straight into the curated row,
        // so a declined invitee listed here without its marker would state,
        // with a citation attached, that someone attended a meeting they
        // turned down.
        attendees: [...people, ...declined.map((d) => `${d} (declined)`)].join("; ") || null,
        calendar_id: cal.id,
        calendar_key: cal.key,
        event_id: eventId,
        ical_uid: event.iCalUID || null,
        status: event.status || "confirmed",
        event_type: event.eventType || "default",
        organizer_email: event.organizer?.email ? String(event.organizer.email).toLowerCase() : null,
        attendee_emails: emails,
        attendee_domains: domains,
        declined_count: declined.length,
        room_count: rooms.length,
        start: start.raw,
        start_date: start.date,
        end: end ? end.raw : null,
        all_day: start.allDay,
        time_zone: start.tz || (end && end.tz) || null,
        is_recurring_master: Array.isArray(event.recurrence) && event.recurrence.length > 0,
        recurrence: Array.isArray(event.recurrence) ? event.recurrence : null,
        recurring_event_id: event.recurringEventId || null,
        location: event.location || null,
        conference_url: conf.uri,
        conference_solution: conf.solution,
        html_link: event.htmlLink || null,
        updated: event.updated || null,
      },
    },
  };
}

/* ------------------------------------------------------------------ http */

function backoffMs(attempt) {
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

function firstErrorReason(body) {
  const errs = body?.error?.errors;
  if (Array.isArray(errs) && errs.length && errs[0].reason) return errs[0].reason;
  return body?.error?.status || null;
}

async function calendarGet(path, params, ctx) {
  const url = `${API_BASE}${path}?${params.toString()}`;
  let authRetried = false;

  for (let attempt = 0; ; attempt++) {
    const token = await ctx.getAccessToken();
    let res;
    try {
      res = await ctx.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (e) {
      if (attempt >= ctx.maxRetries) throw new CalendarApiError(`network error after ${attempt + 1} attempts: ${e.message}`);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* handled by the status checks below */
    }
    if (res.ok) return body || {};

    const reason = firstErrorReason(body);

    // 410 is not an error to retry, it is an instruction to resync.
    if (res.status === 410) throw new SyncTokenExpired(reason || "fullSyncRequired");

    // One forced refresh, then give up. An access token minted seconds ago that
    // still 401s is a scope or client problem, and retrying it just burns quota.
    if (res.status === 401 && !authRetried) {
      authRetried = true;
      await ctx.getAccessToken({ force: true });
      continue;
    }

    const retryable =
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && RETRYABLE_403_REASONS.has(reason));
    if (retryable && attempt < ctx.maxRetries) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    const detail = body?.error?.message || text.slice(0, 200) || res.statusText;
    throw new CalendarApiError(`calendar API ${res.status}${reason ? ` (${reason})` : ""}: ${detail}`, {
      status: res.status,
      reason,
    });
  }
}

/**
 * Page through one calendar.
 *
 * nextSyncToken appears ONLY on the last page and is mutually exclusive with
 * nextPageToken, so a token is returned only when pagination genuinely ran to
 * the end. A caller that persists a token it did not earn skips every event on
 * the pages it never fetched, permanently and silently.
 */
export async function listEvents({ calendar, syncToken = null, config, ctx }) {
  const cfg = config.calendars ? config : normalizeConfig(config);
  const events = [];
  let pageToken = null;
  let nextSyncToken = null;
  let pages = 0;

  do {
    const params = buildListParams({ syncToken, pageToken, config: cfg });
    const body = await calendarGet(`/calendars/${encodeURIComponent(calendar.id)}/events`, params, ctx);
    pages += 1;
    if (Array.isArray(body.items)) events.push(...body.items);
    pageToken = body.nextPageToken || null;
    nextSyncToken = body.nextSyncToken || null;
  } while (pageToken);

  return { events, nextSyncToken, pages };
}

/* ------------------------------------------------------------------- sync */

function emptyState() {
  return { sync_token: null, param_fingerprint: null, last_synced_at: null, last_error: null, consecutive_failures: 0, full_syncs: 0 };
}

/**
 * Sync one calendar. Never throws for a per-calendar problem: the failure is
 * reported in the result so a broken calendar cannot take down the others.
 *
 * The state contract is the important part. The returned `state` is what the
 * caller persists, and on any failure it carries the INPUT sync token forward
 * unchanged. A token is only ever advanced by a run that paginated to the end
 * and got a nextSyncToken back. Everything already fetched by a failed run is
 * still returned and still safe to ingest, because source_ids are stable and a
 * re-ingest is an upsert.
 */
export async function syncCalendar({
  calendar,
  state = null,
  config = {},
  getAccessToken,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const cfg = config.calendars ? config : normalizeConfig(config);
  const prev = { ...emptyState(), ...(state || {}) };
  const fingerprint = paramFingerprint(cfg, calendar);
  const ctx = { getAccessToken, fetchImpl, sleep, maxRetries: cfg.maxRetries };

  const result = {
    calendar_key: calendar.key,
    calendar_id: calendar.id,
    ok: false,
    mode: "incremental",
    reset_reason: null,
    documents: [],
    deletions: [],
    skipped: [],
    events_seen: 0,
    pages: 0,
    error: null,
    state: { ...prev },
  };

  let syncToken = prev.sync_token;
  let tokenInvalidated = false;
  if (syncToken && prev.param_fingerprint && prev.param_fingerprint !== fingerprint) {
    // The stored token was minted under a different query. Google calls reusing
    // it undefined behaviour, and undefined behaviour that returns a plausible
    // subset is worse than an obvious failure.
    syncToken = null;
    result.reset_reason = "sync parameters changed since the stored token was issued";
  }
  if (!syncToken) result.mode = "full";

  let listing;
  try {
    try {
      listing = await listEvents({ calendar, syncToken, config: cfg, ctx });
    } catch (e) {
      if (!(e instanceof SyncTokenExpired)) throw e;
      // Documented recovery, once per run so a server that always 410s cannot
      // spin. Everything fetched before the 410 is discarded because a full
      // sync is about to return a superset of it anyway.
      result.mode = "full";
      result.reset_reason = `sync token rejected by Google (${e.reason}); resynced in full`;
      syncToken = null;
      // Google has declared the stored token dead. It must never be written
      // back, not even as a fallback when this resync fails to earn a new one.
      // Re-arming it guarantees another 410 next run, which resyncs in full
      // again, forever: a permanent full sync that still reports mode "full"
      // as though it were a one-off recovery.
      tokenInvalidated = true;
      listing = await listEvents({ calendar, syncToken: null, config: cfg, ctx });
    }
  } catch (e) {
    result.error = {
      message: e.message,
      name: e.name,
      status: e.status || null,
      needsReconsent: Boolean(e.needsReconsent),
    };
    result.state = {
      ...prev,
      param_fingerprint: prev.param_fingerprint,
      last_error: e.message,
      consecutive_failures: (prev.consecutive_failures || 0) + 1,
    };
    return result;
  }

  result.pages = listing.pages;
  result.events_seen = listing.events.length;

  for (const event of listing.events) {
    const out = buildEnvelope(event, { calendar, config: cfg });
    if (out.kind === "upsert") result.documents.push(out.envelope);
    else if (out.kind === "delete") result.deletions.push({ source_id: out.source_id, event_id: out.event_id, reason: out.reason });
    else result.skipped.push({ source_id: out.source_id || null, event_id: out.event_id, reason: out.reason });
  }

  result.ok = true;
  result.state = {
    // Only advance on a token we actually earned. Google omits nextSyncToken on
    // any page that is not the last one.
    sync_token: listing.nextSyncToken || (tokenInvalidated ? null : prev.sync_token) || null,
    param_fingerprint: fingerprint,
    last_synced_at: new Date(now()).toISOString(),
    last_error: null,
    consecutive_failures: 0,
    full_syncs: (prev.full_syncs || 0) + (result.mode === "full" ? 1 : 0),
  };
  if (!listing.nextSyncToken) {
    result.warning = tokenInvalidated
      ? "Google rejected the stored sync token and this resync earned no replacement, so the token was cleared. The next run does another full sync, which is correct but expensive: if it repeats, the parameter set is probably still changing between runs."
      : "Google returned no nextSyncToken; the stored token was left unchanged and the next run will repeat this range";
  }
  return result;
}

/**
 * Sync every configured calendar, keeping their failures independent.
 *
 * One exception to independence: a dead refresh token fails every calendar
 * identically, so the remaining calendars are short-circuited with the same
 * error rather than each re-hammering the token endpoint, which is itself one
 * of the ways Google revokes a refresh token.
 */
export async function syncAll({ config = {}, state = {}, getAccessToken, fetchImpl = fetch, sleep, now = () => Date.now() }) {
  const cfg = normalizeConfig(config);
  const calendars = cfg.calendars;
  if (!calendars.length) throw new CalendarApiError("no calendars configured");

  const results = [];
  const nextState = { ...state };
  let authDead = null;

  for (const calendar of calendars) {
    if (authDead) {
      results.push({
        calendar_key: calendar.key,
        calendar_id: calendar.id,
        ok: false,
        mode: "skipped",
        documents: [],
        deletions: [],
        skipped: [],
        events_seen: 0,
        pages: 0,
        error: { ...authDead, message: `skipped: ${authDead.message}` },
        state: { ...emptyState(), ...(state[calendar.key] || {}) },
      });
      continue;
    }

    const r = await syncCalendar({
      calendar,
      state: state[calendar.key] || null,
      config: cfg,
      getAccessToken,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      now,
    });
    results.push(r);
    nextState[calendar.key] = r.state;
    if (r.error && r.error.needsReconsent) authDead = r.error;
  }

  const documents = results.flatMap((r) => r.documents);
  const deletions = results.flatMap((r) => r.deletions);
  return {
    ok: results.every((r) => r.ok),
    calendars: results,
    documents,
    deletions,
    state: nextState,
    summary: {
      calendars_ok: results.filter((r) => r.ok).length,
      calendars_failed: results.filter((r) => !r.ok).length,
      documents: documents.length,
      deletions: deletions.length,
      skipped: results.reduce((n, r) => n + r.skipped.length, 0),
      events_seen: results.reduce((n, r) => n + r.events_seen, 0),
      needs_reconsent: Boolean(authDead),
    },
  };
}

/* ----------------------------------------------------------------- ingest */

/**
 * POST envelopes at the brain, one at a time, reporting every outcome.
 *
 * Deliberately not fail-fast. One event carrying a pasted API key gets refused
 * by the worker's credential gate with a 422, and a batch that aborts there
 * would drop every later event for a reason that has nothing to do with them.
 */
export async function ingestEnvelopes({ baseUrl, adminKey, envelopes, fetchImpl = fetch }) {
  const out = { created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
  for (const envelope of envelopes) {
    let res;
    try {
      res = await fetchBrainWithAdminKey(fetchImpl, `${baseUrl.replace(/\/$/, "")}/api/admin/brain/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }, () => adminKey);
    } catch (e) {
      out.errors.push({ source_id: envelope.source_id, error: e.message });
      continue;
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* reported as an error below */
    }
    if (res.status === 422) {
      out.refused.push({ source_id: envelope.source_id, labels: body?.labels || [], detail: body?.detail || null });
      continue;
    }
    if (!res.ok) {
      out.errors.push({ source_id: envelope.source_id, status: res.status, error: body?.error || text.slice(0, 200) });
      continue;
    }
    if (body?.action === "created") out.created += 1;
    else if (body?.action === "updated") out.updated += 1;
    else out.unchanged += 1;
  }
  return out;
}
