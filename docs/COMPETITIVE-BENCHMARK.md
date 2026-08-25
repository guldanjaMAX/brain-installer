# Competitive benchmark

**Reviewed:** 2026-08-25
**Scope:** Installable and managed personal or organizational knowledge-base RAG systems.

This is a product benchmark, not a feature shopping list. A capability belongs in
the installer only when it improves a measured client outcome or closes a clear
security, recovery, or operability gap.

## Decision summary

1. Keep the standard client-owned D1 plus Vectorize architecture while it passes
   the install's full-corpus evaluation. Corpus size alone is not a reason to move.
2. Treat **Cloudflare AI Search** as the current managed Cloudflare comparison.
   The legacy AutoRAG REST endpoints are deprecated, and Cloudflare states that
   new features and improvements are available through AI Search APIs.
3. Benchmark AI Search against this worker before recreating every managed search
   feature or changing the storage architecture.
4. Build the missing coverage, evaluation, permission, tracing, and recovery
   controls. Those are more important than adding another vector database.
5. Add graph retrieval only after a multi-document or corpus-wide evaluation
   slice proves that flat hybrid retrieval is insufficient.

Official Cloudflare references: [AutoRAG REST migration](https://developers.cloudflare.com/ai-search/api/migration/rest-api/),
[AI Search configuration](https://developers.cloudflare.com/ai-search/configuration/), and
[how AI Search works](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/).

## Competitive categories

| Category | Representative systems | What they do better today | Product response |
|---|---|---|---|
| Managed RAG | Cloudflare AI Search, Vectara, Pinecone Assistant, Amazon Bedrock Knowledge Bases, Azure AI Search | Managed indexing jobs, retrieval tuning, metadata filters, reranking, query visibility, grounded-answer features, and first-party evaluation workflows | Run a shadow benchmark. Adopt only where quality, lifecycle safety, cost, and ownership are at least as good. |
| Document understanding | Google Document AI, Pinecone multimodal parsing | OCR, page layout, tables, images, and annotated extraction evaluation | Benchmark extraction separately from retrieval. Keep source-page canaries so a polished answer cannot hide a missing field or page. |
| Advanced ranking | Elastic, Azure AI Search | Semantic ranking, learning-to-rank options, hybrid candidate fusion, and relevance-debugging tools | Compare with pooled private relevance judgments before adding another production search dependency. |
| Turnkey and self-hosted assistants | Open WebUI, AnythingLLM, Khoj | User interface, multi-user controls, broad model support, OCR options, agentic file browsing, incremental source sync, and exports | Keep the installer backend-focused, but match their install clarity, corpus visibility, and permission safety. |
| Obsidian-native tools | Copilot for Obsidian, Smart Connections, Khoj | Automatic vault indexing, clickable note navigation, local embeddings, and related-note discovery | Preserve Obsidian usability through MCP and links without making a desktop plugin the canonical store. |
| RAG frameworks and evaluation platforms | LlamaIndex, LangSmith, Phoenix, Ragas, DeepEval | Pipeline caching, document management, datasets, experiments, traces, human review, production feedback, and component-level evaluation | Build a small native evaluation contract and allow optional export to standard observability tools. |
| Graph and memory systems | Microsoft GraphRAG, LightRAG, Mem0 | Entity and relationship retrieval, corpus-wide synthesis, incremental graph changes, and conversational memory | Treat these as measured retrieval variants, not default architecture. |
| Vector-capable application databases | Supabase Vector | Postgres row-level security and flexible relational joins around vector search | Match the permission outcome without requiring every client to operate Supabase. |

Selected official references:

- [Cloudflare AI Search syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/),
  [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/),
  [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/), and
  [citation scoring details](https://developers.cloudflare.com/ai-search/how-to/chunk-citations/)
- [Vectara retrieval and generation](https://docs.vectara.com/docs/learn/grounded-generation/grounded-generation-overview),
  [reranking](https://docs.vectara.com/docs/search-and-retrieval/reranking), and
  [observability](https://docs.vectara.com/docs/observability)
- [Pinecone Assistant workflow and evaluation](https://docs.pinecone.io/guides/assistant/overview)
- [Amazon Bedrock RAG evaluation](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-evaluation-create-randg.html)
- [Azure AI Search relevance pipeline](https://learn.microsoft.com/en-us/azure/search/search-relevance-overview)
- [Google Document AI evaluation](https://docs.cloud.google.com/document-ai/docs/evaluate) and
  [layout parsing](https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk)
- [Elastic ranking](https://www.elastic.co/docs/solutions/search/ranking)
- [Open WebUI Knowledge](https://docs.openwebui.com/features/workspace/knowledge/)
- [AnythingLLM product and architecture](https://github.com/mintplex-labs/anything-llm)
- [Khoj sources and interfaces](https://docs.khoj.dev/features/all-features/)
- [Copilot for Obsidian vault indexing](https://github.com/logancyang/obsidian-copilot/blob/master/docs/vault-search-and-indexing.md)
- [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
- [LlamaIndex ingestion pipeline](https://docs.llamaindex.ai/en/v0.10.17/module_guides/loading/ingestion_pipeline/root.html)
- [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts),
  [Phoenix](https://arize.com/docs/phoenix/),
  [Ragas metrics](https://docs.ragas.io/en/latest/concepts/metrics/), and
  [DeepEval RAG evaluation](https://deepeval.com/guides/guides-rag-evaluation)
- [Microsoft GraphRAG query modes](https://microsoft.github.io/graphrag/query/overview/),
  [LightRAG](https://github.com/HKUDS/LightRAG), and
  [Mem0 evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation)
- [Supabase RAG permissions](https://supabase.com/docs/guides/ai/rag-with-permissions) and
  [hybrid search](https://supabase.com/docs/guides/ai/hybrid-search)

## Current differentiators

- **Client ownership:** The database, vector index, worker, and keys live in the
  client's Cloudflare account.
- **One standard architecture:** A manifest identifies the install, but worker
  code, schema, migrations, MCP runtime, and upgrade path remain shared.
- **Recoverable vector search:** D1 retains canonical chunk text. Vectorize can be
  rebuilt through the outbox instead of becoming the only copy of indexed data.
- **Hybrid retrieval:** D1 FTS5 and Vectorize provide independent keyword and
  semantic candidate lists combined by reciprocal rank fusion.
- **Lifecycle safety:** Ingestion is resumable, exclusions are enforced before
  indexing, deletion is explicit, and failed or poisoned vector work is surfaced.
- **Honest answers:** Responses carry citations and explicit coverage gaps, and
  the acceptance suite includes questions the corpus should refuse to answer.
- **Credential discipline:** Secrets are stored through platform-appropriate
  durable stores, are not written to manifests, and broad provider secrets are
  reconciled away when the manifest does not permit them.
- **Private support evidence:** Sanitized local issue events contain no document
  content, names, paths, queries, answers, URLs, logs, stacks, or credentials and
  are never uploaded automatically.

These controls are harder to see than a polished chat interface, but they are the
parts that make an install supportable, recoverable, and safe to reproduce.

## Prioritized gaps

| Priority | Gap | Required outcome |
|---|---|---|
| P0 | Evaluation depth | Separate ingestion, retrieval, generation, citation, refusal, security, latency, and cost failures. Add Precision@K, NDCG, answer correctness and completeness, claim faithfulness, citation precision and recall, refusal calibration, and slice-level reports. |
| P0 | Relevance judgments and statistics | Pool the union of top results from every compared retrieval variant, add private graded qrels and hard negatives, then calculate standard Precision, Recall, MAP and nDCG with explicit confidence methods. Repeated calls are not independent questions. |
| P0 | Corpus coverage ledger | A private report must reconcile every expected source item into indexed, skipped, refused, failed, quarantined, deleted, stale, or awaiting-vector state and give a corrective action. |
| P0 for shared installs | Permissions | Replace shared all-access credentials with authenticated users and pre-retrieval document or corpus authorization. Add negative tests proving that an unauthorized result never reaches retrieval or generation. |
| P0 | Verified recovery | Automate a canonical D1 export, protected retention, restore into a clean target, Vectorize rebuild, and post-restore evaluation. A backup is not proven until restore succeeds. |
| P0 | Executable configuration documentation | Every operational manifest field needs an implementation status, enforcing component, and test identifier. CI must reject a field that appears active but has no consuming code. |
| P1 | Query observability and feedback | Add local, privacy-controlled stage traces with configuration, filters, candidate scores, timings, model versions, and result identities. Let a user mark an answer helpful or wrong and promote a reviewed failure into the golden set. |
| P1 | Multi-turn memory evaluation | Add follow-up resolution, temporal update, correction, cross-session reasoning, abstention, and leakage cases. Single-question retrieval cannot certify a conversational brain. |
| P1 | Retrieval feature lab | Measure Cloudflare reranking, query rewriting, recency or priority boosting, diversity, thresholds, and candidate depth as named variants. Never change the default on intuition alone. |
| P1 | OCR and connector breadth | Add OCR and table or image extraction plus a standard connector contract for inventory, cursor, fetch, transform, checksum, delete, retry, quarantine, and reconciliation. Priority missing sources are live message refresh, Slack, Notion, and meeting transcripts. |
| P2 | Graph or multi-hop retrieval | Add only if chronology, relationship, or corpus-wide synthesis slices fail under well-tuned hybrid retrieval. Include incremental update and deletion tests before release. |
| P2 | Central support collection | Keep local-only support evidence as the default. A future submit flow must show exact payload bytes, require explicit consent, and use a separate write-only support credential. |

## Evaluation standard to match

The current evaluator already provides a useful deterministic core: document-level
Recall@K, MRR, unanswerable-question refusal, repeatability measurement, provenance,
baseline regression detection, and a named release profile that enforces a
60-case suite plus five cases per explicitly declared risk, domain, format, and
query-kind slice. That release profile is a structural retrieval-suite gate,
not full answer, citation, corpus-completeness, or security certification.
Extend it rather than replacing it with a judge-only score.

The current evidence-slot precision and nDCG describe how densely the top results
satisfy the case's required slots. They are not yet standard pooled-relevance
metrics because an unlisted but genuinely relevant document can receive grade
zero. Preserve those slot metrics, label them accurately, and add human-reviewed
pooled qrels for backend or retrieval-variant comparisons. See
[NIST relevance judgment pooling](https://trec.nist.gov/data/reljudge_eng.html)
and [trec_eval](https://github.com/usnistgov/trec_eval).

A complete case should record:

- the natural-language question and realistic paraphrases;
- expected source documents and required facts;
- whether the corpus can answer;
- acceptable answer boundaries and forbidden claims;
- time and freshness requirements;
- authorized corpus or role; and
- a question class such as exact lookup, paraphrase, chronology, table value,
  multi-document synthesis, conflict, recency, attribution, or unanswerable.

The report must identify the failing layer:

1. expected item absent from the coverage ledger: ingestion failure;
2. indexed item absent from top K: retrieval failure;
3. required fact retrieved but absent from the response: completeness failure;
4. unsupported response claim: faithfulness failure;
5. citation does not support its claim: provenance failure;
6. unsupported question answered confidently: refusal failure; or
7. unauthorized source appears anywhere: security failure.

Deterministic metrics are release gates. LLM judges remain advisory until their
agreement with reviewed human labels is measured. This follows the component-level
approach used by [Ragas](https://docs.ragas.io/en/latest/concepts/metrics/),
[DeepEval](https://deepeval.com/guides/guides-rag-evaluation),
[LangSmith](https://docs.langchain.com/langsmith/evaluation-concepts), and
[Phoenix](https://arize.com/docs/phoenix/cookbook/evaluation/evaluate-rag).

## Build versus benchmark

### Build into the standard installer

- corpus coverage and source reconciliation;
- private evaluation datasets, regression gates, and failure diagnosis;
- document or corpus authorization for shared installs;
- verified backup, restore, and vector rebuild;
- truthful manifest status and generated operator documentation;
- privacy-safe local traces, reviewed feedback, and support evidence; and
- a stable connector lifecycle contract.

These are product guarantees and must not depend on a vendor dashboard.

### Benchmark before building or adopting

- Cloudflare AI Search as a managed index and retrieval path;
- Cloudflare-native reranking, query rewriting, metadata boosting, and namespaces;
- graph retrieval for relationship and corpus-wide questions;
- multimodal PDF extraction and third-party OCR; and
- Phoenix or another OpenTelemetry-compatible trace viewer.

For each option, use the same private golden set, corpus snapshot, answer model,
latency measurement, and cost accounting. Adopt only after a reproducible win that
does not weaken lifecycle safety, privacy, recovery, or client ownership.

Cloudflare D1 already provides Time Travel, and Cloudflare documents automated D1
exports to R2. The installer still needs its own verified restore workflow because
normal D1 export does not support virtual tables such as FTS5 and can block database
requests while running. See [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
and [D1 import and export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
