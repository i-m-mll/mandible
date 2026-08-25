import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A source file containing a NUL byte is treated as binary by every tool that
// sniffs content rather than trusting the extension. `grep` is the one that
// matters here: it SKIPS such a file and reports no match, which is
// indistinguishable from a clean result. Three files in this tree carried NUL
// bytes as field separators in composite keys, and every grep-derived audit of
// the tree -- duplication scans, security sweeps, refactor impact analysis --
// was silently incomplete for as long as they did (issue ee0055a).
//
// The separators were real and had to keep their exact runtime value, so they
// are written as escape sequences now. This test is what stops a literal byte
// from being pasted back in. It walks the filesystem rather than shelling out
// to `git ls-files`, so it adds no external-binary dependency to the default
// suite.

// Vitest runs with the project root as cwd. Asserted below rather than
// assumed, so a runner change surfaces as a clear failure instead of an empty
// walk that passes.
const REPO_ROOT = process.cwd();

const SOURCE_ROOTS = ["src", "ui/src", "cli", "channel-server", "scripts", "test", "docs"];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".sh", ".css", ".html", ".md", ".mdx", ".yml", ".yaml", ".sql", ".txt",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "__snapshots__"]);

function collectTextFiles(dir: string, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTextFiles(path.join(dir, entry.name), found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;
    found.push(path.join(dir, entry.name));
  }
}

describe("source tree stays greppable", () => {
  it("has no NUL bytes in any text source file", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);

    const files: string[] = [];
    for (const root of SOURCE_ROOTS) collectTextFiles(path.join(REPO_ROOT, root), files);

    // Guard against the walk silently finding nothing and the test passing for
    // the wrong reason.
    expect(files.length).toBeGreaterThan(200);

    const offenders = files
      .filter((file) => fs.readFileSync(file).includes(0))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
