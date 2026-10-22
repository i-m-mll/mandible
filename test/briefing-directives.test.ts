// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BRIEFING_PROFILE_V3, BriefingDirectiveError, parseBriefingDirectives } from "../src/feedback/briefing-directives.js";

describe("mandible-briefing.v2 directives", () => {
  it("keeps canonical typed references out of the directive grammar", () => {
    const references = [
      "[issue:a55b4b3]", "[issue:rlrmp2/28ed941]",
      "[comment:db381cc#18]", "[comment:rlrmp2/db381cc#18]",
      "[artifact:alpha-report]", "[artifact:rlrmp2/alpha-report]",
      "[artifact-version:av_01Kabc]", "[artifact-version:rlrmp2/av_01Kabc]",
      "[artifact-series:alpha-report@2]", "[artifact-series:rlrmp2/alpha-report@2]",
      "[artifact-blob:abcdef1]", "[artifact-blob:rlrmp2/abcdef1]",
    ];
    const source = `${references.join("\n")} 😀\n\n:::spec-item{key="ship" type="verdict" required="false"}\nShip it?\n:::`;
    const directives = parseBriefingDirectives(source, BRIEFING_PROFILE_V3);
    expect(directives.map((directive) => directive.key)).toEqual(["ship"]);
    expect(source.slice(directives[0].start_offset, directives[0].end_offset))
      .toBe(':::spec-item{key="ship" type="verdict" required="false"}\nShip it?\n:::');
  });

  it("masks explicit approval refs without interpreting them as directives", () => {
    expect(parseBriefingDirectives("See [auth:2257522a] and [auth:2257522a-39a2-467b-b3f8-491aea66754c].", BRIEFING_PROFILE_V3, { allowEmpty: true })).toEqual([]);
  });

  it("keeps v2 frozen while v3 parses exact text alternatives", () => {
    const source = `# Policy

:::spec-item{key="push-authorization" type="text_variant" required="false"}
::alternative[Current wording]{key="current"}
First **nonblank** Markdown body.
::alternative[Action-scoped wording]{key="action-scoped"}
Second nonblank Markdown body.
:::`;
    expect(() => parseBriefingDirectives(source)).toThrow(/unsupported/);
    const directive = parseBriefingDirectives(source, BRIEFING_PROFILE_V3)[0];
    expect(directive.variants.map(({ key, label, body }) => ({ key, label, body }))).toEqual([
      { key: "current", label: "Current wording", body: "First **nonblank** Markdown body." },
      { key: "action-scoped", label: "Action-scoped wording", body: "Second nonblank Markdown body." },
    ]);
  });

  it.each([
    `:::spec-item{key="x" type="text_variant" required="false"}\n::alternative[A]{key="a"}\nA\n:::`,
    `:::spec-item{key="x" type="text_variant" required="false"}\n::alternative[A]{key="a"}\nA\n::alternative[B]{key="a"}\nB\n:::`,
    `:::spec-item{key="x" type="text_variant" required="false"}\n::alternative[A]{other="a"}\nA\n::alternative[B]{key="b"}\nB\n:::`,
    `:::spec-item{key="x" type="verdict" required="false"}\nPrompt\n::alternative[A]{key="a"}\nA\n::alternative[B]{key="b"}\nB\n:::`,
  ])("fails closed on malformed v3 alternatives", (source) => {
    expect(() => parseBriefingDirectives(source, BRIEFING_PROFILE_V3)).toThrow();
  });
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
    expect(() => parseBriefingDirectives(":unsupported[text]", BRIEFING_PROFILE_V3, { allowEmpty: true }))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives("::unsupported[text]", BRIEFING_PROFILE_V3, { allowEmpty: true }))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives("[issue:repo/issue/extra]", BRIEFING_PROFILE_V3, { allowEmpty: true }))
      .toThrow(BriefingDirectiveError);
    expect(() => parseBriefingDirectives("[artifact:sha256:abcdef1]", BRIEFING_PROFILE_V3, { allowEmpty: true }))
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
