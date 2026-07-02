import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { registerWorkflowRoutes } from "../src/routes/workflows.js";
import { Router } from "../src/server.js";
import { ingestClaudeWorkflowArtifact, listWorkflowRuns } from "../src/workflows.js";

let tempDir = "";
let db: Db;

const sessionId = "55555555-5555-4555-8555-555555555555";

function summaryPath(runId = "wf_fixture-123"): string {
  return path.join(tempDir, ".claude", "projects", "-tmp-project", sessionId, "workflows", `${runId}.json`);
}

function transcriptPath(runId: string, agentId: string): string {
  return path.join(
    tempDir,
    ".claude",
    "projects",
    "-tmp-project",
    sessionId,
    "subagents",
    "workflows",
    runId,
    `agent-${agentId}.jsonl`,
  );
}

function writeWorkflowSummary(): void {
  const runId = "wf_fixture-123";
  const filePath = summaryPath(runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    runId,
    workflowName: "fixture-workflow",
    status: "completed",
    startTime: 1782425622775,
    timestamp: "2026-06-25T22:18:00.433Z",
    durationMs: 257657,
    totalTokens: 1234,
    totalToolCalls: 7,
    agentCount: 3,
    phases: [
      { title: "Investigate" },
      { title: "Synthesize" },
    ],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Investigate" },
      {
        type: "workflow_agent",
        index: 1,
        label: "reader",
        phaseIndex: 1,
        phaseTitle: "Investigate",
        agentId: "aaa",
        model: "claude-opus",
        state: "done",
        startedAt: 1782425622792,
        lastProgressAt: 1782425744846,
        tokens: 600,
        toolCalls: 3,
        durationMs: 122054,
        resultPreview: "reader done",
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "checker",
        phaseIndex: 1,
        phaseTitle: "Investigate",
        agentId: "bbb",
        state: "failed",
        tokens: 200,
      },
      { type: "workflow_phase", index: 2, title: "Synthesize" },
      {
        type: "workflow_agent",
        index: 3,
        label: "writer",
        phaseIndex: 2,
        phaseTitle: "Synthesize",
        agentId: "ccc",
        state: "done",
        tokens: 434,
      },
    ],
  }), "utf8");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-workflows-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("workflow run ingestion", () => {
  it("parses observed Claude Code workflow summaries into phases and workers", async () => {
    writeWorkflowSummary();
    const transcript = transcriptPath("wf_fixture-123", "aaa");
    db.prepare(
      `INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        session_id, created_at, updated_at
      ) VALUES (?, 'claude_code', ?, 'hash', 0, 'reader', ?, 'child-aaa', ?, ?)`,
    ).run(
      "conv-aaa",
      transcript,
      "2026-06-25T22:13:42.792Z",
      "2026-06-25T22:13:42.792Z",
      "2026-06-25T22:13:42.792Z",
    );

    const workflow = await ingestClaudeWorkflowArtifact(db, summaryPath("wf_fixture-123"));

    expect(workflow).toMatchObject({
      workflow_name: "fixture-workflow",
      session_id: sessionId,
      total_tokens: 1234,
      total_workers: 3,
      completed_workers: 2,
      phases: [
        expect.objectContaining({ title: "Investigate", worker_count: 2, completed_count: 1 }),
        expect.objectContaining({ title: "Synthesize", worker_count: 1, completed_count: 1 }),
      ],
    });
    expect(workflow?.workers).toEqual([
      expect.objectContaining({ label: "reader", status: "completed", tokens: 600, conversation_id: "conv-aaa" }),
      expect.objectContaining({ label: "checker", status: "failed", tokens: 200 }),
      expect.objectContaining({ label: "writer", status: "completed", tokens: 434 }),
    ]);

    const runs = listWorkflowRuns(db, { sessionId });
    expect(runs).toHaveLength(1);
    expect(runs[0].provider_run_id).toBe("wf_fixture-123");
  });

  it("stores corrupt workflow summaries as warning rows", async () => {
    const filePath = summaryPath("wf_broken");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ bad json", "utf8");

    const workflow = await ingestClaudeWorkflowArtifact(db, filePath);

    expect(workflow).toMatchObject({
      provider_run_id: "wf_broken",
      workflow_name: "wf_broken",
      status: "warning",
      total_workers: 0,
    });
    expect(workflow?.warnings.map((warning) => warning.code)).toContain("summary_json_invalid");

    const router = new Router();
    registerWorkflowRoutes(router);
    const response = await router.invoke({ method: "GET", url: `/api/workflows?session_id=${sessionId}` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workflows: [
        expect.objectContaining({
          provider_run_id: "wf_broken",
          warnings: expect.arrayContaining([expect.objectContaining({ code: "summary_json_invalid" })]),
        }),
      ],
    });
  });
});
