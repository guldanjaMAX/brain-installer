import { useEffect, useMemo, useState } from "react";
import { api, type EntityScopeEcho, type FinDocumentsResponse } from "../lib/api";
import {
  dateLabel as financialDateLabel, documentDetail, documentOutcome, entityLabel,
} from "../lib/finance";
import { sourceLabel, dateLabel } from "../lib/words";
import { Attention, Badge, Chip, NextStep, Note, Row, TruthNote } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { retrievalUnavailable, unavailableNotice } from "../lib/retrieval-status.js";

type Hit = {
  doc_uid: string; chunk_uid?: string; title: string | null; snippet: string | null;
  source: string; ts: string | null; date_reliable?: boolean;
  client?: string | null; category?: string | null;
};
type UnifiedBody = { results?: Hit[]; degraded?: string; degraded_reason?: string; status?: string; entity_scope?: EntityScopeEcho; filter_not_applied?: boolean };
type Mode = "register" | "evidence";
type RegisterFilter = "all" | "attention" | "current" | "filed";

/** Financial document custody plus evidence search.
 *
 * The register answers whether a known record is present, readable, filed, or
 * reconciled. Evidence search answers what the text inside all documents says.
 * Keeping the two modes distinct prevents a search hit from being mistaken for
 * proof that a required statement set is complete. */
export function Documents() {
  const [mode, setMode] = useState<Mode>("register");
  return (
    <div>
      <FinanceScopeBar />
      <header className="max-w-2xl">
        <p className="eyebrow">Evidence and custody</p>
        <h1 className="page-title">Documents</h1>
        <p className="page-intro">
          Check which financial records are present and readable, or search evidence inside the selected business or your whole brain.
        </p>
      </header>
      <div className="mt-5 inline-flex rounded-xl bg-card border border-line p-1" role="tablist" aria-label="Document view">
        <ModeButton active={mode === "register"} onClick={() => setMode("register")}>Record register</ModeButton>
        <ModeButton active={mode === "evidence"} onClick={() => setMode("evidence")}>Search evidence</ModeButton>
      </div>
      {mode === "register" ? <DocumentRegister /> : <EvidenceSearch />}
    </div>
  );
}

function ModeButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-3.5 py-2 rounded-lg text-[13.5px] ${active ? "bg-accent-soft text-accent font-medium" : "text-ink-soft hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

function DocumentRegister() {
  const { scope, entities, activeLabel } = useFinanceScope();
  const [body, setBody] = useState<FinDocumentsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RegisterFilter>("all");

  useEffect(() => {
    let current = true;
    setBusy(true);
    setLoaded(false);
    setBody(null);
    setError(null);
    api<FinDocumentsResponse>("/api/fin/documents", {
      limit: 500,
      ...(scope ? { entity_slug: scope } : {}),
    }).then((next) => {
      if (!current) return;
      setBody(next);
      setLoaded(true);
    }).catch(() => {
      if (!current) return;
      setBody(null);
      setError("The financial document register could not be reached. Nothing here is being presented as absent.");
      setLoaded(true);
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [scope]);

  const documents = body?.documents;
  const rows = useMemo(() => {
    if (!documents) return [];
    const q = query.trim().toLocaleLowerCase();
    return documents.filter((document) => {
      const outcome = documentOutcome(document);
      const matchesFilter = filter === "all"
        || (filter === "attention" && (outcome === "NEEDS" || outcome === "PROBLEM" || outcome === "WORKING"))
        || (filter === "current" && outcome === "CURRENT")
        || (filter === "filed" && outcome === "FILED");
      if (!matchesFilter) return false;
      if (!q) return true;
      return [document.title, humanize(document.doc_kind), entityLabel(entities, document.entity_slug), document.tax_year]
        .some((value) => String(value || "").toLocaleLowerCase().includes(q));
    });
  }, [documents, entities, filter, query]);

  const attentionCount = documents?.filter((document) => {
    const outcome = documentOutcome(document);
    return outcome === "NEEDS" || outcome === "PROBLEM" || outcome === "WORKING";
  }).length || 0;

  return (
    <section className="mt-6" aria-busy={busy}>
      {!loaded && <p className="sr-only">Reading the financial document register.</p>}
      {error && <div className="max-w-3xl"><Attention>{error}</Attention></div>}
      {body && !body.ledger_installed && (
        <div className="max-w-3xl">
          <TruthNote>
            No financial ledger is available yet. This is different from a document register with nothing in it.
          </TruthNote>
        </div>
      )}
      {body?.ledger_installed && !("documents" in body) && (
        <div className="max-w-3xl">
          <Attention>The financial document register was unavailable, so it is omitted rather than shown as empty.</Attention>
        </div>
      )}
      {Array.isArray(documents) && (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight">Financial record register</h2>
              <p className="mt-1 text-[13.5px] text-ink-soft">
                {documents.length} known {documents.length === 1 ? "record" : "records"} for {activeLabel}. {attentionCount} need attention or are still being processed.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a financial record"
                aria-label="Find a financial record"
                className="w-full sm:w-56 text-[13.5px] px-3.5 py-2.5 rounded-xl border border-line bg-card outline-none focus:border-accent"
              />
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as RegisterFilter)}
                aria-label="Filter financial records"
                className="text-[13.5px] px-3.5 py-2.5 rounded-xl border border-line bg-card outline-none focus:border-accent"
              >
                <option value="all">Every state</option>
                <option value="attention">Needs attention</option>
                <option value="current">Current</option>
                <option value="filed">Filed</option>
              </select>
            </div>
          </div>

          {body?.truncated && (
            <div className="mt-4 max-w-3xl">
              <Attention>The register is larger than this page can show. Counts and filters below cover only the records returned in this read.</Attention>
            </div>
          )}

          {documents.some((document) => document.restricted) && (
            <div className="mt-4 max-w-3xl">
              <TruthNote>
                Some records carry a restriction note. Exact-document grants are enforced separately in Access; this register note does not create or remove permission.
              </TruthNote>
            </div>
          )}

          <div className="mt-4 bg-card border border-line rounded-2xl overflow-hidden">
            {documents.length === 0 ? (
              <Note>
                No financial document is recorded for {activeLabel}. That is an empty register, not proof that no records exist.
              </Note>
            ) : rows.length === 0 ? (
              <Note>No record in the returned register matches these filters.</Note>
            ) : rows.map((document) => (
              <Row key={document.fin_doc_uid}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14.5px] font-medium">{document.title}</span>
                    {document.restricted && <Badge tone="muted">Restriction noted</Badge>}
                  </span>
                  <span className="block text-[13px] text-ink-soft mt-0.5">
                    {entityLabel(entities, document.entity_slug)} · {humanize(document.doc_kind)}
                    {document.tax_year && ` · ${document.tax_year}`}
                    {document.period_end && ` · through ${financialDateLabel(document.period_end) || "an unreadable date"}`}
                  </span>
                  <NextStep>
                    {documentDetail(document)}
                    {document.received_from && ` Received from ${document.received_from}.`}
                  </NextStep>
                </span>
                <Chip state={documentOutcome(document)} />
              </Row>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EvidenceSearch() {
  const { scope, activeLabel } = useFinanceScope();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState("");
  const [searchedScope, setSearchedScope] = useState("");

  async function search() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const body = await api<UnifiedBody>("/api/rag/unified", {
        q,
        limit: 25,
        ...(scope ? { entity_slug: scope } : {}),
      });
      if (retrievalUnavailable(body)) {
        setHits(null);
        setNotice(unavailableNotice(body.degraded));
      } else if (scope && (body.filter_not_applied || body.entity_scope?.applied !== true || body.entity_scope.entity_slug !== scope)) {
        setHits(null);
        setNotice(`The brain could not prove that this search was narrowed to ${activeLabel}. No whole-brain results are being shown as business-scoped.`);
      } else {
        setHits(body.results || []);
        setSearchedScope(scope ? `${activeLabel} only` : "whole brain · all evidence");
        if (scope && body.degraded === "vector" && body.degraded_reason === "entity-vector-authority-unindexed") {
          setNotice(`Exact business filtering was applied for ${activeLabel}, but meaning-based business search is still being indexed. These keyword results may miss differently phrased evidence.`);
        }
      }
      setSearched(q);
    } catch {
      setHits(null);
      setNotice("Evidence search could not be reached. That is not a search with no matches.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 max-w-3xl">
      <h2 className="text-[15px] font-semibold tracking-tight">Search what your brain has read</h2>
      <p className="mt-1.5 text-[14px] text-ink-soft leading-relaxed">
        This looks inside documents, not just at their names, so a phrase from the middle of a page can find it.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && search()}
          placeholder="A name, a company, a phrase you remember"
          aria-label="Search document evidence"
          className="flex-1 min-w-0 text-[15px] px-4 py-3 rounded-xl border border-line bg-card outline-none focus:border-accent"
        />
        <button
          onClick={search}
          disabled={busy || !query.trim()}
          className="text-[14.5px] font-medium px-5 py-3 rounded-xl bg-accent text-white disabled:opacity-40 shrink-0"
        >
          {busy ? "Looking" : "Search"}
        </button>
      </div>

      {notice && <div className="mt-4"><Attention>{notice}</Attention></div>}

      {hits !== null && (
        <div className="mt-5">
          <p className="text-[13px] text-ink-soft">
            {hits.length === 0
              ? `Nothing matched "${searched}" in the selected evidence scope. Search completed, which is different from not having looked.`
              : `${hits.length} result${hits.length === 1 ? "" : "s"} for "${searched}"`}
            {` · ${searchedScope}`}
          </p>
          <div className="mt-3 bg-card border border-line rounded-2xl overflow-hidden">
            {hits.map((hit) => (
              <article key={hit.chunk_uid || hit.doc_uid} className="px-4 py-4 border-b border-line last:border-b-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <h3 className="text-[14.5px] font-medium min-w-0">{hit.title || "Untitled document"}</h3>
                  <Badge tone="muted">{sourceLabel(hit.source)}</Badge>
                </div>
                {hit.snippet && (
                  <p className="mt-1.5 text-[13.5px] text-ink-soft leading-relaxed">
                    {hit.snippet.slice(0, 260)}{hit.snippet.length > 260 ? "…" : ""}
                  </p>
                )}
                <p className="mt-1.5 text-[12.5px] text-ink-soft">
                  {dateLabel(hit.ts, hit.date_reliable) || "no date on this one"}
                  {hit.client && ` · ${hit.client}`}
                </p>
              </article>
            ))}
          </div>
        </div>
      )}

      {hits === null && !notice && (
        <div className="mt-5">
          <Note>Search above to see the evidence inside what your brain has read.</Note>
        </div>
      )}
    </section>
  );
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
