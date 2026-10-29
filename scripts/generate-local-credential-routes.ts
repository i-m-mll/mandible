import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredOperationMetadata } from './registered-operation-metadata.js';

export function localCredentialProjection(root = process.cwd()) {
  const files = ['src/server.ts', ...fs.readdirSync(path.join(root, 'src/routes')).filter(name => name.endsWith('.ts')).sort().map(name => `src/routes/${name}`)];
  const entries = registeredOperationMetadata(files.map(file => path.join(root, file)));
  for (const [index, entry] of entries.entries()) {
    if (!/^\/(?:[a-zA-Z0-9_.-]+|:[a-zA-Z0-9_]+)(?:\/(?:[a-zA-Z0-9_.-]+|:[a-zA-Z0-9_]+))*$/.test(entry.path)) {
      throw new Error(`Unsupported route template: ${entry.path}`);
    }
    for (const previous of entries.slice(0, index)) {
      if (previous.method !== entry.method) continue;
      const a = previous.path.split('/'), b = entry.path.split('/');
      const overlap = a.length === b.length && a.every((part, i) => part === b[i] || part.startsWith(':') || b[i].startsWith(':'));
      if (overlap && (previous.file !== entry.file || previous.path === entry.path)) {
        throw new Error(`Unresolved route overlap: ${previous.file} ${previous.path} and ${entry.file} ${entry.path}`);
      }
    }
  }
  return { version: 1, routes: entries.map(entry => ({ method: entry.method.toUpperCase(), path: entry.path, localCliCredential: entry.localCliCredential })) };
}

export function checkLocalCredentialProjection(root = process.cwd()) {
  const expected = JSON.stringify(localCredentialProjection(root), null, 2) + '\n';
  const file = path.join(root, 'cli/local-credential-routes.json');
  if (fs.readFileSync(file, 'utf8') !== expected) throw new Error('Stale CLI credential projection; run bun run generate:local-credential-routes');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) checkLocalCredentialProjection(root);
  else fs.writeFileSync(path.join(root, 'cli/local-credential-routes.json'), JSON.stringify(localCredentialProjection(root), null, 2) + '\n');
}
