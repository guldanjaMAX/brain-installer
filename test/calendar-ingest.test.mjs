// WP-04: the calendar connector, actually wired to a runnable command.
//
// connectors/google-calendar.mjs was fully built and covered by 223 tests
// of its own internal functions (test/google-calendar.test.mjs), but a
// repo-wide search turned up nothing anywhere that ever called syncAll() or
// ingestEnvelopes() outside that connector's own test file. `brain connect
// google --scopes calendar` could request the OAuth scope; nothing could
// then actually run a sync. The source matrix's "designed, not written" was
// ALSO wrong, just in the opposite direction from what it looked like.
//
// This file proves the new `brain ingest <manifest> --from calendar`
// command (cmdIngestCalendar in brain.mjs) actually drives the real,
// existing connector correctly: a real syncAll() run against a scripted
// fake Google API, real state persistence to disk, real incremental resume
// on a second call, and correct forwarding of upserts and cancellations.
// Only the outside world this session cannot reach live (Cloudflare account
// resolution, the admin key, and the brain's own /api/admin/brain/ingest
// endpoint) is faked; every calendar-side function is the genuine one.

import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_URL,
  createTokenProvider,
  syncAll,
} from "../connectors/google-calendar.mjs";
import { cmdIngestCalendar } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ------------------------------------------------------------ fake google */
// Same scripted-transport shape as test/google-calendar.test.mjs, kept
// self-contained here rather than shared, matching this repo's convention.

function mkRes({ status = 200, body = {} }) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
function fakeGoogle({ token = { status: 200, body: { access_token: "at-1", expires_in: 3600 } }, calendar = [] } = {}) {
  const calls = { token: [], calendar: [] };
  let ti = 0, ci = 0;
  const impl = async (url, init = {}) => {
    if (String(url).startsWith(TOKEN_URL)) {
      calls.token.push(Object.fromEntries(new URLSearchParams(init.body || "")));
      const script = Array.isArray(token) ? token[Math.min(ti, token.length - 1)] : token;
      ti++;
      return mkRes(script);
    }
    const u = new URL(url);
    calls.calendar.push({ path: u.pathname, params: u.searchParams });
    const next = calendar[ci];
    ci++;
    if (!next) throw new Error(`unscripted calendar request #${ci}: ${url}`);
    return mkRes(next);
  };
  impl.calls = calls;
  return impl;
}
const provider = (impl) => createTokenProvider({ clientId: "cid", clientSecret: "csec", refreshToken: "rt", fetchImpl: impl });

const EVENT_KICKOFF = {
  kind: "calendar#event", id: "evt_kickoff_001", status: "confirmed",
  summary: "Henderson project kickoff", updated: "2026-06-10T18:22:41.512Z",
  start: { dateTime: "2026-06-12T09:00:00-07:00", timeZone: "America/Phoenix" },
  end: { dateTime: "2026-06-12T10:30:00-07:00", timeZone: "America/Phoenix" },
  organizer: { email: "dana@acme.com", displayName: "Dana Reyes" },
  attendees: [
    { email: "dana@acme.com", displayName: "Dana Reyes", responseStatus: "accepted" },
    { email: "owner@acme.com", displayName: "Chris Vale", self: true, responseStatus: "accepted" },
  ],
  iCalUID: "evt_kickoff_001@google.com",
};
const EVENT_CANCELLED = { kind: "calendar#event", id: "evt_old_002", status: "cancelled" };

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-calendar-ingest-")));
const manifestPath = join(sandbox, "brain.manifest.json");

const fakeReceipts = [];
const fakeRemovals = [];
const commonOptions = () => ({
  resolveAccount: async () => ({ id: "fixture-account" }),
  resolveBaseUrl: async () => "https://fixture.invalid",
  resolveAdminKey: () => "fixture-admin-key",
  postSourceReceipt: async (base, adminKey, receipt) => { fakeReceipts.push({ base, adminKey, receipt }); },
  applyDriveRemovals: async ({ uids }) => { fakeRemovals.push(uids); return { applied: uids.length, pending: 0 }; },
});

