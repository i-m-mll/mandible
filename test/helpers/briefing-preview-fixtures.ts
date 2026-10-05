import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from '../../src/sqlite';
import { migrate, type Db } from '../../src/db';
import type { ClientAuthGate, ResolvedClientIdentity } from '../../src/server';
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from '../../src/security/effect-policy';

export class UiRoundTripGate implements ClientAuthGate {
  constructor(private readonly db: Db) {}

  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const user = this.db.prepare('SELECT id, slug FROM users WHERE slug = ?').get(credential) as { id: string; slug: string } | undefined;
    return user ? { user_id: user.id, slug: user.slug, method: 'api_token', credential_id: null, source: 'in_process', effect_ceiling: PRODUCTION_EFFECTS } : null;
  }

  mode() { return 'compat' as const; }
  recordUnattributedWrite() {}
}

export function createCopiedPreviewDatabase(root: string): {
  db: Db;
  dbPath: string;
  sourceDbPath: string;
  previewRoot: string;
  sourceRoot: string;
} {
  const sourceRoot = path.join(root, 'source');
  const previewRoot = path.join(root, 'preview');
  fs.mkdirSync(path.join(sourceRoot, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(previewRoot, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(previewRoot, 'settings', 'users'), { recursive: true });
  const sourceDbPath = path.join(sourceRoot, 'source.db');
  const dbPath = path.join(previewRoot, 'copy.db');
  const sourceDb = new SqliteDatabase(sourceDbPath);
  try {
    migrate(sourceDb);
  } finally {
    sourceDb.close();
  }
  fs.copyFileSync(sourceDbPath, dbPath);
  return { db: new SqliteDatabase(dbPath), dbPath, sourceDbPath, previewRoot, sourceRoot };
}

export function exactTestInstanceEnv(role: 'test' | 'preview', details: {
  previewRoot?: string;
  sourceRoot?: string;
} = {}): NodeJS.ProcessEnv {
  const suffix = role === 'preview' ? 'copied-preview' : 'test';
  return {
    MANDIBLE_INSTANCE_ROLE: role,
    MANDIBLE_INSTANCE_ID: `${suffix}-briefing-rounds`,
    MANDIBLE_INSTALLATION_ID: 'test-installation',
    MANDIBLE_PUBLIC_ORIGIN: `https://${suffix}-briefing-rounds.mandible.localhost:19421`,
    MANDIBLE_BACKEND_GENERATION: 'test-generation',
    ...(details.previewRoot ? {
      MANDIBLE_PREVIEW_ROOT: details.previewRoot,
      MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(STANDARD_PREVIEW_EFFECTS),
      MANDIBLE_WRITABLE_ROOTS: JSON.stringify([details.previewRoot]),
      MANDIBLE_ARTIFACT_DIR: path.join(details.previewRoot, 'artifacts'),
      MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: path.join(details.sourceRoot!, 'artifacts'),
      MANDIBLE_USER_PREFERENCES_DIR: path.join(details.previewRoot, 'settings', 'users'),
    } : {}),
  };
}

export function installStorage(): void {
  const rows = new Map<string, string>();
  const storage = { get length() { return rows.size; }, clear: () => rows.clear(), getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null, removeItem: (key: string) => rows.delete(key), setItem: (key: string, value: string) => rows.set(key, String(value)) } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

export function operatorSessionResponse(): Response {
  return new Response(JSON.stringify({ authenticated: true, session: {
    family_id: 'briefing-test-family', audience: 'production', csrf_token: 'briefing-test-csrf',
    effect_ceiling: ['ledger:read', 'ledger:write'],
  } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

