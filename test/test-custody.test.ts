// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCoworkCliCacheDir, materializeCoworkCliCache } from '../src/cowork-cli-cache.js';
import { defaultFileRpcDirForInstance } from '../src/file-rpc-transport.js';
import { getMandibleHome } from '../src/platform-paths.js';
import { sqliteRuntimePaths } from '../src/sqlite-runtime.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';
import SqliteDatabase from "../src/sqlite.ts";
import { getDb, inspectDbBinding, resetDb, setDb } from "../src/db.js";
import { restoreDbSingleton, withTestDb } from "./helpers/db-lifecycle.js";

// The harness itself: what a test may reach, and how the database singleton is scoped.

describe('test runtime custody', () => {
  it('contains default durable state, CLI cache, RPC spool and inherited subprocess home', () => {
    const home = process.env.HOME!;
    expect(path.relative(testRuntimeRoot, home)).toBe('home');
    expect(process.env.XDG_DATA_HOME).toBe(path.join(home, '.local', 'share'));
    const childDataRoot = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.XDG_DATA_HOME)'], { encoding: 'utf8' });
    expect(childDataRoot).toBe(process.env.XDG_DATA_HOME);
    expect(getMandibleHome()).toBe(path.join(home, '.mandible'));
    expect(defaultCoworkCliCacheDir()).toBe(path.join(home, '.cache', 'mandible', 'cli'));
    expect(defaultFileRpcDirForInstance()).toBe(path.join(home, '.cache', 'mandible', 'agent-rpc'));
    materializeCoworkCliCache({ sourceRoot: process.cwd() });
    expect(fs.existsSync(path.join(defaultCoworkCliCacheDir(), 'manifest.json'))).toBe(true);
    const inheritedHome = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8' });
    expect(inheritedHome).toBe(home);
  });

  it('isolated homes reuse the account runtime store instead of installing copies', () => {
    const { MANDIBLE_RUNTIME: _runtime, MANDIBLE_RUNTIME_STORE: _store, ...env } = process.env;
    const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { env, encoding: 'utf8' }).trim();
    expect(path.relative(testRuntimeRoot, runtime).startsWith('..')).toBe(true);
    expect(path.relative(testRuntimeRoot, sqliteRuntimePaths().library).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.join(process.env.XDG_DATA_HOME!, 'mandible', 'runtimes'))).toBe(false);
  });
});

// Issue c4f456c: the src/db.ts singleton is now scoped to the test that
// installed it. These tests pin the reset contract, including the ordering
// dependency on the vitest setupFiles backstop.

function openTestDb(): InstanceType<typeof SqliteDatabase> {
  return new SqliteDatabase(":memory:");
}

describe("db singleton lifecycle", () => {
  it("poisons the slot on reset so a later getDb() fails loudly", () => {
    const db = openTestDb();
    try {
      setDb(db);
      expect(getDb()).toBe(db);
      expect(inspectDbBinding()).toMatchObject({ source: "set", poisonReason: null });

      const result = resetDb({ reason: "unit check" });
      expect(result).toEqual({ cleared: true, source: "set" });
      expect(inspectDbBinding().poisonReason).toBe("unit check");
      expect(() => getDb()).toThrow(/unit check/);

      // Installing a database clears the sentinel.
      setDb(db);
      expect(getDb()).toBe(db);
    } finally {
      db.close();
    }
  });

  it("resetDb never closes the database it unbinds", () => {
    const db = openTestDb();
    try {
      setDb(db);
      resetDb();
      expect(db.open).toBe(true);
      db.prepare("SELECT 1 AS ok").get();
    } finally {
      db.close();
    }
  });

  it("restoreDbSingleton leaves a production-opened binding alone", () => {
    resetDb({ poison: false });
    expect(restoreDbSingleton()).toEqual({ reset: false, source: null });
    expect(inspectDbBinding().poisonReason).toBeNull();
  });

  it("withTestDb restores the previous binding, including on throw", () => {
    const outer = openTestDb();
    const inner = openTestDb();
    try {
      setDb(outer);
      const seen = withTestDb(inner, (db) => {
        expect(getDb()).toBe(db);
        return "value";
      });
      expect(seen).toBe("value");
      expect(getDb()).toBe(outer);

      expect(() =>
        withTestDb(inner, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(getDb()).toBe(outer);
    } finally {
      outer.close();
      inner.close();
    }
  });

  it("withTestDb restores after an async callback settles", async () => {
    const db = openTestDb();
    try {
      resetDb({ poison: false });
      await withTestDb(db, async (scoped) => {
        expect(getDb()).toBe(scoped);
      });
      expect(inspectDbBinding().db).toBeNull();
      expect(inspectDbBinding().poisonReason).toBe("a withTestDb() scope ended");
    } finally {
      db.close();
    }
  });

  describe("setupFiles backstop", () => {
    // Relies on the previous test having installed a binding it never cleaned
    // up. The backstop must have dropped it before this test started.
    const leaked = openTestDb();

    it("installs a binding that the next test must not see", () => {
      setDb(leaked);
      expect(inspectDbBinding().source).toBe("set");
    });

    it("finds the previous test's binding already reset and poisoned", () => {
      expect(inspectDbBinding().db).toBeNull();
      expect(inspectDbBinding().poisonReason).toBe(
        "the test that installed it has finished",
      );
      expect(() => getDb()).toThrow(/unavailable/);
      leaked.close();
    });
  });
});
