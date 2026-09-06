/**
 * Google Calendar connector tests.
 *
 * Every response here is a hand-written fixture shaped like a real Google
 * response. NOTHING in this file touches the network: `fetchImpl` is injected
 * everywhere, and an unscripted request is a hard failure rather than a
 * fallthrough, so a test that accidentally reaches for the live API fails loud.
 *
 * Covered end to end: a first (full) sync across two pages, an incremental
 * sync carrying one change, a deletion, a 410 with its automatic resync, and a
 * recurring event both as a series master and as a modified instance.
 */

import {
  CALENDAR_SCOPE,
  TOKEN_URL,
  SOURCE_TYPE,
  SYNC_TOKEN_FORBIDDEN,
  DEFAULT_EVENT_TYPES,
  createTokenProvider,
  normalizeConfig,
  paramFingerprint,
  buildListParams,
  stripBoilerplate,
  htmlToText,
  readEventTime,
  describeWhen,
  describeRecurrence,
  partitionAttendees,
  renderEvent,
  buildEnvelope,
  sourceIdFor,
  syncCalendar,
  syncAll,
  ingestEnvelopes,
  GoogleAuthError,
} from "../connectors/google-calendar.mjs";

let fail = 0;
let ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  >> " + d));
  if (!c) fail++;
};
const section = (s) => console.log(`\n--- ${s} ---`);

/* ------------------------------------------------------------ fake google */

