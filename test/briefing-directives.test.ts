import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BriefingDirectiveError, parseBriefingDirectives } from "../src/feedback/briefing-directives.js";

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
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\"}\n:::spec-item{key=\"b\"}\nx\n:::\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" extra=\"x\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\"}\n \n:::"))
      .toThrow(BriefingDirectiveError);
  });
});
