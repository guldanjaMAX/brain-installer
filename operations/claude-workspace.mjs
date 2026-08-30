/**
 * Create the small, instance-local Claude Code guide in a dedicated workspace.
 *
 * This file contains locators and safety rules only. It never contains a
 * Cloudflare token, Brain admin key, provider credential, or copied user data.
 * An unrelated CLAUDE.md is preserved rather than merged or overwritten, and
 * is never used as the working directory for an installer handoff.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { renderCopyableCommand } from "./command-display.mjs";

export const CLAUDE_WORKSPACE_MARKER = "<!-- financial-brain-installer:claude-workspace:v1 -->";

function safeLocator(value, label) {
  const text = resolve(String(value || ""));
  if (!text || /[\u0000-\u001f\u007f`]/.test(text)) {
    throw new Error(`${label} is not safe to place in the Claude workspace guide`);
  }
  return text;
}

export function renderClaudeWorkspaceGuide(manifestPath, {
  brainCliPath = process.argv[1],
  nodePath = null,
  bootstrapStatusPath = null,
  platformName = process.platform,
} = {}) {
  const manifest = safeLocator(manifestPath, "manifest path");
  const brainScript = safeLocator(brainCliPath, "Brain CLI path");
  const launcherCommand = nodePath ? safeLocator(nodePath, "Node path") : brainScript;
  const launcherArgs = nodePath ? [brainScript] : [];
  const brainCommand = (args = []) => renderCopyableCommand(
    launcherCommand,
    [...launcherArgs, ...args],
    { platformName },
  );
  const brain = brainCommand();
  const bootstrapStatus = bootstrapStatusPath
    ? safeLocator(bootstrapStatusPath, "bootstrap status path")
    : join(dirname(manifest), ".financial-brain-bootstrap-status.json");
  return `${CLAUDE_WORKSPACE_MARKER}
# Financial Brain owner workspace

This folder belongs to the Brain owner. Use the installed Brain CLI and the
registered Financial Brain MCP server before reaching for Cloudflare directly.

## Working together safely

- Begin read-only and explain the exact files, folders, or external action that would help next.
- Keep Cloudflare tokens, Brain keys, OAuth secrets, app passwords, passkey material, and authentication codes in provider pages or hidden terminal prompts.
- Keep Claude Code's normal approval prompts enabled.
- Start with the folder or connected-drive root the owner names. Use \`claude --add-dir <approved-folder>\` for that approved root.
- Preview a discovered source and invite the owner to approve the exact folder before ingestion.
- Pause for the owner's specific approval before a deploy, deletion, data-forget action, key rotation, access revocation, or billing change.

## Installed commands

- Guided install and connector skill: \`/financial-brain-technician\`
- Confirm it is available in Claude Code: \`/skills\`
- Brain CLI invocation: \`${brain}\`
- Package-local bootstrap status: \`${bootstrapStatus}\`
- Manifest: \`${manifest}\`
- Readiness: \`${brainCommand(["doctor", manifest])}\`
- Source status: \`${brainCommand(["sources", manifest])}\`
- Ask privately: \`${brainCommand(["ask", manifest])}\`
- Load one approved folder: \`${brainCommand(["ingest", manifest, "--path", "<approved-folder>", "--source", "documents"])}\`

Wrangler is available at the profile-capable pinned release through \`npx wrangler@4.127.1\`.
Prefer the Brain CLI because it applies account pinning, migration safety, key
storage, and proof checks. Use Wrangler directly only for a named diagnostic
the owner has approved. Credentials stay in provider pages or hidden prompts rather than the command or this file.
`;
}

function workspaceIdentity(manifestPath, guideContent) {
  // A guide-content change rotates to a new deterministic directory instead
  // of overwriting an existing CLAUDE.md. This gives upgrades a safe path while
  // keeping every prior owner workspace recoverable and byte-for-byte intact.
  return createHash("sha256")
    .update(resolve(manifestPath), "utf8")
    .update("\0", "utf8")
    .update(guideContent, "utf8")
    .digest("hex")
    .slice(0, 20);
}

function workspacePaths(manifestPath, guideContent, options = {}) {
  const configured = options.workspaceRoot || options.environment?.HOME ||
    options.environment?.USERPROFILE || homedir();
  const root = options.workspaceRoot
    ? resolve(String(configured))
    : join(resolve(String(configured)), ".financial-brain", "claude-workspaces");
  if (!root || /[\u0000-\u001f\u007f]/.test(root)) {
    throw new Error("the dedicated Claude workspace root is invalid");
  }
  return Object.freeze({
    trustedRoot: root,
    workspace: join(root, workspaceIdentity(manifestPath, guideContent)),
  });
}

function sameCanonicalPath(left, right) {
  const normalize = (value) => process.platform === "win32"
    ? resolve(value).toLowerCase()
    : resolve(value);
  return normalize(left) === normalize(right);
}

/**
 * Create one directory chain without ever following a pre-existing symlink.
 * Recursive mkdir is deliberately avoided because the deterministic workspace
 * name is known in advance and may already have been replaced by a link.
 */
