import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import SqliteDatabase from '../src/sqlite.ts';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { saveOwnedMetadata } from './owned-run.mjs';

const fields = ['instance_id', 'installation_id', 'role', 'public_origin', 'backend_origin', 'backend_generation', 'effect_ceiling_json', 'writable_roots_json'];
const tuple = row => row ? Object.fromEntries(fields.map(key => [key, row[key]])) : null;

export function previewRegistration(env) {
  return { instance_id: env.MANDIBLE_INSTANCE_ID, installation_id: env.MANDIBLE_INSTALLATION_ID,
    role: 'preview', public_origin: env.MANDIBLE_PUBLIC_ORIGIN, backend_origin: `http://127.0.0.1:${env.MANDIBLE_PORT}`,
    backend_generation: env.MANDIBLE_BACKEND_GENERATION, effect_ceiling_json: env.MANDIBLE_ALLOWED_EFFECTS,
    writable_roots_json: env.MANDIBLE_WRITABLE_ROOTS };
}

/** Adopt an existing serving tuple without changing or reloading its route. */
export async function withLegacyPreviewRegistration({ home, runId, registration }, operation) {
  const authority = path.join(home, 'config', 'local-sessions');
  if (fs.readFileSync(path.join(home, 'config', 'client-auth', 'authority-id'), 'utf8').trim() !== registration.installation_id) throw new Error('Preview installation authority changed');
  return withInstallationGatewayLock(home, async () => {
    const bindings = path.join(authority, 'preview-bindings');
    if (!/^preview-[a-f0-9]+$/.test(registration.instance_id)
      || fs.existsSync(bindings) && fs.lstatSync(bindings).isSymbolicLink()) throw new Error('Invalid preview registration custody path');
    const file = path.join(bindings, `${registration.instance_id}.json`);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('Preview registration binding is not an exact regular file');
    const binding = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const db = new SqliteDatabase(path.join(authority, 'sessions.db'), { readonly: true, fileMustExist: true });
    try {
      const current = tuple(db.prepare('SELECT * FROM instance_registrations WHERE instance_id = ?').get(registration.instance_id));
      if (!isDeepStrictEqual(current, tuple(registration))) throw new Error('Legacy preview registration identity changed');
      if (binding && (binding.runId !== runId || binding.state !== 'registered'
        || !isDeepStrictEqual(binding.registration, current))) throw new Error('Legacy preview registration belongs to another acquisition');
    } finally { db.close(); }
    return operation(() => {
      if (!binding) {
        fs.mkdirSync(bindings, { recursive: true });
        saveOwnedMetadata(file, { runId, registration: tuple(registration), state: 'registered', adoptedAt: new Date().toISOString() });
      }
    });
  });
}

export async function reconcilePreviewRegistration({ home, runId, expected, desired, reload }) {
  const target = desired ?? expected;
  if (!target || target.role !== 'preview' || !runId) throw new Error('Exact owned preview registration required');
  const authority = path.join(home, 'config', 'local-sessions');
  if (fs.readFileSync(path.join(home, 'config', 'client-auth', 'authority-id'), 'utf8').trim() !== target.installation_id) throw new Error('Preview installation authority changed');
  return withInstallationGatewayLock(home, async token => {
    const bindings = path.join(authority, 'preview-bindings');
    fs.mkdirSync(bindings, { recursive: true });
    if (fs.lstatSync(bindings).isSymbolicLink() || !/^preview-[a-f0-9]+$/.test(target.instance_id)) throw new Error('Invalid preview registration custody path');
    const file = path.join(bindings, `${target.instance_id}.json`);
    const binding = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const db = new SqliteDatabase(path.join(authority, 'sessions.db'), { fileMustExist: true });
    try {
      db.transaction(() => {
        const current = tuple(db.prepare('SELECT * FROM instance_registrations WHERE instance_id = ?').get(target.instance_id));
        if (binding && binding.runId !== runId && (binding.state !== 'retired' || current)) throw new Error('Preview registration is held by another run');
        if (current && (!binding || binding.runId !== runId)) throw new Error('Preview registration lacks this run acquisition binding');
        if (!isDeepStrictEqual(current, tuple(expected)) && !isDeepStrictEqual(current, tuple(desired))) throw new Error('Preview registration identity changed; refusing mutation');
        if (binding?.runId === runId && !(binding.state === 'retired' && current === null)
          && ![expected, desired].some(row => isDeepStrictEqual(tuple(row), binding.registration))) throw new Error('Preview registration custody changed');
        saveOwnedMetadata(file, { runId, registration: tuple(desired ?? expected), state: 'pending', desired: tuple(desired) });
        if (!desired) db.prepare('DELETE FROM instance_registrations WHERE instance_id = ?').run(target.instance_id);
        else db.prepare(`INSERT INTO instance_registrations (${fields.join(', ')}, updated_at)
          VALUES (${fields.map(() => '?').join(', ')}, ?) ON CONFLICT(instance_id) DO UPDATE SET
          ${fields.filter(key => key !== 'instance_id').map(key => `${key}=excluded.${key}`).join(', ')}, updated_at=excluded.updated_at`)
          .run(...fields.map(key => desired[key]), Date.now());
      })();
    } finally { db.close(); }
    await reload(token);
    const result = { runId, registration: tuple(desired ?? expected), state: desired ? 'registered' : 'retired', reconciledAt: new Date().toISOString() };
    saveOwnedMetadata(file, result);
    return result;
  });
}
