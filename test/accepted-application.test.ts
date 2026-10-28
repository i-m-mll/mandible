// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../scripts/bundle-services.mjs', async original => ({
  ...await original<typeof import('../scripts/bundle-services.mjs')>(), adoptBundleRelease: vi.fn(),
}));
import { applicationIdentity } from '../scripts/accepted-release.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { applicationRootIdentity, prepareAcceptedApplication, preparedApplicationContext, installAcceptedApplication } from '../scripts/accepted-app-install.mjs';
import { withInstallationGatewayLock } from '../scripts/lifecycle-lock.mjs';
import { verifyUpdaterClosure } from '../scripts/runtime-handoff.mjs';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-application-'))); roots.push(root);
  const retained = path.join(root, 'accepted/package');
  const app = path.join(retained, 'Mandible.app');
  const resources = path.join(app, 'Contents/Resources');
  const inputs = ['handoff/helper.mjs', '../MacOS/mandible-bun', '../Frameworks/libsqlite3.dylib', 'program'];
  for (const relative of inputs) { const file = path.resolve(resources, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative); }
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>bio.mll.mandible.fixture</string></dict></plist>');
  const shipped = { schema: 'mandible-installed-release@1', version: 'test', target: `${process.platform}-${process.arch}`,
    layout: { kind: 'macos-app', roots: { resources: '.', executable: '../MacOS', libraries: '../Frameworks' } },
    provenance: { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) }, entrypoints: { daemon: 'program' },
    native: { bun: '../MacOS/mandible-bun', sqlite: '../Frameworks/libsqlite3.dylib' },
    files: Object.fromEntries(inputs.map(relative => [relative, installedFileIdentity(path.resolve(resources, relative))])) };
  fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify(shipped));
  const evidence = path.join(root, 'evidence.json'); fs.writeFileSync(evidence, '{}');
  const receipt = { schema: 'mandible-accepted-release@1', candidate: { pin_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40), head_sha: 'd'.repeat(40) },
    acceptance: { run_id: 'package' }, retention: { project: 'test', work_unit: 'test' }, target: shipped.target, shipped,
    package: { custody: 'owned-run', path: 'Mandible.app', handle: { root: retained, runId: 'package' }, sha256: applicationIdentity(app) },
    evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 } };
  const file = path.join(root, 'accepted/.receipts/package-accepted-release.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(receipt); fs.writeFileSync(file, bytes);
  const reference = `accepted-release:${createHash('sha256').update(bytes).digest('hex')}:${Buffer.from(file).toString('base64url')}`;
  const nativeApp = path.join(root, 'installed/Mandible.app'); fs.mkdirSync(nativeApp, { recursive: true }); fs.writeFileSync(path.join(nativeApp, 'old'), 'prior software');
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, 'config/local-sessions'), { recursive: true });
  const binding = { home, requestId: 'request-fixture', executionId: 'execution-fixture', nativeApp,
    priorAppIdentity: applicationRootIdentity(nativeApp), bundleOwner: null, acceptedRelease: { reference } };
  const context = { home, runtimeDir: path.join(home, 'config/local-sessions'), bundleRoot: nativeApp, bundleIdentifier: 'bio.mll.mandible.fixture' };
  return { root, app, resources, receipt, reference, binding, context, inputs };
}

it('carries prepared authority through exchange without rereading app bytes, expires on lease loss, and revalidates the installed target on resume', async () => {
  const f = fixture();
  let prepared: any;
  await withInstallationGatewayLock(f.binding.home, (_token, assertHeld) => {
    prepared = prepareAcceptedApplication(f.binding, { attemptId: 'attempt-one', assertHeld });
    const originalRead = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: any[]) => {
      if (typeof args[0] === 'string' && (args[0].startsWith(prepared.staging) || args[0].startsWith(f.binding.nativeApp))) throw new Error('Application bytes were read twice.');
      return Reflect.apply(originalRead, fs, args);
    });
    fs.writeFileSync(path.join(f.binding.nativeApp, 'old'), 'obsolete content is not an installation identity');
    installAcceptedApplication(f.binding, f.context, { prepared });
    expect(preparedApplicationContext(prepared, f.binding)).toMatchObject({ installed: true, app: f.binding.nativeApp, digest: f.receipt.package.sha256 });
    expect(fs.existsSync(prepared.previous)).toBe(true);
    read.mockRestore();
  });
  expect(() => preparedApplicationContext(prepared, f.binding)).toThrow();
  fs.writeFileSync(path.join(f.binding.nativeApp, 'Contents/Resources/program'), 'changed after lease');
  await withInstallationGatewayLock(f.binding.home, (_token, assertHeld) => {
    expect(() => prepareAcceptedApplication(f.binding, { attemptId: 'attempt-one', assertHeld, phase: 'installed' })).toThrow('differs from the exact accepted package');
  });
});

it('refuses substituted stage roots and every executable-closure input while leaving unrelated payload to the staged digest', async () => {
  const f = fixture();
  expect(verifyUpdaterClosure(f.reference).app).toBe(f.app);
  for (const relative of f.inputs.filter(file => file !== 'program')) {
    const file = path.resolve(f.resources, relative); const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'substituted');
    expect(() => verifyUpdaterClosure(f.reference), relative).toThrow('closure changed');
    fs.writeFileSync(file, original);
  }
  fs.writeFileSync(path.join(f.resources, 'program'), 'substituted payload');
  expect(verifyUpdaterClosure(f.reference).app).toBe(f.app);
  await withInstallationGatewayLock(f.binding.home, (_token, assertHeld) => {
    expect(() => prepareAcceptedApplication(f.binding, { attemptId: 'attempt-one', assertHeld })).toThrow('differs from the exact accepted package');
    fs.rmSync(path.join(f.root, 'installed/.Mandible-request-fixture-execution-fixture.staging.app'), { recursive: true });
    fs.writeFileSync(path.join(f.resources, 'program'), 'program');
    const prepared = prepareAcceptedApplication(f.binding, { attemptId: 'attempt-one', assertHeld });
    fs.renameSync(prepared.staging, `${prepared.staging}.old`); fs.mkdirSync(prepared.staging);
    expect(() => installAcceptedApplication(f.binding, f.context, { prepared })).toThrow('root ownership changed');
    expect(fs.readFileSync(path.join(f.binding.nativeApp, 'old'), 'utf8')).toBe('prior software');
  });
});
