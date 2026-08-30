import { describe, expect, it } from "vitest";
import { ApiError, ownerError, type OwnerUploadCapabilities } from "./api";
import {
  activityEventsInWindow, confirmedOwnerWrite, defaultEntityScope, ingestionReceiptAction, logicalDocumentId, majorToMinor, readOwnerTextFile, readOwnerUploadFile,
  periodClosePresentation, scopedAnswerLabel, validateOwnerUpload,
  activitySentence,
} from "./owner";

const capabilities: OwnerUploadCapabilities = {
  supported_media_types: ["text/plain", "text/markdown", "application/pdf"],
  text_media_types: ["text/plain", "text/markdown"],
  binary_media_types: ["application/pdf"],
  supported_extensions: [".txt", ".md", ".markdown", ".pdf"],
  media_type_extensions: { "text/plain": [".txt"], "text/markdown": [".md", ".markdown"], "application/pdf": [".pdf"] },
  max_content_bytes: 1_000_000,
  max_binary_bytes: 8 * 1024 * 1024,
  max_ocr_image_bytes: 3_000_000,
  media_type_max_bytes: {
    "text/plain": 1_000_000, "text/markdown": 1_000_000,
    "application/pdf": 8 * 1024 * 1024,
  },
  content_encoding: "utf-8",
  empty_media_type_supported: false,
  normalization: "strict UTF-8",
  scanned_pdf_ocr_supported: false,
};

describe("owner upload boundary", () => {
  it("accepts only an exact backend-declared MIME and extension pair", () => {
    expect(validateOwnerUpload({ name: "notes.md", type: "text/markdown", size: 12 }, capabilities)).toEqual({ supported: true, mediaType: "text/markdown" });
    expect(validateOwnerUpload({ name: "notes.md", type: "text/plain", size: 12 }, capabilities).supported).toBe(false);
    expect(validateOwnerUpload({ name: "scan.pdf", type: "application/pdf", size: 12 }, capabilities)).toEqual({ supported: true, mediaType: "application/pdf" });
    expect(validateOwnerUpload({ name: "unknown.txt", type: "", size: 12 }, capabilities).supported).toBe(false);
    expect(validateOwnerUpload({ name: "too-big.txt", type: "text/plain", size: 1_000_001 }, capabilities).supported).toBe(false);
  });

  it("encodes a declared binary document without reading it as text", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const file = {
      name: "evidence.pdf", type: "application/pdf", size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    await expect(readOwnerUploadFile(file, capabilities)).resolves.toEqual({ content_base64: "AQIDBA==" });
  });

  it("strictly decodes declared text, strips one BOM, and never calls File.text", async () => {
    const bytes = new TextEncoder().encode("\uFEFF# Evidence\nkept exactly");
    const file = {
      name: "evidence.md", type: "text/markdown", size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
      text: () => { throw new Error("File.text must not run"); },
    } as unknown as File;
    await expect(readOwnerTextFile(file, capabilities)).resolves.toBe("# Evidence\nkept exactly");
  });

  it("refuses invalid UTF-8 before an upload can be composed", async () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);
    const file = {
      name: "broken.txt", type: "text/plain", size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    await expect(readOwnerTextFile(file, capabilities)).rejects.toThrow(/not valid UTF-8/);
  });

  it("requires a common-ingestion identity and action before calling a request uploaded", () => {
    expect(ingestionReceiptAction({ doc_uid: "private", action: "created" })).toBe("created");
    expect(ingestionReceiptAction({ doc_uid: "private", action: "unchanged" })).toBe("unchanged");
    expect(ingestionReceiptAction({ action: "created" })).toBeNull();
    expect(ingestionReceiptAction({ doc_uid: "private", action: "accepted" })).toBeNull();
  });

  it("keeps logical document identity stable across retries and later file versions", async () => {
    const first = await logicalDocumentId("cafe", "Monthly Notes.md");
    expect(await logicalDocumentId("cafe", "monthly notes.md")).toBe(first);
    expect(await logicalDocumentId("rentals", "Monthly Notes.md")).not.toBe(first);
    expect(first).toMatch(/^file_[a-f0-9]{64}$/);
  });

  it("explains OCR and scanned-PDF gaps instead of mislabeling them as record conflicts", () => {
    expect(ownerError(new ApiError(409, { code: "owner_upload_ocr_disabled" }, "conflict")).message).toMatch(/OCR is not enabled/);
    expect(ownerError(new ApiError(422, { code: "owner_upload_pdf_needs_ocr" }, "refused")).message).toMatch(/Scanned PDF page OCR is not available/);
  });
});

