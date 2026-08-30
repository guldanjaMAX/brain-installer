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
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
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

function workspaceIdentity(manifestPath) {
  return createHash("sha256").update(resolve(manifestPath), "utf8").digest("hex").slice(0, 20);
}

function workspaceRoot(manifestPath, options = {}) {
  const configured = options.workspaceRoot || options.environment?.HOME ||
    options.environment?.USERPROFILE || homedir();
  const root = options.workspaceRoot
    ? resolve(String(configured))
    : join(resolve(String(configured)), ".financial-brain", "claude-workspaces");
  if (!root || /[\u0000-\u001f\u007f]/.test(root)) {
    throw new Error("the dedicated Claude workspace root is invalid");
  }
  return join(root, workspaceIdentity(manifestPath));
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
  const workspace = workspaceRoot(manifestPath, options);
  const target = join(workspace, "CLAUDE.md");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  chmodSync(workspace, 0o700);
  const ancestor = unrelatedAncestorGuide(workspace, target);
  if (ancestor) {
    return { path: target, workspace, changed: false, status: "blocked_unrelated_ancestor_guide", blocked_by: ancestor };
  }
  const content = renderClaudeWorkspaceGuide(manifestPath, options);
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
  }

  const temporary = `${target}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
  return { path: target, workspace, changed: true, status: "written" };
}
