import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { triggerTargetedIngest } from "../src/ingestion.js";
import { readOpeningLine } from "../src/lineage-marker.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import type { LineageGapReport } from "../src/conversation-lineage.js";

const CODEX_PARENT = "01a15eab-0000-7000-8000-000000000001";
const CODEX_OTHER = "01a15eab-0000-7000-8000-000000000002";
const CODEX_CHILD = "01a15eab-0000-7000-8000-00000000000c";
const CLAUDE_PARENT = "11111111-1111-4111-8111-111111111111";
const CLAUDE_CHILD = "22222222-2222-4222-8222-222222222222";
const NIL = "00000000-0000-0000-0000-000000000000";

describe("lineage marker grammar", () => {
  it.each([
    [`[mandible child parent=codex:${CODEX_PARENT} parent-role=coordinator role=worker]`, {
      relation: "child", parent: { source: "codex", sessionId: CODEX_PARENT }, parentRole: "coordinator", role: "worker",
    }],
    [`[mandible child role=worker parent=claude:${CLAUDE_PARENT.toUpperCase()} parent-role=coordinator]`, {
      relation: "child", parent: { source: "claude_code", sessionId: CLAUDE_PARENT }, parentRole: "coordinator", role: "worker",
    }],
    [`  [mandible successor predecessor=gemini:${CLAUDE_PARENT} role=coordinator]  \nI hand you the goal.`, {
      relation: "successor", predecessor: { source: "gemini", sessionId: CLAUDE_PARENT }, role: "coordinator",
    }],
  ])("accepts %s", (line, marker) => {
    expect(readOpeningLine(line)).toMatchObject({ kind: "marker", marker });
  });

  it.each([
    `[mandible child parent=codex:${CODEX_PARENT} parent-role=coordinator]`,
    `[mandible child parent=codex:${CODEX_PARENT} parent-role=coordinator role=worker extra=1]`,
    `[mandible child parent=codex:${CODEX_PARENT} parent=codex:${CODEX_PARENT} parent-role=coordinator role=worker]`,
    `[mandible child parent=openai:${CODEX_PARENT} parent-role=coordinator role=worker]`,
    `[mandible child parent=codex:not-a-session parent-role=coordinator role=worker]`,
    `[mandible child parent=codex:${CODEX_PARENT} parent-role=Coordinator role=worker]`,
    `[mandible sibling parent=codex:${CODEX_PARENT} role=worker]`,
    `[mandible successor predecessor=codex:${CODEX_PARENT} parent-role=coordinator role=worker]`,
    `[mandible child parent=codex:${CODEX_PARENT} parent-role=coordinator role=worker`,
    "[mandible]",
  ])("flags %s as malformed", (line) => {
    expect(readOpeningLine(line)).toMatchObject({ kind: "malformed", line });
  });

  it.each([
    ["I am a Coordinator and your parent. Please adopt the Worker role.", "legacy-prose"],
    ["Please fix the build.", "none"],
    ["", "none"],
    [`Fix this.\n[mandible child parent=codex:${CODEX_PARENT} parent-role=coordinator role=worker]`, "none"],
  ])("reads %j as %s", (message, kind) => {
    expect(readOpeningLine(message).kind).toBe(kind);
  });
});

let tempDir = "";
let db: Db;
let clock = 1_000_000;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-marker-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function marker(parent: string): string {
  return `[mandible child parent=${parent} parent-role=coordinator role=worker]`;
}

