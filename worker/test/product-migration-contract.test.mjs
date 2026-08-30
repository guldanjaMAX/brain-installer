/**
 * Restart and append-only acceptance for the product-gap migrations.
 *
 * This is intentionally real SQLite. A mocked D1 object cannot prove that a
 * half-applied migration resumes, that triggers exist, or that evidence rows
 * physically refuse mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadProduct } from "./product-contract-fixture.mjs";

const ROOT = process.env.PRODUCT_CONTRACT_ROOT;

function schemaSignature(db) {
  return db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all();
}

async function migrationContext() {
  const product = await loadProduct(ROOT);
  const dir = join(product.productRoot, "migrations", "d1");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const statements = new Map(files.map((name) => [
    name,
    product.splitStatements(readFileSync(join(dir, name), "utf8")),
  ]));
  return { ...product, files, statements };
}

function freshBefore(context, target) {
  const db = new DatabaseSync(":memory:");
  for (const name of context.files) {
    if (name === target) break;
    for (const sql of context.statements.get(name)) db.exec(sql);
  }
  return db;
}

function apply(db, statements) {
  for (const sql of statements) db.exec(sql);
}

function queryFor(db) {
  return async (sql) => {
    if (/^\s*PRAGMA\s+table_info/i.test(sql)) {
      return { results: db.prepare(sql).all() };
    }
    db.exec(sql);
    return { results: [] };
  };
}

function addedColumn(statement) {
  const match = String(statement).match(
    /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  return match ? { table: match[1], column: match[2], type: match[3].toUpperCase() } : null;
}

test("owner and security migrations resume after every statement boundary", async () => {
  const context = await migrationContext();
  const targets = (process.env.PRODUCT_CONTRACT_MIGRATIONS || [
    "0021_owner_workspace.sql",
    "0022_document_access_passkey_observability.sql",
  ].join(",")).split(",").map((name) => name.trim()).filter(Boolean);

  for (const target of targets) {
    assert.ok(context.statements.has(target), `${target} must be present in the integrated candidate`);
    const statements = context.statements.get(target);
    assert.ok(statements.length > 0, `${target} must not be empty`);

    const clean = freshBefore(context, target);
    await context.runRestartSafeMigrationStatements(statements, queryFor(clean));
    const expected = schemaSignature(clean);

    for (let boundary = 0; boundary < statements.length; boundary++) {
      const interrupted = freshBefore(context, target);
      await assert.rejects(
        context.runRestartSafeMigrationStatements(statements, queryFor(interrupted), {
          afterStatement: ({ index }) => {
            if (index === boundary) throw new Error(`synthetic crash after ${index}`);
          },
        }),
        /synthetic crash/,
      );
      await assert.doesNotReject(
        context.runRestartSafeMigrationStatements(statements, queryFor(interrupted)),
        `${target} must restart after committed statement ${boundary + 1}/${statements.length}`,
      );
      assert.deepEqual(
        schemaSignature(interrupted),
        expected,
        `${target} restart at statement ${boundary + 1} must converge to the clean schema`,
      );
      interrupted.close();
    }

    // The production runner owns ALTER ADD COLUMN replay. Every other
    // statement still has to be intrinsically idempotent because D1 commits it
    // independently and the runner cannot introspect its side effects.
    for (const statement of statements.filter((sql) => !addedColumn(sql))) {
      assert.doesNotThrow(() => clean.exec(statement), `${target} non-ALTER statement must replay safely`);
    }
    assert.deepEqual(schemaSignature(clean), expected);
    clean.close();

    for (const descriptor of statements.map(addedColumn).filter(Boolean)) {
      const incompatible = freshBefore(context, target);
      incompatible.exec(
        `ALTER TABLE ${descriptor.table} ADD COLUMN ${descriptor.column} ${descriptor.type === "INTEGER" ? "TEXT" : "INTEGER"}`,
      );
      await assert.rejects(
        context.runRestartSafeMigrationStatements(statements, queryFor(incompatible)),
        /incompatible schema/,
        `${target} must hard-stop when ${descriptor.table}.${descriptor.column} already has the wrong contract`,
      );
      incompatible.close();
    }
  }
});

test("owner activity and approvals are physically append-only", async (t) => {
  const context = await migrationContext();
  if (!context.statements.has("0021_owner_workspace.sql")) {
    t.skip("focused security-migration run does not contain backend migration 0021");
    return;
  }
  const db = freshBefore(context, "0021_owner_workspace.sql");
  apply(db, context.statements.get("0021_owner_workspace.sql"));

  db.prepare(
    `INSERT INTO owner_activity_events
       (event_id, tenant_id, request_id, event_type, entity_slug, subject_kind,
        subject_id, display_label, occurred_at)
     VALUES (?, 'primary', ?, 'upload_completed', 'mesa-coffee', 'document', ?, ?, ?)`,
  ).run("evt-fixture", "req-fixture", "upload:fixture", "Fixture upload", "2026-08-29T00:00:00Z");
  db.prepare(
    `INSERT INTO owner_approvals
       (approval_id, tenant_id, request_id, approval_type, entity_slug,
        subject_uid, selected_claim_uid, resolution, note, recorded_at)
     VALUES (?, 'primary', ?, 'exception_resolution', 'mesa-coffee', ?, NULL, ?, NULL, ?)`,
  ).run("approval-fixture", "req-approval", "exception-fixture", "owner supplied", "2026-08-29T00:00:00Z");

  for (const [table, timestampColumn] of [
    ["owner_activity_events", "occurred_at"],
    ["owner_approvals", "recorded_at"],
  ]) {
    assert.throws(
      () => db.exec(`UPDATE ${table} SET ${timestampColumn} = '2026-08-30T00:00:00Z'`),
      /append-only/,
      `${table} must refuse UPDATE`,
    );
    assert.throws(
      () => db.exec(`DELETE FROM ${table}`),
      /append-only/,
      `${table} must refuse DELETE`,
    );
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1);
  }
  db.close();
});
