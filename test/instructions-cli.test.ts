// @vitest-environment node
/**
 * Installing the instruction fragment: never into a tracked file on the
 * protected branch, mapped into a worktree when asked, refusing symlink ownership crossings, and on the pinned Bun even when none is on PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runCli, scratchDir } from "./helpers/cli-process.js";
import Database from "../src/sqlite.js";

const run = (args: string[], env: Record<string, string> = {}) => runCli(args, { cwd: process.cwd(), env });

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

describe("instructions CLI", () => {
  it("refuses inaccessible settings ancestors instead of treating standalone targets as unconfigured", async () => {
    const home = scratchDir("instructions-inaccessible-settings");
    const settingsDir = path.join(home, "settings");
    const target = path.join(home, "standalone.md");
    const env = { HOME: home, MANDIBLE_DB: path.join(settingsDir, "fixture.db") };
    expect((await run(["instructions", "targets", "add", target, "--mode", "standalone"], env)).status).toBe(0);
    expect((await run(["instructions", "install", "--target", target], env)).status).toBe(0);
    const before = fs.readFileSync(target);
    fs.chmodSync(settingsDir, 0o000);
    try {
      for (const command of ["diff", "install"]) {
        // The test-only production DB guard also stats this private path and would mask the exporter defect.
        const result = await runCli([path.join(process.cwd(), "cli/instructions.sh"), command, "--target", target],
          { command: "bash", cwd: process.cwd(), env: { ...env, VITEST: undefined, VITEST_WORKER_ID: undefined, NODE_ENV: "production" } });
        expect(result.status, `${command}: ${result.stderr}`).not.toBe(0);
        expect(result.stderr).toMatch(/EACCES|EPERM|permission denied/i);
        expect(fs.readFileSync(target)).toEqual(before);
      }
    } finally {
      fs.chmodSync(settingsDir, 0o700);
    }
  });

  it("uses configured output modes consistently for explicit diff, install, and refresh", async () => {
    const home = scratchDir("instructions-modes");
    const env = { HOME: home, MANDIBLE_DB: path.join(home, "fixture.db") };
    const standalone = path.join(home, "standalone.md");
    const managed = path.join(home, "managed.md");
    fs.writeFileSync(managed, "User instructions\n");
    for (const [target, mode] of [[standalone, "standalone"], [managed, "managed-block"]]) {
      const added = await run(["instructions", "targets", "add", target!, "--mode", mode!], env);
      expect(added.status, added.stderr).toBe(0);
    }
    const pending = await run(["instructions", "diff", "--target", standalone], env);
    expect(pending.status, pending.stderr).toBe(0);
    expect(pending.stdout).toContain("+<!-- MANDIBLE GENERATED sha256:");
    expect(pending.stdout).not.toContain("BEGIN MANDIBLE MANAGED");
    expect(fs.existsSync(standalone)).toBe(false);
    for (const target of [standalone, managed]) {
      const installed = await run(["instructions", "install", "--target", target], env);
      expect(installed.status, installed.stderr).toBe(0);
      const content = fs.readFileSync(target, "utf8");
      const diff = await run(["instructions", "diff", "--target", target], env);
      expect(diff.status, diff.stderr).toBe(0);
      expect(diff.stdout).not.toContain("@@");
      expect((await run(["instructions", "install"], env)).status).toBe(0);
      expect(fs.readFileSync(target, "utf8")).toBe(content);
    }
    expect(fs.readFileSync(managed, "utf8")).toContain("User instructions\n\n<!-- BEGIN");
    const managedBytes = fs.readFileSync(managed, "utf8");
    expect((await run(["instructions", "install", "--target", `${home}/missing/../managed.md`], env)).status).toBe(0);
    expect(fs.readFileSync(managed, "utf8")).toBe(managedBytes);
    const owned = fs.readFileSync(standalone, "utf8");
    const old = "Previous generated fragment\n";
    fs.writeFileSync(standalone, `${old}\n<!-- MANDIBLE GENERATED sha256:${createHash("sha256").update(old).digest("hex")} -->\n`);
    expect((await run(["instructions", "install", "--target", standalone], env)).status).toBe(0);
    expect(fs.readFileSync(standalone, "utf8")).toBe(owned);
    fs.appendFileSync(standalone, "User edit\n");
    expect((await run(["instructions", "install", "--target", standalone, "--force"], env)).status).toBe(3);
    expect(fs.readFileSync(standalone, "utf8")).toBe(`${owned}User edit\n`);
    const oneOff = path.join(home, "one-off.md");
    fs.writeFileSync(oneOff, owned);
    expect((await run(["instructions", "install", "--target", oneOff], env)).status).toBe(0);
    expect(fs.readFileSync(oneOff, "utf8")).toContain("BEGIN MANDIBLE MANAGED");
  });

  it("resolves mode using normalized source identity before mapping and preserves ownership boundaries", async () => {
    const home = scratchDir("instructions-identity");
    const repo = path.join(home, "repo");
    const worktree = path.join(home, "worktree");
    fs.mkdirSync(repo);
    fs.mkdirSync(worktree);
    git(repo, ["init", "-b", "main"]);
    const env = { HOME: home, MANDIBLE_DB: path.join(home, "fixture.db") };
    const source = path.join(repo, "instructions.md");
    fs.writeFileSync(source, "Protected source\n");
    git(repo, ["add", "instructions.md"]);
    const alias = `${repo}/unused/../instructions.md`;
    expect((await run(["instructions", "targets", "add", alias, "--mode", "standalone"], env)).status).toBe(0);
    const protectedInstall = await run(["instructions", "install", "--target", source], env);
    expect(protectedInstall.status).toBe(3);
    const args = ["--target", source, "--worktree", worktree];
    const diff = await run(["instructions", "diff", "--target", source], env);
    expect(diff.status, diff.stderr).toBe(0);
    expect(diff.stdout).not.toContain("BEGIN MANDIBLE MANAGED");
    const install = await run(["instructions", "install", ...args], env);
    expect(install.status, install.stderr).toBe(0);
    const destination = path.join(worktree, "instructions.md");
    const content = fs.readFileSync(destination, "utf8");
    expect(content).toContain("<!-- MANDIBLE GENERATED sha256:");
    expect((await run(["instructions", "install", ...args], env)).status).toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe(content);
    expect(fs.readFileSync(source, "utf8")).toBe("Protected source\n");
    fs.unlinkSync(destination);
    fs.symlinkSync(source, destination);
    expect((await run(["instructions", "install", ...args, "--force"], env)).status).toBe(3);
    expect(fs.readFileSync(source, "utf8")).toBe("Protected source\n");
    expect((await run(["instructions", "targets", "rm", alias], env)).status).toBe(0);
    expect((await run(["instructions", "targets", "list"], env)).stdout).toBe("");
  });

  it("looks up targets without creating settings and rejects corrupt registries without changing files", async () => {
    const home = scratchDir("instructions-read-only");
    const dbPath = path.join(home, "absent", "fixture.db");
    const env = { HOME: home, MANDIBLE_DB: dbPath };
    const target = path.join(home, "target.md");
    fs.writeFileSync(target, "User text\n");
    expect((await run(["instructions", "diff", "--target", target], env)).status).toBe(0);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
    fs.mkdirSync(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (value TEXT)");
    expect((await run(["instructions", "diff", "--target", target], env)).status).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'settings'").get()).toBeUndefined();
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    db.pragma("journal_mode = WAL");
    db.prepare("INSERT INTO settings VALUES ('instructions.targets', ?, 1)").run(JSON.stringify([{ path: target, mode: "standalone" }]));
    const validBytes = fs.readFileSync(dbPath);
    const walBytes = fs.readFileSync(`${dbPath}-wal`);
    const configuredDiff = await run(["instructions", "diff", "--target", target], env);
    expect(configuredDiff.status, configuredDiff.stderr).toBe(0);
    expect(configuredDiff.stdout).not.toContain("BEGIN MANDIBLE MANAGED");
    expect(fs.readFileSync(dbPath)).toEqual(validBytes);
    expect(fs.readFileSync(`${dbPath}-wal`)).toEqual(walBytes);
    for (const registry of ["{", "null", "{}", "[null]", JSON.stringify([{ path: target, mode: "typo" }]),
      JSON.stringify([{ path: target, mode: "standalone" }, { path: `${home}/./target.md`, mode: "managed-block" }])]) {
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('instructions.targets', ?, 1)").run(registry);
      const before = fs.readFileSync(dbPath);
      for (const command of ["diff", "install"]) {
        const result = await run(["instructions", command, "--target", target], env);
        expect(result.status, result.stdout).not.toBe(0);
        expect(fs.readFileSync(target, "utf8")).toBe("User text\n");
        expect(fs.readFileSync(dbPath)).toEqual(before);
      }
    }
    db.close();
  });

  it("matches physical aliases through missing ancestors without bypassing destination symlink guards", async () => {
    const home = scratchDir("instructions-physical-identity");
    const real = path.join(home, "real");
    const alias = path.join(home, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const target = path.join(real, "missing", "nested", "instructions.md");
    const aliasTarget = path.join(alias, "missing", "nested", "instructions.md");
    const env = { HOME: home, MANDIBLE_DB: path.join(home, "fixture.db") };
    expect((await run(["instructions", "targets", "add", target, "--mode", "standalone"], env)).status).toBe(0);
    const diff = await run(["instructions", "diff", "--target", aliasTarget], env);
    expect(diff.status, diff.stderr).toBe(0);
    expect(diff.stdout).not.toContain("BEGIN MANDIBLE MANAGED");
    expect((await run(["instructions", "install", "--target", aliasTarget, "--force"], env)).status).toBe(3);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    expect(fs.readFileSync(target, "utf8")).not.toContain("BEGIN MANDIBLE MANAGED");
    expect((await run(["instructions", "targets", "add", aliasTarget, "--mode", "managed-block"], env)).status).toBe(0);
    expect((await run(["instructions", "targets", "list"], env)).stdout.trim().split("\n")).toHaveLength(1);
    expect((await run(["instructions", "targets", "rm", target], env)).status).toBe(0);
    expect((await run(["instructions", "targets", "list"], env)).stdout).toBe("");
    const db = new Database(env.MANDIBLE_DB);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'instructions.targets'").run(JSON.stringify([
      { path: target, mode: "standalone" }, { path: aliasTarget, mode: "managed-block" },
    ]));
    const before = fs.readFileSync(target, "utf8");
    expect((await run(["instructions", "install", "--target", target], env)).status).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'instructions.targets'").run(JSON.stringify([
      { path: target, mode: "standalone" }, { path: aliasTarget, mode: "standalone" },
    ]));
    expect((await run(["instructions", "targets", "list"], env)).stdout.trim().split("\n")).toHaveLength(1);
    expect((await run(["instructions", "install"], env)).status).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    db.close();
    const invalidDb = path.join(home, "invalid.db");
    fs.writeFileSync(invalidDb, "not a SQLite database");
    expect((await run(["instructions", "install", "--target", target], { ...env, MANDIBLE_DB: invalidDb })).status).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(fs.readFileSync(invalidDb, "utf8")).toBe("not a SQLite database");
    const outsideRepo = await run(["instructions", "install", "--target", target, "--worktree", scratchDir("instructions-unrelated-destination")],
      { ...env, MANDIBLE_DB: path.join(home, "absent.db") });
    expect(outsideRepo.status).toBe(2);
    expect(outsideRepo.stderr).toContain("Cannot map target outside a git worktree");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

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

    const install = await run(["instructions", "install", "--target", target], { MANDIBLE_DB: path.join(repo, "fixture.db") });

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
    ], { MANDIBLE_DB: path.join(repo, "fixture.db") });

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
