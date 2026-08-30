import type {
  Answer, GrantPrincipal, GrantedDocumentsResponse, WorkspaceAllowlist,
} from "./api";

export const GRANT_WORKSPACE: WorkspaceAllowlist = {
  home: false,
  documents: true,
  ask: true,
  add_review: false,
  access: false,
  bank: false,
  targets: false,
  preferences: false,
};

export function grantWorkspaceConfirmed(workspace: WorkspaceAllowlist | undefined): boolean {
  if (!workspace) return false;
  return (Object.keys(GRANT_WORKSPACE) as Array<keyof WorkspaceAllowlist>)
    .every((key) => workspace[key] === GRANT_WORKSPACE[key]);
}

export function grantedDocumentsConfirmed(
  body: GrantedDocumentsResponse,
  principal: GrantPrincipal,
): boolean {
  return body.status === "ready"
    && body.scope_rule === "exact_document_ids_only"
    && body.principal?.kind === "grant"
    && body.principal.grant_id === principal.grant_id
    && body.principal.entity_slug === principal.entity_slug
    && Array.isArray(body.documents);
}

/** A scoped answer is rendered only when the server proves the exact grant
 * made it all the way through retrieval. The degraded vector signal is
 * expected here: keyword search is the only scoped retrieval mode. */
export function scopedRetrievalConfirmed(body: Answer, principal: GrantPrincipal): boolean {
  return body.retrieval_scope === "exact_document_ids"
    && body.degraded === "scoped-vector"
    && body.degraded_reason === "document-scope-keyword-only"
    && body.access?.principal === "grant"
    && body.access.grant_id === principal.grant_id
    && body.access.entity_slug === principal.entity_slug
    && body.access.document_count === principal.document_count;
}

export function humanSecurityCode(value: string | null | undefined): string {
  if (!value) return "No reason code";
  return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
