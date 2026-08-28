/**
 * The Drive root allowlist — what a client's "connect Drive" is allowed to mean.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * Two very different things need the same rule and neither may drift from the
 * other: the connector, which interpolates a root id into a Drive `q`
 * expression, and the installer, which reads the manifest and fingerprints the
 * policy. The connector cannot be imported cheaply (it pulls the PDF and Office
 * readers with it), so the rule lives here, dependency-free, and both import it.
 *
 * WHAT THE ALLOWLIST IS, AND WHAT IT IS NOT
 *
 * With roots configured, the full Drive walk descends from those roots and
 * nowhere else. Google is never asked about anything outside them, so an
 * excluded file's name, path, size and id are never fetched and never enter the
 * installer. That is enforcement at the source, and it is a stronger statement
 * than the exclusion rules, which can only refuse a file whose metadata has
 * already been retrieved.
 *
 * It does NOT cover the incremental lane. Drive's changes feed is account-wide
 * and the API offers no subtree filter for it, so a change for a file outside
 * the allowlist WILL be delivered and has to be refused on arrival, after its
 * metadata has been seen. `isUnderRoots` is that second, weaker gate, and the
 * documentation says so rather than letting the source-side claim cover both.
 */

/**
 * Drive file ids, as the API actually issues them.
 *
 * The id is interpolated into a `q` expression, so anything that could close
 * the quote has to be refused rather than escaped. Google's ids are URL-safe
 * base64-ish; nothing legitimate falls outside this class.
 */
export const DRIVE_ID = /^[A-Za-z0-9_-]{6,256}$/;

/**
 * Normalise a configured root allowlist, refusing anything unusable.
 *
 * A bad entry STOPS the run. Dropping it quietly would change the scope of what
 * gets read, in the direction the operator cannot see, on the one setting whose
 * entire job is to bound what gets read.
 */
export function normalizeIncludeRootIds(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const out = [];
  for (const value of list) {
    const id = String(value ?? "").trim();
    if (!id) continue;
    if (!DRIVE_ID.test(id)) {
      throw new Error(
        "a Drive include_root_ids entry is not a Drive folder id, so the run was stopped rather than " +
        "reading a different scope than the one configured",
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Is this file inside the allowlist, judged from the folder index?
 *
 * Needed only for the incremental lane, for the reason in the header. A file
 * whose ancestry cannot be resolved from the index is NOT inside: an unknown
 * parent is unknown, and guessing in favour of ingest is the wrong way to be
 * wrong about a scope boundary. An empty allowlist means no boundary was
 * configured, so everything is inside it.
 */
export function isUnderRoots(file, folders = {}, rootIds = []) {
  const roots = new Set((rootIds || []).map(String).filter(Boolean));
  if (!roots.size) return true;
  const start = String(file?.id || "");
  if (start && roots.has(start)) return true;
  const seen = new Set();
  const queue = Array.isArray(file?.parents) ? file.parents.filter(Boolean).map(String) : [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (roots.has(id)) return true;
    const folder = folders?.[id];
    if (!folder) continue;
    for (const parent of folder.parents || []) {
      const next = String(parent);
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

/** One sentence an operator can read, saying exactly what this run may read. */
export function describeDriveScope(rootIds = []) {
  const roots = normalizeIncludeRootIds(rootIds);
  return roots.length
    ? `${roots.length} allowlisted Drive root(s); nothing outside them is requested from Google`
    : "NO Drive root allowlist is configured, so this run may read every file this Google account can see";
}
