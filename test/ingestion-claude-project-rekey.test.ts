// Bug: 1abb772 — moving a project renames its ~/.claude/projects/<key>
// directory. Mandible ingested each moved transcript as a new conversation,
// splitting ids and everything bound to them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import path from "node:path";

import { setDb, type Db } from "../src/db.js";
import { triggerExactPathIngest, triggerReconcileForTest } from "../src/ingestion.js";
import { resolveConversationId } from "../src/conversations/identity.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const SESSION = "e6c74b13-4162-48b1-b3bb-85c42bfebac0";

let tempDir = "";
let projects = "";
let oldDir = "";
let newDir = "";
let db: Db;

function message(uuid: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) {
  return {
    uuid,
    type: role,
    timestamp: "2026-10-30T16:10:00.000Z",
    sessionId: SESSION,
    cwd: "/tmp/old place/proj",
    message: { role, model: "claude-opus", content: role === "user" ? text : [{ type: "text", text }] },
    ...extra,
  };
}

function write(file: string, rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function append(file: string, rows: Array<Record<string, unknown>>): void {
  fs.appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

const main = (dir: string) => path.join(dir, `${SESSION}.jsonl`);
const subagent = (dir: string) => path.join(dir, SESSION, "subagents", "agent-a1b2c3.jsonl");

function reconcile(): Promise<void> {
  return triggerReconcileForTest({ watchConfigs: [{ base: projects, glob: "**/*.jsonl" }] });
}

function visible(): Array<{ id: string; source_path: string; agent_id: string | null; block_count: number }> {
  return db.prepare(`
    SELECT id, source_path, agent_id, block_count FROM conversations c
     WHERE NOT EXISTS (SELECT 1 FROM conversation_identity_aliases a WHERE a.alias_id = c.id)
     ORDER BY agent_id IS NOT NULL, id
  `).all() as Array<{ id: string; source_path: string; agent_id: string | null; block_count: number }>;
}

function availability(conversationId: string): string[] {
  return (db.prepare("SELECT availability FROM conversation_sources WHERE conversation_id = ?")
    .all(conversationId) as Array<{ availability: string }>).map((row) => row.availability);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(testRuntimeRoot, "claude-rekey-"));
  projects = path.join(tempDir, ".claude", "projects");
  oldDir = path.join(projects, "-tmp-old-place-proj");
  newDir = path.join(projects, "-tmp-new-proj");
  write(main(oldDir), [message("u1", "user", "hello"), message("a1", "assistant", "hi")]);
  write(subagent(oldDir), [
    message("s1", "user", "subtask", { isSidechain: true }),
    message("s2", "assistant", "subtask done", { isSidechain: true }),
  ]);
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Claude project rekey", () => {
  it("keeps conversation ids and metadata when a project directory is renamed", async () => {
    await reconcile();
    const before = visible();
    expect(before).toHaveLength(2);
    db.prepare("UPDATE conversations SET starred = 1, tags = '[\"keep\"]' WHERE id = ?").run(before[0].id);

    fs.renameSync(oldDir, newDir);
    await reconcile();

    expect(visible().map(({ id, source_path }) => ({ id, source_path }))).toEqual([
      { id: before[0].id, source_path: main(newDir) },
      { id: before[1].id, source_path: subagent(newDir) },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT starred, tags FROM conversations WHERE id = ?").get(before[0].id))
      .toEqual({ starred: 1, tags: '["keep"]' });
    expect(availability(before[0].id)).toEqual(["available"]);
  });

  it("adopts the original row when the moved transcript is written before the move is observed", async () => {
    await reconcile();
    const [original] = visible();

    fs.renameSync(oldDir, newDir);
    append(main(newDir), [message("u2", "user", "resumed after move"), message("a2", "assistant", "still here")]);
    await triggerExactPathIngest(main(newDir));

    const after = visible();
    expect(after[0]).toMatchObject({ id: original.id, source_path: main(newDir), block_count: 4 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 2 });

    await reconcile();
    expect(visible().map((row) => row.id)).toEqual(after.map((row) => row.id));
    expect(availability(original.id)).toEqual(["available"]);
  });

  it("folds a duplicate ingested at the new key back into the original id", async () => {
    await reconcile();
    const [original] = visible();

    // A copy at the new key while the original is still present: two live
    // transcripts, two rows. This is also how pre-fix rekeys left duplicates.
    fs.cpSync(oldDir, newDir, { recursive: true });
    append(main(newDir), [message("u2", "user", "resumed after move"), message("a2", "assistant", "still here")]);
    await reconcile();
    const duplicate = visible().find((row) => row.source_path === main(newDir))!;
    expect(duplicate.id).not.toBe(original.id);
    expect(visible()).toHaveLength(4);
    db.prepare("UPDATE conversations SET tags = '[\"after-move\"]' WHERE id = ?").run(duplicate.id);

    fs.rmSync(oldDir, { recursive: true });
    await reconcile();

    const after = visible();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: original.id, source_path: main(newDir), block_count: 4 });
    expect(resolveConversationId(db, duplicate.id)).toBe(original.id);
    expect(db.prepare("SELECT tags FROM conversations WHERE id = ?").get(original.id)).toEqual({ tags: '["after-move"]' });
    expect(availability(original.id)).toEqual(["available"]);
  });
});
