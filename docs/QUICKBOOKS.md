# QuickBooks Online connection and proof boundary

QuickBooks Online is a read-only runtime reference, not financial authority.
Intuit exposes one broad Accounting OAuth scope that can authorize reads and
writes. Financial Brain requests that scope because there is no narrower
accounting-read scope, then performs query and read calls only. The consent
screen must state the broader provider permission honestly.

Official Intuit references:

- [OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Redirect URI rules](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri)
- [Scopes](https://developer.intuit.com/app/developer/qbo/docs/learn/scopes)
- [Sandbox management](https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes)
- [Production technical requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/technical-requirements)

## What is available now

The installed flow is available only for an Intuit sandbox company:

```json
{
  "corpora": {
    "quickbooks": {
      "enabled": true,
      "environment": "sandbox",
      "redirect_host": "localhost"
    }
  }
}
```

Register the exact callback shown by the command. The default is
`http://localhost:47812/`. Intuit compares redirects exactly, including the
scheme, host, port, case, and trailing slash. `127.0.0.1` remains an explicit
configuration option for controlled compatibility testing, but Intuit's current
sandbox documentation names `localhost`. The HTTP listener always binds
`127.0.0.1`; the manifest cannot broaden it to a LAN or wildcard address.

The connection:

- keeps the raw `realmId`, app secret, access token, and refresh token only in
  the protected local provider store;
- derives one canonical SHA-256 company fingerprint from
  `quickbooks-company-v1:<realmId>`;
- binds the active credential, explicit source, environment, provider cursor,
  configuration receipt, reconciliation claims, and every document identity to
  that same fingerprint;
- refuses a different company for an existing source before replacing the
  stored credential;
- permits another company only under a separately named source, and refuses an
  inactive source from using the active company's token;
- serializes refresh-token rotation in process, compares the durable token again
  before replacement, and retains the latest refresh-expiry evidence;
- revokes with Intuit before clearing the local credential.

A QuickBooks credential created before company binding was added must complete
one sandbox reconnect before ingest. The reconnect verifies the returned
company and creates the protected source binding. Ingest refuses with
`source_binding_missing` until that proof exists; it does not guess from an old
cursor or manifest label.

Disconnecting ends provider access. Imported documents remain in the Brain.
Removing them is a separate reviewed action: first run the source-specific
`brain forget` preview, review its scope, and then approve that operation
separately. A disconnect receipt never claims that imported documents were
deleted.

Changing from the pre-company-bound document identity to the company-bound
identity can leave prior QuickBooks documents until that reviewed forget and
reingest is performed. Do not infer deletion from an absent QuickBooks query
row. Intuit's query snapshots do not provide complete deletion truth.

## Proof level

Automated fixtures prove company separation, stable same-company reconnect,
wrong-company refusal, paginated read calls, refresh rotation, refresh expiry,
revoke success and failure, retained-document receipts, source cursor custody,
and callback construction. They do not prove an Intuit sandbox login, consent,
provider token behavior, a real company record, or a production callback.

The next accepted field gate is an owner-approved Intuit sandbox company. It
must inspect the exact documented authorization and confidential-client token
exchange, then prove consent, returned company identity, same-company
reconnect, a deliberate wrong-company refusal, token refresh,
configured-entity pagination, one changed record, retry after an outage, dry
run, first ingest, retrieval, disconnect, retained-document truth, and a
separately reviewed forget preview.
The receipt must contain fingerprints and counts only, not company identifiers,
tokens, record content, or app values.

## Production is intentionally unavailable

When `corpora.quickbooks.environment` is `production`, the technician and direct
connect commands stop with `quickbooks_production_callback_unavailable` before
reading a local credential or opening a browser. An API key cannot replace
Intuit OAuth. Intuit production redirects require a registered HTTPS SaaS
domain, so the sandbox loopback callback is not a production shortcut.

### Threat model for the future HTTPS callback

The callback must resist:

- state guessing, replay, login CSRF, and a second callback racing the first;
- authorization codes, tokens, `realmId`, state values, and claim secrets
  entering application logs, support receipts, analytics, or error bodies;
- one client's intent, app, source, environment, or company being claimed by
  another install;
- a lost callback, polling, token-exchange, credential-save, or finalize
  response creating two durable connections or a false success;
- an expired or already-consumed intent being revived;
- a remote service learning the local credential, refresh token, or private
  handoff key;
- a company change bypassing the local source binding.

The HTTPS endpoint must be hosted in the client's own Cloudflare account. It
must not be a shared Financial Brain callback or a technician-owned relay.

### Frozen route contract before implementation

The following is an implementation contract, not a currently available route:

1. The local technician generates a random intent id, random OAuth state,
   random claim secret, and an ephemeral encryption key pair. The private key
   remains local. The HTTPS start request stores only hashes of the state and
   claim secret, the public key, source, environment, client-id fingerprint,
   expected company fingerprint when reconnecting, creation time, and a short
   expiry.
2. The authorization URL contains the raw state and exact registered HTTPS
   callback. Intuit's current discovery metadata reports no supported PKCE
   challenge method, and its official confidential-client samples exchange the
   code with Basic client authentication. The route contract keeps a future
   challenge field reserved, but it stays absent unless Intuit documents and a
   sandbox gate proves provider-side PKCE enforcement.
3. `GET /api/oauth/quickbooks/callback` hashes the returned state, loads one
   unexpired pending intent, encrypts the authorization code and `realmId` to
   the local ephemeral public key, and performs one conditional pending-to-
   received transition. A second callback cannot replace the ciphertext. A
   provider retry receives the same neutral success page.
4. A private `POST /api/oauth/quickbooks/intents/claim` uses the intent id and
   claim secret over HTTPS. It returns the same encrypted callback envelope
   after response loss and uses `Cache-Control: private, no-store`. It never
   returns plaintext provider values.
5. The local technician decrypts the envelope, verifies source and company
   binding, exchanges the one-time code directly with Intuit, and atomically
   stores and reads back the credential. Tokens never traverse the callback
   Worker.
6. Only after durable local readback does the technician call the idempotent
   finalize route. Finalize is safe to repeat. An uncertain Intuit token
   response requires a new authorization ceremony, not a blind exchange retry.
7. Expired, canceled, or finalized intents refuse claim. Scheduled cleanup
   removes expired ciphertext and public metadata. Status and support receipts
   expose only stable reason codes, timestamps, and irreversible fingerprints.

Application code must never log the callback URL, request query, headers,
authorization code, state, claim secret, ciphertext, tokens, raw company id, or
provider error body. Cloudflare request-log and tracing behavior must also be
reviewed with the exact production route before field use.

### Why the production callback is not implemented in this slice

The contract needs durable intent state and restart-safe conditional updates,
which requires a coordinated D1 migration. Migration numbers 0029 and 0030 are
reserved by parallel work. The final client-owned hostname, Cloudflare logging
policy, and any future Intuit PKCE support also need explicit decisions and sandbox proof.
Implementing a partial relay without those boundaries would make production
look available before it is safe. No live app, account, callback, or credential
was used for this work.
