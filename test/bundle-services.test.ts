import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitBundleOwner, bundleLaunchAllowed, bundleRuntimeCommand, readBundleOwner } from '../scripts/bundle-services.mjs';
import { serviceInstallationContext } from '../scripts/service-definitions.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const release = { provenance: { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) } };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-contract-'));
  roots.push(root);
  const context = serviceInstallationContext({ home: path.join(root, 'state'), accountHome: root, bundleRoot: path.join(root, 'Mandible.app') });
  fs.mkdirSync(context.bundleRoot!, { recursive: true });
  fs.mkdirSync(path.join(context.home, 'config/client-auth'), { recursive: true });
  fs.writeFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'original-authority');
  fs.writeFileSync(path.join(context.home, 'mandible.db-wal'), 'durable-existing-writes');
  const events: string[] = [];
  const inspect = async () => ({ status: { state: 'stopped', healthy: false }, trusted: { error: 'no trust' }, backendPortOpen: false, backendJob: { loaded: false } });
  const options = { context, release, launchMode: 'manual', session: () => 'login-1',
    initialize: async () => { events.push('initialize'); },
    inspect, waitReady: inspect, previewCount: () => 0, reloadGateway: () => { events.push('reload-gateway'); },
    configureGateway: () => { events.push('gateway-config'); },
    observe: () => ({ ok: true, observations: [] }),
    control: (_: unknown, operation: string, role: string) => { if (operation !== 'status') events.push(`${operation}:${role}`); return { status: 'not_registered' }; },
  };
  return { context, options, events };
}

it('starts from existing mutable state, refuses duplicate/replacement ownership before effects, and removes registration while preserving data', async () => {
  const { context, options, events } = fixture();
  const configFile = path.join(context.runtimeDir, 'service-config.json');
  fs.mkdirSync(context.runtimeDir, { recursive: true });
  const configuration = JSON.stringify({ environment: { MANDIBLE_DB: path.join(context.home, 'custom.db') }, toolDirectories: ['/private/tools'] });
  fs.writeFileSync(configFile, configuration);
  await bundleRuntimeCommand('start', options);
  expect(events).toEqual(['initialize', 'register:backend']);
  expect(readBundleOwner(context)).toMatchObject({ installationId: 'original-authority', bundleRoot: context.bundleRoot });
  expect(fs.readFileSync(configFile, 'utf8')).toBe(configuration);
  events.length = 0;
  await expect(bundleRuntimeCommand('start', { ...options, control: undefined })).rejects.toThrow('Isolated instances');
  await expect(bundleRuntimeCommand('start', { ...options, context: { ...context, bundleRoot: `${context.bundleRoot}.copy` } })).rejects.toThrow('Another app location');
  await expect(bundleRuntimeCommand('start', { ...options, release: { provenance: { ...release.provenance, commit: 'c'.repeat(40) } } })).rejects.toThrow('accepted-package handoff');
  expect(events).toEqual([]);
  expect(admitBundleOwner({ ...context, bundleRoot: `${context.bundleRoot}.moved` }, release, { relocation: true }).ok).toBe(false);
  fs.rmdirSync(context.bundleRoot!);
  expect(admitBundleOwner({ ...context, bundleRoot: `${context.bundleRoot}.moved` }, release, { relocation: true }).ok).toBe(true);
  await bundleRuntimeCommand('remove', options);
  expect(events).toEqual(['unregister:gateway', 'unregister:backend']);
  expect(readBundleOwner(context)).toBeNull();
  expect(fs.readFileSync(path.join(context.home, 'mandible.db-wal'), 'utf8')).toBe('durable-existing-writes');
  expect(fs.readFileSync(configFile, 'utf8')).toBe(configuration);
});

it('keeps manual starts within their login session and never overrides native denial', async () => {
  expect(bundleLaunchAllowed({ enabled: true, launchMode: 'manual', session: 'login-1' }, 'login-1')).toBe(true);
  expect(bundleLaunchAllowed({ enabled: true, launchMode: 'manual', session: 'login-1' }, 'login-2')).toBe(false);
  expect(bundleLaunchAllowed({ enabled: false, launchMode: 'on_demand' }, 'login-2')).toBe(false);
  expect(bundleLaunchAllowed({ enabled: true, launchMode: 'on_demand' }, 'login-2')).toBe(true);
  const { options, events } = fixture();
  await bundleRuntimeCommand('start', options);
  events.length = 0;
  const result = await bundleRuntimeCommand('start', { ...options, control: (_: unknown, operation: string) => {
    if (operation !== 'status') events.push(operation);
    return { status: 'requires_approval' };
  } });
  expect(result.state).toBe('background_permission_required');
  expect(events).not.toContain('unregister');
});
