import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GRANT_VIEWS, GrantWorkspace, OWNER_VIEWS, supportInviteFromHash, supportModeFromHash, visibleView,
} from "./App";
import type { Me } from "./lib/api";
import type { SupportPrincipal, SupportSystemStatus } from "./lib/api";
import { SupportDiagnosticsView } from "./components/SupportDiagnostics";
import { SupportGate } from "./components/SupportGate";

const grantMe: Me = {
  signed_in: true,
  brain: "Fixture Brain",
  principal: {
    kind: "grant",
    grant_id: "dg_fixture",
    entity_slug: "fixture-entity",
    document_count: 2,
    capabilities: ["documents:read", "ask"],
  },
  workspace: {
    home: false,
    documents: true,
    ask: true,
    add_review: false,
    access: false,
    bank: false,
    targets: false,
    preferences: false,
  },
};

describe("principal workspace routing", () => {
  it("keeps the full owner navigation and limits a grant to Documents and Explore", () => {
    expect(OWNER_VIEWS).toEqual(["home", "year", "documents", "ask", "review", "access"]);
    expect(GRANT_VIEWS).toEqual(["documents", "ask"]);
    for (const forbidden of ["home", "year", "review", "access"] as const) {
      expect(visibleView("grant", forbidden)).toBe("documents");
    }
    expect(visibleView("grant", "ask")).toBe("ask");
    expect(visibleView("owner", "access")).toBe("access");
  });

  it("renders no owner navigation or owner-only route in the grant shell", () => {
    const html = renderToStaticMarkup(<GrantWorkspace me={grantMe} onAccessEnded={() => undefined} />);
    expect(html).toContain("Shared documents");
    expect(html).toContain("Explore");
    expect(html).not.toContain("Home</button>");
    expect(html).not.toContain("This Year");
    expect(html).not.toContain("Add &amp; Review");
    expect(html).not.toContain("Access</button>");
    expect(html).not.toContain("Owner preferences");
    expect(html).not.toContain("Add a text record");
  });
});

describe("temporary support shell", () => {
  const expiresAt = Date.now() + 60 * 60_000;
  const supportPrincipal: SupportPrincipal = {
    kind: "support",
    support_session_id: "ss_fixture",
    technician_label: "Support technician",
    technician_identity_verified: false,
    expires_at: expiresAt,
    idle_expires_at: Date.now() + 15 * 60_000,
    read_only: true,
  };
  const supportStatus: SupportSystemStatus = {
    status: "ready",
    observed_at: Date.now(),
    unavailable: [],
    access: {
      kind: "support", technician_label: "Support technician", expires_at: expiresAt,
      remaining_seconds: 3600, read_only: true, can_fix: false,
    },
    privacy: {
      mode: "aggregate_only", content_visible: false, search_available: false,
      raw_errors_visible: false, credentials_visible: false, account_identifiers_visible: false,
    },
    brain: {
      product_version: "0.2.0", schema_version: 23, status: "active",
      accepting_documents: true, drain_mode: "cron",
    },
    corpus: { documents: 241, chunks: 2180 },
    vectors: { ready: true, expected: 2180, visible: 2180, pending: 0, percent_visible: 100 },
    problem_counts: { crit: 0, warn: 1, info: 0 },
    problems: [{ code: "source_registration_issue", area: "coverage", severity: "warn", count: 1, repairability: "guidance_only" }],
    sources: [{ kind: "email", label: "Email", state: "stale", documents: 39, days_since_ingest: 12, automatable: false }],
  };

  it("accepts only the frozen support fragment and keeps a code-less support mode", () => {
    expect(supportInviteFromHash("#support-enroll=opaque_support-code")).toBe("opaque_support-code");
    expect(supportInviteFromHash("#support=opaque")).toBeNull();
    expect(supportInviteFromHash("#x-support-enroll=opaque")).toBeNull();
    expect(supportModeFromHash("#support-enroll=opaque_support-code")).toBe(true);
    expect(supportModeFromHash("#support")).toBe(true);
    expect(supportModeFromHash("#support=opaque")).toBe(false);
  });

  it("renders only aggregate support diagnostics and no owner workspace routes", () => {
    const html = renderToStaticMarkup(<SupportDiagnosticsView principal={supportPrincipal} status={supportStatus} />);
    expect(html).toContain("Support Diagnostics");
    expect(html).toContain("241");
    expect(html).toContain("Source registration issue");
    expect(html).toContain("cannot repair anything");
    for (const forbidden of ["Home</button>", "This Year", "Documents</button>", "Explore</button>", "Add &amp; Review", "Access</button>", "Owner preferences", "Shared documents"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("explains the support-only passkey boundary before enrollment", () => {
    const html = renderToStaticMarkup(<SupportGate inviteCode="opaque" onIn={() => undefined} />);
    expect(html).toContain("Accept a support invitation");
    expect(html).toContain("No documents, email, messages, searches, answers, or credentials");
    expect(html).not.toContain("your brain is ready");
    expect(html).not.toContain("Sign in to ask your brain");
  });
});
