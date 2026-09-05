import {
  api, listFiles, listRootedFiles, listChanges, startPageToken, triage, toEnvelope, DriveError, EXPORTS,
  updateFolderIndex, folderPathFor, exclusionReason, driveVersion, classifyScopedAbsence, FOLDER_MIME, EXPORT_LIMIT,
} from "../connectors/google-drive.mjs";
import { buildAuthUrl, pkce, exchangeCode, createTokenProvider, redirectUri } from "../connectors/google-auth.mjs";
import * as XLSX from "@e965/xlsx";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 240))); if (!c) fail++; };
const tok = async () => "at-1";
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
const bytes = (s, status = 200) => ({ ok: status < 400, status, json: async () => ({}), arrayBuffer: async () => new TextEncoder().encode(s).buffer });
const binary = (body, status = 200) => {
  const exact = Uint8Array.from(body);
  return { ok: status < 400, status, json: async () => ({}), arrayBuffer: async () => exact.buffer };
};
const workbookBytes = (sheets) => {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
};

/* ================= auth ================= */
{
  const { verifier, challenge } = pkce();
  check("PKCE verifier and challenge differ", verifier !== challenge && challenge.length > 30);
  const u = new URL(buildAuthUrl({ clientId: "cid", scopes: ["s1", "s2"], challenge, state: "st", port: 47811 }));
  check("asks for offline access", u.searchParams.get("access_type") === "offline");
  // Without prompt=consent a re-auth returns NO refresh token and the next
  // unattended run has nothing to refresh from.
  check("forces the consent screen, so a refresh token is issued", u.searchParams.get("prompt") === "consent");
  check("uses S256, not plain", u.searchParams.get("code_challenge_method") === "S256");
  check("redirects to loopback only", u.searchParams.get("redirect_uri") === "http://127.0.0.1:47811");
  check("carries state", u.searchParams.get("state") === "st");
  check("scopes are space separated", u.searchParams.get("scope") === "s1 s2");
}
{
  // A token response with no refresh_token must fail LOUDLY: it works for an
  // hour and then dies unattended, which is the worst way to find out.
  let threw = null;
  await exchangeCode({ clientId: "c", code: "x", verifier: "v", fetchImpl: async () => json({ access_token: "at", expires_in: 3600 }) })
    .catch((e) => (threw = e));
  check("a missing refresh token is refused at exchange time", !!threw && /refresh token/i.test(threw.message), threw?.message);
}
{
  let calls = 0;
  const get = createTokenProvider({ clientId: "c", refreshToken: "r", fetchImpl: async () => { calls++; return json({ access_token: "a" + calls, expires_in: 3600 }); } });
  check("first call fetches", (await get()) === "a1");
  check("second call is cached, not a second round trip", (await get()) === "a1" && calls === 1);
  check("force bypasses the cache", (await get({ force: true })) === "a2");
}
{
  // Several fetches in flight (the Gmail lane) notice an expired token at the
  // same moment. They must share ONE refresh, not fire eight.
  let calls = 0;
  const get = createTokenProvider({ clientId: "c", refreshToken: "r", fetchImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return json({ access_token: "shared" + calls, expires_in: 3600 }); } });
  const tokens = await Promise.all(Array.from({ length: 8 }, () => get()));
  check("eight concurrent callers share a single refresh round trip", calls === 1, `calls=${calls}`);
  check("and all eight receive the same token", tokens.every((v) => v === "shared1"), JSON.stringify(tokens));
  check("a later call after the shared refresh is still served from cache", (await get()) === "shared1" && calls === 1);
}
{
  // A token POST that connects but never answers used to hang forever: this was
  // the ONE Google call with no timeout, and on 2026-09-05 it stalled a real
  // Gmail sync for twelve minutes with nothing in the log. Every caller sharing
  // one refresh makes bounding it essential, not optional.
  const get = createTokenProvider({
    clientId: "c", refreshToken: "r", requestTimeoutMs: 40,
    fetchImpl: (_u, opts) => new Promise((_resolve, reject) => {
      // Never answers. Only the caller's own signal can end it.
      // The keepalive timer matters: AbortSignal.timeout() uses an UNREF'd
      // timer, so with nothing else pending the loop would simply drain and the
      // abort would never fire. A real request holds a socket, which is what
      // keeps the loop alive in production; this stands in for that socket.
      const keepalive = setTimeout(() => reject(new Error("test keepalive expired without an abort")), 5_000);
      opts?.signal?.addEventListener?.("abort", () => {
        clearTimeout(keepalive);
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    }),
  });
  const started = Date.now();
  let err = null;
  await get().catch((e) => (err = e));
  const waited = Date.now() - started;
  check("a token refresh that never answers times out instead of hanging", err !== null, "no error thrown");
  check("and it gives up near the configured bound, not minutes later", waited < 2000, `waited ${waited}ms`);
  check("and the message names the timeout rather than blaming the network", /did not answer within/.test(err?.message || ""), (err?.message || "").slice(0, 90));
  check("and it is marked retryable so the caller's retry budget applies", err?.retryable === true);
}
{
  // The shared-refresh dedupe must not turn one failure into a permanently
  // poisoned provider: the next caller has to be able to try again.
  let calls = 0;
  const get = createTokenProvider({
    clientId: "c", refreshToken: "r", requestTimeoutMs: 40,
    fetchImpl: async () => { calls++; if (calls === 1) throw new Error("transient"); return json({ access_token: "recovered", expires_in: 3600 }); },
  });
  let first = null;
  await get().catch((e) => (first = e));
  check("the first refresh fails", first !== null);
  check("a later call retries rather than replaying the failure", (await get()) === "recovered", `calls=${calls}`);
}
{
  // Concurrent callers must all be released when the shared refresh fails.
  // Waiting on a promise that only one of them observes is the hang this
  // whole block exists to prevent.
  const get = createTokenProvider({
    clientId: "c", refreshToken: "r", requestTimeoutMs: 40,
    fetchImpl: async () => { throw new Error("down"); },
  });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => get()));
  check("all six concurrent callers are released on a failed shared refresh", results.every((r) => r.status === "rejected"), JSON.stringify(results.map((r) => r.status)));
}
{
  const get = createTokenProvider({ clientId: "c", refreshToken: "dead", fetchImpl: async () => json({ error: "invalid_grant" }, 400) });
  let e = null;
  await get().catch((x) => (e = x));
  check("a dead refresh token is flagged for re-auth, not retried", e?.needsReauth === true);
  check("and the message names the 7-day Testing trap", /Testing/.test(e.message), e.message.slice(0, 90));
}

