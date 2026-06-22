import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync("ui/src/style.css", "utf8");

function cssRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("ledger comment card surfaces", () => {
  it("uses the content surface for issue timeline comment cards", () => {
    const body = cssRuleBody(".ledger-comment-card");

    expect(body).toContain("background: var(--surface-content)");
    expect(body).not.toMatch(/background:\s*var\(--neutral-alpha/);
  });

  it("keeps the issue detail shell off the content surface", () => {
    const body = cssRuleBody(".issues-detail");

    expect(body).not.toContain("background: var(--surface-content)");
    expect(body).not.toContain("background: var(--bg-card)");
  });

  it("maps light content surfaces to primary card white", () => {
    const lightRoot = cssRuleBody(":root[data-theme='light']");
    const lightCommentCard = cssRuleBody(":root[data-theme='light'] .ledger-comment-card");

    expect(lightRoot).toContain("--bg-card: #ffffff");
    expect(lightRoot).toContain("--surface-content: var(--bg-card)");
    expect(lightCommentCard).toContain("background: #ffffff");
  });
});
