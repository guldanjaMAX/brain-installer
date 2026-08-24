# James Cloudflare Brain Readiness

Date: 2026-08-23

Branch: `codex/cloudflare-brain-phase2`

Deployed Worker: `james-brain-shadow`

URL: `https://james-brain-shadow.james-d13.workers.dev`

## Decision

The Cloudflare brain is live behind the production retrieval routes on `notes.jamesguldan.com`. Both `/api/rag/unified` and `/api/rag/think` now use the D1, Vectorize, and Workers AI install. The signed-in Search interface includes Answer and Sources modes, renders citations, and shows explicit coverage gaps.

This is not a Cloudflare capability blocker. D1, Vectorize, Workers AI, Worker secrets, ingestion, retrieval, citations, refusal behavior, and source freshness accounting are all working in production retrieval. Supabase is not ready to be retired because unattended incremental refresh is not yet running for Drive or messages.

## Production integration

- Notes deployed SHA: `fb390cb418d2c7a921b382fd09c0ff947fc79f2e`
- Notes branch: `codex/cloudflare-brain-proxy`
- Brain branch: `codex/cloudflare-brain-phase2`
- Brain transition-safe Drive commit: `92bda5a`
- Production backend switch: `RAG_BACKEND=cloudflare`
- Rollback: set the server-side `RAG_BACKEND` Worker secret to `supabase`
- Live UI: `https://notes.jamesguldan.com/search`

The Notes Worker holds a separate read-only Brain proxy key. That key can call only `/api/rag/unified` and `/api/rag/think`; it receives HTTP 401 on administrative routes. Notes cookies and Notes admin credentials are never forwarded to the Brain, and query-string credentials are stripped from proxied requests.

Production verification passed:

- authenticated positive query returned a Workers AI answer with an approved evidence gate and citations
- the Series A subject-ownership trap returned the canonical refusal with zero citations
- unauthenticated retrieval returned HTTP 401
- a missing query returned HTTP 400
- live Answer mode rendered clickable citation markers, three source cards, a coverage warning, and the Workers AI model label
- the live Worker health SHA matches the committed deployment

## Live corpus

| Source | Documents | Chunks | Registry |
| --- | ---: | ---: | --- |
| Curated | 981 | 14,753 | Ready, manual |
| Drive | 6,226 | 182,684 | Ready, daily expectation |
| Messages | 21,375 | 84,196 | Ready, daily expectation |
| **Total** | **28,582** | **281,633** | **All current** |

Integrity checks:

- 281,633 distinct chunk IDs
- 281,633 distinct vector IDs
- 281,633 vectors reported by the official Vectorize API
- zero pending outbox rows
- zero retried or quarantined outbox rows
- D1 and Vectorize counts agree exactly
- all three source receipts match the authoritative store counts

Migration boundaries:

- Drive migration examined 6,055 source files and stored 6,226 target documents.
- One failed-extraction divorce PDF and 2,008 exact duplicate Drive files were excluded from retrieval. Source files were not deleted.
- 2026 message migration examined all 56,906 eligible source rows and accepted 20,379 new target documents.
- 667 credential-bearing message sessions were refused and 607 empty or media-only sessions were skipped.
- The message corpus also contains 996 previously loaded older documents. Full pre-2026 message history was not migrated.

## Retrieval and answer safety

Final live evaluation:

| Suite | Retrieval | Refusal safety |
| --- | --- | --- |
| Core Ring 0 | Recall@5 65.4%, Recall@1 30.8%, MRR 0.480 | 4/4, 100% |
| Hard Ring 1 | Recall@5 20.0%, Recall@1 5.0%, MRR 0.110 | 12/12, 100% |

The Ring 1 retrieval score is a strict exact-document measure. Some live answers succeed from equivalent documents that are not listed in the golden set, so it should not be read as answer accuracy. It is still useful because it identifies hard multi-document retrieval work that remains.

Known-good live probes passed after the final deployment:

- Camp Maverick minimum pre-sell threshold and deadline
- AMS July price reduction and Eli's August approval
- James's standard client agreement and sending process

