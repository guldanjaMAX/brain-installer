import { useState } from "react";
import { api } from "../lib/api";
import { sourceLabel, dateLabel } from "../lib/words";
import { Badge, Note } from "./ui";
// The one contract that decides what an empty result is allowed to mean. Shared
// with Ask and with the MCP surfaces rather than re-derived here.
import { retrievalUnavailable, unavailableNotice } from "../lib/retrieval-status.js";

type Hit = {
  doc_uid: string; chunk_uid?: string; title: string | null; snippet: string | null;
  source: string; ts: string | null; date_reliable?: boolean;
  client?: string | null; category?: string | null;
};
type UnifiedBody = { results?: Hit[]; degraded?: string; status?: string };

/** What this brain holds, found by searching rather than browsed.
 *
 *  Search-first on purpose. A folder tree implies the brain has a filing
 *  structure the owner arranged, and it does not: it has documents from several
 *  sources with wildly different shapes. Offering a tree would be offering a
 *  map of a place that is not laid out that way.
 *
 *  Built on /api/rag/unified rather than the source-families listing, because
 *  unified returns a title, a snippet and a date — a listing a person can read —
 *  while source-families returns bare ids in lexical order. */
export function Documents() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState("");

  async function search() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const body = await api<UnifiedBody>("/api/rag/unified", { q, limit: 25 });
      // An incomplete search must never render as an absence. This is the
      // whole reason the contract is shared rather than reimplemented.
      if (retrievalUnavailable(body)) {
        setHits(null);
        setNotice(unavailableNotice(body.degraded));
      } else {
        setHits(body.results || []);
      }
      setSearched(q);
    } catch (e) {
      setHits(null);
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-[15px] font-semibold tracking-tight">What your brain holds</h2>
      <p className="mt-1.5 text-[14px] text-ink-soft leading-relaxed">
        Search everything it has read. This looks inside documents, not just at
        their names, so a word from the middle of a page will find it.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="A name, a company, a phrase you remember"
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

      {notice && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3.5">
          <p className="text-[14px] text-amber-900 leading-relaxed">{notice}</p>
        </div>
      )}

      {hits !== null && (
        <div className="mt-5">
          <p className="text-[13px] text-ink-soft">
            {hits.length === 0
              ? `Nothing matched "${searched}". Your brain searched what it holds and found no match, which is different from not having looked.`
              : `${hits.length} result${hits.length === 1 ? "" : "s"} for "${searched}"`}
          </p>

          <div className="mt-3 bg-card border border-line rounded-2xl overflow-hidden">
            {hits.map((hit) => (
              <article
                key={hit.chunk_uid || hit.doc_uid}
                className="px-4 py-4 border-b border-line last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <h3 className="text-[14.5px] font-medium min-w-0">
                    {hit.title || "Untitled document"}
                  </h3>
                  <Badge tone="muted">{sourceLabel(hit.source)}</Badge>
                </div>
                {hit.snippet && (
                  <p className="mt-1.5 text-[13.5px] text-ink-soft leading-relaxed">
                    {hit.snippet.slice(0, 260)}
                    {hit.snippet.length > 260 ? "…" : ""}
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
          <Note>
            Search above to see what your brain has read. There is no folder tree
            here on purpose: your documents come from several places and were
            never filed into one structure, so a tree would be a map of somewhere
            that does not exist.
          </Note>
        </div>
      )}
    </div>
  );
}
