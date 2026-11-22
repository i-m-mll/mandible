import fs from 'node:fs';
import path from 'node:path';

export const daemonBuildOutput = 'dist';
export const frontendBuildOutput = 'ui/dist';
export const uiStaticFiles = [
  'ui/index.html', 'ui/manifest.json', 'ui/sw.js', 'ui/icon.svg',
  'ui/header-logo.svg', 'ui/icon-192.png', 'ui/icon-512.png',
];

const desktopOutputs = {
  MANDIBLE_DESKTOP_BOOTSTRAP_DIR: 'src-tauri/dist',
  MANDIBLE_DESKTOP_PAYLOAD_CONTENTS: 'src-tauri/resources/app-payload/Contents',
  MANDIBLE_DESKTOP_BINARIES_DIR: 'src-tauri/binaries',
  MANDIBLE_DESKTOP_SQLITE_LIBRARY: 'src-tauri/resources/libsqlite3.dylib',
  MANDIBLE_DESKTOP_TRUST_HELPER: 'src-tauri/resources/local-ca-trust-helper',
  MANDIBLE_DESKTOP_APPROVAL_HELPER: 'src-tauri/resources/MandibleApproval.app',
  MANDIBLE_DESKTOP_RUNTIME_DIR: 'src-tauri/resources/bun-runtime',
};
const cargoTarget = 'src-tauri/target';

export function desktopPackageEnvironment(root, env) {
  const outputs = Object.entries(desktopOutputs).map(([name, relative]) => [name, path.resolve(root, env[name] ?? relative)]);
  return { ...env, ...Object.fromEntries(outputs) };
}

export function desktopAppPath(root, { env = process.env, profile = 'release', target, product = 'Mandible' } = {}) {
  return path.resolve(root, env.CARGO_TARGET_DIR ?? cargoTarget, ...[target, profile].filter(Boolean), 'bundle', 'macos', `${product}.app`);
}

/** Acceptance builds into the owned checkout even if its caller has set a custom output directory. */
export function acceptanceBuildEnvironment(env) {
  const owned = { ...env };
  for (const key of [...Object.keys(desktopOutputs), 'MANDIBLE_DESKTOP_TRUST_CACHE', 'CARGO_TARGET_DIR',
    'CARGO_BUILD_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'CARGO_BUILD_TARGET']) delete owned[key];
  return owned;
}

export function acceptanceBuildOutputs(root) {
  const directories = relative => {
    const directory = path.join(root, relative);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(relative, entry.name));
  };
  const targets = directories(cargoTarget);
  const bundles = [...targets, ...targets.flatMap(directories)].map(directory => path.join(directory, 'bundle'));
  return [daemonBuildOutput, frontendBuildOutput, ...bundles, 'src-tauri/gen',
    ...Object.entries(desktopOutputs).map(([name, relative]) => name === 'MANDIBLE_DESKTOP_PAYLOAD_CONTENTS' ? path.dirname(relative) : relative)];
}
