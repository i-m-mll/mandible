import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import { observeStableSourceAliasExtent } from "../src/conversations/source-observer.ts";
import { restoreSweepSnapshot, sourceIsIndexed } from "../scripts/route-cost-sweep.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-cost-fixtures-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("selects idle fixtures using ingestion's exact source facts and rejects new appends", async () => {
  const root = tempRoot();
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, "indexed body\n");
  const oldTime = Date.now() / 1_000 - 7_200 + 0.123456;
  fs.utimesSync(source, oldTime, oldTime);
  const observed = await observeStableSourceAliasExtent({
    id: "alias", sourceId: "source", rootKind: "provider", rootPath: root,
    relativePath: "source.jsonl", path: source, aliasKind: "provider", availability: "available",
  });
  const fixture = {
    source_path: source, byte_length: observed.byteLength,
    byte_offset: observed.byteLength, file_mtime_ms: observed.fileMtimeMs,
  };
  expect(sourceIsIndexed(fixture)).toBe(true);
  fs.utimesSync(source, new Date(), new Date());
  const recent = await observeStableSourceAliasExtent({
    id: "alias", sourceId: "source", rootKind: "provider", rootPath: root,
    relativePath: "source.jsonl", path: source, aliasKind: "provider", availability: "available",
  });
  expect(sourceIsIndexed({ ...fixture, file_mtime_ms: recent.fileMtimeMs })).toBe(false);
  fs.appendFileSync(source, "append\n");
  fs.utimesSync(source, oldTime, oldTime);
  expect(sourceIsIndexed(fixture)).toBe(false);
});

it("restores seeded databases before confirmations, including absent caches and writer locks", () => {
  const root = tempRoot();
  const seed = path.join(root, "seed");
  const conversations = path.join(root, "conversations");
  fs.mkdirSync(seed);
  const ledgerSeed = path.join(root, "ledger-seed.db");
  const ledger = path.join(root, "mandible.db");
  const create = (file: string, value: string) => {
    const db = new SqliteDatabase(file);
    try {
      db.exec("CREATE TABLE fixture (value TEXT)");
      db.prepare("INSERT INTO fixture VALUES (?)").run(value);
    } finally { db.close(); }
  };
  const read = (file: string) => {
    const db = new SqliteDatabase(file, { readonly: true });
    try { return db.prepare("SELECT value FROM fixture").get(); }
    finally { db.close(); }
  };
  create(ledgerSeed, "seeded ledger");
  create(path.join(seed, "structure.db"), "seeded structure");
  create(path.join(seed, "search-cache.db"), "seeded search");
  fs.mkdirSync(conversations);
  for (const name of ["structure.db", "search-cache.db"]) create(path.join(conversations, name), "warmed cache");
  fs.writeFileSync(path.join(conversations, "search-cache.db.writer-lock"), "previous daemon");
  fs.writeFileSync(`${ledger}-wal`, "previous daemon");
  restoreSweepSnapshot(ledgerSeed, ledger, seed, conversations);
  expect(read(ledger)).toEqual({ value: "seeded ledger" });
  expect(read(path.join(conversations, "structure.db"))).toEqual({ value: "seeded structure" });
  expect(read(path.join(conversations, "search-cache.db"))).toEqual({ value: "seeded search" });
  expect(fs.existsSync(`${ledger}-wal`)).toBe(false);
  const lock = new SqliteDatabase(path.join(conversations, "search-cache.db.writer-lock"));
  try { lock.exec("BEGIN EXCLUSIVE"); } finally { lock.close(); }
  fs.rmSync(path.join(seed, "search-cache.db"));
  restoreSweepSnapshot(ledgerSeed, ledger, seed, conversations);
  expect(fs.existsSync(path.join(conversations, "search-cache.db"))).toBe(false);
});
