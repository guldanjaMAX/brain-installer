/*
 * Keep CLI support-journal tests away from the developer's real user storage.
 * Loaded before brain.mjs so imported homedir bindings receive this isolated,
 * mkdtemp-owned root. This fixture is excluded from the published package.
 */

import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_TEST_USER_ROOT || "");
if (!userRoot) throw new Error("BRAIN_TEST_USER_ROOT is required");
os.homedir = () => userRoot;
syncBuiltinESMExports();
