/**
 * A deliberately narrow live Google Drive lifecycle fixture.
 *
 * Usage:
 *   node test/drive-live-fixture.mjs add     <8-char-id>
 *   node test/drive-live-fixture.mjs edit    <8-char-id>
 *   node test/drive-live-fixture.mjs refuse  <8-char-id>
 *   node test/drive-live-fixture.mjs recover <8-char-id>
 *   node test/drive-live-fixture.mjs trash   <8-char-id>
 *
 * The command accepts no paths, content, access tokens, or admin keys. It finds
 * the one local Google Drive for Desktop root and obtains the existing
 * read-only Google connection inside this process. The only write path is the
 * fixed fixture filename. Before an overwrite or trash, both the local and
 * remote copies must have the exact expected signed content, and the one remote
 * match must retain the id saved in the private receipt.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Acceptance } from "../acceptance.mjs";
import { api, listFiles } from "../connectors/google-drive.mjs";
import { createTokenProvider, loadTokens } from "../connectors/google-auth.mjs";
import { CLEAN, CONFIRMED, scan } from "../worker/src/lib/secret-scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ACTIONS = Object.freeze(["add", "edit", "refuse", "recover", "trash"]);
const PREVIOUS_STAGE = Object.freeze({ edit: "add", refuse: "edit", recover: "refuse", trash: "recover" });
const RECEIPT_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 2_000;

const sha256 = (value) => createHash("sha256").update(value, "utf-8").digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function fixtureIdOf(value) {
  const id = String(value || "");
  if (!/^[a-f0-9]{8}$/.test(id)) {
    throw new Error("fixture id must be exactly eight lowercase hexadecimal characters");
  }
  return id;
}

export function fixtureName(id) {
  return `Codex Brain Acceptance ${fixtureIdOf(id)}.txt`;
}

export function fixtureSignature(id) {
  return `BRAIN_DRIVE_LIVE_FIXTURE_V1:${fixtureIdOf(id)}`;
}

function markerFor(action, id) {
  const labels = {
    add: "ADD",
    edit: "EDIT",
    refuse: "REFUSE",
    recover: "RECOVER",
  };
  if (!labels[action]) throw new Error(`action ${action} has no fixture content`);
  return `JGDRIVE${labels[action]}${fixtureIdOf(id).toUpperCase()}`;
}

/**
 * Ask the existing acceptance test to construct its synthetic refusal probe.
 * The generated value never appears in this file, argv, environment, logs, or
 * the receipt. The fake request captures it only inside this process.
 */
export async function refusalProbeContent({ AcceptanceClass = Acceptance } = {}) {
  let captured = null;
  const suite = new AcceptanceClass({
    base: "https://fixture.invalid",
    adminKey: "fixture-only",
    manifest: {},
    fetchImpl: async (url, options = {}) => {
      if (!String(url).endsWith("/api/admin/brain/ingest") || options.method !== "POST") {
        throw new Error("acceptance safety probe used an unexpected request");
      }
      captured = JSON.parse(String(options.body || "null"));
      return {
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: "refused" }),
      };
    },
  });
  await suite.tierSafety();
  const gate = suite.results.find((result) => result.name === "credential gate refuses a token");
  if (gate?.status !== "pass" || typeof captured?.content !== "string" || !captured.content) {
    throw new Error("could not obtain the acceptance safety probe");
  }
  return captured.content;
}

export async function fixtureContent(action, id, options = {}) {
  id = fixtureIdOf(id);
  if (!ACTIONS.includes(action) || action === "trash") {
    throw new Error(`action must be one of: ${ACTIONS.filter((item) => item !== "trash").join(", ")}`);
  }
  const lines = [
    fixtureSignature(id),
    `fixture-id: ${id}`,
    `stage: ${action}`,
    `marker: ${markerFor(action, id)}`,
    "This is a synthetic Brain Installer Drive lifecycle fixture.",
  ];
  if (action === "refuse") lines.push(await refusalProbeContent(options));
  const content = `${lines.join("\n")}\n`;
  const gate = scan(content);
  if (action === "refuse") {
    if (gate.verdict !== CONFIRMED || gate.shouldRefuse !== true) {
      throw new Error("the refusal fixture is not confirmed by the production credential scanner");
    }
  } else if (gate.verdict !== CLEAN || gate.shouldFlag !== false) {
    throw new Error(`the ${action} fixture is not clean under the production credential scanner`);
  }
  return content;
}

export function receiptPathFor(id, receiptDir = ROOT) {
  return join(receiptDir, `.brain-drive-live-fixture-${fixtureIdOf(id)}.json`);
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return stat;
}

function assertPrivateMode(path) {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error("fixture receipt permissions are not mode 0600");
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  assertPrivateMode(path);
}

