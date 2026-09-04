/**
 * Render copyable local commands without ever using display text for execution.
 *
 * Execution stays structured as command plus argv. This module is only for the
 * owner-visible copy of that structure. POSIX and PowerShell both treat a
 * single-quoted value as literal; their embedded-quote escapes differ.
 */

function displayValue(value, label = "command argument") {
  const text = String(value ?? "");
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} is not safe to display as a copyable command`);
  }
  return text;
}

export function quotePosixArgument(value) {
  const text = displayValue(value);
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function quotePowerShellArgument(value) {
  const text = displayValue(value);
  return `'${text.replaceAll("'", "''")}'`;
}

export function renderCopyableCommand(command, args = [], {
  platformName = process.platform,
} = {}) {
  const values = [displayValue(command, "command"), ...args.map((value) => displayValue(value))];
  if (platformName === "win32") {
    return `& ${values.map(quotePowerShellArgument).join(" ")}`;
  }
  return values.map(quotePosixArgument).join(" ");
}
