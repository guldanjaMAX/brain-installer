import type {
  FinEntity, OwnerActivityEvent, OwnerPeriodClose, OwnerPreference, OwnerUploadCapabilities, OwnerWriteReceipt,
} from "./api";

export const OWNER_UPLOAD_MEDIA = ["text/plain", "text/markdown"] as const;
export const OWNER_UPLOAD_EXTENSIONS = [".txt", ".md", ".markdown"] as const;
export const OWNER_UPLOAD_MAX_BYTES = 1_000_000;

export type OwnerUploadValidation =
  | { supported: true; mediaType: string }
  | { supported: false; reason: string };

export function validateOwnerUpload(
  file: Pick<File, "name" | "type" | "size">,
  capabilities: OwnerUploadCapabilities,
): OwnerUploadValidation {
  const mediaType = file.type.toLocaleLowerCase();
  const name = file.name.toLocaleLowerCase();
  const extension = capabilities.supported_extensions.find((item) => name.endsWith(item.toLocaleLowerCase()));
  if (!capabilities.supported_media_types.includes(mediaType)) {
    return {
      supported: false,
      reason: "Owner upload currently accepts UTF-8 text and Markdown only. PDF, image, Office, mail, archive, and unknown file types need a different extraction path and were not uploaded.",
    };
  }
  if (!extension || !capabilities.media_type_extensions[mediaType]?.includes(extension)) {
    return {
      supported: false,
      reason: "The selected file does not have a supported .txt, .md, or .markdown filename, so it was not uploaded.",
    };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > capabilities.max_content_bytes) {
    return {
      supported: false,
      reason: "Owner text upload is limited to 1,000,000 bytes. This file was not uploaded.",
    };
  }
  return { supported: true, mediaType: mediaType as typeof OWNER_UPLOAD_MEDIA[number] };
}

export async function readOwnerTextFile(file: File, capabilities: OwnerUploadCapabilities): Promise<string> {
  const validation = validateOwnerUpload(file, capabilities);
  if (validation.supported === false) throw new Error(validation.reason);
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > capabilities.max_content_bytes) {
      throw new Error("Owner text upload is larger than the declared limit. This file was not uploaded.");
    }
    let content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.startsWith("\uFEFF")) content = content.slice(1);
    if (new TextEncoder().encode(content).length > capabilities.max_content_bytes) {
      throw new Error("Owner text upload is limited to 1,000,000 bytes. This file was not uploaded.");
    }
    return content;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("This file is not valid UTF-8 text, so it was not uploaded.");
    }
    throw error;
  }
}

export function validCurrency(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value.trim());
}

export function majorToMinor(value: string): number | null {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const negative = whole.startsWith("-");
  const absoluteWhole = negative ? whole.slice(1) : whole;
  const minor = Number(absoluteWhole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

export function activitySentence(event: OwnerActivityEvent): string {
  const labels: Record<OwnerActivityEvent["event_type"], string> = {
    upload_completed: "Added",
    approval_recorded: "Recorded a decision for",
    period_close_accepted: "Accepted",
    period_close_reopened: "Reopened",
    target_set: "Set",
    target_archived: "Archived",
    preference_set: "Updated",
    document_grant_created: "Shared",
    document_grant_invite_reissued: "Reissued access for",
    document_grant_revoked: "Revoked access for",
    passkey_added: "Added",
    passkey_renamed: "Renamed",
    passkey_revoked: "Removed",
    sessions_revoked: "Ended",
  };
  return `${labels[event.event_type]} ${event.display_label}`;
}

export function scopedAnswerLabel(
  requestedScope: string | null,
  echoedScope: { entity_slug: string | null; applied: boolean } | undefined,
  selectedLabel: string,
  filterNotApplied = false,
): string | null {
  if (!requestedScope) return "Whole brain · all evidence";
  if (filterNotApplied || echoedScope?.applied !== true || echoedScope.entity_slug !== requestedScope) return null;
  return `${selectedLabel} only`;
}

export function ingestionReceiptAction(value: unknown): "created" | "updated" | "unchanged" | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.doc_uid !== "string" && typeof receipt.brain_doc_id !== "string") return null;
  return receipt.action === "created" || receipt.action === "updated" || receipt.action === "unchanged"
    ? receipt.action
    : null;
}

export async function logicalDocumentId(entitySlug: string, fileName: string): Promise<string> {
  const identity = `${entitySlug}\n${fileName.trim().toLocaleLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `file_${hex}`;
}

export function defaultEntityScope(entities: FinEntity[], preferences: OwnerPreference[]): string | null {
  const selected = preferences.find((item) => item.preference_key === "default_entity" && !item.entity_slug);
  if (typeof selected?.value !== "string") return null;
  return entities.some((entity) => entity.entity_slug === selected.value && !entity.counterparty && entity.status === "active")
    ? selected.value
    : null;
}

export function activityEventsInWindow(events: OwnerActivityEvent[], days: number | null, now = Date.now()) {
  if (!days) return events;
  const cutoff = now - days * 86_400_000;
  return events.filter((event) => {
    const occurred = Date.parse(event.occurred_at);
    return !Number.isFinite(occurred) || occurred >= cutoff;
  });
}

export function periodClosePresentation(close: Pick<OwnerPeriodClose, "status" | "evidence_state">) {
  return {
    accepted: close.status === "accepted",
    reopened: close.status === "reopened",
    incompleteEvidence: close.evidence_state === "owner_acknowledged_incomplete",
  };
}

export function confirmedOwnerWrite(receipt: OwnerWriteReceipt, requestId: string, entitySlug: string | null): boolean {
  const eventMatchesChange = receipt.changed === true
    ? typeof receipt.activity_event_id === "string" && receipt.activity_event_id.length > 0
    : receipt.changed === false && receipt.activity_event_id === null;
  return receipt.request_id === requestId
    && receipt.entity_scope?.entity_slug === entitySlug
    && eventMatchesChange;
}
