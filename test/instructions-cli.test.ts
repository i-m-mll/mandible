// @vitest-environment node
/**
 * Installing the instruction fragment: never into a tracked file on the
 * protected branch, mapped into a worktree when asked, refusing symlink ownership crossings, and on the pinned Bun even when none is on PATH.
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

  it("writes only selected owned targets, preserves user text, and refuses symlink destinations", async () => {
    const home = scratchDir("instructions-choice");
    const env = { HOME: home, MANDIBLE_DB: path.join(home, "fixture.db") };
    const empty = await run(["instructions", "install"], env);
    expect(empty.status, empty.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    const target = path.join(home, "selected.md");
    fs.writeFileSync(target, "User instructions\n");
    expect((await run(["instructions", "targets", "add", target], env)).status).toBe(0);
    const selected = await run(["instructions", "install"], env);
    expect(selected.status, selected.stderr).toBe(0);
    fs.appendFileSync(target, "\nMore user instructions\n");
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    const content = fs.readFileSync(target, "utf8");
    expect(content.startsWith("User instructions\n")).toBe(true);
    expect(content.endsWith("More user instructions\n")).toBe(true);
    expect(content.match(/BEGIN MANDIBLE MANAGED/g)).toHaveLength(1);
    expect((await run(["instructions", "post-export", "set", "false"], env)).status).toBe(0);
    const refreshFailure = await run(["instructions", "install"], env);
    expect(refreshFailure.status).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
    expect((await run(["instructions", "post-export", "clear"], env)).status).toBe(0);
    const standalone = path.join(home, "standalone.md");
    expect((await run(["instructions", "targets", "add", standalone, "--mode", "standalone"], env)).status).toBe(0);
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    fs.appendFileSync(standalone, "User edit\n");
    const edited = fs.readFileSync(standalone, "utf8");
    expect((await run(["instructions", "install"], env)).status).toBe(3);
    expect(fs.readFileSync(standalone, "utf8")).toBe(edited);
    const link = path.join(home, "linked.md");
    fs.symlinkSync(target, link);
    const refused = await run(["instructions", "install", "--target", link], env);
    expect(refused.status).toBe(3);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const linkedDir = path.join(home, "linked-directory");
    fs.symlinkSync(home, linkedDir);
    expect((await run(["instructions", "install", "--target", path.join(linkedDir, "new.md")], env)).status).toBe(3);
    expect(fs.existsSync(path.join(home, "new.md"))).toBe(false);
  });
});
