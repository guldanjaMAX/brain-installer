import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { api, type FinEntity, type FinSnapshot, type OwnerPreferencesResponse } from "../lib/api";
import { activeScopeLabel } from "../lib/finance";
import { defaultEntityScope } from "../lib/owner";
import { Attention } from "./ui";
import { ScopeBar } from "./ScopeBar";

type ScopeStatus = "loading" | "ready" | "not_installed" | "unavailable";
type FinanceScopeValue = {
  scope: string | null;
  setScope: (scope: string | null) => void;
  entities: FinEntity[];
  status: ScopeStatus;
  activeLabel: string;
  refresh: () => Promise<void>;
};

const STORAGE_KEY = "financial-brain:entity-scope";
const FinanceScopeContext = createContext<FinanceScopeValue | null>(null);

function savedScope(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function FinanceScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<string | null>(savedScope);
  const scopeRef = useRef(scope);
  const [entities, setEntities] = useState<FinEntity[]>([]);
  const [status, setStatus] = useState<ScopeStatus>("loading");

  const setScope = useCallback((next: string | null) => {
    scopeRef.current = next;
    setScopeState(next);
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, next);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is a convenience. A private browsing restriction must not
      // make the financial screens unusable.
    }
  }, []);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const snapshot = await api<FinSnapshot>("/api/fin/snapshot", { sections: ["entities"] });
      if (!snapshot.ledger_installed) {
        setEntities([]);
        setStatus("not_installed");
        return;
      }
      if (!Array.isArray(snapshot.entities)) {
        setEntities([]);
        setStatus("unavailable");
        return;
      }
      setEntities(snapshot.entities);
      setStatus("ready");
      const currentScope = scopeRef.current;
      if (currentScope && !snapshot.entities.some((entity) => entity.entity_slug === currentScope)) {
        setScope(null);
      } else if (!currentScope) {
        // A saved session choice wins. The default is consulted only when
        // this visit has not selected a scope yet.
        try {
          const preferences = await api<OwnerPreferencesResponse>("/api/owner/preferences/read", {});
          const preferredSlug = defaultEntityScope(snapshot.entities, preferences.preferences || []);
          if (preferredSlug) {
            setScope(preferredSlug);
          }
        } catch {
          // The financial list remains usable without a saved default.
        }
      }
    } catch {
      setEntities([]);
      setStatus("unavailable");
    }
  }, [setScope]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<FinanceScopeValue>(() => ({
    scope,
    setScope,
    entities,
    status,
    activeLabel: activeScopeLabel(entities, scope),
    refresh,
  }), [entities, refresh, scope, setScope, status]);

  return <FinanceScopeContext.Provider value={value}>{children}</FinanceScopeContext.Provider>;
}

export function useFinanceScope(): FinanceScopeValue {
  const value = useContext(FinanceScopeContext);
  if (!value) throw new Error("useFinanceScope must be used inside FinanceScopeProvider");
  return value;
}

export function FinanceScopeBar({ unavailableMessage = true }: { unavailableMessage?: boolean }) {
  const { entities, scope, setScope, status } = useFinanceScope();
  if (status === "loading" || status === "not_installed") return null;
  if (status === "unavailable") {
    return unavailableMessage ? (
      <Attention>
        The business list could not be read, so this page cannot narrow the records. Each section below still says whether its own read succeeded.
      </Attention>
    ) : null;
  }
  return <ScopeBar entities={entities} value={scope} onChange={setScope} />;
}
