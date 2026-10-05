import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const destination = path.join(repoRoot, "src", "conversation-control", "generated", "codex-app-server");
const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-codex-app-server-"));
const providerPath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => !entry.includes(`${path.sep}node_modules${path.sep}.bin`))
  .join(path.delimiter);
const codexBinary = process.env.MANDIBLE_CODEX_BIN
  ?? execFileSync("which", ["codex"], {
    encoding: "utf8",
    env: { ...process.env, PATH: providerPath },
    timeout: 60_000,
  }).trim();
const entrypoints = [
  "InitializeParams.ts",
  "ClientNotification.ts",
  "v2/GetAccountParams.ts",
  "v2/ThreadReadParams.ts",
  "v2/ThreadUnarchiveParams.ts",
  "v2/ThreadResumeParams.ts",
  "v2/ThreadStartParams.ts",
  "v2/TurnInterruptParams.ts",
  "v2/TurnStartParams.ts",
  "v2/TurnSteerParams.ts",
];

function importedFiles(relativePath, source) {
  return [...source.matchAll(/from "([^"]+)"/g)].map((match) =>
    path.normalize(path.join(path.dirname(relativePath), `${match[1]}.ts`)),
  );
}

function collect(relativePath, selected) {
  if (selected.has(relativePath)) return;
  selected.add(relativePath);
  const source = fs.readFileSync(path.join(generatedRoot, relativePath), "utf8");
  for (const dependency of importedFiles(relativePath, source)) collect(dependency, selected);
}

try {
  execFileSync(codexBinary, ["app-server", "generate-ts", "--out", generatedRoot], {
    stdio: "inherit",
    timeout: 60_000,
  });
  const version = execFileSync(codexBinary, ["--version"], { encoding: "utf8", timeout: 60_000 }).trim();
  const selected = new Set();
  for (const entrypoint of entrypoints) collect(entrypoint, selected);

  fs.rmSync(destination, { recursive: true, force: true });
  for (const relativePath of [...selected].sort()) {
    const target = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = fs.readFileSync(path.join(generatedRoot, relativePath), "utf8")
      .replace(/from "([^"]+)"/g, 'from "$1.js"');
    fs.writeFileSync(target, source);
  }
  const exports = entrypoints
    .map((relativePath) => `export type { ${path.basename(relativePath, ".ts")} } from "./${relativePath.replace(/\.ts$/, ".js")}";`)
    .join("\n");
  fs.writeFileSync(
    path.join(destination, "index.ts"),
    `// GENERATED CODE! DO NOT MODIFY BY HAND!\n// Source: ${version} app-server generate-ts\n\n${exports}\n`,
  );
} finally {
  fs.rmSync(generatedRoot, { recursive: true, force: true });
}
