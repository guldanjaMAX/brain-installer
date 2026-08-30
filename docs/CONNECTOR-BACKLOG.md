# Connector readiness and ranked backlog

Current as of 2026-08-30 for the integrated v0.2.1 release candidate.

This is the engineering proof ledger. The client-facing capability description
lives in `onboarding/07-ingest-source-matrix.md`. No assertion count promotes a
connector. A row moves only when its named real-boundary test has a reviewed,
sanitized receipt.

## Proof vocabulary

These dimensions are independent. Do not compress them into one word.

| Dimension | Allowed values | Meaning |
|---|---|---|
| Build | Built, partial, absent | Whether runnable product code exists in this checkout |
| Automated proof | Unit, fixture, scripted I/O, in-process, none | Unit uses constructed values. Fixture uses a committed sample. Scripted I/O runs real connector code against a fake provider, process, or filesystem. In-process calls the real Worker with scripted bindings. |
| Real boundary | None, live smoke, partial real data, end-to-end real data | Live smoke touches a real service with synthetic data. Partial real data crosses at least one real source boundary but not the lifecycle. End-to-end proves the named lifecycle on authorized real data. |
| Acceptance | Pending or accepted | Accepted requires a sanitized receipt for the exact test in this ledger. |

`Proven` means the connector processed authorized real source data through the
accepted boundary. A fake daemon that emits production log strings is still
scripted I/O. A disposable real Cloudflare Worker processing fictional files is
a live service smoke test, not proof of a source connector or customer corpus.

## Current proof ledger

