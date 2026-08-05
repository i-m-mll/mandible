import { describe, expect, it } from "vitest";
import {
  extractMandibleClosingIssueRefs,
  extractMandibleIssueRefs,
} from "../src/utils/bug-refs.js";

// Issue 1624ee9 — trailer parsing was duplicated across auth-queue,
// operational-links, and sse; the sse copy captured only the FIRST trailer.
// These tests pin the shared contract: all matches, message order, no dedup.
describe("extractMandibleIssueRefs", () => {
  it("returns every Mandible-Issue trailer, not just the first", () => {
    const message = [
      "Merge branch 'feature/multi'",
      "",
      "Mandible-Issue: aaa1111",
      "Mandible-Issue: bbb2222",
      "Mandible-Issue: ccc3333",
    ].join("\n");
    expect(extractMandibleIssueRefs(message)).toEqual(["aaa1111", "bbb2222", "ccc3333"]);
  });

  it("preserves message order and does not dedup repeats", () => {
    const message = "Mandible-Issue: aaa1111\nMandible-Issue: aaa1111\nMandible-Issue: bbb2222";
    expect(extractMandibleIssueRefs(message)).toEqual(["aaa1111", "aaa1111", "bbb2222"]);
  });

  it("is stateless across calls (module-level /g regex is not shared)", () => {
    const message = "Mandible-Issue: aaa1111\nMandible-Issue: bbb2222";
    const first = extractMandibleIssueRefs(message);
    const second = extractMandibleIssueRefs(message);
    expect(second).toEqual(first);
    expect(second).toHaveLength(2);
  });

  it("ignores closing trailers and non-anchored mentions", () => {
    const message = [
      "Fix thing",
      "",
      "Closes-Mandible-Issue: ddd4444",
      "See also Mandible-Issue: eee5555 inline",
      "Mandible-Issue: fff6666",
    ].join("\n");
    expect(extractMandibleIssueRefs(message)).toEqual(["fff6666"]);
  });

  it("returns an empty array for messages without trailers and for empty input", () => {
    expect(extractMandibleIssueRefs("Merge branch 'feature/none'")).toEqual([]);
    expect(extractMandibleIssueRefs("")).toEqual([]);
    expect(extractMandibleIssueRefs(null)).toEqual([]);
    expect(extractMandibleIssueRefs(undefined)).toEqual([]);
  });
});

describe("extractMandibleClosingIssueRefs", () => {
  it("returns every Closes-Mandible-Issue trailer", () => {
    const message = [
      "Deliver work",
      "",
      "Mandible-Issue: aaa1111",
      "Closes-Mandible-Issue: bbb2222",
      "Closes-Mandible-Issue: ccc3333",
    ].join("\n");
    expect(extractMandibleClosingIssueRefs(message)).toEqual(["bbb2222", "ccc3333"]);
  });

  it("does not treat plain reference trailers as closures", () => {
    expect(extractMandibleClosingIssueRefs("Mandible-Issue: aaa1111")).toEqual([]);
  });

  it("returns an empty array for missing or empty input", () => {
    expect(extractMandibleClosingIssueRefs("no trailers here")).toEqual([]);
    expect(extractMandibleClosingIssueRefs(null)).toEqual([]);
    expect(extractMandibleClosingIssueRefs(undefined)).toEqual([]);
  });
});
