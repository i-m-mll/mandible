import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BriefingDirectiveError, parseBriefingDirectives } from "../src/feedback/briefing-directives.js";
import { RICH_BRIEFING_ROUND_ONE_MARKDOWN, RICH_BRIEFING_ROUND_TWO_MARKDOWN } from "../src/feedback/rich-briefing-demo.js";

describe("mandible-briefing.v1 directives", () => {
  it("uses UTF-16 ranges and hashes the exact CRLF directive slice", () => {
    const source = "Before 😀\r\n:::spec-item{key=\"ship.it\" required=\"true\"}\r\nBody **here**\r\n:::\r\n";
    const [directive] = parseBriefingDirectives(source);
    expect(directive.start_offset).toBe(source.indexOf(":::spec-item"));
    expect(source.slice(directive.body_start_offset, directive.body_end_offset)).toBe("Body **here**");
    expect(directive.definition_digest).toBe(createHash("sha256")
      .update(Buffer.from(source.slice(directive.start_offset, directive.end_offset), "utf8")).digest("hex"));
    expect(directive.required).toBe(true);
  });

  it("rejects nested, malformed, and empty directives", () => {
    expect(() => parseBriefingDirectives("ordinary prose"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::unknown{key=\"a\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\"}\n:::spec-item{key=\"b\"}\nx\n:::\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" extra=\"x\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\"}\n \n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" required=\"yes\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\"}\nx\n::::"))
      .toThrow(BriefingDirectiveError);
  });

  it("pins the rich demo to four stable verdict directives with exact ranges and requiredness", () => {
    const first = parseBriefingDirectives(RICH_BRIEFING_ROUND_ONE_MARKDOWN);
    const second = parseBriefingDirectives(RICH_BRIEFING_ROUND_TWO_MARKDOWN);
    expect(first.map(({ key, required }) => [key, required])).toEqual([
      ["scope.approval", true],
      ["rollback.plan", true],
      ["observability", false],
      ["operator.runbook", false],
    ]);
    expect(second.map(({ key, required }) => [key, required])).toEqual(first.map(({ key, required }) => [key, required]));
    for (const directive of first) {
      expect(RICH_BRIEFING_ROUND_ONE_MARKDOWN.slice(directive.body_start_offset, directive.body_end_offset)).toBe(directive.body);
      expect(directive.definition_digest).toBe(createHash("sha256")
        .update(RICH_BRIEFING_ROUND_ONE_MARKDOWN.slice(directive.start_offset, directive.end_offset)).digest("hex"));
    }
    expect(second.map((directive) => directive.definition_digest)).not.toEqual(first.map((directive) => directive.definition_digest));
  });
});
