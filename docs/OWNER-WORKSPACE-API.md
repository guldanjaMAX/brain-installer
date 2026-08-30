# Owner workspace API contract

This document freezes the owner backend contract introduced by D1 migration
0021 and the destructive-action receipt extension in migration 0024.
All routes use JSON `POST`, return `Cache-Control: no-store`, and require both a
valid passkey session and `X-Brain-App: 1`. The session must resolve positively
to `{ kind: "owner", grantId: null }`. There is no admin-key fallback.

Missing or invalid sessions return `401 {"error":"unauthorized","code":"session_required"}`.
A live scoped principal returns `403 {"error":"forbidden","code":"owner_required"}`.
Unavailable authorization or storage fails closed with a stable `503` code.

## Shared write envelope

Every write requires `request_id`, 1 to 128 letters, digits, underscores, or
hyphens. Successful write responses contain:

```json
{
  "request_id": "stable retry identity",
  "entity_scope": { "entity_slug": "owned-entity-or-null" },
  "changed": true,
  "activity_event_id": "event id or null",
  "replayed": false
}
```

An exact retry returns the stored result with `replayed:true`, HTTP 200, and no
second domain write or activity event. Reusing a request ID with a different
normalized request returns HTTP 409 with `code:"request_id_conflict"`.

Writes are refused with HTTP 503 and `code:"owner_writes_paused"` while
`VECTOR_DRAIN_MODE=paused-for-upgrade`.

An owned entity is a live `fin_entities` row with `relationship="owned"`.
Unknown entities return 404. Counterparties return 403. Database failures
return 503 and never fall through to a broader scope.

## Upload

`POST /api/owner/uploads/capabilities` accepts `{}` and declares the backend's
exact MIME, extension, encoding, and byte limits. Current support is:

- `text/plain` with `.txt`
- `text/markdown` with `.md` or `.markdown`
- strict UTF-8, with one leading UTF-8 BOM removed
- 1,000,000 UTF-8 content bytes

Empty or unknown MIME types, PDFs, images, Office files, RTF, email containers,
archives, and binary files return HTTP 415. Full binary upload remains blocked
on a separately reviewed storage and extraction architecture.

`POST /api/owner/uploads` request:

```json
{
  "request_id": "upload_attempt_1",
  "document_id": "stable_document_identity",
  "entity_slug": "owned_entity",
  "media_type": "text/plain",
  "file_name": "notes.txt",
  "envelope": {
    "content": "text",
    "title": "optional title",
    "metadata": {}
  }
}
```

`document_id` is stable across retries and later versions of the same logical
document. `request_id` identifies one attempted write only. Clients must not
send `envelope.source_type` or `envelope.source_id`. The server binds:

- `source_type = "upload"`
- `source_id = "owner:{entity_slug}:{document_id}"`
- authoritative `metadata.entity_slug = entity_slug`
- legacy Vectorize candidate metadata `client = entity_slug`

The resulting corpus identity is `upload:owner:{entity_slug}:{document_id}`.
Every accepted upload passes through the common ingest scanner, provenance,
chunking, and store path. Created or updated content emits one event only after
the store succeeds. Identical content is `unchanged` and emits no event.

The route persists a bounded pending intent before common ingest. A retry after
ingest committed but before receipt finalization resumes that intent, returns
HTTP 200 with the original action and `replayed:true`, and finalizes exactly one
event. A scanner rejection removes the pending intent and leaves no receipt or
event.

## Approvals

`POST /api/owner/approvals` supports:

```json
{
  "request_id": "ruling_1",
  "entity_slug": "owned_entity",
  "approval_type": "reconciliation_ruling",
  "subject_uid": "reconciliation_uid",
  "selected_claim_uid": "claim_uid",
  "note": "optional"
}
```

```json
{
  "request_id": "exception_1",
  "entity_slug": "owned_entity",
  "approval_type": "exception_resolution",
  "subject_uid": "exception_uid",
  "resolution": "required resolution",
  "note": "optional"
}
```

The reconciliation write updates the served `fin_reconciliations` row while
preserving both claims and appends `owner_approvals`. The exception write
updates the served `fin_exceptions` row without changing its transaction.
Approval and activity rows are append-only in SQL.

## Period close

- `POST /api/owner/period-closes/read`
- `POST /api/owner/period-closes/accept`
- `POST /api/owner/period-closes/reopen`

Read accepts `{entity_slug,period_start?,period_end?}`. A healthy empty result
contains `period_closes:[]`. An unavailable read omits the collection and names
`sections_unavailable:["period_closes"]`.

Accept and reopen require `request_id`, `entity_slug`, `period_start`, and
`period_end`. Accept may include `acknowledge_incomplete:true`. Evidence failure
returns 503 without a write. Incomplete evidence returns 409 unless explicitly
acknowledged.

The response keeps decision and evidence orthogonal:

```json
{
  "period_close": {
    "period_close_id": "id",
    "status": "accepted",
    "evidence_state": "complete",
    "acknowledged_incomplete": false
  }
}
```

`status` is `accepted` or `reopened`. `evidence_state` is `complete` or
`owner_acknowledged_incomplete`. Re-acceptance derives evidence state from the
current evidence snapshot, not from an older acceptance.

## Activity

`POST /api/owner/activity` accepts `{entity_slug?,limit?,cursor?}` and returns
an append-only page under `activity_events`. Each row uses `event_type`,
`entity_slug`, `subject_kind`, `subject_id`, `display_label`, and `occurred_at`.