function delegation(source: string, prompt: string): string {
  return `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
}

type CodexOpening = { prompt: string } | { createdBy: string; prompt: string } | null;

function codexRecords(threadId: string, opening: CodexOpening): Array<Record<string, unknown>> {
  const meta = {
    type: "session_meta",
    timestamp: "2026-10-21T09:00:00.000Z",
    payload: {
      id: threadId,
      cwd: "/tmp/project",
      cli_version: "0.162.0",
      source: "vscode",
      thread_source: opening && "createdBy" in opening ? "agent_created_thread" : "user",
    },
  };
  const first = !opening ? [] : "createdBy" in opening
    ? [{
        type: "response_item",
        timestamp: "2026-10-21T09:00:01.000Z",
        payload: { type: "function_call_output", name: "create_thread", output: delegation(opening.createdBy, opening.prompt) },
      }]
    : [{
        type: "response_item",
        timestamp: "2026-10-21T09:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: opening.prompt }] },
      }];
  return [
    meta,
    ...first,
    {
      type: "response_item",
      timestamp: "2026-10-21T09:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    },
  ];
}

function writeJsonl(filePath: string, rows: Array<Record<string, unknown>>): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return filePath;
}

function codexRollout(threadId: string, opening: CodexOpening): string {
  const file = path.join(tempDir, ".codex", "sessions", "2026", "10", "21", `rollout-2026-10-21T09-00-00-${threadId}.jsonl`);
  return writeJsonl(file, codexRecords(threadId, opening));
}

function claudeTranscript(sessionId: string, prompt: string): string {
  const file = path.join(tempDir, ".claude", "projects", "-tmp-project", `${sessionId}.jsonl`);
  const record = (uuid: string, role: "user" | "assistant", content: unknown) => ({
    uuid, type: role, sessionId, cwd: "/tmp/project", timestamp: "2026-10-21T09:00:00.000Z", message: { role, content },
  });
  return writeJsonl(file, [record("u1", "user", prompt), record("a1", "assistant", [{ type: "text", text: "ok" }])]);
}

async function ingest(filePath: string): Promise<void> {
  clock += 100_000;
  await triggerTargetedIngest({ transcriptPath: filePath, now: clock });
}

function row(sessionId: string): { id: string; parent_conversation_id: string | null; opening_lineage: string | null } {
  return db.prepare("SELECT id, parent_conversation_id, opening_lineage FROM conversations WHERE session_id = ?")
    .get(sessionId) as { id: string; parent_conversation_id: string | null; opening_lineage: string | null };
}

async function gaps(): Promise<LineageGapReport> {
  const router = new Router();
  registerConversationRoutes(router);
  const response = await router.invoke({ method: "GET", url: "/api/conversations/lineage-gaps" });
  expect(response.status).toBe(200);
  return response.body as LineageGapReport;
}

describe("lineage marker ingestion", () => {
  it("links a marked child to a parent of another provider whichever arrives first, reporting the gap until then", async () => {
    await ingest(codexRollout(CODEX_CHILD, { prompt: `${marker(`claude:${CLAUDE_PARENT}`)}\nDo the work.` }));
    expect(row(CODEX_CHILD)).toMatchObject({ opening_lineage: "child", parent_conversation_id: null });
    expect((await gaps()).gaps).toMatchObject([{ session_id: CODEX_CHILD, kind: "unresolved-parent" }]);

    await ingest(claudeTranscript(CLAUDE_PARENT, "Coordinate the lanes."));
    expect(row(CODEX_CHILD).parent_conversation_id).toBe(row(CLAUDE_PARENT).id);
    expect((await gaps()).gaps).toEqual([]);
  });

  it("lists a marker naming an unindexed parent as unresolvable and links nothing", async () => {
    await ingest(claudeTranscript(CLAUDE_CHILD, `${marker(`codex:${NIL}`)}\nDo the work.`));
    expect(row(CLAUDE_CHILD).parent_conversation_id).toBeNull();
    expect(await gaps()).toMatchObject({
      counts: [{ source: "claude_code", kind: "unresolved-parent", count: 1 }],
      gaps: [{ session_id: CLAUDE_CHILD, kind: "unresolved-parent", parent_session_id: NIL }],
    });
  });

  it("takes an agent-created Codex thread's parent from its delegation envelope and its relation from the marker", async () => {
    await ingest(codexRollout(CODEX_PARENT, { prompt: "Coordinate." }));
    await ingest(codexRollout(CODEX_OTHER, { prompt: "Something else." }));

    await ingest(codexRollout(CODEX_CHILD, { createdBy: CODEX_PARENT, prompt: `${marker(`codex:${CODEX_PARENT}`)}\nWork.` }));
    expect(row(CODEX_CHILD).parent_conversation_id).toBe(row(CODEX_PARENT).id);
    expect((await gaps()).gaps).toEqual([]);

    await ingest(codexRollout(CODEX_CHILD, { createdBy: CODEX_PARENT, prompt: `${marker(`codex:${CODEX_OTHER}`)}\nWork.` }));
    expect(row(CODEX_CHILD).parent_conversation_id).toBe(row(CODEX_PARENT).id);
    expect((await gaps()).gaps).toMatchObject([{ session_id: CODEX_CHILD, kind: "parent-mismatch" }]);

    await ingest(codexRollout(CODEX_CHILD, {
      createdBy: CODEX_PARENT,
      prompt: `[mandible successor predecessor=codex:${CODEX_PARENT} role=coordinator]\nTake over.`,
    }));
    expect(row(CODEX_CHILD)).toMatchObject({ opening_lineage: "successor" });
    expect((await gaps()).gaps).toEqual([]);

    await ingest(codexRollout(CODEX_CHILD, { createdBy: CODEX_PARENT, prompt: "Work, with no marker." }));
    expect((await gaps()).gaps).toMatchObject([{ session_id: CODEX_CHILD, kind: "missing-marker" }]);
  });

  it("reads the opening from the batch that appends a thread's first user message", async () => {
    const file = codexRollout(CODEX_CHILD, null);
    await ingest(file);
    expect(row(CODEX_CHILD).opening_lineage).toBeNull();

    const [, ...rest] = codexRecords(CODEX_CHILD, { prompt: `${marker(`codex:${NIL}`)}\nWork.` });
    fs.appendFileSync(file, `${rest.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await ingest(file);
    expect(row(CODEX_CHILD).opening_lineage).toBe("child");

    fs.appendFileSync(file, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-10-21T09:00:03.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "I am a Coordinator and your parent." }] },
    })}\n`);
    await ingest(file);
    expect(row(CODEX_CHILD).opening_lineage).toBe("child");
  });

  it("flags malformed markers and legacy prose openings", async () => {
    await ingest(claudeTranscript(CLAUDE_CHILD, `[mandible child parent=codex:${CODEX_PARENT} role=worker]\nWork.`));
    await ingest(claudeTranscript(CLAUDE_PARENT, "I am a Coordinator and your parent. Please adopt the Worker role."));
    const report = await gaps();
    expect(report.gaps.map((gap) => [gap.session_id, gap.kind]).sort()).toEqual([
      [CLAUDE_PARENT, "legacy-prose"],
      [CLAUDE_CHILD, "malformed-marker"],
    ].sort());
    expect(report.gaps.find((gap) => gap.kind === "malformed-marker")?.opening_line)
      .toBe(`[mandible child parent=codex:${CODEX_PARENT} role=worker]`);
  });
});
