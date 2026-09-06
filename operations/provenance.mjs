/**
 * Shared evidence-authority vocabulary for `brain check`.
 *
 * The Worker owns the classifier because it has the stored metadata needed to
 * verify an owner-confirmed record. Search returns that decision on
 * `row.authority`; the CLI reuses it rather than maintaining a second tier
 * system that could drift from answer ranking.
 */

import {
  TIERS,
  OWNER_CONFIRMED_SOURCE,
  agreementVerdict,
  bestTier,
  tierOf,
} from "../worker/src/lib/evidence-authority.js";

export {
  TIERS,
  OWNER_CONFIRMED_SOURCE,
  agreementVerdict,
  bestTier,
  tierOf,
};

/**
 * True only when the Worker verified the complete stored owner-confirmation
 * tuple. The public row intentionally omits its raw internal metadata.
 */
export function isOwnerConfirmedDocument(row = {}) {
  const authority = row?.authority;
  return Boolean(
    authority &&
    authority.owner_confirmed === true &&
    authority.tier === "T1" &&
    authority.rank === TIERS.T1.rank
  );
}
