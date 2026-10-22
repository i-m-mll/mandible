import SqliteDatabase from "../src/sqlite.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExactCodexTitleAuthority } from "../src/conversations/codex-title-authority.js";

const roots: string[] = [];

function fixture(): { codexRoot: string; sourcePath: string; sessionId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-codex-title-authority-"));
  roots.push(root);
  const codexRoot = path.join(root, ".codex");
  const sessionId = "01a0107f-82c4-7262-b8b7-9b81273efc61";
  const sourcePath = path.join(codexRoot, "sessions", "2026", "08", "17", `rollout-2026-08-17T12-13-07-${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "{}\n");
  const db = new SqliteDatabase(path.join(codexRoot, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER,
      title TEXT NOT NULL
    )
  `);
  db.prepare("INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, title) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, sourcePath, 2_000_000_000, 2_000_000_000_000, "Exact provider title");
  db.prepare("INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, title) VALUES (?, ?, ?, ?, ?)")
    .run("unrelated", "/private/unrelated.jsonl", 2_000_000_000, 2_000_000_000_000, "Unrelated secret title");
  db.close();
  return { codexRoot, sourcePath, sessionId };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exact Codex title authority", () => {
  it("queries the exact thread row and ignores unrelated provider rows", () => {
    const { sourcePath, sessionId } = fixture();
    const statements: string[] = [];
    expect(readExactCodexTitleAuthority({
      sourcePath,
      nativeSessionId: sessionId,
      sourceMtimeMs: 2_000_000_000_000.949,
      traceSql: (sql) => statements.push(sql),
    })).toEqual({
      status: "current",
      title: "Exact provider title",
      rolloutPath: sourcePath,
      updatedAtMs: 2_000_000_000_000,
    });
    const threadReads = statements.filter((sql) => /\bFROM threads\b/i.test(sql));
    expect(threadReads).toHaveLength(1);
    expect(threadReads[0]).toMatch(new RegExp(`WHERE id = '${sessionId.slice(0, 32)}`));
    expect(threadReads[0]).not.toContain("unrelated");
  });

  it("accepts the same rollout after Codex archive relocation", () => {
    const { codexRoot, sourcePath, sessionId } = fixture();
    const archivedPath = path.join(codexRoot, "archived_sessions", path.basename(sourcePath));
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.renameSync(sourcePath, archivedPath);
    expect(readExactCodexTitleAuthority({
      sourcePath: archivedPath,
      nativeSessionId: sessionId,
      sourceMtimeMs: 1_900_000_000_000,
    })).toMatchObject({ status: "current", title: "Exact provider title" });
  });
});
