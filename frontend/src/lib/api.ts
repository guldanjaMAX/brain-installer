// Every call carries X-Brain-App. It is the CSRF companion to the
// SameSite=Strict session cookie: the cookie proves who, this header proves
// the request came from this app rather than from a page that merely sits in
// the same browser.
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-App": "1" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  return data as T;
}

export type Citation = { n: number; title: string; source?: string; ts?: string | null };
export type Confidence = { percent: number; band: string; basis: string[] };
export type Answer = {
  answer: string | null;
  answer_error?: string;
  // Set when the search itself did not complete. Distinct from a genuine
  // no-match, and the difference decides what the page is allowed to say.
  status?: string;
  degraded?: string;
  notice?: string;
  results?: unknown[];
  confidence?: Confidence;
  citations?: Citation[];
};
export type Device = {
  credential_id: string;
  nickname: string | null;
  created_at: number;
  last_used_at: number | null;
};
/** One app holding a live grant. Rows are per app, not per token: a connector
 *  refreshes routinely and an owner is asking about apps. */
export type Connection = {
  client_id: string;
  name: string;
  can_write: boolean;
  connected_at: number | null;
  last_used_at: number | null;
};
/** A bank the owner linked. Timestamps here are ISO strings, not epoch ms. */
export type BankConnection = {
  item_ref: string;
  institution_label: string | null;
  status: string;
  status_detail?: string | null;
  connected_at?: string | null;
  last_synced_at?: string | null;
};
export type BankStatus = {
  configured?: boolean;
  connections?: BankConnection[];
  needs_attention?: BankConnection[];
};
export type Me = {
  signed_in: boolean;
  owner: string;
  brain: string;
  devices: Device[];
  connections: Connection[];
};

/** GET companion to `api`. The bank feed answers status on GET; the same
 *  X-Brain-App header still marks the request as coming from this app. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { "X-Brain-App": "1" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  return data as T;
}
