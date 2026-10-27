import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Portable grammar renderer runtime for cache-mounted clients, separate from host-native execution. */
export function stageCoworkRuntime(root, resources) {
  const target = path.join(resources, 'cowork-runtime');
  for (const relative of ['.bun-version', 'scripts/bun-runtime.sh', 'scripts/bun-runtime-lock.tsv']) {
    fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(target, relative));
  }
  const cache = path.join(os.homedir(), '.cache/mandible/package-tools/bun');
  fs.mkdirSync(cache, { recursive: true });
  for (const line of fs.readFileSync(path.join(root, 'scripts/bun-runtime-lock.tsv'), 'utf8').split('\n')) {
    const [platform, asset, expected, , url] = line.split('\t');
    if (!platform?.startsWith('Linux-') && platform !== `Darwin-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`) continue;
    const archive = path.join(cache, `${expected}.zip`);
    if (!fs.existsSync(archive)) {
      const temporary = `${archive}.${process.pid}`;
      try {
        execFileSync('/usr/bin/curl', ['-fsSL', '--max-time', '60', url, '-o', temporary], { timeout: 60_000 });
        const hash = createHash('sha256').update(fs.readFileSync(temporary)).digest('hex');
        if (hash !== expected) throw new Error(`Projected Bun archive checksum mismatch: ${asset}`);
        fs.renameSync(temporary, archive);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (hash !== expected) throw new Error(`Projected Bun archive checksum mismatch: ${asset}`);
    fs.mkdirSync(path.join(target, 'runtime'), { recursive: true });
    fs.copyFileSync(archive, path.join(target, 'runtime', `${asset}.zip`));
  }
}
