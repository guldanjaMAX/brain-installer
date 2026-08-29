import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GRANT_VIEWS, GrantWorkspace, OWNER_VIEWS, visibleView,
} from "./App";
import type { Me } from "./lib/api";

const grantMe: Me = {
  signed_in: true,
  brain: "Fixture Brain",
  principal: {
    kind: "grant",
    grant_id: "dg_fixture",
    entity_slug: "fixture-entity",
    document_count: 2,
    capabilities: ["documents:read", "ask"],
  },
  workspace: {
    home: false,
    documents: true,
    ask: true,
    add_review: false,
    access: false,
    bank: false,
    targets: false,
    preferences: false,
  },
};

describe("principal workspace routing", () => {
  it("keeps the full owner navigation and limits a grant to Documents and Explore", () => {
    expect(OWNER_VIEWS).toEqual(["home", "year", "documents", "ask", "review", "access"]);
    expect(GRANT_VIEWS).toEqual(["documents", "ask"]);
    for (const forbidden of ["home", "year", "review", "access"] as const) {
      expect(visibleView("grant", forbidden)).toBe("documents");
    }
    expect(visibleView("grant", "ask")).toBe("ask");
    expect(visibleView("owner", "access")).toBe("access");
  });

  it("renders no owner navigation or owner-only route in the grant shell", () => {
    const html = renderToStaticMarkup(<GrantWorkspace me={grantMe} onAccessEnded={() => undefined} />);
    expect(html).toContain("Shared documents");
    expect(html).toContain("Explore");
    expect(html).not.toContain("Home</button>");
    expect(html).not.toContain("This Year");
    expect(html).not.toContain("Add &amp; Review");
    expect(html).not.toContain("Access</button>");
    expect(html).not.toContain("Owner preferences");
    expect(html).not.toContain("Add a text record");
  });
});
