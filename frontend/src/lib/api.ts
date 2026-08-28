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
  confidence?: Confidence;
  citations?: Citation[];
};
export type Device = {
  credential_id: string;
  nickname: string | null;
  created_at: number;
  last_used_at: number | null;
};
export type Me = { signed_in: boolean; owner: string; brain: string; devices: Device[] };
