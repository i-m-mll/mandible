import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BriefingDirectiveError, parseBriefingDirectives } from "../src/feedback/briefing-directives.js";

describe("mandible-briefing.v2 directives", () => {
  it("uses UTF-16 ranges and hashes the exact CRLF directive slice", () => {
    const source = "Before 😀\r\n:::spec-item{key=\"ship.it\" type=\"verdict\" required=\"true\"}\r\nBody **here**\r\n:::\r\n";
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
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" type=\"verdict\" required=\"false\"}\n:::spec-item{key=\"b\" type=\"verdict\" required=\"false\"}\nx\n:::\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" type=\"verdict\" required=\"false\" extra=\"x\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" type=\"verdict\" required=\"false\"}\n \n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" type=\"verdict\" required=\"yes\"}\nx\n:::"))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives(":::spec-item{key=\"a\" type=\"verdict\" required=\"false\"}\nx\n::::"))
      .toThrow(BriefingDirectiveError);
  });

  it("accepts exactly six closed types and excludes trailing options from the prompt range", () => {
    const source = [
      ':::spec-item{key="verdict" type="verdict" required="true"}\nKeep it?\n:::',
      ':::spec-item{key="single" type="single_choice" required="false"}\nPick **one**.\n::option[Alpha]{key="a"}\n::option[Beta]{key="b"}\n:::',
      ':::spec-item{key="multi" type="multi_choice" required="false"}\nPick several.\n::option[Alpha]{key="a"}\n::option[Beta]{key="b"}\n:::',
      ':::spec-item{key="short" type="short_text" required="false"}\nShort note.\n:::',
      ':::spec-item{key="long" type="long_text" required="false"}\nLong note.\n:::',
      ':::spec-item{key="rating" type="rating" required="false"}\nRate it.\n:::',
    ].join("\n\n");
    const parsed = parseBriefingDirectives(source);
    expect(parsed.map((directive) => directive.type)).toEqual([
      "verdict", "single_choice", "multi_choice", "short_text", "long_text", "rating",
    ]);
    expect(parsed[1].options).toEqual([{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }]);
    expect(source.slice(parsed[1].body_start_offset, parsed[1].body_end_offset)).toBe("Pick **one**.");
  });

  it("rejects misplaced, non-plain, duplicate, noncontiguous, and wrong-type options", () => {
    const wrap = (type: string, options: string) =>
      `:::spec-item{key="a" type="${type}" required="false"}\nPrompt\n${options}\n:::`;
    expect(() => parseBriefingDirectives(wrap("single_choice", '::option[One]{key="one"}'))).toThrow(/2-12/);
    expect(() => parseBriefingDirectives(wrap("verdict", '::option[One]{key="one"}\n::option[Two]{key="two"}'))).toThrow(/only/);
    expect(() => parseBriefingDirectives(wrap("single_choice", '::option[**One**]{key="one"}\n::option[Two]{key="two"}'))).toThrow(/plain text/);
    expect(() => parseBriefingDirectives(wrap("single_choice", '::option[One]{key="same"}\n::option[Two]{key="same"}'))).toThrow(/unique/);
    expect(() => parseBriefingDirectives(wrap("single_choice", '::option[One]{key="one"}\n\n::option[Two]{key="two"}'))).toThrow(/contiguous/);
    expect(() => parseBriefingDirectives(wrap("single_choice", '::option[One]{key="one"}\nTrailing\n::option[Two]{key="two"}'))).toThrow(/trailing/);
  });
});
