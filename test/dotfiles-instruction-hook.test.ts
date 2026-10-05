// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.js";
import { migrate, MINIMUM_SUPPORTED_SCHEMA_VERSION } from "../src/db.js";

it("compiles fresh and migrated automatic hooks without repairing provider settings or home links", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-compile-hook-"));
  const databases: SqliteDatabase[] = [];
  try {
    const floor = fs.readFileSync(path.join(process.cwd(), "test/fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`), "utf8");
    const fresh = new SqliteDatabase(":memory:"); databases.push(fresh); migrate(fresh);
    const existing = new SqliteDatabase(":memory:"); databases.push(existing); existing.exec(floor);
    existing.prepare("UPDATE auth_hooks SET enabled = 0, position = 7, label = 'My instruction label' WHERE id = 'builtin-dotfiles-agent-instructions'").run();
    const customized = new SqliteDatabase(":memory:"); databases.push(customized); customized.exec(floor);
    customized.prepare("UPDATE auth_hooks SET command = 'echo my custom hook' WHERE id = 'builtin-dotfiles-agent-instructions'").run();
    customized.exec("INSERT INTO auth_hooks (id, repo_pattern, auth_type, command, label, enabled, builtin, position, created_at, updated_at, required) SELECT 'custom-doctor', repo_pattern, auth_type, command, label, enabled, 0, position, created_at, updated_at, required FROM auth_hooks WHERE id = 'builtin-dotfiles-agent-instructions-nodot'");
    const customDoctor = customized.prepare("SELECT command FROM auth_hooks WHERE id = 'custom-doctor'").get() as { command: string };
    migrate(existing); migrate(existing); migrate(customized);
    expect(customized.prepare("SELECT command FROM auth_hooks WHERE id = 'builtin-dotfiles-agent-instructions'").get()).toEqual({ command: "echo my custom hook" });
    expect(customized.prepare("SELECT command FROM auth_hooks WHERE id = 'custom-doctor'").get()).toEqual(customDoctor);
    expect(existing.prepare("SELECT enabled, position, label FROM auth_hooks WHERE id = 'builtin-dotfiles-agent-instructions'").get()).toEqual({ enabled: 0, position: 7, label: "My instruction label" });

    const repo = path.join(scratch, "repo"); const home = path.join(scratch, "home");
    fs.mkdirSync(path.join(repo, "bin"), { recursive: true }); fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const settings = path.join(home, ".claude/settings.json");
    const content = '{"permissions":{"allow":["my-existing-choice"]}}\n'; fs.writeFileSync(settings, content);
    const link = path.join(home, ".codex/AGENTS.md"); fs.symlinkSync("my-existing-instructions.md", link);
    fs.writeFileSync(path.join(repo, "instructions.source"), "Current shared instructions\n");
    fs.writeFileSync(path.join(repo, "bin/compile-agent-instructions"), '#!/bin/bash\nset -eu\ncp instructions.source instructions.generated\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "bin/agent-instruction-symlink-doctor"), '#!/bin/bash\nset -eu\nmv "$HOME/.claude/settings.json" "$HOME/.claude/settings.backup"\nrm "$HOME/.codex/AGENTS.md"\nln -s canonical "$HOME/.codex/AGENTS.md"\nbash bin/compile-agent-instructions\n', { mode: 0o755 });
    const originalSettings = fs.lstatSync(settings);
    for (const db of [fresh, existing]) {
      const hooks = db.prepare("SELECT command FROM auth_hooks WHERE id IN ('builtin-dotfiles-agent-instructions', 'builtin-dotfiles-agent-instructions-nodot')").all() as Array<{ command: string }>;
      expect(hooks).toHaveLength(2);
      for (const hook of hooks) {
        const result = spawnSync("bash", ["-c", hook.command], { cwd: repo, env: { ...process.env, HOME: home }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(path.join(repo, "instructions.generated"), "utf8")).toBe("Current shared instructions\n");
        expect(fs.readFileSync(settings, "utf8")).toBe(content);
        expect(fs.lstatSync(settings).isFile()).toBe(true);
        expect(fs.lstatSync(settings).ino).toBe(originalSettings.ino);
        expect(fs.readdirSync(path.dirname(settings))).toEqual(["settings.json"]);
        expect(fs.readlinkSync(link)).toBe("my-existing-instructions.md");
        fs.rmSync(path.join(repo, "instructions.generated"));
      }
    }
    expect(fs.existsSync(path.join(repo, "bin/agent-instruction-symlink-doctor"))).toBe(true);
  } finally {
    for (const db of databases) db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
