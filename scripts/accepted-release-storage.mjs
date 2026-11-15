import path from 'node:path';

export const ACCEPTED_RELEASE_DIRECTORY = 'accepted-releases';
export const VERSIONED_RELEASE_DIRECTORY = '.v2';

export function isVersionedReleaseStorage(storage) {
  return path.basename(storage) === VERSIONED_RELEASE_DIRECTORY && path.basename(path.dirname(storage)) === ACCEPTED_RELEASE_DIRECTORY;
}