Safety behavior added and verified:

- Retrieval deduplicates by document before applying the result limit.
- Workers AI generation and verification run at temperature zero.
- Every factual answer needs inline citations.
- Every citation in the answer must be approved by the verifier.
- Every material part of a multi-part question must be answered or explicitly called unknown.
- High-risk personal, HR, legal, financial, and medical facts need an explicit owner link in the same document as the claimed fact.
- Planning interviews, drafts, templates, and decisions-so-far notes cannot establish binding legal obligations.
- Unsupported answers return the canonical sentence: `The documents do not answer the question.`
- Five fresh repetitions of the previously unstable Series A trap all refused after the deterministic owner-link rule was deployed.

## Security state

- Brain admin credentials are accepted only through `X-Admin-Key`. Query-string admin credentials are refused.
- The Brain admin key is stored in macOS Keychain under service `james-brain-shadow-admin-key`, account `james-main`.
- The Notes read-only proxy key is stored in macOS Keychain under service `james-brain-shadow-notes-proxy-key`, account `james-main`.
- The Cloudflare deployment token is stored in macOS Keychain under service `james-brain-shadow-cloudflare-api-token`, account `james-main`.
- The scoped token expires 2026-09-30 and is limited to James's account with Workers AI Read, Vectorize Edit, D1 Edit, and Workers Scripts Edit.
- The token was verified through the official API against the live Vectorize index.
- The token has no R2 permission because this brain does not use R2.
- Credential scanning refuses secrets before they enter the corpus.
- A broader Worker audit found no credential-named plain-text bindings after remediation and no hardcoded deployed token findings.
- The Notes admin key was rotated and stored in Keychain. Notes private routes reject unauthenticated requests.

## Remaining production gates

### 1. Run unattended incremental refresh

Drive and messages now have a daily freshness expectation, but no unattended connector is scheduled. The brain will correctly report them stale after 1.5 days if nothing updates them.

Required proof:

- a newly added Drive file appears without a full reload
- an edited Drive file replaces its old chunks
- a deleted Drive file is removed from D1 and Vectorize
- a new message appears after the high-water mark
- failed sync state is visible in source freshness

The product's Google Drive connector already implements a full first walk, incremental changes, edits, trash/deletion handling, and a persisted sync token. It needs a one-time OAuth connection to James's Google account before it can replace the migration snapshot. The product does not yet have an iMessage connector, so message freshness still needs a standard connector rather than a James-only bridge.

The pre-OAuth compatibility audit is complete and deployed:

- live Drive envelopes use the same `drive:<file-id>` identity as the migrated corpus, so refresh updates rather than duplicates
- the 2,009 reviewed migration exclusions remain enforced by the ordinary connector
- Drive folder paths and top-folder filters survive edits and moves without erasing richer migrated client or category metadata
- deletion removes both a one-document file and every oversized split part
- changed split counts are reconciled only after all replacement parts are accepted
- a document-level ingest failure does not advance the Drive change cursor
- the full product test suite passes, and the live authenticated family-cleanup route passed a non-mutating probe

Google Cloud Console then required James's passkey before OAuth client setup could continue. This is the only current Drive gate and requires a one-time local identity approval; it is not a Cloudflare, credential-design, or connector-capability blocker.

## Non-blocking cleanup

- Diagnose reports 30 exact duplicate documents still stored more than once.
- 6,681 documents have no trustworthy document date. This affects recency questions, not ordinary factual lookup.
- More than 5,000 groups of identical chunk text remain, mostly repeated headers, footers, and boilerplate.
- Full pre-2026 message migration is optional and large. It should only be done if real questions demonstrate that the missing history is valuable.
- Notes still needs separate transport/browser hardening for query-string admin-key compatibility, CSP, HSTS, and legacy TLS acceptance.

## Go or no-go

- Cloudflare brain itself: **GO and live for production retrieval**
- Notes production endpoint switch: **GO and live**
- Supabase retirement: **NO-GO until unattended Drive and message refresh are proven and freshness stays healthy through a rollback window**
