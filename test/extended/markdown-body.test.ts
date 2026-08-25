import { describe, expect, it } from "vitest";
import {
  detectAccidentalEscapedMarkdown,
  evaluateMarkdownBodyPolicy,
  parseMarkdownBodyEscapePolicy,
} from "../../src/ledger/markdown-body.js";

describe("Markdown body escape policy", () => {
  it("detects repeated literal escaped newlines with few real newlines", () => {
    const detection = detectAccidentalEscapedMarkdown("Implemented change.\\n\\nDetails:\\n- item");

    expect(detection).toMatchObject({
      suspicious: true,
      literal_newline_count: 3,
      actual_newline_count: 0,
    });
  });

  it("does not flag normal Markdown with real newlines", () => {
    const detection = detectAccidentalEscapedMarkdown("Implemented change.\n\nDetails:\n- item");

    expect(detection.suspicious).toBe(false);
  });

  it("ignores code-ish intentional escaped newline examples", () => {
    expect(detectAccidentalEscapedMarkdown("```json\n{\"body\":\"a\\n\\nb\"}\n```").suspicious).toBe(false);
    expect(detectAccidentalEscapedMarkdown("{\"body\":\"a\\n\\nb\"}").suspicious).toBe(false);
    expect(detectAccidentalEscapedMarkdown("Use `\\n\\n` for a blank escaped line.").suspicious).toBe(false);
  });

  it("supports allow, warn, and reject policy actions without normalizing", () => {
    const body = "One\\n\\nTwo";

    expect(evaluateMarkdownBodyPolicy(body, "allow")).toMatchObject({ action: "allow" });
    expect(evaluateMarkdownBodyPolicy(body, "warn")).toMatchObject({
      action: "warn",
      warning: { code: "literal_escaped_newlines" },
    });
    expect(evaluateMarkdownBodyPolicy(body, "reject")).toMatchObject({
      action: "reject",
      warning: { code: "literal_escaped_newlines" },
    });
  });

  it("defaults unknown settings to warn", () => {
    expect(parseMarkdownBodyEscapePolicy("bogus")).toBe("warn");
  });
});
