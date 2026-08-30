import { describe, expect, it } from "vitest";
import { ActionRequestIds } from "./useActionRequests";

describe("owner write idempotency keys", () => {
  it("preserves one request id for every unchanged owner write intent", () => {
    for (const prefix of [
      "upload", "approval", "period_close", "target", "preference", "document_access",
    ]) {
      const ids = new ActionRequestIds(prefix);
      const first = ids.forAction("unchanged intent");
      expect(ids.forAction("unchanged intent"), prefix).toBe(first);
      expect(first, prefix).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  it("keeps one key through retries and resets only after confirmation", () => {
    const ids = new ActionRequestIds("approval");
    const first = ids.forAction("same normalized decision");
    expect(ids.forAction("same normalized decision")).toBe(first);
    expect(ids.forAction("materially edited decision")).not.toBe(first);
    ids.confirmed("same normalized decision");
    expect(ids.forAction("same normalized decision")).not.toBe(first);
  });

  it("uses object identity to distinguish a newly selected upload", () => {
    const ids = new ActionRequestIds("upload");
    const file = { name: "notes.txt" };
    const first = ids.forAction(file);
    expect(ids.forAction(file)).toBe(first);
    expect(ids.forAction({ name: "notes.txt" })).not.toBe(first);
  });
});
