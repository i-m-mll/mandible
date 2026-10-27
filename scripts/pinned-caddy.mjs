import { installedResourceRoot, readInstalledRelease, releaseFile } from './installed-release.mjs';
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CADDY_VERSION = "2.11.3";
const RELEASES = Object.freeze({
  "darwin-x64": { name: `caddy_${CADDY_VERSION}_mac_amd64.tar.gz`, sha256: "9e6f08758f2a4677d0f3acd3e3ccc541b0475217800325b5e5f4ef56668e4c88" },
  "darwin-arm64": { name: `caddy_${CADDY_VERSION}_mac_arm64.tar.gz`, sha256: "b37757be82ef630dddf359e6f1685731a1c657576ce80c469e0e3e6a8fb49e9d" },
});

export function pinnedCaddyBinary(home) {
  const installed = installedResourceRoot();
  if (installed) return releaseFile(installed, readInstalledRelease(installed).native.caddy);
  return path.join(home, "runtime", "caddy", CADDY_VERSION, "caddy"); }

export function installPinnedCaddy(home) {
  const binary = pinnedCaddyBinary(home);
  if (fs.existsSync(binary)) return binary;
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No pinned Caddy build for ${process.platform}-${process.arch}.`);
  const runtimeDir = path.dirname(binary);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const archive = path.join(os.tmpdir(), `mandible-caddy-${randomUUID()}.tar.gz`);
  try {
    const url = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${release.name}`;
    const fetched = spawnSync("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "30", "--output", archive, url], { encoding: "utf8", timeout: 35_000 });
    if (fetched.status !== 0) throw new Error(`Failed to download pinned Caddy: ${fetched.stderr.trim()}`);
    const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (actual !== release.sha256) throw new Error(`Caddy archive digest mismatch: ${actual}`);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", runtimeDir, "caddy"], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(`Failed to extract pinned Caddy: ${extracted.stderr.trim()}`);
    fs.chmodSync(binary, 0o755);
    return binary;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