function validateReceipt(receipt, id) {
  const stages = [...ACTIONS];
  if (
    receipt?.version !== RECEIPT_VERSION ||
    receipt.fixture_id !== id ||
    receipt.filename !== fixtureName(id) ||
    receipt.signature !== fixtureSignature(id) ||
    !stages.includes(receipt.stage) ||
    typeof receipt.remote_file_id !== "string" ||
    !receipt.remote_file_id ||
    !/^[a-f0-9]{64}$/.test(String(receipt.content_sha256 || "")) ||
    (receipt.pending_action != null && !ACTIONS.includes(receipt.pending_action)) ||
    (receipt.pending_action != null && PREVIOUS_STAGE[receipt.pending_action] !== receipt.stage) ||
    (receipt.stage === "trash" && receipt.pending_action != null)
  ) {
    throw new Error("fixture receipt failed validation");
  }
  return receipt;
}

function readReceipt(path, id) {
  if (!existsSync(path)) return null;
  assertRegularFile(path, "fixture receipt");
  assertPrivateMode(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("fixture receipt is not valid JSON");
  }
  return validateReceipt(parsed, id);
}

function exactContent(path, expected, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  assertRegularFile(path, label);
  const actual = readFileSync(path, "utf-8");
  if (actual !== expected) throw new Error(`${label} does not have the expected fixture signature and stage`);
  return actual;
}

function driveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Build the token-free read-only remote verifier used by the CLI. */
export function createLiveRemote({ load = loadTokens, makeProvider = createTokenProvider } = {}) {
  const google = load()?.google;
  if (!google?.refresh_token || !google?.client_id) {
    throw new Error("no stored Google connection is available; reconnect Google first");
  }
  if (!google.scopes?.includes("drive")) {
    throw new Error("the stored Google connection does not include Drive read access");
  }
  const getAccessToken = makeProvider({
    clientId: google.client_id,
    clientSecret: google.client_secret,
    refreshToken: google.refresh_token,
  });
  return {
    async listExact(name) {
      const matches = [];
      const query = `name = '${driveQueryValue(name)}' and trashed = false`;
      for await (const file of listFiles(getAccessToken, { query })) {
        if (file?.name === name && file.trashed !== true) matches.push({ id: String(file.id), name: file.name });
      }
      return matches;
    },
    async read(id) {
      const bytes = await api(getAccessToken, `/files/${encodeURIComponent(id)}`, {
        search: { alt: "media", supportsAllDrives: true },
        raw: true,
      });
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    async state(id) {
      try {
        const file = await api(getAccessToken, `/files/${encodeURIComponent(id)}`, {
          search: { fields: "id,name,trashed", supportsAllDrives: true },
        });
        return { id: String(file.id), name: String(file.name || ""), trashed: file.trashed === true };
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    },
  };
}

export function discoverDriveRoot(home = homedir()) {
  const cloudRoot = join(home, "Library", "CloudStorage");
  if (!existsSync(cloudRoot)) throw new Error("Google Drive for Desktop is not mounted on this Mac");
  const roots = readdirSync(cloudRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^GoogleDrive-/.test(entry.name))
    .map((entry) => join(cloudRoot, entry.name, "My Drive"))
    .filter((path) => existsSync(path) && statSync(path).isDirectory());
  if (roots.length !== 1) {
    throw new Error(`expected exactly one mounted Google Drive root, found ${roots.length}`);
  }
  return roots[0];
}

async function oneRemote(remote, filename) {
  const matches = await remote.listExact(filename);
  if (!Array.isArray(matches)) throw new Error("remote verifier returned an invalid listing");
  if (matches.length > 1) throw new Error("more than one remote file has the fixture name; no change was made");
  return matches[0] || null;
}

async function assertRemoteCurrent(remote, filename, remoteId, expected) {
  const match = await oneRemote(remote, filename);
  if (!match) throw new Error("the remote fixture is missing; no change was made");
  if (match.id !== remoteId) throw new Error("the remote fixture id changed; no change was made");
  const actual = await remote.read(match.id);
  if (actual !== expected) throw new Error("the remote fixture does not have the expected signature and stage; no change was made");
  return match;
}

async function waitForRemoteContent(remote, filename, remoteId, expected, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  wait = sleep,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const match = await oneRemote(remote, filename);
    if (match) {
      if (remoteId && match.id !== remoteId) throw new Error("the remote fixture id changed while waiting for Drive sync");
      const actual = await remote.read(match.id);
      if (actual === expected) return match;
    }
    if (now() >= deadline) break;
    await wait(pollMs);
  } while (true);
  throw new Error("Google Drive did not confirm the expected fixture content before the timeout");
}

async function waitForRemoteGone(remote, filename, remoteId, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now || Date.now;
  const wait = options.wait || sleep;
  const deadline = now() + timeoutMs;
  do {
    const match = await oneRemote(remote, filename);
    if (match && match.id !== remoteId) throw new Error("the remote fixture id changed while waiting for Drive trash sync");
    if (typeof remote.state !== "function") throw new Error("remote verifier cannot confirm the saved Drive file state");
    const saved = await remote.state(remoteId);
    if (saved && saved.id !== remoteId) throw new Error("remote verifier returned the wrong saved Drive file id");
    if (!match && (!saved || saved.trashed === true)) return;
    if (now() >= deadline) break;
    await wait(pollMs);
  } while (true);
  throw new Error("Google Drive did not confirm the saved fixture id as trashed or deleted before the timeout");
}

function receiptFor({ id, stage, remoteId, content, pendingAction = null }) {
  return {
    version: RECEIPT_VERSION,
    fixture_id: id,
    filename: fixtureName(id),
    signature: fixtureSignature(id),
    stage,
    remote_file_id: remoteId,
    content_sha256: sha256(content),
    pending_action: pendingAction,
    updated_at: new Date().toISOString(),
  };
}

async function addFixture({ id, localPath, receiptPath, remote, sync }) {
  const content = await fixtureContent("add", id);
  const existingReceipt = readReceipt(receiptPath, id);
  if (existingReceipt) {
    if (existingReceipt.stage !== "add" || existingReceipt.pending_action) {
      throw new Error("add is not the next fixture lifecycle action");
    }
    if (existingReceipt.content_sha256 !== sha256(content)) throw new Error("fixture receipt content hash is inconsistent");
    exactContent(localPath, content, "local fixture");
    await assertRemoteCurrent(remote, fixtureName(id), existingReceipt.remote_file_id, content);
    return existingReceipt;
  }

  const before = await oneRemote(remote, fixtureName(id));
  if (existsSync(localPath)) {
    exactContent(localPath, content, "existing local fixture");
  } else {
    if (before) throw new Error("a remote fixture already exists without a local signed copy; no change was made");
    writeFileSync(localPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    chmodSync(localPath, 0o600);
  }
  if (before) {
    const actual = await remote.read(before.id);
    if (actual !== content) throw new Error("the existing remote fixture does not have the expected signature; no receipt was adopted");
  }
  const confirmed = before || await waitForRemoteContent(remote, fixtureName(id), null, content, sync);
  const receipt = receiptFor({ id, stage: "add", remoteId: confirmed.id, content });
  writeReceipt(receiptPath, receipt);
  return receipt;
}

async function resumeMutation({ action, id, localPath, receiptPath, receipt, remote, sync }) {
  if (receipt.pending_action !== action) throw new Error(`finish pending ${receipt.pending_action} before running ${action}`);
  const current = await fixtureContent(receipt.stage, id);
  const next = await fixtureContent(action, id);
  if (receipt.content_sha256 !== sha256(current)) throw new Error("fixture receipt content hash is inconsistent");

  const local = exactContent(localPath, existsSync(localPath) && readFileSync(localPath, "utf-8") === next ? next : current, "local fixture");
  const match = await oneRemote(remote, fixtureName(id));
  if (!match || match.id !== receipt.remote_file_id) throw new Error("the pending remote fixture is missing or changed id");
  const remoteContent = await remote.read(match.id);
  if (remoteContent !== current && remoteContent !== next) {
    throw new Error("the pending remote fixture does not have a recognised signed stage");
  }
  if (local !== next) {
    writeFileSync(localPath, next, { encoding: "utf-8", flag: "w", mode: 0o600 });
    chmodSync(localPath, 0o600);
  }
  await waitForRemoteContent(remote, fixtureName(id), receipt.remote_file_id, next, sync);
  const complete = receiptFor({ id, stage: action, remoteId: receipt.remote_file_id, content: next });
  writeReceipt(receiptPath, complete);
  return complete;
}

async function mutateFixture({ action, id, localPath, receiptPath, remote, sync }) {
  const receipt = readReceipt(receiptPath, id);
  if (!receipt) throw new Error("the private fixture receipt is missing; run add first");
  if (receipt.pending_action) {
    return resumeMutation({ action, id, localPath, receiptPath, receipt, remote, sync });
  }
  if (receipt.stage === action) {
    const content = await fixtureContent(action, id);
    if (receipt.content_sha256 !== sha256(content)) throw new Error("fixture receipt content hash is inconsistent");
    exactContent(localPath, content, "local fixture");
    await assertRemoteCurrent(remote, fixtureName(id), receipt.remote_file_id, content);
    return receipt;
  }
  if (receipt.stage !== PREVIOUS_STAGE[action]) throw new Error(`${action} is not the next fixture lifecycle action`);

  const current = await fixtureContent(receipt.stage, id);
  const next = await fixtureContent(action, id);
  if (receipt.content_sha256 !== sha256(current)) throw new Error("fixture receipt content hash is inconsistent");
  exactContent(localPath, current, "local fixture");
  await assertRemoteCurrent(remote, fixtureName(id), receipt.remote_file_id, current);

  writeReceipt(receiptPath, receiptFor({
    id,
    stage: receipt.stage,
    remoteId: receipt.remote_file_id,
    content: current,
    pendingAction: action,
  }));
  writeFileSync(localPath, next, { encoding: "utf-8", flag: "w", mode: 0o600 });
  chmodSync(localPath, 0o600);
  await waitForRemoteContent(remote, fixtureName(id), receipt.remote_file_id, next, sync);
  const complete = receiptFor({ id, stage: action, remoteId: receipt.remote_file_id, content: next });
  writeReceipt(receiptPath, complete);
  return complete;
}

async function trashFixture({ id, localPath, trashPath, receiptPath, remote, sync }) {
  const receipt = readReceipt(receiptPath, id);
  if (!receipt) throw new Error("the private fixture receipt is missing; no file was trashed");
  const content = await fixtureContent("recover", id);
  if (receipt.content_sha256 !== sha256(content)) throw new Error("fixture receipt content hash is inconsistent");

  if (receipt.stage === "trash" && !receipt.pending_action) {
    if (existsSync(localPath)) throw new Error("a completed trash receipt still has a local Drive file");
    exactContent(trashPath, content, "trashed fixture");
    await waitForRemoteGone(remote, fixtureName(id), receipt.remote_file_id, { ...sync, timeoutMs: 0 });
    return receipt;
  }
  if (receipt.stage !== "recover" || (receipt.pending_action && receipt.pending_action !== "trash")) {
    throw new Error("trash is not the next fixture lifecycle action");
  }

  if (!receipt.pending_action) {
    exactContent(localPath, content, "local fixture");
    await assertRemoteCurrent(remote, fixtureName(id), receipt.remote_file_id, content);
    if (existsSync(trashPath)) throw new Error("the fixed Trash destination already exists; no file was moved");
    writeReceipt(receiptPath, receiptFor({
      id,
      stage: "recover",
      remoteId: receipt.remote_file_id,
      content,
      pendingAction: "trash",
    }));
  } else {
    const match = await oneRemote(remote, fixtureName(id));
    if (match) {
      if (match.id !== receipt.remote_file_id) throw new Error("the pending remote fixture changed id");
      if (await remote.read(match.id) !== content) throw new Error("the pending remote fixture lost its signed content");
    }
  }

  if (existsSync(localPath)) {
    exactContent(localPath, content, "local fixture");
    if (existsSync(trashPath)) throw new Error("both the Drive and Trash fixture copies exist; no file was moved");
    renameSync(localPath, trashPath);
  } else {
    exactContent(trashPath, content, "trashed fixture");
  }
  await waitForRemoteGone(remote, fixtureName(id), receipt.remote_file_id, sync);
  const complete = receiptFor({ id, stage: "trash", remoteId: receipt.remote_file_id, content });
  writeReceipt(receiptPath, complete);
  return complete;
}

export async function runDriveLiveFixture({
  action,
  fixtureId,
  driveRoot,
  home = homedir(),
  receiptDir = ROOT,
  remote,
  sync,
} = {}) {
  const id = fixtureIdOf(fixtureId);
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of: ${ACTIONS.join(", ")}`);
  driveRoot = driveRoot || discoverDriveRoot(home);
  if (!existsSync(driveRoot) || !statSync(driveRoot).isDirectory()) throw new Error("the mounted Drive root is unavailable");
  remote = remote || createLiveRemote();

  const filename = fixtureName(id);
  const localPath = join(driveRoot, filename);
  const receiptPath = receiptPathFor(id, receiptDir);
  const trashDir = join(home, ".Trash");
  if (action === "trash" && (!existsSync(trashDir) || !statSync(trashDir).isDirectory())) {
    throw new Error("the local Trash directory is unavailable");
  }
  const trashPath = join(trashDir, filename);

  if (action === "add") return addFixture({ id, localPath, receiptPath, remote, sync });
  if (action === "trash") return trashFixture({ id, localPath, trashPath, receiptPath, remote, sync });
  return mutateFixture({ action, id, localPath, receiptPath, remote, sync });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) throw new Error(`usage: node test/drive-live-fixture.mjs <${ACTIONS.join("|")}> <8-char-id>`);
  const [action, fixtureId] = argv;
  await runDriveLiveFixture({ action, fixtureId });
  console.log(`PASS  Drive lifecycle fixture ${action} ${fixtureId}`);
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((error) => {
    console.error(`FAIL  ${error?.message || "Drive lifecycle fixture failed"}`);
    process.exitCode = 1;
  });
}
