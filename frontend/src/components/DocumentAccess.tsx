import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, api, ownerError, type DocumentAccessStatus, type DocumentGrantReceipt,
  type EntityScopeEcho,
} from "../lib/api";
import { entityLabel } from "../lib/finance";
import { sourceLabel } from "../lib/words";
import { retrievalUnavailable, unavailableNotice } from "../lib/retrieval-status.js";
import { Attention, Badge, Confirm, Empty, Note, Row, Section, TruthNote, ago } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { useActionRequests } from "./useActionRequests";

type SearchHit = {
  doc_uid?: string;
  title?: string | null;
  source?: string;
  ts?: string | null;
};
type SearchResponse = {
  results?: SearchHit[];
  status?: string;
  degraded?: string;
  entity_scope?: EntityScopeEcho;
  filter_not_applied?: boolean;
};

export function DocumentAccess() {
  const { scope, activeLabel, entities } = useFinanceScope();
  const [status, setStatus] = useState<DocumentAccessStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invite, setInvite] = useState<DocumentGrantReceipt | null>(null);
  const requests = useActionRequests("document_access");

  const load = useCallback(async () => {
    setStatusError(null);
    try {
      const next = await api<DocumentAccessStatus>("/api/app/document-access/status", {});
      if (next.status !== "ready" || next.scope_rule !== "exact_document_ids_only" || next.default_access !== "owner_only" || !Array.isArray(next.grants)) {
        throw new Error("Document access status did not return the enforced exact-document policy.");
      }
      setStatus(next);
    } catch (next) {
      setStatus(null);
      setStatusError(ownerError(next).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setHits(null);
    setSelected([]);
    setMessage(null);
    setActionError(null);
    setInvite(null);
  }, [scope]);

  async function search() {
    const q = query.trim();
    if (!q || !scope || searching) return;
    setSearching(true);
    setActionError(null);
    setMessage(null);
    try {
      const body = await api<SearchResponse>("/api/rag/unified", { q, limit: 25, entity_slug: scope });
      if (retrievalUnavailable(body)) {
        setHits(null);
        setActionError(unavailableNotice(body.degraded));
      } else if (body.filter_not_applied || body.entity_scope?.applied !== true || body.entity_scope.entity_slug !== scope) {
        setHits(null);
        setActionError(`The brain could not prove this search was narrowed to ${activeLabel}. No documents are available to select.`);
      } else {
        const byDocument = new Map<string, SearchHit>();
        for (const hit of body.results || []) {
          if (hit.doc_uid && !byDocument.has(hit.doc_uid)) byDocument.set(hit.doc_uid, hit);
        }
        setHits([...byDocument.values()]);
      }
    } catch (next) {
      setHits(null);
      setActionError(ownerError(next).message);
    } finally {
      setSearching(false);
    }
  }

  function toggle(documentId: string) {
    setSelected((current) => current.includes(documentId)
      ? current.filter((item) => item !== documentId)
      : [...current, documentId]);
    setInvite(null);
    setMessage(null);
  }

  async function create() {
    const label = subject.trim();
    if (!scope || !label || selected.length === 0 || busy) return;
    const documents = [...selected].sort();
    const actionKey = `create:${scope}:${label}:${documents.join("|")}`;
    const requestId = requests.forAction(actionKey);
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/create", {
        request_id: requestId,
        subject_label: label,
        entity_slug: scope,
        document_ids: documents,
      });
      if (receipt.status !== "active" || receipt.scope_rule !== "exact_document_ids_only"
        || receipt.entity_slug !== scope || receipt.subject_label !== label
        || !sameIds(receipt.document_ids, documents) || typeof receipt.replayed !== "boolean"
        || receipt.invite_state !== "active" || !receipt.enrollment_url) {
        throw new Error("The brain did not return a confirmed exact-document access receipt. No access link is being presented.");
      }
      requests.confirmed(actionKey);
      setInvite(receipt);
      setMessage(receipt.replayed
        ? "This exact access request was already created. The same active receipt was returned without a second grant."
        : "Exact document access was created. Copy the private enrollment link before it expires.");
      await load();
    } catch (next) {
      setActionError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  async function reissue(grantId: string) {
    const actionKey = `reissue:${grantId}`;
    const requestId = requests.forAction(actionKey);
    await runAction(async () => {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/reissue", { request_id: requestId, grant_id: grantId });
      if (receipt.status !== "active" || receipt.grant_id !== grantId || receipt.invite_state !== "active"
        || !receipt.enrollment_url || typeof receipt.replayed !== "boolean") {
        throw new Error("The brain did not confirm a new active enrollment link.");
      }
      requests.confirmed(actionKey);
      setInvite(receipt);
      setMessage(receipt.replayed
        ? "The same reissue receipt was returned. No additional enrollment link was created."
        : "The earlier unused link is no longer usable. Copy the newly issued private link before it expires.");
    });
  }

  async function revoke(grantId: string) {
    const actionKey = `revoke:${grantId}`;
    const requestId = requests.forAction(actionKey);
    await runAction(async () => {
      const receipt = await api<DocumentGrantReceipt>("/api/app/document-access/revoke", { request_id: requestId, grant_id: grantId });
      if (receipt.status !== "revoked" || receipt.grant_id !== grantId
        || typeof receipt.changed !== "boolean" || typeof receipt.replayed !== "boolean") {
        throw new Error("The brain did not return a confirmed revocation receipt.");
      }
      requests.confirmed(actionKey);
      setInvite(null);
      setMessage(receipt.changed
        ? "Document access was revoked. Its passkey session can no longer read or ask."
        : "The brain confirmed this document access was already revoked.");
      await load();
    });
  }

  async function runAction(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try { await work(); }
    catch (next) { setActionError(ownerError(next).message); }
    finally { setBusy(false); }
  }

  async function copyInvite() {
    if (!invite?.enrollment_url) return;
    try {
      await navigator.clipboard.writeText(invite.enrollment_url);
      setMessage("Private enrollment link copied. Send it only to the intended person before it expires.");
    } catch {
      setActionError("The browser could not copy the private link. Reissue it from a browser that permits clipboard access.");
    }
  }

  const activeGrants = useMemo(() => status?.grants || [], [status]);
  return (
    <Section
      title="Shared document access"
      blurb="Create and revoke access to exact documents. A business selection narrows discovery, but it never grants the whole business."
    >
      <div className="p-4 border-b border-line"><FinanceScopeBar /></div>
      <div className="p-4 border-b border-line">
        <TruthNote>Documents are owner-only by default. Every grant is an immutable exact-document allowlist enforced by the brain.</TruthNote>
        {!scope && <Attention>Select one business before finding documents to share.</Attention>}
        <label className="block text-[12.5px] text-ink-soft">Who is this for?
          <input className="field mt-1" value={subject} maxLength={120} onChange={(event) => { setSubject(event.target.value); setInvite(null); }} placeholder="Accountant, attorney, reviewer" />
        </label>
        <div className="mt-3 flex gap-2">
          <input
            className="field flex-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void search()}
            placeholder="Find evidence to share"
            aria-label="Find evidence to share"
            disabled={!scope || searching}
          />
          <button className="rounded-xl bg-accent px-4 text-white text-[13.5px] disabled:opacity-45" onClick={search} disabled={!scope || !query.trim() || searching}>
            {searching ? "Looking" : "Find"}
          </button>
        </div>
        {hits?.length === 0 && <p className="mt-3 text-[13px] text-ink-soft">No matching document was returned. Search did complete, but that does not prove the document does not exist.</p>}
        {!!hits?.length && (
          <div className="mt-3 border border-line rounded-xl overflow-hidden">
            {hits.map((hit) => (
              <label key={hit.doc_uid} className="px-3 py-3 border-b border-line last:border-0 flex gap-3 items-start cursor-pointer">
                <input type="checkbox" className="mt-1" checked={selected.includes(hit.doc_uid!)} onChange={() => toggle(hit.doc_uid!)} />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">{hit.title || "Untitled document"}</span>
                  <span className="block text-[12.5px] text-ink-soft">{sourceLabel(hit.source || "unknown")}{hit.ts ? ` · ${String(hit.ts).slice(0, 10)}` : ""}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {selected.length > 0 && <p className="mt-3 text-[13px] text-ink-soft">{selected.length} exact {selected.length === 1 ? "document" : "documents"} selected.</p>}
        {actionError && <div className="mt-3"><Attention>{actionError}</Attention></div>}
        {message && <div className="mt-3"><Note>{message}</Note></div>}
        {invite?.enrollment_url && invite.invite_state === "active" && (
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <button className="rounded-xl bg-accent px-4 py-2.5 text-white text-[13.5px]" onClick={copyInvite}>Copy private enrollment link</button>
            <span className="text-[12.5px] text-ink-soft">{inviteExpiry(invite.enrollment_expires_at)} The link itself is hidden from the page.</span>
          </div>
        )}
        <button
          className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-white text-[13.5px] disabled:opacity-45"
          onClick={create}
          disabled={busy || !scope || !subject.trim() || selected.length === 0 || selected.length > 100}
        >
          {busy ? "Saving" : "Create exact document access"}
        </button>
      </div>
      {statusError && <Attention>{statusError}</Attention>}
      {!status && !statusError && <Empty>Reading document access status.</Empty>}
      {status && activeGrants.length === 0 && <Empty>No document access has been created.</Empty>}
      {activeGrants.map((grant) => (
        <Row key={grant.grant_id}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap text-[14.5px] font-medium">
              {grant.subject_label}
              <Badge tone={grant.state === "active" ? "accent" : "muted"}>{grant.state}</Badge>
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {grant.documents.filter((document) => !document.revoked_at).length} exact {grant.documents.filter((document) => !document.revoked_at).length === 1 ? "document" : "documents"} · {entityLabel(entities, grant.entity_slug)} · created {ago(grant.created_at)}
            </span>
          </span>
          {grant.state === "active" && (
            <span className="flex items-center gap-2">
              <button disabled={busy} className="text-[13px] text-accent px-2 py-1 disabled:opacity-50" onClick={() => reissue(grant.grant_id)}>New link</button>
              <Confirm label="Revoke" question="Revoke this exact access?" disabled={busy} onConfirm={() => revoke(grant.grant_id)} />
            </span>
          )}
        </Row>
      ))}
    </Section>
  );
}

function sameIds(actual: string[] | undefined, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((item, index) => item === expected[index]);
}

function inviteExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return "This link expires soon.";
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  return minutes > 0 ? `This link expires in about ${minutes} minutes.` : "This link has reached its expiry time.";
}
