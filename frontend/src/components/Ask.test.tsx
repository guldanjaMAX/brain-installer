import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Answer } from "../lib/api";
import {
  ANSWER_ERROR_MESSAGES, answerText,
} from "../lib/answer-render.js";
import { unavailableNotice } from "../lib/retrieval-status.js";
import { EvidenceGateReason, evidenceGateNote } from "./Ask";

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
