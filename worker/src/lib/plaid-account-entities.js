/**
 * Owner-confirmed Plaid account-to-entity authority.
 *
 * A Plaid Item is an institution connection, not a business scope. One Item
 * can return accounts belonging to several legal entities. Provider account
 * ids stay internal; the owner sees and writes through a stable opaque ref plus
 * the provider's already-masked last four only.
 */

const TENANT_FALLBACK = "primary";
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_REF = /^acct_[0-9a-f]{32}$/;
const ENTITY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTION_TYPE = "plaid_account_entity_assignment";
const EVENT_TYPE = "bank_account_entity_assigned";
const DEFAULT_RECONCILE_MINUTES = 360;

export class PlaidAccountEntityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PlaidAccountEntityError";
    this.code = code;
    this.status = status;
  }
}

function tenantIdOf(env) {
  return String(env.BANK_FEED_TENANT || TENANT_FALLBACK);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function plaidPublicAccountRef(tenantId, itemRef, providerAccountId) {
  const hash = await sha256Hex(
    `financial-brain:plaid-account-ref:v1\0${tenantId}\0${itemRef}\0${providerAccountId}`,
  );
  return `acct_${hash.slice(0, 32)}`;
}

/**
 * Record only the internal identifier map needed to pause for owner scope.
 * Rediscovery refreshes last_seen_at but never changes an existing assignment.
 */
export async function discoverPlaidAccountAssignments(env, {
  tenantId = tenantIdOf(env), itemRef, accounts, at,
} = {}) {
  if (!itemRef || !Array.isArray(accounts) || accounts.length === 0) {
    throw new PlaidAccountEntityError(
      "plaid_account_inventory_unavailable",
      "Plaid returned no account inventory to assign.",
      503,
    );
  }
  if (accounts.length > 250) {
    throw new PlaidAccountEntityError(
      "plaid_account_inventory_too_large",
      "This connection returned more accounts than one safe assignment pass can review.",
      503,
    );
  }
  const stamp = at || new Date().toISOString();
  const discovered = await Promise.all(accounts.map(async (account) => {
    const providerAccountId = String(account?.providerAccountId || "");
    if (!providerAccountId) {
      throw new PlaidAccountEntityError(
        "plaid_account_inventory_unavailable",
        "Plaid returned an account without a stable identifier.",
        503,
      );
    }
    return {
      providerAccountId,
      accountRef: await plaidPublicAccountRef(tenantId, itemRef, providerAccountId),
    };
  }));
  await env.DB.prepare(
    `INSERT INTO plaid_account_entity_assignments
       (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,
        discovered_at,last_seen_at,assigned_at,updated_at)
     SELECT ?1,?2,json_extract(value,'$.providerAccountId'),json_extract(value,'$.accountRef'),
            NULL,?3,?3,NULL,?3
       FROM json_each(?4) WHERE 1
     ON CONFLICT(tenant_id,item_ref,provider_account_id) DO UPDATE SET
       account_ref=excluded.account_ref,last_seen_at=excluded.last_seen_at,
       updated_at=CASE WHEN plaid_account_entity_assignments.entity_slug IS NULL
                       THEN excluded.updated_at ELSE plaid_account_entity_assignments.updated_at END`,
  ).bind(tenantId, itemRef, stamp, JSON.stringify(discovered)).run();
  return discovered;
}

/** Recheck authority immediately before every promotion, including resume. */
export async function plaidAccountAssignmentReadiness(env, { tenantId = tenantIdOf(env), windowRef } = {}) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS account_count,
            COALESCE(SUM(CASE WHEN a.entity_slug IS NULL THEN 1 ELSE 0 END),0) AS missing_count,
            COALESCE(SUM(CASE WHEN a.entity_slug IS NOT NULL AND e.entity_slug IS NULL THEN 1 ELSE 0 END),0) AS invalid_count
       FROM plaid_sync_stage_accounts s
       LEFT JOIN plaid_account_entity_assignments a
         ON a.tenant_id=s.tenant_id AND a.item_ref=(
              SELECT w.item_ref FROM plaid_sync_windows w
               WHERE w.tenant_id=s.tenant_id AND w.window_ref=s.window_ref
            ) AND a.provider_account_id=s.provider_account_id
       LEFT JOIN fin_entities e
         ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
        AND e.superseded_by_id IS NULL AND e.status='active' AND e.relationship='owned'
      WHERE s.tenant_id=? AND s.window_ref=?`,
  ).bind(tenantId, windowRef).first();
  const accountCount = Number(row?.account_count || 0);
  const missingCount = Number(row?.missing_count || 0);
  const invalidCount = Number(row?.invalid_count || 0);
  if (accountCount === 0) {
    return {
      ready: false,
      state: "unavailable",
      code: "plaid_account_inventory_unavailable",
      account_count: 0,
      assignment_required: 0,
    };
  }
  return {
    ready: missingCount === 0 && invalidCount === 0,
    state: missingCount === 0 && invalidCount === 0 ? "assigned" : "assignment_required",
    code: missingCount === 0 && invalidCount === 0 ? null : "plaid_account_assignment_required",
    account_count: accountCount,
    assignment_required: missingCount + invalidCount,
    invalid_assignments: invalidCount,
  };
}

function maskedIdentifier(label, mask) {
  const safeLabel = String(label || "Bank account").trim().replace(/\s+/g, " ").slice(0, 80) || "Bank account";
  const lastFour = String(mask || "").replace(/\D/g, "").slice(-4);
  return lastFour ? `${safeLabel} ending ${lastFour}` : safeLabel;
}

function freshness(lastSyncedAt, at, intervalMinutes) {
  if (!lastSyncedAt) return { state: "never_synced", stale: true };
  const synced = Date.parse(lastSyncedAt);
  const observed = Date.parse(at);
  if (!Number.isFinite(synced) || !Number.isFinite(observed)) return { state: "unavailable", stale: true };
  const staleAfterMinutes = Math.min(Math.max(intervalMinutes * 2, 30), 2880);
  return {
    state: observed - synced > staleAfterMinutes * 60_000 ? "stale" : "current",
    stale: observed - synced > staleAfterMinutes * 60_000,
    last_synced_at: lastSyncedAt,
    stale_after_minutes: staleAfterMinutes,
  };
}

/** Owner-safe account inventory. No Item, provider-account, account-slug, or transaction ids leave D1. */
export async function plaidOwnerAccountStatus(env, { now = null } = {}) {
  const tenantId = tenantIdOf(env);
  const stamp = now || new Date().toISOString();
  const interval = Math.min(
    Math.max(Number(env.BANK_FEED_RECONCILE_MINUTES) || DEFAULT_RECONCILE_MINUTES, 15),
    1440,
  );
  let itemCount;
  let inventoriedItemCount;
  let rows;
  try {
    const inventory = await env.DB.prepare(
      `SELECT COUNT(*) AS item_count,
              COALESCE(SUM(CASE WHEN EXISTS (
                SELECT 1 FROM plaid_account_entity_assignments a
                 WHERE a.tenant_id=i.tenant_id AND a.item_ref=i.item_ref
              ) THEN 1 ELSE 0 END),0) AS inventoried_item_count
         FROM bank_feed_items i
        WHERE i.tenant_id=? AND i.removed_at IS NULL`,
    ).bind(tenantId).first();
    itemCount = Number(inventory?.item_count || 0);
    inventoriedItemCount = Number(inventory?.inventoried_item_count || 0);
    rows = (await env.DB.prepare(
      `SELECT a.account_ref,a.entity_slug,e.entity_slug AS live_entity_slug,
              e.display_label AS entity_label,e.legal_name AS entity_legal_name,
              i.institution_label,i.status AS item_status,i.status_detail,i.last_synced_at,
              b.state AS history_state,b.provider_history_state,b.pages_done,
              b.transactions_seen,b.unread_lines,
              COALESCE(f.label,s.name) AS account_label,COALESCE(f.mask,s.mask) AS account_mask,
              c.coverage_status,c.covered_from,c.covered_to,c.basis_note,c.computed_at
         FROM plaid_account_entity_assignments a
         JOIN bank_feed_items i
           ON i.tenant_id=a.tenant_id AND i.item_ref=a.item_ref AND i.removed_at IS NULL
         LEFT JOIN plaid_sync_windows w
           ON w.tenant_id=a.tenant_id AND w.item_ref=a.item_ref
         LEFT JOIN plaid_sync_stage_accounts s
           ON s.tenant_id=a.tenant_id AND s.window_ref=w.window_ref
          AND s.provider_account_id=a.provider_account_id
         LEFT JOIN fin_accounts f
           ON f.tenant_id=a.tenant_id AND f.external_ref=a.provider_account_id
          AND f.source_feed=('bank-feed:'||a.item_ref) AND f.superseded_by_id IS NULL
         LEFT JOIN fin_account_coverage c
           ON c.tenant_id=f.tenant_id AND c.account_slug=f.account_slug
          AND c.superseded_by_id IS NULL
         LEFT JOIN fin_entities e
           ON e.tenant_id=a.tenant_id AND e.entity_slug=a.entity_slug
          AND e.superseded_by_id IS NULL AND e.status='active' AND e.relationship='owned'
         LEFT JOIN bank_feed_backfill b
           ON b.tenant_id=a.tenant_id AND b.item_ref=a.item_ref
        WHERE a.tenant_id=? ORDER BY i.connected_at,a.account_ref`,
    ).bind(tenantId).all())?.results || [];
  } catch (error) {
    throw new PlaidAccountEntityError(
      "bank_account_status_unavailable",
      "Bank account status could not be read safely.",
      503,
    );
  }
  if (itemCount > 0 && inventoriedItemCount !== itemCount) {
    return {
      error: "unavailable",
      provider: "plaid",
      state: "unavailable",
      unavailable: true,
      code: "plaid_account_inventory_unavailable",
      sections_unavailable: ["accounts"],
    };
  }
  const accounts = rows.map((row) => {
    const assigned = Boolean(row.entity_slug && row.live_entity_slug);
    const sync = freshness(row.last_synced_at, stamp, interval);
    const historyPartial = row.provider_history_state !== "HISTORICAL_UPDATE_COMPLETE";
    const coverageState = !assigned
      ? "assignment_required"
      : row.coverage_status || (historyPartial ? "pending" : "missing");
    return {
      account_ref: row.account_ref,
      masked_identifier: maskedIdentifier(row.account_label, row.account_mask),
      institution_label: row.institution_label || null,
      assignment: {
        state: assigned ? "assigned" : "assignment_required",
        entity_scope: { entity_slug: assigned ? row.entity_slug : null },
        entity_label: assigned ? (row.entity_label || row.entity_legal_name || row.entity_slug) : null,
      },
      connection: {
        state: row.item_status,
        detail: row.status_detail || null,
      },
      freshness: sync,
      history: {
        state: row.history_state || "none",
        provider_state: row.provider_history_state || "TRANSACTIONS_UPDATE_STATUS_UNKNOWN",
        partial: historyPartial,
        pages_done: Number(row.pages_done || 0),
        transactions_seen: Number(row.transactions_seen || 0),
        unread_lines: Number(row.unread_lines || 0),
      },
      coverage: {
        state: coverageState,
        covered_from: row.covered_from || null,
        covered_to: row.covered_to || null,
        note: row.basis_note || null,
        computed_at: row.computed_at || null,
      },
    };
  });
  const summary = {
    total: accounts.length,
    assignment_required: accounts.filter((account) => account.assignment.state === "assignment_required").length,
    stale: accounts.filter((account) => account.freshness.stale).length,
    history_partial: accounts.filter((account) => account.history.partial).length,
    coverage_gaps: accounts.filter((account) => !["complete", "indirect", "not_applicable", "closed"].includes(account.coverage.state)).length,
  };
  const state = summary.assignment_required > 0
    ? "assignment_required"
    : summary.stale > 0
      ? "stale"
      : (summary.history_partial > 0 || summary.coverage_gaps > 0 ? "partial" : (accounts.length ? "current" : "empty"));
  return {
    provider: "plaid",
    state,
    unavailable: false,
    sections_unavailable: [],
    accounts,
    summary,
  };
}

function replayBody(row) {
  try { return JSON.parse(row.response_json); } catch { return null; }
}

export async function assignPlaidAccountEntity(env, body, { now = null } = {}) {
  const tenantId = tenantIdOf(env);
  const requestId = typeof body?.request_id === "string" && REQUEST_ID.test(body.request_id)
    ? body.request_id
    : null;
  const accountRef = typeof body?.account_ref === "string" && ACCOUNT_REF.test(body.account_ref)
    ? body.account_ref
    : null;
  const entitySlug = typeof body?.entity_slug === "string" && ENTITY_SLUG.test(body.entity_slug)
    ? body.entity_slug
    : null;
  if (!requestId) throw new PlaidAccountEntityError("request_id_required", "A stable request_id is required.", 400);
  if (!accountRef) throw new PlaidAccountEntityError("invalid_account_ref", "Choose one account from the current account list.", 400);
  if (!entitySlug) throw new PlaidAccountEntityError("invalid_entity_slug", "Choose one active owned entity.", 400);
  const requestHash = await sha256Hex(canonical({ account_ref: accountRef, entity_slug: entitySlug }));
  let replay;
  try {
    replay = await env.DB.prepare(
      `SELECT action_type,request_hash,response_json FROM owner_action_requests
        WHERE tenant_id=? AND request_id=?`,
    ).bind(tenantId, requestId).first();
  } catch {
    throw new PlaidAccountEntityError(
      "bank_account_assignment_unavailable",
      "The account assignment could not be read safely.",
      503,
    );
  }
  if (replay) {
    if (replay.action_type !== ACTION_TYPE || replay.request_hash !== requestHash) {
      throw new PlaidAccountEntityError("request_id_conflict", "That request_id belongs to a different action.", 409);
    }
    const stored = replayBody(replay);
    if (!stored) {
      throw new PlaidAccountEntityError(
        "bank_account_assignment_unavailable",
        "The saved account assignment receipt could not be read safely.",
        503,
      );
    }
    return { status: 200, body: { ...stored, replayed: true } };
  }

  let entity;
  let account;
  try {
    entity = await env.DB.prepare(
      `SELECT entity_slug,legal_name,display_label,relationship
         FROM fin_entities WHERE tenant_id=? AND entity_slug=?
          AND superseded_by_id IS NULL AND status='active'`,
    ).bind(tenantId, entitySlug).first();
    account = await env.DB.prepare(
      `SELECT a.item_ref,a.provider_account_id,a.entity_slug,
              f.entity_slug AS ledger_entity_slug,f.account_slug AS ledger_account_slug,
              (SELECT COUNT(*) FROM fin_transactions t
                WHERE t.tenant_id=f.tenant_id AND t.account_slug=f.account_slug) AS ledger_transaction_count,
              COALESCE(f.label,s.name) AS account_label,COALESCE(f.mask,s.mask) AS account_mask
         FROM plaid_account_entity_assignments a
         JOIN bank_feed_items i
           ON i.tenant_id=a.tenant_id AND i.item_ref=a.item_ref AND i.removed_at IS NULL
         LEFT JOIN plaid_sync_windows w
           ON w.tenant_id=a.tenant_id AND w.item_ref=a.item_ref
         LEFT JOIN plaid_sync_stage_accounts s
           ON s.tenant_id=a.tenant_id AND s.window_ref=w.window_ref
          AND s.provider_account_id=a.provider_account_id
         LEFT JOIN fin_accounts f
           ON f.tenant_id=a.tenant_id AND f.external_ref=a.provider_account_id
          AND f.source_feed=('bank-feed:'||a.item_ref) AND f.superseded_by_id IS NULL
        WHERE a.tenant_id=? AND a.account_ref=?`,
    ).bind(tenantId, accountRef).first();
  } catch {
    throw new PlaidAccountEntityError(
      "bank_account_assignment_unavailable",
      "The account assignment could not be verified safely.",
      503,
    );
  }
  if (!entity) throw new PlaidAccountEntityError("entity_not_found", "That active entity is not available.", 404);
  if (entity.relationship !== "owned") {
    throw new PlaidAccountEntityError("entity_not_owned", "Bank accounts can be assigned only to an owned entity.", 403);
  }
  if (!account) throw new PlaidAccountEntityError("bank_account_not_found", "That bank account is not available.", 404);
  if (account.entity_slug && account.ledger_entity_slug && account.entity_slug !== account.ledger_entity_slug) {
    throw new PlaidAccountEntityError(
      "bank_account_assignment_inconsistent",
      "The saved account scope does not match the ledger and needs supervised review.",
      503,
    );
  }
  if (account.ledger_entity_slug && account.ledger_entity_slug !== entitySlug &&
      Number(account.ledger_transaction_count || 0) > 0) {
    throw new PlaidAccountEntityError(
      "bank_account_reassignment_requires_review",
      "This account already has financial history. Moving that history needs a separate reviewed correction.",
      409,
    );
  }

  const stamp = now || new Date().toISOString();
  const changed = account.entity_slug !== entitySlug;
  const eventId = changed ? `evt_${EVENT_TYPE}_${requestId}` : null;
  const displayLabel = maskedIdentifier(account.account_label, account.account_mask);
  const response = {
    assigned: true,
    request_id: requestId,
    account_ref: accountRef,
    masked_identifier: displayLabel,
    entity_scope: { entity_slug: entitySlug },
    entity_label: entity.display_label || entity.legal_name || entitySlug,
    changed,
    activity_event_id: eventId,
    replayed: false,
  };
  const statements = [
    // Recheck both owner authority and historical reclassification inside the
    // same transaction as the receipt. A concurrent entity retirement or
    // first ledger promotion must fail the complete write, never leave a
    // receipt that claims a scope change which did not remain safe.
    env.DB.prepare(
      `SELECT CASE WHEN
          EXISTS (
            SELECT 1 FROM fin_entities e
             WHERE e.tenant_id=? AND e.entity_slug=? AND e.superseded_by_id IS NULL
               AND e.status='active' AND e.relationship='owned'
          )
          AND EXISTS (
            SELECT 1 FROM plaid_account_entity_assignments a
            JOIN bank_feed_items i
              ON i.tenant_id=a.tenant_id AND i.item_ref=a.item_ref AND i.removed_at IS NULL
             WHERE a.tenant_id=? AND a.account_ref=?
          )
          AND NOT EXISTS (
            SELECT 1 FROM plaid_account_entity_assignments a
            JOIN fin_accounts f
              ON f.tenant_id=a.tenant_id AND f.external_ref=a.provider_account_id
             AND f.source_feed=('bank-feed:'||a.item_ref) AND f.superseded_by_id IS NULL
            JOIN fin_transactions t
              ON t.tenant_id=f.tenant_id AND t.account_slug=f.account_slug
             WHERE a.tenant_id=? AND a.account_ref=? AND f.entity_slug<>?
          )
        THEN 1 ELSE json_extract('bank account assignment authority changed','$') END AS assignment_guard`,
    ).bind(tenantId, entitySlug, tenantId, accountRef, tenantId, accountRef, entitySlug),
  ];
  if (changed) {
    statements.push(
      env.DB.prepare(
        `UPDATE plaid_account_entity_assignments
            SET entity_slug=?,assigned_at=?,updated_at=?
          WHERE tenant_id=? AND item_ref=? AND provider_account_id=? AND account_ref=?`,
      ).bind(entitySlug, stamp, stamp, tenantId, account.item_ref, account.provider_account_id, accountRef),
      env.DB.prepare(
        `UPDATE fin_accounts SET entity_slug=?,recorded_at=?
          WHERE tenant_id=? AND external_ref=? AND source_feed=('bank-feed:'||?)
            AND superseded_by_id IS NULL`,
      ).bind(entitySlug, stamp, tenantId, account.provider_account_id, account.item_ref),
      env.DB.prepare(
        `INSERT INTO owner_activity_events
           (event_id,tenant_id,request_id,event_type,entity_slug,
            subject_kind,subject_id,display_label,occurred_at)
         VALUES (?,?,?,?,?,'bank_account',?,?,?)`,
      ).bind(eventId, tenantId, requestId, EVENT_TYPE, entitySlug, accountRef, displayLabel, stamp),
    );
  }
  statements.push(env.DB.prepare(
    `INSERT INTO owner_action_requests
       (tenant_id,request_id,action_type,request_hash,response_json,response_status,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(tenantId, requestId, ACTION_TYPE, requestHash, JSON.stringify(response), changed ? 201 : 200, stamp));
  try {
    await env.DB.batch(statements);
  } catch {
    // A first ledger row can race the preflight on an account that previously
    // had no history. Name that stable review requirement on the same attempt
    // instead of asking the owner to guess why a safe retry keeps failing.
    try {
      const after = await env.DB.prepare(
        `SELECT f.entity_slug,
                (SELECT COUNT(*) FROM fin_transactions t
                  WHERE t.tenant_id=f.tenant_id AND t.account_slug=f.account_slug) AS ledger_transaction_count
           FROM plaid_account_entity_assignments a
           JOIN fin_accounts f
             ON f.tenant_id=a.tenant_id AND f.external_ref=a.provider_account_id
            AND f.source_feed=('bank-feed:'||a.item_ref) AND f.superseded_by_id IS NULL
          WHERE a.tenant_id=? AND a.account_ref=?`,
      ).bind(tenantId, accountRef).first();
      if (after?.entity_slug && after.entity_slug !== entitySlug &&
          Number(after.ledger_transaction_count || 0) > 0) {
        throw new PlaidAccountEntityError(
          "bank_account_reassignment_requires_review",
          "This account already has financial history. Moving that history needs a separate reviewed correction.",
          409,
        );
      }
    } catch (afterError) {
      if (afterError instanceof PlaidAccountEntityError) throw afterError;
    }
    throw new PlaidAccountEntityError(
      "bank_account_assignment_unavailable",
      "The account assignment was not committed. Retry with the same request_id.",
      503,
    );
  }
  return { status: changed ? 201 : 200, body: response };
}
