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

  it("keeps the rendered markdown body on the content surface", () => {
    const body = cssRuleBody(".ledger-comment-card__body.spec-panel");

    expect(body).toContain("background: var(--surface-content)");
    expect(body).not.toContain("background: var(--surface-code)");
    expect(body).not.toMatch(/background:\s*var\(--neutral-alpha/);
  });

  it("keeps code affordances narrower than the normal prose body", () => {
    const inlineCode = cssRuleBody(".spec-panel code");
    const codeBlock = cssRuleBody(".spec-panel pre");
    const codeInsidePre = cssRuleBody(".spec-panel pre code");

    expect(inlineCode).toContain("background: var(--neutral-alpha-06)");
    expect(codeBlock).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.3\)/);
    expect(codeInsidePre).toContain("background: none");
  });

  it("keeps the issue detail shell off the content surface", () => {
    const body = cssRuleBody(".issues-detail");

    expect(body).not.toContain("background: var(--surface-content)");
    expect(body).not.toContain("background: var(--bg-card)");
  });

  it("maps light content surfaces to primary card white", () => {
    const lightRoot = cssRuleBody(":root[data-theme='light']");
    const lightCommentCard = cssRuleBody(":root[data-theme='light'] .ledger-comment-card");
    const lightCommentBody = cssRuleBody(":root[data-theme='light'] .ledger-comment-card__body.spec-panel");

    expect(lightRoot).toContain("--bg-card: #ffffff");
    expect(lightRoot).toContain("--surface-content: var(--bg-card)");
    expect(lightCommentCard).toContain("background: #ffffff");
    expect(lightCommentBody).toContain("background: #ffffff");
  });
});
