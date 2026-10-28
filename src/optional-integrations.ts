import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as z from "zod";
import { installedResourceRoot } from "../scripts/installed-release.mjs";
import { productResource, publicCommand } from "./product-resources.js";
import { getUserClaudeIntegrationStatus, installUserClaudeIntegration, uninstallUserClaudeIntegration } from "./claude-hook-settings.js";

const { ownershipConflict } = createRequire(import.meta.url)("../cli/integration-files.cjs") as {
  ownershipConflict(target: string): string | null;
};
export const INTEGRATION_ACTION = z.object({
  id: z.enum(["cli", "claude-hooks", "claude-mcp", "claude-skill", "codex-skill"]),
  action: z.enum(["install", "remove"]),
});
type IntegrationId = z.infer<typeof INTEGRATION_ACTION>["id"];
export type OptionalIntegration = {
  id: IntegrationId;
  label: string;
  destination: string;
  status: "absent" | "installed" | "outdated" | "conflict";
  detail: string;
};
export type OptionalIntegrations = {
  available: boolean;
  command: string;
  skill: string;
  items: OptionalIntegration[];
};

function destinations(): Record<IntegrationId, string> {
  const home = os.homedir();
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return {
    cli: path.join(home, ".local/bin/mandible"),
    "claude-hooks": path.join(claude, "settings.json"),
    "claude-mcp": process.env.CLAUDE_CONFIG_DIR ? path.join(claude, ".claude.json") : path.join(home, ".claude.json"),
    "claude-skill": path.join(claude, "skills/mandible/SKILL.md"),
    "codex-skill": path.join(home, ".agents/skills/mandible/SKILL.md"),
  };
}

function jsonFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON object: ${file}`);
  return parsed;
}

function mcpEntry() { return { type: "stdio", ...publicCommand("channel") }; }
function sameMcp(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.command === publicCommand().command && JSON.stringify(record.args) === JSON.stringify(["channel"]);
}

export function readOptionalIntegrations(preview = false): OptionalIntegrations {
  const command = publicCommand().command;
  const skill = fs.readFileSync(productResource("cli/skills/mandible/SKILL.md"), "utf8");
  const labels: Record<IntegrationId, string> = {
    cli: "Command line shortcut", "claude-hooks": "Claude hooks and status line",
    "claude-mcp": "Claude MCP channel", "claude-skill": "Claude Mandible skill", "codex-skill": "Codex Mandible skill",
  };
  const items = Object.entries(destinations()).map(([key, destination]): OptionalIntegration => {
    const id = key as IntegrationId;
    const item: OptionalIntegration = { id, label: labels[id], destination, status: "absent", detail: "" };
    try {
      // Our CLI link is the one deliberately owned symlink; never follow a parent link.
      const conflict = ownershipConflict(id === "cli" ? path.dirname(destination) : destination);
      if (conflict) return { ...item, status: "conflict", detail: conflict };
      if (id === "codex-skill") {
        const legacy = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills/mandible");
        if (fs.lstatSync(legacy, { throwIfNoEntry: false }) || fs.lstatSync(path.dirname(legacy), { throwIfNoEntry: false })?.isSymbolicLink()) {
          return { ...item, status: "conflict", detail: `Existing user-owned skill: ${legacy}. Keep or manage it yourself.` };
        }
      }
      if (id === "cli") {
        const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (stat) return { ...item, status: stat.isSymbolicLink() && fs.readlinkSync(destination) === command ? "installed" : "conflict", detail: "Existing command shortcut" };
      } else if (id.endsWith("skill")) {
        if (fs.existsSync(destination)) return { ...item, status: fs.readFileSync(destination, "utf8") === skill ? "installed" : "conflict", detail: "Existing skill content is preserved" };
      } else if (id === "claude-hooks") {
        jsonFile(destination);
        const status = getUserClaudeIntegrationStatus({ settingsPath: destination });
        return { ...item, status: status.status === "absent" ? "absent" : status.status === "installed" ? "installed" : "outdated", detail: status.details.join(", ") };
      } else {
        const config = jsonFile(destination);
        const servers = config.mcpServers;
        if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error("Invalid mcpServers configuration");
        const entry = (servers as Record<string, unknown> | undefined)?.mandible;
        if (entry !== undefined) return { ...item, status: sameMcp(entry) ? "installed" : "conflict", detail: "Existing Mandible MCP registration" };
      }
      return item;
    } catch (error) { return { ...item, status: "conflict", detail: String(error) }; }
  });
  return { available: !preview && installedResourceRoot() !== null, command, skill, items };
}

export function applyOptionalIntegration(input: z.infer<typeof INTEGRATION_ACTION>, preview = false):
  { ok: true; value: OptionalIntegrations } | { ok: false; error: string } {
  const state = readOptionalIntegrations(preview);
  if (!state.available) return { ok: false, error: "Integration installation is available in the installed app. This source or preview instance does not change global integrations." };
  const item = state.items.find(item => item.id === input.id)!;
  if (item.status === "conflict") return { ok: false, error: item.detail };
  if ((input.action === "install" && item.status === "installed") || (input.action === "remove" && item.status === "absent")) return { ok: true, value: state };
  try {
    if (input.id === "claude-hooks") {
      const options = { settingsPath: item.destination };
      if (input.action === "install") installUserClaudeIntegration(options);
      else uninstallUserClaudeIntegration(options);
    } else if (input.id === "claude-mcp") {
      const config = jsonFile(item.destination);
      const servers = { ...(config.mcpServers as Record<string, unknown> | undefined) };
      if (input.action === "install") servers.mandible = mcpEntry();
      else delete servers.mandible;
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      fs.writeFileSync(item.destination, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
    } else if (input.action === "remove") fs.unlinkSync(item.destination);
    else {
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      if (input.id === "cli") fs.symlinkSync(state.command, item.destination);
      else fs.writeFileSync(item.destination, state.skill, { flag: "wx" });
    }
    return { ok: true, value: readOptionalIntegrations(preview) };
  } catch (error) { return { ok: false, error: String(error) }; }
}
