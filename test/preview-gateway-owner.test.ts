// @vitest-environment node
import { testRuntimeRoot } from './helpers/runtime-isolation.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installedFileIdentity } from '../scripts/installed-release.mjs';

const home = path.join(testRuntimeRoot, 'installation');
const app = path.join(testRuntimeRoot, 'Mandible.app');
const resources = path.join(app, 'Contents/Resources');
const receipt = path.join(testRuntimeRoot, 'gateway-reloaded');
const ownerFile = path.join(home, 'config/local-sessions/bundle-owner.json');

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('reloads through the installed service owner and refuses a changed owner before executing any controller', async () => {
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/MacOS'));
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.mkdirSync(path.join(home, 'config/client-auth'));
  fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), 'fixture-installation');
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>bio.mll.mandible.fixture</string></dict></plist>');
  const owner = { schema: 'mandible-bundle-owner@1', bundleRoot: app, installationId: 'fixture-installation', generation: 'a'.repeat(40), sourceDigest: 'b'.repeat(64) };
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  fs.writeFileSync(path.join(path.dirname(ownerFile), 'bundle-launch.json'), JSON.stringify({ launchMode: 'manual' }));
  const runtime = path.join(app, 'Contents/MacOS/mandible-bun');
  fs.writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  const controller = path.join(resources, 'controller.mjs');
  fs.writeFileSync(controller, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(receipt)}, 'gateway reloaded by installed controller'); console.log('reloaded');`);
  const manifest = { schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`,
    layout: { kind: 'macos-app', roots: { resources: '.', native: '../MacOS' } }, provenance: { commit: owner.generation, source_digest: owner.sourceDigest },
    entrypoints: { controller: 'controller.mjs' }, native: { bun: '../MacOS/mandible-bun' },
    files: { 'controller.mjs': installedFileIdentity(controller), '../MacOS/mandible-bun': installedFileIdentity(runtime) } };
  fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify(manifest));
  vi.stubEnv('MANDIBLE_HOME', home);
  vi.stubEnv('MANDIBLE_RELEASE_ROOT', '');
  const { reloadLocalFrontDoor } = await import('../scripts/iab-preview.mjs');
  expect(reloadLocalFrontDoor()).toBe('reloaded');
  expect(fs.readFileSync(receipt, 'utf8')).toBe('gateway reloaded by installed controller');
  expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8'))).toEqual(owner);
  fs.unlinkSync(receipt);
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, generation: 'c'.repeat(40) }));
  expect(() => reloadLocalFrontDoor()).toThrow('installed release differs from the service owner');
  expect(fs.existsSync(receipt)).toBe(false);
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, installationId: 'foreign-installation' }));
  expect(() => reloadLocalFrontDoor()).toThrow('another installation authority');
  expect(fs.existsSync(receipt)).toBe(false);
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  fs.unlinkSync(controller);
  expect(() => reloadLocalFrontDoor()).toThrow();
  expect(fs.existsSync(receipt)).toBe(false);
});
