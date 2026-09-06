/** Named public-endpoint profiles for providers that implement the bank-feed contract. */

export const PLAID_PROFILE = Object.freeze({
  provider: "plaid",
  apiBases: Object.freeze({
    sandbox: "https://sandbox.plaid.com",
    production: "https://production.plaid.com",
  }),
  linkSdkUrl: "https://cdn.plaid.com/link/v2/stable/link-initialize.js",
  linkGlobal: "Plaid",
});

/**
 * An explicit base always wins, preserving private aggregators and fixtures.
 * Selecting Plaid fills only public endpoints and SDK metadata. It never
 * supplies, infers, prints, or persists a credential.
 */
export function bankFeedProfile(env, environment) {
  if (env.BANK_FEED_API_BASE) {
    return {
      provider: env.BANK_FEED_PROVIDER || "custom",
      apiBase: env.BANK_FEED_API_BASE,
      linkSdkUrl: env.BANK_FEED_LINK_SDK_URL || null,
      linkGlobal: env.BANK_FEED_LINK_GLOBAL || null,
    };
  }
  if (String(env.BANK_FEED_PROVIDER || "").toLowerCase() === "plaid") {
    return {
      provider: PLAID_PROFILE.provider,
      apiBase: PLAID_PROFILE.apiBases[environment],
      linkSdkUrl: PLAID_PROFILE.linkSdkUrl,
      linkGlobal: PLAID_PROFILE.linkGlobal,
    };
  }
  return { provider: null, apiBase: null, linkSdkUrl: null, linkGlobal: null };
}
