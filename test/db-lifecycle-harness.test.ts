import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it } from "vitest";

import { getDb, inspectDbBinding, resetDb, setDb } from "../src/db.js";
import { restoreDbSingleton, withTestDb } from "./helpers/db-lifecycle.js";

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
