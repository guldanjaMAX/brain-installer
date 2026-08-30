import { useEffect, useState } from "react";
import {
  ApiError, api, type GrantPrincipal, type GrantedDocument, type GrantedDocumentsResponse,
} from "../lib/api";
import { grantedDocumentsConfirmed } from "../lib/security";
import { sourceLabel } from "../lib/words";
import { Attention, Badge, Empty, NextStep, Row, Section, TruthNote } from "./ui";

export function ScopedDocuments({ principal, onAccessEnded }: {
  principal: GrantPrincipal;
  onAccessEnded: () => void;
}) {
  const [documents, setDocuments] = useState<GrantedDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setDocuments(null);
    setError(null);
    api<GrantedDocumentsResponse>("/api/app/document-access/documents", {})
      .then((body) => {
        if (!current) return;
        if (!grantedDocumentsConfirmed(body, principal)) {
          setError("The brain could not prove that this list belongs to the current document grant. No documents are being shown.");
          return;
        }
        setDocuments(body.documents);
      })
      .catch((next) => {
        if (!current) return;
        if (next instanceof ApiError && next.status === 403) {
          setError(typeof next.body.recovery === "string"
            ? next.body.recovery
            : "This document access is no longer active. Ask the owner for a new link.");
          onAccessEnded();
          return;
        }
        setError(next instanceof ApiError && next.status === 503
          ? "The shared document list is unavailable right now. Nothing is being presented as absent."
          : "The shared document list could not be read. Nothing is being presented as absent.");
      });
    return () => { current = false; };
  }, [onAccessEnded, principal]);

  return (
    <div>
      <header className="max-w-2xl">
        <p className="eyebrow">Exact document access</p>
        <h1 className="page-title">Shared documents</h1>
        <p className="page-intro">
          These are the exact documents the owner shared with this passkey. Other records, businesses, owner controls, and financial screens stay outside this workspace.
        </p>
      </header>
      <div className="mt-5 max-w-3xl">
        <TruthNote>
          Access is owner-only by default. This workspace does not turn a business label into access to every document for that business.
        </TruthNote>
        {error && <Attention>{error}</Attention>}
      </div>
      <Section
        title="Documents in this access"
        blurb={documents ? `${documents.length} exact ${documents.length === 1 ? "document is" : "documents are"} available to this passkey.` : "Reading the exact document allowlist."}
      >
        {documents === null && !error && <Empty>Reading shared documents.</Empty>}
        {documents?.length === 0 && <Empty>No document was returned. That is not permission to browse anything else.</Empty>}
        {documents?.map((document) => (
          <Row key={document.document_id}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-[14.5px] font-medium">{document.title || "Untitled document"}</span>
                <Badge tone="muted">{sourceLabel(document.source)}</Badge>
              </span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {documentDate(document)}
              </span>
              {(!document.text_reliable || document.text_source !== "native") && (
                <NextStep>
                  {document.text_reliable
                    ? `Text came from ${humanize(document.text_source)}.`
                    : `Text from ${humanize(document.text_source)} may be incomplete or unreadable.`}
                </NextStep>
              )}
            </span>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function documentDate(document: GrantedDocument): string {
  if (!document.document_date) return "No document date was returned.";
  const raw = document.document_date < 10_000_000_000 ? document.document_date * 1000 : document.document_date;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "The document date could not be read.";
  const label = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return document.date_reliable
    ? `Dated ${label}`
    : `Possible date ${label}; the source did not confirm it`;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}
