import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import SqliteDatabase from "../src/sqlite.js";
import { runLedgerRead } from "../src/ledger-reads/registry.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";

it("keeps conversation counts and pages in one snapshot across a writer commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-snapshot-"));
  const dbPath = path.join(root, "ledger.db");
  const writer = createMigratedDb({ path: dbPath, pragmas: ["journal_mode = WAL"] });
  const reader = new SqliteDatabase(dbPath, { readonly: true });
  try {
    writer.prepare(`INSERT INTO conversations
      (id, source, source_path, source_hash, source_mtime, title, started_at, session_id)
      VALUES ('conversation', 'codex', '/tmp/snapshot', 'hash', 1, 'Snapshot', '2026-10-25', 'session')`).run();
    const prepare = reader.prepare.bind(reader);
    let committed = false;
    const spy = vi.spyOn(reader, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT COUNT(*) as total FROM conversations c")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...params) => {
          const count = get(...params);
          writer.prepare("UPDATE conversations SET starred = 1 WHERE id = 'conversation'").run();
          committed = true;
          return count;
        });
      }
      return statement;
    });

    const result = await runLedgerRead(reader, "conversation_list", { query: { starred: "true" } });
    expect(committed).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.json)).toMatchObject({ conversations: [], total: 0, pages: 0 });
    expect(reader.inTransaction).toBe(false);
    spy.mockRestore();

    const next = await runLedgerRead(reader, "conversation_list", { query: { starred: "true" } });
    expect(JSON.parse(next.json)).toMatchObject({ conversations: [{ id: "conversation" }], total: 1, pages: 1 });
  } finally {
    vi.restoreAllMocks();
    reader.close();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
