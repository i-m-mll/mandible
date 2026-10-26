import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface RunFixtureDescriptor {
  file: string;
  manifest: string;
  label: string;
  identity: Record<string, string | number>;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function prepareRunFixture(root: string, descriptor: RunFixtureDescriptor, bytes: Uint8Array): void {
  fs.writeFileSync(path.join(root, descriptor.file), bytes, { flag: 'wx', mode: 0o400 });
  fs.writeFileSync(path.join(root, descriptor.manifest), JSON.stringify({
    ...descriptor.identity, root: fs.realpathSync(root), sha256: digest(bytes),
  }), { flag: 'wx', mode: 0o400 });
}

export function readRunFixture(root: string | undefined, descriptor: RunFixtureDescriptor): Buffer {
  if (!root) throw new Error('Missing test run root; start Vitest through scripts/run-vitest.js.');
  const manifestPath = path.join(root, descriptor.manifest);
  const filename = path.join(root, descriptor.file);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(filename)) {
    throw new Error(`Missing run-scoped ${descriptor.label}; start Vitest through scripts/run-vitest.js.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bytes = fs.readFileSync(filename);
  if (manifest.root !== fs.realpathSync(root) || manifest.sha256 !== digest(bytes)
      || Object.entries(descriptor.identity).some(([key, value]) => manifest[key] !== value)) {
    throw new Error(`Run-scoped ${descriptor.label} does not match this run, identity, or snapshot bytes.`);
  }
  return bytes;
}
