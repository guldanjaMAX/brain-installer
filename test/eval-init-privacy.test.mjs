import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateEvalTemplate } from "../brain.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-eval-init-"));
try {
  const destination = join(sandbox, "brain.golden.json");
  writePrivateEvalTemplate(destination);
  const identity = lstatSync(destination);
  assert.equal(identity.isFile(), true);
  assert.equal(identity.isSymbolicLink(), false);
  assert.equal(identity.nlink, 1);
  if (process.platform !== "win32") assert.equal(identity.mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(destination, "utf8")).schema_version, 1);

  assert.throws(
    () => writePrivateEvalTemplate(destination),
    /already exists/i,
  );
  assert.throws(
    () => writePrivateEvalTemplate(destination, { force: true }),
    /never|not supported|rename/i,
  );

  if (process.platform !== "win32") {
    const outside = join(sandbox, "outside");
    const linked = join(sandbox, "linked.golden.json");
    writeFileSync(outside, "must stay unchanged", { mode: 0o600 });
    symlinkSync(outside, linked);
    assert.throws(() => writePrivateEvalTemplate(linked), /already exists/i);
    assert.equal(readFileSync(outside, "utf8"), "must stay unchanged");
  }

  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^brain\.golden\.json$/m);
  console.log("eval init privacy: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
