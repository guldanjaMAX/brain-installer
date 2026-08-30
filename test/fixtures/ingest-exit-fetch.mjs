/*
 * Network fixture for the CLI exit-status regression in errors.test.mjs.
 *
 * Node loads this file with --import before brain.mjs, so every Cloudflare,
 * Worker and Google request remains in-process. The values below are inert test
 * labels, not credentials, and no request can leave this fixture unnoticed.
 */

import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const scenario = String(process.env.BRAIN_INGEST_EXIT_TEST || "");
if (!scenario) throw new Error("BRAIN_INGEST_EXIT_TEST is required");

// Redirect os.homedir() inside this test child only, before product modules are
// imported. This keeps both the support journal and the explicit Drive token
// fixture away from a developer's real user storage without changing a process
// home-directory variable.
const userRoot = String(process.env.BRAIN_INGEST_EXIT_USER_ROOT || "");
if (!userRoot) throw new Error("BRAIN_INGEST_EXIT_USER_ROOT is required");
os.homedir = () => userRoot;
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const requestUrl = (input) => new URL(
  typeof input === "string" || input instanceof URL ? String(input) : input.url
);

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "api.cloudflare.com" && url.pathname === "/client/v4/accounts") {
    return json({ success: true, result: [{ id: "fixture-account", name: "Fixture account" }] });
  }

  if (url.hostname === "api.cloudflare.com" && /\/d1\/database\/fixture-db\/query$/.test(url.pathname)) {
    const request = JSON.parse(String(options.body || "{}"));
    if (/^UPDATE sources SET status=/i.test(String(request.sql || "")) && request.params?.[0] === "error") {
      console.log("TEST_LOCAL_ERROR_RECEIPT_RECORDED");
    }
    return json({ success: true, result: [{ results: [], success: true }] });
  }

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: "fixture-next-cursor" });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    if (!String(url.searchParams.get("q") || "").includes("'fixture-root' in parents")) {
      throw new Error("Drive ingest attempted an unscoped account-wide listing");
    }
    return json({
      files: [{
        id: "fixture-file-one",
        name: "fixture-note.txt",
        mimeType: "text/plain",
        size: "128",
        createdTime: "2026-08-20T12:00:00.000Z",
        modifiedTime: "2026-08-20T12:00:00.000Z",
        md5Checksum: "fixture-revision",
        trashed: false,
        parents: ["fixture-root"],
        webViewLink: "https://drive.example/fixture-file-one",
      }],
      nextPageToken: null,
      incompleteSearch: false,
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/fixture-root") {
    return json({
      id: "fixture-root",
      name: "Reviewed Root",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/fixture-file-one") {
    return new Response(
      "This fixture note has enough ordinary prose to pass extraction quality and reach the ingest receipt boundary safely.",
      { status: 200, headers: { "content-type": "text/plain" } },
    );
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const docs = JSON.parse(String(options.body || "{}")).docs || [];
    const refused = scenario.endsWith("-refused");
    return json({
      created: 0,
      updated: 0,
      unchanged: 0,
      refused: refused ? docs.length : 0,
      failed: refused ? 0 : docs.length,
      results: docs.map((doc) => refused
        ? { source_id: doc.source_id, status: "refused", labels: ["synthetic_test_label"] }
        : { source_id: doc.source_id, status: "failed", error: "synthetic store failure" }),
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    return json({ dry_run: false, documents: 0, chunks: 0, vectors: 0, targets: [] });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = JSON.parse(String(options.body || "{}"));
    return json({ source: request.source, families: [], next_cursor: null });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = JSON.parse(String(options.body || "{}"));
    if (receipt.status === "error") {
      console.log(scenario.startsWith("drive")
        ? "TEST_REMOTE_ERROR_RECEIPT_RECORDED"
        : "TEST_LOCAL_ERROR_RECEIPT_RECORDED");
    }
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
