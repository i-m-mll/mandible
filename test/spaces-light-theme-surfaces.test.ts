import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheets = {
  canvas: readFileSync("ui/src/views/spaces/SpaceCanvas.css", "utf8"),
  board: readFileSync("ui/src/views/spaces/space-board.css", "utf8"),
};

function cssRuleBody(stylesheet: string, selector: string): string {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return "";
}

describe("Spaces light theme surfaces", () => {
  it("keeps the canvas flow and bottom inspector on real app theme tokens", () => {
    const flow = cssRuleBody(stylesheets.canvas, ".space-canvas__flow");
    const inspector = cssRuleBody(stylesheets.canvas, ".space-canvas__inspector");
    const node = cssRuleBody(stylesheets.canvas, ".space-canvas__node");

    expect(flow).toContain("position: relative");
    expect(inspector).toContain("background: var(--bg-secondary)");
    expect(inspector).toContain("border-top: 1px solid var(--border");
    expect(node).toContain("background: var(--bg-card)");
    expect(node).toContain("color: var(--text-primary)");
    expect(inspector).not.toContain("var(--surface");
    expect(node).not.toContain("var(--surface-raised");
    expect(node).not.toContain("var(--text,");
  });

  // The `SpaceEdgeLayer` panel this suite also covered was retired and deleted
  // along with `SpaceEdgeLayer.css`; the canvas inspector above is its
  // replacement surface.

  it("keeps the board column menu and filter editor on real app theme tokens", () => {
    const menu = cssRuleBody(stylesheets.board, ".space-board__add-column-menu");
    const filter = cssRuleBody(stylesheets.board, ".space-board-filter");
    const filterInput = cssRuleBody(stylesheets.board, ".space-board-filter__input input");
    const filterActions = cssRuleBody(stylesheets.board, ".space-board-filter__actions");
    const filterButton = cssRuleBody(stylesheets.board, ".space-board-filter__actions button");

    expect(menu).toContain("background: var(--bg-secondary)");
    expect(menu).toContain("color: var(--text-primary");
    expect(menu).toContain("width: min(24rem");
    expect(filter).toContain("gap: 0.45rem");
    expect(filterInput).toContain("background: var(--bg-secondary)");
    expect(filterInput).toContain("color: var(--text-primary");
    expect(filterActions).toContain("flex-wrap: nowrap");
    expect(filterButton).toContain("color: var(--text-primary");

    for (const body of [menu, filterInput, filterButton]) {
      expect(body).not.toContain("#2a2a3a");
      expect(body).not.toContain("var(--surface");
      expect(body).not.toContain("var(--text,");
      expect(body).not.toContain("var(--bg-emphasis");
    }
  });
});
