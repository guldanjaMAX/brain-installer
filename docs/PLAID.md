# Plaid bank feed

Plaid is the reviewed named profile for the hosted read-only bank feed. It
requests only the Transactions product. It never requests Auth, Transfer,
Payment Initiation, account numbers, or routing numbers.

The account holder completes Plaid Link themselves. Financial Brain never asks
for or receives the bank username, password, one-time code, security answer, or
MFA response.

## Configuration

The manifest names public, non-secret policy only:

```json
{
  "corpora": {
    "bank_feed": {
      "enabled": true,
      "provider": "plaid",
      "environment": "sandbox",
      "registered_redirect_uris": [
        "https://brain.example/app/connect/bank"
      ],
      "country_codes": ["US"],
      "reconciliation_interval_minutes": 360
    }
  }
}
```

The Plaid profile pins the reviewed public API and Link SDK endpoints. Do not
add `api_base`, `link_sdk_url`, or `link_global` to a Plaid manifest. Those
fields remain available only for a separately reviewed `custom` bank-feed
provider.

The setup order is:

1. Fix the Brain's final hostname and enable the Plaid profile with
   `environment: "sandbox"` in the manifest.
2. Register `https://<brain-host>/app/connect/bank` in the client's Plaid
   Sandbox environment and record that exact address in
   `registered_redirect_uris`.
3. Deploy and migrate the Brain.
4. Run `brain doctor <manifest>`. It prints the exact return and signed webhook
   URLs and refuses a Plaid endpoint override.
5. Run `brain technician <manifest> --run plaid` in an interactive terminal.
   The command refuses a missing manifest, disabled feed, non-Plaid provider,
   any custom Plaid endpoint field, missing environment, Production selection,
   invalid final hostname, or unregistered return address before reading a
   hidden value. It also refuses an agent shell and records the exact
   owner-terminal continuation.
   The Plaid client ID, secret, and independently generated
   `BANK_FEED_WRAPPING_KEY_V2` are entered with echo disabled, cross only into
   one short-lived secrets child, and are then zeroed from the parent. Keep the
   wrapping key in the reviewed owner custody record before this step. It is
   required for recovery and is never derived from an admin, session, or Plaid
   credential. After that child returns, a second child receives no Plaid value
   and opens or prints the reviewed owner Link page.
   Do not add `--json` to this owner-terminal command. Plaid returns its fixed
   no-secret result through the private technician status file; a coding agent
   continues with the separate credential-free
   `brain technician <manifest> --json` plan refresh. QuickBooks has a different
   structured JSON ceremony.
6. If the owner page needs to be reopened, run `brain connect bank <manifest>`.
   The CLI reads only the saved manifest, checks that the exact return address
   is recorded, and prints the owner URL without reading a credential or
   calling a Plaid API. It then opens the page when the desktop permits; that
   browser page loads Plaid's Link SDK. Use `--print` for a fully offline
   command that leaves the link for the owner to open themselves.
7. The account holder signs in to the Brain, completes Link themselves, and
   assigns each masked account to the business that owns it. Transactions stay
   staged until every discovered account has an owner-confirmed scope.

No Plaid credential belongs in the manifest, shell history, source tree, log,
status response, support artifact, or recovery artifact.

The technician status stores only `connector: "plaid"`,
`environment: "sandbox"`, `outcome: "owner_link_page_ready"`, fixed custody
and pending-field-gate flags, plus the normal credential-free refresh command.
It stores no Plaid value, page URL, account identity, or claim of live provider
proof. Production remains outside this technician ceremony.

## Runtime contract

- Initial Link requests only `transactions`, with up to 730 days requested.
- The Link page's Content Security Policy permits the pinned SDK origin and only
  the API origin for the selected Sandbox or Production environment.
- A normal top-level page navigation is authorized by the signed owner session
  cookie because browsers cannot add application headers to address-bar
  navigation. Every page API request still requires both that cookie and
  `X-Brain-App: 1`. The page renders provider labels as text, never executable
  markup.
- Update mode supplies the existing access token and omits `products`,
  `transactions`, and other product-specific parameters. A successful update
  keeps the existing access token and does not exchange a public token. The
  connection remains `reauth_required` until `/item/get` proves the same Item is
  healthy.
- The browser persists one client request ID for Link-token creation. An
  unexpired durable Link receipt is replayed after a lost response.
- A completed token-exchange receipt is replayed without calling Plaid twice.
  D1 atomically allows one concurrent request to claim the single-use public
  token. Exchange is never automatically retried. An ambiguous outcome returns
  `PLAID_EXCHANGE_OUTCOME_UNKNOWN` and keeps the same recovery identity.
- Access tokens use the independent versioned bank-feed wrapping key. They are
  never protected by the admin key or session-signing key.
- Every `transactions/sync` `has_more` window is staged from the original
  committed cursor. The ledger rows and final cursor become visible in one
  set-based D1 promotion only after the complete window is present.
- An Item is not a business scope. Every discovered account receives one opaque
  `account_ref` and remains staged until the signed-in owner assigns it to one
  active owned entity. Missing, retired, counterparty, or unavailable entity
  authority blocks the complete promotion and cursor advance. `entity_slug` in
  an older Plaid manifest is ignored; it never defaults new accounts to
  `primary`.
