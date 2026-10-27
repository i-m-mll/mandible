#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inventoryRelease } from './stage-app-payload.mjs';
import { verifyInstalledRelease } from './installed-release.mjs';

/** Call after Tauri signs nested code and before acceptance or distribution. */
export function finalizeAppPayload(app, identity = process.env.APPLE_SIGNING_IDENTITY || '-') {
  const resources = path.join(app, 'Contents/Resources');
  const manifest = path.join(resources, 'release.json');
  const release = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const [role, entitlements] of Object.entries(release.signing)) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--preserve-metadata=identifier',
      '--entitlements', path.join(resources, entitlements), path.resolve(resources, release.native[role])], { timeout: 60_000, stdio: 'inherit' });
  }
  fs.writeFileSync(manifest, `${JSON.stringify(inventoryRelease(resources, release), null, 2)}\n`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', app], { timeout: 60_000, stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60_000, stdio: 'inherit' });
  return verifyInstalledRelease(resources);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: finalize-app-payload.mjs /path/to/Mandible.app');
  const release = finalizeAppPayload(path.resolve(process.argv[2]));
  process.stdout.write(`${release.provenance.commit}\n`);
}
