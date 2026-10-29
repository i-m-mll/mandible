// @vitest-environment node
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const signing = vi.hoisted(() => ({ app: '', tamper: false, verified: [] as boolean[] }));
vi.mock('../scripts/app-signing.mjs', async original => ({
  ...await original<typeof import('../scripts/app-signing.mjs')>(),
  openAppSigner: (plan: any) => ({
    identity: 'a'.repeat(40), temporary: path.dirname(signing.app), plan,
    sign: (file: string) => {
      if (file === signing.app) {
        fs.mkdirSync(path.join(file, 'Contents/_CodeSignature'));
        fs.writeFileSync(path.join(file, 'Contents/_CodeSignature/CodeResources'), 'signed');
      } else fs.appendFileSync(file, '-signed');
    },
    run: (command: string, args: string[]) => {
      if (command.endsWith('plutil')) return args[1] === 'CFBundleIdentifier' ? 'bio.mll.mandible.fixture' : 'mandible-app';
      if (args[0] === 'notarytool') return JSON.stringify({ status: 'Accepted' });
      if (args[0] === 'stapler' && args[1] === 'staple') {
        fs.writeFileSync(path.join(signing.app, 'Contents/ticket'), 'ticket');
        if (signing.tamper) fs.appendFileSync(path.join(signing.app, 'Contents/MacOS/mandible-app'), '-changed');
      }
      if (command.endsWith('codesign') && args[0] === '--display') return 'Identifier=bio.mll.mandible.fixture\nTeamIdentifier=FIXTURETEAM\n';
      if (command.endsWith('codesign') && args.includes('--deep')) signing.verified.push(fs.existsSync(path.join(signing.app, 'Contents/ticket')));
      return '';
    }, close: () => {},
  }),
}));
import { finishAppPackage } from '../scripts/finish-app-package.mjs';
import { verifyInstalledRelease } from '../scripts/installed-release.mjs';

it('validates the final signed package after optional stapling and refuses changed sealed bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-finalization-'));
  try {
    for (const [name, notarization, tamper] of [['signed', false, false], ['stapled', true, false], ['changed', true, true]] as const) {
      signing.app = path.join(root, `${name}.app`); signing.tamper = tamper; signing.verified = [];
      const resources = path.join(signing.app, 'Contents/Resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.mkdirSync(path.join(signing.app, 'Contents/MacOS'));
      fs.writeFileSync(path.join(signing.app, 'Contents/Info.plist'), 'fixture');
      fs.writeFileSync(path.join(signing.app, 'Contents/MacOS/mandible-app'), 'app');
      fs.writeFileSync(path.join(signing.app, 'Contents/MacOS/mandible-service'), 'helper');
      fs.writeFileSync(path.join(resources, 'program'), 'program');
      fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: 'fixture',
        target: `${process.platform}-${process.arch}`, provenance: { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) },
        layout: { kind: 'macos-app', roots: { resources: '.', executable: '../MacOS' } }, entrypoints: { daemon: 'program' }, native: { serviceHelper: '../MacOS/mandible-service' }, signing: {}, files: {} }));
      const plan = { identity: 'fixture', notarization: notarization ? { kind: 'apple-id' } : null };
      if (tamper) {
        expect(() => finishAppPackage(signing.app, plan)).toThrow('Signed app content changed');
        expect(fs.existsSync(`${signing.app}.packaging.json`)).toBe(false);
      } else {
        expect(finishAppPackage(signing.app, plan).notarization).toBe(notarization ? 'accepted-and-stapled' : 'not-requested');
        expect(signing.verified).toEqual([notarization]);
        expect(verifyInstalledRelease(resources).provenance.commit).toBe('a'.repeat(40));
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