The one human history includes upload, approval, close, target, preference,
document-grant create/invite-reissue/revoke, and passkey/device changes. Shared
security writers use `document_grant_created`,
`document_grant_invite_reissued`, `document_grant_revoked`, `passkey_added`,
`passkey_renamed`, `passkey_revoked`, and `sessions_revoked`; receipt deletion
uses `corpus_deletion_completed`. Each is appended only after a successful
state change, and an exact retry after completion adds no second event. The history never contains document
content, questions, answers, credentials, credential IDs, raw errors, IP
addresses, user agents, or low-level allow/deny telemetry. Security telemetry
remains separate.

## Targets and preferences

Targets:

- `POST /api/owner/targets/read` with `{entity_slug}`
- `POST /api/owner/targets/upsert`
- `POST /api/owner/targets/archive`

Metrics are `revenue`, `cash_reserve`, `spending_limit`, `debt_reduction`, or
`other`. Money is a safe integer in minor units with a three-letter currency.
Identical upserts and repeated archives return `changed:false` and emit no event.

Preferences:

- `POST /api/owner/preferences/read` with `{entity_slug?}`
- `POST /api/owner/preferences/set`

Supported keys are `default_entity`, `display_currency`,
`fiscal_year_start_month`, and `activity_window_days`. Scope and value rules are
enforced by the backend. Setting an identical value returns `changed:false` and
emits no event.

## Software update status

`POST /api/app/update-status` is owner-only and accepts an empty JSON body. The
Worker reads `https://financialbrain.ai/update/manifest.json` server-to-server.
The public request contains no client body, identity, files, questions,
manifest, source list, account details, or installed version.

The Worker treats the release feed as untrusted input. It refuses redirects and
bounds the response. A validated schema-v2 `held` or `candidate` feed returns
`release_held` or `release_candidate` with no installer, command, digest, or
size. Only `stable` can expose the fixed Claude handoff and an immutable GitHub
asset URL, SHA-256 digest, byte count, and reviewed changes. Stable responses
have `status` equal to `update_available`, `up_to_date`, or `ahead` and include
`installed_version`, `latest_version`, `checked_at`, and `update_url`.

Missing local version truth, an unreachable feed, or any malformed field returns
HTTP 503 with `status:"unavailable"`. It never falls back to a guessed installed
version or a healthy current claim. The route is private and no-store like every
other owner endpoint. It does not perform an update.

## Entity-scoped Explore and Ask

`POST /api/rag/unified` and `POST /api/rag/think` accept `entity_slug` in the
private JSON body. D1 validates a live owned entity, then applies exact
`documents.entity_slug` equality to keyword search and vector hydration.

Migration 0021 backfills this authority only from an unambiguous live
`fin_documents.corpus_doc_uid` mapping. It never infers authority from the
free-form legacy `documents.client` label. Unmapped or ambiguous legacy rows
remain `NULL` and owner-only.

Vectorize does not yet have canonical entity metadata. The legacy client value
is used only as a candidate hint, never as a D1 predicate. Every scoped response
therefore reports `degraded:"vector"` and
`degraded_reason:"entity-vector-authority-unindexed"` until the canonical
metadata index is built and reprojected. A scoped semantic miss cannot appear
as a healthy empty result.

## Corpus deletion receipts

Corpus deletion is not part of the shared owner-write envelope. It has a
separate short-lived authorization state machine introduced by migration 0024.
All three routes require the positively identified owner session described at
the top of this document. There is no admin-key fallback.

`POST /api/owner/corpus-deletions/preview` accepts exactly:

```json
{
  "entity_slug": "owned_entity",
  "document_ids": ["drive:one", "upload:two"]
}
```

The server requires 1 to 50 unique ids, sorts them, validates exact
`documents.entity_slug` authority, and returns one opaque five-minute receipt.
The stored hash binds the exact requesting principal, entity, sorted ids,
document count, chunk count, current content digest, and expiration. Cross-
entity and missing ids share the same 404 response.

`POST /api/owner/corpus-deletions/passkey/options` accepts only `{receipt}`.
The server rechecks the exact selection, then creates a short-lived WebAuthn
challenge whose purpose binds the receipt hash and selection digest.

`POST /api/owner/corpus-deletions/execute` accepts exactly:

```json
{
  "receipt": "opaque preview receipt",
  "request_id": "stable_delete_attempt",
  "credentialId": "owner credential id",
  "authenticatorData": "base64url",
  "clientDataJSON": "base64url",
  "signature": "base64url"
}
```

Caller-supplied `confirm`, entity, document ids, counts, digest, scope, or
instructions are invalid. The passkey must be an owner credential, not a
scoped grant. The server atomically consumes the receipt-bound challenge,
updates the passkey counter, binds the stable request id and request hash, then
claims one execution. It rechecks the exact current digest before calling the
D1-first deletion primitive and verifies that every target is absent afterward.

Expired or changed receipts return 410 or 409. A completed receipt with altered
input returns 409. An exact response-loss retry returns the stored HTTP 200
result with `replayed:true`, performs no second corpus mutation, and emits no
second `corpus_deletion_completed` activity event. D1 unavailability returns
503 and cannot fall through to deletion. Vector cleanup remains enqueue-only
through the shared outbox and leased drain.