function ensureCanonicalDirectory(path, { mode = 0o700, trustedRoot = path } = {}) {
  const target = resolve(path);
  const root = resolve(trustedRoot);
  const descent = relative(root, target);
  if (descent === ".." || descent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(descent)) {
    throw new Error("the dedicated Claude workspace escaped its trusted root");
  }
  const missing = [];
  let current = root;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error("the dedicated Claude workspace has no safe existing parent");
    current = parent;
  }

  const verify = (candidate) => {
    const identity = lstatSync(candidate);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error("the dedicated Claude workspace path contains a symlink or non-directory component");
    }
    const canonical = realpathSync(candidate);
    if (!sameCanonicalPath(canonical, candidate)) {
      throw new Error("the dedicated Claude workspace path is not canonical");
    }
    if (typeof process.getuid === "function" &&
        (identity.uid !== process.getuid() || (identity.mode & 0o022) !== 0)) {
      throw new Error("the dedicated Claude workspace path is not private to the current owner");
    }
  };

  verify(current);
  while (missing.length) {
    const next = missing.pop();
    mkdirSync(next, { recursive: false, mode });
    verify(next);
  }
  verify(root);

  // Revalidate every component from the owner-controlled root on every run.
  // Checking only the deepest existing directory would trust a parent that was
  // replaced or made writable after the first successful setup.
  let candidate = root;
  for (const part of descent.split(/[\\/]+/).filter(Boolean)) {
    candidate = join(candidate, part);
    if (!existsSync(candidate)) mkdirSync(candidate, { recursive: false, mode });
    verify(candidate);
  }
  verify(target);
  return target;
}

function unrelatedAncestorGuide(workspace, target) {
  let current = dirname(workspace);
  const root = parse(current).root;
  while (current && current !== root) {
    const candidate = join(current, "CLAUDE.md");
    if (candidate !== target && existsSync(candidate)) {
      try {
        const identity = lstatSync(candidate);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
            !readFileSync(candidate, "utf8").startsWith(CLAUDE_WORKSPACE_MARKER)) {
          return candidate;
        }
      } catch {
        return candidate;
      }
    }
    current = dirname(current);
  }
  return null;
}

export function writeClaudeWorkspaceGuide(manifestPath, options = {}) {
  const content = renderClaudeWorkspaceGuide(manifestPath, options);
  const paths = workspacePaths(manifestPath, content, options);
  const workspace = ensureCanonicalDirectory(paths.workspace, { trustedRoot: paths.trustedRoot });
  const target = join(workspace, "CLAUDE.md");
  chmodSync(workspace, 0o700);
  const ancestor = unrelatedAncestorGuide(workspace, target);
  if (ancestor) {
    return { path: target, workspace, changed: false, status: "blocked_unrelated_ancestor_guide", blocked_by: ancestor };
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return { path: target, workspace, changed: false, status: "preserved_unsafe_existing_file" };
    }
    const existing = readFileSync(target, "utf8");
    if (!existing.startsWith(CLAUDE_WORKSPACE_MARKER)) {
      return { path: target, workspace, changed: false, status: "preserved_unrelated_existing_file" };
    }
    if (existing === content) return { path: target, workspace, changed: false, status: "verified" };
    // Portable Node has no atomic compare-and-replace primitive. Never let a
    // stale managed guide turn into permission to overwrite whatever occupies
    // the name one syscall later. A changed guide is a visible collision that
    // the owner can resolve; ordinary identical reruns still verify in place.
    return { path: target, workspace, changed: false, status: "preserved_stale_managed_file" };
  }

  const temporary = `${target}.${process.pid}.tmp`;
  let fd = null;
  let temporaryCreated = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (typeof options.beforeWorkspaceRename === "function") options.beforeWorkspaceRename();
    // Revalidate the entire owner-only chain immediately before no-replace
    // publication; neither an ancestor swap nor a newly occupied target is
    // accepted as installer-owned state.
    ensureCanonicalDirectory(workspace, { trustedRoot: paths.trustedRoot });
    // link() is an atomic no-replace publication: if any file appeared at the
    // target after the absence check, EEXIST preserves it byte-for-byte.
    linkSync(temporary, target);
    chmodSync(target, 0o600);
    unlinkSync(temporary);
    temporaryCreated = false;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (temporaryCreated) {
      try { unlinkSync(temporary); } catch { /* only this invocation's temporary may be removed */ }
    }
    throw error;
  }
  return { path: target, workspace, changed: true, status: "written" };
}
