// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createAcceptanceHome, acceptanceGatewayConfig, acceptanceHealth, assessLogs } from '../scripts/candidate-acceptance.mjs';

describe('production acceptance evidence', () => {
  it('rejects closed-database shutdown errors and event storms', () => {
    const stopped = JSON.stringify({ level: 'info', message: 'server_stopped' });
    const closedDb = JSON.stringify({ level: 'error', message: 'work_scanner_repo_scan_failed', error: 'The database connection is not open' });
    expect(assessLogs(`${stopped}\n${closedDb}`)).toEqual([closedDb]);
    expect(assessLogs(Array(101).fill(JSON.stringify({ level: 'info', message: 'work:scan:completed' })).join('\n'))).toContain('Repeated event storm: work:scan:completed (101)');
    expect(assessLogs(`${stopped}\n${JSON.stringify({ level: 'info', message: 'daemon_ready' })}`)).toEqual([]);
    for (const event of ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error']) {
      const warning = JSON.stringify({ level: 'warn', message: event, error: 'SQLite already loaded' });
      expect(assessLogs(warning)).toEqual([warning]);
    }
    expect(assessLogs(JSON.stringify({ level: 'warn', message: 'optional_provider_unavailable' }))).toEqual([]);
  });
});


it('routes only the exact private HTTPS dashboard and retains certificate validation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-acceptance-tls-'));
  let server: https.Server | undefined;
  try {
    const privateHome = path.join(home, 'private-home');
    createAcceptanceHome(privateHome);
    expect(fs.statSync(privateHome).mode & 0o777).toBe(0o700);
    for (const name of ['root', 'unrelated']) {
      const result = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=app.mandible.localhost', '-addext', 'subjectAltName=DNS:app.mandible.localhost',
        '-keyout', path.join(home, `${name}.key`), '-out', path.join(home, `${name}.crt`)], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    }
    server = https.createServer({ key: fs.readFileSync(path.join(home, 'root.key')), cert: fs.readFileSync(path.join(home, 'root.crt')) }, (request, response) => {
      expect(request.url).toBe('/api/health');
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const origin = `https://app.mandible.localhost:${port}`;
    const config = acceptanceGatewayConfig({ origin, backendPort: 12345, adminPort: 12346, storageRoot: home });
    expect(config).toContain(`${origin} {`);
    expect(config).toContain('skip_install_trust');
    expect(config).toContain('tls internal');
    expect(config).toContain('reverse_proxy http://127.0.0.1:12345');
    expect(config).toContain('header_up -X-Mandible-Session-Context');
    await expect(acceptanceHealth(origin, path.join(home, 'root.crt'))).resolves.toEqual({ ready: true });
    await expect(acceptanceHealth(origin, path.join(home, 'unrelated.crt'))).rejects.toThrow();
    for (const denied of ['http://127.0.0.1:12347', 'https://other.mandible.localhost:12347', `${origin}/path`, 'https://app.mandible.localhost']) {
      expect(() => acceptanceGatewayConfig({ origin: denied, backendPort: 12345, adminPort: 12346, storageRoot: home })).toThrow('exact Mandible HTTPS');
    }
    expect(() => acceptanceGatewayConfig({ origin, backendPort: port, adminPort: 12346, storageRoot: home })).toThrow('distinct valid ports');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
