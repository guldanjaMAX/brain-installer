import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderSchedulerPlan,
  createProviderSchedulerSpec,
} from "../operations/provider-scheduler.mjs";
import { safeIngestEnvironment } from "../operations/drive-scheduler.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const folder = mkdtempSync(join(tmpdir(), "brain-provider-scheduler-"));
try {
  const manifestPath = join(folder, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture-client", display_name: "Fixture" },
    brain: { version: "0.2.0", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    corpora: { slack: { enabled: true, channel_ids: ["C1"] } },
    operations: {
      provider_crons: { slack: "15 */2 * * *" },
      provider_token_stores: { slack: "file" },
    },
  }));
  const plan = buildProviderSchedulerPlan("slack", manifestPath, {
    platform: "darwin",
    uid: 501,
    home: folder,
    nodePath: "/usr/bin/node",
    brainPath: "/opt/brain/brain.mjs",
  });
  check("provider scheduler uses a provider-specific identity and cron",
    plan.label.endsWith(".slack-ingest") && plan.cron === "15 */2 * * *");
  check("installed scheduler argv retains the provider across a later run",
    plan.programArguments.slice(0, 4).join("|").includes("provider-scheduler.mjs|slack|run"));
  check("scheduled child invokes the ordinary provider ingest command",
    plan.spec.childArgumentsOf(plan).join(" ") === `ingest ${plan.path} --from slack`);
  const env = plan.spec.childEnvironmentOf(plan, {
    HOME: folder,
    BRAIN_SLACK_TOKEN_STORE: "keychain",
    SLACK_CLIENT_SECRET: "must-not-pass",
    CLOUDFLARE_API_TOKEN: "must-not-pass",
  });
  check("scheduled child carries only the token-store selector, never provider or Cloudflare secrets",
    env.BRAIN_SLACK_TOKEN_STORE === "file" && !("SLACK_CLIENT_SECRET" in env) && !("CLOUDFLARE_API_TOKEN" in env));

  const changed = JSON.parse(readFileSync(manifestPath, "utf8"));
  changed.corpora.slack.channel_ids.push("C2");
  writeFileSync(manifestPath, JSON.stringify(changed));
  const changedPlan = buildProviderSchedulerPlan("slack", manifestPath, {
    platform: "darwin", uid: 501, home: folder,
    nodePath: "/usr/bin/node", brainPath: "/opt/brain/brain.mjs",
  });
  check("provider selection changes are covered by the installed config hash",
    changedPlan.configHash !== plan.configHash);
} finally {
  rmSync(folder, { recursive: true, force: true });
}

{
  let error;
  try { createProviderSchedulerSpec("salesforce"); } catch (caught) { error = caught; }
  check("absent providers cannot acquire a scheduler by typo", /unsupported OAuth provider/.test(error?.message || ""));
}

{
  const env = safeIngestEnvironment({
    HOME: "/owner", BRAIN_HUBSPOT_TOKEN_STORE: "file", HUBSPOT_CLIENT_SECRET: "secret",
  });
  check("the shared sparse scheduler environment recognizes only provider storage mode",
    env.BRAIN_HUBSPOT_TOKEN_STORE === "file" && !("HUBSPOT_CLIENT_SECRET" in env));
}

console.log(`\nprovider scheduler: all ${ran} checks passed`);
