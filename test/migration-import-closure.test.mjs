import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const loaderUrl = new URL("./fixtures/reject-extractor-imports.mjs", import.meta.url).href;
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
  "path", "systemroot", "windir", "comspec", "pathext",
  "temp", "tmp", "tmpdir", "lang", "lc_all", "lc_ctype", "tz",
].includes(key.toLowerCase())));

const runImport = (specifier) => spawnSync(process.execPath, [
  "--no-warnings",
  "--experimental-loader", loaderUrl,
  "--input-type=module",
  "--eval", `await import(${JSON.stringify(specifier)})`,
], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  env: cleanEnvironment,
});

// Negative controls prove the loader really rejects both forbidden boundaries.
for (const specifier of [new URL("../ingest/formats.mjs", import.meta.url).href, "fflate"]) {
  const result = runImport(specifier);
  assert.notEqual(result.status, 0, `guard unexpectedly allowed ${specifier}`);
  assert.match(result.stderr, /FORBIDDEN_EXTRACTOR_IMPORT/);
}

// The message migration transitively imports the general Supabase importer.
// Both entrypoints must remain usable when every extractor import is refused.
for (const relative of [
  "../migration/supabase-import.mjs",
  "../migration/supabase-message-sessions.mjs",
]) {
  const result = runImport(new URL(relative, import.meta.url).href);
  assert.equal(result.status, 0, `${relative} loaded an extractor:\n${result.stderr}`);
  assert.equal(result.stdout, "");
}

const shared = await import("../ingest/envelope-batching.mjs");
const ingest = await import("../ingest/run.mjs");
for (const name of ["MAX_DOC_CHARS", "batches", "envelopeBytes", "splitOversized"]) {
  assert.strictEqual(ingest[name], shared[name], `ingest/run.mjs did not preserve ${name}`);
}

console.log("migration import closure: extractor-free import and ingest API compatibility passed");
