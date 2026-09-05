import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RECOVERY_ARTIFACT_PLAINTEXT_PREFIX,
  assertNoRecoveryPlaintextResidue,
  decryptRecoveryArtifact,
  encryptRecoveryArtifact,
  generateRecoveryArtifactKey,
  recoveryPlaintextResidues,
  recoveryArtifactResidues,
  withDecryptedRecoveryArtifact,
} from "../operations/recovery-artifact-crypto.mjs";

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "brain-recovery-artifact-"));
  chmodSync(directory, 0o700);
  return directory;
}

test("the durable recovery artifact is authenticated ciphertext", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const restored = join(directory, "restored.sql");
  const body = "-- synthetic only\nINSERT INTO documents VALUES ('fixture');\n";
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 23));
  writeFileSync(source, body, { mode: 0o600 });

  await encryptRecoveryArtifact(source, encrypted, key);
  assert.notEqual(readFileSync(encrypted, "utf8").includes("synthetic only"), true);
  await decryptRecoveryArtifact(encrypted, restored, key);
  assert.equal(readFileSync(restored, "utf8"), body);
});

test("wrong key and tampering never produce plaintext", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  writeFileSync(source, "private synthetic body", { mode: 0o600 });
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 31));
  const wrong = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 32));
  await encryptRecoveryArtifact(source, encrypted, key);
  await assert.rejects(
    decryptRecoveryArtifact(encrypted, join(directory, "wrong.sql"), wrong),
    /could not be authenticated/,
  );
  assert.equal(recoveryPlaintextResidues(directory).length, 0);

  const tampered = Buffer.from(readFileSync(encrypted));
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  writeFileSync(join(directory, "tampered.sql.fbrenc"), tampered, { mode: 0o600 });
  await assert.rejects(
    decryptRecoveryArtifact(
      join(directory, "tampered.sql.fbrenc"),
      join(directory, "tampered.sql"),
      key,
    ),
    /could not be authenticated/,
  );
  assert.deepEqual(recoveryArtifactResidues(directory), []);
});

test("plaintext exists only for the callback and residue is fail-closed", async () => {
  const directory = privateDirectory();
  const source = join(directory, "source.sql");
  const encrypted = join(directory, "source.sql.fbrenc");
  const key = generateRecoveryArtifactKey((length) => Buffer.alloc(length, 41));
  writeFileSync(source, "callback body", { mode: 0o600 });
  await encryptRecoveryArtifact(source, encrypted, key);

  const seen = await withDecryptedRecoveryArtifact(encrypted, directory, key, (path) => {
    assert.match(path, new RegExp(RECOVERY_ARTIFACT_PLAINTEXT_PREFIX.replaceAll(".", "\\.")));
    return readFileSync(path, "utf8");
  });
  assert.equal(seen, "callback body");
  assert.deepEqual(recoveryPlaintextResidues(directory), []);

  const residue = join(directory, `${RECOVERY_ARTIFACT_PLAINTEXT_PREFIX}interrupted`);
  writeFileSync(residue, "review me", { mode: 0o600 });
  assert.throws(() => assertNoRecoveryPlaintextResidue(directory), /manual review/);
  unlinkSync(residue);
});
