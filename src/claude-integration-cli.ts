import {
  getUserClaudeIntegrationStatus,
  installUserClaudeIntegration,
  uninstallUserClaudeIntegration,
} from "./claude-hook-settings.js";

import { parseCommand, stringOption, flagOption } from "./cli/grammar.js";
const parsed = parseCommand(["claude-integration"], process.argv.slice(2));
const action = parsed.command.split(".").at(-1);
const settingsPath = stringOption(parsed, "settings");
const json = flagOption(parsed, "json");

switch (action) {
  case "install": {
    const result = installUserClaudeIntegration({ settingsPath });
    print(result);
    break;
  }
  case "uninstall": {
    const result = uninstallUserClaudeIntegration({ settingsPath });
    print(result);
    break;
  }
  case "status": {
    const result = getUserClaudeIntegrationStatus({ settingsPath });
    print(result);
    process.exitCode = result.status === "drifted" ? 1 : 0;
    break;
  }
  default:
    throw new Error("Unknown integration action");
}

function print(result: object): void {
  const record = result as Record<string, unknown>;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const status = typeof record.status === "string" ? record.status : "unknown";
  const path = typeof record.settingsPath === "string" ? record.settingsPath : "";
  console.log(path ? `${status}: ${path}` : status);
  if (Array.isArray(record.details) && record.details.length > 0) {
    for (const detail of record.details) {
      console.log(`- ${detail}`);
    }
  }
}
