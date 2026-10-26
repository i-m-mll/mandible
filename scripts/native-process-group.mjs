import { spawnSync } from 'node:child_process';

export function nativeProcessGroupMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('Invalid native process group');
  const listed = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000 });
  if (listed.error || listed.status !== 0) throw new Error(`Cannot inspect native process group: ${listed.error?.message ?? listed.stderr}`);
  return listed.stdout.trim().split('\n').flatMap(line => {
    const [pid, group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && Number(pid) !== listed.pid && !state.startsWith('Z') ? [Number(pid)] : [];
  });
}
