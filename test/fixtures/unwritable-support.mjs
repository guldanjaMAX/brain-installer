/*
 * Simulate a filesystem refusing only the immutable support-event create.
 * Loaded before brain.mjs so the named fs import receives this test seam.
 */

import fs from "node:fs";
import { join, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_TEST_USER_ROOT || "");
if (!userRoot) throw new Error("BRAIN_TEST_USER_ROOT is required");
const eventsPrefix = `${join(userRoot, ".brain", "support", "events")}${sep}`;
const originalOpen = fs.openSync.bind(fs);

fs.openSync = (path, ...args) => {
  const requested = String(path);
  if (requested.startsWith(eventsPrefix) && /evt_[0-9a-f]{32}\.json$/.test(requested)) {
    const error = new Error("synthetic support journal write refusal");
    error.code = "EACCES";
    throw error;
  }
  return originalOpen(path, ...args);
};

syncBuiltinESMExports();
