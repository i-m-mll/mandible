import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";

function run(args: string[], cwd = tempDir): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      MANDIBLE_PORT: "9",
      ZELLIJ: "",
      TMUX: "",
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-request-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-request-home-"));
  createRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth request protected-root dirty policy", () => {
  it("blocks tracked dirty protected roots without restoring files", () => {
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "dirty\n", "utf8");

    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "350817b",
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("protected branch worktree is dirty");
    expect(result.stderr).toContain("tracked.txt");
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("dirty\n");
  });

  it("moves dirty protected-root state to a shelve branch when configured", () => {
    fs.writeFileSync(
      path.join(tempDir, "mandible.toml"),
      [
        "[auth.protected_root_dirty]",
        'default_policy = "branch-off"',
        'branch_prefix = "shelve/protected-root-test"',
        "include_untracked = true",
        "",
      ].join("\n"),
      "utf8",
    );
    git(["add", "mandible.toml"]);
    git(["commit", "-m", "add mandible config"]);
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "dirty\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "untracked.txt"), "local\n", "utf8");

    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "350817b",
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Protected-root changes were moved to branch");
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(tempDir, "untracked.txt"))).toBe(false);

    const branches = git(["branch", "--list", "shelve/protected-root-test-*"]);
    const branch = branches.split(/\s+/).find((item) => item.includes("shelve/protected-root-test-"));
    expect(branch).toBeTruthy();
    const safeBranch = branch!.replace(/[/: .]/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
    const shelveRoot = path.join(tempDir, "worktrees", safeBranch);
    expect(fs.readFileSync(path.join(shelveRoot, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(fs.readFileSync(path.join(shelveRoot, "untracked.txt"), "utf8")).toBe("local\n");
  });
});
