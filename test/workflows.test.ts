import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { triggerReconcileForTest, triggerTargetedIngest } from "../src/ingestion.js";
import { registerWorkflowRoutes } from "../src/routes/workflows.js";
import { Router } from "../src/server.js";
import { ingestClaudeWorkflowArtifact, listWorkflowRuns } from "../src/workflows.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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

function journalPath(runId = "wf_fixture-123"): string {
  return path.join(
    tempDir,
    ".claude",
    "projects",
    "-tmp-project",
    sessionId,
    "subagents",
    "workflows",
    runId,
    "journal.jsonl",
  );
}

function workflowWatchConfigs(): Array<{ base: string; glob: string }> {
  const base = path.join(tempDir, ".claude", "projects");
  return [
    { base, glob: "**/*.jsonl" },
    { base, glob: "**/workflows/wf_*.json" },
  ];
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

function writeWorkflowJournal(runId = "wf_fixture-123"): void {
  const filePath = journalPath(runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ event: "workflow_started", runId })}\n`, "utf8");
}

function touch(filePath: string, tick: number): void {
  const date = new Date(1_800_000_000_000 + tick * 1000);
  fs.utimesSync(filePath, date, date);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-workflows-"));
  db = migratedMemoryDb();
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

  it("lets targeted ingest handle workflow summary artifacts", async () => {
    writeWorkflowSummary();
    touch(summaryPath(), 1);

    await expect(triggerTargetedIngest({ transcriptPath: summaryPath(), now: 1_000 })).resolves.toMatchObject({
      status: "ingested",
      transcript_path: summaryPath(),
    });

    expect(listWorkflowRuns(db, { sessionId })).toHaveLength(1);
    expect(
      db.prepare("SELECT file_path, source_mtime FROM workflow_ingest_state WHERE file_path = ?")
        .get(summaryPath()),
    ).toMatchObject({ file_path: summaryPath(), source_mtime: fs.statSync(summaryPath()).mtimeMs });
  });

  it("skips unchanged workflow summary and journal artifacts during reconcile", async () => {
    writeWorkflowSummary();
    writeWorkflowJournal();
    touch(summaryPath(), 1);
    touch(journalPath(), 1);

    const logs: Array<{ event: string; file: string | null }> = [];
    const log = (_level: string, event: string, fields?: Record<string, unknown>) => {
      if (event === "workflow_ingestion_complete") {
        logs.push({ event, file: typeof fields?.file === "string" ? fields.file : null });
      }
    };

    await triggerReconcileForTest({ watchConfigs: workflowWatchConfigs(), log });
    expect(logs.map((entry) => entry.file).sort()).toEqual([journalPath(), summaryPath()].sort());
    expect(db.prepare("SELECT COUNT(*) AS count FROM workflow_ingest_state").get()).toMatchObject({
      count: 2,
    });

    logs.length = 0;
    await triggerReconcileForTest({ watchConfigs: workflowWatchConfigs(), log });
    expect(logs).toEqual([]);

    touch(summaryPath(), 2);
    await triggerReconcileForTest({ watchConfigs: workflowWatchConfigs(), log });
    expect(logs.map((entry) => entry.file)).toEqual([summaryPath()]);

    logs.length = 0;
    touch(journalPath(), 3);
    await triggerReconcileForTest({ watchConfigs: workflowWatchConfigs(), log });
    expect(logs.map((entry) => entry.file)).toEqual([journalPath()]);
  });
});
