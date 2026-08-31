/**
 * Public, non-secret Cloudflare account guidance for a first Brain install.
 *
 * This module describes the human prerequisite only. The OAuth session and
 * the Cloudflare API remain the authority for which accounts are reachable.
 * Choosing "existing" here never grants access, and choosing "create" never
 * creates an account or approves billing.
 */

export const CLOUDFLARE_ACCOUNT_PATHS = Object.freeze(["create", "existing"]);

export const CLOUDFLARE_ACCOUNT_URLS = Object.freeze({
  create: "https://dash.cloudflare.com/sign-up",
  login: "https://dash.cloudflare.com/login",
  dashboard: "https://dash.cloudflare.com/",
  plans: "https://dash.cloudflare.com/?to=/:account/workers/plans",
});

export function normalizeCloudflareAccountPath(value, { required = false } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized && !required) return null;
  if (!CLOUDFLARE_ACCOUNT_PATHS.includes(normalized)) {
    throw new TypeError("Cloudflare account path must be create or existing");
  }
  return normalized;
}

export function cloudflareAccountPlan(value) {
  const path = normalizeCloudflareAccountPath(value, { required: true });
  const creating = path === "create";
  return Object.freeze({
    path,
    title: creating ? "Create my first Cloudflare account" : "Use a Cloudflare account I already have",
    start_url: creating ? CLOUDFLARE_ACCOUNT_URLS.create : CLOUDFLARE_ACCOUNT_URLS.login,
    human_steps: Object.freeze(creating
      ? [
          "Create the account in Cloudflare's own page.",
          "Verify the email address and complete any sign-in protection Cloudflare requests.",
          "Choose the supported Workers Paid plan after the installer identifies the exact account.",
        ]
      : [
          "Sign in to Cloudflare in its own page.",
          "If the login can reach several accounts, choose the exact account by name and ID before setup changes anything.",
          "Confirm that the selected account uses the supported Workers Paid plan.",
        ]),
    convergence: "Continue with the same Wrangler browser sign-in. The installer verifies the exact reachable account before creating any Brain resource.",
    multi_brain: "One Cloudflare account can hold many separate Brains. Each Brain receives its own Worker, D1 database, Vectorize index, secrets, hostname, and saved resource IDs.",
    boundaries: Object.freeze({
      account_creation: "human_in_cloudflare",
      login_2fa_and_billing: "human_in_cloudflare",
      exact_account_selection: "owner_confirmed_then_api_verified",
      credential_storage: "wrangler_os_keyring",
      provisioning: "not_started_by_this_plan",
    }),
  });
}

export async function chooseCloudflareAccountPath(prompt, supplied = null) {
  const direct = normalizeCloudflareAccountPath(supplied);
  if (direct) return direct;
  if (typeof prompt !== "function") {
    throw new TypeError("a prompt is required when the Cloudflare account path is not supplied");
  }
  const answer = await prompt(
    "Cloudflare account: create a new one, or use one you already have? (create/existing)",
    "create",
  );
  return normalizeCloudflareAccountPath(answer, { required: true });
}
