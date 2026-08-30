import { useState, type ReactNode } from "react";
import { outcomeFor, MOVE_LABEL, type MoveOwner } from "../lib/outcome";

/** "today" / "yesterday" / "12 days ago" / "Mar 3". Null means never. */
export function ago(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The same, for an ISO string. The bank feed stores timestamps as text. */
export function agoISO(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ago(ms) : null;
}

export function Section({ title, blurb, children, action }: {
  title: string; blurb?: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {blurb && <p className="mt-1.5 text-[14px] text-ink-soft leading-relaxed">{blurb}</p>}
      <div className="mt-3 bg-card border border-line rounded-2xl overflow-hidden">{children}</div>
    </section>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-3.5 border-b border-line last:border-b-0 flex items-center justify-between gap-3 flex-wrap">
      {children}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-3.5 text-[14px] text-ink-soft leading-relaxed border-b border-line last:border-b-0">
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-[14px] text-ink-soft text-center">{children}</p>;
}

export function Badge({ tone, children }: {
  tone: "accent" | "muted" | "warn"; children: ReactNode;
}) {
  const styles = {
    accent: "bg-accent-soft text-accent",
    muted: "bg-paper text-ink-soft border border-line",
    warn: "bg-amber-50 text-amber-800 border border-amber-200",
  }[tone];
  return (
    <span className={`text-[11.5px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

/** A state chip from the closed five-word vocabulary.
 *
 *  Every chip carries a glyph, and the glyph is not decoration: it is what
 *  makes the state legible in grayscale, in print, and to someone who cannot
 *  distinguish the colours. Colour here only reinforces what the glyph and the
 *  word already say, so nothing is lost when it is absent.
 *
 *  Prefer this over Badge for anything that is a STATE. Badge is for labels
 *  that carry no status meaning, like a source name. */
export function Chip({ state }: { state: string }) {
  const o = outcomeFor(state);
  const styles: Record<string, string> = {
    good: "bg-emerald-50 text-emerald-800 border-emerald-200",
    done: "bg-paper text-ink-soft border-line",
    wait: "bg-sky-50 text-sky-800 border-sky-200",
    act: "bg-amber-50 text-amber-900 border-amber-200",
    bad: "bg-red-50 text-red-800 border-red-200",
  };
  return (
    <span
      className={`text-[11.5px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap border inline-flex items-center gap-1 ${styles[o.tone]}`}
    >
      <span aria-hidden="true">{o.glyph}</span>
      {o.label}
    </span>
  );
}

/** The move under a row. Deliberately NOT colour-coded: it is the sentence
 *  that tells someone what to do, and it has to survive grayscale on its own. */
export function NextStep({ owner, children }: { owner?: MoveOwner; children: ReactNode }) {
  return (
    <span className="block text-[13px] text-ink-soft mt-1.5 pl-2.5 border-l-2 border-line">
      {owner && <span className="font-medium">{MOVE_LABEL[owner]}. </span>}
      {children}
    </span>
  );
}

/** The severity ladder, three rungs, graded by CONSEQUENCE not by machine
 *  state. Critical is the heaviest object on any screen and sits outside every
 *  action cap; nothing else may compete with it visually. */
export function Critical({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-3 border-[1.5px] border-red-300 bg-red-50 rounded-2xl px-4 py-3.5 mb-4">
      <span aria-hidden="true" className="text-red-700 font-semibold">!</span>
      <div className="text-[14.5px] text-red-900 leading-relaxed min-w-0">{children}</div>
    </div>
  );
}

export function Attention({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex gap-3 border border-amber-200 bg-amber-50 rounded-2xl px-4 py-3.5 mb-4">
      <span aria-hidden="true" className="text-amber-800">!</span>
      <div className="text-[14.5px] text-amber-900 leading-relaxed min-w-0">{children}</div>
    </div>
  );
}

/** The quietest rung: something true and worth saying that is not a problem. */
export function TruthNote({ children }: { children: ReactNode }) {
  return (
    <div className="border border-line bg-card rounded-2xl px-4 py-3.5 mb-4">
      <div className="text-[14px] text-ink-soft leading-relaxed">{children}</div>
    </div>
  );
}

/** A destructive action that asks in place.
 *
 *  window.confirm() cannot be styled, cannot be read by a screen reader in the
 *  page's own voice, and on iOS it steals the whole screen for a sentence. It
 *  also makes the honest, specific warning this app owes an owner ("this also
 *  disconnects every AI") look like a browser error. Asking inline keeps the
 *  question next to the thing it is about. */
export function Confirm({ label, question, onConfirm, disabled, tone = "danger" }: {
  label: string;
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
  tone?: "danger" | "quiet";
}) {
  const [asking, setAsking] = useState(false);
  const color = tone === "danger" ? "text-red-700" : "text-ink-soft";

  if (!asking) {
    return (
      <button
        disabled={disabled}
        onClick={() => setAsking(true)}
        className={`text-[13px] ${color} px-2 py-1 rounded-lg hover:bg-paper disabled:opacity-50 shrink-0`}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5 flex-wrap justify-end">
      <span className="text-[13px] text-ink-soft">{question}</span>
      <button
        disabled={disabled}
        onClick={() => { setAsking(false); onConfirm(); }}
        className="text-[13px] font-medium text-red-700 px-2 py-1 rounded-lg hover:bg-red-50 disabled:opacity-50"
      >
        Yes
      </button>
      <button
        onClick={() => setAsking(false)}
        className="text-[13px] text-ink-soft px-2 py-1 rounded-lg hover:bg-paper"
      >
        Cancel
      </button>
    </span>
  );
}

/** Click-to-edit text. Same reasoning as Confirm: prompt() is a modal for
 *  something that is really just a text field. */
export function EditableName({ value, placeholder, onSave, disabled }: {
  value: string; placeholder: string; onSave: (next: string) => void; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        disabled={disabled}
        onClick={() => { setDraft(value); setEditing(true); }}
        className="text-[14.5px] text-left hover:text-accent disabled:opacity-50"
        title="Rename"
      >
        {value || <span className="text-ink-soft italic">{placeholder}</span>}
      </button>
    );
  }
  const commit = () => { setEditing(false); if (draft !== value) onSave(draft); };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className="text-[14.5px] px-2 py-1 -mx-2 -my-1 rounded-lg border border-accent bg-card outline-none min-w-0 w-44"
      placeholder={placeholder}
    />
  );
}
