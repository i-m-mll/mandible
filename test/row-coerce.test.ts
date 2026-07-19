import { describe, expect, it } from "vitest";
import { nullableNumber, nullableString, parseJsonOr } from "../src/row-coerce.js";

describe("row coercion helpers", () => {
  it("normalizes nullish strings to null and preserves existing coercion", () => {
    expect(nullableString(undefined)).toBeNull();
    expect(nullableString(null)).toBeNull();
    expect(nullableString("value")).toBe("value");
    expect(nullableString(42)).toBe("42");
  });

  it("normalizes nullish numbers to null and preserves existing coercion", () => {
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber(null)).toBeNull();
    expect(nullableNumber(42)).toBe(42);
    expect(nullableNumber("42")).toBe(42);
  });

  it("parses JSON or returns the caller-provided fallback", () => {
    const fallback = { fallback: true };

    expect(parseJsonOr<{ value: number }>('{"value":1}', fallback)).toEqual({ value: 1 });
    expect(parseJsonOr(undefined, fallback)).toBe(fallback);
    expect(parseJsonOr(null, fallback)).toBe(fallback);
    expect(parseJsonOr("{malformed", fallback)).toBe(fallback);
  });
});