function mkRes({ status = 200, body = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/**
 * Scripted transport. Calendar responses are consumed in order; the token
 * endpoint is answered from its own script so auth failures can be tested
 * independently of the API.
 */
function fakeGoogle({ token = { status: 200, body: { access_token: "at-1", expires_in: 3600 } }, calendar = [] } = {}) {
  const calls = { token: [], calendar: [] };
  let ti = 0;
  let ci = 0;
  const impl = async (url, init = {}) => {
    if (String(url).startsWith(TOKEN_URL)) {
      calls.token.push(Object.fromEntries(new URLSearchParams(init.body || "")));
      const script = Array.isArray(token) ? token[Math.min(ti, token.length - 1)] : token;
      ti++;
      return mkRes(script);
    }
    const u = new URL(url);
    calls.calendar.push({
      path: u.pathname,
      params: u.searchParams,
      auth: (init.headers || {}).authorization || null,
    });
    const next = calendar[ci];
    ci++;
    if (!next) throw new Error(`unscripted calendar request #${ci}: ${url}`);
    return mkRes(next);
  };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {};
const CAL = { id: "primary", key: "primary", label: "Work calendar" };
const provider = (impl) => createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt", fetchImpl: impl });

/* ------------------------------------------------------------- fixtures */

// A Zoom invite tail: ~identical across every Zoom meeting in a corpus, which
// is exactly why it must never reach the embedder.
const ZOOM_TAIL = `

Join Zoom Meeting
https://us02web.zoom.us/j/81234567890?pwd=Zm9vYmFy

Meeting ID: 812 3456 7890
Passcode: 447291

---

One tap mobile
+16699006833,,81234567890# US (San Jose)
+12532158782,,81234567890# US (Tacoma)

Dial by your location
+1 669 900 6833 US (San Jose)
+1 253 215 8782 US (Tacoma)
+1 346 248 7799 US (Houston)
Find your local number: https://us02web.zoom.us/u/kbXyZ`;

const EVENT_KICKOFF = {
  kind: "calendar#event",
  id: "evt_kickoff_001",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0X2tpY2tvZmY",
  created: "2026-06-02T14:11:00.000Z",
  updated: "2026-06-10T18:22:41.512Z",
  summary: "Henderson project kickoff",
  description:
    "Walk through the Henderson scope, the budget cap and the September deadline.<br><br>Priya is bringing the site survey." +
    ZOOM_TAIL,
  location: "Acme HQ, 400 N Central Ave, Phoenix AZ",
  organizer: { email: "dana@acme.com", displayName: "Dana Reyes" },
  creator: { email: "dana@acme.com", displayName: "Dana Reyes" },
  start: { dateTime: "2026-06-12T09:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-06-12T10:30:00-07:00", timeZone: "America/Phoenix" },
  iCalUID: "evt_kickoff_001@google.com",
  eventType: "default",
  attendees: [
    { email: "dana@acme.com", displayName: "Dana Reyes", organizer: true, responseStatus: "accepted" },
    { email: "owner@acme.com", displayName: "Chris Vale", self: true, responseStatus: "accepted" },
    { email: "priya@henderson.co", displayName: "Priya Raman", responseStatus: "accepted" },
    { email: "sam@acme.com", displayName: "Sam Ortiz", responseStatus: "declined" },
    { email: "acme.com_room_b@resource.calendar.google.com", displayName: "Conference Room B", resource: true, responseStatus: "accepted" },
  ],
  conferenceData: {
    conferenceSolution: { name: "Zoom Meeting" },
    entryPoints: [
      { entryPointType: "video", uri: "https://us02web.zoom.us/j/81234567890" },
      { entryPointType: "phone", uri: "tel:+16699006833" },
    ],
  },
};

// All-day. Google's end.date is EXCLUSIVE, so this is a ONE day event.
const EVENT_ALLDAY = {
  kind: "calendar#event",
  id: "evt_offsite_002",
  status: "confirmed",
  updated: "2026-06-01T09:00:00.000Z",
  summary: "Henderson site visit",
  start: { date: "2026-06-19" },
  end: { date: "2026-06-20" },
  organizer: { email: "owner@acme.com", displayName: "Chris Vale" },
  attendees: [{ email: "priya@henderson.co", displayName: "Priya Raman", responseStatus: "accepted" }],
  iCalUID: "evt_offsite_002@google.com",
};

// Recurring SERIES MASTER. With singleEvents=false this is one document that
// stands in for every unmodified occurrence.
const EVENT_RECURRING_MASTER = {
  kind: "calendar#event",
  id: "evt_weekly_003",
  status: "confirmed",
  updated: "2026-04-06T12:00:00.000Z",
  summary: "Henderson weekly sync",
  description: "Standing check-in on the Henderson build.",
  start: { dateTime: "2026-04-07T14:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-04-07T14:30:00-07:00", timeZone: "America/Phoenix" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260825T000000Z"],
  organizer: { email: "dana@acme.com", displayName: "Dana Reyes" },
  attendees: [
    { email: "dana@acme.com", displayName: "Dana Reyes", responseStatus: "accepted" },
    { email: "owner@acme.com", displayName: "Chris Vale", responseStatus: "accepted" },
    { email: "priya@henderson.co", displayName: "Priya Raman", responseStatus: "accepted" },
  ],
  iCalUID: "evt_weekly_003@google.com",
};

// A MODIFIED occurrence of that series. Returned as its own resource even with
// singleEvents=false, which is the whole reason singleEvents=false is safe.
const EVENT_RECURRING_EXCEPTION = {
  kind: "calendar#event",
  id: "evt_weekly_003_20260616T210000Z",
  status: "confirmed",
  updated: "2026-06-15T17:04:00.000Z",
  summary: "Henderson weekly sync (moved: budget review)",
  description: "Moved an hour later. Bringing the revised Henderson budget.",
  start: { dateTime: "2026-06-16T15:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-06-16T16:00:00-07:00", timeZone: "America/Phoenix" },
  recurringEventId: "evt_weekly_003",
  originalStartTime: { dateTime: "2026-06-16T14:00:00-07:00", timeZone: "America/Phoenix" },
  organizer: { email: "dana@acme.com", displayName: "Dana Reyes" },
  attendees: [
    { email: "dana@acme.com", displayName: "Dana Reyes", responseStatus: "accepted" },
    { email: "owner@acme.com", displayName: "Chris Vale", responseStatus: "accepted" },
  ],
  iCalUID: "evt_weekly_003@google.com",
};

// Nothing to retrieve: no title, no attendees, no description.
const EVENT_EMPTY = {
  kind: "calendar#event",
  id: "evt_blank_004",
  status: "confirmed",
  updated: "2026-06-03T00:00:00.000Z",
  start: { dateTime: "2026-06-13T12:00:00-07:00" },
  end: { dateTime: "2026-06-13T12:30:00-07:00" },
};

// A deletion, as it arrives on an incremental sync.
const EVENT_CANCELLED = {
  kind: "calendar#event",
  id: "evt_offsite_002",
  status: "cancelled",
  updated: "2026-06-14T08:30:00.000Z",
};

const PAGE_FULL_1 = {
  status: 200,
  body: {
    kind: "calendar#events",
    summary: "owner@acme.com",
    updated: "2026-06-15T00:00:00.000Z",
    timeZone: "America/Phoenix",
    accessRole: "owner",
    nextPageToken: "PAGE2",
    items: [EVENT_KICKOFF, EVENT_ALLDAY],
  },
};
const PAGE_FULL_2 = {
  status: 200,
  body: {
    kind: "calendar#events",
    nextSyncToken: "SYNC_TOKEN_A",
    items: [EVENT_RECURRING_MASTER, EVENT_EMPTY],
  },
};

/* ============================================================ scope facts */

section("verified constants");
check("minimum scope is calendar.events.readonly", CALENDAR_SCOPE === "https://www.googleapis.com/auth/calendar.events.readonly", CALENDAR_SCOPE);
check(
  "the syncToken forbidden list matches Google's documented set",
  JSON.stringify([...SYNC_TOKEN_FORBIDDEN].sort()) ===
    JSON.stringify(["iCalUID", "orderBy", "privateExtendedProperty", "q", "sharedExtendedProperty", "timeMax", "timeMin", "updatedMin"]),
  JSON.stringify(SYNC_TOKEN_FORBIDDEN)
);
check("workingLocation is excluded by default", !DEFAULT_EVENT_TYPES.includes("workingLocation"), DEFAULT_EVENT_TYPES.join(","));
check("birthday is excluded by default", !DEFAULT_EVENT_TYPES.includes("birthday"));
check("outOfOffice is kept by default", DEFAULT_EVENT_TYPES.includes("outOfOffice"));

/* ========================================================== list params */

section("request parameters");
{
  const cfg = normalizeConfig({ fullSyncSince: "2025-01-01T00:00:00Z" });

  const full = buildListParams({ config: cfg });
  check("full sync sends timeMin when a window is configured", full.get("timeMin") === "2025-01-01T00:00:00Z");
  check("full sync pins showDeleted=true", full.get("showDeleted") === "true");
  check("full sync defaults singleEvents=false", full.get("singleEvents") === "false");
  check("full sync sends the eventTypes allowlist", full.getAll("eventTypes").join(",") === "default,focusTime,fromGmail,outOfOffice", full.getAll("eventTypes").join(","));

  const inc = buildListParams({ syncToken: "SYNC_TOKEN_A", config: cfg });
  const leaked = SYNC_TOKEN_FORBIDDEN.filter((p) => inc.has(p));
  check("incremental sends NO forbidden parameter", leaked.length === 0, leaked.join(","));
  check("incremental drops timeMin even though it is configured", !inc.has("timeMin"));
  check("incremental still pins showDeleted=true (false is illegal with syncToken)", inc.get("showDeleted") === "true");
  check("incremental carries the sync token", inc.get("syncToken") === "SYNC_TOKEN_A");

  const paged = buildListParams({ syncToken: "SYNC_TOKEN_A", pageToken: "PAGE2", config: cfg });
  check("pageToken rides alongside syncToken", paged.get("pageToken") === "PAGE2" && paged.get("syncToken") === "SYNC_TOKEN_A");
}

section("parameter fingerprint");
{
  const a = paramFingerprint(normalizeConfig({}), CAL);
  check("fingerprint is stable across identical config", a === paramFingerprint(normalizeConfig({}), CAL));
  check("singleEvents change moves the fingerprint", a !== paramFingerprint(normalizeConfig({ singleEvents: true }), CAL));
  check("eventTypes change moves the fingerprint", a !== paramFingerprint(normalizeConfig({ eventTypes: ["default"] }), CAL));
  check("fullSyncSince change moves the fingerprint", a !== paramFingerprint(normalizeConfig({ fullSyncSince: "2020-01-01T00:00:00Z" }), CAL));
  check("a different calendar has a different fingerprint", a !== paramFingerprint(normalizeConfig({}), { id: "team@acme.com", key: "team" }));
  check("maxResults does NOT move the fingerprint (paging, not filtering)", a === paramFingerprint(normalizeConfig({ maxResults: 500 }), CAL));
}

section("calendar identity");
{
  const cfg = normalizeConfig({ calendars: [{ id: "owner@acme.com", key: "primary" }] });
  check("key can be pinned while the address changes", cfg.calendars[0].key === "primary" && cfg.calendars[0].id === "owner@acme.com");
  check(
    "source_id follows the key, so re-addressing does not duplicate the corpus",
    sourceIdFor(cfg.calendars[0].key, "evt_kickoff_001") === sourceIdFor("primary", "evt_kickoff_001")
  );
  let threw = false;
  try {
    normalizeConfig({ calendars: [{ id: "a@x.com", key: "k" }, { id: "b@x.com", key: "K" }] });
  } catch {
    threw = true;
  }
  check("duplicate calendar keys are refused", threw);
}

/* ============================================================ auth */

section("token refresh");
{
  const impl = fakeGoogle({ token: { status: 200, body: { access_token: "at-fresh", expires_in: 3600 } } });
  const p = createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt-1", fetchImpl: impl });
  const t1 = await p.get();
  const t2 = await p.get();
  check("refresh returns the access token", t1 === "at-fresh", t1);
  check("second call is served from cache", t2 === "at-fresh" && impl.calls.token.length === 1, `token calls=${impl.calls.token.length}`);
  const body = impl.calls.token[0];
  check("grant_type is refresh_token", body.grant_type === "refresh_token", body.grant_type);
  check("client_id, client_secret and refresh_token are sent", body.client_id === "cid" && body.client_secret === "csec" && body.refresh_token === "rt-1");
}
{
  // client_secret is optional for a native/PKCE client and must not be sent empty.
  const impl = fakeGoogle({ token: { status: 200, body: { access_token: "at", expires_in: 3600 } } });
  const p = createTokenProvider({ clientId: "cid", refreshToken: "rt", fetchImpl: impl });
  await p.get();
  check("client_secret is omitted when not configured", !("client_secret" in impl.calls.token[0]), JSON.stringify(impl.calls.token[0]));
}
{
  // Expiry with the 60s skew: a token 30s from death must be refreshed early.
  let clock = 1_000_000;
  const impl = fakeGoogle({
    token: [
      { status: 200, body: { access_token: "at-1", expires_in: 3600 } },
      { status: 200, body: { access_token: "at-2", expires_in: 3600 } },
    ],
  });
  const p = createTokenProvider({ clientId: "c", refreshToken: "r", fetchImpl: impl, now: () => clock });
  check("first mint", (await p.get()) === "at-1");
  clock += 3_000_000; // 600s of nominal life left: comfortably outside the skew
  check("still cached well before expiry", (await p.get()) === "at-1", "should not have re-minted yet");
  clock += 550_000; // now 50s of nominal life left, inside the 60s skew window
  check("re-mints inside the 60s skew window", (await p.get()) === "at-2", "expected a second mint");
}
{
  const impl = fakeGoogle({ token: { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
  const p = createTokenProvider({ clientId: "c", refreshToken: "r", fetchImpl: impl });
  let err = null;
  try {
    await p.get();
  } catch (e) {
    err = e;
  }
  check("invalid_grant raises GoogleAuthError", err instanceof GoogleAuthError, String(err));
  check("invalid_grant is flagged as needing re-consent", err && err.needsReconsent === true);
  check("the error names the 7-day Testing-status cause", err && /TESTING publishing status/.test(err.message));
  check("the error names the six month non-use cause", err && /six months/.test(err.message));
  check("the error states the fix", err && /re-runs the consent flow/.test(err.message));
}
{
  const impl = fakeGoogle({ token: { status: 500, body: { error: "internal_failure" } } });
  const p = createTokenProvider({ clientId: "c", refreshToken: "r", fetchImpl: impl });
  let err = null;
  try {
    await p.get();
  } catch (e) {
    err = e;
  }
  check("a 500 from the token endpoint is NOT flagged as needing re-consent", err && err.needsReconsent === false, String(err && err.needsReconsent));
}

/* ============================================================ text tidying */

section("description cleaning");
{
  const cleaned = stripBoilerplate(EVENT_KICKOFF.description);
  check("human prose survives", /Walk through the Henderson scope/.test(cleaned), cleaned);
  check("second sentence survives", /Priya is bringing the site survey/.test(cleaned));
  check("the Zoom join block is gone", !/Join Zoom Meeting/.test(cleaned), cleaned);
  check("dial-in numbers are gone", !/669 900 6833/.test(cleaned));
  check("the passcode is gone", !/447291/.test(cleaned));
  check("<br> became a line break, not a literal tag", !/<br>/.test(cleaned) && /\n/.test(cleaned));
  check("the tail is actually short now", cleaned.length < 200, `len=${cleaned.length} of ${EVENT_KICKOFF.description.length}`);

  check("a Google Meet separator block is stripped", stripBoilerplate("Agenda: pricing\n-::~:~::~:~::~\nJoin with Google Meet\nmeet.google.com/abc") === "Agenda: pricing");
  check("a Teams separator block is stripped", stripBoilerplate("Notes here\n______________________\nMicrosoft Teams meeting\nJoin on your computer") === "Notes here");
  check("an all-boilerplate description collapses to empty", stripBoilerplate("Join Zoom Meeting\nhttps://z.us/j/1") === "");
  check("an empty description stays empty", stripBoilerplate(null) === "");
  check("entities are decoded", htmlToText("Q3 &amp; Q4 &lt;plan&gt;") === "Q3 & Q4 <plan>");
  check("description is capped", stripBoilerplate("x".repeat(5000), { maxChars: 300 }).length <= 304);
}

/* ============================================================ dates */

section("date handling");
{
  const t = readEventTime({ dateTime: "2026-06-12T18:00:00-07:00", timeZone: "America/Phoenix" });
  check("local date is read literally, never shifted to UTC", t.date === "2026-06-12", t.date);
  check("local time is read literally", t.time === "18:00", t.time);
  check("offset is preserved", t.offset === "-07:00");
  check("timed events are not marked all-day", t.allDay === false);

  const a = readEventTime({ date: "2026-06-19" });
  check("date-only slots are marked all-day", a.allDay === true && a.time === null);

  const when = describeWhen(EVENT_KICKOFF);
  check("When carries the spoken month", /12 June 2026/.test(when), when);
  check("When carries the ISO date too", /2026-06-12/.test(when));
  check("When carries the weekday", /Friday/.test(when), when);
  check("When carries start and end times", /9:00 AM to 10:30 AM/.test(when), when);
  check("When names the timezone", /America\/Phoenix/.test(when));

  const allDay = describeWhen(EVENT_ALLDAY);
  check("a one-day all-day event does NOT report the exclusive end date", !/20 June/.test(allDay), allDay);
  check("a one-day all-day event says all day", /19 June 2026/.test(allDay) && /all day/.test(allDay), allDay);

  const multi = describeWhen({ start: { date: "2026-06-19" }, end: { date: "2026-06-22" } });
  check("a multi-day all-day event ends on the last INCLUSIVE day", /through Sunday, 21 June 2026/.test(multi), multi);

  // 18:00 in Phoenix is the 13th in UTC. D1 stores occurred_at as an epoch and
  // retrieval emits UTC, so the envelope must carry the local calendar day.
  const lateEnvelope = buildEnvelope(
    { id: "x", status: "confirmed", summary: "Evening call", start: { dateTime: "2026-06-12T18:00:00-07:00" }, end: { dateTime: "2026-06-12T19:00:00-07:00" } },
    { calendar: CAL }
  );
  check("occurred_at is the local calendar day", lateEnvelope.envelope.occurred_at === "2026-06-12", lateEnvelope.envelope.occurred_at);
  check("storage's epoch-to-UTC round trip keeps that local day", new Date(Date.parse(lateEnvelope.envelope.occurred_at)).toISOString().slice(0, 10) === "2026-06-12");
  check("the exact event time and offset remain in metadata", lateEnvelope.envelope.metadata.start === "2026-06-12T18:00:00-07:00", lateEnvelope.envelope.metadata.start);
}

section("recurrence in words");
{
  const w = describeRecurrence(EVENT_RECURRING_MASTER.recurrence, "2026-04-07");
  check("weekly BYDAY renders in English", /repeats weekly on Tuesday/.test(w), w);
  check("the series start is stated", /from Tuesday, 7 April 2026/.test(w), w);
  check("UNTIL is stated", /until Tuesday, 25 August 2026/.test(w), w);
  check("interval > 1 renders", /repeats every 2 weeks on Monday and Wednesday/.test(describeRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"])), describeRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"]));
  check("COUNT renders", /repeats daily, 10 times/.test(describeRecurrence(["RRULE:FREQ=DAILY;COUNT=10"])));
  check("an open-ended series says so", /no end date/.test(describeRecurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"])));
  check("no recurrence returns null", describeRecurrence(null) === null && describeRecurrence([]) === null);
  check("EXDATE-only recurrence returns null", describeRecurrence(["EXDATE;TZID=America/Phoenix:20260616T140000"]) === null);
}

/* ============================================================ attendees */

section("attendees");
{
  const p = partitionAttendees(EVENT_KICKOFF.attendees);
  check("a conference room is not a person", !p.people.some((x) => /Conference Room B/.test(x)), p.people.join(" | "));
  check("the room is captured separately", p.rooms.length === 1 && /Conference Room B/.test(p.rooms[0]));
  check("the room's opaque resource address is dropped", p.rooms[0] === "Conference Room B", p.rooms[0]);
  check("a declined attendee is not listed as an attendee", !p.people.some((x) => /Sam Ortiz/.test(x)));
  check("a declined attendee is listed as declined", p.declined.length === 1 && /Sam Ortiz/.test(p.declined[0]));
  check("attendees carry names AND emails", p.people.some((x) => x === "Priya Raman <priya@henderson.co>"), p.people.join(" | "));
  check("three real people remain", p.people.length === 3, String(p.people.length));

  const many = partitionAttendees(Array.from({ length: 60 }, (_, i) => ({ email: `p${i}@x.com` })), { maxListed: 40 });
  check("a huge invite list is capped", many.people.length === 40 && many.truncated === 20, `${many.people.length}/${many.truncated}`);
}

/* ------------------------------------------------------------------------
 * The conference password.
 *
 * A real Zoom entry point carries ?pwd=<secret>. Emitting it verbatim trips
 * the worker's own credential scanner, so the ingest 422s and EVERY Zoom
 * meeting silently vanishes from the install while the sync reports success.
 * These tests are pinned against the real scanner, not against a copy of its
 * rules, so a change to either side breaks here rather than in production.
 * ---------------------------------------------------------------------- */
section("conference links carry a password; it must not be indexed");
{
  const { scan } = await import("../worker/src/lib/secret-scan.js");
  const zoomEvent = {
    id: "z1",
    status: "confirmed",
    summary: "Henderson kickoff",
    start: { dateTime: "2026-06-12T09:00:00-07:00" },
    end: { dateTime: "2026-06-12T10:00:00-07:00" },
    attendees: [{ email: "priya@henderson.co", displayName: "Priya Raman" }],
    htmlLink: "https://www.google.com/calendar/event?eid=MjBfa2lja29mZl9ldnRfaWRfaGVyZQ",
    conferenceData: {
      conferenceSolution: { name: "Zoom Meeting" },
      entryPoints: [{ entryPointType: "video", uri: `https://us02web.zoom.us/j/81234567890?pwd=${"dGhpc0lzQVJlYWxab29tUHdk".repeat(2)}` }],
    },
  };
  const doc = renderEvent(zoomEvent, { calendar: CAL });
  check("the join path survives", /us02web\.zoom\.us\/j\/81234567890/.test(doc), doc);
  check("the password does NOT survive", !/pwd=/.test(doc), doc);
  const verdict = scan(doc);
  check("the rendered document passes the worker's real credential gate", verdict.shouldRefuse === false, JSON.stringify(verdict.labels));

  const meetDoc = renderEvent({ ...zoomEvent, conferenceData: undefined, hangoutLink: "https://meet.google.com/abc-defg-hij" }, { calendar: CAL });
  check("a Google Meet link is untouched (no query to strip)", /meet\.google\.com\/abc-defg-hij/.test(meetDoc));
  check("a Meet document also passes the gate", scan(meetDoc).shouldRefuse === false);

  // The gate must still catch a genuinely leaked key pasted into a description.
  const leaky = renderEvent(
    { ...zoomEvent, conferenceData: undefined, description: `Key for the demo: sk-ant-api03-${"x".repeat(80)}AA` },
    { calendar: CAL }
  );
  check("a real key pasted into a description is still refused", scan(leaky).shouldRefuse === true, JSON.stringify(scan(leaky).labels));
}

/* ============================================================ renderer */

section("document renderer");
{
  const text = renderEvent(EVENT_KICKOFF, { calendar: CAL, config: { ownerEmail: "owner@acme.com" } });

  check("the title leads", text.startsWith("Meeting: Henderson project kickoff"), text.split("\n")[0]);
  check("the organizer is named", /Organizer: Dana Reyes <dana@acme.com>/.test(text));
  check("attendee emails are present for domain matching", /priya@henderson.co/.test(text));
  check("the client domain appears verbatim", /henderson\.co/.test(text));
  check("the location is present", /400 N Central Ave/.test(text));
  check("the conference solution is named in prose", /Video call: Zoom Meeting/.test(text));
  check("the conference URL is present", /us02web\.zoom\.us\/j\/81234567890/.test(text));
  check("the description survives", /Walk through the Henderson scope/.test(text));
  check("the dial-in block did not survive", !/Dial by your location/.test(text));

  // The opaque tokens must be demoted, not scattered through the prose.
  const lines = text.split("\n").filter(Boolean);
  const linkLineIdx = lines.findIndex((l) => /Video link:/.test(l));
  check("provenance is the last line", linkLineIdx === lines.length - 1, `idx=${linkLineIdx} of ${lines.length}`);
  check("the htmlLink is in the provenance band, not the prose", /Event link: https:\/\/www\.google\.com\/calendar/.test(lines[lines.length - 1]));
  check("the calendar label is in the provenance band", /Calendar: Work calendar/.test(lines[lines.length - 1]));
  check("iCalUID is not embedded (never searched, always noise)", !/evt_kickoff_001@google\.com/.test(text));

  // The retrieval question the connector exists to answer.
  const q = "who did I meet about the Henderson project in June";
  const terms = ["Henderson", "June", "2026-06-12", "Priya Raman", "Dana Reyes"];
  check(`all terms for "${q}" are present`, terms.every((t) => text.includes(t)), terms.filter((t) => !text.includes(t)).join(","));

  const declinedText = renderEvent(
    { ...EVENT_KICKOFF, attendees: EVENT_KICKOFF.attendees.map((a) => (a.email === "owner@acme.com" ? { ...a, responseStatus: "declined" } : a)) },
    { calendar: CAL, config: { ownerEmail: "owner@acme.com" } }
  );
  check("an owner decline is stated outright", /The calendar owner declined this invitation\./.test(declinedText));

  const rec = renderEvent(EVENT_RECURRING_MASTER, { calendar: CAL });
  check("a series master states its span in English", /repeats weekly on Tuesday, from Tuesday, 7 April 2026 until Tuesday, 25 August 2026/.test(rec), rec);
  check("the raw RRULE never reaches the embedded text", !/RRULE/.test(rec));

  const exc = renderEvent(EVENT_RECURRING_EXCEPTION, { calendar: CAL });
  check("a modified occurrence says it belongs to a series", /Part of a recurring series/.test(exc));
  check("a modified occurrence states its original slot", /originally scheduled for Tuesday, 16 June 2026/.test(exc), exc);

  const bare = renderEvent({ id: "z", summary: "Dentist", start: { dateTime: "2026-06-12T09:00:00-07:00" }, end: { dateTime: "2026-06-12T10:00:00-07:00" } }, { calendar: CAL });
  check("an event with nothing but a title still renders", /Meeting: Dentist/.test(bare) && /none listed/.test(bare), bare);
  check("renderer tolerates a nearly empty event", typeof renderEvent({ id: "q" }, { calendar: CAL }) === "string");
}

/* ============================================================ envelopes */

section("ingest envelopes");
{
  const out = buildEnvelope(EVENT_KICKOFF, { calendar: CAL });
  const e = out.envelope;
  check("kind is upsert", out.kind === "upsert");
  check("source_type is calendar_event", e.source_type === SOURCE_TYPE, e.source_type);
  check("source_id is gcal:<key>:<event id>", e.source_id === "gcal:primary:evt_kickoff_001", e.source_id);
  check("occurred_at is the event's local calendar day", e.occurred_at === "2026-06-12", e.occurred_at);
  check("a timed start names its date provenance", e.date_source === "calendar:event_start", e.date_source);
  check("a Google event start is marked reliable", e.date_reliable === true, String(e.date_reliable));
  check("the canonical event link is the top-level citation URI", e.uri === EVENT_KICKOFF.htmlLink, e.uri);
  check("title carries the date for readable citations", e.title === "Henderson project kickoff — 2026-06-12", e.title);
  check("metadata.category routes it to a calendar corpus", e.metadata.category === "calendar");
  check("metadata.attendees is the string the worker expects", typeof e.metadata.attendees === "string" && /Priya Raman/.test(e.metadata.attendees));
  check("a declined invitee is marked declined in metadata.attendees", /Sam Ortiz <sam@acme.com> \(declined\)/.test(e.metadata.attendees), e.metadata.attendees);
  check("the resource address never reaches the embedded text", !/resource\.calendar\.google\.com/.test(e.content), e.content);
  check("attendee domains are extracted for client matching", e.metadata.attendee_domains.includes("henderson.co"), e.metadata.attendee_domains.join(","));
  check("the room is excluded from attendee_emails", !e.metadata.attendee_emails.some((x) => /resource\.calendar/.test(x)));
  check("iCalUID travels in metadata for cross-calendar dedupe", e.metadata.ical_uid === "evt_kickoff_001@google.com");
  check("conference_url is structured, not only prose", e.metadata.conference_url === "https://us02web.zoom.us/j/81234567890");
  check("recurrence master flag is false for a one-off", e.metadata.is_recurring_master === false);

  const recEnv = buildEnvelope(EVENT_RECURRING_MASTER, { calendar: CAL }).envelope;
  check("a series master is flagged", recEnv.metadata.is_recurring_master === true);
  check("the raw RRULE is preserved in metadata", recEnv.metadata.recurrence[0].startsWith("RRULE:FREQ=WEEKLY"));

  const allDayEnv = buildEnvelope(EVENT_ALLDAY, { calendar: CAL }).envelope;
  check("an all-day start names its date-only provenance", allDayEnv.date_source === "calendar:all_day_start", allDayEnv.date_source);
  check("an event without an htmlLink has no invented citation URI", allDayEnv.uri === null, String(allDayEnv.uri));

  const excEnv = buildEnvelope(EVENT_RECURRING_EXCEPTION, { calendar: CAL }).envelope;
  check("an exception gets its OWN source_id", excEnv.source_id === "gcal:primary:evt_weekly_003_20260616T210000Z", excEnv.source_id);
  check("an exception points back at its series", excEnv.metadata.recurring_event_id === "evt_weekly_003");
  check("an exception dates itself to the moved slot", excEnv.occurred_at.slice(0, 10) === "2026-06-16");

  const del = buildEnvelope(EVENT_CANCELLED, { calendar: CAL });
  check("a cancelled event becomes a deletion", del.kind === "delete", del.kind);
  check("the deletion targets the same source_id the upsert used", del.source_id === allDayEnv.source_id, del.source_id);
  check("a cancelled event does NOT become a tombstone document", !("envelope" in del));

  const skip = buildEnvelope(EVENT_EMPTY, { calendar: CAL });
  check("an event with nothing to retrieve is skipped", skip.kind === "skip", skip.kind);
  check("the skip states why", /nothing to retrieve/.test(skip.reason));

  // Idempotency: the whole point of a stable source_id.
  const a = buildEnvelope(EVENT_KICKOFF, { calendar: CAL }).envelope;
  const b = buildEnvelope(EVENT_KICKOFF, { calendar: CAL }).envelope;
  check("re-rendering the same event is byte-identical", JSON.stringify(a) === JSON.stringify(b));
  check("the same event on another calendar gets its own id", buildEnvelope(EVENT_KICKOFF, { calendar: { id: "team@acme.com", key: "team" } }).envelope.source_id === "gcal:team:evt_kickoff_001");
}

/* ============================================================ FIRST SYNC */

section("scenario: first sync (full, two pages)");
{
  const impl = fakeGoogle({ calendar: [PAGE_FULL_1, PAGE_FULL_2] });
  const r = await syncCalendar({ calendar: CAL, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("run succeeded", r.ok === true, JSON.stringify(r.error));
  check("mode is full", r.mode === "full", r.mode);
  check("both pages were fetched", r.pages === 2, String(r.pages));
  check("page 1 sent no syncToken", !impl.calls.calendar[0].params.has("syncToken"));
  check("page 2 sent the pageToken", impl.calls.calendar[1].params.get("pageToken") === "PAGE2");
  check("every request carried a bearer token", impl.calls.calendar.every((c) => c.auth === "Bearer at-1"));
  check("the calendar id was URL-encoded into the path", impl.calls.calendar[0].path === "/calendar/v3/calendars/primary/events", impl.calls.calendar[0].path);
  check("4 events seen", r.events_seen === 4, String(r.events_seen));
  check("3 documents produced", r.documents.length === 3, String(r.documents.length));
  check("1 event skipped as empty", r.skipped.length === 1, JSON.stringify(r.skipped));
  check("no deletions on a clean first sync", r.deletions.length === 0);
  check("the sync token was stored", r.state.sync_token === "SYNC_TOKEN_A", r.state.sync_token);
  check("the fingerprint was stored beside it", r.state.param_fingerprint === paramFingerprint(normalizeConfig({}), CAL));
  check("last_synced_at was recorded", typeof r.state.last_synced_at === "string" && r.state.last_synced_at.endsWith("Z"));
  check("full_syncs counter advanced", r.state.full_syncs === 1);
  check("the Henderson kickoff is among the documents", r.documents.some((d) => d.source_id === "gcal:primary:evt_kickoff_001"));
}

/* ====================================================== INCREMENTAL SYNC */

section("scenario: incremental sync with one change");
{
  const CHANGED = {
    ...EVENT_KICKOFF,
    updated: "2026-06-16T11:02:00.000Z",
    summary: "Henderson project kickoff (rescheduled)",
    description: "Moved to the afternoon. Priya can no longer make the morning." + ZOOM_TAIL,
    start: { dateTime: "2026-06-12T14:00:00-07:00", timeZone: "America/Phoenix" },
    end: { dateTime: "2026-06-12T15:30:00-07:00", timeZone: "America/Phoenix" },
  };
  const impl = fakeGoogle({ calendar: [{ status: 200, body: { nextSyncToken: "SYNC_TOKEN_B", items: [CHANGED] } }] });
  const prior = { sync_token: "SYNC_TOKEN_A", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL), full_syncs: 1 };
  const r = await syncCalendar({ calendar: CAL, state: prior, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("run succeeded", r.ok === true, JSON.stringify(r.error));
  check("mode is incremental", r.mode === "incremental", r.mode);
  check("only ONE request was made", impl.calls.calendar.length === 1, String(impl.calls.calendar.length));
  check("the stored token was sent", impl.calls.calendar[0].params.get("syncToken") === "SYNC_TOKEN_A");
  check("no forbidden parameter was sent", SYNC_TOKEN_FORBIDDEN.every((p) => !impl.calls.calendar[0].params.has(p)));
  check("only the changed event came back", r.events_seen === 1 && r.documents.length === 1);
  check("the change is reflected in the document", /rescheduled/.test(r.documents[0].content), r.documents[0].content.split("\n")[0]);
  check("the rescheduled event keeps its local calendar day for retrieval", r.documents[0].occurred_at === "2026-06-12");
  check("the new exact start time is reflected in metadata", r.documents[0].metadata.start === "2026-06-12T14:00:00-07:00");
  check("the source_id is UNCHANGED, so this upserts rather than duplicates", r.documents[0].source_id === "gcal:primary:evt_kickoff_001");
  check("the token advanced", r.state.sync_token === "SYNC_TOKEN_B", r.state.sync_token);
  check("full_syncs did NOT advance on an incremental run", r.state.full_syncs === 1, String(r.state.full_syncs));
}

/* ============================================================= DELETION */

section("scenario: deletion");
{
  const impl = fakeGoogle({ calendar: [{ status: 200, body: { nextSyncToken: "SYNC_TOKEN_C", items: [EVENT_CANCELLED] } }] });
  const prior = { sync_token: "SYNC_TOKEN_B", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL) };
  const r = await syncCalendar({ calendar: CAL, state: prior, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("run succeeded", r.ok === true);
  check("no document was produced for a cancelled event", r.documents.length === 0);
  check("one deletion was produced", r.deletions.length === 1, JSON.stringify(r.deletions));
  check("the deletion names the exact source_id previously ingested", r.deletions[0].source_id === "gcal:primary:evt_offsite_002", r.deletions[0].source_id);
  check("the deletion states its reason", /cancelled or deleted/.test(r.deletions[0].reason));
  check("the token still advanced", r.state.sync_token === "SYNC_TOKEN_C");
}

/* ================================================================== 410 */

section("scenario: 410 GONE, automatic full resync");
{
  const GONE = {
    status: 410,
    body: { error: { code: 410, message: "Sync token is no longer valid, a full sync is required.", errors: [{ domain: "calendar", reason: "fullSyncRequired", message: "Sync token is no longer valid" }] } },
  };
  const impl = fakeGoogle({ calendar: [GONE, PAGE_FULL_1, PAGE_FULL_2] });
  const prior = { sync_token: "DEAD_TOKEN", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL), full_syncs: 1 };
  const r = await syncCalendar({ calendar: CAL, state: prior, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("the run recovered rather than failing", r.ok === true, JSON.stringify(r.error));
  check("mode flipped to full", r.mode === "full", r.mode);
  check("the reset reason names the 410", /rejected by Google \(fullSyncRequired\)/.test(r.reset_reason || ""), r.reset_reason);
  check("the dead token was sent exactly once", impl.calls.calendar.filter((c) => c.params.get("syncToken") === "DEAD_TOKEN").length === 1);
  check("the resync sent NO syncToken", !impl.calls.calendar[1].params.has("syncToken"));
  check("410 was NOT retried as if it were a rate limit", impl.calls.calendar.length === 3, String(impl.calls.calendar.length));
  check("the full corpus came back", r.documents.length === 3, String(r.documents.length));
  check("a fresh token replaced the dead one", r.state.sync_token === "SYNC_TOKEN_A", r.state.sync_token);
  check("the full_syncs counter recorded the resync", r.state.full_syncs === 2, String(r.state.full_syncs));
}
{
  // A 410 on the RESYNC too. It must give up, not spin.
  const GONE = { status: 410, body: { error: { errors: [{ reason: "fullSyncRequired" }] } } };
  const impl = fakeGoogle({ calendar: [GONE, GONE] });
  const r = await syncCalendar({
    calendar: CAL,
    state: { sync_token: "DEAD", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL) },
    config: {},
    getAccessToken: provider(impl).get,
    fetchImpl: impl,
    sleep: noSleep,
  });
  check("a repeat 410 fails instead of looping", r.ok === false && impl.calls.calendar.length === 2, `calls=${impl.calls.calendar.length}`);
  check("the failure is reported, not thrown", r.error && /sync token expired/.test(r.error.message), JSON.stringify(r.error));
}

/* ================================================== fingerprint-triggered resync */

section("scenario: config change invalidates the stored token");
{
  const impl = fakeGoogle({ calendar: [PAGE_FULL_1, PAGE_FULL_2] });
  const stale = { sync_token: "SYNC_TOKEN_A", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL) };
  const r = await syncCalendar({ calendar: CAL, state: stale, config: { singleEvents: true }, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("the stale token was discarded", !impl.calls.calendar[0].params.has("syncToken"));
  check("mode is full", r.mode === "full");
  check("the reset reason names the parameter change", /sync parameters changed/.test(r.reset_reason || ""), r.reset_reason);
  check("the new request reflects the new config", impl.calls.calendar[0].params.get("singleEvents") === "true");
  check("the new fingerprint was stored", r.state.param_fingerprint === paramFingerprint(normalizeConfig({ singleEvents: true }), CAL));
}

/* ============================================== token discipline on failure */

section("state discipline: a token is only advanced when it is earned");
{
  // Page 1 succeeds, page 2 dies. maxRetries 0 so it fails on the first try.
  const impl = fakeGoogle({ calendar: [PAGE_FULL_1, { status: 500, body: { error: { message: "backend error" } } }] });
  const prior = { sync_token: "SYNC_TOKEN_A", param_fingerprint: paramFingerprint(normalizeConfig({ maxRetries: 0 }), CAL), full_syncs: 1 };
  const r = await syncCalendar({ calendar: CAL, state: prior, config: { maxRetries: 0 }, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });

  check("the run is reported failed", r.ok === false);
  check("the failure carries the HTTP status", r.error && r.error.status === 500, JSON.stringify(r.error));
  check("the OLD token is preserved, not advanced", r.state.sync_token === "SYNC_TOKEN_A", r.state.sync_token);
  check("the failure was recorded on the state", /calendar API 500/.test(r.state.last_error || ""), r.state.last_error);
  check("consecutive_failures incremented", r.state.consecutive_failures === 1, String(r.state.consecutive_failures));
  check("a failed run produces no documents to ingest", r.documents.length === 0);
}
{
  // A last page with no nextSyncToken. The token must not be invented.
  const impl = fakeGoogle({ calendar: [{ status: 200, body: { items: [EVENT_ALLDAY] } }] });
  const prior = { sync_token: "SYNC_TOKEN_A", param_fingerprint: paramFingerprint(normalizeConfig({}), CAL) };
  const r = await syncCalendar({ calendar: CAL, state: prior, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  check("a missing nextSyncToken leaves the stored token alone", r.state.sync_token === "SYNC_TOKEN_A", r.state.sync_token);
  check("the anomaly is surfaced as a warning", /no nextSyncToken/.test(r.warning || ""), r.warning);
  check("the events fetched are still returned", r.documents.length === 1);
}

/* ============================================================ retry / 401 */

section("transport: retries and auth recovery");
{
  const impl = fakeGoogle({
    token: [
      { status: 200, body: { access_token: "at-old", expires_in: 3600 } },
      { status: 200, body: { access_token: "at-new", expires_in: 3600 } },
    ],
    calendar: [
      { status: 401, body: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } },
      { status: 200, body: { nextSyncToken: "T", items: [EVENT_ALLDAY] } },
    ],
  });
  const r = await syncCalendar({ calendar: CAL, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  check("a 401 triggers one forced refresh and a retry", r.ok === true && impl.calls.token.length === 2, `tokens=${impl.calls.token.length}`);
  check("the retry used the NEW access token", impl.calls.calendar[1].auth === "Bearer at-new", impl.calls.calendar[1].auth);
}
{
  const impl = fakeGoogle({
    calendar: [
      { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }], message: "Rate Limit Exceeded" } } },
      { status: 429, body: { error: { message: "Too Many Requests" } } },
      { status: 200, body: { nextSyncToken: "T", items: [] } },
    ],
  });
  const r = await syncCalendar({ calendar: CAL, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  check("403 rateLimitExceeded and 429 are both retried", r.ok === true && impl.calls.calendar.length === 3, `calls=${impl.calls.calendar.length}`);
}
{
  // A scope failure must NOT be retried: retrying buries the one useful message.
  const impl = fakeGoogle({
    calendar: [{ status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }], message: "Request had insufficient authentication scopes." } } }],
  });
  const r = await syncCalendar({ calendar: CAL, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  check("a scope 403 fails on the first attempt", r.ok === false && impl.calls.calendar.length === 1, `calls=${impl.calls.calendar.length}`);
  check("the scope error message survives to the caller", /insufficient authentication scopes/.test(r.error.message), r.error.message);
}
{
  const impl = fakeGoogle({ calendar: [{ status: 404, body: { error: { errors: [{ reason: "notFound" }], message: "Not Found" } } }] });
  const r = await syncCalendar({ calendar: { id: "gone@acme.com", key: "gone" }, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  check("a missing calendar fails that calendar only", r.ok === false && r.error.status === 404);
}

/* ============================================================ syncAll */

section("multi-calendar isolation");
{
  const impl = fakeGoogle({
    calendar: [
      { status: 200, body: { nextSyncToken: "T_A", items: [EVENT_KICKOFF] } },
      { status: 404, body: { error: { errors: [{ reason: "notFound" }], message: "Not Found" } } },
      { status: 200, body: { nextSyncToken: "T_C", items: [EVENT_RECURRING_MASTER] } },
    ],
  });
  const out = await syncAll({
    config: { calendars: ["primary", "broken@acme.com", "team@acme.com"], maxRetries: 0 },
    state: {},
    getAccessToken: provider(impl).get,
    fetchImpl: impl,
    sleep: noSleep,
  });

  check("the aggregate is marked not-ok", out.ok === false);
  check("the two healthy calendars still produced documents", out.documents.length === 2, String(out.documents.length));
  check("the failure is attributed to the right calendar", out.calendars[1].calendar_key === "broken@acme.com" && out.calendars[1].ok === false);
  check("the third calendar ran AFTER the second failed", out.calendars[2].ok === true, JSON.stringify(out.calendars[2].error));
  check("state was written for the healthy calendars", out.state["primary"].sync_token === "T_A" && out.state["team@acme.com"].sync_token === "T_C");
  check("no token was written for the broken calendar", out.state["broken@acme.com"].sync_token === null, JSON.stringify(out.state["broken@acme.com"]));
  check("the summary counts both outcomes", out.summary.calendars_ok === 2 && out.summary.calendars_failed === 1, JSON.stringify(out.summary));
}
{
  // A dead refresh token fails everything. Re-hammering the token endpoint per
  // calendar is itself a way to get a refresh token revoked, so it stops.
  const impl = fakeGoogle({
    token: { status: 400, body: { error: "invalid_grant" } },
    calendar: [],
  });
  const out = await syncAll({
    config: { calendars: ["primary", "team@acme.com", "ops@acme.com"] },
    state: {},
    getAccessToken: provider(impl).get,
    fetchImpl: impl,
    sleep: noSleep,
  });
  check("every calendar is reported failed", out.summary.calendars_failed === 3, JSON.stringify(out.summary));
  check("the aggregate flags that re-consent is needed", out.summary.needs_reconsent === true);
  check("the token endpoint was hit ONCE, not once per calendar", impl.calls.token.length === 1, `tokens=${impl.calls.token.length}`);
  check("the skipped calendars say why", /skipped:/.test(out.calendars[2].error.message), out.calendars[2].error.message);
}

/* ============================================== full re-run is a no-op */

section("idempotency: re-running the same sync changes nothing");
{
  const run = async () => {
    const impl = fakeGoogle({ calendar: [PAGE_FULL_1, PAGE_FULL_2] });
    return syncCalendar({ calendar: CAL, state: null, config: {}, getAccessToken: provider(impl).get, fetchImpl: impl, sleep: noSleep });
  };
  const r1 = await run();
  const r2 = await run();
  check("both runs produce identical envelopes", JSON.stringify(r1.documents) === JSON.stringify(r2.documents));
  const ids = r1.documents.map((d) => d.source_id);
  check("source_ids are unique within a run", new Set(ids).size === ids.length, ids.join(","));
  check("source_ids are identical across runs", JSON.stringify(ids) === JSON.stringify(r2.documents.map((d) => d.source_id)));
}

/* ============================================================ ingest post */

section("posting envelopes at the brain");
{
  const seen = [];
  const impl = async (url, init) => {
    seen.push({
      url,
      body: JSON.parse(init.body),
      key: new Headers(init.headers).get("x-admin-key"),
      redirect: init.redirect,
    });
    const n = seen.length;
    if (n === 2) return mkRes({ status: 422, body: { error: "refused", labels: ["anthropic_key"], detail: "Rotate them." } });
    return mkRes({ status: 200, body: { brain_doc_id: n, action: n === 3 ? "unchanged" : "created", embedded: true } });
  };
  const envs = [EVENT_KICKOFF, EVENT_RECURRING_MASTER, EVENT_ALLDAY].map((e) => buildEnvelope(e, { calendar: CAL }).envelope);
  const out = await ingestEnvelopes({ baseUrl: "https://brain.acme.com/", adminKey: "k", envelopes: envs, fetchImpl: impl });

  check("it posts to the ingest route", seen[0].url === "https://brain.acme.com/api/admin/brain/ingest", seen[0].url);
  check("it sends the admin key", seen[0].key === "k");
  check("it refuses redirects before posting the admin key", seen[0].redirect === "error");
  check("a 422 refusal does NOT abort the batch", seen.length === 3, String(seen.length));
  check("the refusal is reported with its labels", out.refused.length === 1 && out.refused[0].labels[0] === "anthropic_key");
  check("created and unchanged are counted separately", out.created === 1 && out.unchanged === 1, JSON.stringify(out));
}

/* ------------------------------------------------------------------ done */




/* ============================ 410 that earns NO replacement token ========= */

section("scenario: 410 GONE where the resync earns no new token");
{
  // The existing 410 scenario covers the happy path: the resync earns
  // SYNC_TOKEN_A and it replaces the dead one. This is the case that loops.
  // Google can legitimately answer a full sync without a nextSyncToken, and the
  // old code then fell back to prev.sync_token, re-arming the token Google had
  // just declared dead. Next run: another 410, another full sync, forever.
  const GONE2 = {
    status: 410,
    body: { error: { code: 410, errors: [{ domain: "calendar", reason: "fullSyncRequired" }] } },
  };
  const NO_TOKEN_PAGE = { status: 200, body: { items: [] } };
  const impl = fakeGoogle({ calendar: [GONE2, NO_TOKEN_PAGE] });
  const prior = {
    sync_token: "DEAD_TOKEN",
    param_fingerprint: paramFingerprint(normalizeConfig({}), CAL),
  };
  const r = await syncCalendar({
    calendar: CAL,
    state: prior,
    config: {},
    getAccessToken: provider(impl).get,
    fetchImpl: impl,
    sleep: noSleep,
  });

  check("the run still succeeded", r.ok === true, JSON.stringify(r.error));
  check("mode flipped to full", r.mode === "full", r.mode);
  check("the dead token is NOT re-armed", r.state.sync_token !== "DEAD_TOKEN", String(r.state.sync_token));
  check("the token is cleared to null", r.state.sync_token === null, String(r.state.sync_token));
  check("the warning explains the clearing", /cleared/i.test(r.warning || ""), r.warning || "(none)");
}

console.log(fail ? `\n${fail} FAILURES` : `\ngoogle-calendar: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
