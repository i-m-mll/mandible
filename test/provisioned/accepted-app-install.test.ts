// @provisioned launchd
// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { retainAcceptedRelease, applicationIdentity, readAcceptedReleaseReceipt } from '../../scripts/accepted-release.mjs';
import { installAcceptedApplication, acceptedInstallPaths } from '../../scripts/accepted-app-install.mjs';
import { installedFileIdentity } from '../../scripts/installed-release.mjs';
import { serviceInstallationContext } from '../../scripts/service-definitions.mjs';
import { readBundleOwner } from '../../scripts/bundle-services.mjs';
import { withLifecycleLock } from '../../scripts/lifecycle-lock.mjs';

it('replaces exact signed apps from source-free custody and disposes only the superseded owner', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-accepted-install-')));
  try {
    const home = path.join(root, 'home'); const app = path.join(root, 'Installed.app');
    const context = serviceInstallationContext({ home, accountHome: root, bundleRoot: app });
    fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
    const authority = path.join(home, 'config/client-auth/authority-id'); fs.writeFileSync(authority, 'preserved-authority');
    const credentials = path.join(home, 'config/client-auth/credentials'); fs.writeFileSync(credentials, 'preserved-credentials');
    fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'legacy'), 'old desktop');
    const initial = applicationIdentity(app);
    let prior: any = null;
    let previousReference = '';
    for (const [index, pin] of ['a', 'b'].entries()) {
      const scratch = path.join(root, `build-${pin}`); const built = path.join(scratch, 'Mandible.app');
      const contents = path.join(built, 'Contents'); const resources = path.join(contents, 'Resources');
      fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(path.join(contents, 'MacOS'));
      fs.copyFileSync('/usr/bin/true', path.join(contents, 'MacOS/mandible-app'));
      fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>bio.mll.mandible.fixture.installer</string><key>CFBundleExecutable</key><string>mandible-app</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
      const program = path.join(resources, 'program'); fs.writeFileSync(program, `accepted ${pin}`);
      const candidate = { pin_sha: pin.repeat(40), tree_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), head_sha: 'e'.repeat(40) };
      fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`,
        layout: { kind: 'macos-app', roots: { resources: '.' } }, provenance: { commit: candidate.pin_sha, source_digest: 'f'.repeat(64) },
        entrypoints: { daemon: 'program' }, native: {}, files: { program: installedFileIdentity(program) } }));
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', built], { timeout: 10_000, stdio: 'pipe' });
      const evidence = path.join(root, `evidence-${pin}`); fs.writeFileSync(evidence, 'passed');
      const reference = await retainAcceptedRelease({ app: built, storage: path.join(root, 'retained'), ownership: { runId: randomUUID(), instanceId: 'fixture', project: 'mandible', workUnit: 'fixture' },
        candidate, acceptance: { record_id: null, request_id: null }, evidence: { receipt: evidence, sha256: installedFileIdentity(evidence).sha256 }, expectedDigest: applicationIdentity(built) });
      fs.rmSync(scratch, { recursive: true });
      const binding: any = { nativeApp: app, requestId: `request-${index}`, executionId: `execution-${index}`, acceptedRelease: { reference }, bundleOwner: prior,
        priorAppSha256: index ? applicationIdentity(app) : initial };
      await withLifecycleLock(home, async () => {
        installAcceptedApplication(binding, context);
        installAcceptedApplication(binding, context);
      });
      const receipt = readAcceptedReleaseReceipt(reference);
      expect(applicationIdentity(app)).toBe(receipt.package.sha256);
      const previous = acceptedInstallPaths(binding).previous;
      expect(applicationIdentity(previous)).toBe(binding.priorAppSha256);
      execFileSync(process.execPath, ['scripts/verify-accepted-release.mjs', reference, JSON.stringify(candidate), app, previous, binding.priorAppSha256, previousReference], { cwd: process.cwd(), timeout: 30_000 });
      expect(fs.existsSync(previous)).toBe(false);
      if (previousReference) {
        const old = readAcceptedReleaseReceipt(previousReference);
        expect(fs.existsSync(old.package.handle.root)).toBe(false);
      }
      expect(fs.readFileSync(authority, 'utf8')).toBe('preserved-authority');
      expect(fs.readFileSync(credentials, 'utf8')).toBe('preserved-credentials');
      prior = readBundleOwner(context); previousReference = reference;
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
