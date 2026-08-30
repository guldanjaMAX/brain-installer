import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  cloudflareTokenAvailable,
  readHiddenCloudflareToken,
  withCloudflareToken,
} from "../brain.mjs";

class FakeTty extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawStates = [];
  }

  setRawMode(value) {
    this.isRaw = Boolean(value);
    this.rawStates.push(this.isRaw);
    return this;
  }
}

function outputTty() {
  const output = new PassThrough();
  output.isTTY = true;
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  return { output, text: () => text };
}

test("hidden prompt handles backspace without echoing and restores terminal mode", async () => {
  const input = new FakeTty();
  const { output, text } = outputTty();
  const pending = readHiddenCloudflareToken({ input, output });
  input.write(Buffer.from("fixture-cloudflare-token-xX\x7fX\r", "binary"));
  const token = await pending;
  assert.equal(token.toString("ascii"), "fixture-cloudflare-token-xX");
  assert.deepEqual(input.rawStates, [true, false]);
  assert.equal(input.isRaw, false);
  assert.match(text(), /Cloudflare token \(hidden\)/);
  assert.doesNotMatch(text(), /fixture-cloudflare-token/);
  token.fill(0);
});

test("Ctrl-C rejects and still restores terminal mode", async () => {
  const input = new FakeTty();
  const { output } = outputTty();
  const pending = readHiddenCloudflareToken({ input, output });
  input.write(Buffer.from([0x03]));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(input.rawStates, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

test("a non-TTY refuses to read a secret insecurely", async () => {
  await assert.rejects(
    readHiddenCloudflareToken({ input: new PassThrough(), output: new PassThrough() }),
    /cannot prompt securely/,
  );
});

test("command-scoped token exists only inside the action and is scrubbed afterward", async () => {
  const prior = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const entered = Buffer.from("fixture-command-scoped-token");
  try {
    await withCloudflareToken(async () => {
      assert.equal(cloudflareTokenAvailable(), true);
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
    }, { readCloudflareToken: async () => entered });
    assert.equal(cloudflareTokenAvailable(), false);
    assert.equal(entered.every((byte) => byte === 0), true);

    const failed = Buffer.from("fixture-command-scoped-token");
    await assert.rejects(
      withCloudflareToken(async () => { throw new Error("fixture action failed"); }, {
        readCloudflareToken: async () => failed,
      }),
      /fixture action failed/,
    );
    assert.equal(cloudflareTokenAvailable(), false);
    assert.equal(failed.every((byte) => byte === 0), true);
  } finally {
    if (prior === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prior;
  }
});

test("an exported token bypasses prompting and is not changed", async () => {
  const prior = process.env.CLOUDFLARE_API_TOKEN;
  const fixture = "fixture-exported-cloudflare-token";
  process.env.CLOUDFLARE_API_TOKEN = fixture;
  let prompts = 0;
  try {
    await withCloudflareToken(async () => {
      assert.equal(cloudflareTokenAvailable(), true);
    }, { readCloudflareToken: async () => { prompts++; return Buffer.from("should-not-be-used-token"); } });
    assert.equal(prompts, 0);
    assert.equal(process.env.CLOUDFLARE_API_TOKEN, fixture);
  } finally {
    if (prior === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prior;
  }
});
