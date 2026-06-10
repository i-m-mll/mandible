import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
const tempRoots: string[] = [];

function run(args: string[], env: Record<string, string> = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("instructions CLI", () => {
  it("diffs and installs the managed instructions block", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-cli-"));
    tempRoots.push(tempDir);
    const target = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(target, "# Existing\n\nUser policy stays here.\n", "utf8");

    const diff = await run(["instructions", "diff", "--target", target]);
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain("Mandible Interface Contract");
    expect(diff.stdout).toContain("User policy stays here.");

    const install = await run(["instructions", "install", "--target", target]);
    expect(install.status).toBe(0);
    const installed = fs.readFileSync(target, "utf8");
    expect(installed).toContain("<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->");
    expect(installed).toContain("mandible auth request <branch>");
    expect(installed).toContain("User policy stays here.");

    const cleanDiff = await run(["instructions", "diff", "--target", target]);
    expect(cleanDiff.status).toBe(0);
    expect(cleanDiff.stdout).toContain("already current");
  });

  it("uses ~/.claude/CLAUDE.md as the default install target", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-home-"));
    tempRoots.push(home);

    const install = await run(["instructions", "install"], { HOME: home });
    expect(install.status).toBe(0);
    const claudeTarget = path.join(home, ".claude", "CLAUDE.md");
    const codexTarget = path.join(home, ".codex", "AGENTS.md");
    expect(fs.readFileSync(claudeTarget, "utf8")).toContain("Mandible Interface Contract");
    expect(fs.readFileSync(codexTarget, "utf8")).toContain("Mandible Interface Contract");
  });

  it("refuses to install into a tracked target on the protected branch", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-protected-"));
    tempRoots.push(repo);
    git(repo, ["init", "-b", "main"]);
    const target = path.join(repo, "AGENTS.md");
    const original = "# Existing\n\nKeep this unchanged.\n";
    fs.writeFileSync(target, original, "utf8");
    git(repo, ["add", "AGENTS.md"]);

    const install = await run(["instructions", "install", "--target", target]);

    expect(install.status).toBe(3);
    expect(install.stderr).toContain("Refusing to install Mandible instructions");
    expect(install.stderr).toContain("--worktree <feature-worktree>");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("maps a protected target into a worktree path before installing", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-source-"));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-worktree-"));
    tempRoots.push(repo, worktree);
    git(repo, ["init", "-b", "main"]);
    const sourceTarget = path.join(repo, ".codex", "AGENTS.md");
    fs.mkdirSync(path.dirname(sourceTarget), { recursive: true });
    fs.writeFileSync(sourceTarget, "# Source\n", "utf8");
    git(repo, ["add", ".codex/AGENTS.md"]);

    const install = await run([
      "instructions",
      "install",
      "--target",
      sourceTarget,
      "--worktree",
      worktree,
    ]);

    expect(install.status).toBe(0);
    const worktreeTarget = path.join(worktree, ".codex", "AGENTS.md");
    expect(install.stdout).toContain(worktreeTarget);
    expect(fs.readFileSync(worktreeTarget, "utf8")).toContain("Mandible Interface Contract");
    expect(fs.readFileSync(sourceTarget, "utf8")).toBe("# Source\n");
  });

  it("refreshes configured standalone targets and runs the post-export hook", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-config-home-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-config-target-"));
    tempRoots.push(home, targetDir);
    const dbPath = path.join(home, ".cache", "mandible", "mandible.db");
    const target = path.join(targetDir, "50-mandible.generated.md");
    const hookOut = path.join(targetDir, "hook-ran.txt");
    const env = { HOME: home, MANDIBLE_DB: dbPath, HOOK_OUT: hookOut };

    const add = await run(["instructions", "targets", "add", target, "--mode", "standalone"], env);
    expect(add.status).toBe(0);
    const hookCommand = "node -e \"require('node:fs').writeFileSync(process.env.HOOK_OUT, 'ran')\"";
    const setHook = await run(["instructions", "post-export", "set", hookCommand], env);
    expect(setHook.status).toBe(0);

    const install = await run(["instructions", "install"], env);

    expect(install.status).toBe(0);
    const installed = fs.readFileSync(target, "utf8");
    expect(installed).toContain("Mandible Interface Contract");
    expect(installed).not.toContain("<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->");
    expect(fs.readFileSync(hookOut, "utf8")).toBe("ran");
  });

  it("cleans managed blocks and exact standalone generated targets", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-cleanup-"));
    tempRoots.push(tempDir);
    const managedTarget = path.join(tempDir, "AGENTS.md");
    const standaloneTarget = path.join(tempDir, "50-mandible.generated.md");

    fs.writeFileSync(managedTarget, "# Existing\n", "utf8");
    const managedInstall = await run(["instructions", "install", "--target", managedTarget]);
    expect(managedInstall.status).toBe(0);
    expect(fs.readFileSync(managedTarget, "utf8")).toContain("<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->");

    const managedCleanup = await run([
      "instructions",
      "cleanup",
      "--target",
      managedTarget,
      "--mode",
      "managed-block",
    ]);
    expect(managedCleanup.status).toBe(0);
    expect(fs.readFileSync(managedTarget, "utf8")).toBe("# Existing\n");

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-clean-home-"));
    tempRoots.push(home);
    const env = { HOME: home, MANDIBLE_DB: path.join(home, ".cache", "mandible", "mandible.db") };
    expect((await run(["instructions", "targets", "add", standaloneTarget, "--mode", "standalone"], env)).status).toBe(0);
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    expect(fs.existsSync(standaloneTarget)).toBe(true);

    const standaloneCleanup = await run([
      "instructions",
      "cleanup",
      "--target",
      standaloneTarget,
      "--mode",
      "standalone",
    ]);
    expect(standaloneCleanup.status).toBe(0);
    expect(fs.existsSync(standaloneTarget)).toBe(false);
  });
});