describe("owner inputs and scoped answers", () => {
  it("describes only support lifecycle changes in the owner history", () => {
    const base = {
      event_id: "support", entity_slug: null, subject_kind: "support_access",
      subject_id: "support", display_label: "Support technician", occurred_at: "2026-08-30T00:00:00Z",
    };
    expect(activitySentence({ ...base, event_type: "support_access_created" })).toBe("Invited Support technician");
    expect(activitySentence({ ...base, event_type: "support_access_activated" })).toBe("Opened support access for Support technician");
    expect(activitySentence({ ...base, event_type: "support_access_revoked" })).toBe("Ended support access for Support technician");
  });

  it("converts decimal money without floating point drift", () => {
    expect(majorToMinor("26300.10")).toBe(2_630_010);
    expect(majorToMinor("12.345")).toBeNull();
  });

  it("applies only an active owned default entity", () => {
    const entities = [
      { entity_slug: "cafe", legal_name: "Cafe", label: "Cafe", kind: "business", status: "active", relationship: "owned", counterparty: false, fixed: false },
      { entity_slug: "buyer", legal_name: "Buyer", label: "Buyer", kind: "business", status: "active", relationship: "counterparty", counterparty: true, fixed: false },
    ];
    expect(defaultEntityScope(entities, [{ preference_key: "default_entity", entity_slug: null, value: "cafe" }])).toBe("cafe");
    expect(defaultEntityScope(entities, [{ preference_key: "default_entity", entity_slug: null, value: "buyer" }])).toBeNull();
  });

  it("uses the activity-window preference without hiding invalid timestamps", () => {
    const events = [
      { event_id: "new", event_type: "target_set" as const, entity_slug: "cafe", subject_kind: "target", subject_id: "new", display_label: "New", occurred_at: "2026-08-29T00:00:00Z" },
      { event_id: "old", event_type: "target_set" as const, entity_slug: "cafe", subject_kind: "target", subject_id: "old", display_label: "Old", occurred_at: "2026-01-01T00:00:00Z" },
      { event_id: "bad", event_type: "target_set" as const, entity_slug: "cafe", subject_kind: "target", subject_id: "bad", display_label: "Bad date", occurred_at: "not-a-date" },
    ];
    expect(activityEventsInWindow(events, 30, Date.parse("2026-08-30T00:00:00Z")).map((event) => event.event_id)).toEqual(["new", "bad"]);
  });

  it("keeps close status separate from evidence completeness", () => {
    expect(periodClosePresentation({ status: "accepted", evidence_state: "owner_acknowledged_incomplete" })).toEqual({
      accepted: true, reopened: false, incompleteEvidence: true,
    });
    expect(periodClosePresentation({ status: "reopened", evidence_state: "owner_acknowledged_incomplete" })).toEqual({
      accepted: false, reopened: true, incompleteEvidence: true,
    });
  });

  it("requires the shared request, scope, changed flag, and activity receipt", () => {
    const receipt = { request_id: "request", entity_scope: { entity_slug: "cafe" }, changed: true, activity_event_id: "event" };
    expect(confirmedOwnerWrite(receipt, "request", "cafe")).toBe(true);
    expect(confirmedOwnerWrite({ ...receipt, request_id: "other" }, "request", "cafe")).toBe(false);
    expect(confirmedOwnerWrite({ ...receipt, activity_event_id: null }, "request", "cafe")).toBe(false);
    expect(confirmedOwnerWrite({ ...receipt, changed: false, activity_event_id: null }, "request", "cafe")).toBe(true);
    expect(confirmedOwnerWrite({ ...receipt, changed: false, activity_event_id: "unexpected" }, "request", "cafe")).toBe(false);
  });

  it("withholds a mismatched scope and captures the accepted label", () => {
    const saved = scopedAnswerLabel("cafe", { entity_slug: "cafe", applied: true }, "Cafe");
    expect(saved).toBe("Cafe only");
    expect(scopedAnswerLabel("cafe", { entity_slug: "rentals", applied: true }, "Cafe")).toBeNull();
    expect(scopedAnswerLabel("cafe", { entity_slug: "cafe", applied: false }, "Cafe")).toBeNull();
    expect(scopedAnswerLabel("cafe", { entity_slug: "cafe", applied: true }, "Cafe", true)).toBeNull();
    expect(scopedAnswerLabel(null, undefined, "All finances")).toBe("Whole brain · all evidence");
    const laterSelectedLabel = "Rentals";
    expect(saved).not.toContain(laterSelectedLabel);
  });
});
