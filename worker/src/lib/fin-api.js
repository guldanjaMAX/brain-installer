/**
 * fin-api — the read transport over the financial ledger.
 *
 * WHY THIS EXISTS
 *
 * `fin-d1.js` held thirteen tested query functions and no HTTP route reached
 * any of them. Four client-facing screens were blocked on that one gap.
 *
 * WHY THREE ROUTES AND NOT THIRTEEN
 *
 * A screen must be able to show one as-of stamp across everything visible on
 * it. Ten parallel calls can straddle an ingest and put two as-of dates on one
 * page, so a single read is what makes that invariant holdable at all.
 *
 * WHY THIS COMPOSES THE READERS RATHER THAN CALLING `ledgerSnapshot`
 *
 * Two reasons, and the second is the important one.
 *
 * Cost: `ledgerSnapshot` fires roughly 13 + N queries — 200 documents, 200
 * statements, every reconciliation with its unbounded claims join, and per
 * account balance lookups that run SERIALLY — on a screen that may render
 * three collections. A `sections` whitelist lets the first screen an owner
 * opens pay for what it shows.
 *
 * Honesty: `ledgerSnapshot` ORs `unavailable` across eleven reads, so one
 * broken table marks the whole snapshot unavailable while ten collections
 * still hold real data, and nothing says which broke. Composing here keeps
 * each reader's own flag.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 *
 * `safeAll` catches every failure and returns `{ results: [], unavailable:
 * true }`, so a failed query is byte-identical to an empty table apart from
 * that one flag. **No collection key may appear in a response whose read did
 * not succeed.** Not an empty array — absent. An empty array is an invitation
 * to render an empty state; a missing key forces the surface to branch. This
 * is what stops a screen saying "you have no obligations" when the truth is
 * "the query did not run".
 */

import { jsonResponse, privateNoStore, validateAdminKey } from "./core.js";
import { validateOwnerSession } from "./owner-auth.js";
import {
  DEFAULT_TENANT, ledgerInstalled, ledgerEntities, ledgerAccounts, ledgerDocuments,
  ledgerStatements, ledgerExceptions, ledgerDeadlines, ledgerOpenItems,
  ledgerReconciliations, ledgerObligations, ledgerCashPosition, ledgerUnsortedSpending,
} from "./fin-d1.js";

export const FIN_PATH_PREFIX = "/api/fin/";

/** Every collection a snapshot can carry, and how to read it.
 *
 *  `key` is what lands in the response. Row shapes are whatever `fin-d1.js`
 *  returns, unchanged: this module renames nothing, computes nothing, and
 *  labels nothing. */
const SECTIONS = {
  entities: { read: (env, o) => ledgerEntities(env, { tenantId: o.tenantId }), pick: (r) => r.entities },
  accounts: { read: (env, o) => ledgerAccounts(env, o), pick: (r) => r.accounts },
  documents: { read: (env, o) => ledgerDocuments(env, o), pick: (r) => r.documents },
  statements: { read: (env, o) => ledgerStatements(env, o), pick: (r) => r.statements },
  exceptions: { read: (env, o) => ledgerExceptions(env, o), pick: (r) => r.exceptions },
  deadlines: { read: (env, o) => ledgerDeadlines(env, o), pick: (r) => r.deadlines },
  open_items: { read: (env, o) => ledgerOpenItems(env, o), pick: (r) => r.open_items },
  reconciliations: { read: (env, o) => ledgerReconciliations(env, o), pick: (r) => r.reconciliations },
  obligations: { read: (env, o) => ledgerObligations(env, o), pick: (r) => r.obligations, extra: (r) => ({ obligation_exposure: r.exposure }) },
  cash: { read: (env, o) => ledgerCashPosition(env, o), pick: (r) => r, whole: true },
  unsorted_spending: { read: (env, o) => ledgerUnsortedSpending(env, o), pick: (r) => r.by_account },
};

const SECTION_NAMES = Object.keys(SECTIONS);

