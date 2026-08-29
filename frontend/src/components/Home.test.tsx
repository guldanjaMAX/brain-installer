import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinanceScopeProvider } from "./FinanceScope";
import { Home } from "./Home";

describe("home composition", () => {
  it("mounts durable change history before financial reads resolve", () => {
    const html = renderToStaticMarkup(
      <FinanceScopeProvider><Home /></FinanceScopeProvider>,
    );
    expect(html).toContain("What changed");
    expect(html).not.toContain("visit-to-visit change history is not available");
  });
});