/* ================= retry policy ================= */
{
  let n = 0;
  const fetchImpl = async () => { n++; return n < 3 ? json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403) : json({ files: [] }); };
  const r = await api(tok, "/files", { fetchImpl, sleep: async () => {} });
  check("403 rateLimitExceeded is retried", n === 3 && !!r, String(n));
}
{
  let n = 0;
  const fetchImpl = async () => { n++; return json({ error: { errors: [{ reason: "insufficientFilePermissions" }], message: "no access" } }, 403); };
  let e = null;
  await api(tok, "/files", { fetchImpl, sleep: async () => {} }).catch((x) => (e = x));
  // A permission 403 retried five times is five identical failures and a long
  // silence. It must fail on the first.
  check("403 for a permission problem fails FAST", n === 1 && e instanceof DriveError, `${n} attempts`);
  check("and reports the reason", e.reason === "insufficientFilePermissions", e.reason);
}
{
  let n = 0;
  const fetchImpl = async () => { n++; return n < 2 ? json({}, 500) : json({ files: [] }); };
  await api(tok, "/files", { fetchImpl, sleep: async () => {} });
  check("5xx is retried", n === 2);
}
{
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n < 3) throw new TypeError("temporary socket reset");
    return json({ files: [] });
  };
  await api(tok, "/files", { fetchImpl, sleep: async () => {} });
  check("network exceptions are retried", n === 3, String(n));
}
{
  let n = 0, sawTimeoutSignal = false;
  const body = await api(tok, "/files/x", {
    raw: true,
    fetchImpl: async (_url, init) => {
      n++;
      sawTimeoutSignal ||= !!init.signal;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => {
          if (n === 1) throw new TypeError("response stream reset");
          return new TextEncoder().encode("complete").buffer;
        },
      };
    },
    sleep: async () => {},
  });
  check("response-body network failures are retried", n === 2 && new TextDecoder().decode(body) === "complete", String(n));
  check("each Google request carries an unattended-run timeout", sawTimeoutSignal);
}
{
  let n = 0, e = null;
  await api(tok, "/files", {
    attempts: 2,
    fetchImpl: async () => { n++; throw new TypeError("host unavailable"); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted network failure stays fatal", n === 2 && e instanceof DriveError && e.retryable === true && e.reason === "networkError", `${n} ${e?.reason}`);
}
{
  const tokenCalls = [];
  let requests = 0;
  const getToken = async (opts) => { tokenCalls.push(opts); return opts.force ? "fresh" : "stale"; };
  const result = await api(getToken, "/files", {
    fetchImpl: async (_url, init) => {
      requests++;
      return init.headers.authorization === "Bearer stale"
        ? json({ error: { message: "expired" } }, 401)
        : json({ files: [] });
    },
    sleep: async () => {},
  });
  check("a 401 forces one access-token refresh", requests === 2 && tokenCalls[0].force === false && tokenCalls[1].force === true && !!result, JSON.stringify(tokenCalls));
}
{
  let tokens = 0, requests = 0, e = null;
  await api(async () => { tokens++; return "bad"; }, "/files", {
    fetchImpl: async () => { requests++; return json({ error: { message: "still unauthorized" } }, 401); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("a second 401 is fatal instead of becoming a skip", tokens === 2 && requests === 2 && e instanceof DriveError && e.status === 401, `${tokens}/${requests} ${e?.status}`);
}
{
  const tokenCalls = [];
  let fresh = false, requests = 0;
  await api(async ({ force }) => {
    tokenCalls.push(force);
    if (force) fresh = true;
    return fresh ? "fresh" : "stale";
  }, "/files", {
    fetchImpl: async () => {
      requests++;
      if (requests === 1) return json({ error: { message: "expired" } }, 401);
      if (requests === 2) return json({ error: { message: "temporary backend" } }, 503);
      return json({ files: [] });
    },
    sleep: async () => {},
  });
  check("a refreshed token is not minted again for an unrelated 5xx retry",
    tokenCalls.join(",") === "false,true,false", tokenCalls.join(","));
}
{
  let tokenCalls = 0;
  const getToken = async () => {
    tokenCalls++;
    if (tokenCalls < 3) throw new TypeError("token endpoint unavailable");
    return "fresh";
  };
  await api(getToken, "/files", { fetchImpl: async () => json({ files: [] }), sleep: async () => {} });
  check("transient token-provider failures are retried", tokenCalls === 3, String(tokenCalls));
}
{
  let tokenCalls = 0, e = null;
  const dead = Object.assign(new Error("reconnect required"), { needsReauth: true });
  await api(async () => { tokenCalls++; throw dead; }, "/files", {
    fetchImpl: async () => json({ files: [] }), sleep: async () => {},
  }).catch((x) => (e = x));
  check("a revoked refresh token is immediately fatal", tokenCalls === 1 && e === dead, `${tokenCalls} ${e?.message}`);
}

/* ================= listing ================= */
{
  const pages = [
    { files: [{ id: "1", name: "a.md" }], nextPageToken: "p2" },
    { files: [{ id: "2", name: "b.md" }] },
  ];
  let i = 0, seen = [];
  const fetchImpl = async (url) => { seen.push(url); return json(pages[i++]); };
  const out = [];
  for await (const f of listFiles(tok, { opts: { fetchImpl, sleep: async () => {} } })) out.push(f.id);
  check("pagination follows nextPageToken", out.join(",") === "1,2", out.join(","));
  const u = new URL(seen[0]);
  // Without all three, files on Shared Drives are invisible and the walk
  // silently returns only My Drive.
  check("shared drives are included", u.searchParams.get("includeItemsFromAllDrives") === "true" &&
    u.searchParams.get("supportsAllDrives") === "true" && u.searchParams.get("corpora") === "allDrives",
    u.search);
  check("the all-drives walk requests Google's incomplete-search signal",
    /incompleteSearch/.test(u.searchParams.get("fields") || ""), u.searchParams.get("fields"));
  check("trashed files are excluded by default", /trashed = false/.test(u.searchParams.get("q") || ""));
}
{
  const yielded = [];
  let error = null;
  try {
    for await (const file of listFiles(tok, {
      opts: { fetchImpl: async () => json({ files: [{ id: "partial" }], incompleteSearch: true }), sleep: async () => {} },
    })) yielded.push(file.id);
  } catch (caught) {
    error = caught;
  }
  check("an incomplete all-drives search aborts before absence can drive deletion",
    yielded.length === 0 && error instanceof DriveError && error.reason === "incompleteSearch",
    `${yielded.join(",")} ${error?.message || "no error"}`);
}

/* ================= changes feed ================= */
{
  const pages = [
    { changes: [{ fileId: "a", file: { id: "a", name: "a.md" } }, { fileId: "b", removed: true }], nextPageToken: "p2" },
    { changes: [{ fileId: "c", file: { id: "c", name: "c.md", trashed: true } }], newStartPageToken: "T99" },
  ];
  let i = 0;
  const r = await listChanges(tok, "T1", { fetchImpl: async () => json(pages[i++]), sleep: async () => {} });
  check("changed files are collected", r.changed.map((f) => f.id).join(",") === "a", JSON.stringify(r.changed));
  check("removed files are reported", r.removed.includes("b"));
  // Trashing is how deletion usually looks. Treating it as a change would leave
  // the brain answering from a document the client believes they deleted.
  check("a trashed file counts as removed, not changed", r.removed.includes("c"), JSON.stringify(r));
  check("the next token is returned for the following run", r.nextToken === "T99");
}

/* ================= authoritative root boundary ================= */
{
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    const id = decodeURIComponent(url.pathname.split("/").pop());
    if (url.pathname !== "/drive/v3/files") {
      if (id === "root-a") return json({ id, name: "Approved", mimeType: FOLDER_MIME, parents: ["my-drive"] });
      if (id === "shared-root") return json({ id, name: "Shared Approved", mimeType: FOLDER_MIME, driveId: "shared-1" });
      return json({ error: { message: "not found" } }, 404);
    }
    const q = url.searchParams.get("q") || "";
    if (q.includes("'root-a' in parents")) return json({ files: [
      { id: "inside-a", name: "inside.txt", mimeType: "text/plain", parents: ["root-a"] },
      { id: "nested", name: "Nested", mimeType: FOLDER_MIME, parents: ["root-a"] },
      { id: "shortcut-out", name: "Outside shortcut", mimeType: "application/vnd.google-apps.shortcut",
        parents: ["root-a"], shortcutDetails: { targetId: "outside-secret", targetMimeType: "text/plain" } },
    ] });
    if (q.includes("'nested' in parents")) return json({ files: [
      { id: "inside-nested", name: "nested.txt", mimeType: "text/plain", parents: ["nested"] },
    ] });
    if (q.includes("'shared-root' in parents")) return json({ files: [
      { id: "inside-shared", name: "shared.txt", mimeType: "text/plain", parents: ["shared-root"], driveId: "shared-1" },
    ] });
    return json({ files: [{ id: "outside-secret", name: "must-not-appear.txt" }] });
  };
  const files = [];
  for await (const file of listRootedFiles(tok, {
    rootFolderIds: ["shared-root", "root-a", "root-a"],
    opts: { fetchImpl, sleep: async () => {} },
  })) files.push(file);
  const ids = files.map((file) => file.id).sort();
  check("root traversal includes nested files under every reviewed root",
    ["inside-a", "inside-nested", "inside-shared", "nested", "root-a", "shared-root", "shortcut-out"]
      .every((id) => ids.includes(id)), ids.join(","));
  check("an unrelated visible file is excluded by construction", !ids.includes("outside-secret"), ids.join(","));
  check("every listing is a direct-parent query rather than an account sweep",
    calls.filter((url) => url.pathname === "/drive/v3/files").every((url) => / in parents/.test(url.searchParams.get("q") || "")));
  check("Shared Drive traversal keeps allDrives support on every child query",
    calls.filter((url) => url.pathname === "/drive/v3/files").every((url) =>
      url.searchParams.get("corpora") === "allDrives" &&
      url.searchParams.get("includeItemsFromAllDrives") === "true" &&
      url.searchParams.get("supportsAllDrives") === "true"));
  check("a shortcut is observed but its out-of-scope target is never followed",
    calls.every((url) => !url.pathname.endsWith("/outside-secret")) &&
      triage(files.find((file) => file.id === "shortcut-out")).skipCode === "shortcut_not_followed");
  check("root provenance names the exact reviewed root on every file",
    files.find((file) => file.id === "inside-shared").scope_root_ids.join(",") === "shared-root" &&
      files.find((file) => file.id === "inside-nested").scope_root_ids.join(",") === "root-a");
}
{
  let error = null;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/root")) return json({ id: "root", name: "Root", mimeType: FOLDER_MIME });
    return json({ files: [], nextPageToken: "same-token" });
  };
  try {
    for await (const _file of listRootedFiles(tok, {
      rootFolderIds: ["root"], opts: { fetchImpl, sleep: async () => {} },
    })) { /* collect only after the complete traversal */ }
  } catch (caught) { error = caught; }
  check("a repeated rooted pagination cursor is refused before yielding partial scope",
    error instanceof DriveError && error.reason === "repeatedPageToken", error?.message);
}
{
  let error = null, yielded = 0;
  try {
    for await (const _file of listRootedFiles(tok, {
      rootFolderIds: ["revoked-root"],
      opts: { fetchImpl: async () => json({ error: { message: "not found" } }, 404), sleep: async () => {} },
    })) yielded++;
  } catch (caught) { error = caught; }
  check("a missing or permission-lost root is unavailable, never an empty authoritative corpus",
    yielded === 0 && error instanceof DriveError && error.reason === "rootUnavailable", error?.message);
}
{
  const scopedFolderIds = new Set(["root", "nested"]);
  const classify = (body, status = 200) => classifyScopedAbsence(tok, "old", {
    scopedFolderIds,
    opts: { fetchImpl: async () => json(body, status), sleep: async () => {} },
  });
  const moved = await classify({ id: "old", name: "old.txt", parents: ["outside"] });
  const trashed = await classify({ id: "old", name: "old.txt", parents: ["root"], trashed: true });
  const ambiguous = await classify({ error: { message: "not found" } }, 404);
  const inconsistent = await classify({ id: "old", name: "old.txt", parents: ["nested"] });
  check("a visible move out of scope is authoritative removal evidence", moved.kind === "left_scope");
  check("visible trash is authoritative deletion evidence", trashed.kind === "source_deleted");
  check("permission loss is not guessed to be hard deletion", ambiguous.kind === "unresolved" && ambiguous.retryable);
  check("an item still parented inside scope but missing from the walk blocks tombstones",
    inconsistent.kind === "unresolved" && inconsistent.retryable);
}
{
  const t = await startPageToken(tok, { fetchImpl: async () => json({ startPageToken: "T1" }), sleep: async () => {} });
  check("a start token can be fetched before the first walk", t === "T1");
}

/* ================= triage ================= */
{
  check("a folder is neither indexed nor an error", triage({ mimeType: "application/vnd.google-apps.folder" }).folder === true);
  check("a Google Doc is exported, not downloaded", triage({ mimeType: "application/vnd.google-apps.document", name: "x" }).export.mime === "text/plain");
  const sheetPlan = triage({ mimeType: "application/vnd.google-apps.spreadsheet", name: "x" }).export;
  check("a Sheet exports as one XLSX workbook so every tab survives",
    sheetPlan.mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" && sheetPlan.ext === ".xlsx",
    JSON.stringify(sheetPlan));
  check("a Google Form is skipped with a reason", /cannot be exported/.test(triage({ mimeType: "application/vnd.google-apps.form", name: "f" }).skip));
  check("an unsupported Google type has a stable skip code",
    triage({ mimeType: "application/vnd.google-apps.form", name: "f" }).skipCode === "unsupported_google_type");
  check("an image is skipped before spending a request", /carries no text/.test(triage({ mimeType: "image/png", name: "a.png" }).skip));
  check("a no-text media skip is typed", triage({ mimeType: "image/png", name: "a.png" }).skipCode === "non_text_media");
  check("an unsupported extension is skipped", /no extractor/.test(triage({ mimeType: "application/octet-stream", name: "a.bin" }).skip));
  check("an unsupported extension skip is typed",
    triage({ mimeType: "application/octet-stream", name: "a.bin" }).skipCode === "unsupported_extension");
  check("a PDF is downloaded", triage({ mimeType: "application/pdf", name: "a.pdf", size: "1000" }).download === true);
  check("an oversized file is skipped with its size", /over the/.test(triage({ mimeType: "application/pdf", name: "a.pdf", size: String(99 * 1048576) }).skip));
  check("an oversized-file skip is typed",
    triage({ mimeType: "application/pdf", name: "a.pdf", size: String(99 * 1048576) }).skipCode === "download_limit");
  check("trashed is skipped", /trash/.test(triage({ trashed: true, name: "a.md" }).skip));
}

/* ================= envelope ================= */
{
  const folders = updateFolderIndex([
    { id: "root-child", name: "Provider Records", mimeType: "application/vnd.google-apps.folder", parents: ["unknown-root"] },
    { id: "year", name: "2025", mimeType: "application/vnd.google-apps.folder", parents: ["root-child"] },
  ]);
  const file = { id: "F-path", name: "Visit.txt", parents: ["year"] };
  check("folder paths are reconstructed after the unordered walk", folderPathFor(file, folders) === "Provider Records/2025", folderPathFor(file, folders));
  const beforeMove = driveVersion({ ...file, modifiedTime: "2026-08-23T00:00:00Z", md5Checksum: "same-bytes" }, "Provider Records/2025");
  const afterMove = driveVersion({ ...file, modifiedTime: "2026-08-23T00:00:00Z", md5Checksum: "same-bytes" }, "Archive/Provider Records/2025");
  check("an ancestor-folder move changes the stable Drive version", beforeMove !== afterMove, `${beforeMove} ${afterMove}`);
  check("equivalent path separators do not cause a false version change",
    driveVersion(file, " Provider Records\\2025/ ") === driveVersion(file, "Provider Records/2025"));
  check("an exact reviewed file id is excluded", /file-id policy/.test(exclusionReason({ id: "F1", name: "x.txt" }, "", { excludeFileIds: ["F1"] })));
  check("path exclusions match segment boundaries", !!exclusionReason(file, "Legal/Sealed", { excludePaths: ["Legal/Sealed"] }));
  check("path exclusions do not overmatch sibling names", exclusionReason(file, "Legal/Sealed Notes", { excludePaths: ["Legal/Sealed"] }) === null);
  check("private prefixes apply to Drive path segments", /private path/.test(exclusionReason(file, "Clients/_private", { privatePrefixes: ["_private"] })));
  check("Drive private prefixes match the local walker's starts-with contract",
    /private path/.test(exclusionReason(file, "Clients/_private-legal", { privatePrefixes: ["_private"] })));
}
{
  const file = { id: "F1", name: "2026-03-14 board notes.txt", mimeType: "text/plain", size: "400",
    createdTime: "2020-01-01T00:00:00Z", modifiedTime: "2026-08-17T00:00:00Z", md5Checksum: "abc", webViewLink: "https://drive/F1" };
  const body = "The board agreed to defer the retainer increase until the following quarter, pending the coverage review.";
  const r = await toEnvelope(tok, file, {}, { fetchImpl: async () => bytes(body), sleep: async () => {} });
  check("a text file becomes an envelope", !!r.envelope, JSON.stringify(r.skip));
  check("the envelope carries the bare Drive id", r.envelope.source_id === "F1", r.envelope.source_id);
  check("the store namespaces that id exactly once, matching migration identity",
    `${r.envelope.source_type}:${r.envelope.source_id}` === "drive:F1", `${r.envelope.source_type}:${r.envelope.source_id}`);
  // modifiedTime here is 2026; createdTime is 2020; the FILENAME says 2026-03-14.
  check("the filename date wins over Drive metadata", r.envelope.occurred_at.startsWith("2026-03-14"), r.envelope.occurred_at);
  check("and it records where the date came from", r.envelope.date_source === "filename");
  check("modifiedTime is used only as a change signal", r.version.includes("2026-08-17") && !r.envelope.occurred_at.includes("2026-08-17"));
  check("the web link is kept for citations", r.envelope.uri === "https://drive/F1");
}
{
  const file = { id: "F-provenance", name: "notes.txt", mimeType: "text/plain", size: "400",
    createdTime: "2020-01-01T00:00:00Z", scope_root_ids: ["root-b", "root-a"] };
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async () => bytes("A rooted Drive document with enough readable content for deterministic provenance testing."),
    sleep: async () => {},
  });
  check("the ingest envelope preserves exact reviewed-root provenance",
    r.envelope.metadata.root_folder_ids.join(",") === "root-a,root-b", JSON.stringify(r.envelope.metadata));
}
{
  const file = { id: "F-folder", name: "visit.txt", mimeType: "text/plain", size: "400",
    createdTime: "2020-01-01T00:00:00Z", parents: ["medical"] };
  const r = await toEnvelope(tok, file, { pathOf: () => "Provider Records/2025" }, {
    fetchImpl: async () => bytes("A readable provider visit record with enough substance to pass the quality floor."), sleep: async () => {},
  });
  check("Drive envelopes preserve their folder for filtering", r.envelope.metadata.top_folder === "Provider Records", JSON.stringify(r.envelope.metadata));
  check("Drive envelopes identify their platform", r.envelope.metadata.platform === "drive");
}
{
  // No filename date: createdTime is used, NOT modifiedTime. Storing modifiedTime
  // as the document date is what once made 80% of a corpus look current.
  const file = { id: "F2", name: "notes.txt", mimeType: "text/plain", size: "300",
    createdTime: "2019-05-02T00:00:00Z", modifiedTime: "2026-08-17T00:00:00Z" };
  const r = await toEnvelope(tok, file, {}, { fetchImpl: async () => bytes("A note with enough text in it to pass the quality floor comfortably."), sleep: async () => {} });
  check("falls back to createdTime, never modifiedTime", r.envelope.occurred_at.startsWith("2019-05-02"), r.envelope.occurred_at);
  check("and says so", r.envelope.date_source === "drive_created");
}
{
  const file = { id: "F3", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", size: "500", createdTime: "2026-01-01T00:00:00Z" };
  let exported = null;
  const workbook = workbookBytes([
    ["Accounts", [["Account", "Balance"], ["Checking", 15234.11]]],
    ["Forecast", [["Quarter", "Projected Revenue"], ["Q4", 98250]]],
  ]);
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async (url) => { exported = url; return binary(workbook); }, sleep: async () => {},
  });
  check("a native Sheet requests Google's whole-workbook XLSX export",
    new URL(exported).searchParams.get("mimeType") === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    String(exported));
  check("content from the first worksheet remains retrievable",
    /Sheet: Accounts \(Budget\.xlsx\)/.test(r.envelope?.content || "") && /Account: Checking/.test(r.envelope?.content || ""),
    r.envelope?.content);
  check("content from a second worksheet remains retrievable",
    /Sheet: Forecast \(Budget\.xlsx\)/.test(r.envelope?.content || "") && /Quarter: Q4/.test(r.envelope?.content || ""),
    r.envelope?.content);
  check("a complete multi-tab workbook is not mislabeled incomplete",
    r.incomplete !== true && r.envelope?.metadata?.extraction_incomplete !== true, JSON.stringify(r));
}
{
  const file = { id: "F3-tiny", name: "A", mimeType: "application/vnd.google-apps.spreadsheet", size: "100", createdTime: "2026-01-01T00:00:00Z" };
  const tiny = workbookBytes([["S", [["x"]]]]);
  const r = await toEnvelope(tok, file, {}, { fetchImpl: async () => binary(tiny), sleep: async () => {} });
  check("a workbook with too little useful text is refused by the normal quality gate",
    r.skip?.code === "quality_refused" && !r.envelope, JSON.stringify(r));
}
{
  const file = { id: "F3-corrupt", name: "Broken", mimeType: "application/vnd.google-apps.spreadsheet", size: "100", createdTime: "2026-01-01T00:00:00Z" };
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async () => binary(Buffer.from("this is not an XLSX workbook")), sleep: async () => {},
  });
  check("a corrupt workbook is an explicit extraction refusal, never a green empty Sheet",
    r.skip?.code === "extraction_refused" && !r.envelope, JSON.stringify(r));
}
{
  let fetched = false;
  const file = {
    id: "F3-oversized", name: "Huge", mimeType: "application/vnd.google-apps.spreadsheet",
    size: String(EXPORT_LIMIT + 1), createdTime: "2026-01-01T00:00:00Z",
  };
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async () => { fetched = true; return binary(new Uint8Array()); }, sleep: async () => {},
  });
  check("an export beyond Google's byte ceiling is refused before downloading",
    fetched === false && r.skip?.code === "file_unavailable" && /export limit/.test(r.skip?.reason || ""), JSON.stringify(r));
}
{
  const file = { id: "F4", name: "junk.txt", mimeType: "text/plain", size: "50", createdTime: "2026-01-01T00:00:00Z" };
  const r = await toEnvelope(tok, file, {}, { fetchImpl: async () => bytes("hi"), sleep: async () => {} });
  check("a file with too little text is skipped, not indexed empty", !!r.skip && !r.envelope, JSON.stringify(r));
  check("and the skip carries the Drive id so it can be chased", r.skip.id === "F4");
  check("a quality refusal carries its stable policy code", r.skip.code === "quality_refused", JSON.stringify(r.skip));
}
{
  const file = { id: "F5", name: "locked.pdf", mimeType: "application/pdf", size: "1000", createdTime: "2026-01-01T00:00:00Z" };
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async () => json({ error: { errors: [{ reason: "insufficientFilePermissions" }], message: "no access" } }, 403), sleep: async () => {},
  });
  check("a permanent per-file permission failure is a reasoned skip", !!r.skip && /could not be fetched/.test(r.skip.reason), r.skip?.reason);
  check("a permanent per-file permission failure is typed", r.skip.code === "file_unavailable", JSON.stringify(r.skip));
}
{
  const file = { id: "F5-export", name: "locked doc", mimeType: "application/vnd.google-apps.document", createdTime: "2026-01-01T00:00:00Z" };
  const r = await toEnvelope(tok, file, {}, {
    fetchImpl: async () => json({ error: { errors: [{ reason: "cannotExportFile" }], message: "This file cannot be exported by the user." } }, 403), sleep: async () => {},
  });
  check("a Google-native file the user cannot export is a reasoned per-file skip",
    !!r.skip && /cannot be exported by the user/.test(r.skip.reason), r.skip?.reason);
}
{
  const file = { id: "F6", name: "temporary.pdf", mimeType: "application/pdf", size: "1000", createdTime: "2026-01-01T00:00:00Z" };
  let calls = 0, e = null;
  await toEnvelope(tok, file, {}, {
    attempts: 2,
    fetchImpl: async () => { calls++; return json({ error: { message: "backend unavailable" } }, 503); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted file 5xx is fatal so the source cursor cannot advance", calls === 2 && e instanceof DriveError && e.status === 503 && e.retryable === true, `${calls} ${e?.status}`);
}
{
  const file = { id: "F7", name: "network.pdf", mimeType: "application/pdf", size: "1000", createdTime: "2026-01-01T00:00:00Z" };
  let calls = 0, e = null;
  await toEnvelope(tok, file, {}, {
    attempts: 2,
    fetchImpl: async () => { calls++; throw new TypeError("connection reset"); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted file network error is fatal so the source cursor cannot advance", calls === 2 && e instanceof DriveError && e.reason === "networkError", `${calls} ${e?.reason}`);
}
{
  const file = { id: "F8", name: "document.pdf", mimeType: "application/pdf", size: "1000", createdTime: "2026-01-01T00:00:00Z" };
  let e = null;
  await toEnvelope(tok, file, {}, {
    fetchImpl: async () => json({ error: { errors: [{ reason: "accessNotConfigured" }], message: "Drive API disabled" } }, 403),
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("a connector-wide 403 is fatal rather than silently skipping every file", e instanceof DriveError && e.reason === "accessNotConfigured", e?.reason);
}

/* ================= gmail ================= */
const gm = await import("../connectors/gmail.mjs");
{
  const q = gm.DEFAULT_QUERY;
  // Volume alone lets bulk mail dominate retrieval; in a previous corpus
  // newsletter HTML took the top six citations on a real client question.
  for (const c of ["promotions", "social", "forums", "updates"]) {
    check(`bulk mail category "${c}" is excluded by default`, q.includes(`-category:${c}`), q);
  }
  check("chats and drafts are excluded", q.includes("-in:chats") && q.includes("-in:drafts"));
  check("spam and trash are excluded", q.includes("-in:spam") && q.includes("-in:trash"));
}
{
  const pages = [{ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" }, { messages: [{ id: "m3" }] }];
  let i = 0;
  const out = [];
  for await (const id of gm.listMessages(tok, { opts: { fetchImpl: async () => json(pages[i++]), sleep: async () => {} } })) out.push(id);
  check("message listing paginates", out.join(",") === "m1,m2,m3", out.join(","));
}
{
  let i = 0;
  const out = [];
  for await (const id of gm.listMessages(tok, { max: 2, opts: { fetchImpl: async () => json({ messages: [{ id: "a" }, { id: "b" }, { id: "c" }] }), sleep: async () => {} } })) out.push(id);
  check("--limit stops the walk early", out.length === 2, out.join(","));
}
{
  const raw = Buffer.from(
    "From: Jordan Lee <jordan.lee@brightfield-partners.test>\r\nTo: morgan.diaz@example-holdings.test\r\nSubject: Retainer\r\nDate: Fri, 14 Aug 2026 10:00:00 -0700\r\n\r\n" +
    "Confirming we agreed to hold the retainer at the current rate through October, and revisit at the quarterly review."
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await gm.toEnvelope(tok, "M1", {}, {
    fetchImpl: async () => json({ raw, internalDate: "1755172800000", threadId: "T1", historyId: "H9", labelIds: ["INBOX"] }),
    sleep: async () => {},
  });
  check("a message becomes an envelope", !!r.envelope, JSON.stringify(r.skip));
  check("the subject becomes the title", r.envelope.title === "Retainer", r.envelope?.title);
  check("the sender survives into the text, so it is searchable", /jordan\.lee@brightfield-partners\.test/.test(r.envelope.content), r.envelope?.content?.slice(0, 120));
  check("the body survives", /hold the retainer/.test(r.envelope.content));
  // internalDate is a receipt time; unlike a file mtime nothing rewrites it.
  check("internalDate is the document date", r.envelope.occurred_at === new Date(1755172800000).toISOString(), r.envelope?.occurred_at);
  check("and it is marked reliable", r.envelope.date_reliable === true);
  check("the envelope id is bare so the store namespaces Gmail exactly once", r.envelope.source_id === "M1");
  check("the thread is kept", r.envelope.metadata.thread_id === "T1");
}
{
  const r = await gm.toEnvelope(tok, "M2", {}, { fetchImpl: async () => json({ internalDate: "1" }), sleep: async () => {} });
  check("a message with no label evidence is a coverage gap before its body can be trusted",
    !!r.skip && /no label classification/.test(r.skip.reason) && r.policy_skip === false && r.retain_existing === true,
    JSON.stringify(r));
}
{
  // Carried over from the release line's version of this file, which the field
  // version does not assert. connectors/gmail.mjs still refuses an empty
  // message by name, and a reason nothing checks is a reason that quietly
  // becomes something else. Labels present so the classification gate above
  // cannot mask the skip under test.
  const r = await gm.toEnvelope(tok, "M3", {}, {
    fetchImpl: async () => json({ internalDate: "1", labelIds: ["INBOX"] }),
    sleep: async () => {},
  });
  check("a message with no content is a reasoned skip, not a silent one",
    !!r.skip && /no content/.test(r.skip.reason), JSON.stringify(r));
}
{
  const raw = Buffer.from(
    "From: sender@example.invalid\r\nTo: owner@example.invalid\r\nSubject: Sale\r\n\r\n" +
    "This invented promotion is deliberately excluded from the customer Brain."
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await gm.toEnvelope(tok, "bulk", {}, {
    fetchImpl: async () => json({ raw, labelIds: ["CATEGORY_PROMOTIONS"], historyId: "H10" }),
    sleep: async () => {},
  });
  check("incremental Gmail applies the same bulk-mail policy as a full query",
    !!r.skip && r.policy_skip === true && r.retain_existing === false && /policy excludes/.test(r.skip.reason),
    JSON.stringify(r));
}
{
  const r = await gm.toEnvelope(tok, "gone", {}, {
    fetchImpl: async () => json({ error: { errors: [{ reason: "notFound" }], message: "Message not found" } }, 404),
    sleep: async () => {},
  });
  check("a deleted message is the one fetch failure safe to skip", !!r.skip && r.skip.id === "gone" && /could not be fetched/.test(r.skip.reason), JSON.stringify(r));
}
{
  let calls = 0, e = null;
  await gm.toEnvelope(tok, "network", {}, {
    attempts: 2,
    fetchImpl: async () => { calls++; throw new TypeError("connection reset"); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted Gmail network failure escapes instead of becoming a skip",
    calls === 2 && e instanceof DriveError && e.reason === "networkError" && e.retryable === true,
    `${calls} ${e?.reason}`);
}
{
  let tokenCalls = 0, e = null;
  await gm.toEnvelope(async () => { tokenCalls++; throw new TypeError("token endpoint unavailable"); }, "token-outage", {}, {
    attempts: 2,
    fetchImpl: async () => json({}),
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted Gmail token-provider outage escapes instead of advancing history",
    tokenCalls === 2 && e instanceof DriveError && e.reason === "tokenRefreshError" && e.retryable === true,
    `${tokenCalls} ${e?.reason}`);
}
{
  const dead = Object.assign(new Error("reconnect required"), { needsReauth: true });
  let tokenCalls = 0, e = null;
  await gm.toEnvelope(async () => { tokenCalls++; throw dead; }, "reauth", {}, {
    fetchImpl: async () => json({}),
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("a Gmail reauthorization failure escapes immediately",
    tokenCalls === 1 && e === dead,
    `${tokenCalls} ${e?.message}`);
}
{
  let tokenCalls = 0, requests = 0, e = null;
  await gm.toEnvelope(async () => { tokenCalls++; return "bad"; }, "unauthorized", {}, {
    fetchImpl: async () => { requests++; return json({ error: { message: "still unauthorized" } }, 401); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("a repeated Gmail 401 escapes after one forced token refresh",
    tokenCalls === 2 && requests === 2 && e instanceof DriveError && e.status === 401,
    `${tokenCalls}/${requests} ${e?.status}`);
}
{
  let calls = 0, e = null;
  await gm.toEnvelope(tok, "quota", {}, {
    attempts: 2,
    fetchImpl: async () => { calls++; return json({ error: { message: "Too many requests" } }, 429); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted Gmail 429 escapes instead of becoming a skip",
    calls === 2 && e instanceof DriveError && e.status === 429 && e.retryable === true,
    `${calls} ${e?.status}`);
}
{
  let calls = 0, e = null;
  await gm.toEnvelope(tok, "backend", {}, {
    attempts: 2,
    fetchImpl: async () => { calls++; return json({ error: { message: "backend unavailable" } }, 503); },
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("an exhausted Gmail 5xx escapes instead of becoming a skip",
    calls === 2 && e instanceof DriveError && e.status === 503 && e.retryable === true,
    `${calls} ${e?.status}`);
}
{
  let e = null;
  await gm.toEnvelope(tok, "connector-off", {}, {
    fetchImpl: async () => json({ error: { errors: [{ reason: "accessNotConfigured" }], message: "Gmail API disabled" } }, 403),
    sleep: async () => {},
  }).catch((x) => (e = x));
  check("a connector-wide Gmail 403 is fatal rather than silently skipping every message",
    e instanceof DriveError && e.status === 403 && e.reason === "accessNotConfigured",
    `${e?.status} ${e?.reason}`);
}
{
  // A history id older than roughly a week is unanswerable. That is not an
  // error; it means fall back to a full list, and the caller must be TOLD.
  const r = await gm.listHistory(tok, "1", { fetchImpl: async () => json({ error: { message: "not found" } }, 404), sleep: async () => {} });
  check("an expired history id reports expired rather than throwing", r.expired === true && r.ids.length === 0, JSON.stringify(r));
}
{
  const r = await gm.listHistory(tok, "5", {
    fetchImpl: async () => json({ history: [{ id: "7", messagesAdded: [{ message: { id: "n1" } }, { message: { id: "n2" } }] }] }),
    sleep: async () => {},
  });
  check("history returns only what was added", r.ids.sort().join(",") === "n1,n2", JSON.stringify(r.ids));
  check("and advances the history id", r.historyId === "7");
  check("and does not claim expiry", r.expired === false);
}

console.log(fail ? `\n${fail} FAILURES` : `\ngoogle-drive: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
