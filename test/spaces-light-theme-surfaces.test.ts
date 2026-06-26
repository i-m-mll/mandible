import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheets = {
  canvas: readFileSync("ui/src/views/spaces/SpaceCanvas.css", "utf8"),
  edges: readFileSync("ui/src/views/spaces/SpaceEdgeLayer.css", "utf8"),
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
  it("keeps the canvas shelf on real app theme tokens", () => {
    const shelf = cssRuleBody(stylesheets.canvas, ".space-canvas__shelf");
    const shelfItem = cssRuleBody(stylesheets.canvas, ".space-canvas__shelf-item");

    expect(shelf).toContain("background: var(--bg-secondary)");
    expect(shelf).not.toContain("var(--surface");
    expect(shelfItem).toContain("background: var(--bg-card)");
    expect(shelfItem).toContain("color: var(--text-primary)");
    expect(shelfItem).not.toContain("var(--surface-raised");
    expect(shelfItem).not.toContain("var(--text,");
  });

  it("keeps the edge panel and controls on real app theme tokens", () => {
    const panel = cssRuleBody(stylesheets.edges, ".space-edge-layer");
    const create = cssRuleBody(stylesheets.edges, ".space-edge-layer__create");
    const input = cssRuleBody(stylesheets.edges, ".space-edge-layer__input");
    const button = cssRuleBody(stylesheets.edges, ".space-edge-layer__btn");
    const empty = cssRuleBody(stylesheets.edges, ".space-edge-layer__empty");

    expect(panel).toContain("background: var(--bg-secondary)");
    expect(panel).toContain("color: var(--text-primary)");
    expect(create).not.toContain("var(--surface");
    expect(input).toContain("background: var(--bg-card)");
    expect(input).toContain("color: var(--text-primary)");
    expect(button).toContain("background: var(--bg-card)");
    expect(button).toContain("color: var(--text-primary)");
    expect(empty).toContain("color: var(--text-muted");

    for (const body of [panel, create, input, button, empty]) {
      expect(body).not.toContain("var(--surface");
      expect(body).not.toContain("var(--text,");
    }
  });

  it("keeps the selected board manual mode tab off dark fallback chrome", () => {
    const selectedMode = cssRuleBody(
      stylesheets.board,
      ".space-board__add-column-mode[aria-selected='true']",
    );

    expect(selectedMode).toContain("background: var(--status-info-bg)");
    expect(selectedMode).toContain("border-color: var(--accent-blue)");
    expect(selectedMode).toContain("color: var(--text-primary)");
    expect(selectedMode).not.toContain("#2a2a3a");
    expect(selectedMode).not.toContain("var(--accent-subtle");
    expect(selectedMode).not.toContain("var(--bg-emphasis");
  });
});
