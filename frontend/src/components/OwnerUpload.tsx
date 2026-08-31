import { useEffect, useState } from "react";
import {
  api, ownerError, type OwnerUploadCapabilities, type OwnerWriteReceipt,
} from "../lib/api";
import { ingestionReceiptAction, logicalDocumentId, readOwnerUploadFile, validateOwnerUpload } from "../lib/owner";
import { Attention, Note, Section } from "./ui";
import { useFinanceScope } from "./FinanceScope";
import { useActionRequests } from "./useActionRequests";

export function OwnerUpload({ onStored }: { onStored?: () => void }) {
  const { scope, activeLabel } = useFinanceScope();
  const [capabilities, setCapabilities] = useState<OwnerUploadCapabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capabilitiesUnavailable, setCapabilitiesUnavailable] = useState(false);
  const requests = useActionRequests("upload");

  useEffect(() => {
    let current = true;
    setCapabilities(null);
    setCapabilitiesUnavailable(false);
    api<OwnerUploadCapabilities>("/api/owner/uploads/capabilities", {})
      .then((next) => {
        if (!current) return;
        if (!Array.isArray(next.supported_media_types) || !Number.isSafeInteger(next.max_content_bytes)) {
          setCapabilitiesUnavailable(true);
          return;
        }
        setCapabilities(next);
      })
      .catch(() => { if (current) setCapabilitiesUnavailable(true); });
    return () => { current = false; };
  }, []);

  function choose(next: File | null) {
    setFile(null);
    setMessage(null);
    setError(null);
    if (!next || !capabilities) return;
    const validation = validateOwnerUpload(next, capabilities);
    if (validation.supported === false) {
      setError(validation.reason);
      return;
    }
    setFile(next);
  }

  async function upload() {
    if (!scope) return setError("Select one business before adding a record.");
    if (!file || !capabilities || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const actionKey = file;
    const id = requests.forAction(actionKey);
    try {
      const validation = validateOwnerUpload(file, capabilities);
      if (validation.supported === false) throw new Error(validation.reason);
      const payload = await readOwnerUploadFile(file, capabilities);
      const documentId = await logicalDocumentId(scope, file.name);
      const receipt = await api<OwnerWriteReceipt>("/api/owner/uploads", {
        request_id: id,
        entity_slug: scope,
        document_id: documentId,
        media_type: validation.mediaType,
        file_name: file.name,
        ...(payload.content_base64 ? { content_base64: payload.content_base64 } : {}),
        envelope: {
          title: file.name,
          ...(payload.content !== undefined ? { content: payload.content } : {}),
          metadata: { entity_slug: scope },
        },
      });
      const action = ingestionReceiptAction(receipt.document);
      const changed = action !== "unchanged";
      const eventMatchesChange = changed === Boolean(receipt.activity_event_id);
      if (receipt.uploaded !== true || receipt.request_id !== id || receipt.entity_scope?.entity_slug !== scope
        || receipt.document_id !== documentId || receipt.changed !== changed || !eventMatchesChange || !action) {
        throw new Error("The request completed, but the brain did not return a common-ingestion receipt. This file is not being labeled uploaded.");
      }
      setMessage(receipt.replayed
        ? "The brain confirmed this exact upload request was already processed. No second write or event was created."
        : action === "unchanged"
        ? "The brain confirmed this upload request was already stored. No duplicate was created."
        : action === "updated"
          ? "The brain confirmed the stored document text was updated and recorded the change."
          : "The brain confirmed the document text was stored and recorded the change.");
      requests.confirmed(actionKey);
      setFile(null);
      onStored?.();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  const accept = capabilities
    ? [...capabilities.supported_media_types, ...capabilities.supported_extensions].join(",")
    : undefined;

  const binaryReady = Boolean(capabilities?.supported_media_types.some((mediaType) =>
    mediaType === "application/pdf" || mediaType.startsWith("image/") || mediaType.startsWith("application/vnd.")));
  const binaryLimit = capabilities?.max_binary_bytes ?? capabilities?.max_content_bytes ?? 0;

  return (
    <Section title="Add a document" blurb={`Add a supported document or receipt to ${scope ? activeLabel : "one selected business"}. The Brain reads and stores it through the same protected path as every other owner upload.`}>
      {capabilitiesUnavailable && (
        <Attention>Upload limits could not be read from the brain, so file selection is unavailable. No file was submitted.</Attention>
      )}
      {!capabilities && !capabilitiesUnavailable && <Note>Reading supported file types and size limits.</Note>}
      {capabilities && (
        <div className="p-4">
          <label className="block text-[13px] font-medium">Choose a document or receipt
            <input
              type="file"
              accept={accept}
              disabled={busy || !scope}
              onChange={(event) => choose(event.target.files?.[0] || null)}
              className="block w-full mt-2 text-[13px] text-ink-soft file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-accent file:font-medium"
            />
          </label>
          <p className="mt-2 text-[12.5px] text-ink-soft">
            {capabilities.supported_extensions.join(", ")} · text up to {capabilities.max_content_bytes.toLocaleString()} bytes
            {binaryReady ? ` · documents up to ${binaryLimit.toLocaleString()} bytes` : ""}
          </p>
          <p className="mt-2 text-[12.5px] text-ink-soft leading-relaxed">
            {binaryReady
              ? "This Brain reports protected document upload. Images may use private OCR. A PDF without a readable text layer can still be refused, and the receipt will say why."
              : "This installed Brain accepts text records only. PDF, image, Office, email, archive, and unknown file types remain closed and will not be labeled uploaded."}
          </p>
          {!scope && <div className="mt-3"><Attention>Select one business above before adding a record.</Attention></div>}
          {file && <p className="mt-3 text-[13.5px]">Ready to submit: <span className="font-medium">{file.name}</span></p>}
          {error && <div className="mt-3"><Attention>{error}</Attention></div>}
          {message && <div className="mt-3"><Note>{message}</Note></div>}
          <button
            onClick={upload}
            disabled={!file || !scope || busy}
            className="mt-3 rounded-xl bg-accent px-4 py-2.5 text-white text-[13.5px] font-medium disabled:opacity-45"
          >
            {busy ? "Submitting" : "Add document"}
          </button>
        </div>
      )}
    </Section>
  );
}
