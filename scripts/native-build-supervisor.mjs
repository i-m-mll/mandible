import { spawn } from 'node:child_process';
import { nativeProcessGroupMembers } from './native-process-group.mjs';

const { command, args } = JSON.parse(process.argv[2]);
const child = spawn(command, args, { stdio: 'inherit' });
const outcome = await new Promise(resolve => {
  child.once('error', error => { console.error(error); resolve({ code: 1 }); });
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const descendants = nativeProcessGroupMembers(process.pid).filter(pid => pid !== process.pid);
if (descendants.length) {
  console.error(`Native build command left ${descendants.length} active descendants; terminating its owned process group`);
  process.kill(-process.pid, 'SIGKILL');
}
if (outcome.signal) console.error(`Native build command terminated with ${outcome.signal}`);
process.exitCode = outcome.code ?? 1;
