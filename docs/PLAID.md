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
      "entity_slug": "primary",
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

1. Fix the Brain's final hostname and enable the Plaid profile in the manifest.
2. Register `https://<brain-host>/app/connect/bank` in the client's Plaid environment.
3. Deploy and migrate the Brain.
4. Run `brain technician <manifest> --run plaid` in an interactive terminal.
   The Plaid client ID, secret, and independently generated
   `BANK_FEED_WRAPPING_KEY_V2` are entered with echo disabled, cross only into
   one short-lived secrets child, and are then zeroed from the parent. Keep the
   wrapping key in the reviewed owner custody record before this step. It is
   required for recovery and is never derived from an admin, session, or Plaid
   credential.
5. Run `brain doctor <manifest>`. It prints the exact return and signed webhook
   URLs and refuses a Plaid endpoint override.
6. The account holder signs in to the Brain, opens the bank connection page,
   and completes Link themselves.

No Plaid credential belongs in the manifest, shell history, source tree, log,
status response, support artifact, or recovery artifact.

## Runtime contract

- Initial Link requests only `transactions`, with up to 730 days requested.
- Update mode supplies the existing access token and omits `products`,
  `transactions`, and other product-specific parameters. A successful update
  keeps the existing access token and does not exchange a public token.
- An unexpired durable Link receipt is replayed after a lost browser response.
- A completed token-exchange receipt is replayed without calling Plaid twice.
  An internally ambiguous public-token exchange fails closed because Plaid
  public tokens are single-use.
- Access tokens use the independent versioned bank-feed wrapping key. They are
  never protected by the admin key or session-signing key.
- Every `transactions/sync` `has_more` window is staged from the original
  committed cursor. The ledger rows and final cursor become visible in one
  set-based D1 promotion only after the complete window is present.
- `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` discards the staged attempt and
  restarts from that original cursor.
- `pending_transaction_id`, official currency, unofficial currency, provider
  account and transaction IDs, endpoint, window, and page provenance survive
  normalization.
- The webhook accepts only a current ES256 `Plaid-Verification` JWT whose
  fetched key ID matches and whose SHA-256 claim matches the exact raw request
  body. Replays and out-of-order deliveries are recorded explicitly. Webhooks
  request reconciliation but never replace scheduled reconciliation.
- Disconnect creates durable revocation debt. The encrypted access token stays
  available for retry until `/item/remove` succeeds. Financial history stays.

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
correct update mode, pagination mutation restart, whole-window promotion,
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

The runner creates one disposable Sandbox Item, exchanges its public token,
completes a bounded `transactions/sync` window, requests a synthetic refresh,
forces `ITEM_LOGIN_REQUIRED`, creates the correct update-mode Link token,
optionally requests a test webhook, and removes the Item in `finally`. Its
receipt never contains an Item ID or token. Provider acceptance of a fired
webhook is not delivery proof. The deployed Brain's signed webhook receipt and
scheduled fallback must be checked separately.

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
  account list, date coverage, transaction direction, currency, pending and
  posted replacement, webhook delivery, scheduled fallback, disconnect, and
  provider-side removal.
- A sanitized receipt is reviewed before the connector is called field-proven.

Until that ceremony and receipt exist, the honest status is built with
credential-free scripted proof and a Plaid Sandbox gate, with no Production or
real-bank proof.