| Source or surface | Build | Automated proof | Real boundary | Exact next acceptance test |
|---|---|---|---|---|
| Common ingestion outcome and deletion contract | Built | Unit, fixture, scripted I/O, and in-process | None as one composed field gate | On disposable real sources, record one completed run, one partial run, one unavailable source, one retryable interruption, one refusal, cursor withholding, authenticated family inventory, guarded deletion, and exact post-delete readback. |
| Direct upload and API push into Cloudflare | Built | Scripted I/O and in-process | Live smoke only, real Worker, D1, Vectorize, and Workers AI with synthetic corpus | Keep the disposable release gate green for changed, unchanged, retry, retrieval, and confirmed cleanup. Separately ingest one authorized non-sensitive real document before claiming real-data proof. |
| Google Drive full walk | Built | Scripted I/O and fixture | Partial real data, one real unbounded walk was observed | Record a sanitized no-limit completion receipt with exact scanned, accepted, refused, retryable, and stored-family counts. |
| Google Drive root allowlist, incremental refresh, deletion, and macOS schedule | Built | Scripted I/O | None | On a seeded Drive, prove allowlist scope, add, edit, intentional refusal, interrupted resume, trash, incremental refresh, no cursor loss, no duplicate families, and two real scheduler ticks. |
| Google OAuth connection | Built | Scripted I/O | Partial real data, two of the three connector scopes were observed | Connect a disposable Google app with Drive, Gmail, and Calendar scopes, then read back the stored scope set without printing tokens. |
| Gmail full and incremental | Built | Scripted I/O | None | Seed a mailbox, run a bounded baseline, interrupt mid-batch, resume, add one message, and prove the next `historyId` refresh adds it once. |
| Google Calendar | Built | Scripted I/O | None | Use a seeded calendar to prove baseline, edit, cancellation removal, pagination, expired-token resync, and no duplicate event family. |
| Watched local folder | Built | Fixture and scripted filesystem | None | On a real Mac, supervise install and two ticks covering add, edit, delete, sleep or wake catch-up, missing folder, lock contention, and fresh status readback. |
| iMessage on Mac | Built | Fixture and scripted I/O | None, no accepted real `chat.db` read | With explicit approval on a test Mac, prove Full Disk Access, history, one new iMessage, one forwarded SMS, restart resume, and source freshness without printing content. |
| WhatsApp export | Built | Invented fixtures | None | Load reviewed real exports from current iOS and Android formats, prove dates and session counts, and prove an ambiguous export is refused rather than guessed. |
| WhatsApp live pairing and drain | Built | Go unit tests and scripted I/O | None, never paired | With explicit account-risk approval, prove a phone scans the real QR, bounded history arrives, one live message drains once, restart resumes, and disconnect removes supervision on a non-critical account. |
| Android SMS and Google Voice exports | Built | Handwritten fixtures | None | Load one reviewed real export of each shape and prove direction, time, session identity, rerun idempotency, and family deletion. |
| iPhone backup | Built | Self-written fixture | None | Run against an Apple-written backup on macOS and Windows, then prove encrypted refusal, WAL handling, rerun idempotency, and snapshot labeling. |
| Zoom webhook and delivery debt | Built | In-process | None, zero provider smoke | On an approved paid test seat, record one meeting, wait for transcript completion, prove debt creation and clearance, then retrieve the transcript with speaker provenance. |
| Zoom transcript export | Built | Fixture | None accepted | Load a transcript exported by Zoom and prove timestamps, speaker attribution, rerun identity, and citation provenance. |
| Bank CSV, OFX, and QFX | Built | Invented fixtures | None | Use reviewed exports from at least two institutions: reconcile counts and balances, rerun unchanged, import one revision, and prove every ledger row points to its source document and position. |
| Plaid hosted bank feed | Built | Scripted I/O and real SQLite/D1-compatible runtime | None, no Plaid credential or Sandbox call used | With an approved client-owned Plaid Sandbox account, run the disposable runner, then prove product Link, lost-response replay, whole-window sync promotion, pagination-mutation restart, pending-to-posted replacement, currency and provenance preservation, signed webhook receipt, scheduled fallback, update mode, durable revocation retry, and provider-confirmed Item removal. |
| Financial ledger | Built schema, import, and reads | Scripted I/O | None, synthetic ledgers only | Complete the bank-export gate, then answer one approved question from ledger rows with source-document provenance rather than text retrieval. |
| Scanned-PDF OCR | Built, off by default | Fixture and scripted I/O | None, no page reached real Workers AI | In a private disposable gate, test a typed scan, a one-bit fax or photocopy, and handwriting; verify exact page coverage, low-confidence marking, refusal, citation provenance, and no ledger claim from OCR text alone. |
| Human custodian or manual portal export | Operational source type | Watched-folder and Drive paths tested as above | None for an actual delivery cadence | Record who supplies the artifact, cadence, expected format, date coverage, and one missed-delivery test that reports stale or unavailable instead of zero. |
| IMAP | Built, read-only | Scripted real socket, 78 checks; TLS and provider behavior remain outside the harness | None | Use a seeded disposable Yahoo, Fastmail, iCloud, or hosted mailbox to prove TLS, app-password custody, folder inventory, baseline, UID resume, reconnect, no unread-state mutation, and explicit Archive/unclassified-folder reporting. |
| Facebook Messenger export | Built, export-only | Fixture plus common folder-ingestion path | None | Load one current reviewed Download Your Information JSON export; prove exact timestamps, text repair, stable thread/session identity, attachment/unavailable counts, rerun idempotency, provenance, retrieval, and family deletion. |
| Browser owner document and image upload | Built for text, PDF text layers, Word, PowerPoint, Excel, EML, PNG, and JPEG | Extractor fixtures and in-process Worker | None | On a disposable Worker, upload every supported format; prove private OCR, signature and archive refusal, lost-response retry, unchanged retry, retrieval, and exact deletion. Scanned PDF page OCR remains absent. |
| QuickBooks Online | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use an Intuit sandbox company to prove company-bound consent, refresh, all configured entities, pagination, changed records, outage retry, disconnect, and retrieval. Query snapshots cannot prove deletions. |
| Slack | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use a test workspace to prove public-client PKCE, rotating user-token refresh, channel and direct-message pagination, threads, surfaced deletion events, rate limits, exclusions, disconnect, and retrieval. Complete deletion truth remains unavailable. |
| Notion | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use a test workspace to prove shared and unshared pages, recursive blocks, edits, trash, under-sharing visibility, refresh, retry, disconnect, and retrieval. Complete removal truth remains unavailable. |
| LinkedIn Download Your Data | Built, export-only | Bounded archive and CSV fixtures through common folder ingest | None | Load one current reviewed owner export, reconcile recognized and skipped CSVs, rerun unchanged, retrieve one result, and prove exact source-file family deletion. Live LinkedIn is absent. |
| Microsoft 365 | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use a test Entra tenant to prove consent, refresh, Outlook immutable-ID delta, OneDrive and SharePoint body downloads, cursor expiry reset, lost drive visibility, deletion, disconnect, and retrieval. |
| Dropbox | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use a test account to prove public-client PKCE, refresh, bounded body extraction, cursor resume and reset, an extraction gap, edits, tombstones, disconnect, and retrieval. |
| HubSpot CRM | Sandbox-ready read-only runner | Unit and scripted provider I/O | None | Use a test portal to prove the 2026-03 OAuth lifecycle, pagination, contacts, companies, deals, archives, retry, revoke, disconnect, and retrieval. Permanent-deletion truth remains unavailable. |
| Salesforce, QuickBooks Desktop, live LinkedIn, official Facebook, and official WhatsApp | Absent | None | None | Define a policy-compliant product boundary, custody model, deletion semantics, and sandbox acceptance plan before building any of these. |

