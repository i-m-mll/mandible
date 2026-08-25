import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM dev tool, no type declarations
import { extractUnits, ncdPair } from "../scripts/ncd-scan.mjs";

const tokensOf = (source: string, name: string): string[] => {
  const units = extractUnits("sample.ts", source) as Array<{ name: string; tokens: string[] }>;
  const unit = units.find((candidate) => candidate.name === name);
  if (!unit) throw new Error(`no unit named ${name} in ${units.map((u) => u.name).join(", ")}`);
  return unit.tokens;
};

// A 40-token floor applies, so these samples are padded to clear it.
const shaped = (fnName: string, a: string, b: string, c: string, call: string) => `
function ${fnName}(${a}: string[], ${b}: number): number {
  let ${c} = 0;
  for (const entry of ${a}) {
    if (entry.length > ${b}) {
      ${c} += ${call}(entry).length;
    } else {
      ${c} -= 1;
    }
  }
  return ${c};
}
`;

describe("ncd-scan normalization", () => {
  it("is invariant under renaming of locally bound identifiers", () => {
    const first = tokensOf(shaped("countA", "items", "limit", "total", "String"), "countA");
    const second = tokensOf(shaped("countB", "rows", "max", "sum", "String"), "countB");
    expect(second).toEqual(first);
  });

  it("keeps free identifiers, so a different call target is a different unit", () => {
    const first = tokensOf(shaped("countA", "items", "limit", "total", "String"), "countA");
    const other = tokensOf(shaped("countA", "items", "limit", "total", "JSON.stringify"), "countA");
    expect(other).not.toEqual(first);
  });

  it("erases literal payloads but keeps the shape around them", () => {
    const withA = tokensOf(shaped("countA", "items", "limit", "total", "String"), "countA");
    expect(withA).toContain("#n");
    expect(withA).not.toContain("0");
  });

  it("scores an alpha-variant pair far nearer than an unrelated pair", () => {
    const a = tokensOf(shaped("countA", "items", "limit", "total", "String"), "countA").join(" ");
    const b = tokensOf(shaped("countB", "rows", "max", "sum", "String"), "countB").join(" ");
    const unrelated = tokensOf(
      `function other(input: string): string { return input.split("").reverse().join("-").padStart(12, "x").toUpperCase().trim().normalize("NFC").slice(0, 4); }`,
      "other",
    ).join(" ");
    const buf = (text: string) => Buffer.from(text, "utf8");
    const clen = (text: string) => zlib.deflateRawSync(buf(text), { level: 9, memLevel: 9, windowBits: 15 }).length;
    const near = ncdPair(buf(a), buf(b), clen(a), clen(b)) as { ncd: number };
    const far = ncdPair(buf(a), buf(unrelated), clen(a), clen(unrelated)) as { ncd: number };
    expect(near.ncd).toBeLessThan(0.2);
    expect(far.ncd).toBeGreaterThan(near.ncd);
  });
});
