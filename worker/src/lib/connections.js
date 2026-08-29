// What can reach this brain right now, besides the owner's own devices.
//
// An owner asks this question about APPS ("is Claude still connected?"), not
// about tokens. A connector refreshes its token routinely, so a token list
// would show the same app several times and imply activity that is really just
// bookkeeping. Every row here is one app.
//
// Liveness is the delicate part. A token dies three ways, and only one of them
// writes to the row:
//
//   1. revoked_at set        — the owner disconnected it here
//   2. expires_at passed     — it aged out
//   3. session_generation is behind — "Sign out everywhere" bumped the counter
//
// The third leaves the row looking untouched. Listing it as connected would be
// exactly the wrong lie to tell on a page whose entire job is answering "who
// has access", so generation is part of the liveness test, not an afterthought.

import { sessionGeneration } from "./auth-store.js";

/** Apps holding a live grant, most recently active first. */
export async function listConnections(env) {
  const generation = await sessionGeneration(env);
  const { results = [] } = await env.DB.prepare(
    `SELECT t.client_id,
            c.client_name,
            GROUP_CONCAT(DISTINCT t.scope) AS scopes,
            MIN(t.created_at)              AS connected_at,
            MAX(t.last_used_at)            AS last_used_at
       FROM oauth_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.revoked_at IS NULL
        AND t.expires_at > ?
        AND t.session_generation = ?
      GROUP BY t.client_id
      ORDER BY MAX(COALESCE(t.last_used_at, t.created_at)) DESC`,
  ).bind(Date.now(), generation).all();

  return results.map((row) => {
    // GROUP_CONCAT can return "read,read write" when an app refreshed across a
    // scope change. The widest grant is the true answer to what it can do.
    const canWrite = /write/.test(row.scopes || "");
    return {
      client_id: row.client_id,
      // A client that never sent a name during registration is still a real
      // grant; say so rather than rendering a blank row.
      name: row.client_name || "an unnamed app",
      can_write: canWrite,
      connected_at: row.connected_at ?? null,
      last_used_at: row.last_used_at ?? null,
    };
  });
}

/** Disconnect one app. Idempotent, and safe to call on an already-dead grant.
 *
 *  Until this existed, `oauth_tokens.revoked_at` was read by
 *  validateConnectorToken but written by nothing, so the consent screen's
 *  promise that a grant can be revoked from Settings had no mechanism behind
 *  it. */
export async function revokeConnection(env, clientId) {
  const result = await env.DB.prepare(
    `UPDATE oauth_tokens SET revoked_at = ?
      WHERE client_id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), String(clientId)).run();
  // The app can ask for access again through the normal consent screen; this
  // revokes the grant it holds, it does not ban the app.
  return { revoked: true, tokens: result?.meta?.changes ?? 0 };
}
