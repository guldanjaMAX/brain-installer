import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANSWER_ERROR_MESSAGES } from "../lib/answer-render.js";
import { AnswerCopy } from "./Ask";

describe("owner answer copy", () => {
  it("replaces a raw provider error before rendering it", () => {
    const raw = "RAW_PROVIDER_FAILURE_SENTINEL private-trace-456";
    const html = renderToStaticMarkup(
      <AnswerCopy answer={{ answer: null, answer_error: raw }} />,
    );
    expect(html).toContain(ANSWER_ERROR_MESSAGES.unavailable);
    expect(html).not.toContain(raw);
  });

  it("keeps a reviewed recovery message specific", () => {
    const html = renderToStaticMarkup(
      <AnswerCopy answer={{
        answer: null,
        answer_error: ANSWER_ERROR_MESSAGES.notConfigured,
      }} />,
    );
    expect(html).toContain(ANSWER_ERROR_MESSAGES.notConfigured);
  });
});
