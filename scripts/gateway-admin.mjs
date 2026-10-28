import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

export function gatewayAdminEndpoint(home) {
  if (!path.isAbsolute(home)) throw new Error('Gateway installation home must be absolute.');
  const directory = path.join(home, 'config/local-sessions/admin');
  const socket = path.join(directory, 'caddy.sock');
  if (Buffer.byteLength(socket) > 103) throw new Error('Gateway admin socket exceeds the macOS Unix socket path limit; choose a shorter installation home.');
  return { directory, socket, address: `unix/${socket}|0600` };
}

export function prepareGatewayAdmin(home) {
  const endpoint = gatewayAdminEndpoint(home);
  fs.mkdirSync(endpoint.directory, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(endpoint.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) {
    throw new Error('Gateway admin directory must belong to this account with mode 0700; preserving the existing entry.');
  }
  try {
    const socket = fs.lstatSync(endpoint.socket);
    if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) throw new Error('Gateway admin socket is not an owner-only socket; preserving the existing entry.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return endpoint;
}

export function reloadGatewayConfiguration(binary, home, configFile) {
  const endpoint = prepareGatewayAdmin(home);
  const result = spawnSync(binary, ['reload', '--address', endpoint.address, '--config', configFile, '--adapter', 'caddyfile'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`The trusted dashboard gateway reload failed: ${(result.stderr || result.error?.message || 'unknown failure').trim()}`);
}

/** Capture before rewriting the generated config; an old TCP listener cannot receive a Unix reload. */
export async function gatewayAdminNeedsRestart(home) {
  try {
    const config = fs.readFileSync(path.join(home, 'config/local-sessions/Caddyfile'), 'utf8');
    if (/^\s*admin\s+(?:127\.0\.0\.1:\d+|"127\.0\.0\.1:\d+")\s*$/m.test(config)) return true;
    const endpoint = prepareGatewayAdmin(home);
    return !await new Promise((resolve, reject) => {
      const connection = net.createConnection(endpoint.socket);
      const finish = ready => { connection.destroy(); resolve(ready); };
      connection.once('connect', () => finish(true));
      connection.once('error', error => {
        connection.destroy();
        if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false); else reject(error);
      });
      connection.setTimeout(500, () => finish(false));
    });
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
