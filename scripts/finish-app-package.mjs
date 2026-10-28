import fs from 'node:fs';
import path from 'node:path';
import { finalizeAppPayload, assertUnsignedApp } from './finalize-app-payload.mjs';
import { openAppSigner } from './app-signing.mjs';
import { verifyInstalledRelease, installedFileIdentity } from './installed-release.mjs';

const digest = file => installedFileIdentity(file).sha256;

/** Signing is complete before submission; only Apple's stapler may then change the app. */
export function finishAppPackage(app, plan, { dmg = false, archive = false } = {}) {
  assertUnsignedApp(app);
  for (const stale of [`${app}.packaging.json`, `${app}.zip`, app.replace(/\.app$/, '.dmg')]) fs.rmSync(stale, { force: true });
  const signer = openAppSigner(plan);
  try {
    const release = finalizeAppPayload(app, signer);
    const resources = path.join(app, 'Contents/Resources');
    const sealed = [path.join(resources, 'release.json'), path.join(app, 'Contents/Info.plist'), path.join(app, 'Contents/_CodeSignature/CodeResources')];
    const executable = signer.run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).trim();
    sealed.push(path.join(app, 'Contents/MacOS', executable));
    const beforeNotarization = plan.notarization ? sealed.map(digest) : null;
    let notarization = 'not-requested';
    if (plan.notarization) {
      const submission = path.join(signer.temporary, 'submission.zip');
      signer.run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, submission]);
      const credentials = plan.notarization.kind === 'apple-id'
        ? ['--apple-id', plan.notarization.appleId, '--password', plan.notarization.password, '--team-id', plan.notarization.teamId]
        : ['--key', plan.notarization.key, '--key-id', plan.notarization.keyId, '--issuer', plan.notarization.issuer];
      const result = JSON.parse(signer.run('/usr/bin/xcrun', ['notarytool', 'submit', submission, '--wait', '--timeout', '10m', '--output-format', 'json', ...credentials], { timeout: 660_000 }));
      if (result.status !== 'Accepted') throw new Error(`Apple notarization was not accepted (submission ${result.id ?? 'unknown'}; status ${result.status ?? 'unknown'}). The signed app is preserved without distribution containers.`);
      signer.run('/usr/bin/xcrun', ['stapler', 'staple', app]);
      signer.run('/usr/bin/xcrun', ['stapler', 'validate', app]);
      notarization = 'accepted-and-stapled';
    }
    const signatures = sealed.map(digest);
    if (beforeNotarization && signatures.some((digest, index) => digest !== beforeNotarization[index])) throw new Error('Signed app content changed after finalization. Distribution refused.');
    verifyInstalledRelease(resources);
    signer.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const containers = [];
    if (archive) {
      const output = `${app}.zip`;
      fs.rmSync(output, { force: true });
      signer.run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, output]);
      containers.push({ path: output, sha256: digest(output) });
    }
    if (dmg) {
      const folder = path.join(signer.temporary, 'disk-image');
      fs.mkdirSync(folder);
      signer.run('/usr/bin/ditto', [app, path.join(folder, path.basename(app))]);
      fs.symlinkSync('/Applications', path.join(folder, 'Applications'));
      const output = app.replace(/\.app$/, '.dmg');
      signer.run('/usr/bin/hdiutil', ['create', '-ov', '-format', 'UDZO', '-volname', path.basename(app, '.app'), '-srcfolder', folder, output], { timeout: 180_000 });
      if (signer.identity !== '-') signer.sign(output, null, false);
      containers.push({ path: output, sha256: digest(output) });
    }
    const receipt = { schema: 'mandible-app-package@1', commit: release.provenance.commit, identity: signer.identity,
      notarization, app, manifest_sha256: signatures[0], signature_sha256: signatures[2], containers,
      order: ['tauri-unsigned-assembly', 'native-signatures', 'resource-inventory', 'app-signature', 'notarization-and-stapling', 'distribution-containers'] };
    fs.writeFileSync(`${app}.packaging.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally { signer.close(); }
}
