// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { channelEnvironment, ensureChannelInstallation, reconcileChannelInstallation, retireLegacyChannels } from '../scripts/channel-installation.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { withInstallationGatewayLock } from '../scripts/lifecycle-lock.mjs';
import { inspectRunConsumers } from '../scripts/owned-run.mjs';

const roots: string[] = [];
const scratch = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'channel-lifecycle-'))); roots.push(root); return root; };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8', timeout: 5_000 }).trim();
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = scratch();
  const home = path.join(root, 'home');
  const app = path.join(root, 'Mandible.app');
  const resources = path.join(app, 'Contents/Resources');
  fs.mkdirSync(path.join(resources, 'channel'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config/local-sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), 'test-installation');
  fs.writeFileSync(path.join(resources, 'channel/bridge.mjs'), 'bridge-v1');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/bun'), 'signed-runtime-v1');
  const release = { schema: 'mandible-installed-release@1', target: `${process.platform}-${process.arch}`, version: '1',
    provenance: { commit: 'a'.repeat(40), source_digest: 'a'.repeat(64) },
    layout: { kind: 'macos-app', roots: { resources: '.', executables: '../MacOS' } },
    entrypoints: { channel: 'channel/bridge.mjs' }, native: { bun: '../MacOS/bun' },
    qualification: { bun_sha256: 'a'.repeat(64) }, channelRuntimePolicy: { signer: 'qualified-signer', hardenedRuntime: true }, files: {} };
  const publish = () => {
    release.files = Object.fromEntries(['channel/bridge.mjs', '../MacOS/bun'].map(relative => [relative, installedFileIdentity(path.resolve(resources, relative))]));
    fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify(release));
    fs.writeFileSync(path.join(home, 'config/local-sessions/bundle-owner.json'), JSON.stringify({ installationId: 'test-installation',
      bundleRoot: app, generation: release.provenance.commit, sourceDigest: release.provenance.source_digest }));
  };
  publish();
  return { root, home, app, resources, release, publish };
}

