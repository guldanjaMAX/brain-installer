import { useEffect, useState } from "react";
import { api, type Answer } from "../lib/api";
// Shared with the Worker: the rule that an incomplete search must never render
// as an absence is a product rule, not a rendering detail, so both surfaces
// derive it from one module instead of each writing their own.
import { answerText, confidenceText, unavailableSearch } from "../lib/answer-render.js";
import { Attention } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { scopedAnswerLabel } from "../lib/owner";

/** How sure the brain is, and why. The basis is shown rather than summarised:
 *  a bare percentage is a number to argue with, a percentage with its reasons
 *  is something a person can actually judge. */
function Trust({ answer }: { answer: Answer }) {
  const c = answer.confidence;
  // A search that never completed has no rubric to report. Rendering a
  // percentage here would put a number on an absence nobody measured.
  if (unavailableSearch(answer)) {
    return (
      <p className="mt-5 pt-4 border-t border-line text-[13px] text-ink-soft">
        {confidenceText(answer)}
      </p>
    );
  }
  if (!c) return null;
  const refused = /^The documents do not answer/i.test(answer.answer || "");
  const tone = c.percent >= 80 ? "text-emerald-700 bg-emerald-50"
    : c.percent >= 55 ? "text-amber-700 bg-amber-50"
      : "text-red-700 bg-red-50";
  return (
    <div className="mt-5 pt-4 border-t border-line">
      <div className="flex items-center gap-2">
        <span className={`text-[13px] font-semibold px-2 py-0.5 rounded-md ${tone}`}>
          {c.percent}% {c.band}
        </span>
        <span className="text-[13px] text-ink-soft">
          {refused ? "confidence nothing is recorded" : "confidence"}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {c.basis.map((reason) => (
          <li key={reason} className="text-[13px] text-ink-soft leading-snug">· {reason}</li>
        ))}
      </ul>
    </div>
  );
}

export function Ask({ initialQuestion, onManage }: {
  initialQuestion?: { id: number; text: string } | null;
  onManage: () => void;
}) {
  const { activeLabel, scope } = useFinanceScope();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answerLabel, setAnswerLabel] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);

  useEffect(() => {
    if (!initialQuestion?.text) return;
    setQuestion(initialQuestion.text);
    setAnswer(null);
    setError(null);
  }, [initialQuestion?.id, initialQuestion?.text]);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    if (attachment) {
      setError("This Brain cannot read a file for one question and then discard it yet. Remove the attachment to ask from saved records, or save the document first under Manage.");
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer(null);
    setAnswerLabel(null);
    try {
      const next = await api<Answer>("/api/rag/think", {
        q,
        limit: 12,
        ...(scope ? { entity_slug: scope } : {}),
      });
      const label = scopedAnswerLabel(scope, next.entity_scope, activeLabel, next.filter_not_applied);
      if (!label) {
        setError(`The brain could not prove that this answer was narrowed to ${activeLabel}. No whole-brain answer is being shown as business-scoped.`);
        return;
      }
      setAnswerLabel(label);
      setAnswer(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-busy={busy}>
      <FinanceScopeBar />
      <header className="max-w-2xl mb-6">
        <p className="eyebrow">Cited answers</p>
        <h1 className="page-title">Ask &amp; Explore</h1>
        <p className="page-intro">
          Ask a question in plain language. The answer keeps its sources beside it and names what the records do not cover.
        </p>
      </header>
      <div className="max-w-3xl">
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); }}
        placeholder="Ask your brain anything…"
        aria-label="Ask your brain anything"
        rows={3}
        className="w-full rounded-xl border border-line bg-card p-4 text-[16px] leading-relaxed
                   outline-none focus:border-accent resize-y"
      />
      <div className="mt-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-[13.5px] font-medium text-ink-soft hover:border-accent hover:text-accent">
          <span aria-hidden="true">+</span>
          {attachment ? "Replace document" : "Attach document"}
          <input
            type="file"
            className="sr-only"
            aria-label="Choose a document to attach to this question"
            onChange={(event) => {
              setAttachment(event.target.files?.[0] || null);
              setError(null);
            }}
          />
        </label>
      </div>
      {attachment && (
        <div className="mt-3 rounded-2xl border border-line bg-card p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <span className="min-w-0">
              <span className="block text-[14px] font-medium break-all">{attachment.name}</span>
              <span className="block text-[12.5px] text-ink-soft mt-0.5">{fileSize(attachment.size)} · preview only, not uploaded or read</span>
            </span>
            <button type="button" onClick={() => setAttachment(null)} className="text-[13px] text-red-700 px-2 py-1 rounded-lg hover:bg-red-50">
              Remove
            </button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-[13.5px] font-medium text-amber-900">Use for this question only</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-amber-900">Not available yet. The Brain has no verified path that reads the file and proves it was discarded afterwards.</p>
            </div>
            <div className="rounded-xl border border-line bg-paper p-3">
              <p className="text-[13.5px] font-medium">Save to my records</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">Add it deliberately to one entity under Manage, wait for its receipt, then ask from the saved record.</p>
              <button type="button" onClick={onManage} className="mt-2 text-[13px] font-medium text-accent">Open Manage</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={ask}
          disabled={busy || !question.trim() || Boolean(attachment)}
          className="rounded-xl bg-accent px-5 py-2.5 text-white font-semibold
                     disabled:opacity-45 transition-opacity"
        >
          {busy ? "Thinking…" : "Ask"}
        </button>
        <span className="text-[13px] text-ink-soft">⌘ + Enter</span>
      </div>

      {error && <div className="mt-4"><Attention>{error}</Attention></div>}

      {answer && (
        <article className="mt-6 bg-card border border-line rounded-2xl p-6">
          <p className="text-[12px] uppercase tracking-wider text-ink-soft font-semibold mb-3">
            {answerLabel}
          </p>
          {scope && answer.degraded === "vector" && answer.degraded_reason === "entity-vector-authority-unindexed" && (
            <div className="mb-4">
              <Attention>
                Exact business filtering was applied, but meaning-based business search is still being indexed. This answer may miss differently phrased evidence.
              </Attention>
            </div>
          )}
          <p className="whitespace-pre-wrap leading-relaxed">{answerText(answer)}</p>
          <Trust answer={answer} />
          {!!answer.citations?.length && (
            <div className="mt-4 pt-4 border-t border-line">
              <h2 className="text-[12px] uppercase tracking-wider text-ink-soft font-semibold">
                Sources
              </h2>
              <ul className="mt-2 space-y-1.5">
                {answer.citations.map((c) => (
                  <li key={c.n} className="text-[13.5px] text-ink-soft leading-snug">
                    <span className="text-accent font-medium">[{c.n}]</span> {c.title}
                    {c.ts && <span className="opacity-70"> · {String(c.ts).slice(0, 10)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
      </div>
    </section>
  );
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
