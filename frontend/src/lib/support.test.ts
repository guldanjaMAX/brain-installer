import { describe, expect, it, vi } from "vitest";
import type {
  SupportAccessReceipt, SupportAccessStatus, SupportMe, SupportPrincipal, SupportSystemStatus,
} from "./api";
import {
  DEFAULT_SUPPORT_DURATION, SUPPORT_DURATION_CHOICES, SUPPORT_WORKSPACE,
  supportCreateReceiptConfirmed, supportMeConfirmed, supportRevokeReceiptConfirmed,
  supportStatusConfirmed, supportSystemConfirmed, supportWorkspaceConfirmed,
} from "./support";
import { supportApi } from "./api";

const future = () => Date.now() + 60 * 60_000;
const principal = (): SupportPrincipal => ({
  kind: "support",
  support_session_id: "ss_fixture",
  technician_label: "Invited technician",
  technician_identity_verified: false,
  expires_at: future(),
  idle_expires_at: Date.now() + 15 * 60_000,
  read_only: true,
});

describe("temporary support boundary", () => {
  it("uses only the dedicated support companion header", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await supportApi("/api/support/me", {});
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.headers).toEqual({ "Content-Type": "application/json", "X-Brain-Support": "1" });
      expect(init?.headers).not.toHaveProperty("X-Brain-App");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts only a bounded numeric Retry-After for support throttling", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: "rate_limited", code: "support_system_rate_limited",
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "15" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(supportApi("/api/support/system", {})).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: 15,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts only the support-only workspace", () => {
    expect(supportWorkspaceConfirmed(SUPPORT_WORKSPACE)).toBe(true);
    expect(supportWorkspaceConfirmed({ ...SUPPORT_WORKSPACE, documents: true })).toBe(false);
    expect(supportWorkspaceConfirmed({ ...SUPPORT_WORKSPACE, access: true })).toBe(false);
  });

  it("requires a live support principal and exact restricted workspace", () => {
    const body: SupportMe = {
      signed_in: true, principal: principal(), workspace: SUPPORT_WORKSPACE,
      can_fix: false, repair_mode: "owner_approval_required_future",
    };
    expect(supportMeConfirmed(body)).toBe(true);
    expect(supportMeConfirmed({ ...body, principal: { ...body.principal, expires_at: Date.now() - 1 } })).toBe(false);
    expect(supportMeConfirmed({ ...body, owner: "must never render" } as SupportMe)).toBe(false);
  });

  it("freezes the short read-only duration policy", () => {
    expect(SUPPORT_DURATION_CHOICES).toEqual([15, 30, 60, 120]);
    expect(DEFAULT_SUPPORT_DURATION).toBe(30);
    const body: SupportAccessStatus = {
      status: "ready",
      sessions: [{
        support_session_id: "ss_pending",
        technician_label: "Invited technician",
        state: "pending",
        authentication_state: null,
        created_at: Date.now(),
        invite_state: "active",
        enrollment_expires_at: Date.now() + 10 * 60_000,
        activated_at: null,
        expires_at: null,
        idle_expires_at: null,
        last_used_at: null,
        revoked_at: null,
      }],
      policy: {
        access: "read_only_diagnostics",
        duration_choices_minutes: [15, 30, 60, 120],
        default_duration_minutes: 30,
        max_duration_minutes: 120,
        enrollment_link_max_minutes: 10,
        can_fix: false,
        repair_mode: "owner_approval_required_future",
      },
    };
    expect(supportStatusConfirmed(body)).toBe(true);
    expect(supportStatusConfirmed({ ...body, policy: { ...body.policy, max_duration_minutes: 240 as 120 } })).toBe(false);
    expect(supportStatusConfirmed({ ...body, sessions: [{ ...body.sessions[0], expires_at: future() }] })).toBe(false);

    const active: SupportAccessStatus = {
      ...body,
      sessions: [{
        support_session_id: "ss_active",
        technician_label: "Invited technician",
        state: "active",
        authentication_state: "reauthentication_required",
        created_at: Date.now() - 20 * 60_000,
        invite_state: "consumed",
        enrollment_expires_at: Date.now() - 15 * 60_000,
        activated_at: Date.now() - 15 * 60_000,
        expires_at: future(),
        idle_expires_at: Date.now() - 5 * 60_000,
        last_used_at: Date.now() - 15 * 60_000,
        revoked_at: null,
      }],
    };
    expect(supportStatusConfirmed(active)).toBe(true);
    expect(supportStatusConfirmed({
      ...active,
      sessions: [{ ...active.sessions[0], authentication_state: "authenticated" }],
    })).toBe(false);
  });

  it("presents a link only from a confirmed pending receipt", () => {
    const receipt: SupportAccessReceipt = {
      status: "pending",
      support_session_id: "ss_pending",
      technician_label: "Invited technician",
      activated_at: null,
      expires_at: null,
      idle_expires_at: null,
      changed: true,
      replayed: false,
      request_id: "support_request",
      invite_state: "active",
      enrollment_url: "https://brain.example.test/app#support-enroll=opaque",
      enrollment_expires_at: Date.now() + 10 * 60_000,
    };
    expect(supportCreateReceiptConfirmed(receipt, "support_request", "Invited technician")).toBe(true);
    expect(supportCreateReceiptConfirmed({ ...receipt, status: "active" }, "support_request", "Invited technician")).toBe(false);
    expect(supportCreateReceiptConfirmed({ ...receipt, invite_state: "consumed" }, "support_request", "Invited technician")).toBe(false);
    expect(supportCreateReceiptConfirmed({ ...receipt, enrollment_url: null }, "support_request", "Invited technician")).toBe(false);
  });

  it("requires an exact revocation receipt", () => {
    const receipt: SupportAccessReceipt = {
      status: "revoked",
      support_session_id: "ss_active",
      revoked_at: Date.now(),
      changed: true,
      replayed: false,
      request_id: "support_revoke",
    };
    expect(supportRevokeReceiptConfirmed(receipt, "support_revoke", "ss_active")).toBe(true);
    expect(supportRevokeReceiptConfirmed({ ...receipt, support_session_id: "ss_other" }, "support_revoke", "ss_active")).toBe(false);
  });

  it("accepts aggregate diagnostics only when privacy and access echoes are exact", () => {
    const who = principal();
    const body: SupportSystemStatus = {
      status: "ready",
      observed_at: Date.now(),
      unavailable: [],
      access: {
        kind: "support", technician_label: who.technician_label, expires_at: who.expires_at,
        remaining_seconds: 900, read_only: true, can_fix: false,
      },
      privacy: {
        mode: "aggregate_only", content_visible: false, search_available: false,
        raw_errors_visible: false, credentials_visible: false, account_identifiers_visible: false,
      },
      brain: {
        product_version: "0.2.0", schema_version: 23, status: "ok",
        accepting_documents: true, drain_mode: "active",
      },
    };
    expect(supportSystemConfirmed(body, who)).toBe(true);
    expect(supportSystemConfirmed({ ...body, privacy: { ...body.privacy, content_visible: true as false } }, who)).toBe(false);
    expect(supportSystemConfirmed({ ...body, access: { ...body.access, can_fix: true as false } }, who)).toBe(false);
    expect(supportSystemConfirmed({ ...body, document_titles: ["must never render"] } as SupportSystemStatus, who)).toBe(false);
    expect(supportSystemConfirmed({ ...body, problems: [{
      code: "source_registration_issue", area: "coverage", severity: "warn", count: 1,
      repairability: "guidance_only", raw_error: "must never render",
    }] } as SupportSystemStatus, who)).toBe(false);
    expect(supportSystemConfirmed({ ...body, problems: [{
      code: "raw_database_message", area: "diagnostics", severity: "warn", count: 1,
      repairability: "guidance_only",
    }] } as SupportSystemStatus, who)).toBe(false);
    expect(supportSystemConfirmed({ ...body, sources: [{
      kind: "other", label: "owner@example.com", state: "unknown", documents: 1,
      days_since_ingest: null, automatable: false,
    }] } as SupportSystemStatus, who)).toBe(false);
  });
});
