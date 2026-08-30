/**
 * Human recovery guidance for every privacy-safe installer issue code.
 *
 * The code is the durable identity. These sentences may improve without
 * changing journal records, automation, or support searches. Guidance stays
 * intentionally general: private paths, account identifiers, provider text,
 * and credentials belong neither here nor in the support journal.
 */

import { SUPPORT_ERROR_CODES } from "./support-journal.mjs";

const RETRY_STATES = new Set(["safe_now", "safe_after_step", "review_first"]);

const entry = (code, title, whatHappened, protection, retry, nextSteps, technicianWhen) => Object.freeze({
  code,
  title,
  what_happened: whatHappened,
  protection,
  retry,
  next_steps: Object.freeze(nextSteps),
  technician_when: technicianWhen,
});

const CATALOG = [
  entry("AUTH_DENIED", "Sign-in was not approved", "The provider or account owner declined the sign-in request.", "The connection was left unchanged.", "safe_after_step", ["Open the sign-in step again when the owner is ready.", "Approve only the access shown on the provider screen, then retry the same Brain step."], "The provider keeps declining a request the owner has approved."),
  entry("AUTH_EXPIRED", "The connection needs a fresh sign-in", "A previously approved session or token is no longer accepted.", "Stored documents remain in place while the connector waits.", "safe_after_step", ["Run the matching connection step and complete sign-in again.", "Retry the same refresh after the connection check passes."], "A fresh sign-in succeeds but the Brain still reports this code."),
  entry("AUTH_REQUIRED", "A sign-in or credential is still needed", "This step reached a protected service without a usable authorization.", "The installer paused before relying on missing access.", "safe_after_step", ["Return to the matching technician step for Cloudflare, Google, Zoom, or IMAP.", "Enter any sensitive value only in the provider page or hidden terminal prompt, then retry."], "It is unclear which account or provider step is missing."),
  entry("COMMAND_FAILED", "The step did not finish", "The command stopped before it could confirm a complete result.", "The installer kept the rerun boundary so completed work can be adopted.", "safe_now", ["Read the sentence immediately above this code.", "Retry the same command once. If it stops again, open the private issue note with brain support --preview."], "The same command stops twice at the same point."),
  entry("CONFIG_INVALID", "One setup value needs attention", "A manifest value, option, filename, or command choice was missing or did not match the expected shape.", "The installer paused before using an ambiguous configuration.", "safe_after_step", ["Review the named field or option in the message above.", "Correct that one value and retry the same command."], "The suggested value is unclear or changing it could select a different account."),
  entry("EXTRACTION_FAILED", "One file could not be read", "The file opened, but its text could not be extracted reliably.", "Other documents and the source cursor stay protected from a false complete result.", "safe_after_step", ["Open the file locally to confirm it is readable.", "Use a clean export or OCR-ready copy, then retry the same source."], "Several ordinary files of the same type fail together."),
  entry("FORMAT_UNSUPPORTED", "This file type is not supported yet", "The selected file does not match a format this ingestion path can read safely.", "The file was left unchanged and was not represented as successfully indexed.", "review_first", ["Check the supported-format list for this source.", "Export the item as a supported text, PDF, Office, mail, or bank format and preview it before loading."], "The format is listed as supported but still receives this code."),
  entry("HEALTH_CHECK_FAILED", "The Brain is reachable only in part", "One or more live health checks could not confirm a ready install.", "The result stays unavailable or degraded instead of looking healthy.", "safe_now", ["Run brain health with the same manifest once more.", "If the same section remains unavailable, run brain doctor and follow its named recovery step."], "Health and doctor disagree, or the same check remains unavailable."),
  entry("INDEX_WRITE_FAILED", "Search indexing did not finish", "The document store accepted work that the search index could not yet confirm.", "The durable queue keeps the unfinished search work available for recovery.", "safe_now", ["Run brain drain with the same manifest.", "Run brain health after the queue reaches zero."], "The queue does not shrink across two drain attempts."),
  entry("INGEST_FAILED", "This source refresh is incomplete", "At least one item in the source could not finish ingestion.", "The source cursor stays behind the failed item so a retry can resume without hiding the gap.", "safe_now", ["Review the named failed item or source stage.", "Retry the same ingest command; completed items are designed to be recognized rather than duplicated."], "The same item fails twice or the failed item cannot be opened locally."),
  entry("INPUT_REFUSED", "The Brain chose not to accept this input", "A safety or quality rule found content that should be reviewed before ingestion.", "The item was kept out of the searchable corpus.", "review_first", ["Review the stated safety or quality reason.", "Use a cleaned or intentionally approved source, then preview the ingest again."], "The refusal reason does not match the file being reviewed."),
  entry("INTERNAL_ERROR", "The installer hit an unexpected problem", "The installer encountered a condition that does not yet have a specific recovery message.", "Commands are designed so the same operation can resume or adopt work already completed.", "safe_now", ["Retry the same command once.", "If it repeats, preview the private issue note and share that reviewed record with the technician."], "The problem repeats, or the Brain's current state is uncertain."),
  entry("MIGRATION_FAILED", "The database update paused", "A schema update could not complete or verify its next safe boundary.", "Upgrade state records preserve the last confirmed migration step.", "safe_now", ["Run brain doctor with the same manifest.", "Use the repair command it recommends, then retry the update."], "Doctor reports checksum drift, an incompatible column, or no reviewed repair path."),
  entry("NETWORK_UNREACHABLE", "The service could not be reached", "The computer lost a usable route to the local or provider service before the request completed.", "The command stopped with its resumable state intact.", "safe_now", ["Confirm the internet connection and that any VPN or security filter allows the provider.", "Retry the same command."], "Other websites work but this service remains unreachable."),
  entry("PDF_PROCESS_FAILED", "This PDF needs another reading path", "The PDF processor could not produce usable text from the file.", "The document was not presented as a successful clean extraction.", "review_first", ["Open the PDF and check whether its pages contain selectable text.", "For scanned pages, enable the reviewed OCR path or provide a clearer export, then retry."], "A normal text PDF fails, or OCR also fails."),
  entry("PDF_PROCESS_TIMEOUT", "This PDF took too long to read", "PDF processing reached its time limit before a safe result was ready.", "The ingest remains incomplete and can be resumed.", "safe_after_step", ["Try a smaller or split copy of the PDF.", "If it is scanned, use the reviewed OCR path and retry."], "A modest, readable PDF repeatedly reaches the time limit."),
  entry("RATE_LIMITED", "The provider asked us to slow down", "A provider temporarily limited the number of requests.", "Progress already confirmed stays recorded and the remaining work can resume.", "safe_now", ["Wait a few minutes.", "Retry the same command; use the existing cursor or queue rather than resetting the source."], "The limit returns after a longer pause or during very small requests."),
  entry("REMOTE_NOT_FOUND", "The expected service or item was not found", "A provider returned a not-found response for a route, resource, or item the Brain expected.", "The installer did not guess at a replacement resource.", "safe_after_step", ["Confirm the final Brain hostname and the named provider resource.", "For a fresh deployment, allow a short propagation window and retry health."], "The dashboard shows the exact resource but the Brain still cannot find it."),
  entry("REMOTE_PERMISSION_DENIED", "This account does not currently allow the step", "The signed-in account or token lacks access to the requested resource or action.", "The operation stopped instead of switching accounts or broadening access silently.", "safe_after_step", ["Confirm the owner is signed into the intended account.", "Review the least-privilege permissions for this connector, update them in the provider, and retry."], "The intended account and listed permissions are already confirmed."),
  entry("REMOTE_UNAVAILABLE", "The provider is temporarily unavailable", "The remote service answered, but it could not serve this operation right now.", "The Brain keeps the section explicitly unavailable and preserves resume state.", "safe_now", ["Wait briefly and retry the same command.", "Check the provider status page if the same response continues."], "The provider reports healthy service while this code persists."),
  entry("SAFETY_REVIEW_REQUIRED", "A larger change is ready for review", "The requested operation crossed a deletion, scope, or integrity guard that benefits from a human check.", "Nothing beyond the reviewed safety boundary was applied.", "review_first", ["Read the preview and confirm the source, count, and scope are expected.", "Ask the technician to review the plan before using the exact approval step shown by the installer."], "Any item, count, source, or scope in the preview is surprising."),
  entry("SCHEDULE_INSTALL_FAILED", "Automatic refresh was not installed", "The operating system did not confirm the new background schedule.", "Existing source data and any previous schedule remain visible for review.", "safe_after_step", ["Run brain schedule to inspect the current state.", "Resolve the named operating-system permission or path issue, then run the install step again."], "The scheduler reports two copies or an unfamiliar program path."),
  entry("SCHEDULE_RUN_FAILED", "An automatic refresh did not finish", "A scheduled connector run stopped before recording a complete refresh.", "The connector retains its prior cursor so the next run can resume.", "safe_now", ["Run the same ingest command once in the terminal to see the guided message.", "After it succeeds, inspect brain sources to confirm freshness."], "The manual run succeeds but the scheduled run continues to fail."),
  entry("UPGRADE_FAILED", "The update paused before final verification", "One update stage did not reach its verified completion point.", "The pre-update snapshot and upgrade state remain available for reviewed recovery.", "safe_now", ["Run brain doctor with the same manifest.", "Follow its resume or rollback preview, then run brain update again."], "Doctor cannot identify a safe resume point or suggests an unexpected rollback."),
  entry("VECTOR_DRAIN_FAILED", "Meaning search is still catching up", "The durable search queue did not reach zero or confirm visibility in time.", "Keyword search and stored documents remain separate from unconfirmed vector work, and the gap stays explicit.", "safe_now", ["Run brain drain again with the same manifest.", "When it reaches zero, run brain health to confirm query visibility."], "The remaining count does not fall or grows while no ingestion is running."),
];

