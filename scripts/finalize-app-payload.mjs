#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { inventoryRelease } from './stage-app-payload.mjs';

export function assertUnsignedApp(app) {
  if (fs.existsSync(path.join(app, 'Contents/_CodeSignature/CodeResources'))) throw new Error('App is already signed. Assemble a fresh unsigned app; finalized or notarized apps must never be re-signed.');
}

/** Finalize an unsigned Tauri assembly exactly once, before notarization. */
export function finalizeAppPayload(app, signer) {
  assertUnsignedApp(app);
  if (!signer?.identity || typeof signer.sign !== 'function') throw new Error('An explicit resolved app signer is required.');
  const resources = path.join(app, 'Contents/Resources');
  const manifest = path.join(resources, 'release.json');
  const release = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  signer.run('/usr/bin/xattr', ['-cr', app]);
  for (const [role, relative] of Object.entries(release.native)) {
    signer.sign(path.resolve(resources, relative), release.signing[role] ? path.join(resources, release.signing[role]) : null, role !== 'sqlite' && signer.plan.hardenedRuntime);
  }
  const finalized = inventoryRelease(resources, release);
  fs.writeFileSync(manifest, `${JSON.stringify(finalized, null, 2)}\n`);
  let entitlements = signer.plan.entitlements;
  if (entitlements && typeof entitlements !== 'string') {
    entitlements = path.join(signer.temporary, 'app-entitlements.plist');
    fs.writeFileSync(entitlements, JSON.stringify(signer.plan.entitlements));
    signer.run('/usr/bin/plutil', ['-convert', 'xml1', entitlements]);
  }
  signer.sign(app, entitlements);
  return finalized;
}
