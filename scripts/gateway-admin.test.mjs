import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { gatewayCaddyfile } from './gateway-config.mjs';
import { prepareGatewayAdmin, gatewayAdminNeedsRestart, reloadGatewayConfiguration } from './gateway-admin.mjs';
import { pinnedCaddyBinary } from './pinned-caddy.mjs';
import { acceptanceGatewayConfig } from './candidate-acceptance.mjs';
import { setupCaddyfile } from './local-ca-trust.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() { const server = net.createServer(); const port = await listen(server); await close(server); return port; }
async function until(check) {
  const deadline = Date.now() + 5000;
  let error;
  do { try { if (await check()) return; } catch (observed) { error = observed; } await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw error || new Error('Private gateway did not converge.');
}

test('migrates an owned TCP gateway to private admin, then reloads HTTPS main/preview routes over Unix', async () => {
  const binary = pinnedCaddyBinary(path.join(os.userInfo().homedir, '.mandible'));
  assert.ok(fs.existsSync(binary), 'Provision the pinned Caddy before this explicit native contract.');
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mandible gw-'));
  const endpoint = prepareGatewayAdmin(home);
  const storageRoot = path.join(home, 'storage');
  const config = path.join(home, 'config/local-sessions/Caddyfile');
  const authTargets = [];
  const backend = label => http.createServer((request, response) => {
    if (request.url === '/api/client-auth/forward-auth') {
      authTargets.push(request.headers['x-mandible-target-instance']);
      response.setHeader('X-Mandible-Session-Context', 'fixture-session'); response.end();
    } else response.end(label);
  });
  const first = backend('first'); const second = backend('second');
  const preview = http.createServer((request, response) => response.end(request.headers['x-mandible-session-context'] || 'missing context'));
  let gateway;
  let ca;
  let output = '';
  const start = () => {
    gateway = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], { env: { HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(home, 'xdg') }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  };
  const stop = async () => {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGTERM'); await new Promise(resolve => gateway.once('exit', resolve)); }
  };
  try {
    const firstPort = await listen(first), secondPort = await listen(second), previewPort = await listen(preview);
    const ports = new Set(); while (ports.size < 3) ports.add(await freePort());
    const [publicPort, publicPreviewPort, legacyAdminPort] = [...ports];
    const instances = [
      { role: 'main', instance_id: 'production', public_origin: `https://app.mandible.localhost:${publicPort}`, backend_origin: `http://127.0.0.1:${firstPort}` },
      { role: 'preview', instance_id: 'fixture-preview', public_origin: `https://preview-fixture.mandible.localhost:${publicPreviewPort}`, backend_origin: `http://127.0.0.1:${previewPort}` },
    ];
    const write = address => fs.writeFileSync(config, gatewayCaddyfile(instances, { storageRoot, adminAddress: address }), { mode: 0o600 });
    const get = (port, hostname) => new Promise((resolve, reject) => {
      const request = https.get({ hostname: '127.0.0.1', port, servername: hostname, headers: { Host: `${hostname}:${port}` },
        ca: ca ??= fs.readFileSync(path.join(storageRoot, 'pki/authorities/local/root.crt')), agent: false }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body));
      });
      request.on('error', reject); request.setTimeout(500, () => request.destroy(new Error('Private TLS response timed out')));
    });
    write(`127.0.0.1:${legacyAdminPort}`); start();
    await until(async () => (await get(publicPort, 'app.mandible.localhost')) === 'first');
    assert.equal(await gatewayAdminNeedsRestart(home), true);
    write(endpoint.address);
    assert.equal(await gatewayAdminNeedsRestart(home), true, 'An interrupted rewrite still requires owned restart while the new endpoint is absent');
    await stop(); start();
    await until(async () => (await get(publicPreviewPort, 'preview-fixture.mandible.localhost')) === 'fixture-session');
    assert.equal(await gatewayAdminNeedsRestart(home), false);
    assert.equal(fs.statSync(endpoint.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(endpoint.socket).mode & 0o777, 0o600);
    const listeners = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(gateway.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 2500 });
    assert.equal(listeners.status, 0);
    assert.ok(!listeners.stdout.includes(`:${legacyAdminPort}\n`) && !listeners.stdout.includes(':2019\n'), 'The private process must have no TCP admin listener');
    const pid = gateway.pid;
    instances[0].backend_origin = `http://127.0.0.1:${secondPort}`;
    write(endpoint.address);
    reloadGatewayConfiguration(binary, home, config);
    assert.equal(await get(publicPort, 'app.mandible.localhost'), 'second');
    assert.equal(await get(publicPreviewPort, 'preview-fixture.mandible.localhost'), 'fixture-session');
    assert.equal(gateway.pid, pid); assert.ok(authTargets.length > 0 && authTargets.every(target => target === 'fixture-preview'));
    await stop();
    fs.writeFileSync(config, acceptanceGatewayConfig({ origin: instances[0].public_origin, backendPort: secondPort, storageRoot }));
    start();
    await until(async () => (await get(publicPort, 'app.mandible.localhost')) === 'second');
    assert.equal(await gatewayAdminNeedsRestart(home), true, 'The disabled acceptance admin must not accept Unix connections, even if Caddy left a stale socket entry');
    const temporary = spawnSync(binary, ['adapt', '--config', '-', '--adapter', 'caddyfile'], {
      input: setupCaddyfile(storageRoot, publicPort), encoding: 'utf8', timeout: 2500,
    });
    assert.equal(temporary.status, 0); assert.equal(JSON.parse(temporary.stdout).admin.disabled, true);
  } catch (error) { error.message += `\nPrivate gateway log: ${output}`; throw error; }
  finally { await stop(); await Promise.all([close(first), close(second), close(preview)]); fs.rmSync(home, { recursive: true, force: true }); }
});

