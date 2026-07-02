import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync("ui/src/style.css", "utf8");
const tokensStylesheet = readFileSync("ui/src/styles/tokens.css", "utf8");

function cssRuleBodyIn(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function cssRuleBody(selector: string): string {
  return cssRuleBodyIn(stylesheet, selector);
}

function cssRule(selector: string): string {
  const body = cssRuleBody(selector);
  expect(body).not.toBe("");
  const fixtureBody = body.replaceAll("var(--neutral-alpha-06)", "rgba(15, 23, 42, 0.06)");
  return `${selector} {${fixtureBody}}`;
}

function createRenderedCommentFixture(): Document {
  const dom = new JSDOM(
    `<!doctype html>
    <html data-theme="light">
      <head></head>
      <body>
        <div class="issues-detail">
          <article class="ledger-issue-detail">
            <section class="ledger-issue-detail__section">
              <div class="ledger-comment-list ledger-timeline-list">
                <div id="comment-0" class="ledger-comment-card ledger-timeline-card">
                  <div class="ledger-comment-card__body spec-panel">
                    <p>
                      Normal prose with a long inline code ref
                      <code>repo://feedbax@2446b61/docs/design/spec_bundle_audit.md</code>
                      after it.
                    </p>
                    <pre><code>block code keeps its block affordance</code></pre>
                  </div>
                </div>
              </div>
            </section>
          </article>
        </div>
      </body>
    </html>`,
    { pretendToBeVisual: true },
  );
  const style = dom.window.document.createElement("style");
  style.textContent = [
    cssRule(":root[data-theme='light'] .ledger-comment-card"),
    cssRule(":root[data-theme='light'] .ledger-comment-card__body.spec-panel"),
    cssRule(".spec-panel code"),
    cssRule(".ledger-comment-card__body.spec-panel code:not(pre code)"),
    cssRule(".spec-panel pre"),
    cssRule(".spec-panel pre code"),
  ].join("\n");
  dom.window.document.head.append(style);
  return dom.window.document;
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

  it("keeps the timeline inspector body on the normal content surface", () => {
    const body = cssRuleBody(".timeline-event-body");

    expect(body).toContain("min-height: 0");
    expect(body).toContain("background: var(--surface-content)");
    expect(body).not.toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.22\)/);
  });

  it("keeps comment inline code clear while preserving code-block affordances", () => {
    const inlineCode = cssRuleBody(".spec-panel code");
    const codeBlock = cssRuleBody(".spec-panel pre");
    const codeInsidePre = cssRuleBody(".spec-panel pre code");
    const commentInlineCode = cssRuleBody(".ledger-comment-card__body.spec-panel code:not(pre code)");

    expect(inlineCode).toContain("background: var(--neutral-alpha-06)");
    expect(commentInlineCode).toContain("background: transparent");
    expect(commentInlineCode).not.toMatch(/background:\s*var\(--neutral-alpha/);
    expect(codeBlock).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.3\)/);
    expect(codeInsidePre).toContain("background: none");
  });

  it("keeps the issue detail shell off the content surface", () => {
    const lightTokens = cssRuleBodyIn(tokensStylesheet, "[data-theme='light']");
    const body = cssRuleBody(".issues-detail");

    expect(lightTokens).toContain("--neutral-4: #e8edf4");
    expect(lightTokens).toContain("--issues-detail-bg: var(--neutral-4)");
    expect(body).toContain("background: var(--issues-detail-bg)");
    expect(body).not.toContain("background: var(--surface-content)");
    expect(body).not.toContain("background: var(--bg-card)");
  });

  it("maps light content surfaces to primary card white", () => {
    const lightTokens = cssRuleBodyIn(tokensStylesheet, "[data-theme='light']");
    const lightCommentCard = cssRuleBody(":root[data-theme='light'] .ledger-comment-card");
    const lightCommentBody = cssRuleBody(":root[data-theme='light'] .ledger-comment-card__body.spec-panel");

    expect(lightTokens).toContain("--neutral-1: #ffffff");
    expect(lightTokens).toContain("--surface-card: var(--neutral-1)");
    expect(lightCommentCard).toContain("background: #ffffff");
    expect(lightCommentBody).toContain("background: #ffffff");
  });

  it("renders the issue body surface white with transparent inline code", () => {
    const document = createRenderedCommentFixture();
    const view = document.defaultView;
    expect(view).toBeTruthy();

    const comment = document.querySelector("#comment-0");
    const body = document.querySelector(".ledger-comment-card__body.spec-panel");
    const prose = document.querySelector(".ledger-comment-card__body.spec-panel p");
    const inlineCode = document.querySelector(".ledger-comment-card__body.spec-panel p code");
    const codeBlock = document.querySelector(".ledger-comment-card__body.spec-panel pre");
    const codeInsidePre = document.querySelector(".ledger-comment-card__body.spec-panel pre code");

    expect(comment).toBeInstanceOf(view!.HTMLElement);
    expect(body).toBeInstanceOf(view!.HTMLElement);
    expect(prose).toBeInstanceOf(view!.HTMLElement);
    expect(inlineCode).toBeInstanceOf(view!.HTMLElement);
    expect(codeBlock).toBeInstanceOf(view!.HTMLElement);
    expect(codeInsidePre).toBeInstanceOf(view!.HTMLElement);

    expect(view!.getComputedStyle(comment!).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(view!.getComputedStyle(body!).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(view!.getComputedStyle(prose!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(view!.getComputedStyle(inlineCode!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(view!.getComputedStyle(inlineCode!).padding).toBe("0px");
    expect(view!.getComputedStyle(codeBlock!).backgroundColor).toBe("rgba(0, 0, 0, 0.3)");
    expect(view!.getComputedStyle(codeInsidePre!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
});