async function readJson(request) {
  try {
    const parsed = await request.json();
    // `null`, an array, or a bare string are all "not an options object". They
    // must reach the readers as `{}`, never as `null`: the readers default on
    // `undefined` only, so `null` is the one input that makes them throw.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A fixed sentence for anything unrecognised.
 *
 *  A D1 error text can carry a bound parameter, and here the bound parameters
 *  are entity slugs and account slugs. This never returns `error.message`. */
function safeFinError() {
  return "could not read this brain's financial records";
}

const envelope = (install, extra = {}) => ({
  ledger_installed: install.installed,
  missing_tables: install.missing,
  unavailable: install.unavailable,
  tenant_id: DEFAULT_TENANT,
  ...extra,
});

export async function handleFinApi(env, request, url, path) {
  try {
    const ownerAuthorised = async () => await validateOwnerSession(request, env);
    const operatorAuthorised = () => validateAdminKey(request, env);

    if (request.method !== "POST") {
      return privateNoStore(jsonResponse({ error: "method not allowed" }, 405));
    }
    // Owner session is the primary tier. The admin key can ingest, purge,
    // reindex and drain, so a client-facing page that asks for it trains
    // people to paste it anywhere. It is accepted here because these are
    // reads and an operator answering "the client says this is empty" should
    // not need the client to share their screen.
    if (!await ownerAuthorised() && !operatorAuthorised()) {
      return privateNoStore(jsonResponse({ error: "unauthorized" }, 401));
    }

    const body = await readJson(request);
    // "" and null both mean no filter, so a cleared form field behaves like an
    // absent one rather than scoping to an entity named "".
    const entitySlug = body.entity_slug ? String(body.entity_slug) : null;
    const install = await ledgerInstalled(env);

    if (install.unavailable) {
      return privateNoStore(jsonResponse({
        ...envelope(install), error: safeFinError(),
      }, 503));
    }
    if (!install.installed) {
      // Not an error. "This brain has no financial layer" is a true answer to
      // the question asked, and a 4xx would arrive at the app as a thrown
      // Error indistinguishable from a network fault — losing exactly the
      // absent-versus-empty distinction this route exists to draw.
      return privateNoStore(jsonResponse({
        ...envelope(install),
        remedy: `this brain has no financial ledger yet (missing: ${install.missing.join(", ")}). `
          + "Run `brain migrate <manifest>` to create it.",
      }, 200));
    }

    if (path === "/api/fin/status") {
      return privateNoStore(jsonResponse(envelope(install)));
    }
    if (path === "/api/fin/snapshot") {
      return await snapshot(env, install, body, entitySlug);
    }
    if (path === "/api/fin/documents") {
      return await documents(env, install, body, entitySlug);
    }
    return privateNoStore(jsonResponse({ error: "not found" }, 404));
  } catch (error) {
    // One exit for every failure, so no path out of this module can carry a
    // bound value — an account slug, an entity, a figure — into a response.
    return privateNoStore(jsonResponse({ error: safeFinError(error), unavailable: true }, 503));
  }
}

async function snapshot(env, install, body, entitySlug) {
  let wanted = SECTION_NAMES;
  if (Array.isArray(body.sections)) {
    const unknown = body.sections.filter((s) => !SECTIONS[String(s)]);
    if (unknown.length) {
      // A typo must not answer with an empty collection: a screen cannot tell
      // that from a quiet month.
      return privateNoStore(jsonResponse({
        error: `unknown section: ${unknown.map(String).join(", ")}`,
        valid_sections: SECTION_NAMES,
      }, 400));
    }
    wanted = body.sections.map(String);
  }

  const limits = body.limits && typeof body.limits === "object" ? body.limits : {};
  const out = envelope(install, { entity_scope: entitySlug });
  const returned = [];
  const unavailableSections = [];
  const truncated = {};

  const reads = await Promise.all(wanted.map(async (name) => {
    const spec = SECTIONS[name];
    const options = { tenantId: DEFAULT_TENANT, entitySlug };
    // Ask for one more than requested: hitting a limit is otherwise
    // indistinguishable from having exactly that many rows, and there is no
    // total or cursor anywhere in the query layer to appeal to.
    const limit = Number(limits[name]);
    if (Number.isFinite(limit) && limit > 0) options.limit = limit + 1;
    return { name, spec, limit, result: await spec.read(env, options) };
  }));

  for (const { name, spec, limit, result } of reads) {
    if (result.unavailable) { unavailableSections.push(name); continue; }
    let rows = spec.pick(result);
    if (Number.isFinite(limit) && limit > 0 && Array.isArray(rows)) {
      truncated[name] = rows.length > limit;
      if (rows.length > limit) rows = rows.slice(0, limit);
    }
    out[name] = rows;
    if (spec.extra) Object.assign(out, spec.extra(result));
    returned.push(name);
  }

  // Exposure is computed by the reader over the rows it returned, so past the
  // limit its totals describe one page. Say so rather than letting a headline
  // stand on a partial sum.
  if (out.obligation_exposure) {
    out.obligation_exposure = {
      ...out.obligation_exposure,
      covers_all_obligations: !truncated.obligations,
    };
  }

  out.sections_returned = returned;
  out.sections_unavailable = unavailableSections;
  out.truncated = truncated;
  out.unavailable = unavailableSections.length > 0;

  // Nothing true is known, so nothing is rendered.
  const status = returned.length === 0 && unavailableSections.length > 0 ? 503 : 200;
  return privateNoStore(jsonResponse(out, status));
}

async function documents(env, install, body, entitySlug) {
  const asked = Number(body.limit);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 1000) : 200;
  const result = await ledgerDocuments(env, {
    tenantId: DEFAULT_TENANT, entitySlug, limit: limit + 1,
  });
  if (result.unavailable) {
    return privateNoStore(jsonResponse({
      ...envelope(install, { entity_scope: entitySlug }),
      unavailable: true, error: safeFinError(),
    }, 503));
  }
  const rows = result.documents;
  // Restricted and unreadable documents are returned and flagged, never
  // filtered. If a surface must hide them it does so where that is visible.
  return privateNoStore(jsonResponse(envelope(install, {
    entity_scope: entitySlug,
    documents: rows.slice(0, limit),
    truncated: rows.length > limit,
  })));
}