describe('independent channel installation', () => {
  it('installs, repairs exact bytes, preserves behavior across app revisions and re-signing, and rejects stale owners', () => {
    const f = fixture();
    const first = reconcileChannelInstallation(f);
    expect(first.bridge.startsWith(f.app)).toBe(false);
    expect(fs.readFileSync(first.runtime, 'utf8')).toBe('signed-runtime-v1');
    const before = fs.statSync(first.runtime).ino;
    f.release.provenance.commit = 'b'.repeat(40);
    fs.writeFileSync(path.join(f.app, 'Contents/MacOS/bun'), 'signed-runtime-v2-timestamp');
    f.publish();
    const unchanged = reconcileChannelInstallation(f);
    expect(unchanged.generation).toBe(first.generation);
    expect(fs.statSync(first.runtime).ino).toBe(before);
    expect(unchanged.runtimeSha256).toBe(first.runtimeSha256);
    fs.writeFileSync(first.runtime, 'corruption');
    fs.rmSync(first.bridge);
    const repaired = reconcileChannelInstallation(f);
    expect(repaired.generation).toBe(first.generation);
    expect(fs.readFileSync(repaired.runtime, 'utf8')).toBe('signed-runtime-v2-timestamp');
    expect(fs.readFileSync(repaired.bridge, 'utf8')).toBe('bridge-v1');
    f.release.qualification.bun_sha256 = 'c'.repeat(64); f.publish();
    expect(reconcileChannelInstallation(f).generation).not.toBe(first.generation);
    f.release.provenance.commit = 'd'.repeat(40);
    expect(() => reconcileChannelInstallation(f)).toThrow('current installation owner');
    const environment = channelEnvironment(first, { PATH: `${f.app}/Contents/MacOS:/bin`, MANDIBLE_RELEASE_ROOT: f.resources,
      MANDIBLE_RUNTIME: first.runtime, CLAUDE_CODE_SESSION_ID: 'conversation' }, '/logical/project');
    expect(environment).toMatchObject({ PATH: '/bin', CLAUDE_CWD: '/logical/project', CLAUDE_CODE_SESSION_ID: 'conversation' });
    expect(environment.MANDIBLE_RELEASE_ROOT).toBeUndefined();
  });

  it('retires exact owned legacy channel children while preserving parents, unrelated consumers and reused pids', () => {
    const f = fixture();
    const previous = path.join(f.root, '.Mandible-request123-execution123.previous.app');
    fs.mkdirSync(previous);
    const stat = fs.statSync(previous);
    const binding = { home: f.home, nativeApp: f.app, requestId: 'request123', executionId: 'execution123', priorAppIdentity: { dev: stat.dev, ino: stat.ino } };
    const directory = path.join(f.home, 'config/local-sessions/handoff/request123-execution123');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'journal.json'), JSON.stringify({ schema: 'mandible-runtime-handoff@1', binding, bindingDigest: hash(binding) }));
    const command = `${f.app}/Contents/Resources/../MacOS/mandible-bun --no-install ${f.app}/Contents/Resources/cli/../dist/channel-server/index.js`;
    const row = (pid: number, invocation = command) => ({ pid, uid: process.getuid!(), birth: 'fixed-birth', command: invocation });
    const initial = [row(99101), row(99102, command + ' unrelated'), row(process.ppid), row(99103)];
    let samples = 0;
    const signals: unknown[] = [];
    retireLegacyChannels({ ...f, rows: () => ++samples === 1 ? initial : initial.map(value => value.pid === 99103 ? { ...value, birth: 'new-birth' } : value),
      executable: () => path.join(previous, 'Contents/MacOS/mandible-bun'), signal: (pid: number, name: string) => signals.push({ pid, name }) });
    expect(signals).toEqual([{ pid: 99101, name: 'SIGTERM' }]);
  });

  it('serializes repairs against owner adoption, permits read-only startup under a held handoff lock, and rejects symlink writes', async () => {
    const f = fixture();
    const active = reconcileChannelInstallation(f);
    const oldRelease = structuredClone(f.release);
    await withInstallationGatewayLock(f.home, async () => {
      expect((await ensureChannelInstallation(f)).generation).toBe(active.generation);
      fs.rmSync(active.bridge);
      await expect(ensureChannelInstallation(f)).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY' });
      f.release.provenance.commit = 'c'.repeat(40);
      fs.writeFileSync(path.join(f.resources, 'channel/bridge.mjs'), 'bridge-v2');
      f.publish();
      reconcileChannelInstallation(f);
    });
    await expect(ensureChannelInstallation({ ...f, release: oldRelease })).rejects.toThrow('current installation owner');
    const privateHome = fixture();
    const target = path.join(scratch(), 'production-channel'); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(privateHome.home, 'channel'));
    expect(() => reconcileChannelInstallation(privateHome)).toThrow('canonical owned paths');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('signals a real renamed-bundle channel child and leaves its parent and unrelated bundle consumer alive', async () => {
    const f = fixture();
    const binary = path.join(f.app, 'Contents/MacOS/mandible-bun'); fs.copyFileSync(runtime, binary); fs.chmodSync(binary, 0o755);
    const entry = path.join(f.resources, 'dist/channel-server/index.js'); fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log("ready"); setInterval(() => {}, 1000);');
    const other = path.join(f.resources, 'holder.js'); fs.writeFileSync(other, 'console.log("ready"); setInterval(() => {}, 1000);');
    const legacy = spawn(binary, ['--no-install', entry], { cwd: f.resources, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 });
    const unrelated = spawn(binary, ['--no-install', other], { cwd: f.resources, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 });
    try {
      await Promise.all([once(legacy.stdout, 'data'), once(unrelated.stdout, 'data')]);
      const stat = fs.statSync(f.app);
      const previous = path.join(f.root, '.Mandible-request123-execution123.previous.app'); fs.renameSync(f.app, previous);
      const binding = { home: f.home, nativeApp: f.app, requestId: 'request123', executionId: 'execution123', priorAppIdentity: { dev: stat.dev, ino: stat.ino } };
      const directory = path.join(f.home, 'config/local-sessions/handoff/request123-execution123'); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'journal.json'), JSON.stringify({ schema: 'mandible-runtime-handoff@1', binding, bindingDigest: hash(binding) }));
      const exited = once(legacy, 'close');
      expect(retireLegacyChannels(f)).toEqual([legacy.pid]);
      await exited;
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      const consumers = inspectRunConsumers(previous);
      expect(consumers.idle).toBe(false);
      expect(consumers.pids).toContain(unrelated.pid);
      expect(fs.existsSync(previous)).toBe(true);
    } finally {
      for (const child of [legacy, unrelated]) if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close'); child.kill('SIGTERM'); await exited;
      }
    }
  }, 10_000);
});

