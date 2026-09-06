/**
 * Local half of the QuickBooks HTTPS callback handoff.
 *
 * The returned private CryptoKey is intentionally memory-only. A future CLI
 * integration owns its lifetime and must not serialize it, pass it through an
 * agent, or include it in a support receipt.
 */

import {
  decryptQuickBooksCallback,
  generateQuickBooksCallbackKeyPair,
  normalizeQuickBooksCallbackBinding,
  sha256Hex,
} from "../worker/src/lib/quickbooks-callback-crypto.js";

export async function createQuickBooksCallbackHandoff() {
  return generateQuickBooksCallbackKeyPair();
}

export async function openQuickBooksCallbackHandoff({
  privateKey,
  envelope,
  expectedBinding,
}) {
  const expected = normalizeQuickBooksCallbackBinding(expectedBinding);
  const opened = await decryptQuickBooksCallback({ privateKey, envelope });
  if (JSON.stringify(opened.binding) !== JSON.stringify(expected)) {
    const error = new Error("QuickBooks callback handoff did not match the local intent");
    error.code = "quickbooks_callback_binding_mismatch";
    throw error;
  }
  if (expected.expected_company_fingerprint !== null) {
    const openedCompanyFingerprint = await sha256Hex(
      `quickbooks-company-v1:${opened.realmId}`,
    );
    if (openedCompanyFingerprint !== expected.expected_company_fingerprint) {
      const error = new Error("QuickBooks callback company did not match the local source binding");
      error.code = "quickbooks_company_binding_mismatch";
      throw error;
    }
  }
  return opened;
}
