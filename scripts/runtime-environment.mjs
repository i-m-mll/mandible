import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function runtimeEnvironment({ runtime, root, environment = process.env }) {
  const home = environment.HOME || os.homedir();
  const directories = [path.dirname(runtime), path.join(root, 'bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(environment.CARGO_HOME || path.join(home, '.cargo'), 'bin'),
    ...(environment.PATH || '').split(':')];
  return { ...environment, MANDIBLE_RUNTIME: runtime, GIT_OPTIONAL_LOCKS: '0',
    PATH: [...new Set(directories.filter(directory => path.isAbsolute(directory)))].join(':') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtime, root] = process.argv.slice(2);
  if (!path.isAbsolute(runtime || '') || !path.isAbsolute(root || '')) throw new Error('Exact runtime and checkout paths are required.');
  process.stdout.write(runtimeEnvironment({ runtime, root }).PATH);
}
