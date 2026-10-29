import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect } from "vitest";
import { testRuntimeRoot } from "./runtime-isolation.js";

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  function walk(relative: string): void {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      hash.update(child).update("\0");
      if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(root, child)));
      else if (entry.isDirectory()) walk(child);
      else hash.update(fs.readFileSync(path.join(root, child)));
    }
  }
  walk(".");
  return hash.digest("hex");
}

/** Build once per file; give consumers only complete private copies, never the source. */
export function preparedGitFixture<T>(prefix: string, build: (root: string) => T): {
  copyInto: (destination: string) => T;
} {
  let prepared: { root: string; digest: string; value: T } | undefined;
  afterAll(() => {
    if (!prepared) return;
    try {
      expect(treeDigest(prepared.root)).toBe(prepared.digest);
    } finally {
      fs.rmSync(prepared.root, { recursive: true, force: true });
    }
  });
  return {
    copyInto(destination) {
      if (!prepared) {
        const root = fs.mkdtempSync(path.join(testRuntimeRoot, `${prefix}-template-`));
        const value = build(root);
        prepared = { root, value, digest: treeDigest(root) };
      }
      fs.cpSync(prepared.root, destination, { recursive: true });
      return prepared.value;
    },
  };
}

/** The identical main/feature history used by the auth merge and request CLIs. */
export const authCliRepo = preparedGitFixture("auth-cli", (repo) => {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, timeout: 5_000 });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feature/demo"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature"]);
  git(["checkout", "main"]);
});
