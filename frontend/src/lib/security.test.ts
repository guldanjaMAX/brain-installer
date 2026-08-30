import { describe, expect, it } from "vitest";
import type { Answer, GrantPrincipal, GrantedDocumentsResponse } from "./api";
import {
  GRANT_WORKSPACE, grantWorkspaceConfirmed, grantedDocumentsConfirmed, scopedRetrievalConfirmed,
} from "./security";

const principal: GrantPrincipal = {
  kind: "grant",
  grant_id: "dg_fixture",
  entity_slug: "fixture-entity",
  document_count: 2,
  capabilities: ["documents:read", "ask"],
};

describe("frozen exact-document client contract", () => {
  it("requires the complete restricted workspace allowlist", () => {
    expect(grantWorkspaceConfirmed(GRANT_WORKSPACE)).toBe(true);
    expect(grantWorkspaceConfirmed({ ...GRANT_WORKSPACE, home: true })).toBe(false);
    expect(grantWorkspaceConfirmed(undefined)).toBe(false);
  });

  it("withholds a document list whose principal or scope rule does not echo", () => {
    const response: GrantedDocumentsResponse = {
      status: "ready",
      principal: { kind: "grant", grant_id: "dg_fixture", entity_slug: "fixture-entity" },
      scope_rule: "exact_document_ids_only",
      documents: [],
    };
    expect(grantedDocumentsConfirmed(response, principal)).toBe(true);
    expect(grantedDocumentsConfirmed({ ...response, principal: { ...response.principal, grant_id: "dg_other" } }, principal)).toBe(false);
  });

  it("renders scoped retrieval only with every exact-grant echo", () => {
    const answer: Answer = {
      answer: "Cited answer",
      retrieval_scope: "exact_document_ids",
      degraded: "scoped-vector",
      degraded_reason: "document-scope-keyword-only",
      access: {
        principal: "grant",
        grant_id: "dg_fixture",
        entity_slug: "fixture-entity",
        document_count: 2,
      },
    };
    expect(scopedRetrievalConfirmed(answer, principal)).toBe(true);
    expect(scopedRetrievalConfirmed({ ...answer, retrieval_scope: "owner" }, principal)).toBe(false);
    expect(scopedRetrievalConfirmed({ ...answer, access: { ...answer.access!, document_count: 3 } }, principal)).toBe(false);
    expect(scopedRetrievalConfirmed({ ...answer, degraded_reason: undefined }, principal)).toBe(false);
  });
});
