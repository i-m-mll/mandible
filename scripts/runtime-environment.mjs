import path from 'node:path';
import os from 'node:os';

export const composePath = directories => [...new Set(directories.filter(directory => path.isAbsolute(directory)))].join(':');

export function runtimeEnvironment({ runtime, root, environment = process.env }) {
  const home = environment.HOME || os.homedir();
  const directories = [path.dirname(runtime), path.join(root, 'bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(environment.CARGO_HOME || path.join(home, '.cargo'), 'bin'),
    ...(environment.PATH || '').split(':')];
  return { ...environment, MANDIBLE_RUNTIME: runtime, GIT_OPTIONAL_LOCKS: '0',
    PATH: composePath(directories) };
}
