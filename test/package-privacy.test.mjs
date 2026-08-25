import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: ROOT,
  encoding: "utf-8",
  // Windows resolves npm through npm.cmd. Current Node releases require batch
  // files to run through the platform shell; every argument here is fixed.
  shell: process.platform === "win32",
  timeout: 60_000,
});

let files = [];
try {
  files = JSON.parse(packed.stdout)?.[0]?.files?.map((entry) => entry.path) || [];
} catch {
  // The failure below includes npm's own diagnostic without inventing a second
  // parse error that hides the useful cause.
}

const forbidden = files.filter((path) =>
  /(^|\/)(instances|eval\/baselines)(\/|$)/i.test(path) ||
  (/^eval\/golden\//i.test(path) && path !== "eval/golden/TEMPLATE.golden.json") ||
  /james|readiness|\.brain-(?:migration|ingest|drive-live-fixture)|brain-support-|support-bundle/i.test(path)
);
const required = [
  "brain.mjs",
  "components/brain-mcp.mjs",
  "components/brain-mcp-runtime.mjs",
  "connectors/google-auth.mjs",
  "manifest.schema.json",
  "operations/admin-key-file.mjs",
  "operations/admin-key-persistence.mjs",
  "operations/drive-scheduler.mjs",
  "support-journal.mjs",
  "templates/brain.manifest.json",
  "connectors/keychain-write.exp",
  "docs/README-developer.md",
];
const missing = required.filter((path) => !files.includes(path));

if (packed.status !== 0 || !files.length || forbidden.length || missing.length) {
  console.error("FAIL  published package privacy allowlist");
  if (packed.status !== 0) {
    console.error(
      String(packed.stderr || packed.stdout || packed.error?.message || "npm pack failed without a diagnostic").trim()
    );
  }
  if (!files.length) console.error("npm returned no packlist");
  if (forbidden.length) console.error(`private paths would ship: ${forbidden.join(", ")}`);
  if (missing.length) console.error(`required product paths are missing: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`PASS  published package contains ${files.length} reviewed files and no client-private paths`);
