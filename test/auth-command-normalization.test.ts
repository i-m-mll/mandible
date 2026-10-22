/**
 * @vitest-environment node
 *
 * Issue 08a5f04 — the legacy single-source normalizer and the fail-closed
 * hostile-HOME guard on the canonical command space. The route-level
 * submission path lives in auth-queue-approval.test.ts.
 */
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalAuthMergeCommands,
  normalizeLegacySingleSourceMergeCommand,
} from "../src/auth-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeLegacySingleSourceMergeCommand", () => {
  it("normalizes exactly the legacy single-source shape for the resolved head", () => {
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge feature/x", "feature/x", "main"),
    ).toBe("mandible auth merge feature/x --into main");
  });

  it("returns null for every non-matching shape", () => {
    const cases: Array<[string | null, string, string]> = [
      // Already canonical — nothing to normalize.
      ["mandible auth merge feature/x --into main", "feature/x", "main"],
      // Branch argument differs from the resolved head.
      ["mandible auth merge feature/other", "feature/x", "main"],
      // Extra flags / hierarchical / multi-source shapes.
      ["mandible auth merge feature/x --force", "feature/x", "main"],
      ["mandible auth merge --hierarchical feature/x", "feature/x", "main"],
      ["mandible auth merge feature/x feature/y", "feature/x", "main"],
      // Different prefix or trailing shell content.
      ["/usr/local/bin/mandible auth merge feature/x", "feature/x", "main"],
      ["mandible auth merge feature/x && echo pwned", "feature/x", "main"],
      [null, "feature/x", "main"],
    ];
    for (const [command, head, base] of cases) {
      expect(normalizeLegacySingleSourceMergeCommand(command, head, base)).toBeNull();
    }
  });

  it("refuses unsafe resolved branch names", () => {
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge x", "x", "main;rm -rf"),
    ).toBeNull();
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge -evil", "-evil", "main"),
    ).toBeNull();
  });
});

describe("canonicalAuthMergeCommands hostile-HOME guard", () => {
  it("includes the absolute-prefix variants for a safe home path", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/Users/normal_user-1.2");
    const commands = canonicalAuthMergeCommands("feature/x", "main");
    expect(commands).toContain("mandible auth merge feature/x --into main");
    expect(commands).toContain(
      "/Users/normal_user-1.2/.dotfiles/bin/mandible auth merge feature/x --into main",
    );
    expect(commands).toHaveLength(4);
  });

  it("fails closed to the bare prefix when the home path carries hostile bytes", () => {
    const hostileHomes = [
      "/Users/evil user", // whitespace splits words under bash -c
      "/Users/evil$(touch pwned)", // command substitution
      "/Users/evil;rm -rf ~", // command separator
      "/Users/evil`id`", // backtick substitution
      "relative/home", // not absolute
      "/Users/../etc", // traversal
      "", // unset
    ];
    for (const home of hostileHomes) {
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const commands = canonicalAuthMergeCommands("feature/x", "main");
      expect(commands).toEqual([
        "mandible auth merge feature/x --into main",
        "mandible auth merge feature/x --into main --preserve-head-branch",
      ]);
      vi.restoreAllMocks();
    }
  });
});
