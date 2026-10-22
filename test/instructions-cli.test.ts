// @vitest-environment node
/**
 * Installing the instruction fragment: never into a tracked file on the
 * protected branch, mapped into a worktree when asked, through symlinks without
 * replacing them, and on the pinned Bun even when none is on PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { runCli, scratchDir } from "./helpers/cli-process.js";

const run = (args: string[], env: Record<string, string> = {}) => runCli(args, { cwd: process.cwd(), env });

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

describe("instructions CLI", () => {
  it("uses the pinned Bun runtime when Bun is not on PATH", async () => {
    const home = scratchDir("instructions-bun-runtime");

    const list = await run(["instructions", "targets", "list"], {
      HOME: home,
      MANDIBLE_DB: path.join(home, "fixture.db"),
      MANDIBLE_RUNTIME: process.execPath,
      PATH: "/usr/bin:/bin",
    });

    expect(list.status, list.stderr).toBe(0);
    expect(list.stderr).toBe("");
  });

  it("refuses to install into a tracked target on the protected branch", async () => {
    const repo = scratchDir("instructions-protected");
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
    const repo = scratchDir("instructions-source");
    const worktree = scratchDir("instructions-worktree");
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

    expect(install.status, install.stderr).toBe(0);
    const worktreeTarget = path.join(worktree, ".codex", "AGENTS.md");
    expect(install.stdout).toContain(worktreeTarget);
    expect(fs.readFileSync(worktreeTarget, "utf8")).toContain("Mandible Interface Contract");
    expect(fs.readFileSync(sourceTarget, "utf8")).toBe("# Source\n");
  });

  it("preserves symlinked instruction targets when installing and cleaning", async () => {
    const tempDir = scratchDir("instructions-symlink");
    const home = scratchDir("instructions-symlink-home");

    const managedReal = path.join(tempDir, "tracked", "AGENTS.md");
    const managedLink = path.join(tempDir, "home", "AGENTS.md");
    fs.mkdirSync(path.dirname(managedReal), { recursive: true });
    fs.mkdirSync(path.dirname(managedLink), { recursive: true });
    fs.writeFileSync(managedReal, "# Existing\n", "utf8");
    fs.symlinkSync(managedReal, managedLink);

    const managedInstall = await run(["instructions", "install", "--target", managedLink]);
    expect(managedInstall.status).toBe(0);
    expect(fs.lstatSync(managedLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(managedLink)).toBe(managedReal);
    expect(fs.readFileSync(managedReal, "utf8")).toContain("Mandible Interface Contract");

    const managedCleanup = await run([
      "instructions",
      "cleanup",
      "--target",
      managedLink,
      "--mode",
      "managed-block",
    ]);
    expect(managedCleanup.status).toBe(0);
    expect(fs.lstatSync(managedLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(managedLink)).toBe(managedReal);
    expect(fs.readFileSync(managedReal, "utf8")).toBe("# Existing\n");

    const standaloneReal = path.join(tempDir, "tracked", "50-mandible.generated.md");
    const standaloneLink = path.join(tempDir, "home", "50-mandible.generated.md");
    fs.writeFileSync(standaloneReal, "stale\n", "utf8");
    fs.symlinkSync(standaloneReal, standaloneLink);
    const env = { HOME: home, MANDIBLE_DB: path.join(home, "fixture.db") };

    const addStandalone = await run(["instructions", "targets", "add", standaloneLink, "--mode", "standalone"], env);
    expect(addStandalone.status).toBe(0);

    const standaloneInstall = await run(["instructions", "install"], env);
    expect(standaloneInstall.status).toBe(0);
    expect(fs.lstatSync(standaloneLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(standaloneLink)).toBe(standaloneReal);
    const standaloneInstalled = fs.readFileSync(standaloneReal, "utf8");
    expect(standaloneInstalled).toContain("Mandible Interface Contract");
    expect(standaloneInstalled).not.toContain("<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->");
  });
});
