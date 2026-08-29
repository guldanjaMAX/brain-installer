import { useState } from "react";
import { api, type Answer } from "../lib/api";
// Shared with the Worker: the rule that an incomplete search must never render
// as an absence is a product rule, not a rendering detail, so both surfaces
// derive it from one module instead of each writing their own.
import { answerText, confidenceText, unavailableSearch } from "../lib/answer-render.js";
import { TruthNote } from "./ui";
import { useFinanceScope } from "./FinanceScope";

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

export function Ask() {
  const { activeLabel, scope } = useFinanceScope();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await api<Answer>("/api/rag/think", { q, limit: 12 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="max-w-2xl mb-6">
        <p className="eyebrow">Cited answers</p>
        <h1 className="page-title">Ask &amp; Explore</h1>
        <p className="page-intro">
          Ask a question in plain language. The answer keeps its sources beside it and names what the records do not cover.
        </p>
      </header>
      {scope && (
        <div className="max-w-3xl mb-5">
          <TruthNote>
            {activeLabel} stays selected on the financial screens. Questions here still search all evidence because business-level answer scoping is not enforced yet.
          </TruthNote>
        </div>
      )}
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
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={ask}
          disabled={busy || !question.trim()}
          className="rounded-xl bg-accent px-5 py-2.5 text-white font-semibold
                     disabled:opacity-45 transition-opacity"
        >
          {busy ? "Thinking…" : "Ask"}
        </button>
        <span className="text-[13px] text-ink-soft">⌘ + Enter</span>
      </div>

      {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}

      {answer && (
        <article className="mt-6 bg-card border border-line rounded-2xl p-6">
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
