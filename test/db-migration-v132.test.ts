import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuthHookManager } from "../src/auth-hooks.js";
import { migrate } from "../src/db.js";

const DEPLOY_HOOK_IDS = [
  "builtin-dotfiles-agent-schedule-deploy",
  "builtin-dotfiles-agent-schedule-deploy-nodot",
] as const;

type HookRow = {
  id: string;
  repo_pattern: string;
  auth_type: string;
  command: string;
  label: string;
  enabled: number;
  builtin: number;
  position: number;
};

function readDeployHooks(db: InstanceType<typeof Database>): HookRow[] {
  return db
    .prepare(
      `SELECT id, repo_pattern, auth_type, command, label, enabled, builtin, position
       FROM auth_hooks WHERE id IN (?, ?) ORDER BY id`,
    )
    .all(...DEPLOY_HOOK_IDS) as HookRow[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * Run the hook command the way AuthHookManager does — `bash -c` with the merge
 * commit checked out — against a throwaway repo, so the guard logic is
 * exercised as shipped rather than re-implemented in the assertion.
 */
function runHookCommand(command: string, cwd: string, extraEnv: Record<string, string>): string {
  return execFileSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "v132-hook-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "base");
  return root;
}

function mergeBranchTouching(root: string, path: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("checkout", "--quiet", "-b", "feature");
  const full = join(root, path);
  execFileSync("mkdir", ["-p", join(full, "..")], { stdio: "ignore" });
  writeFileSync(full, "changed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "change");
  git("checkout", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "--no-edit", "feature");
}

describe("migration v132: agent-schedule deploy auth hook", () => {
  it("registers the deploy hook for both dotfiles repo patterns", () => {
    const db = new Database(":memory:");
    migrate(db);

    const rows = readDeployHooks(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.repo_pattern).sort()).toEqual([".dotfiles", "dotfiles"]);
    for (const row of rows) {
      expect(row.auth_type).toBe("merge");
      expect(row.enabled).toBe(1);
      expect(row.builtin).toBe(1);
      // Runs after the agent-instruction hook, which sits at position 0.
      expect(row.position).toBe(10);
      expect(row.command).toContain("agent-schedule");
      expect(row.command).toContain("deploy");
    }
    // Both patterns must carry byte-identical commands: a dotfiles repo
    // registered either way has to behave the same.
    expect(rows[0]!.command).toBe(rows[1]!.command);
    expect(rows[0]!.label).toBe(rows[1]!.label);
  });

  it("matches the hook for a dotfiles merge and not for other repos", () => {
    const db = new Database(":memory:");
    migrate(db);
    const manager = new AuthHookManager(db);

    for (const repo of [".dotfiles", "dotfiles"]) {
      const ids = manager.findMatchingHooks(repo, "merge").map((hook) => hook.id);
      expect(ids.some((id) => DEPLOY_HOOK_IDS.includes(id as never))).toBe(true);
    }

    const mandibleIds = manager.findMatchingHooks("mandible", "merge").map((hook) => hook.id);
    expect(mandibleIds.some((id) => DEPLOY_HOOK_IDS.includes(id as never))).toBe(false);
  });

  it("orders the deploy hook after the agent-instruction hook", () => {
    const db = new Database(":memory:");
    migrate(db);
    const ids = new AuthHookManager(db).findMatchingHooks(".dotfiles", "merge").map((h) => h.id);
    expect(ids.indexOf("builtin-dotfiles-agent-instructions"))
      .toBeLessThan(ids.indexOf("builtin-dotfiles-agent-schedule-deploy"));
  });

  it("skips deploying when the merge touched nothing under agents/", () => {
    const db = new Database(":memory:");
    migrate(db);
    const command = readDeployHooks(db)[0]!.command;

    const root = initRepo();
    mergeBranchTouching(root, "docs/notes.md");

    // HOME points at an empty dir, so if the guard failed to exit early the
    // command would report a missing executable instead of skipping.
    const home = mkdtempSync(join(tmpdir(), "v132-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const output = runHookCommand(command, root, { HOME: home });
    expect(output).toContain("skipping agent-schedule deploy");
  });

  it("proceeds past the path guard when the merge touched agents/", () => {
    const db = new Database(":memory:");
    migrate(db);
    const command = readDeployHooks(db)[0]!.command;

    const root = initRepo();
    mergeBranchTouching(root, "agents/tasks/demo/task.toml");

    const home = mkdtempSync(join(tmpdir(), "v132-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    // No agent-schedule under this HOME, so the command must get past the
    // path guard and fail on the executable lookup rather than skipping.
    let failed = false;
    try {
      runHookCommand(command, root, { HOME: home, PATH: "/usr/bin:/bin" });
    } catch (error) {
      failed = true;
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      expect(stderr).toContain("agent-schedule executable not found");
    }
    expect(failed).toBe(true);
  });
});
