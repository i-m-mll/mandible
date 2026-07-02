import {
  getUserClaudeIntegrationStatus,
  installUserClaudeIntegration,
  uninstallUserClaudeIntegration,
} from "./claude-hook-settings.js";

function usage(): never {
  console.error("Usage: mandible claude-integration <install|uninstall|status> [--settings <path>] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const action = args.shift();
let settingsPath: string | undefined;
let json = false;

while (args.length > 0) {
  const arg = args.shift();
  switch (arg) {
    case "--settings":
      settingsPath = args.shift();
      if (!settingsPath) usage();
      break;
    case "--json":
      json = true;
      break;
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      usage();
  }
}

if (!action) {
  usage();
}

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
    usage();
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
