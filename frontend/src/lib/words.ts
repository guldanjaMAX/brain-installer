/** Every slug-to-English translation the app makes, in one file.
 *
 *  The plan calls this the words layer. It exists because the backend speaks in
 *  identifiers — `drive`, `curated`, `message`, `email_track` — and a client
 *  should never see one. Scattering these maps across screens is how the same
 *  source ends up called three different things on three pages. */

const SOURCE_LABELS: Record<string, string> = {
  curated: "Files you uploaded",
  drive: "Google Drive",
  message: "Messages",
  email: "Email",
  email_track: "Email",
  gmail: "Email",
  calendar: "Calendar",
  zoom: "Meeting recordings",
};

/** Never returns the slug. An unrecognised source is described, not named. */
export const sourceLabel = (slug: string | null | undefined): string =>
  (slug && SOURCE_LABELS[slug]) || "Another source";

/** A date the brain is unsure of must not be shown as if it were certain.
 *  `date_reliable` is false when the date was inferred rather than read. */
export function dateLabel(ts: string | null | undefined, reliable?: boolean): string | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const text = d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
  return reliable === false ? `around ${text}` : text;
}
