// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readOptionalIntegrations, applyOptionalIntegration } from "../src/optional-integrations.js";
import { scratchDir } from "./helpers/cli-process.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("installs explicit integrations in an isolated installed profile while preserving ownership and unrelated settings", () => {
  const home = scratchDir("optional-profile");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "custom-claude"));
  vi.stubEnv("CODEX_HOME", path.join(home, "custom-codex"));
  vi.stubEnv("MANDIBLE_RELEASE_ROOT", "");
  expect(applyOptionalIntegration({ id: "cli", action: "install" }).ok).toBe(false);
  const release = scratchDir("optional-release");
  const skill = "cli/skills/mandible/SKILL.md";
  for (const file of ["bin/mandible", skill]) {
    fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), file), path.join(release, file));
  }
  fs.writeFileSync(path.join(release, "release.json"), JSON.stringify({
    schema: "mandible-installed-release@1", version: "fixture", target: `${process.platform}-${process.arch}`,
    provenance: { commit: "a".repeat(40), source_digest: "b".repeat(64) }, layout: { kind: "macos-app", roots: { resources: "." } },
    entrypoints: { cli: "bin/mandible" }, native: {}, resources: { mandibleSkill: skill },
    files: Object.fromEntries(["bin/mandible", skill].map(file => [file, { sha256: "c".repeat(64), size: 1 }])),
  }));
  vi.stubEnv("MANDIBLE_RELEASE_ROOT", release);
  const fresh = readOptionalIntegrations();
  expect(fresh.available).toBe(true);
  expect(fresh.items.every(item => item.status === "absent")).toBe(true);
  expect(fs.readdirSync(home)).toEqual([]);
  expect(applyOptionalIntegration({ id: "cli", action: "install" }, true).ok).toBe(false);
  const target = (id: string) => readOptionalIntegrations().items.find(item => item.id === id)!;
  const settings = target("claude-hooks").destination;
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: "user-choice", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  const mcp = target("claude-mcp").destination;
  fs.writeFileSync(mcp, JSON.stringify({ theme: "user-choice", mcpServers: { other: { command: "other" } } }));
  for (const id of ["cli", "claude-hooks", "claude-mcp", "claude-skill", "codex-skill"] as const) {
    const result = applyOptionalIntegration({ id, action: "install" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(target(id).status).toBe("installed");
  }
  expect(fs.readlinkSync(target("cli").destination)).toBe(path.join(fs.realpathSync(release), "bin/mandible"));
  expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toMatchObject({ model: "user-choice", hooks: { Stop: expect.arrayContaining([expect.objectContaining({ hooks: [{ type: "command", command: "say done" }] })]) } });
  expect(JSON.parse(fs.readFileSync(mcp, "utf8"))).toMatchObject({ theme: "user-choice", mcpServers: { other: { command: "other" } } });
  const customSkill = target("claude-skill").destination;
  fs.appendFileSync(customSkill, "\nMy own policy\n");
  expect(target("claude-skill").status).toBe("conflict");
  expect(applyOptionalIntegration({ id: "claude-skill", action: "remove" }).ok).toBe(false);
  expect(fs.readFileSync(customSkill, "utf8")).toContain("My own policy");
  const changedSettings = JSON.parse(fs.readFileSync(settings, "utf8"));
  changedSettings.statusLine = { type: "command", command: "my-new-statusline" };
  fs.writeFileSync(settings, JSON.stringify(changedSettings));
  expect(target("claude-hooks").status).toBe("outdated");
  expect(applyOptionalIntegration({ id: "claude-hooks", action: "remove" }).ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toMatchObject({ model: "user-choice", statusLine: { command: "my-new-statusline" } });
  fs.unlinkSync(settings);
  fs.symlinkSync(mcp, settings);
  expect(target("claude-hooks").status).toBe("conflict");
  expect(applyOptionalIntegration({ id: "claude-hooks", action: "install" }).ok).toBe(false);
  expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
  expect(applyOptionalIntegration({ id: "claude-mcp", action: "remove" }).ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(mcp, "utf8"))).toEqual({ theme: "user-choice", mcpServers: { other: { command: "other" } } });
});