try {
  /* ---- dry run: computes and previews, sends and saves NOTHING ---- */
  {
    const impl = fakeGoogle({ calendar: [{ status: 200, body: { nextSyncToken: "TOK_1", items: [EVENT_KICKOFF] } }] });
    let ingestCalls = 0;
    const result = await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, { "dry-run": true },
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: { syncAll, ingestEnvelopes: async () => { ingestCalls++; return {}; } },
      },
    );
    check("dry run computes the real event as something that would upsert",
      result.documents.length === 1 && result.documents[0].title.includes("Henderson project kickoff"),
      JSON.stringify(result.documents.map((d) => d.title)));
    check("dry run sends nothing", ingestCalls === 0);
    check("dry run posts no source receipt", fakeReceipts.length === 0);
    check("dry run writes no state file", !(await import("node:fs")).existsSync(join(sandbox, ".brain-ingest-calendar.json")));
  }

  fakeReceipts.length = 0;
  fakeRemovals.length = 0;

  /* ---- a real run: one upsert, one cancellation, state persisted ---- */
  let savedSyncToken = null;
  {
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_1", items: [EVENT_KICKOFF, EVENT_CANCELLED] } }],
    });
    const sentEnvelopes = [];
    const result = await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: {
          syncAll,
          ingestEnvelopes: async ({ envelopes }) => {
            sentEnvelopes.push(...envelopes);
            return { created: envelopes.length, updated: 0, unchanged: 0, refused: [], errors: [], total: envelopes.length };
          },
        },
      },
    );
    check("the real event was sent for upsert", sentEnvelopes.length === 1 && sentEnvelopes[0].source_id.includes("evt_kickoff_001"),
      JSON.stringify(sentEnvelopes.map((e) => e.source_id)));
    check("the cancelled event was forwarded to removal, not upsert",
      fakeRemovals.length === 1 && fakeRemovals[0][0] === "calendar_event:gcal:primary:evt_old_002",
      JSON.stringify(fakeRemovals));
    check("two source receipts were posted (indexing, then final)",
      fakeReceipts.length === 2 && fakeReceipts[0].receipt.status === "indexing" && fakeReceipts[1].receipt.status === "ready",
      JSON.stringify(fakeReceipts.map((r) => r.receipt.status)));
    check("the final receipt reports the real created/removed counts",
      fakeReceipts[1].receipt.docs_added === 1 && /1 removed/.test(fakeReceipts[1].receipt.detail),
      JSON.stringify(fakeReceipts[1].receipt));
    check("cmdIngestCalendar returns a real result object, not undefined",
      result && result.result && result.sent && typeof result.removed === "number");

    const statePath = join(sandbox, ".brain-ingest-calendar.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    check("the sync token was actually persisted to disk",
      saved?.primary?.sync_token === "TOK_1", JSON.stringify(saved));
    savedSyncToken = saved?.primary?.sync_token;
  }

  fakeReceipts.length = 0;
  fakeRemovals.length = 0;

  /* ---- resume: the SECOND call must load the saved state and go incremental ---- */
  {
    check("precondition: the first run's token was saved", savedSyncToken === "TOK_1", savedSyncToken);
    const impl = fakeGoogle({
      calendar: [{ status: 200, body: { nextSyncToken: "TOK_2", items: [] } }],
    });
    await cmdIngestCalendar(
      { infrastructure: { cloudflare: {} } }, manifestPath, {},
      {
        ...commonOptions(),
        getAccessToken: provider(impl).get,
        fetchImpl: impl,
        googleCalendar: { syncAll, ingestEnvelopes: async () => ({ created: 0, updated: 0, unchanged: 0, refused: [], errors: [], total: 0 }) },
      },
    );
    check("the resumed run sent the saved syncToken back to Google (incremental, not a full resync)",
      impl.calls.calendar[0]?.params.get("syncToken") === "TOK_1",
      JSON.stringify(impl.calls.calendar[0]?.params?.toString()));

    const statePath = join(sandbox, ".brain-ingest-calendar.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    check("the new token replaces the old one", saved?.primary?.sync_token === "TOK_2", JSON.stringify(saved));
  }

  fakeReceipts.length = 0;

  /* ---- a dead refresh token is reported clearly, not as a crash ---- */
  {
    const impl = fakeGoogle({ token: { status: 400, body: { error: "invalid_grant" } } });
    let threw = null;
    let result;
    try {
      result = await cmdIngestCalendar(
        { infrastructure: { cloudflare: {} } }, manifestPath, { "dry-run": true },
        {
          ...commonOptions(),
          getAccessToken: provider(impl).get,
          fetchImpl: impl,
          googleCalendar: { syncAll, ingestEnvelopes: async () => ({}) },
        },
      );
    } catch (error) { threw = error; }
    check("a dead refresh token does not crash the command", threw === null, threw?.message);
    check("it is reported through the connector's own needs_reconsent signal",
      result?.summary?.needs_reconsent === true, JSON.stringify(result?.summary));
  }

  console.log(fail ? `\n${fail} FAILURES` : `\ncalendar-ingest: all ${ran} tests passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
