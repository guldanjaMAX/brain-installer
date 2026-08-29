import { useState, type ReactNode } from "react";

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
