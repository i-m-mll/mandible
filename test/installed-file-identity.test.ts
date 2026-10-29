import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

it('hashes exact fresh bytes across multi-chunk, short, empty, and replaced files', () => {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'file-identity-'));
  const file = path.join(root, 'program');
  const large = Buffer.alloc(2 * 1024 * 1024 + 37);
  for (let index = 0; index < large.length; index++) large[index] = (index * 13 + (index >>> 16)) & 255;
  try {
    for (const bytes of [Buffer.alloc(0), large, Buffer.from('abc'), Buffer.alloc(0)]) {
      fs.writeFileSync(file, bytes);
      expect(installedFileIdentity(file)).toEqual({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
    const replacement = path.join(root, 'replacement');
    fs.writeFileSync(replacement, 'abc');
    fs.renameSync(replacement, file);
    expect(installedFileIdentity(file)).toEqual({
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      size: 3,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
