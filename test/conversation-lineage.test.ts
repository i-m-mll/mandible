import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { triggerTargetedIngest } from "../src/ingestion.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { backfillConversationLineageOnce } from "../src/conversations/lineage-backfill.js";
import SqliteDatabase from "../src/sqlite.js";
import { Router } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
let clock = 1_000_000;

const ROOT = "01a15eab-0000-7000-8000-000000000001";
const CHILD_A = "01a15eab-0000-7000-8000-00000000000a";
const CHILD_B = "01a15eab-0000-7000-8000-00000000000b";
const GRANDCHILD = "01a15eab-0000-7000-8000-0000000000aa";

function rolloutPath(root: "sessions" | "archived_sessions", threadId: string): string {
  const dir = root === "sessions"
    ? path.join(tempDir, ".codex", "sessions", "2026", "10", "21")
    : path.join(tempDir, ".codex", "archived_sessions");
  return path.join(dir, `rollout-2026-10-21T09-00-00-${threadId}.jsonl`);
}

function writeRollout(
  filePath: string,
  threadId: string,
  spawn: { parent: string; nickname: string } | null,
): string {
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-10-21T09:00:00.000Z",
      payload: {
        id: threadId,
        session_id: ROOT,
        cwd: "/tmp/project",
        cli_version: "0.162.0",
        source: spawn
          ? { subagent: { thread_spawn: { parent_thread_id: spawn.parent, depth: 1, agent_nickname: spawn.nickname } } }
          : "vscode",
        thread_source: spawn ? "subagent" : "user",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-21T09:00:01.000Z",
      payload: { type: "user_message", message: `work for ${threadId}` },
    },
    {
      type: "response_item",
      timestamp: "2026-10-21T09:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    },
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return filePath;
}

async function ingest(filePath: string): Promise<void> {
  clock += 100_000;
  await triggerTargetedIngest({ transcriptPath: filePath, now: clock });
}

function rowsOf(sessionId: string): Array<{ id: string; parent_conversation_id: string | null; is_sidechain: number; agent_id: string | null }> {
  return db.prepare(
    "SELECT id, parent_conversation_id, is_sidechain, agent_id FROM conversations WHERE session_id = ? ORDER BY source_path",
  ).all(sessionId) as Array<{ id: string; parent_conversation_id: string | null; is_sidechain: number; agent_id: string | null }>;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-lineage-"));
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation lineage", () => {
  it("links Codex subagents from rollout headers whichever of parent and child is ingested first", async () => {
    const childA = writeRollout(rolloutPath("sessions", CHILD_A), CHILD_A, { parent: ROOT, nickname: "Leibniz" });
    const grandchild = writeRollout(rolloutPath("sessions", GRANDCHILD), GRANDCHILD, { parent: CHILD_A, nickname: "Hume" });
    await ingest(childA);
    await ingest(grandchild);
    expect(rowsOf(CHILD_A)[0]).toMatchObject({ parent_conversation_id: null, is_sidechain: 1, agent_id: "Leibniz" });

    const root = writeRollout(rolloutPath("sessions", ROOT), ROOT, null);
    await ingest(root);
    const rootId = rowsOf(ROOT)[0].id;
    expect(rowsOf(CHILD_A)[0].parent_conversation_id).toBe(rootId);
    expect(rowsOf(GRANDCHILD)[0].parent_conversation_id).toBe(rowsOf(CHILD_A)[0].id);
    expect(rowsOf(ROOT)[0]).toMatchObject({ parent_conversation_id: null, is_sidechain: 0 });

    // A second row of the root (Codex re-ingests a rollout after archiving
    // it) shares one family; a child ingested now links to one of them.
    const archivedRoot = rolloutPath("archived_sessions", ROOT);
    fs.mkdirSync(path.dirname(archivedRoot), { recursive: true });
    fs.copyFileSync(root, archivedRoot);
    await ingest(archivedRoot);
    const childB = writeRollout(rolloutPath("sessions", CHILD_B), CHILD_B, { parent: ROOT, nickname: "Locke" });
    await ingest(childB);
    expect(rowsOf(CHILD_B)[0].parent_conversation_id).not.toBeNull();

    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    expect(rowsOf(ROOT)).toHaveLength(2);
    for (const { id } of rowsOf(ROOT)) {
      const detail = await router.invoke({ method: "GET", url: `/api/conversations/${id}` });
      expect(detail.status).toBe(200);
      const children = (detail.body as { children: Array<{ agent_id: string }> }).children;
      expect(children.map((child) => child.agent_id).sort()).toEqual(["Leibniz", "Locke"]);
    }
    const listed = await router.invoke({ method: "GET", url: `/api/conversations?parent_id=${rowsOf(CHILD_A)[0].id}` });
    expect((listed.body as { total: number }).total).toBe(1);
  });

  it("backfills rows indexed without lineage through their parsers, or Codex's registry once the rollout is pruned", async () => {
    const root = writeRollout(rolloutPath("sessions", ROOT), ROOT, null);
    const childA = writeRollout(rolloutPath("sessions", CHILD_A), CHILD_A, { parent: ROOT, nickname: "Leibniz" });
    const childB = writeRollout(rolloutPath("sessions", CHILD_B), CHILD_B, { parent: ROOT, nickname: "Locke" });
    for (const file of [root, childA, childB]) await ingest(file);
    db.prepare(
      "UPDATE conversations SET parent_conversation_id = NULL, parent_source = NULL, parent_session_id = NULL, is_sidechain = 0, agent_id = NULL",
    ).run();
    fs.rmSync(childB);
    const registry = new SqliteDatabase(path.join(tempDir, ".codex", "state_5.sqlite"));
    registry.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_source TEXT, agent_nickname TEXT)");
    registry.prepare("INSERT INTO threads VALUES (?, ?, 'subagent', 'Locke')").run(
      CHILD_B,
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_nickname: "Locke" } } }),
    );
    registry.close();

    const result = await backfillConversationLineageOnce(db);
    expect(result).toMatchObject({
      declared: { codex: 2 },
      lineage_source: { transcript: 2, codex_state_database: 1 },
      linked: 2,
      unresolved_parent: 0,
    });
    expect(await backfillConversationLineageOnce(db)).toBeNull();
    const rootId = rowsOf(ROOT)[0].id;
    expect(rowsOf(CHILD_A)[0]).toMatchObject({ parent_conversation_id: rootId, is_sidechain: 1, agent_id: "Leibniz" });
    expect(rowsOf(CHILD_B)[0]).toMatchObject({ parent_conversation_id: rootId, is_sidechain: 1, agent_id: "Locke" });
  });

  it("links a legacy Claude sidechain transcript to the session its records name", async () => {
    const parentSession = "44444444-4444-4444-8444-444444444444";
    const projectDir = path.join(tempDir, ".claude", "projects", "-tmp-project");
    const write = (file: string, rows: Array<Record<string, unknown>>) => {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, file), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      return path.join(projectDir, file);
    };
    const record = (uuid: string, role: "user" | "assistant", extra: Record<string, unknown> = {}) => ({
      uuid,
      type: role,
      timestamp: "2026-01-08T00:00:00.000Z",
      sessionId: parentSession,
      cwd: "/tmp/project",
      message: { role, content: role === "user" ? "go" : [{ type: "text", text: "ok" }] },
      ...extra,
    });
    const agent = write("agent-aaa6e9a.jsonl", [
      record("a1", "user", {
        isSidechain: true,
        message: {
          role: "user",
          content: "[mandible child parent=claude:99999999-9999-4999-8999-999999999999 parent-role=coordinator role=worker]\nWork.",
        },
      }),
      record("a2", "assistant", { isSidechain: true }),
    ]);
    await ingest(agent);
    await ingest(write(`${parentSession}.jsonl`, [record("p1", "user"), record("p2", "assistant")]));

    const rows = db.prepare(
      "SELECT source_path, parent_conversation_id, agent_id FROM conversations WHERE session_id = ?",
    ).all(parentSession) as Array<{ source_path: string; parent_conversation_id: string | null; agent_id: string | null }>;
    const parent = rows.find((row) => !row.source_path.includes("agent-"))!;
    const child = rows.find((row) => row.source_path.includes("agent-"))!;
    expect(parent.parent_conversation_id).toBeNull();
    expect(child.agent_id).toBe("aaa6e9a");
    expect(child.parent_conversation_id).toBe(
      (db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(parent.source_path) as { id: string }).id,
    );
  });

  it("links Claude subagent transcripts under their session directory and keeps them out of top-level lists", async () => {
    const parentSession = "33333333-3333-4333-8333-333333333333";
    const projectDir = path.join(tempDir, ".claude", "projects", "-tmp-project");
    const write = (file: string, rows: Array<Record<string, unknown>>) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      return file;
    };
    const message = (uuid: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) => ({
      uuid, type: role, timestamp: "2026-06-01T00:00:00.000Z", cwd: "/tmp/project",
      message: { role, model: "claude-opus", content: role === "user" ? text : [{ type: "text", text }] }, ...extra,
    });
    await ingest(write(path.join(projectDir, `${parentSession}.jsonl`), [
      message("p1", "user", "Run two tasks", { sessionId: parentSession }),
      message("p2", "assistant", "dispatching"),
    ]));
    for (const agentId of ["alpha", "beta"]) {
      await ingest(write(path.join(projectDir, parentSession, "subagents", `agent-${agentId}.jsonl`), [
        message(`${agentId}-1`, "user", `You are a subagent: ${agentId}`, { sessionId: `child-${agentId}`, isSidechain: true }),
        message(`${agentId}-2`, "assistant", `${agentId} done`, { isSidechain: true }),
      ]));
    }

    const parentId = rowsOf(parentSession)[0].id;
    for (const agentId of ["alpha", "beta"]) {
      expect(rowsOf(`child-${agentId}`)[0]).toMatchObject({ parent_conversation_id: parentId, is_sidechain: 1, agent_id: agentId });
    }
    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    const detail = await router.invoke({ method: "GET", url: `/api/conversations/${parentId}` });
    expect(detail.body).toMatchObject({ conversation: { id: parentId, children_count: 2 } });
    const list = await router.invoke({ method: "GET", url: "/api/conversations?exclude_subagents=true" });
    expect(list.body).toMatchObject({ total: 1 });
  });
});
