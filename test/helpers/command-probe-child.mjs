import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [dir, command, executable, ...args] = process.argv.slice(2);
const id = `${process.pid}-${crypto.randomUUID()}`;
const record = { command, args, acknowledged: false };
const journal = path.join(dir, `${id}.json`);
const save = () => fs.writeFileSync(journal, JSON.stringify(record));
save();
const socket = net.createConnection(path.join(dir, 'ack.sock'));
const fail = (reason) => {
  record.failure = reason;
  save();
  process.stderr.write(`Command probe: ${command}: ${reason}\n`);
  process.exit(124);
};
// A synchronous caller cannot serve the acknowledgement. Never release it on time.
const guard = setTimeout(() => fail('event loop did not acknowledge invocation'), 1000);
socket.on('error', error => fail(error.message));
socket.on('connect', () => socket.write(`${JSON.stringify({ id, command, args })}\n`));
let response = '';
socket.on('data', data => {
  response += data.toString();
  if (!response.endsWith('\n')) return;
  if (response !== 'ack\n') return fail('invalid acknowledgement');
  clearTimeout(guard);
  record.acknowledged = true;
  save();
  socket.end();
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.once('error', error => fail(error.message));
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code);
  });
});
socket.once('end', () => {
  if (!record.acknowledged) fail('probe closed before acknowledgement');
});
