#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(fs.readFileSync(path.join(root, "config/canonical-origin.json"), "utf8"));
const origin = new URL(source.production_origin);
if (origin.origin !== source.production_origin || origin.protocol !== "https:"
    || origin.hostname !== "app.mandible.localhost" || origin.port !== "19420") {
  throw new Error("The canonical production origin must be https://app.mandible.localhost:19420.");
}
const files = new Map([
  ["src/canonical-origin.ts", `// Generated from config/canonical-origin.json.\nexport const PRODUCTION_ORIGIN = ${JSON.stringify(origin.origin)};\n`],
  ["scripts/canonical-origin.mjs", `// Generated from config/canonical-origin.json.\nexport const PRODUCTION_ORIGIN = ${JSON.stringify(origin.origin)};\n`],
  ["src-tauri/src/canonical_origin.rs", `// Generated from config/canonical-origin.json.\npub const PRODUCTION_ORIGIN: &str = ${JSON.stringify(origin.origin)};\n`],
  ["src-tauri/bootstrap/canonical-origin.js", `// Generated from config/canonical-origin.json.\nwindow.MANDIBLE_PRODUCTION_ORIGIN = ${JSON.stringify(origin.origin)};\n`],
  ["cli/canonical-origin.sh", `# Generated from config/canonical-origin.json.\nexport MANDIBLE_CANONICAL_ORIGIN=${JSON.stringify(origin.origin)}\n`],
  ["src-tauri/capabilities/default.json", `${JSON.stringify({
    $schema: "../gen/schemas/desktop-schema.json",
    identifier: "default",
    description: "Default capability for Mandible",
    windows: ["main"],
    remote: { urls: [origin.origin] },
    permissions: [
      "core:default",
      "core:window:allow-set-theme",
      "core:window:allow-start-dragging",
      "deep-link:default",
      "allow-desktop-commands",
    ],
  }, null, 2)}\n`],
]);
const inlineTargets = [
  "cli/hooks/mandible-claude-notification.sh",
  "cli/hooks/mandible-claude-ingest-nudge.sh",
  "cli/hooks/mandible-claude-statusline.sh",
];
for (const name of inlineTargets) {
  const current = fs.readFileSync(path.join(root, name), "utf8");
  files.set(name, current.replace(/https:\/\/(?:app\.)?mandible\.localhost(?::19420)?/g, origin.origin));
}
const check = process.argv.includes("--check");
let drift = false;
for (const [name, content] of files) {
  const target = path.join(root, name);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) {
      process.stderr.write(`Canonical origin derived file is stale: ${name}\n`);
      drift = true;
    }
  } else {
    fs.writeFileSync(target, content);
  }
}
if (drift) process.exitCode = 1;
