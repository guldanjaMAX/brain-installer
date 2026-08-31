import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OWNER_VIEWS, PRIMARY_OWNER_NAV, supportInviteFromHash, supportModeFromHash, visibleView,
} from "./App";
import type { SupportPrincipal, SupportSystemStatus } from "./lib/api";
import { SupportDiagnosticsView } from "./components/SupportDiagnostics";
import { SupportGate } from "./components/SupportGate";

describe("owner workspace routing", () => {
  it("keeps Ask as an internal destination without putting it in primary navigation", () => {
    expect(OWNER_VIEWS).toEqual(["home", "year", "documents", "ask", "access"]);
    expect(visibleView("ask")).toBe("ask");
    expect(visibleView("access")).toBe("access");
  });

  it("keeps Ask and Add & Review out of the primary menu", () => {
    expect(PRIMARY_OWNER_NAV).toEqual([
      { view: "home", label: "Home" },
      { view: "year", label: "This Year" },
      { view: "documents", label: "Documents" },
      { view: "access", label: "Manage" },
    ]);
    expect(PRIMARY_OWNER_NAV.map((item) => item.label)).not.toContain("Ask");
    expect(PRIMARY_OWNER_NAV.map((item) => item.label)).not.toContain("Add & Review");
  });

  it("falls back to Home for anything outside the owner-only view set", () => {
    expect(visibleView("home")).toBe("home");
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
