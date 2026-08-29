import { useCallback, useRef } from "react";
import { requestId } from "../lib/api";

/** One idempotency key per unchanged action.
 *
 * A response can disappear after the server commits. Keeping the key lets the
 * next click retrieve that receipt instead of creating a second write. A
 * material edit produces a different key; a confirmed receipt clears it. */
export class ActionRequestIds {
  private ids = new Map<unknown, string>();
  constructor(private prefix: string) {}
  forAction(key: unknown) {
    const existing = this.ids.get(key);
    if (existing) return existing;
    const next = requestId(this.prefix);
    this.ids.set(key, next);
    return next;
  }
  confirmed(key: unknown) { this.ids.delete(key); }
}

export function useActionRequests(prefix: string) {
  const ids = useRef<ActionRequestIds | null>(null);
  if (!ids.current) ids.current = new ActionRequestIds(prefix);
  const forAction = useCallback((key: unknown) => ids.current!.forAction(key), []);
  const confirmed = useCallback((key: unknown) => ids.current!.confirmed(key), []);
  return { forAction, confirmed };
}
