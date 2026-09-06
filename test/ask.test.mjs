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
  const printed = [];
  const adminKey = `fixture-${"k".repeat(40)}`;
  const originalLog = console.log;
  let result;
  console.log = (...args) => printed.push(args.join(" "));
  try {
    result = await cmdAsk(manifest, {
      ask: async () => "What did the fixture decide?",
      adminKey,
      http: async (url, options) => {
        seen.push({ url, options });
        return new Response(JSON.stringify({
          answer: "It chose the safe path [1].",
          citations: [{
            n: 1, title: "Fixture decision", source: "documents",
            ts: "2026-01-02T00:00:00.000Z", date_reliable: false,
            text_source: "ocr_partial", text_reliable: false,
            ref: "fixture-decision",
          }, {
            n: 2, title: "Legacy decision", source: "drive",
            ts: "2025-12-31T00:00:00.000Z",
          }],
          gaps: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.answer, "It chose the safe path [1].");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://fixture.example/api/rag/think");
  assert.equal(seen[0].options.method, "POST");
  assert.equal(JSON.parse(seen[0].options.body).q, "What did the fixture decide?");
  assert.equal(seen[0].options.headers["X-Admin-Key"], adminKey);
  assert.match(printed.join("\n"), /documents; possible date 2026-01-02; OCR text may be incomplete/);
  assert.match(printed.join("\n"), /reference documents:fixture-decision/);
  assert.match(printed.join("\n"), /Legacy decision \(drive; possible date 2025-12-31\)/,
    "a legacy citation without date_reliable must not be presented as confirmed");

  await assert.rejects(
    cmdAsk(manifest, { ask: async () => "", adminKey }),
    /no question entered/i,
  );
  console.log("brain ask: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
