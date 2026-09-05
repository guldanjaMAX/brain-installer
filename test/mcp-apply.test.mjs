/**
 * `brain mcp-config --apply` must actually connect, not print.
 *
 * Setup already wires both assistants at step 5, but a brain that is already
 * installed, or an assistant installed afterwards, had no path except a full
 * setup re-run or copying a printed command by hand. A printed command someone
 * has to retype is how a connected brain ends up unconnected.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { cmdMcpConfig } from "../brain.mjs";

// fileURLToPath, not .pathname: on Windows .pathname yields "/D:/a/..." and
// resolving that produces "D:\\D:\\a\\..." with a doubled drive letter.
const manifest = fileURLToPath(new URL("../templates/brain.manifest.json", import.meta.url));

// --apply routes to the reconciler and reports per assistant.
let sawArgs = null;
const result = await cmdMcpConfig(manifest, {
  flags: { apply: true },
  wireAgents: async (m, path) => {
    sawArgs = { slug: m?.client?.slug, path };
    return { wired: ["Claude Code", "Codex"], skipped: [], failures: [] };
  },
});
assert.deepEqual(result.wired, ["Claude Code", "Codex"]);
assert.equal(sawArgs.path, manifest, "the reconciler must receive the manifest it was given");

// A partial failure must stop loudly rather than report success.
await assert.rejects(
  cmdMcpConfig(manifest, {
    flags: { apply: true },
    wireAgents: async () => ({ wired: ["Claude Code"], skipped: [], failures: ["Codex"] }),
  }),
  /could not connect: Codex/,
);

// Neither assistant present is a statement, not a failure.
const none = await cmdMcpConfig(manifest, {
  flags: { apply: true },
  wireAgents: async () => ({ wired: [], skipped: [], failures: [] }),
});
assert.deepEqual(none.wired, []);

// An unknown flag is refused rather than silently ignored.
await assert.rejects(
  cmdMcpConfig(manifest, { flags: { aply: true }, wireAgents: async () => ({ wired: [], skipped: [], failures: [] }) }),
  /unknown option/,
);

console.log("brain mcp-config --apply connects both assistants, fails loudly, and refuses typos");