test('refuses an unsafe admin directory or substituted socket without replacing it', () => {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mandible-gw-'));
  try {
    const endpoint = prepareGatewayAdmin(home);
    fs.chmodSync(endpoint.directory, 0o755);
    assert.throws(() => prepareGatewayAdmin(home), /0700/);
    fs.chmodSync(endpoint.directory, 0o700);
    fs.writeFileSync(endpoint.socket, 'preserve');
    assert.throws(() => prepareGatewayAdmin(home), /owner-only socket/);
    assert.equal(fs.readFileSync(endpoint.socket, 'utf8'), 'preserve');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('finishes local responses but bounds open main/preview streams during graceful shutdown', { timeout: 10000 }, async () => {
  const binary = pinnedCaddyBinary(path.join(os.userInfo().homedir, '.mandible'));
  assert.ok(fs.existsSync(binary), 'Provision the pinned Caddy before this explicit native contract.');
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mandible-gw-drain-'));
  const storageRoot = path.join(home, 'storage');
  const clients = [];
  const agents = [];
  let pendingResponse;
  let pendingReached;
  const pending = new Promise(resolve => { pendingReached = resolve; });
  const backend = http.createServer((request, response) => {
    if (request.url === '/api/client-auth/forward-auth') response.end();
    else if (request.url === '/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: connected\n\n');
    } else if (request.url === '/pending') { pendingResponse = response; pendingReached(); }
    else response.end('ready');
  });
  let gateway;
  let deadline;
  let output = '';
  try {
    const backendPort = await listen(backend);
    const ports = new Set(); while (ports.size < 2) ports.add(await freePort());
    const [mainPort, previewPort] = [...ports];
    const instances = [
      { role: 'main', instance_id: 'production', public_origin: `https://app.mandible.localhost:${mainPort}`, backend_origin: `http://127.0.0.1:${backendPort}` },
      { role: 'preview', instance_id: 'drain-preview', public_origin: `https://preview-drain.mandible.localhost:${previewPort}`, backend_origin: `http://127.0.0.1:${backendPort}` },
    ];
    const config = path.join(home, 'Caddyfile');
    const endpoint = prepareGatewayAdmin(home);
    fs.writeFileSync(config, gatewayCaddyfile(instances, { storageRoot, adminAddress: endpoint.address }));
    for (const text of [fs.readFileSync(config, 'utf8'), acceptanceGatewayConfig({ origin: instances[0].public_origin, backendPort, storageRoot }), setupCaddyfile(storageRoot, mainPort)]) {
      const adapted = spawnSync(binary, ['adapt', '--config', '-', '--adapter', 'caddyfile'], { input: text, encoding: 'utf8', timeout: 2500 });
      assert.equal(adapted.status, 0, adapted.stderr);
      assert.equal(JSON.parse(adapted.stdout).apps.http.grace_period, 1e9, 'Every generated HTTP server shares the connection grace policy');
    }
    gateway = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], {
      env: { HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(home, 'xdg') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => gateway.once('exit', (code, signal) => resolve({ code, signal })));
    let beganGrace;
    const grace = new Promise(resolve => { beganGrace = resolve; });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => {
      output = (output + chunk).slice(-16000);
      if (output.includes('servers shutting down; grace period initiated')) beganGrace();
    });
    const request = (entry, route, agent = false) => new Promise((resolve, reject) => {
      const url = new URL(entry.public_origin);
      const client = https.get({ hostname: '127.0.0.1', port: url.port, servername: url.hostname, headers: { Host: url.host },
        path: route, ca: fs.readFileSync(path.join(storageRoot, 'pki/authorities/local/root.crt')), agent }, resolve);
      clients.push(client); client.on('error', reject);
    });
    const body = async response => { let text = ''; for await (const chunk of response) text += chunk; return text; };
    await until(async () => (await body(await request(instances[0], '/ready'))) === 'ready');
    const streams = [];
    const streamErrors = [];
    const idleSockets = [];
    for (const entry of instances) {
      const agent = new https.Agent({ keepAlive: true }); agents.push(agent);
      const idle = await request(entry, '/ready', agent); idleSockets.push(idle.socket);
      assert.equal(await body(idle), 'ready');
      const stream = await request(entry, '/stream'); streams.push(stream);
      stream.on('error', error => streamErrors.push(error));
      await once(stream, 'data');
    }
    const response = request(instances[0], '/pending').then(body);
    await pending;
    const started = performance.now();
    deadline = setTimeout(() => gateway.kill('SIGKILL'), 4000);
    gateway.kill('SIGTERM');
    await grace;
    pendingResponse.end('completed');
    assert.equal(await response, 'completed', 'A finite in-flight response can finish during grace');
    assert.deepEqual(await exited, { code: 0, signal: null }, output);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 3000, `Graceful shutdown took ${elapsedMs}ms`);
    await until(() => streams.every(stream => stream.destroyed) && idleSockets.every(socket => socket.destroyed));
    assert.ok(streamErrors.every(error => error.code === 'ECONNRESET'), 'Only connection closure errors are expected on interrupted streams');
    const shutdown = output.trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.signal === 'SIGTERM' || row.msg === 'servers shutting down; grace period initiated' || row.msg === 'server shutdown');
    console.log(JSON.stringify({ contract: 'gateway-connection-shutdown', graceMs: 1000, elapsedMs: Math.round(elapsedMs),
      idleConnections: idleSockets.length, activeStreams: streams.length, finiteResponse: 'completed', exitCode: 0, shutdown }));
  } catch (error) { error.message += `\nPrivate gateway log: ${output}`; throw error; }
  finally {
    clearTimeout(deadline);
    for (const client of clients) client.destroy();
    for (const agent of agents) agent.destroy();
    if (gateway?.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGKILL'); await once(gateway, 'exit'); }
    backend.closeAllConnections(); await close(backend);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
