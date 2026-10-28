import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { admitRuntimeHandoff, runRuntimeHandoffWorker, runtimeHandoffDrainIdentity, closeQuiescentRuntimeHandoff } from '../../scripts/runtime-handoff.mjs';

const [mode, file] = process.argv.slice(2);
const emit = (event, value = {}) => process.stdout.write(`${JSON.stringify({ event, ...value })}\n`);
const queue = [];
let receive;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { if (receive) { const resolve = receive; receive = null; resolve(line); } else queue.push(line); });
const command = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { receive = resolve; });
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const emitted = new Set();
const once = event => { if (!emitted.has(event)) { emitted.add(event); emit(event); } };

try {
  if (mode === 'predecessor') {
    emit('ready', { pid: process.pid, startedAt: spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500 }).stdout.trim() });
    for (;;) {
      if (await command() === 'exit') break;
      emit('drain', { identity: runtimeHandoffDrainIdentity(read()) });
    }
  } else if (mode === 'producer') {
    const journal = await admitRuntimeHandoff(read(), {
      verifyPublication: async () => {},
      prepare: async () => ({ packageSha256: 'fixture-package', installed: false }),
      bootstrap: async () => {
        emit('bootstrap');
        if (await command() === 'crash') process.exit(17);
      },
      wait: async ms => { once('waiting'); await new Promise(resolve => setTimeout(resolve, ms)); },
    });
    emit('done', { attemptId: journal.attempt.id });
  } else if (mode === 'worker') {
    const journal = await runRuntimeHandoffWorker(file, {
      verifyPublication: async () => {},
      prepare: async () => {
        emit('preparing');
        if (await command() === 'fail') throw new Error('Fixture preparation failed.');
        return { packageSha256: 'fixture-package', installed: false, bundleIdentifier: 'bio.mll.mandible.fixture' };
      },
      control: async (_journal, operation) => { emit('effect', { operation }); return '{}'; },
      install: async () => ({}), desktop: async () => {},
      observe: async () => ({ files: {} }),
      wait: async ms => {
        const journal = read();
        if (journal.drainReady) once('draining');
        else if (fs.existsSync(path.join(journal.binding.home, 'config/local-sessions/.gateway.lock/owner.json'))) once('contended');
        await new Promise(resolve => setTimeout(resolve, ms));
      },
    });
    emit('done', { state: journal.attempt.state });
  } else if (mode === 'close') {
    emit('closed', await closeQuiescentRuntimeHandoff(read().binding.home, { actor: { kind: 'fixture' } }, { fence: async () => {} }));
  } else throw new Error('Unknown fixture mode.');
} catch (error) {
  emit('error', { message: error.message, code: error.code });
  process.exitCode = 1;
} finally {
  input.close();
  process.stdin.destroy();
}
