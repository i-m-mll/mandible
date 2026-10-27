import { installedResourceRoot, readInstalledRelease, releaseFile } from "../scripts/installed-release.mjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProviderStartupProvenance } from "./provider-startup.js";

const require = createRequire(import.meta.url);

type PackageIdentity = { root: string; version: string };

function packageIdentity(name: string): PackageIdentity {
  const entrypoint = fs.realpathSync(require.resolve(name));
  let root = path.dirname(entrypoint);
  while (root !== path.dirname(root)) {
    const packagePath = path.join(root, "package.json");
    if (fs.existsSync(packagePath)) {
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string; version?: string };
      if (manifest.name === name && typeof manifest.version === "string") {
        return { root, version: manifest.version };
      }
    }
    root = path.dirname(root);
  }
  throw new Error(`Cannot resolve package identity for ${name}`);
}

export function claudeSdkProvenance(): ProviderStartupProvenance {
  const identity = packageIdentity("@anthropic-ai/claude-agent-sdk");
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  const libc = process.platform === "linux"
    ? (report?.header?.glibcVersionRuntime ? "" : "-musl")
    : "";
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}`;
  const platformManifestPath = require.resolve(`${platformPackage}/package.json`);
  const platformManifest = JSON.parse(fs.readFileSync(platformManifestPath, "utf8")) as { version: string };
  if (platformManifest.version !== identity.version) {
    throw new Error(`Claude SDK wrapper ${identity.version} does not match native package ${platformManifest.version}`);
  }
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const installed = installedResourceRoot();
  const entrypoint = installed ? releaseFile(installed, readInstalledRelease(installed).native.claude)
    : fs.realpathSync(path.join(path.dirname(platformManifestPath), binaryName));
  return {
    backend_type: "sdk",
    provider: "claude",
    implementation: {
      kind: "package",
      name: "@anthropic-ai/claude-agent-sdk",
      version: identity.version,
      entrypoint,
      launcher: entrypoint,
    },
  };
}

export function resolveExecutable(command: string, env: Record<string, string>): string {
  if (path.isAbsolute(command)) return fs.realpathSync(command);
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error(`Provider executable is not available: ${command}`);
}

export function executableProvenance(provider: string, entrypoint: string): ProviderStartupProvenance {
  return {
    backend_type: "acp",
    provider,
    implementation: {
      kind: "executable",
      name: provider,
      version: null,
      entrypoint,
      launcher: entrypoint,
    },
  };
}
