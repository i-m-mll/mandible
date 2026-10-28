import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAppSigning, openAppSigner } from './app-signing.mjs';

test('Tauri configuration scopes select the signer without an ad-hoc downgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-signing-config-'));
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ bundle: { macOS: { signingIdentity: 'Developer ID Application: Configured' } } }));
    assert.equal(resolveAppSigning(root, [], {}).identity, 'Developer ID Application: Configured');
    fs.writeFileSync(path.join(root, 'src-tauri/tauri.macos.conf.json5'), "{bundle:{macOS:{signingIdentity:'Developer ID Application: Platform'}}}");
    fs.writeFileSync(path.join(root, 'release.toml'), '[bundle.macOS]\nsigningIdentity = "Developer ID Application: Release"\n');
    assert.equal(resolveAppSigning(root, ['release.toml'], {}).identity, 'Developer ID Application: Release');
    assert.equal(resolveAppSigning(root, ['release.toml'], { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Environment' }).identity, 'Developer ID Application: Environment');
    assert.throws(() => resolveAppSigning(root, ['{"bundle":{"macOS":{"signingIdentity":null}}}'], {}), /explicit.*signingIdentity/);
    assert.throws(() => resolveAppSigning(root, [], { APPLE_SIGNING_IDENTITY: '' }), /explicit.*signingIdentity/);
    assert.throws(() => resolveAppSigning(root, [], { APPLE_SIGNING_IDENTITY: '-', APPLE_ID: 'configured', APPLE_PASSWORD: 'configured', APPLE_TEAM_ID: 'configured' }), /Ad-hoc signing/);
    assert.throws(() => resolveAppSigning(root, [], { APPLE_ID: 'incomplete' }), /requires APPLE_ID/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unavailable configured distributor certificate fails using the real keychain', { skip: process.platform !== 'darwin' }, () => {
  assert.throws(() => openAppSigner({ identity: 'Developer ID Application: Mandible missing certificate fixture 8F21B96D', hardenedRuntime: true }), /configured signing identity.*exactly one/);
});
