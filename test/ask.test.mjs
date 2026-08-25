import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdAsk } from "../brain.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-ask-"));
try {
  const manifest = join(sandbox, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.example", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
  }));
  const seen = [];
  const adminKey = `fixture-${"k".repeat(40)}`;
  const result = await cmdAsk(manifest, {
    ask: async () => "What did the fixture decide?",
    adminKey,
    http: async (url, options) => {
      seen.push({ url, options });
      return new Response(JSON.stringify({
        answer: "It chose the safe path [1].",
        citations: [{ n: 1, title: "Fixture decision", source: "documents" }],
        gaps: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.answer, "It chose the safe path [1].");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://fixture.example/api/rag/think");
  assert.equal(seen[0].options.method, "POST");
  assert.equal(JSON.parse(seen[0].options.body).q, "What did the fixture decide?");
  assert.equal(seen[0].options.headers["X-Admin-Key"], adminKey);

  await assert.rejects(
    cmdAsk(manifest, { ask: async () => "", adminKey }),
    /no question entered/i,
  );
  console.log("brain ask: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