## Ranked work

1. **Field-prove common ingestion truth.** The executable conformance gate now
   proves completed, partial, unavailable, retryable, and refused outcomes do
   not share a success-shaped value; remote cursors advance only after complete
   accepted work; multi-document producers declare `family_of`; and real
   deletion plans use authenticated stored-family truth plus exact readback.
   Connector receipts count logical families rather than split rows, and the
   Calendar command now keeps its row, receipt, cancellation, and custom-source
   namespaces identical. A connector that returns no recognized receipt can no
   longer be promoted to completed merely because it did not throw. Calendar
   also withholds its Google token after an event failure, refusal, or pending
   cancellation cleanup. Calendar dry runs emit the shared preview receipt and
   fail closed when any declared calendar cannot be read. Message commands now
   distinguish submitted from accepted conversations, classify any Worker
   refusal as partial, and report exact would-send volume in dry runs without
   credentials, network writes, or resume-state writes. Explicit message
   `--limit` runs are partial by contract. Refusal receipts retain a redacted
   reason, and direct commands do not print a success-shaped accepted-count
   line for bounded or refused loads.
   It remains automated proof until the composed disposable field gate above.
2. **Keep the test chain and public-repository privacy gates complete.** A
   fixture-only test that is not run is zero evidence. A clean package scan is
   not proof that the public repository is clean.
3. **Prove the common live sources.** Drive lifecycle, Gmail, Calendar, Zoom,
   and message paths need real-system receipts. These require explicit approval
   and test accounts or devices.
4. **Prove watched-folder behavior over real time.** The code path is shared and
   deterministic, but real macOS sleep, wake, File Provider, lock, and
   multi-tick behavior is still missing.
5. **Run the Plaid Sandbox field gate and real-export normalization gate.** The
   code now closes the local durability boundaries. The next risk is the real
   provider shape, Link and webhook delivery, direction, revision, and removal
   behavior, not another bank-specific schema.
6. **Prove OCR on private real scans.** The implementation is complete and off.
   The field gate must include typed, one-bit, and handwritten pages and must
   preserve low-confidence and partial states.
7. **Field-prove the integrated read-only IMAP line.** Email export through MBOX
   remains the zero-credential fallback. The live connector must prove TLS,
   app-password custody, folder truth, UID resume, and no unread-state mutation.
8. **Run the six provider sandbox gates and the LinkedIn export gate.** The
   runners are locally complete enough to test, but no consent, refresh,
   cursor, deletion, scheduling, disconnect, or retrieval lifecycle has crossed
   a real provider boundary.
9. **Defer speculative long-tail APIs.** Treat people, recurring manual exports,
   and portal downloads as first-class source plans. Do not assume every source
   has an API or that the owner controls its credentials.

## Evidence currently accepted

- `docs/release-evidence/v0.1.12-cloudflare-field-gate.json` and
  `v0.1.13-cloudflare-field-gate.json` prove disposable real Cloudflare service
  behavior using synthetic corpora. They do not prove a source connector or a
  private corpus.
- `evidence/WP-07-cli.md` and `daemons/whatsapp/README.md` explicitly state that
  scripted pairing output does not prove a phone can scan the QR or that a
  real message is delivered.
- `evidence/WP-00-closeout.md` describes the connector rehearsal as synthetic
  and scripted at provider, Vectorize, and Workers AI boundaries.
- `evidence/WP-11-ocr-for-scans.md` proves local page imaging, refusal, and
  provenance behavior. It does not contain a real-scan Workers AI receipt.
- `test/ingestion-contract.test.mjs` is the common automated conformance gate.
  It does not promote any connector to real-boundary proof.
