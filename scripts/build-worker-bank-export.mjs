#!/usr/bin/env node

/** Bundle the shared bank-export reader into the raw Worker upload tree. */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "ingest", "bank-export.mjs");
const outputPath = resolve(root, "worker", "src", "lib", "bank-export.js");
const source = readFileSync(sourcePath, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const banner = [
  "// GENERATED FILE. Edit ingest/bank-export.mjs instead.",
  `// Entry SHA-256: ${sourceHash}; esbuild ${esbuildVersion}.`,
].join("\n");

const result = await build({
  entryPoints: [sourcePath],
  outfile: outputPath,
  write: false,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  banner: { js: banner },
  metafile: true,
});

if (result.outputFiles?.length !== 1) {
  throw new Error(`expected one generated Worker module, received ${result.outputFiles?.length || 0}`);
}
const generated = result.outputFiles[0].text;
const imports = Object.values(result.metafile?.outputs || {})
  .flatMap((output) => output.imports || [])
  .map((entry) => entry.path);
if (imports.length) {
  throw new Error(`generated Worker bank reader retained imports: ${[...new Set(imports)].join(", ")}`);
}

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(outputPath, "utf8"); } catch {}
  if (current !== generated) {
    console.error("worker/src/lib/bank-export.js is stale; run npm run build:worker-bank-export");
    process.exit(1);
  }
  console.log(`Worker bank reader is current (${generated.length} bytes, ${sourceHash.slice(0, 12)}).`);
} else {
  writeFileSync(outputPath, generated);
  console.log(`Wrote worker/src/lib/bank-export.js (${generated.length} bytes, ${sourceHash.slice(0, 12)}).`);
}
