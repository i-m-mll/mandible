import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";

describe("canonicalJson", () => {
  it("orders keys by code unit, not by host locale collation", () => {
    // Digest inputs must not depend on the machine's locale. `localeCompare`
    // places "ä" next to "a" under en-US but after "z" under sv-SE, so a
    // collation-based sort would make the same value hash differently on
    // different hosts. Code-unit order is stable everywhere.
    expect(canonicalJson({ "ä": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"ä":1}');
  });

  it("is insensitive to insertion order at every depth", () => {
    const first = canonicalJson({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: null });
    const second = canonicalJson({ a: null, b: { c: [{ e: 2, f: 1 }], d: 1 } });
    expect(first).toBe(second);
    expect(first).toBe('{"a":null,"b":{"c":[{"e":2,"f":1}],"d":1}}');
  });
});
