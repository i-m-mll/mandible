// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { nativeSigningIdentifier, openAppSigner, requireNativeAppSigning, resolveAppSigning, verifyNativeAppSignatures } from '../scripts/app-signing.mjs';
import { finalizeAppPayload } from '../scripts/finalize-app-payload.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('requires an explicit certificate for native qualification while preserving ad-hoc development selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-signing-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ bundle: { macOS: { signingIdentity: '-' } } }));
  const local = resolveAppSigning(root, [], {});
  expect(local.identity).toBe('-');
  expect(() => requireNativeAppSigning(local)).toThrow('Provision an Apple Development');
  expect(() => requireNativeAppSigning(null)).toThrow('requires an Apple-issued signing identity');
  expect(spawnSync).not.toHaveBeenCalled();
  const development = resolveAppSigning(root, [], { APPLE_SIGNING_IDENTITY: 'Apple Development: Fixture' });
  expect(requireNativeAppSigning(development)).toBe(development);
});

it('signs distinct native generations with one certificate and stable first-party identifiers before inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-signing-')); roots.push(root);
  const identifier = 'bio.mll.mandible.fixture.same-installation';
  const identity = 'A'.repeat(40);
  const signatures: Array<{ file: string; identity: string; identifier?: string }> = [];
  const requirements: string[] = [];
  let rejectSignature = false;
  vi.mocked(spawnSync).mockImplementation((program, args = []) => {
    if (program === '/usr/bin/security' && args[0] === 'find-identity') return { status: 0, stdout: `1) ${identity} "Apple Development: Fixture (TEAM)"`, stderr: '' } as any;
    if (program === '/usr/bin/plutil') return { status: 0, stdout: identifier, stderr: '' } as any;
    if (program === '/usr/bin/codesign') {
      if (args[0] === '--display') return { status: 0, stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=FIXTURETEAM\n` } as any;
      if (args[0] === '--verify') {
        requirements.push(String(args[args.indexOf('-R') + 1]));
        return { status: rejectSignature ? 1 : 0, stdout: '', stderr: rejectSignature ? 'code does not satisfy signing requirement' : '' } as any;
      }
      const file = String(args.at(-1));
      signatures.push({ file, identity: String(args[args.indexOf('--sign') + 1]),
        ...(args.includes('--identifier') ? { identifier: String(args[args.indexOf('--identifier') + 1]) } : {}) });
      if (fs.statSync(file).isFile()) fs.appendFileSync(file, '\nsigned fixture bytes');
    } else if (program !== '/usr/bin/xattr') throw new Error(`Unexpected Apple tool: ${program}`);
    return { status: 0, stdout: '', stderr: '' } as any;
  });
  const signer = openAppSigner({ identity: 'Apple Development: Fixture', hardenedRuntime: true, entitlements: null });
  try {
    for (const generation of ['a', 'b']) {
      const app = path.join(root, generation, 'Mandible.app');
      const resources = path.join(app, 'Contents/Resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.mkdirSync(path.join(app, 'Contents/MacOS'));
      fs.writeFileSync(path.join(app, 'Contents/Info.plist'), 'fixture plist');
      const native = { serviceHelper: '../MacOS/mandible-service', trustHelper: '../MacOS/mandible-trust-helper', bun: '../MacOS/mandible-bun' };
      for (const relative of Object.values(native)) fs.writeFileSync(path.resolve(resources, relative), generation);
      fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ native, signing: {} }));
      const finalized = finalizeAppPayload(app, signer);
      for (const relative of Object.values(native)) expect(finalized.files[relative]).toEqual(installedFileIdentity(path.resolve(resources, relative)));
      verifyNativeAppSignatures(app, signer, finalized);
      if (generation === 'b') {
        rejectSignature = true;
        expect(() => verifyNativeAppSignatures(app, signer, finalized)).toThrow('code does not satisfy signing requirement');
      }
    }
  } finally { signer.close(); }
  expect(new Set(signatures.map(item => item.identity))).toEqual(new Set([identity]));
  for (const name of ['mandible-service', 'mandible-trust-helper']) {
    const expected = nativeSigningIdentifier(identifier, name === 'mandible-service' ? 'serviceHelper' : 'trustHelper');
    expect(signatures.filter(item => path.basename(item.file) === name).map(item => item.identifier)).toEqual([expected, expected]);
  }
  expect(signatures.filter(item => path.basename(item.file) === 'Mandible.app').map(item => item.identifier)).toEqual([identifier, identifier]);
  expect(signatures.filter(item => path.basename(item.file) === 'mandible-bun').every(item => item.identifier === undefined)).toBe(true);
  expect(requirements.slice(0, 4)).toEqual([identifier, `${identifier}.service`, identifier, `${identifier}.service`].map(id =>
    `=anchor apple generic and certificate leaf = H"${identity}" and certificate leaf[subject.OU] = "FIXTURETEAM" and identifier "${id}"`));
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '0 valid identities found', stderr: '' } as any);
  expect(() => openAppSigner({ identity: 'Apple Development: Missing' })).toThrow('Provision the selected Apple Development');
});
