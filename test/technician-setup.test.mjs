import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TECHNICIAN_RUN_STEPS,
  runTechnicianStep,
  technicianChildEnvironment,
  technicianPlan,
} from "../operations/technician-setup.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-technician-test-"));
const manifestPath = join(sandbox, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture" },
  brain: { domain: "brain.fixture.test" },
  corpora: {
    google_drive: { enabled: true },
    gmail: { enabled: true },
    calendar: { enabled: true },
    zoom: { enabled: true },
    imap: { enabled: true },
  },
}));

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("the plan is read-only, ordered, honest about proof, and agent-readable", () => {
  const missing = join(sandbox, "not-created.json");
  const plan = technicianPlan(missing);
  assert.equal(plan.mode, "read_only_plan");
  assert.equal(plan.proof_level, "workflow_only");
  assert.deepEqual(plan.steps.map((step) => step.id), TECHNICIAN_RUN_STEPS);
  assert.equal(plan.steps[0].state, "ready_to_start");
  assert.match(plan.warning, /No account.*proven/i);
  assert.match(JSON.stringify(plan), /never paste/i);
  assert.doesNotMatch(JSON.stringify(plan), /client_secret|app_password|api_token/i);
});

test("the child environment strips ambient credentials and unrelated application state", () => {
  const env = technicianChildEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    CLOUDFLARE_API_TOKEN: "must-not-cross",
    OPENAI_API_KEY: "must-not-cross",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    GOOGLE_CLIENT_SECRET: "must-not-cross",
    ZOOM_CLIENT_SECRET: "must-not-cross",
    RANDOM_APPLICATION_VALUE: "must-not-cross",
  });
  assert.deepEqual(env, { PATH: "/safe/bin", HOME: "/safe/home", LANG: "en_US.UTF-8" });
  assert.doesNotMatch(JSON.stringify(env), /must-not-cross/);
});

test("Google credentials cross only the child environment, never argv, and input buffers are zeroed", async () => {
  const clientId = Buffer.from("fixture-google-client-id");
  const clientSecret = Buffer.from("fixture-google-client-secret");
  const entered = [clientId, clientSecret];
  const calls = [];
  const receipt = await runTechnicianStep({
    step: "google",
    manifestPath,
    flags: {},
    scriptPath: "/fixture/brain.mjs",
    nodePath: "/fixture/node",
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    readHidden: async () => entered.shift(),
    spawn: (node, args, options) => {
      calls.push({ node, args, options });
      assert.equal(options.env.GOOGLE_CLIENT_ID, "fixture-google-client-id");
      assert.equal(options.env.GOOGLE_CLIENT_SECRET, "fixture-google-client-secret");
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.deepEqual(calls[0].args, ["/fixture/brain.mjs", "connect", "google", "--scopes", "drive,gmail,calendar"]);
  assert.doesNotMatch(calls[0].args.join(" "), /fixture-google/);
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_ID, "");
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_SECRET, "");
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
});

test("Zoom collects the exact S2S values, strips ambient secrets, and zeroes every input", async () => {
  const values = [
    Buffer.from("fixture-account"),
    Buffer.from("fixture-client"),
    Buffer.from("fixture-client-secret"),
    Buffer.from("fixture-webhook-secret"),
  ];
  const originals = [...values];
  let call;
  await runTechnicianStep({
    step: "zoom",
    manifestPath,
    scriptPath: "/fixture/brain.mjs",
    nodePath: "/fixture/node",
    baseEnv: { PATH: "/safe/bin", BANK_FEED_SECRET: "ambient-bank-secret" },
    readHidden: async () => values.shift(),
    spawn: (node, args, options) => {
      call = { node, args, options };
      assert.deepEqual(
        Object.keys(options.env).filter((key) => key.startsWith("ZOOM_")).sort(),
        ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"],
      );
      assert.equal(options.env.BANK_FEED_SECRET, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(call.args, ["/fixture/brain.mjs", "connect", "zoom", manifestPath]);
  assert.doesNotMatch(call.args.join(" "), /fixture-account|fixture-client|fixture-webhook/);
  for (const key of ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"]) {
    assert.equal(call.options.env[key], "");
  }
  for (const buffer of originals) assert.ok(buffer.every((byte) => byte === 0));
});

test("IMAP passes only non-secret routing values and leaves app-password prompting to the connector", async () => {
  let call;
  await runTechnicianStep({
    step: "imap",
    manifestPath,
    flags: { host: "imap.example.test", user: "owner@example.test", port: "993", source: "owner-mail" },
    scriptPath: "/fixture/brain.mjs",
    nodePath: "/fixture/node",
    baseEnv: { PATH: "/safe/bin", IMAP_PASSWORD: "ambient-secret" },
    spawn: (node, args, options) => { call = { node, args, options }; return { status: 0 }; },
  });
  assert.deepEqual(call.args, [
    "/fixture/brain.mjs", "connect", "imap", manifestPath,
    "--host", "imap.example.test", "--user", "owner@example.test",
    "--port", "993", "--source", "owner-mail",
  ]);
  assert.equal(call.options.env.IMAP_PASSWORD, undefined);
  assert.doesNotMatch(JSON.stringify(call), /ambient-secret/);
});

test("passkey enrollment refuses before mutation unless the exact final hostname is confirmed", async () => {
  let calls = 0;
  const common = {
    step: "passkey",
    manifestPath,
    scriptPath: "/fixture/brain.mjs",
    nodePath: "/fixture/node",
    spawn: () => { calls++; return { status: 0 }; },
  };
  await assert.rejects(
    runTechnicianStep({ ...common, flags: { "confirm-host": "other.fixture.test" } }),
    /exactly matches brain\.fixture\.test/,
  );
  assert.equal(calls, 0);
  await runTechnicianStep({ ...common, flags: { "confirm-host": "BRAIN.FIXTURE.TEST" } });
  assert.equal(calls, 1);
});

test("verification is ordered and stops at the first failed proof", async () => {
  const commands = [];
  await assert.rejects(
    runTechnicianStep({
      step: "verify",
      manifestPath,
      scriptPath: "/fixture/brain.mjs",
      nodePath: "/fixture/node",
      spawn: (_node, args) => {
        commands.push(args[1]);
        return { status: args[1] === "health" ? 1 : 0 };
      },
    }),
    /did not complete/,
  );
  assert.deepEqual(commands, ["doctor", "health"]);
});
