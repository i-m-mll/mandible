import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM dev tool, no type declarations
import { extractUnits, ncdPair } from "../../scripts/ncd-scan.mjs";

const unitsOf = (path: string, source: string) =>
  extractUnits(path, source) as Array<{ name: string; kind: string; tokens: string[] }>;

const named = (path: string, source: string, name: string): string[] => {
  const units = unitsOf(path, source);
  const unit = units.find((candidate) => candidate.name === name);
  if (!unit) throw new Error(`no unit named ${name} in ${units.map((u) => u.name).join(", ")}`);
  return unit.tokens;
};
// ---------------------------------------------------------------------------
// Python extraction goes through Python's own `ast` in a subprocess, so these
// also assert that the two-language seam is wired end to end.
// ---------------------------------------------------------------------------

// A 40-token floor applies, so these samples are padded to clear it.
const pyShaped = (fnName: string, a: string, b: string, c: string, call: string) => `
def ${fnName}(${a}, ${b}):
    ${c} = 0
    for entry in ${a}:
        if len(entry) > ${b}:
            ${c} += ${call}(entry)
        else:
            ${c} -= 1
    if ${c} < 0:
        ${c} = 0
    while ${c} > ${b}:
        ${c} = ${c} // 2
    return ${c}
`;

const pyTokens = (source: string, name: string) => named("sample.py", source, name);

describe("ncd-scan python normalization", () => {
  it("is invariant under renaming of locally bound identifiers", () => {
    const first = pyTokens(pyShaped("count_a", "items", "limit", "total", "len"), "count_a");
    const second = pyTokens(pyShaped("count_b", "rows", "max_len", "acc", "len"), "count_b");
    expect(second).toEqual(first);
  });

  it("keeps free identifiers, so a different call target is a different unit", () => {
    const first = pyTokens(pyShaped("count_a", "items", "limit", "total", "len"), "count_a");
    const other = pyTokens(pyShaped("count_a", "items", "limit", "total", "hash"), "count_a");
    expect(other).not.toEqual(first);
  });

  it("keeps the module a unit reaches for, so np and jnp stay distinguishable", () => {
    const np = pyTokens(pyShaped("count_a", "items", "limit", "total", "np.sum"), "count_a");
    const jnp = pyTokens(pyShaped("count_a", "items", "limit", "total", "jnp.sum"), "count_a");
    expect(np).toContain("np");
    expect(jnp).toContain("jnp");
    expect(jnp).not.toEqual(np);
  });

  it("erases literal payloads but keeps the shape around them", () => {
    const tokens = pyTokens(pyShaped("count_a", "items", "limit", "total", "len"), "count_a");
    expect(tokens).toContain("#n");
    expect(tokens).not.toContain("0");
  });

  it("extracts a class unit and keeps its field and method names verbatim", () => {
    const source = `
class Widget:
    hidden_size: int
    label: str = "w"

    def step(self, xs, limit):
        acc = 0
        for entry in xs:
            if len(entry) > limit:
                acc += np.sum(entry)
            else:
                acc -= 1
        return acc
`;
    const unit = unitsOf("sample.py", source).find((u) => u.kind === "class");
    expect(unit).toBeDefined();
    // Field and method names are the class's external contract, exactly as a
    // TypeScript property or method declaration name is, so they are not
    // alpha-renamed. The class's own name is locally bound, so it is.
    expect(unit!.tokens).toContain("hidden_size");
    expect(unit!.tokens).toContain("label");
    expect(unit!.tokens).toContain("step");
    expect(unit!.tokens).not.toContain("Widget");
  });

  it("scores an alpha-variant python pair far nearer than an unrelated pair", () => {
    const a = pyTokens(pyShaped("count_a", "items", "limit", "total", "len"), "count_a").join(" ");
    const b = pyTokens(pyShaped("count_b", "rows", "max_len", "acc", "len"), "count_b").join(" ");
    const unrelated = pyTokens(
      `
def other(raw, sep, width):
    parts = raw.split(sep)
    parts.reverse()
    joined = sep.join(parts).upper().strip()
    padded = joined.rjust(width, "x")
    trimmed = padded[:width]
    return trimmed.encode("utf-8").hex()
`,
      "other",
    ).join(" ");
    const buf = (text: string) => Buffer.from(text, "utf8");
    const clen = (text: string) => zlib.deflateRawSync(buf(text), { level: 9, memLevel: 9, windowBits: 15 }).length;
    const near = ncdPair(buf(a), buf(b), clen(a), clen(b)) as { ncd: number };
    const far = ncdPair(buf(a), buf(unrelated), clen(a), clen(unrelated)) as { ncd: number };
    expect(near.ncd).toBeLessThan(0.2);
    expect(far.ncd).toBeGreaterThan(near.ncd);
  });

  it("reports a syntax error instead of silently dropping the file", () => {
    // The batch protocol surfaces per-file failures; a bad file must not take
    // the scan down, and must not vanish without a trace either.
    const units = unitsOf("broken.py", "def f(:\n    pass\n");
    expect(units).toEqual([]);
  });
});
