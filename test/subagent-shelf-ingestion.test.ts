import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../../src/db.js";
import { triggerTargetedIngest } from "../../src/ingestion.js";
import { registerConversationRoutes } from "../../src/routes/conversations.js";
import { Router } from "../../src/server.js";

let tempDir = "";
let db: Db;

const parentSessionId = "33333333-3333-4333-8333-333333333333";

function writeJsonl(filePath: string, rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function parentPath(): string {
  return path.join(tempDir, ".claude", "projects", "-tmp-project", `${parentSessionId}.jsonl`);
}

function subagentPath(agentId: string): string {
  return path.join(
    tempDir,
    ".claude",
    "projects",
    "-tmp-project",
    parentSessionId,
    "subagents",
    `agent-${agentId}.jsonl`,
  );
}

function writeParent(): void {
  writeJsonl(parentPath(), [
    {
      uuid: "p1",
      type: "user",
      timestamp: "2026-06-01T00:00:00.000Z",
      sessionId: parentSessionId,
      cwd: "/tmp/project",
      message: { role: "user", content: "Run two tasks" },
    },
    {
      uuid: "p2",
      type: "assistant",
      timestamp: "2026-06-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus",
        content: [
          { type: "tool_use", id: "task-1", name: "Task", input: { description: "Inspect parser" } },
          { type: "tool_use", id: "task-2", name: "Task", input: { description: "Inspect UI" } },
        ],
      },
    },
  ]);
}

function writeSubagent(agentId: string, sessionId: string, text: string): void {
  writeJsonl(subagentPath(agentId), [
    {
      uuid: `${agentId}-1`,
      type: "user",
      timestamp: "2026-06-01T00:00:02.000Z",
      sessionId,
      cwd: "/tmp/project",
      isSidechain: true,
      message: { role: "user", content: `You are a subagent. ${text}` },
    },
    {
      uuid: `${agentId}-2`,
      type: "assistant",
      timestamp: "2026-06-01T00:00:04.000Z",
      isSidechain: true,
      message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text }] },
    },
  ]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-subagent-ingest-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Claude subagent ingestion", () => {
  it("links parent and child files, stores sidechain metadata, and hides children from top-level lists", async () => {
    writeParent();
    writeSubagent("alpha", "child-alpha", "Alpha done");
    writeSubagent("beta", "child-beta", "Beta done");

    await triggerTargetedIngest({ transcriptPath: parentPath(), now: 1_000_000 });
    await triggerTargetedIngest({ transcriptPath: subagentPath("alpha"), now: 1_100_000 });
    await triggerTargetedIngest({ transcriptPath: subagentPath("beta"), now: 1_200_000 });

    const parent = db.prepare("SELECT id FROM conversations WHERE session_id = ?").get(parentSessionId) as { id: string };
    const children = db.prepare(
      `SELECT session_id, parent_conversation_id, is_sidechain, agent_id
       FROM conversations
       WHERE parent_conversation_id = ?
       ORDER BY agent_id`
    ).all(parent.id) as Array<{
      session_id: string;
      parent_conversation_id: string;
      is_sidechain: number;
      agent_id: string;
    }>;

    expect(children).toEqual([
      expect.objectContaining({ session_id: "child-alpha", is_sidechain: 1, agent_id: "alpha" }),
      expect.objectContaining({ session_id: "child-beta", is_sidechain: 1, agent_id: "beta" }),
    ]);

    const router = new Router();
    registerConversationRoutes(router);
    const parentDetail = await router.invoke({ method: "GET", url: `/api/conversations/${parent.id}` });
    expect(parentDetail.status).toBe(200);
    expect(parentDetail.body).toMatchObject({
      conversation: { id: parent.id, children_count: 2 },
      children: [
        expect.objectContaining({ agent_id: "alpha", is_sidechain: true, status: expect.any(String) }),
        expect.objectContaining({ agent_id: "beta", is_sidechain: true, status: expect.any(String) }),
      ],
    });

    const list = await router.invoke({ method: "GET", url: "/api/conversations?exclude_subagents=true" });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1 });
  });
});