export const SUPPORT_RECOVERY_CATALOG = Object.freeze(Object.fromEntries(CATALOG.map((item) => [item.code, item])));

if (CATALOG.length !== SUPPORT_ERROR_CODES.length ||
    SUPPORT_ERROR_CODES.some((code) => !SUPPORT_RECOVERY_CATALOG[code]) ||
    CATALOG.some((item) => !RETRY_STATES.has(item.retry))) {
  throw new Error("support recovery catalog does not match the support issue schema");
}

export function supportRecovery(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const result = SUPPORT_RECOVERY_CATALOG[normalized];
  if (!result) {
    const error = new Error(`unknown issue code ${normalized || "(empty)"}`);
    error.code = "CONFIG_INVALID";
    throw error;
  }
  return result;
}

export function renderSupportRecovery(recovery) {
  const retryLabel = {
    safe_now: "Yes. The same command is designed to resume safely.",
    safe_after_step: "Yes, after the step below is complete.",
    review_first: "Pause for the short review below first.",
  }[recovery.retry];
  return [
    "",
    `${recovery.code} · ${recovery.title}`,
    "",
    `What happened: ${recovery.what_happened}`,
    `What stayed protected: ${recovery.protection}`,
    `Safe to retry: ${retryLabel}`,
    "",
    "Next step:",
    ...recovery.next_steps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    `A technician can help when: ${recovery.technician_when}`,
    "",
  ].join("\n");
}
