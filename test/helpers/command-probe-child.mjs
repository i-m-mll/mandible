import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [dir, command, ...args] = process.argv.slice(2);
const id = `${process.pid}-${crypto.randomUUID()}`;
const record = { command, args, acknowledged: false, settled: false };
const journal = path.join(dir, `${id}.json`);
const save = () => fs.writeFileSync(journal, JSON.stringify(record));
save();
const socket = net.createConnection(path.join(dir, 'ack.sock'));
const finish = (failure) => {
  record.failure = failure;
  record.settled = true;
  save();
  if (failure) process.stderr.write(`Command probe: ${command}: ${failure}\n`);
  process.exit(failure ? 124 : 0);
};
// A synchronous caller cannot serve the acknowledgement. Never release it on time.
const guard = setTimeout(() => finish('event loop did not acknowledge invocation'), 1000);
socket.on('error', error => finish(error.message));
socket.on('connect', () => socket.write(`${JSON.stringify({ id, command, args })}\n`));
let response = '';
socket.on('data', data => {
  response += data.toString();
  if (!response.endsWith('\n')) return;
  clearTimeout(guard);
  if (response === 'cancel\n') return finish('probe closed before acknowledgement');
  if (response !== 'ack\n') return finish('invalid acknowledgement');
  record.acknowledged = true;
  finish();
});
socket.once('end', () => finish('probe disconnected before acknowledgement'));
