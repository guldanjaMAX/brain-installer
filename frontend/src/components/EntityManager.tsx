import { useEffect, useMemo, useState } from "react";
import { api, type OwnerUploadCapabilities } from "../lib/api";
import { useFinanceScope } from "./FinanceScope";
import { OwnerUpload } from "./OwnerUpload";
import { Attention, Empty, Note, Row, Section } from "./ui";

const CLASSIFICATION_KEY = "financial-brain-entity-classifications-v1";
const CLASSIFICATIONS = [
  ["personal", "Personal"],
  ["business", "Business"],
  ["rental", "Rental"],
  ["estate", "Estate"],
] as const;

type Classification = typeof CLASSIFICATIONS[number][0];
type SavedClassifications = Record<string, Classification>;

function readClassifications(): SavedClassifications {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLASSIFICATION_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
      CLASSIFICATIONS.some(([classification]) => classification === value))) as SavedClassifications;
  } catch {
    return {};
  }
}

function fallbackClassification(kind: string): Classification {
  const value = kind.toLowerCase();
  if (["person", "personal", "household", "individual", "investment"].includes(value)) return "personal";
  if (["property", "rental"].includes(value)) return "rental";
  if (["trust", "estate"].includes(value)) return "estate";
  return "business";
}

export function EntityManager() {
  const { entities, status, setScope } = useFinanceScope();
  const [classifications, setClassifications] = useState<SavedClassifications>(() => readClassifications());
  const [capabilities, setCapabilities] = useState<OwnerUploadCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const owned = useMemo(() => entities.filter((entity) => !entity.counterparty), [entities]);
  const binaryReady = Boolean(capabilities?.supported_media_types.some((mediaType) =>
    mediaType === "application/pdf" || mediaType.startsWith("image/") || mediaType.startsWith("application/vnd.")));

  useEffect(() => {
    let current = true;
    api<OwnerUploadCapabilities>("/api/owner/uploads/capabilities", {})
      .then((next) => {
        if (!current) return;
        setCapabilities(next);
        setCapabilityError(false);
      })
      .catch(() => {
        if (!current) return;
        setCapabilities(null);
        setCapabilityError(true);
      });
    return () => { current = false; };
  }, []);

  function classify(entitySlug: string, value: Classification) {
    const next = { ...classifications, [entitySlug]: value };
    setClassifications(next);
    try {
      localStorage.setItem(CLASSIFICATION_KEY, JSON.stringify(next));
    } catch {
      // This is a display choice only. The note below is explicit that the
      // server does not own it yet.
    }
  }

  function startScan(entitySlug: string) {
    setScope(entitySlug);
    setUploadFor(entitySlug);
    requestAnimationFrame(() => document.getElementById("manage-entity-upload")
      ?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div id="manage-entities" className="scroll-mt-24">
      <Section
        title="Business entities"
        blurb="Classify every entity and add its documents from the same row. The classification organizes this interface and does not change legal or ledger records."
      >
        <Note>Classifications are saved on this device until the Brain provides an owner preference for them.</Note>
        {status === "unavailable" && (
          <Attention>The entity list could not be read. Nothing is being presented as an empty portfolio.</Attention>
        )}
        {status === "ready" && owned.length === 0 && <Empty>No owned entity is recorded yet.</Empty>}
        {owned.map((entity) => {
          const classification = classifications[entity.entity_slug] || fallbackClassification(entity.kind);
          return (
            <Row key={entity.entity_slug}>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium">{entity.label}</span>
                <span className="block text-[12.5px] text-ink-soft mt-0.5">
                  {entity.status ? `Recorded status: ${entity.status.replace(/_/g, " ")}` : "No status recorded"}
                </span>
              </span>
              <label className="min-w-[9.5rem] text-[12px] text-ink-soft">
                Type
                <select
                  value={classification}
                  aria-label={`Classify ${entity.label}`}
                  onChange={(event) => classify(entity.entity_slug, event.target.value as Classification)}
                  className="mt-1 block w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                >
                  {CLASSIFICATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <button
                type="button"
                disabled={!binaryReady}
                onClick={() => startScan(entity.entity_slug)}
                title={binaryReady ? `Add documents for ${entity.label}` : "Document and receipt scanning is not supported by this installed Brain yet."}
                className="rounded-xl border border-line bg-paper px-3 py-2.5 text-[13px] font-medium text-ink hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-55"
              >
                Scan documents or receipts
              </button>
            </Row>
          );
        })}
        {!binaryReady && !capabilityError && capabilities && (
          <Note>This installed Brain currently accepts text records only. Scan controls stay closed until the protected upload route reports PDF and image support.</Note>
        )}
        {capabilityError && (
          <Attention>Upload capabilities could not be verified, so every scan control is closed. No file was selected or sent.</Attention>
        )}
      </Section>
      {uploadFor && binaryReady && (
        <div id="manage-entity-upload" className="scroll-mt-24">
          <OwnerUpload onStored={() => setUploadFor(null)} />
        </div>
      )}
    </div>
  );
}
