import path from 'node:path';
import { releaseFile } from './installed-release.mjs';

export function daemonPreflightCommand(resources, release, database) {
  if (!path.isAbsolute(database)) throw new Error('Daemon preflight requires the absolute path to an existing database.');
  return {
    binary: releaseFile(resources, release.native.bun, release.layout),
    args: ['--no-install', releaseFile(resources, release.entrypoints.daemon, release.layout), '--preflight', database],
  };
}

export function readDaemonPreflight(stdout) {
  const result = JSON.parse(stdout);
  if (result?.schema !== 'mandible-daemon-preflight@1'
      || result.schemaVersion !== null && !Number.isSafeInteger(result.schemaVersion)) {
    throw new Error('Daemon preflight returned invalid schema evidence.');
  }
  return result;
}
