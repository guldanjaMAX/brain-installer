import { describe, expect, it } from "vitest";
import { OWNER_VIEWS, PRIMARY_OWNER_NAV, visibleView } from "./App";

describe("owner workspace routing", () => {
  it("keeps Ask as an internal destination without putting it in primary navigation", () => {
    expect(OWNER_VIEWS).toEqual(["home", "year", "documents", "ask", "access"]);
    expect(visibleView("ask")).toBe("ask");
    expect(visibleView("access")).toBe("access");
  });

  it("keeps Ask and Add & Review out of the primary menu", () => {
    expect(PRIMARY_OWNER_NAV).toEqual([
      { view: "home", label: "Home" },
      { view: "year", label: "This Year" },
      { view: "documents", label: "Documents" },
      { view: "access", label: "Manage" },
    ]);
    expect(PRIMARY_OWNER_NAV.map((item) => item.label)).not.toContain("Ask");
    expect(PRIMARY_OWNER_NAV.map((item) => item.label)).not.toContain("Add & Review");
  });

  it("falls back to Home for anything outside the owner-only view set", () => {
    expect(visibleView("home")).toBe("home");
  });
});
