import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const RELEASE_SCHEMA = 'mandible-installed-release@1';
const executionContext = 'source';
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function installedFileIdentity(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, count));
      size += count;
    }
    return { sha256: digest.digest('hex'), size };
  } finally { fs.closeSync(descriptor); }
}

/** Installed context is supplied by the native launcher or the installed module location. */
export function installedResourceRoot() {
  const explicit = process.env.MANDIBLE_RELEASE_ROOT;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('MANDIBLE_RELEASE_ROOT must be absolute.');
    const root = fs.realpathSync(explicit);
    readInstalledRelease(root);
    return root;
  }
  if (executionContext === 'installed') {
    readInstalledRelease(moduleRoot);
    return moduleRoot;
  }
  return null;
}

/** Layout adapters declare program roots; the resource root only locates the manifest. */
export function installedProgramRoots(root, layout) {
  if (layout?.kind !== 'macos-app') throw new Error('Unsupported installed program layout.');
  return Object.values(layout.roots).map(relative => path.resolve(fs.realpathSync(root), relative));
}

export function releaseFile(root, relative, layout = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8')).layout) {
  root = fs.realpathSync(root);
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid installed resource path.');
  const absolute = path.resolve(root, relative);
  if (!installedProgramRoots(root, layout).some(directory => absolute.startsWith(`${directory}${path.sep}`))) throw new Error(`Installed resource leaves its program roots: ${relative}`);
  if (!fs.statSync(absolute).isFile()) throw new Error(`Installed resource is missing: ${relative}`);
  if (fs.realpathSync(absolute) !== absolute) throw new Error(`Installed resource must not reference another installation: ${relative}`);
  return absolute;
}

export function readInstalledRelease(root) {
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (release.schema !== RELEASE_SCHEMA || !/^[a-f0-9]{40}$/.test(release.provenance?.commit ?? '')
      || !/^[a-f0-9]{64}$/.test(release.provenance?.source_digest ?? '')
      || release.target !== `${process.platform}-${process.arch}` || typeof release.version !== 'string'
      || !release.files || !release.entrypoints || !release.native) throw new Error('Invalid or incompatible installed Mandible release.');
  for (const relative of [...Object.values(release.entrypoints), ...Object.values(release.native), ...Object.values(release.resources ?? {})]) {
    if (!/^[a-f0-9]{64}$/.test(release.files[relative]?.sha256 ?? '')) throw new Error(`Unidentified installed resource: ${relative}`);
    releaseFile(root, relative, release.layout);
  }
  return release;
}

/** Verify final shipped bytes, including signed native files; the package receipt binds this manifest. */
export function verifyInstalledRelease(root) {
  const release = readInstalledRelease(root);
  for (const [relative, expected] of Object.entries(release.files)) {
    const file = releaseFile(root, relative, release.layout);
    const actual = installedFileIdentity(file);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`Installed resource changed: ${relative}`);
  }
  return release;
}

export function installedRuntimeEnvironment(root, environment = process.env) {
  root = fs.realpathSync(root);
  const release = readInstalledRelease(root);
  const native = Object.fromEntries(Object.entries(release.native).map(([key, relative]) => [key, releaseFile(root, relative, release.layout)]));
  const result = { ...environment, MANDIBLE_RELEASE_ROOT: root, MANDIBLE_RUNTIME: native.bun,
    MANDIBLE_SQLITE_LIBRARY: native.sqlite, MANDIBLE_CADDY: native.caddy,
    MANDIBLE_CA_TRUST_HELPER: native.trustHelper, MANDIBLE_CLI_DIR: path.join(root, 'cli'),
    PATH: [...new Set([path.dirname(native.bun), path.join(root, 'bin'), ...(environment.PATH ?? '').split(path.delimiter)])].join(path.delimiter),
  };
  delete result.MANDIBLE_SQLITE_LIBRARY_ARCHIVE;
  delete result.MANDIBLE_RUNTIME_ARCHIVE;
  return result;
}