describe('live MCP bridge lifecycle', () => {
  it('survives daemon restart without replay, then disconnects only its transport on changed generation', async () => {
    const root = scratch();
    const bridge = path.join(root, 'bridge.mjs');
    execFileSync(runtime, ['build', 'channel-server/index.ts', '--target', 'bun', '--outfile', bridge], { encoding: 'utf8', timeout: 10_000 });
    const active = path.join(root, 'active.json');
    fs.writeFileSync(active, JSON.stringify({ generation: 'one' }));
    let calls = 0;
    const handler: http.RequestListener = (req, res) => {
      if (req.url?.startsWith('/api/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/channel/catalog') res.end(JSON.stringify({ protocol: 1, tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }));
        else if (req.url === '/api/channel/connect') res.end('{"session_id":null}');
        else if (req.url === '/api/channel/render') res.end('{"notifications":[],"delivered":[]}');
        else if (req.url === '/api/channel/call') { calls++; res.end('{"content":[{"type":"text","text":"done"}]}'); }
      });
    };
    let daemon = http.createServer(handler);
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    const port = (daemon.address() as { port: number }).port;
    const transport = new StdioClientTransport({ command: runtime, args: ['--no-install', bridge], cwd: root, stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin', MANDIBLE_BASE: `http://127.0.0.1:${port}`, MANDIBLE_CHANNEL_ACTIVE: active, MANDIBLE_CHANNEL_GENERATION: 'one' } });
    const client = new Client({ name: 'lifecycle-test', version: '1' });
    let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
    try {
      await client.connect(transport);
      const pid = transport.pid;
      expect((await client.listTools()).tools[0].name).toBe('probe');
      await client.callTool({ name: 'probe' });
      daemon.closeAllConnections(); await new Promise<void>(resolve => daemon.close(() => resolve()));
      await expect(client.callTool({ name: 'probe' })).rejects.toThrow();
      daemon = http.createServer(handler);
      await new Promise<void>(resolve => daemon.listen(port, '127.0.0.1', resolve));
      expect((await client.listTools()).tools[0].name).toBe('probe');
      expect(transport.pid).toBe(pid);
      expect(calls).toBe(1);
      const closed = new Promise<void>(resolve => { client.onclose = resolve; });
      fs.writeFileSync(active, JSON.stringify({ generation: 'two' }));
      await closed;
      expect(stderr).toContain('reconnect mandible using /mcp');
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      await client.close(); daemon.closeAllConnections(); await new Promise<void>(resolve => daemon.close(() => resolve()));
    }
  }, 10_000);

  it('exits on stdin EOF even before MCP initialization', async () => {
    const child = spawn(runtime, ['--no-install', path.resolve('channel-server/index.ts')], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 4_000 });
    const closed = once(child, 'close');
    child.stdin.end();
    expect((await closed)[0]).toBe(0);
  });
});
