/**
 * Create the small, instance-local Claude Code guide beside a Brain manifest.
 *
 * This file contains locators and safety rules only. It never contains a
 * Cloudflare token, Brain admin key, provider credential, or copied user data.
 * An unrelated CLAUDE.md is preserved rather than merged or overwritten.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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
} = {}) {
  const manifest = safeLocator(manifestPath, "manifest path");
  const brainScript = safeLocator(brainCliPath, "Brain CLI path");
  const brain = nodePath
    ? `${JSON.stringify(safeLocator(nodePath, "Node path"))} ${JSON.stringify(brainScript)}`
    : JSON.stringify(brainScript);
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
- Readiness: \`${brain} doctor ${manifest}\`
- Source status: \`${brain} sources ${manifest}\`
- Ask privately: \`${brain} ask ${manifest}\`
- Load one approved folder: \`${brain} ingest ${manifest} --path <approved-folder> --source documents\`

Wrangler is available at the profile-capable pinned release through \`npx wrangler@4.127.1\`.
Prefer the Brain CLI because it applies account pinning, migration safety, key
storage, and proof checks. Use Wrangler directly only for a named diagnostic
the owner has approved. Credentials stay in provider pages or hidden prompts rather than the command or this file.
`;
}

export function writeClaudeWorkspaceGuide(manifestPath, options = {}) {
  const target = join(dirname(resolve(manifestPath)), "CLAUDE.md");
  const content = renderClaudeWorkspaceGuide(manifestPath, options);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return { path: target, changed: false, status: "preserved_unsafe_existing_file" };
    }
    const existing = readFileSync(target, "utf8");
    if (!existing.startsWith(CLAUDE_WORKSPACE_MARKER)) {
      return { path: target, changed: false, status: "preserved_unrelated_existing_file" };
    }
    if (existing === content) return { path: target, changed: false, status: "verified" };
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
  return { path: target, changed: true, status: "written" };
}
