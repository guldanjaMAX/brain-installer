import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceScopeProvider } from "./FinanceScope";
import { Home } from "./Home";

describe("home composition", () => {
  it("mounts durable change history before financial reads resolve", () => {
    const html = renderToStaticMarkup(
      <FinanceScopeProvider><Home onExplore={() => undefined} /></FinanceScopeProvider>,
    );
    expect(html).toContain("What changed");
    expect(html).toContain("Your financial life, in one clear view");
    expect(html).toContain("Explore");
    expect(html).toContain("Customized Tasks");
    expect(html).toContain("Review Priorities");
    expect(html).toContain("Viewing");
    expect(html).not.toContain("visit-to-visit change history is not available");
    expect(html).not.toContain("Review top priority");
  });
});
