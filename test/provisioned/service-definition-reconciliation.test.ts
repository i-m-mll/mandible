// @provisioned launchd
// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { renderLaunchAgent } from '../../scripts/local-runtime.mjs';
import { serviceInstallationContext, inspectServiceDefinitions, matchingServiceDefinitions } from '../../scripts/service-definitions.mjs';
import { pinnedCaddyBinary } from '../../scripts/pinned-caddy.mjs';

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
});
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw new Error('Private launchd fixture did not reach its expected state.');
}

it('real restart reconciles both jobs, preserves a gateway-only backend, and leaves a refused bootstrap installed and unloaded', async () => {
  if (process.platform !== 'darwin') throw new Error('This provisioned test requires macOS launchd.');
  const runtime = process.env.MANDIBLE_RUNTIME;
  if (!runtime) throw new Error('Run through the pinned test:provisioned runner.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-service-reconcile-'));
  const root = path.join(scratch, 'checkout');
  const home = path.join(scratch, 'installation');
  const context = serviceInstallationContext({ home, accountHome: path.join(scratch, 'account') });
  const publicOrigin = `https://127.0.0.1:${await freePort()}`;
  const backendPort = await freePort();
  const generation = 'a'.repeat(40);
  const installationId = 'private-service-definition-fixture';
  const control = (args: string[]) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000 });
  const env = { ...process.env, MANDIBLE_HOME: home, MANDIBLE_SERVICE_ACCOUNT_HOME: context.accountHome, MANDIBLE_DB: path.join(home, 'mandible.db') };
  const write = (relative: string, bytes: string) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const run = (args: string[]) => spawnSync(runtime, args, { cwd: root, env, encoding: 'utf8', timeout: 25_000 });
  const evaluate = (source: string) => run(['--eval', source]);
  const controller = path.join(root, 'scripts/local-runtime.mjs');
  const moduleUrl = pathToFileURL(controller).href;
  const main = `{ backendUrl: new URL('http://127.0.0.1:${backendPort}') }`;
  let backendFile = '';
  let gatewayFile = '';
  try {
    // Only the origin, build identity and registration dependencies are fixture
    // data. The lifecycle controller, inspector, renderer and selector are real.
    for (const name of fs.readdirSync(path.resolve('scripts')).filter(name => name.endsWith('.mjs') || ['bun-runtime.sh', 'bun-runtime-lock.tsv'].includes(name))) {
      write(`scripts/${name}`, fs.readFileSync(path.resolve('scripts', name), 'utf8'));
    }
    write('.bun-version', fs.readFileSync('.bun-version', 'utf8'));
    write('package.json', '{"type":"module"}');
    write('dist/index.js', '// Private harmless lifecycle fixture.\n');
    write('scripts/canonical-origin.mjs', `export const PRODUCTION_ORIGIN = ${JSON.stringify(publicOrigin)}; export const DEFAULT_BACKEND_PORT = ${backendPort};`);
    write('scripts/build-revision.mjs', `export const readBuildRevision = () => '${generation}'; export const compiledBuildDigest = () => ''; export const runtimeDependenciesDigest = () => '';`);
    write('dist/sqlite.js', `export { default } from ${JSON.stringify(pathToFileURL(path.resolve('src/sqlite.ts')).href)};`);
    write('dist/instance-policy.js', `export const resolveInstanceInfo = () => ({ installation_id: '${installationId}', role: 'main', public_origin: ${JSON.stringify(publicOrigin)}, allowed_effects: [] });`);
    write('dist/client-auth/session-authority.js', `export class LocalSessionAuthority { instance() { return { installation_id: '${installationId}', role: 'main', public_origin: ${JSON.stringify(publicOrigin)}, effect_ceiling: [] }; } close() {} }`);
    write('scripts/local-session-production-runner.mjs', `import { randomUUID } from 'node:crypto';
      const startup_epoch = randomUUID();
      Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.MANDIBLE_PORT), fetch() { return Response.json({ status: 'ok', ready: true, warm: true, startup_epoch,
        instance: { role: 'main', instance_id: 'production', installation_id: '${installationId}', public_origin: ${JSON.stringify(publicOrigin)}, backend_generation: '${generation}' } }); } });`);
    fs.mkdirSync(context.privateServiceDir, { recursive: true });
    fs.mkdirSync(path.join(home, 'config/client-auth'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), installationId);
    const authority = new Database(path.join(context.runtimeDir, 'sessions.db'));
    authority.exec('CREATE TABLE instance_registrations(instance_id TEXT, installation_id TEXT, role TEXT, public_origin TEXT, backend_origin TEXT, backend_generation TEXT, effect_ceiling_json TEXT, writable_roots_json TEXT)');
    authority.prepare('INSERT INTO instance_registrations VALUES(?,?,?,?,?,?,?,?)').run('production', installationId, 'main', publicOrigin, `http://127.0.0.1:${backendPort}`, generation, '[]', '[]');
    authority.close();
    const caddy = pinnedCaddyBinary(home);
    fs.mkdirSync(path.dirname(caddy), { recursive: true });
    fs.writeFileSync(caddy, '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o700 });
    const seeded = evaluate(`import { prepareServicePlists } from ${JSON.stringify(moduleUrl)};
      const { definitions } = prepareServicePlists({root: ${JSON.stringify(root)}}, ${main}, 'manual'); console.log(JSON.stringify(definitions));`);
    expect(seeded.status, seeded.stderr).toBe(0);
    const definitions = JSON.parse(seeded.stdout);
    backendFile = definitions[0].file; gatewayFile = definitions[1].file;
    const logDir = path.dirname(definitions[0].record.StandardOutPath);
    fs.mkdirSync(logDir, { recursive: true });
    for (const definition of definitions) {
      const record = definition.record;
      const environment = { ...record.EnvironmentVariables, PATH: '/old/bin:/usr/bin:/bin', ...(definition.service === 'backend' ? { NODE_OPTIONS: '--max-old-space-size=768' } : {}) };
      fs.writeFileSync(definition.file, renderLaunchAgent({ label: record.Label, programArguments: record.ProgramArguments, environment,
        workingDirectory: record.WorkingDirectory, stdoutPath: record.StandardOutPath, stderrPath: record.StandardErrorPath }), { mode: 0o600 });
    }
    for (const name of ['production-runner.mjs', 'canonical-origin.mjs', 'build-revision.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', name === 'production-runner.mjs' ? 'local-session-production-runner.mjs' : name), path.join(context.runtimeDir, name));
    }
    for (const definition of definitions) expect(control(['bootstrap', context.domain, definition.file]).status).toBe(0);
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${backendPort}/api/health`)).ok; } catch { return false; } });
    const before = await (await fetch(`http://127.0.0.1:${backendPort}/api/health`)).json() as { startup_epoch: string };
    const oldPid = control(['print', `${context.domain}/${context.backendLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1];
    // Disk can already contain desired bytes while launchd retains an older
    // definition. Capture must use launchd for prior state and migration.
    for (const definition of definitions) {
      fs.writeFileSync(definition.file, definition.service === 'backend'
        ? definition.contents.replace('<key>PATH</key>', '<key>NODE_OPTIONS</key><string>--max-old-space-size=900</string><key>PATH</key>')
        : definition.contents);
    }
    const drift = await inspectServiceDefinitions(context);
    expect(drift.ok).toBe(true);
    expect(matchingServiceDefinitions(drift).ok).toBe(false);
    const captured = run([controller, 'handoff-snapshot', '--root', root]);
    expect(captured.status, captured.stderr).toBe(0);
    const binding = JSON.parse(captured.stdout);
    expect(binding.priorBackend.definition.EnvironmentVariables.NODE_OPTIONS).toBe('--max-old-space-size=768');
    expect(binding.priorBackend.definition.EnvironmentVariables.PATH).toBe('/old/bin:/usr/bin:/bin');
    expect(binding.priorGateway.definition.EnvironmentVariables.PATH).toBe('/old/bin:/usr/bin:/bin');
    expect(Buffer.from(binding.priorBackend.installed[0].bytesBase64, 'base64').toString()).toContain('--max-old-space-size=900');
    expect(binding.serviceConfiguration.configuration.environment.NODE_OPTIONS).toBe('--max-old-space-size=768');
    expect(binding.serviceConfiguration.configuration.toolDirectories).toContain('/old/bin');
    expect(binding.daemonLog).toBe(binding.priorBackend.definition.StandardErrorPath);
    expect(binding.priorBackend.launchMode).toBe('manual');
    expect(fs.existsSync(path.join(context.runtimeDir, 'service-config.json'))).toBe(false);
    const restarted = run([controller, 'restart']);
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(matchingServiceDefinitions(await inspectServiceDefinitions(context)).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(context.runtimeDir, 'service-config.json'), 'utf8')).environment.NODE_OPTIONS).toBe('--max-old-space-size=768');
    const after = await (await fetch(`http://127.0.0.1:${backendPort}/api/health`)).json() as { startup_epoch: string };
    expect(after.startup_epoch).not.toBe(before.startup_epoch);
    expect(control(['print', `${context.domain}/${context.backendLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1]).not.toBe(oldPid);
    const snapshot = run([controller, 'handoff-snapshot', '--root', root]);
    expect(snapshot.status, snapshot.stderr).toBe(0);

    // Gateway drift alone must reload that job without restarting the backend.
    const gatewayBefore = control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1];
    fs.writeFileSync(gatewayFile, fs.readFileSync(gatewayFile, 'utf8').replace('<key>PATH</key><string>', '<key>PATH</key><string>/changed:'));
    expect(matchingServiceDefinitions(await inspectServiceDefinitions(context)).ok).toBe(false);
    const started = run([controller, 'start']);
    expect(started.status, started.stderr).toBe(0);
    expect(matchingServiceDefinitions(await inspectServiceDefinitions(context)).ok).toBe(true);
    expect((await (await fetch(`http://127.0.0.1:${backendPort}/api/health`)).json() as { startup_epoch: string }).startup_epoch).toBe(after.startup_epoch);
    await until(() => !!control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1]);
    expect(control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1]).not.toBe(gatewayBefore);

    // Loaded ownership allows regeneration and consolidation of generated files.
    const duplicateBackend = path.join(context.serviceDir, `${context.backendLabel}.plist`);
    fs.mkdirSync(context.serviceDir, { recursive: true });
    fs.copyFileSync(backendFile, duplicateBackend);
    fs.unlinkSync(gatewayFile);
    expect((await inspectServiceDefinitions(context)).ok).toBe(true);
    const regenerated = run([controller, 'start']);
    expect(regenerated.status, regenerated.stderr).toBe(0);
    expect(fs.existsSync(duplicateBackend)).toBe(false);
    expect(fs.existsSync(gatewayFile)).toBe(true);
    expect(matchingServiceDefinitions(await inspectServiceDefinitions(context)).ok).toBe(true);

    // An owned plist does not prove that a loaded job with the same label is
    // ours. Preserve both the foreign process and all installed bytes.
    const foreignFile = path.join(scratch, 'foreign.plist');
    fs.writeFileSync(foreignFile, renderLaunchAgent({ label: context.gatewayLabel, programArguments: ['/bin/sleep', '600'],
      workingDirectory: scratch, environment: { HOME: context.accountHome }, stdoutPath: path.join(scratch, 'foreign.log'), stderrPath: path.join(scratch, 'foreign.log') }));
    expect(control(['bootout', `${context.domain}/${context.gatewayLabel}`]).status).toBe(0);
    expect(control(['bootstrap', context.domain, foreignFile]).status).toBe(0);
    await until(() => /\bpid = (\d+)/.test(control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout));
    const foreignPid = control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1];
    const installedBytes = [backendFile, gatewayFile].map(file => fs.readFileSync(file, 'utf8'));
    const conflict = await inspectServiceDefinitions(context);
    expect(conflict).toMatchObject({ ok: false, refusal: { service: 'gateway', category: 'ownership_conflict' } });
    const refused = run([controller, 'start']);
    expect(refused.status).not.toBe(0);
    expect([backendFile, gatewayFile].map(file => fs.readFileSync(file, 'utf8'))).toEqual(installedBytes);
    expect(control(['print', `${context.domain}/${context.gatewayLabel}`]).stdout.match(/\bpid = (\d+)/)?.[1]).toBe(foreignPid);
    expect(control(['bootout', `${context.domain}/${context.gatewayLabel}`]).status).toBe(0);
    expect(control(['bootstrap', context.domain, gatewayFile]).status).toBe(0);

    // Inject only the unavailable bootstrap domain; unload and publication still
    // use real launchd, and the real bootstrap must return the failure.
    const failed = evaluate(`import { reconcileServiceDefinitions } from ${JSON.stringify(moduleUrl)};
      import { spawnSync } from 'node:child_process';
      await reconcileServiceDefinitions({root: ${JSON.stringify(root)}}, ${main}, 'manual', {
        configuration: { environment: { MANDIBLE_PID_FILE: ${JSON.stringify(path.join(scratch, 'replacement.pid'))} } },
        loadService(label) { const result = spawnSync('/bin/launchctl', ['bootstrap', 'gui/4294967294', label === ${JSON.stringify(context.backendLabel)} ? ${JSON.stringify(backendFile)} : ${JSON.stringify(gatewayFile)}], { encoding: 'utf8', timeout: 2500 });
          if (result.status !== 0) throw new Error('Fixture bootstrap refused: ' + result.stderr); throw new Error('Unavailable domain unexpectedly accepted bootstrap'); }
      });`);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('replacement is installed; loaded=false');
    expect(fs.readFileSync(backendFile, 'utf8')).toContain('replacement.pid');
    expect(control(['print', `${context.domain}/${context.backendLabel}`]).status).not.toBe(0);
    expect(matchingServiceDefinitions(await inspectServiceDefinitions(context)).ok).toBe(true);
  } finally {
    control(['bootout', `${context.domain}/${context.backendLabel}`]);
    control(['bootout', `${context.domain}/${context.gatewayLabel}`]);
    // Installation hashes keep these paths exclusive to this fixture.
    for (const label of [context.backendLabel, context.gatewayLabel]) {
      const standard = path.join(context.serviceDir, `${label}.plist`);
      if (fs.existsSync(standard)) fs.unlinkSync(standard);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
