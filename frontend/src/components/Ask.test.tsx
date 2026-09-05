import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Answer } from "../lib/api";
import {
  ANSWER_ERROR_MESSAGES, answerText,
} from "../lib/answer-render.js";
import { unavailableNotice } from "../lib/retrieval-status.js";
import { CitationSources, EvidenceGateReason, citationMeta, evidenceGateNote } from "./Ask";

describe("answer messages", () => {
  it("replaces an older Worker's raw provider error with reviewed copy", () => {
    const raw = "provider request failed with private trace fixture-123";
    const rendered = answerText({ answer: null, answer_error: raw });
    expect(rendered).toBe(ANSWER_ERROR_MESSAGES.unavailable);
    expect(rendered).not.toContain(raw);
  });

  it("keeps a reviewed recovery message specific", () => {
    expect(answerText({
      answer: null,
      answer_error: ANSWER_ERROR_MESSAGES.notConfigured,
    })).toBe(ANSWER_ERROR_MESSAGES.notConfigured);
  });

  it("states the unavailable-search conclusion in the right direction", () => {
    const notice = unavailableNotice("vector");
    expect(notice).toContain("This does not mean your brain is empty");
    expect(notice).not.toContain("Nothing here means your brain is empty");
  });
});

describe("evidence gate reason", () => {
  it("shows why a refusal was withheld", () => {
    const answer: Answer = {
      answer: "The documents do not answer the question.",
      evidence_gate: {
        supported: false,
        complete: false,
        reason: "newer direct evidence was missing",
      },
    };
    expect(evidenceGateNote(answer)).toBe(
      "Why no answer was shown: newer direct evidence was missing.",
    );
    const html = renderToStaticMarkup(<EvidenceGateReason answer={answer} />);
    expect(html).toContain("Why no answer was shown: newer direct evidence was missing.");
  });

  it("labels a partial answer's uncovered evidence", () => {
    const answer: Answer = {
      answer: "The records support the first part [1].",
      evidence_gate: {
        supported: true,
        complete: false,
        partial: true,
        reason: "the deadline was not established",
      },
    };
    expect(evidenceGateNote(answer)).toBe(
      "What the records did not cover: the deadline was not established.",
    );
  });
});

describe("citation provenance", () => {
  it("labels uncertain dates and OCR beside the source", () => {
    const meta = citationMeta({
      n: 1,
      title: "Scanned statement",
      source: "gmail",
      ts: "2024-02-03T12:00:00.000Z",
      date_reliable: false,
      text_source: "ocr_partial",
      text_reliable: false,
    });
    expect(meta).toBe("Email · around Feb 3, 2024 · OCR text may be incomplete");
  });

  it("keeps a legacy citation with missing date trust uncertain", () => {
    const meta = citationMeta({
      n: 1,
      title: "Legacy note",
      source: "drive",
      ts: "2024-02-03T00:00:00.000Z",
    });
    expect(meta).toBe("Google Drive · around Feb 3, 2024");
  });

  it("renders provenance on the citation instead of silently dropping it", () => {
    const html = renderToStaticMarkup(<CitationSources citations={[{
      n: 2,
      title: "Native note",
      source: "drive",
      ts: "2024-04-05T00:00:00.000Z",
      date_reliable: true,
      text_source: "native",
      text_reliable: true,
    }]} />);
    expect(html).toContain("Google Drive");
    expect(html).toContain("Apr 5, 2024");
  });
});
