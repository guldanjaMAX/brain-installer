import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UpdateStatusCard } from "./Settings";
import type { UpdateStatus } from "../lib/api";

const base: UpdateStatus = {
  status: "update_available",
  installed_version: "0.2.0",
  latest_version: "0.3.0",
  checked_at: "2026-08-30T12:00:00.000Z",
  published_at: "2026-08-30",
  update_url: "https://financialbrain.ai/update",
  claude_prompt: "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.",
  changes: ["A reviewed synthetic change."],
};

describe("client update status", () => {
  it("shows the available version, changes, and one Claude handoff", () => {
    const html = renderToStaticMarkup(<UpdateStatusCard update={base} onRetry={() => undefined} />);
    expect(html).toContain("Version 0.3.0 is ready");
    expect(html).toContain("You currently have 0.2.0");
    expect(html).toContain("A reviewed synthetic change.");
    expect(html).toContain("Open https://financialbrain.ai/update");
    expect(html).toContain("Copy for Claude");
    expect(html).toContain("Open update guide");
  });

  it("does not turn an unavailable release channel into an up-to-date claim", () => {
    const html = renderToStaticMarkup(<UpdateStatusCard update={{
      status: "unavailable",
      error: "unavailable",
      code: "update_check_unavailable",
      installed_version: "0.2.0",
      latest_version: null,
      checked_at: base.checked_at,
      update_url: base.update_url,
    }} onRetry={() => undefined} />);
    expect(html).toContain("update check is unavailable");
    expect(html).toContain("not treating an unreachable release channel as proof that you are up to date");
    expect(html).not.toContain("You are up to date");
    expect(html).toContain("Check again");
  });

  it("shows an exact stable match as up to date", () => {
    const html = renderToStaticMarkup(<UpdateStatusCard update={{
      ...base, status: "up_to_date", installed_version: "0.3.0",
    }} onRetry={() => undefined} />);
    expect(html).toContain("You are up to date");
    expect(html).toContain("Version 0.3.0");
  });

  it("shows a held release explicitly without an executable handoff", () => {
    const html = renderToStaticMarkup(<UpdateStatusCard update={{
      status: "release_held",
      release_state: "held",
      available: false,
      installed_version: "0.2.0",
      latest_version: null,
      checked_at: base.checked_at,
      update_url: base.update_url,
      held_reason: "Clean-machine checks remain open.",
    }} onRetry={() => undefined} />);
    expect(html).toContain("next release is held");
    expect(html).toContain("Clean-machine checks remain open");
    expect(html).toContain("No installer or update command is available");
    expect(html).not.toContain("Copy for Claude");
  });

  it("shows a candidate as non-installable without a Claude command", () => {
    const html = renderToStaticMarkup(<UpdateStatusCard update={{
      status: "release_candidate",
      release_state: "candidate",
      available: false,
      installed_version: "0.2.0",
      latest_version: null,
      checked_at: base.checked_at,
      update_url: base.update_url,
      held_reason: "Remote Windows proof remains open.",
    }} onRetry={() => undefined} />);
    expect(html).toContain("candidate is still under review");
    expect(html).toContain("not installable until it becomes a reviewed stable release");
    expect(html).not.toContain("Copy for Claude");
  });
});
