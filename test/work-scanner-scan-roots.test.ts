// Issue 8aadf70 — repo scan roots are configuration, not hard-coded personal paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dedupeScanRoots, parseWorkScannerScanRoots } from "../src/work-scanner.js";

describe("parseWorkScannerScanRoots", () => {
  it("reads a JSON array of path/depth entries", () => {
    expect(parseWorkScannerScanRoots('[{"path":"/srv/code","depth":2},{"path":"/srv/flat"}]')).toEqual([
      { path: "/srv/code", depth: 2 },
      { path: "/srv/flat", depth: 1 },
    ]);
  });

  it("reads a plain separated list at the default depth", () => {
    expect(parseWorkScannerScanRoots("/srv/a:/srv/b")).toEqual([
      { path: "/srv/a", depth: 1 },
      { path: "/srv/b", depth: 1 },
    ]);
    expect(parseWorkScannerScanRoots("/srv/a\n/srv/b\n")).toEqual([
      { path: "/srv/a", depth: 1 },
      { path: "/srv/b", depth: 1 },
    ]);
  });

  it("treats absent, empty, and malformed configuration as unconfigured", () => {
    expect(parseWorkScannerScanRoots(undefined)).toEqual([]);
    expect(parseWorkScannerScanRoots(null)).toEqual([]);
    expect(parseWorkScannerScanRoots("   ")).toEqual([]);
    expect(parseWorkScannerScanRoots("[not json")).toEqual([]);
  });

  it("drops entries without a usable path and normalizes bad depths", () => {
    expect(parseWorkScannerScanRoots('[{"depth":3},{"path":""},{"path":"/srv/x","depth":0}]')).toEqual([
      { path: "/srv/x", depth: 1 },
    ]);
  });
});

describe("dedupeScanRoots", () => {
  it("collapses two names for the same directory and keeps the deepest scan", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scan-roots-"));
    try {
      const real = path.join(home, "code");
      fs.mkdirSync(real);
      const link = path.join(home, "linked-code");
      fs.symlinkSync(real, link);

      expect(dedupeScanRoots([
        { path: real, depth: 1 },
        { path: link, depth: 2 },
      ])).toEqual([{ path: link, depth: 2 }]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps genuinely distinct directories and preserves unresolvable roots", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scan-roots-"));
    try {
      const a = path.join(home, "a");
      const b = path.join(home, "b");
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const missing = path.join(home, "not-there");

      const result = dedupeScanRoots([
        { path: a, depth: 1 },
        { path: b, depth: 2 },
        { path: missing, depth: 1 },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.path).sort()).toEqual([a, b, missing].sort());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