- `GET /api/bank-feed/accounts` is owner-session-only and returns masked account
  labels, assignment, freshness, provider-history, and coverage states. It
  returns unavailable rather than a healthy empty list when D1 or the account
  inventory cannot be proved. `POST /api/bank-feed/accounts/assign` uses a
  stable `request_id`; an unchanged retry replays one receipt and never appends
  a second owner activity event. Neither route accepts the admin key as a
  fallback or returns Item, provider-account, ledger-account, or transaction
  identifiers.
- The browser preserves one assignment request ID until a successful response.
  A retry after a lost response therefore returns the one stored receipt and
  one activity event. The final required assignment immediately resumes the
  staged import; earlier assignments do not start a partially scoped promotion.
- `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` discards the staged attempt and
  restarts from that original cursor.
- An empty page is not historical-completion evidence. The exact Plaid state is
  stored in `provider_history_state` as
  `TRANSACTIONS_UPDATE_STATUS_UNKNOWN`, `NOT_READY`,
  `INITIAL_UPDATE_COMPLETE`, or `HISTORICAL_UPDATE_COMPLETE`; the result stays
  `ok:false, partial:true` until the historical state is observed. Receipts and
  status expose the local `history_state` (`queued`, `running`, or `complete`)
  separately. Both states are scoped to one Plaid Item. Historical readiness
  for one Item never completes another Item. Within an Item, Plaid's readiness
  is the provider evidence for the accounts belonging to that Item.
- `pending_transaction_id`, official currency, unofficial currency, provider
  account and transaction IDs, endpoint, window, and page provenance survive
  normalization.
- The webhook accepts only a current ES256 `Plaid-Verification` JWT whose
  fetched key ID matches and whose SHA-256 claim matches the exact raw request
  body. The key cache expires no later than Plaid's `expired_at`. Event receipt,
  readiness evidence, and reconciliation debt commit in one D1 batch. A replay
  repairs missing debt, while out-of-order delivery remains explicit.
- Disconnect creates durable revocation debt. The encrypted access token stays
  until provider removal is confirmed. `/item/remove` is single-shot. A lost or
  unclear response is stored as `unknown`; recovery checks `/item/get` before
  considering another removal call. Financial history stays.

These rules follow Plaid's current [Transactions Sync guidance](https://plaid.com/docs/transactions/),
[update-mode guidance](https://plaid.com/docs/link/update-mode/),
[webhook verification contract](https://plaid.com/docs/api/webhooks/webhook-verification/),
and [Item removal contract](https://plaid.com/docs/api/items/).

## Proof levels

Run the credential-free rehearsal with:

```sh
node operations/plaid-sandbox-runner.mjs
```

It uses invented values and a fake provider. It exercises response loss,
correct update mode, historical readiness, pagination mutation restart, whole-window promotion,
pending-to-posted linkage, official and unofficial currency preservation,
signed webhooks, replay ordering, and revocation retry. It prints
`fieldProof: false` on purpose.

The live Plaid Sandbox gate is separate. Sandbox can automate a disposable test
Item, public-token exchange, paginated sync, synthetic transaction changes,
test webhooks, `ITEM_LOGIN_REQUIRED`, scheduled reconciliation, and confirmed
Item removal. It cannot prove a human Link ceremony, a real institution, a
production access grant, or the owner's primary bank.

After the client approves the Sandbox action and the reviewed hidden launcher
supplies `BANK_FEED_CLIENT_ID`, `BANK_FEED_SECRET`, and the registered redirect
URI as `BANK_FEED_SANDBOX_REDIRECT_URI`, run. Set
`BANK_FEED_SANDBOX_WEBHOOK_URI` only when the disposable deployed Brain webhook
has also been approved for this gate:

```sh
node operations/plaid-sandbox-runner.mjs --live
```

The runner creates one disposable Sandbox Item, exchanges its public token once,
completes a bounded `transactions/sync` window, reports local `history_state`
separately from exact `provider_history_state`, requests a synthetic refresh,
forces `ITEM_LOGIN_REQUIRED`, creates the correct update-mode Link token,
optionally requests a test webhook, and removes the Item in `finally`. Its
receipt never contains an Item ID or token. Provider acceptance of a fired
webhook is not delivery proof. `providerApiProof` covers only this sanitized
provider-API subset. `liveSandboxProof` stays false until the same disposable
Item also passes the Financial Brain route/D1 path and update-mode health proof.
The deployed Brain's signed webhook receipt and scheduled fallback must be
checked separately.

## Owner ceremony still required before the primary bank

- The owner owns or explicitly approves the Plaid account, plan, legal terms, and
  Production access.
- The final hostname, Production redirect URI, and webhook destination are
  reviewed in Plaid before the session.
- The owner enters or supervises the hidden Plaid credential ceremony.
- The owner stores or supervises the independently generated wrapping key in the
  reviewed recovery custody location before any Item is connected.
- The owner completes Link, institution login, consent, MFA, and any later update-mode
  repair on his own device.
- The first Production connection is checked against the institution's visible
  account list, per-account entity assignment, date coverage, transaction direction, currency, pending and
  posted replacement, webhook delivery, scheduled fallback, disconnect, and
  provider-side removal.
- A sanitized receipt is reviewed before the connector is called field-proven.

Until that ceremony and receipt exist, the honest status is built with
credential-free scripted proof and a Plaid Sandbox gate, with no Production or
real-bank proof.
