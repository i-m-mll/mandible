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
import { verifyMandibleIssueReferences } from "../src/routes/auth.js";
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
  it("classifies a non-zero exit as a real git answer", () => {
    const failure = classifyGitFailure({ status: 1, stderr: "" });
    expect(failure).toEqual({ kind: "exit", status: 1, stderr: "" });
  });

  it("classifies a killed-by-timeout invocation as a timeout, not an answer", () => {
    const failure = classifyGitFailure(
      { code: "ETIMEDOUT", signal: "SIGTERM", status: null },
      5000,
    );
    expect(failure.kind).toBe("timeout");
    expect(describeGitFailure(failure)).toContain("timed out after 5000ms");
    expect(describeGitFailure(failure)).toContain("not evidence about the repository");
  });

  it("classifies fd/process exhaustion as a spawn failure naming the errno", () => {
    for (const errno of ["EMFILE", "EAGAIN", "ENOMEM"]) {
      const failure = classifyGitFailure({ code: errno, status: null });
      expect(failure).toMatchObject({ kind: "spawn", errno });
      const described = describeGitFailure(failure);
      expect(described).toContain(`git could not be executed (${errno})`);
      expect(described).toContain("Retry the approval");
      expect(described).toContain("daemon health");
      // Never asserts anything about the repository itself.
      expect(described).not.toContain("does not exist");
    }
  });

  it("captures a Buffer stderr from execFileSync", () => {
    const failure = classifyGitFailure({ status: 128, stderr: Buffer.from("fatal: bad object\n") });
    expect(failure).toMatchObject({ kind: "exit", status: 128, stderr: "fatal: bad object" });
    expect(describeGitFailure(failure)).toContain("git exited with status 128");
    expect(describeGitFailure(failure)).toContain("fatal: bad object");
  });
});

describe("resolveAuthMergeExecutionContext branch verification", () => {
  it("reports a genuinely absent branch as absent", () => {
    const repo = createRepo();
    const db = createSharedMigratedDb({ now: 1 });
    try {
      registerRepo(db, repo);
      expect(() =>
        resolveAuthMergeExecutionContext(db, {
          type: "merge",
          command: "mandible auth merge feature/missing --into main",
          target_repo_root: repo,
          base_branch: "main",
          head_branch: "feature/missing",
        }),
      ).toThrow(/local branch 'feature\/missing' does not exist/);
    } finally {
      db.close();
    }
  });

  it("reports an unrunnable git as a spawn failure, never as a missing branch", () => {
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
        resolveAuthMergeExecutionContext(db, {
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
  it("resolves the repo root and reports no failure inside a repository", () => {
    const repo = createRepo();
    const probe = probeRepoRootFromGitCommonDir(repo);
    expect(probe.failure).toBeNull();
    expect(probe.root).toBe(repo);
  });

  it("reports git's own answer as an exit failure outside a repository", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-norepo-")));
    tempDirs.push(dir);
    const probe = probeRepoRootFromGitCommonDir(dir);
    expect(probe.root).toBeNull();
    expect(probe.failure?.kind).toBe("exit");
  });

  it("reports an unrunnable git as a spawn failure, not as a missing repository", () => {
    const repo = createRepo();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = path.join(repo, "no-such-bin");
      const probe = probeRepoRootFromGitCommonDir(repo);
      expect(probe.root).toBeNull();
      expect(probe.failure).toMatchObject({ kind: "spawn", errno: "ENOENT" });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// Issue 2205073 (review F8, residual) — the submission-time `Mandible-Issue:`
// trailer gate was the last action-bearing caller of the lossy wrapper: it
// refused work and named the cwd as the cause for failures that never reached
// the repository. The gate still fails closed; only the explanation changes.
describe("verifyMandibleIssueReferences cwd honesty", () => {
  const merge = (cwd: string, head: string) => ({
    type: "merge",
    command: `mandible auth merge ${head} --into main`,
    cwd,
    base_branch: "main",
    head_branch: head,
  });

  it("blames the cwd only when git itself answers that it is not a repository", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-gate-norepo-")));
    tempDirs.push(dir);
    expect(verifyMandibleIssueReferences(merge(dir, "feature/x"))).toContain(
      "Invalid 'cwd' for auth merge verification",
    );
  });

  it("blames daemon health, not the cwd, when git cannot be spawned", () => {
    const repo = createRepo();
    const originalPath = process.env.PATH;
    try {
      // The cwd is a healthy repository; git simply cannot run (stands in for
      // EMFILE/EAGAIN from daemon fd exhaustion).
      process.env.PATH = path.join(repo, "no-such-bin");
      const error = verifyMandibleIssueReferences(merge(repo, "feature/x")) ?? "";
      // Still fails closed...
      expect(error).toBeTruthy();
      // ...but never as a claim about the path.
      expect(error).not.toContain("Invalid 'cwd'");
      expect(error).toContain("git could not be executed (ENOENT)");
      expect(error).toContain("daemon health");
      expect(error).toContain("not an invalid cwd");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps refusing commits that genuinely lack a Mandible-Issue trailer", () => {
    const repo = createRepo();
    expect(verifyMandibleIssueReferences(merge(repo, "feature/x"))).toContain(
      "missing Mandible-Issue references",
    );
  });

  it("admits a branch whose commits all carry the trailer", () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature/trailered"]);
    fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "trailered\n\nMandible-Issue: 2205073"]);
    git(repo, ["checkout", "main"]);
    expect(verifyMandibleIssueReferences(merge(repo, "feature/trailered"))).toBeNull();
  });

  it("keeps the generic manual-review refusal when git answers with a non-zero exit", () => {
    const repo = createRepo();
    // git log exits non-zero for an absent revision: a real git answer about
    // this history, not a daemon-health failure.
    expect(verifyMandibleIssueReferences(merge(repo, "feature/absent"))).toBe(
      "Mandible issue reference verification failed; manual review required.",
    );
  });
});

describe("resolveAuthMergeExecutionContext cwd resolution", () => {
  it("reports a cwd outside any repository as invalid or unregistered", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-cwd-")));
    tempDirs.push(dir);
    const db = createSharedMigratedDb({ now: 1 });
    try {
      expect(() =>
        resolveAuthMergeExecutionContext(db, {
          type: "merge",
          command: "mandible auth merge feature/x --into main",
          cwd: dir,
          base_branch: "main",
          head_branch: "feature/x",
        }),
      ).toThrow(/Invalid or unregistered 'cwd'/);
    } finally {
      db.close();
    }
  });

  it("blames daemon health, not repository registration, when git never answers", () => {
    const repo = createRepo();
    const db = createSharedMigratedDb({ now: 1 });
    const originalPath = process.env.PATH;
    try {
      registerRepo(db, repo);
      // The repo is registered and healthy; git simply cannot be spawned.
      process.env.PATH = path.join(repo, "no-such-bin");
      let message = "";
      try {
        resolveAuthMergeExecutionContext(db, {
          type: "merge",
          command: "mandible auth merge feature/x --into main",
          cwd: repo,
          base_branch: "main",
          head_branch: "feature/x",
        });
        throw new Error("expected resolveAuthMergeExecutionContext to throw");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Unable to resolve the repository for 'cwd'");
      expect(message).toContain("git could not be executed (ENOENT)");
      expect(message).toContain("daemon health");
      expect(message).not.toContain("Invalid or unregistered");
    } finally {
      process.env.PATH = originalPath;
      db.close();
    }
  });
});
