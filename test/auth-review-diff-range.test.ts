// @vitest-environment node
// Issue 1512471 — the diff an approver reads must be the change the merge will
// apply, which is the three-dot range from the merge base. Both operator-facing
// derivations used two dots, so once the base advanced they attributed other
// lanes' merged work to the branch under review, as deletions.
//
// The scenario below is the one that made the bug visible: cut a branch, then
// advance the base with an unrelated commit. Two-dot and three-dot disagree
// only after that second step, so a test that skips it passes either way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";

let repoDir = "";

function git(args: string[], cwd = repoDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(name: string, lines: number, prefix: string): void {
  const body = Array.from({ length: lines }, (_, i) => `${prefix} ${i}\n`).join("");
  fs.writeFileSync(path.join(repoDir, name), body, "utf8");
}

interface Shortstat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

function shortstatFor(range: string): Shortstat {
  const out = git(["diff", "--shortstat", range]);
  return {
    filesChanged: Number(out.match(/(\d+) files? changed/)?.[1] ?? 0),
    additions: Number(out.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(out.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
  };
}

/**
 * `feature/small` makes a three-line edit, then ANOTHER lane lands 40 lines of
 * new work on `main` that this branch never saw. Two-dot diffs tip against tip,
 * so it renders that arriving work as this branch deleting it — the exact
 * inversion issue 1512471 was filed for, and the reason the error grows as the
 * base advances.
 */
function createRepoWithAdvancedBase(): void {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);

  write("shared.txt", 5, "shared");
  git(["add", "."]);
  git(["commit", "-m", "base"]);

  git(["checkout", "-b", "feature/small"]);
  write("shared.txt", 8, "shared");
  git(["add", "shared.txt"]);
  git(["commit", "-m", "small feature edit"]);

  git(["checkout", "main"]);
  write("other-lane.txt", 40, "other lane");
  git(["add", "-A"]);
  git(["commit", "-m", "another lane lands 40 lines on main"]);
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-review-range-repo-"));
  createRepoWithAdvancedBase();
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("auth review diff range", () => {
  it("the daemon records the three-dot counts and preview, never another lane's work", async () => {
    // Guard the guard: the scenario must separate the ranges, or every
    // assertion here would pass against two-dot code.
    const twoDot = shortstatFor("main..feature/small");
    const threeDot = shortstatFor("main...feature/small");
    expect(threeDot).toEqual({ filesChanged: 1, additions: 3, deletions: 0 });
    expect(twoDot.deletions).toBe(40);

    const metadata = await computeAuthMergeReviewMetadata(
      repoDir,
      "main",
      "feature/small",
      { counts: true, diffSummary: true },
    );
    expect({
      filesChanged: metadata.filesChanged,
      additions: metadata.additions,
      deletions: metadata.deletions,
    }).toEqual(threeDot);
    expect(metadata.diffSummary).toContain("shared.txt");
    expect(metadata.diffSummary).not.toContain("other-lane.txt");
  });

  it("the recorded counts do not change when the base advances again", async () => {
    const before = await computeAuthMergeReviewMetadata(
      repoDir, "main", "feature/small", { counts: true, diffSummary: false },
    );

    write("yet-another-lane.txt", 120, "yet another lane");
    git(["add", "-A"]);
    git(["commit", "-m", "a third lane lands on main"]);

    const after = await computeAuthMergeReviewMetadata(
      repoDir, "main", "feature/small", { counts: true, diffSummary: false },
    );

    // The branch did not change, so its recorded size must not change either.
    // Under two dots this grows by 120 additions for work the branch never did.
    expect(after.filesChanged).toEqual(before.filesChanged);
    expect(after.additions).toEqual(before.additions);
    expect(after.deletions).toEqual(before.deletions);
    expect(after.changeReport?.files).toEqual(before.changeReport?.files);
    expect(after.changeReport?.comparison.head_sha).toBe(before.changeReport?.comparison.head_sha);
    expect(after.changeReport?.comparison.merge_base_sha).toBe(before.changeReport?.comparison.merge_base_sha);
    expect(after.changeReport?.comparison.base_sha).not.toBe(before.changeReport?.comparison.base_sha);
  });
});
