import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedResourceRoot, releaseFile } from "../scripts/installed-release.mjs";

const developmentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function productResource(relative: string): string {
  const root = installedResourceRoot();
  return root ? releaseFile(root, relative) : path.join(developmentRoot, relative);
}

export function publicCommand(...args: string[]): { command: string; args: string[] } {
  return { command: productResource("bin/mandible"), args };
}
