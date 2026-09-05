import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  brainCliPrefix,
  renderCliCommands,
  renderDiagnosis,
} from "../brain.mjs";
import {
  renderTechnicianPlan,
  technicianPlan,
} from "../operations/technician-setup.mjs";
import {
  renderSupportRecovery,
  supportRecovery,
} from "../support-recovery.mjs";

const windows = {
  platform: "win32",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  scriptPath: "C:\\Users\\client\\AppData\\Local\\FinancialBrain\\node_modules\\brain-installer\\brain.mjs",
};
const prefix = brainCliPrefix(windows);
const bareCommand = /\bbrain\s+(?:setup|doctor|update|drain|support|technician|eval|grants|forget|mcp-config|tools)\b/;

const supportText = renderCliCommands(
  renderSupportRecovery(supportRecovery("HEALTH_CHECK_FAILED")),
  windows,
);
assert.match(supportText, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(supportText, bareCommand);

const plan = technicianPlan("C:\\Users\\client\\Financial Brain\\brain.manifest.json", {
  existsSync: () => false,
});
const technicianText = renderCliCommands(renderTechnicianPlan(plan), windows);
assert.match(technicianText, /--run tools/);
assert.doesNotMatch(technicianText, bareCommand);

const output = [];
const originalLog = console.log;
try {
  console.log = (...parts) => output.push(parts.join(" "));
  renderDiagnosis({
    totals: { documents: 1, chunks: 1, sources: 1 },
    findings: [{
      area: "integrity",
      severity: "crit",
      title: "Synthetic backlog",
      detail: "Fixture only",
      action: "Run brain drain C:\\fixture\\brain.manifest.json, then brain health C:\\fixture\\brain.manifest.json.",
    }],
    summary: { crit: 1, warn: 0 },
    verdict: "critical",
  }, windows);
} finally {
  console.log = originalLog;
}
assert.match(output.join("\n"), /Synthetic backlog/);
assert.doesNotMatch(output.join("\n"), bareCommand);

// These assertions bind the pure renderer checks above to the actual human
// output branches. Structured JSON deliberately stays byte-stable.
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
assert.match(source, /: renderCliCommands\(renderSupportRecovery\(recovery\)\)\)/);
assert.match(source, /else console\.log\(renderCliCommands\(renderTechnicianPlan\(plan\)\)\)/);
assert.match(source, /if \(flags\.json\) console\.log\(JSON\.stringify\(plan, null, 2\)\)/);
assert.doesNotMatch(source, /node brain\.mjs forget/);
assert.doesNotMatch(source, /\$\{(?:x|item)\.fix\.split\("\\n"\)/);
assert.doesNotMatch(source, /\$\{f\.action\}/);

console.log("CLI guidance rendering: Windows human commands are executable and JSON stays canonical");
