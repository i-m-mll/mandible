import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: homeDir,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      MANDIBLE_PORT: "9",
      ZELLIJ: "",
      TMUX: "",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[], cwd = tempDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRepo(): void {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feature/demo"]);
  fs.writeFileSync(path.join(tempDir, "feature.txt"), "feature\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature"]);
  git(["checkout", "main"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-home-"));
  createRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth merge pre-auth-check fallback", () => {
  it("forces optional git locks off for CLI-internal git calls", () => {
    const realGit = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-git-wrapper-"));
    const envLog = path.join(fakeBin, "env.log");
    fs.writeFileSync(path.join(fakeBin, "git"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$GIT_OPTIONAL_LOCKS" >> ${JSON.stringify(envLog)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });

    try {
      const result = run(["auth", "merge", "feature/demo"], tempDir, {
        GIT_OPTIONAL_LOCKS: "1",
        PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("commit.gpgsign is set to false");
      const observed = fs.readFileSync(envLog, "utf8").trim().split("\n");
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((value) => value === "0")).toBe(true);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("aborts before dirty checks when git lock files are present", () => {
    const lockPath = path.join(tempDir, ".git", "index.lock");
    fs.writeFileSync(lockPath, "", "utf8");

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git lock file(s) are present before auth merge");
    expect(result.stderr).toContain(lockPath);
    expect(result.stderr).toContain("no owning process found");
    expect(result.stderr).toContain("Aborting before auth merge because git lock files are present");
    expect(result.stderr).not.toContain("pre-auth-check not found");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("does not block untracked-only working tree state", () => {
    fs.writeFileSync(path.join(tempDir, "scratch.txt"), "local\n", "utf8");

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pre-auth-check not found");
    expect(result.stderr).not.toContain("Working tree is dirty");
    expect(result.stderr).toContain("commit.gpgsign is set to false");
  });

  it("blocks staged changes when pre-auth-check is unavailable", () => {
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"]);

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Working tree has staged changes");
    expect(result.stderr).toContain("staged.txt");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });
});
