import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { scan } from "../worker/src/lib/secret-scan.js";
import {
  fixtureContent,
  fixtureIdOf,
  fixtureName,
  receiptPathFor,
  refusalProbeContent,
  runDriveLiveFixture,
} from "./drive-live-fixture.mjs";

const directory = mkdtempSync(join(tmpdir(), "brain-drive-live-fixture-"));
const driveRoot = join(directory, "drive");
const home = join(directory, "home");
const receiptDir = join(directory, "receipts");
mkdirSync(driveRoot, { recursive: true });
mkdirSync(join(home, ".Trash"), { recursive: true });

const id = "a1b2c3d4";
const localPath = join(driveRoot, fixtureName(id));
const trashPath = join(home, ".Trash", fixtureName(id));
const receiptPath = receiptPathFor(id, receiptDir);
const controls = { id: "remote-fixture-one", duplicate: false, renamedLive: false };
const remote = {
  async listExact(name) {
    if (name !== fixtureName(id) || !existsSync(localPath)) return [];
    const rows = [{ id: controls.id, name }];
    if (controls.duplicate) rows.push({ id: "remote-fixture-two", name });
    return rows;
  },
  async read(remoteId) {
    assert.ok([controls.id, "remote-fixture-two"].includes(remoteId));
    return readFileSync(localPath, "utf-8");
  },
  async state(remoteId) {
    assert.equal(remoteId, "remote-fixture-one");
    if (existsSync(localPath) || controls.renamedLive) {
      return {
        id: remoteId,
        name: controls.renamedLive ? "Renamed but still active.txt" : fixtureName(id),
        trashed: false,
      };
    }
    return { id: remoteId, name: fixtureName(id), trashed: true };
  },
};

try {
  const ignore = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".gitignore"), "utf-8");
  assert.match(ignore, /^\.brain-drive-live-fixture-(?:\[0-9a-f\]){8}\.json$/m);
  assert.doesNotMatch(ignore, /^\.brain-drive-live-fixture-\*\.json$/m);

  assert.equal(fixtureIdOf(id), id);
  for (const invalid of ["", "abc", "A1B2C3D4", "../bad00", "g1b2c3d4", "a1b2c3d45"]) {
    assert.throws(() => fixtureIdOf(invalid), /exactly eight/);
  }

  const probe = await refusalProbeContent();
  assert.equal(scan(probe).shouldRefuse, true);
  for (const stage of ["add", "edit", "recover"]) {
    const gate = scan(await fixtureContent(stage, id));
    assert.equal(gate.verdict, "clean");
    assert.equal(gate.shouldFlag, false);
  }
  assert.equal(scan(await fixtureContent("refuse", id)).verdict, "confirmed");

  await runDriveLiveFixture({ action: "add", fixtureId: id, driveRoot, home, receiptDir, remote });
  assert.equal(readFileSync(localPath, "utf-8"), await fixtureContent("add", id));
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf-8")).remote_file_id, controls.id);
  if (process.platform !== "win32") assert.equal(statSync(receiptPath).mode & 0o777, 0o600);

  const beforeBlockedEdit = readFileSync(localPath, "utf-8");
  controls.duplicate = true;
  await assert.rejects(
    runDriveLiveFixture({ action: "edit", fixtureId: id, driveRoot, home, receiptDir, remote }),
    /more than one remote file/,
  );
  assert.equal(readFileSync(localPath, "utf-8"), beforeBlockedEdit);
  controls.duplicate = false;

  controls.id = "remote-fixture-changed";
  await assert.rejects(
    runDriveLiveFixture({ action: "edit", fixtureId: id, driveRoot, home, receiptDir, remote }),
    /remote fixture id changed/,
  );
  assert.equal(readFileSync(localPath, "utf-8"), beforeBlockedEdit);
  controls.id = "remote-fixture-one";

  const addContent = await fixtureContent("add", id);
  const editContent = await fixtureContent("edit", id);
  let laggedContent = addContent;
  const laggedRemote = { ...remote, read: async () => laggedContent };
  await assert.rejects(
    runDriveLiveFixture({
      action: "edit",
      fixtureId: id,
      driveRoot,
      home,
      receiptDir,
      remote: laggedRemote,
      sync: { timeoutMs: 0 },
    }),
    /before the timeout/,
  );
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf-8")).pending_action, "edit");
  assert.equal(readFileSync(localPath, "utf-8"), editContent);
  laggedContent = editContent;
  await runDriveLiveFixture({ action: "edit", fixtureId: id, driveRoot, home, receiptDir, remote: laggedRemote });
  assert.equal(readFileSync(localPath, "utf-8"), await fixtureContent("edit", id));

  const remoteWithoutSignature = { ...remote, read: async () => "not the signed fixture\n" };
  const beforeBlockedRefusal = readFileSync(localPath, "utf-8");
  await assert.rejects(
    runDriveLiveFixture({ action: "refuse", fixtureId: id, driveRoot, home, receiptDir, remote: remoteWithoutSignature }),
    /remote fixture does not have the expected signature/,
  );
  assert.equal(readFileSync(localPath, "utf-8"), beforeBlockedRefusal);

  await runDriveLiveFixture({ action: "refuse", fixtureId: id, driveRoot, home, receiptDir, remote });
  assert.equal(scan(readFileSync(localPath, "utf-8")).shouldRefuse, true);

  await runDriveLiveFixture({ action: "recover", fixtureId: id, driveRoot, home, receiptDir, remote });
  assert.equal(readFileSync(localPath, "utf-8"), await fixtureContent("recover", id));
  assert.equal(scan(readFileSync(localPath, "utf-8")).shouldRefuse, false);

  controls.renamedLive = true;
  await assert.rejects(
    runDriveLiveFixture({
      action: "trash",
      fixtureId: id,
      driveRoot,
      home,
      receiptDir,
      remote,
      sync: { timeoutMs: 0 },
    }),
    /saved fixture id as trashed or deleted/,
  );
  assert.equal(existsSync(localPath), false);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf-8")).pending_action, "trash");
  controls.renamedLive = false;
  await runDriveLiveFixture({ action: "trash", fixtureId: id, driveRoot, home, receiptDir, remote });
  assert.equal(existsSync(localPath), false);
  assert.equal(readFileSync(trashPath, "utf-8"), await fixtureContent("recover", id));
  const completed = JSON.parse(readFileSync(receiptPath, "utf-8"));
  assert.equal(completed.stage, "trash");
  assert.equal(completed.pending_action, null);

  await runDriveLiveFixture({ action: "trash", fixtureId: id, driveRoot, home, receiptDir, remote });
  controls.renamedLive = true;
  await assert.rejects(
    runDriveLiveFixture({ action: "trash", fixtureId: id, driveRoot, home, receiptDir, remote }),
    /saved fixture id as trashed or deleted/,
  );
  controls.renamedLive = false;
  console.log("drive live fixture: all focused tests passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
