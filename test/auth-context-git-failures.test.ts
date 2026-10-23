import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyGitFailure,
  describeGitFailure,
  probeRepoRootFromGitCommonDir,
  resolveAuthMergeExecutionContext,
} from "../src/auth-context.js";
import type { Db } from "../src/db.js";
import { createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";

// Issue 2205073 — verifyLocalBranch used to map every execFileSync failure to
// "local branch 'X' does not exist". A real EMFILE (watcher fd exhaustion)
// surfaced to the operator as a missing `main` branch on a healthy repo. These
// tests hold the distinction: only git's own "ref absent" answer may claim the
// branch is missing; spawn and timeout failures must say so and invite retry.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env }).trim();
}

function createRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-errno-")));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["checkout", "-b", "feature/x"]);
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["checkout", "main"]);
  return repo;
}

function registerRepo(db: Db, repo: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, 'main', 1, 0)`,
  ).run(path.basename(repo), repo, path.basename(repo));
}

describe("classifyGitFailure", () => {
  it("separates git's own answers from timeouts and spawn failures", () => {
    expect(classifyGitFailure({ status: 1, stderr: "" })).toEqual({ kind: "exit", status: 1, stderr: "" });
    expect(classifyGitFailure({ status: 128, stderr: Buffer.from("fatal: bad object\n") }))
      .toMatchObject({ kind: "exit", status: 128, stderr: "fatal: bad object" });

    const timeout = classifyGitFailure({ code: "ETIMEDOUT", signal: "SIGTERM", status: null }, 5000);
    expect(timeout.kind).toBe("timeout");
    expect(describeGitFailure(timeout)).toContain("not evidence about the repository");

    for (const errno of ["EMFILE", "EAGAIN", "ENOMEM"]) {
      const failure = classifyGitFailure({ code: errno, status: null });
      expect(failure).toMatchObject({ kind: "spawn", errno });
      // Never asserts anything about the repository itself.
      expect(describeGitFailure(failure)).not.toContain("does not exist");
    }
  });
});

describe("resolveAuthMergeExecutionContext branch verification", () => {
  it("reports a genuinely absent branch as absent", async () => {
    const repo = createRepo();
    const db = createSharedMigratedDb({ now: 1 });
    try {
      registerRepo(db, repo);
      await expect(
        resolveAuthMergeExecutionContext(db, {
          type: "merge",
          command: "mandible auth merge feature/missing --into main",
          target_repo_root: repo,
          base_branch: "main",
          head_branch: "feature/missing",
        }),
      ).rejects.toThrow(/local branch 'feature\/missing' does not exist/);
    } finally {
      db.close();
    }
  });

  it("reports an unrunnable git as a spawn failure, never as a missing branch", async () => {
    const repo = createRepo();
    const db = createSharedMigratedDb({ now: 1 });
    const originalPath = process.env.PATH;
    try {
      registerRepo(db, repo);
      // Stand in for EMFILE/EAGAIN: git cannot be spawned at all. The branch
      // exists and is perfectly healthy.
      process.env.PATH = path.join(repo, "no-such-bin");
      let message = "";
      try {
        await resolveAuthMergeExecutionContext(db, {
          type: "merge",
          command: "mandible auth merge feature/x --into main",
          target_repo_root: repo,
          base_branch: "main",
          head_branch: "feature/x",
        });
        throw new Error("expected resolveAuthMergeExecutionContext to throw");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Unable to verify 'base_branch' branch 'main'");
      expect(message).toContain("git could not be executed (ENOENT)");
      expect(message).toContain("Retry the approval");
      expect(message).not.toContain("does not exist");
    } finally {
      process.env.PATH = originalPath;
      db.close();
    }
  });
});

// Issue 2205073 (review F8) — the cwd-based repository lookup was the one
// approval-context path still collapsing every git outcome into null, so a
// daemon-health failure was reported as an unregistered repository.
describe("repoRootFromGitCommonDir failure honesty", () => {
  it("reports a root inside a repository, git's answer outside one, and a spawn failure as such", async () => {
    const repo = createRepo();
    expect(await probeRepoRootFromGitCommonDir(repo)).toMatchObject({ root: repo, failure: null });

    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-norepo-")));
    tempDirs.push(dir);
    const outside = await probeRepoRootFromGitCommonDir(dir);
    expect(outside.root).toBeNull();
    expect(outside.failure?.kind).toBe("exit");

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = path.join(repo, "no-such-bin");
      expect(await probeRepoRootFromGitCommonDir(repo)).toMatchObject({ root: null, failure: { kind: "spawn", errno: "ENOENT" } });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
