// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { acceptanceGatewayConfig, acceptanceHealth, awaitAcceptanceGatewayReadiness, awaitReadiness, copyAcceptanceCa, loopbackListening } from '../../scripts/candidate-acceptance.mjs';
import { pinnedCaddyBinary } from '../../scripts/pinned-caddy.mjs';
import { STATE_DEADLINE_MS } from '../helpers/wait-until.js';

it.each(['cold', 'cached'])('validates the private HTTPS gateway with a %s leaf cache', async leaf => {
  const operatorHome = execFileSync('/bin/sh', ['-c', 'eval "printf %s ~$(id -un)"'], { encoding: 'utf8', timeout: STATE_DEADLINE_MS });
  const sourceHome = path.join(operatorHome, '.mandible');
  const binary = pinnedCaddyBinary(sourceHome);
  if (!fs.existsSync(binary)) throw new Error('Gateway readiness prerequisite missing: installed pinned Caddy.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-gateway-readiness-'));
  const home = path.join(scratch, 'home');
  const backend = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true }));
  });
  let gateway: ReturnType<typeof spawn> | undefined;
  let fd: number | undefined;
  try {
    const ca = copyAcceptanceCa(sourceHome, home);
    if (leaf === 'cold') fs.rmSync(path.join(ca.storageRoot, 'certificates'), { recursive: true, force: true });
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    const ports = new Set<number>();
    while (ports.size < 2) {
      const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      ports.add((listener.address() as net.AddressInfo).port); await new Promise<void>(resolve => listener.close(() => resolve()));
    }
    const [publicPort, adminPort] = [...ports];
    const origin = `https://app.mandible.localhost:${publicPort}`;
    const config = path.join(scratch, 'Caddyfile');
    fs.writeFileSync(config, acceptanceGatewayConfig({ origin, backendPort: (backend.address() as net.AddressInfo).port, adminPort, storageRoot: ca.storageRoot }));
    const log = path.join(scratch, 'gateway.log'); fd = fs.openSync(log, 'w');
    gateway = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], {
      env: { ...process.env, HOME: home, MANDIBLE_HOME: home }, stdio: ['ignore', fd, fd],
    });
    await awaitReadiness(() => loopbackListening(publicPort), () => true,
      { timeout: STATE_DEADLINE_MS, interval: 1, description: 'Private gateway bind' });
    const errors: Array<{ code: string }> = [];
    await expect(awaitAcceptanceGatewayReadiness(async () => {
      if (gateway!.exitCode !== null || gateway!.signalCode !== null) throw new Error('Private gateway exited.');
      return acceptanceHealth(origin, ca.rootCert);
    }, value => value.ready, { timeout: STATE_DEADLINE_MS, interval: 1, description: 'Private gateway readiness',
      onInitialTlsError: error => errors.push(error) })).resolves.toEqual({ ready: true });
    expect(errors.every(error => error.code === 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR')).toBe(true);
    if (leaf === 'cold') expect(fs.readFileSync(log, 'utf8')).toContain('certificate obtained successfully');
  } finally {
    if (gateway?.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGTERM'); await new Promise(resolve => gateway!.once('exit', resolve)); }
    await new Promise<void>(resolve => backend.close(() => resolve()));
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
