import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { columnExists, tableExists } from "../../src/db-introspection.js";
import { readBody, sendJson } from "../../src/routes/http.js";

describe("shared HTTP helpers", () => {
  it("reads request bodies with an empty-object fallback", () => {
    expect(readBody<{ value?: string }>({ body: { value: "ok" } } as never)).toEqual({
      value: "ok",
    });
    expect(readBody<Record<string, unknown>>({ body: undefined } as never)).toEqual({});
  });

  it("sends JSON through status/json response methods", () => {
    const status = vi.fn();
    const json = vi.fn();

    sendJson({ status, json }, 201, { ok: true });

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it("falls back across code, send, and end response methods", () => {
    const code = vi.fn();
    const send = vi.fn();
    const end = vi.fn();

    sendJson({ code, send }, 202, { sent: true });
    sendJson({ end }, 200, { ended: true });
    sendJson(null, 500, { ignored: true });

    expect(code).toHaveBeenCalledWith(202);
    expect(send).toHaveBeenCalledWith({ sent: true });
    expect(end).toHaveBeenCalledWith('{"ended":true}');
  });
});

describe("shared database introspection helpers", () => {
  const databases: SqliteDatabase[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("detects tables and columns", () => {
    const db = new SqliteDatabase(":memory:");
    databases.push(db);
    db.exec("CREATE TABLE example (id TEXT PRIMARY KEY, value INTEGER)");

    expect(tableExists(db, "example")).toBe(true);
    expect(tableExists(db, "missing")).toBe(false);
    expect(columnExists(db, "example", "value")).toBe(true);
    expect(columnExists(db, "example", "missing")).toBe(false);
  });

  it("treats introspection failures as absent schema", () => {
    const db = new SqliteDatabase(":memory:");
    db.close();

    expect(tableExists(db, "example")).toBe(false);
    expect(columnExists(db, "example", "value")).toBe(false);
  });
});
