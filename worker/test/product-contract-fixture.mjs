/**
 * Real-SQLite fixture for the independent owner/security contract suite.
 *
 * The product code under test may live in another isolated worktree while the
 * QA harness is reviewed here. Set PRODUCT_CONTRACT_ROOT to that checkout and
 * every migration and Worker module is loaded from the target, not from this
 * branch. No private manifest, credential, account, or network service is used.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const QA_ROOT = resolve(HERE, "..", "..");

const moduleAt = (root, path) => import(pathToFileURL(join(root, path)).href);

export async function loadProduct(root = process.env.PRODUCT_CONTRACT_ROOT || QA_ROOT) {
  const productRoot = resolve(root);
  const [{ default: worker }, { mintSessionCookie }, brain] = await Promise.all([
    moduleAt(productRoot, "worker/src/index.js"),
    moduleAt(productRoot, "worker/src/lib/sessions.js"),
    moduleAt(productRoot, "brain.mjs"),
  ]);
  return {
    productRoot,
    worker,
    mintSessionCookie,
    splitStatements: brain.splitStatements,
    runRestartSafeMigrationStatements: brain.runRestartSafeMigrationStatements,
  };
}

export async function loadOwnerActions(root = process.env.PRODUCT_CONTRACT_ROOT || QA_ROOT) {
  return moduleAt(resolve(root), "worker/src/lib/owner-actions.js");
}

function execute(sqlite, sql, params, mode) {
  const statement = sqlite.prepare(sql);
  if (mode === "all") return { results: statement.all(...params) };
  if (mode === "first") return statement.get(...params) ?? null;
  const result = statement.run(...params);
  return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
}

function shouldFail(control, sql) {
  if (control.failEverything) return true;
  if (!control.failOn) return false;
  control.failOn.lastIndex = 0;
  return control.failOn.test(sql);
}

function prepared(sqlite, seen, control, sql, params = []) {
  return {
    sql,
    params,
    bind: (...next) => prepared(sqlite, seen, control, sql, next),
    all: async () => {
      seen.sql.push(sql); seen.binds.push(params);
      if (shouldFail(control, sql)) throw new Error("fixture database unavailable");
      return execute(sqlite, sql, params, "all");
    },
    first: async () => {
      seen.sql.push(sql); seen.binds.push(params);
      if (shouldFail(control, sql)) throw new Error("fixture database unavailable");
      return execute(sqlite, sql, params, "first");
    },
    run: async () => {
      seen.sql.push(sql); seen.binds.push(params);
      if (shouldFail(control, sql)) throw new Error("fixture database unavailable");
      return execute(sqlite, sql, params, "run");
    },
  };
}

function d1Binding(sqlite, seen, control) {
  return {
    prepare: (sql) => prepared(sqlite, seen, control, sql),
    async exec(sql) {
      seen.sql.push(sql); seen.binds.push([]);
      if (shouldFail(control, sql)) throw new Error("fixture database unavailable");
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(statements) {
      if (control.failEverything || control.failNextBatch) {
        control.failNextBatch = false;
        throw new Error("fixture database unavailable");
      }
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          seen.sql.push(statement.sql); seen.binds.push(statement.params || []);
          if (shouldFail(control, statement.sql)) throw new Error("fixture database unavailable");
          const readOnly = /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ||
            (/^\s*WITH\b/i.test(statement.sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(statement.sql));
          return execute(sqlite, statement.sql, statement.params || [], readOnly ? "all" : "run");
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export async function createProductFixture(options = {}) {
  const product = await loadProduct(options.productRoot);
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = join(product.productRoot, "migrations", "d1");
  const migrationFiles = readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    const source = readFileSync(join(migrationDir, file), "utf8");
    for (const sql of product.splitStatements(source)) sqlite.exec(sql);
  }

  const schemaVersion = Math.max(...migrationFiles.map((name) => Number.parseInt(name, 10)).filter(Number.isFinite));
  sqlite.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0-test', ?, 0, '2026-08-29T00:00:00Z', 'test')`,
  ).run(schemaVersion);

  const seen = { sql: [], binds: [], vectorQueries: [], vectorDeletes: [] };
  const control = {
    failEverything: false,
    failOn: null,
    failNextBatch: false,
    vectorQueryFails: false,
    vectorDrainFails: false,
  };
  const DB = d1Binding(sqlite, seen, control);
  const env = {
    STORAGE: "d1",
    DB,
    ADMIN_KEY: "fixture-admin-key",
    SESSION_SIGNING_KEY: "fixture-session-signing-key-0123456789",
    BRAIN_NAME: "Synthetic Contract Brain",
    BRAIN_OWNER: "Fixture Owner",
    VECTORIZE: {
      async query(_vector, query) {
        seen.vectorQueries.push(query);
        if (control.vectorQueryFails) throw new Error("fixture vector query unavailable");
        return { matches: [] };
      },
      async upsert(rows) {
        if (control.vectorDrainFails) throw new Error("fixture vector write unavailable");
        return { count: rows.length };
      },
      async deleteByIds(ids) {
        seen.vectorDeletes.push([...ids]);
        if (control.vectorDrainFails) throw new Error("fixture vector delete unavailable");
        return { count: ids.length };
      },
      async describe() { return { vectorCount: 0, processedUpToMutation: null }; },
    },
    AI: {
      async run(model) {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        return { response: "Synthetic grounded answer [1]." };
      },
    },
    ...(options.env || {}),
  };

  const raw = (sql, ...params) => sqlite.prepare(sql).run(...params);
  const rows = (sql, ...params) => sqlite.prepare(sql).all(...params);
  const first = (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null;

  const ownerHeaders = async (options = {}) => {
    const cookie = Object.keys(options).length
      ? await product.mintSessionCookie(env, 1, options)
      : await product.mintSessionCookie(env, 1);
    return { Cookie: cookie.split(";")[0], "X-Brain-App": "1" };
  };
  const waitUntil = [];
  const post = async (path, body = {}, headers = {}) => product.worker.fetch(
    new Request(`https://brain.invalid${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil(promise) { waitUntil.push(Promise.resolve(promise)); }, passThroughOnException() {} },
  );

  return {
    ...product,
    sqlite,
    migrationFiles,
    env,
    DB,
    seen,
    control,
    raw,
    rows,
    first,
    ownerHeaders,
    post,
    waitUntil,
    close: () => sqlite.close(),
  };
}

export function seedOwnedEntity(fixture, slug = "mesa-coffee", label = "Mesa Coffee") {
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, status, relationship,
        provenance, basis_state, recorded_at)
     VALUES ('primary', ?, ?, ?, 'business', 'active', 'owned',
             'owner_stated', 'confirmed', '2026-08-29T00:00:00Z')`,
    slug, `${label} LLC`, label,
  );
}

export function seedCounterparty(fixture, slug = "fixture-buyer") {
  fixture.raw(
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, status, relationship,
        provenance, basis_state, recorded_at)
     VALUES ('primary', ?, 'Fixture Buyer LLC', 'Fixture Buyer', 'business', 'active',
             'counterparty', 'owner_stated', 'confirmed', '2026-08-29T00:00:00Z')`,
    slug,
  );
}

export async function json(response) {
  const body = await response.json();
  return { response, body };
}
