import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db.js';
import { PRODUCTION_DB_PATH } from '../cli/production-db-guard.cjs';
import { createMigratedDb, createMigratedDbWithSeeds, migratedMemoryDb } from './helpers/ledger-fixtures.js';
import { prepareSchemaSeed, readSchemaSeed } from './helpers/schema-seed.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

const databases: ReturnType<typeof migratedMemoryDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('run-scoped schema fixtures', () => {
  it('keeps every memory and file clone private, including users, schema mutations, and pragmas', () => {
    const seedBefore = readSchemaSeed();
    const first = createMigratedDbWithSeeds({
      operator: { slug: 'human' }, agent: { slug: 'agent', sessionEnv: 'seed-session' },
      now: 1, setGlobal: true, pragmas: ['foreign_keys = OFF'],
    });
    databases.push(first.db);
    expect(getDb()).toBe(first.db);
    expect(first.seeds.operator?.slug).toBe('human');
    expect(first.seeds.agent?.kind).toBe('agent');
    first.db.exec('CREATE TABLE private_mutation(value TEXT); INSERT INTO private_mutation VALUES (\'first\')');
    expect(first.db.pragma('foreign_keys', { simple: true })).toBe(0);

    const memory = migratedMemoryDb();
    databases.push(memory);
    const filename = path.join(testRuntimeRoot, 'private.sqlite');
    const file = createMigratedDb({ path: filename, pragmas: ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 321'] });
    databases.push(file);
    for (const db of [memory, file]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'private_mutation'").get()).toBeUndefined();
      expect(db.prepare("SELECT slug FROM users WHERE slug IN ('human', 'agent')").all()).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare("SELECT mandible_sha256('clone') AS hash").get().hash).toHaveLength(64);
    }
    expect(memory.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(file.pragma('busy_timeout', { simple: true })).toBe(321);
    expect(file.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    file.exec('CREATE TABLE file_only(value TEXT)');
    expect(memory.prepare("SELECT name FROM sqlite_master WHERE name = 'file_only'").get()).toBeUndefined();
    expect(readSchemaSeed().equals(seedBefore)).toBe(true);
  });

  it('fails clearly for missing, foreign, stale-schema, or corrupt seed bytes', () => {
    expect(() => readSchemaSeed('')).toThrow('Missing test run root');
    const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'seed-proof-'));
    expect(() => readSchemaSeed(root)).toThrow('Missing run-scoped schema seed');
    prepareSchemaSeed(root);
    const prepared = readSchemaSeed(root);
    const filename = path.join(root, 'schema-seed.sqlite');
    const manifestPath = path.join(root, 'schema-seed.json');
    expect(fs.statSync(filename).mode & 0o777).toBe(0o400);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.chmodSync(manifestPath, 0o600);
    for (const invalid of [{ ...manifest, root: 'another-run' }, { ...manifest, schema: 0 }, { ...manifest, sha256: 'wrong' }]) {
      fs.writeFileSync(manifestPath, JSON.stringify(invalid));
      expect(() => readSchemaSeed(root)).toThrow('does not match');
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readSchemaSeed(root).equals(prepared)).toBe(true);
    fs.chmodSync(filename, 0o600);
    fs.writeFileSync(filename, Buffer.alloc(100));
    expect(() => readSchemaSeed(root)).toThrow('does not match');
    fs.unlinkSync(filename);
    expect(() => readSchemaSeed(root)).toThrow('Missing run-scoped schema seed');
  });

  it('refuses production paths before cloning and never overwrites an existing fixture', () => {
    expect(() => createMigratedDb({ path: PRODUCTION_DB_PATH })).toThrow();
    const filename = path.join(testRuntimeRoot, 'existing.sqlite');
    fs.writeFileSync(filename, 'existing bytes');
    expect(() => createMigratedDb({ path: filename })).toThrow();
    expect(fs.readFileSync(filename, 'utf8')).toBe('existing bytes');
  });
});
