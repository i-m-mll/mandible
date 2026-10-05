import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./types.js";

const DEFAULT_COWORK_CLI_CACHE_DIR = path.join(userHome(), ".cache", "mandible", "cli");
const CLI_SOURCE_DIR = "cli";
const CLI_REFERENCE_SOURCE = path.join("docs", "cli-reference.md");

export interface CoworkCliCacheOptions {
  sourceRoot: string;
  targetDir?: string;
  version?: string;
  logger?: Logger;
  generatedFiles?: CoworkCliCacheGeneratedFile[];
}

export interface CoworkCliCacheFile {
  source: string;
  path: string;
  sha256: string;
  size: number;
}

export interface CoworkCliCacheGeneratedFile {
  path: string;
  contents: string;
  mode?: number;
}

export interface CoworkCliCacheManifest {
  schema: "mandible-cowork-cli-cache@2";
  content_digest: string;
  version: string;
  source_root: string;
  generated_at: string;
  files: CoworkCliCacheFile[];
}

export function defaultCoworkCliCacheDir(): string {
  return process.env.MANDIBLE_CLI_CACHE_DIR?.trim()
    ? path.resolve(resolveHome(process.env.MANDIBLE_CLI_CACHE_DIR.trim()))
    : DEFAULT_COWORK_CLI_CACHE_DIR;
}

export function materializeCoworkCliCache(options: CoworkCliCacheOptions): CoworkCliCacheManifest {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetDir = path.resolve(options.targetDir ?? defaultCoworkCliCacheDir());
  const files = collectCacheFiles(sourceRoot);

  if (files.length === 0) {
    throw new Error(`no CLI files found under ${path.join(sourceRoot, CLI_SOURCE_DIR)}`);
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const manifestFiles: CoworkCliCacheFile[] = [];
  for (const file of files) {
    const sourcePath = path.join(sourceRoot, file.source);
    const destinationPath = path.join(targetDir, file.path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const mode = file.path.endsWith(".sh") ? 0o755 : 0o644;
    const bytes = copyFileAtomically(sourcePath, destinationPath, mode);
    manifestFiles.push({
      source: file.source,
      path: file.path,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
  for (const file of options.generatedFiles ?? []) {
    const normalizedPath = normalizeGeneratedFilePath(file.path);
    const destinationPath = path.join(targetDir, normalizedPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const mode = file.mode ?? 0o644;
    const bytes = Buffer.from(file.contents, "utf8");
    writeFileAtomically(destinationPath, bytes, mode);
    manifestFiles.push({
      source: `generated:${normalizedPath}`,
      path: normalizedPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }

  const manifest: CoworkCliCacheManifest = {
    schema: "mandible-cowork-cli-cache@2",
    content_digest: crypto.createHash("sha256").update(JSON.stringify(
      manifestFiles.map(({ source, path, sha256 }) => ({ source, path, sha256 })),
    )).digest("hex"),
    version: options.version ?? "0.0.0",
    source_root: sourceRoot,
    generated_at: new Date().toISOString(),
    files: manifestFiles,
  };
  writeFileAtomically(
    path.join(targetDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o644,
  );
  options.logger?.("info", "cowork_cli_cache_materialized", {
    target_dir: targetDir,
    file_count: manifestFiles.length,
    version: manifest.version,
  });
  return manifest;
}

function normalizeGeneratedFilePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid generated CLI cache path: ${input}`);
  }
  return normalized;
}

function copyFileAtomically(sourcePath: string, destinationPath: string, mode: number): Buffer {
  const bytes = fs.readFileSync(sourcePath);
  writeFileAtomically(destinationPath, bytes, mode);
  return bytes;
}

function writeFileAtomically(destinationPath: string, data: string | Buffer, mode: number): void {
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, data, { mode });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, destinationPath);
}

function collectCacheFiles(sourceRoot: string): Array<{ source: string; path: string }> {
  const cliDir = path.join(sourceRoot, CLI_SOURCE_DIR);
  const files: Array<{ source: string; path: string }> = [];
  if (fs.existsSync(cliDir)) {
    for (const entry of fs.readdirSync(cliDir).sort()) {
      // Shell entrypoints depend on adjacent renderers, syntax data, jq modules,
      // and authored instruction Markdown. Ship the runtime together.
      if (![".sh", ".cjs", ".json", ".md", ".jq"].includes(path.extname(entry))) continue;
      const source = path.join(CLI_SOURCE_DIR, entry);
      files.push({ source, path: entry });
    }
  }

  // A flattened CLI bundle needs the selector's complete, platform-independent
  // identity contract. Reuse its verification/install path rather than inventing
  // a cache-specific runtime or trusting the destination's ambient executable.
  if (files.some((file) => file.path === "command-syntax.sh")) {
    for (const source of [".bun-version", "scripts/bun-runtime.sh", "scripts/bun-runtime-lock.tsv", "scripts/sqlite-runtime-install.mjs", "src/sqlite-runtime.ts"]) {
      if (!fs.statSync(path.join(sourceRoot, source)).isFile()) {
        throw new Error(`missing CLI runtime dependency: ${source}`);
      }
      files.push({ source, path: path.join("runtime", source) });
    }
  }

  const referencePath = path.join(sourceRoot, CLI_REFERENCE_SOURCE);
  if (fs.existsSync(referencePath)) {
    files.push({ source: CLI_REFERENCE_SOURCE, path: path.join("docs", "cli-reference.md") });
  }
  return files;
}

function userHome(): string {
  return process.env.HOME || os.homedir();
}

function resolveHome(input: string): string {
  if (input === "~") return userHome();
  if (input.startsWith("~/")) return path.join(userHome(), input.slice(2));
  return input;
}
