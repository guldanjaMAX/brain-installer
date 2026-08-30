import { useEffect, useRef, useState } from "react";
import type { FinEntity } from "../lib/api";
import { orderedScopes, visibleScopes } from "../lib/finance";

const FIND_AT = 7;

/** One scope model for every financial screen. The row stays on one swipeable
 *  line so twenty businesses do not become a wall on a phone. */
export function ScopeBar({ entities, value, onChange, disabled = false }: {
  entities: FinEntity[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const choicesRef = useRef<HTMLDivElement>(null);
  const ordered = orderedScopes(entities);
  const shown = visibleScopes(entities, query, value);
  const q = query.trim().toLocaleLowerCase();
  const foundAdded = !q || ordered.some((entity) =>
    !entity.fixed && entity.label.toLocaleLowerCase().includes(q));

  const choose = (next: string | null) => {
    setQuery("");
    onChange(next);
  };

  useEffect(() => {
    choicesRef.current?.querySelector<HTMLElement>("[aria-pressed='true']")
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [value]);

  return (
    <div className="mb-6" role="group" aria-label="Showing">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-ink-soft">
          Showing
        </span>
        {ordered.length >= FIND_AT && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a business"
            aria-label="Find a business"
            className="w-44 max-w-[58vw] text-[13px] px-3 py-2 rounded-lg border border-line bg-card outline-none focus:border-accent"
          />
        )}
      </div>
      <div ref={choicesRef} className="flex flex-nowrap gap-2 overflow-x-auto pb-2 -mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ScopeChoice active={value === null} disabled={disabled} onClick={() => choose(null)}>
          All
        </ScopeChoice>
        {shown.map((entity) => (
          <ScopeChoice
            key={entity.entity_slug}
            active={value === entity.entity_slug}
            disabled={disabled}
            onClick={() => choose(entity.entity_slug)}
          >
            {entity.label}
          </ScopeChoice>
        ))}
        {q && !foundAdded && (
          <span className="text-[13px] text-ink-soft py-2 whitespace-nowrap">
            No business by that name here.
          </span>
        )}
      </div>
    </div>
  );
}

function ScopeChoice({ active, disabled, onClick, children }: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 text-[13.5px] font-medium px-3.5 py-2 rounded-xl border transition-colors disabled:opacity-60 ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-card text-ink-soft border-line hover:text-ink hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}
