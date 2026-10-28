#!/usr/bin/env bun
import fs from 'node:fs';
import { resolveAcceptedRelease, applicationIdentity, disposeAcceptedRelease, readAcceptedReleaseReceipt } from './accepted-release.mjs';
import { ownedRunReceipt } from './owned-run.mjs';

const [reference, candidateJson, installed, previous, previousHash, superseded, mode = 'verify'] = process.argv.slice(2);
if (!['verify', 'cleanup'].includes(mode)) throw new Error('Unknown accepted-release operation.');
const candidate = candidateJson ? JSON.parse(candidateJson) : undefined;
// Acknowledgment has already verified the current retained and installed app.
// Cleanup checks only the exact objects it deletes; it never mutates that app.
const accepted = mode === 'cleanup' ? { receipt: readAcceptedReleaseReceipt(reference, candidate) } : resolveAcceptedRelease(reference, candidate);
if (mode === 'verify' && installed && applicationIdentity(installed) !== accepted.receipt.package.sha256) throw new Error('Installed application differs from the exact accepted package.');
if (previous && fs.existsSync(previous)) {
  if (applicationIdentity(previous) !== previousHash) throw new Error('Previous application custody changed.');
  fs.rmSync(previous, { recursive: true });
}
if (superseded) {
  const old = readAcceptedReleaseReceipt(superseded);
  if (ownedRunReceipt(old.package.handle)?.cleanup !== 'completed') {
    const result = await disposeAcceptedRelease(superseded, old.candidate, `Superseded by ${accepted.receipt.acceptance.run_id}`);
    if (result.action !== 'delete-owned' || result.remaining?.length) throw new Error('Superseded package cleanup is incomplete.');
  }
}
process.stdout.write(`${JSON.stringify({ packageSha256: accepted.receipt.package.sha256 })}\n`);
