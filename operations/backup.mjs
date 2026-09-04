/**
 * `brain backup` — the owner's own copy of their brain, in one file.
 *
 * WHY THIS DID NOT EXIST. The machinery has been here for a while, inside the
 * recovery adapter, but it was built as an OPERATOR drill: prove we could
 * restore a client into a disposable target. It needs six explicit approval
 * flags because restoring is destructive. Nobody ever built the safe half, so
 * a client asking "can I back this up?" was told no, and on 2026-09-04 a
 * partner reached that conclusion independently and was repeating it.
 *
 * They were right about the symptom. `wrangler d1 export` refuses outright on
 * this schema:
 *
 *     D1 Export error: cannot export databases with Virtual Tables (fts5)
 *
 * and there is no flag around it. The way through is `--no-schema`, a
 * data-only export, which the recovery drill has always used. The search index
 * is FTS5 in external-content mode: it stores no copy of the text and is
 * rebuilt from the documents, so leaving it out loses nothing.
 *
 * This module is the safe half only. It reads, it writes one file, and it
 * never touches the brain's contents.
 */

/** Two things are deliberately absent from any artifact, and both are features. */
export const EXCLUDED_BY_DESIGN = Object.freeze([
  {
    what: "live sign-in material",
    why: "auth challenges, enrolment codes, OAuth tokens and bank link sessions are single use. A restored brain issues new ones, so a backup file cannot leak a way in.",
  },
  {
    what: "the search index",
    why: "it holds no copy of your text and is rebuilt from your documents, so copying it would only make the file bigger.",
  },
]);

/** The exact wrangler invocation. `--no-schema` is what gets past the FTS5 refusal. */
export function backupArgs({ databaseName, out, tables = [] }) {
  if (!databaseName) throw new Error("backup needs the database name");
  if (!out) throw new Error("backup needs an output path");
  return ["d1", "export", databaseName, "--remote", "--no-schema", "--output", out,
    ...tables.flatMap((t) => ["--table", t])];
}

/**
 * What the owner is told BEFORE anything runs.
 *
 * The unavailability warning is not boilerplate. Wrangler takes the database
 * offline while it exports and answers its own prompt yes in a script; on
 * 2026-09-04 a live brain returned 500 for about a minute during one. On a
 * shared screen that is a client watching their brain go dark with nobody able
 * to explain it.
 */
export function renderBackupPlan({ databaseName, out, tables = [], schemaVersion = null }) {
  const lines = [
    `This copies your brain's contents into one file: ${out}`,
    `  database        ${databaseName}`,
    `  tables          ${tables.length}`,
  ];
  if (schemaVersion != null) lines.push(`  schema version  ${schemaVersion}`);
  lines.push(
    "",
    "Not included, on purpose:",
    ...EXCLUDED_BY_DESIGN.map((e) => `  • ${e.what}: ${e.why}`),
    "",
    "While this runs your brain is briefly UNAVAILABLE. It comes back on its own,",
    "but do not run it during a call or a demo: on a shared screen it looks like",
    "the brain has broken.",
  );
  return lines.join("\n");
}

/**
 * A backup nobody can restore is a comfort, not a backup. The sidecar records
 * what a restore has to recreate first, because the export carries no schema.
 */
export function sidecarFor({ databaseName, schemaVersion, migrations = [], tables = [], bytes, productVersion, when }) {
  return {
    kind: "financial-brain-backup",
    taken_at: when,
    database_name: databaseName,
    product_version: productVersion ?? null,
    schema_version: schemaVersion ?? null,
    migration_count: migrations.length,
    highest_migration: migrations.length ? migrations[migrations.length - 1] : null,
    tables,
    bytes,
    contains_schema: false,
    restore_note:
      "Data only. A restore must create the schema first by applying the migrations up to " +
      `schema_version ${schemaVersion ?? "?"}, then load this file, then rebuild the search and vector indexes.`,
  };
}

/** Refuse to call an empty or absurdly small file a backup. */
export function verifyBackup({ bytes, tables = [] }, { minBytes = 512 } = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, reason: "the export produced no file" };
  }
  if (bytes < minBytes) {
    return { ok: false, reason: `the export is only ${bytes} bytes, which is too small to be a copy of ${tables.length} table(s)` };
  }
  return { ok: true, reason: `${bytes} bytes across ${tables.length} table(s)` };
}

export function renderBackupReceipt({ out, sidecar, verified }) {
  return [
    `Your brain's contents are in ${out}`,
    `  ${verified.reason}`,
    `  taken ${sidecar.taken_at}, schema version ${sidecar.schema_version ?? "unknown"}`,
    "",
    "Keep it somewhere you would keep a tax return. It contains your documents.",
    "",
    "What it is NOT: a one-click restore. Rebuilding a brain from this is a",
    "supervised job today, and the file records what has to happen first. Ask",
    "before you need it, not after.",
  ].join("\n");
}
