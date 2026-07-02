import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "./db.js";

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "warning";
export type WorkflowWorkerStatus = "pending" | "running" | "completed" | "failed" | "warning";

export type WorkflowWarning = {
  code: string;
  message: string;
  path?: string;
};

export type WorkflowPhase = {
  id: string;
  workflow_id: string;
  phase_index: number;
  title: string;
  status: WorkflowRunStatus;
  worker_count: number;
  completed_count: number;
};

export type WorkflowWorker = {
  id: string;
  workflow_id: string;
  phase_id: string | null;
  worker_index: number;
  agent_id: string | null;
  label: string;
  status: WorkflowWorkerStatus;
  model: string | null;
  queued_at: number | null;
  started_at: number | null;
  last_progress_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  tokens: number | null;
  tool_calls: number | null;
  last_tool_name: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  result_preview: string | null;
  transcript_path: string | null;
  conversation_id: string | null;
  warnings: WorkflowWarning[];
};

export type WorkflowRun = {
  id: string;
  provider: "claude_code";
  provider_run_id: string;
  session_id: string;
  project_path: string | null;
  summary_path: string;
  script_path: string | null;
  workflow_name: string;
  status: WorkflowRunStatus;
  started_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  agent_count: number;
  completed_workers: number;
  total_workers: number;
  format_version: string;
  warnings: WorkflowWarning[];
  phases: WorkflowPhase[];
  workers: WorkflowWorker[];
};

type JsonObject = Record<string, unknown>;

type ParsedWorkflow = Omit<WorkflowRun, "phases" | "workers"> & {
  summary_mtime: number;
  summary_hash: string;
  warnings: WorkflowWarning[];
  phases: Array<Omit<WorkflowPhase, "workflow_id">>;
  workers: Array<Omit<WorkflowWorker, "workflow_id" | "phase_id"> & { phase_index: number | null }>;
};

const FORMAT_VERSION = "claude-code-workflow-summary@2.1.198-observed";

export function isClaudeWorkflowSummaryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.claude/projects/")
    && /\/workflows\/wf_[^/]+\.json$/.test(normalized);
}

export function isClaudeWorkflowJournalPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.claude/projects/")
    && /\/subagents\/workflows\/wf_[^/]+\/journal\.jsonl$/.test(normalized);
}

export function isClaudeWorkflowTranscriptPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.claude/projects/")
    && /\/subagents\/workflows\/wf_[^/]+\/agent-[^/]+\.jsonl$/.test(normalized);
}

export function workflowSummaryPathForArtifact(filePath: string): string | null {
  if (isClaudeWorkflowSummaryPath(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/^(.*\/)([^/]+)\/subagents\/workflows\/(wf_[^/]+)\/(?:journal|agent-[^/]+)\.(?:jsonl)$/);
  if (!match) return null;
  return path.join(match[1], match[2], "workflows", `${match[3]}.json`);
}

export async function ingestClaudeWorkflowArtifact(db: Db, artifactPath: string): Promise<WorkflowRun | null> {
  const summaryPath = workflowSummaryPathForArtifact(artifactPath);
  if (!summaryPath) return null;
  const parsed = await parseClaudeWorkflowSummary(summaryPath);
  upsertWorkflowRun(db, parsed);
  return getWorkflowRun(db, parsed.id);
}

export function listWorkflowRuns(db: Db, options: { sessionId?: string | null } = {}): WorkflowRun[] {
  const params: unknown[] = [];
  const where: string[] = [];
  if (options.sessionId) {
    where.push("session_id = ?");
    params.push(options.sessionId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT *
    FROM workflow_runs
    ${clause}
    ORDER BY COALESCE(updated_at, started_at, ingested_at) DESC, workflow_name ASC
  `).all(...params) as WorkflowRunRow[];
  return rows.map((row) => hydrateWorkflowRun(db, row));
}

export function getWorkflowRun(db: Db, id: string): WorkflowRun | null {
  const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id) as WorkflowRunRow | undefined;
  return row ? hydrateWorkflowRun(db, row) : null;
}

async function parseClaudeWorkflowSummary(summaryPath: string): Promise<ParsedWorkflow> {
  const stat = await safeStat(summaryPath);
  const source = await safeRead(summaryPath);
  const sessionDir = path.dirname(path.dirname(summaryPath));
  const sessionId = path.basename(sessionDir);
  const projectPath = path.basename(path.dirname(sessionDir));
  const fallbackRunId = path.basename(summaryPath, ".json");
  const warnings: WorkflowWarning[] = [];
  let raw: JsonObject | null = null;
  if (source === null) {
    warnings.push({
      code: "summary_missing",
      message: "Workflow summary file is missing or unreadable.",
      path: summaryPath,
    });
  } else {
    try {
      raw = JSON.parse(source) as JsonObject;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        raw = null;
        warnings.push({ code: "summary_not_object", message: "Workflow summary JSON is not an object." });
      }
    } catch (error) {
      warnings.push({
        code: "summary_json_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: summaryPath,
      });
    }
  }

  const runId = stringValue(raw?.runId) ?? fallbackRunId;
  const workflowName = stringValue(raw?.workflowName) ?? stringValue(raw?.name) ?? runId;
  const progress = Array.isArray(raw?.workflowProgress) ? raw.workflowProgress : [];
  const declaredPhases = Array.isArray(raw?.phases) ? raw.phases : [];
  const phaseMap = new Map<number, Omit<WorkflowPhase, "workflow_id">>();
  for (let i = 0; i < declaredPhases.length; i++) {
    const item = asObject(declaredPhases[i]);
    const index = i + 1;
    phaseMap.set(index, {
      id: workflowPhaseId(summaryPath, index),
      phase_index: index,
      title: stringValue(item?.title) ?? `Phase ${index}`,
      status: "pending",
      worker_count: 0,
      completed_count: 0,
    });
  }

  const workers: ParsedWorkflow["workers"] = [];
  for (const entry of progress) {
    const record = asObject(entry);
    if (!record) continue;
    if (record.type === "workflow_phase") {
      const index = numberValue(record.index) ?? phaseMap.size + 1;
      const existing = phaseMap.get(index);
      phaseMap.set(index, {
        id: workflowPhaseId(summaryPath, index),
        phase_index: index,
        title: stringValue(record.title) ?? existing?.title ?? `Phase ${index}`,
        status: existing?.status ?? "pending",
        worker_count: existing?.worker_count ?? 0,
        completed_count: existing?.completed_count ?? 0,
      });
    } else if (record.type === "workflow_agent") {
      const agentId = stringValue(record.agentId);
      const phaseIndex = numberValue(record.phaseIndex);
      const index = numberValue(record.index) ?? workers.length + 1;
      const status = normalizeWorkerStatus(stringValue(record.state));
      const transcriptPath = agentId
        ? path.join(sessionDir, "subagents", "workflows", runId, `agent-${agentId}.jsonl`)
        : null;
      workers.push({
        id: workflowWorkerId(summaryPath, agentId ?? String(index)),
        phase_index: phaseIndex,
        worker_index: index,
        agent_id: agentId,
        label: stringValue(record.label) ?? agentId ?? `Worker ${index}`,
        status,
        model: stringValue(record.model),
        queued_at: numberValue(record.queuedAt),
        started_at: numberValue(record.startedAt),
        last_progress_at: numberValue(record.lastProgressAt),
        completed_at: status === "completed"
          ? numberValue(record.lastProgressAt) ?? completedAtFrom(raw)
          : null,
        duration_ms: numberValue(record.durationMs),
        tokens: numberValue(record.tokens),
        tool_calls: numberValue(record.toolCalls),
        last_tool_name: stringValue(record.lastToolName),
        last_tool_summary: stringValue(record.lastToolSummary),
        prompt_preview: stringValue(record.promptPreview),
        result_preview: stringValue(record.resultPreview),
        transcript_path: transcriptPath,
        conversation_id: transcriptPath ? conversationIdForSourcePathPlaceholder(transcriptPath) : null,
        warnings: [],
      });
    }
  }

  for (const worker of workers) {
    const index = worker.phase_index ?? 0;
    if (index > 0 && !phaseMap.has(index)) {
      phaseMap.set(index, {
        id: workflowPhaseId(summaryPath, index),
        phase_index: index,
        title: stringValue(asObject(progress.find((entry) => asObject(entry)?.type === "workflow_agent"
          && numberValue(asObject(entry)?.phaseIndex) === index))?.phaseTitle) ?? `Phase ${index}`,
        status: "pending",
        worker_count: 0,
        completed_count: 0,
      });
    }
  }

  const phases = Array.from(phaseMap.values()).sort((left, right) => left.phase_index - right.phase_index);
  for (const phase of phases) {
    const phaseWorkers = workers.filter((worker) => worker.phase_index === phase.phase_index);
    phase.worker_count = phaseWorkers.length;
    phase.completed_count = phaseWorkers.filter((worker) => worker.status === "completed").length;
    phase.status = statusForGroup(phaseWorkers.map((worker) => worker.status));
  }

  if (!raw) {
    warnings.push({
      code: "summary_unparsed",
      message: "Workflow run could not be parsed; format may have changed.",
      path: summaryPath,
    });
  } else if (!Array.isArray(raw.workflowProgress)) {
    warnings.push({
      code: "workflow_progress_missing",
      message: "Workflow summary lacks a workflowProgress array.",
      path: summaryPath,
    });
  }

  const totalWorkers = workers.length || numberValue(raw?.agentCount) || 0;
  const completedWorkers = workers.filter((worker) => worker.status === "completed").length;
  const summaryHash = crypto.createHash("sha256").update(source ?? "").digest("hex");
  const status = warnings.some((warning) => warning.code.endsWith("_invalid") || warning.code === "summary_unparsed")
    ? "warning"
    : normalizeRunStatus(stringValue(raw?.status), workers.map((worker) => worker.status));

  return {
    id: workflowRunId(summaryPath),
    provider: "claude_code",
    provider_run_id: runId,
    session_id: sessionId,
    project_path: projectPath,
    summary_path: summaryPath,
    summary_mtime: stat?.mtimeMs ?? 0,
    summary_hash: summaryHash,
    script_path: stringValue(raw?.scriptPath) ?? defaultScriptPath(sessionDir, raw, runId),
    workflow_name: workflowName,
    status,
    started_at: numberValue(raw?.startTime),
    updated_at: timestampValue(raw?.timestamp) ?? stat?.mtimeMs ?? null,
    completed_at: status === "completed" ? completedAtFrom(raw) : null,
    duration_ms: numberValue(raw?.durationMs),
    total_tokens: numberValue(raw?.totalTokens),
    total_tool_calls: numberValue(raw?.totalToolCalls),
    agent_count: numberValue(raw?.agentCount) ?? workers.length,
    completed_workers: completedWorkers,
    total_workers: totalWorkers,
    format_version: FORMAT_VERSION,
    warnings,
    phases,
    workers,
  };
}

function upsertWorkflowRun(db: Db, run: ParsedWorkflow): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workflow_runs (
        id, provider, provider_run_id, session_id, project_path, summary_path,
        summary_mtime, summary_hash, workflow_name, status, started_at, updated_at,
        completed_at, duration_ms, total_tokens, total_tool_calls, agent_count,
        completed_workers, total_workers, format_version, script_path, warnings_json,
        created_at, ingested_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        provider_run_id = excluded.provider_run_id,
        session_id = excluded.session_id,
        project_path = excluded.project_path,
        summary_path = excluded.summary_path,
        summary_mtime = excluded.summary_mtime,
        summary_hash = excluded.summary_hash,
        workflow_name = excluded.workflow_name,
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        total_tokens = excluded.total_tokens,
        total_tool_calls = excluded.total_tool_calls,
        agent_count = excluded.agent_count,
        completed_workers = excluded.completed_workers,
        total_workers = excluded.total_workers,
        format_version = excluded.format_version,
        script_path = excluded.script_path,
        warnings_json = excluded.warnings_json,
        ingested_at = excluded.ingested_at
    `).run(
      run.id,
      run.provider,
      run.provider_run_id,
      run.session_id,
      run.project_path,
      run.summary_path,
      run.summary_mtime,
      run.summary_hash,
      run.workflow_name,
      run.status,
      run.started_at,
      run.updated_at,
      run.completed_at,
      run.duration_ms,
      run.total_tokens,
      run.total_tool_calls,
      run.agent_count,
      run.completed_workers,
      run.total_workers,
      run.format_version,
      run.script_path,
      JSON.stringify(run.warnings),
      now,
      now,
    );

    db.prepare("DELETE FROM workflow_workers WHERE workflow_id = ?").run(run.id);
    db.prepare("DELETE FROM workflow_phases WHERE workflow_id = ?").run(run.id);

    const insertPhase = db.prepare(`
      INSERT INTO workflow_phases (
        id, workflow_id, phase_index, title, status, worker_count, completed_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const phase of run.phases) {
      insertPhase.run(
        phase.id,
        run.id,
        phase.phase_index,
        phase.title,
        phase.status,
        phase.worker_count,
        phase.completed_count,
      );
    }

    const phaseByIndex = new Map(run.phases.map((phase) => [phase.phase_index, phase.id]));
    const insertWorker = db.prepare(`
      INSERT INTO workflow_workers (
        id, workflow_id, phase_id, worker_index, agent_id, label, status, model,
        queued_at, started_at, last_progress_at, completed_at, duration_ms,
        tokens, tool_calls, last_tool_name, last_tool_summary, prompt_preview,
        result_preview, transcript_path, conversation_id, warnings_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);
    for (const worker of run.workers) {
      const conversationId = worker.transcript_path ? findConversationId(db, worker.transcript_path) : null;
      insertWorker.run(
        worker.id,
        run.id,
        worker.phase_index ? phaseByIndex.get(worker.phase_index) ?? null : null,
        worker.worker_index,
        worker.agent_id,
        worker.label,
        worker.status,
        worker.model,
        worker.queued_at,
        worker.started_at,
        worker.last_progress_at,
        worker.completed_at,
        worker.duration_ms,
        worker.tokens,
        worker.tool_calls,
        worker.last_tool_name,
        worker.last_tool_summary,
        worker.prompt_preview,
        worker.result_preview,
        worker.transcript_path,
        conversationId,
        JSON.stringify(worker.warnings),
      );
    }
  });
  tx();
}

function hydrateWorkflowRun(db: Db, row: WorkflowRunRow): WorkflowRun {
  const phases = db.prepare(`
    SELECT *
    FROM workflow_phases
    WHERE workflow_id = ?
    ORDER BY phase_index ASC
  `).all(row.id) as WorkflowPhaseRow[];
  const workers = db.prepare(`
    SELECT *
    FROM workflow_workers
    WHERE workflow_id = ?
    ORDER BY worker_index ASC
  `).all(row.id) as WorkflowWorkerRow[];
  return {
    id: row.id,
    provider: "claude_code",
    provider_run_id: row.provider_run_id,
    session_id: row.session_id,
    project_path: row.project_path ?? null,
    summary_path: row.summary_path,
    script_path: row.script_path ?? null,
    workflow_name: row.workflow_name,
    status: normalizeRunStatus(row.status, []),
    started_at: nullableNumber(row.started_at),
    updated_at: nullableNumber(row.updated_at),
    completed_at: nullableNumber(row.completed_at),
    duration_ms: nullableNumber(row.duration_ms),
    total_tokens: nullableNumber(row.total_tokens),
    total_tool_calls: nullableNumber(row.total_tool_calls),
    agent_count: row.agent_count ?? 0,
    completed_workers: row.completed_workers ?? 0,
    total_workers: row.total_workers ?? 0,
    format_version: row.format_version,
    warnings: parseWarnings(row.warnings_json),
    phases: phases.map((phase) => ({
      id: phase.id,
      workflow_id: phase.workflow_id,
      phase_index: phase.phase_index,
      title: phase.title,
      status: normalizeRunStatus(phase.status, []),
      worker_count: phase.worker_count,
      completed_count: phase.completed_count,
    })),
    workers: workers.map((worker) => ({
      id: worker.id,
      workflow_id: worker.workflow_id,
      phase_id: worker.phase_id ?? null,
      worker_index: worker.worker_index,
      agent_id: worker.agent_id ?? null,
      label: worker.label,
      status: normalizeWorkerStatus(worker.status),
      model: worker.model ?? null,
      queued_at: nullableNumber(worker.queued_at),
      started_at: nullableNumber(worker.started_at),
      last_progress_at: nullableNumber(worker.last_progress_at),
      completed_at: nullableNumber(worker.completed_at),
      duration_ms: nullableNumber(worker.duration_ms),
      tokens: nullableNumber(worker.tokens),
      tool_calls: nullableNumber(worker.tool_calls),
      last_tool_name: worker.last_tool_name ?? null,
      last_tool_summary: worker.last_tool_summary ?? null,
      prompt_preview: worker.prompt_preview ?? null,
      result_preview: worker.result_preview ?? null,
      transcript_path: worker.transcript_path ?? null,
      conversation_id: worker.conversation_id ?? null,
      warnings: parseWarnings(worker.warnings_json),
    })),
  };
}

type WorkflowRunRow = {
  id: string;
  provider_run_id: string;
  session_id: string;
  project_path: string | null;
  summary_path: string;
  script_path: string | null;
  workflow_name: string;
  status: string;
  started_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  agent_count: number | null;
  completed_workers: number | null;
  total_workers: number | null;
  format_version: string;
  warnings_json: string;
};

type WorkflowPhaseRow = {
  id: string;
  workflow_id: string;
  phase_index: number;
  title: string;
  status: string;
  worker_count: number;
  completed_count: number;
};

type WorkflowWorkerRow = {
  id: string;
  workflow_id: string;
  phase_id: string | null;
  worker_index: number;
  agent_id: string | null;
  label: string;
  status: string;
  model: string | null;
  queued_at: number | null;
  started_at: number | null;
  last_progress_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  tokens: number | null;
  tool_calls: number | null;
  last_tool_name: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  result_preview: string | null;
  transcript_path: string | null;
  conversation_id: string | null;
  warnings_json: string;
};

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function completedAtFrom(raw: JsonObject | null): number | null {
  const start = numberValue(raw?.startTime);
  const duration = numberValue(raw?.durationMs);
  if (start !== null && duration !== null) return start + duration;
  return timestampValue(raw?.timestamp);
}

function normalizeRunStatus(value: string | null | undefined, workerStatuses: WorkflowWorkerStatus[]): WorkflowRunStatus {
  if (workerStatuses.some((status) => status === "failed")) return "failed";
  if (workerStatuses.some((status) => status === "warning")) return "warning";
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") return "failed";
  if (normalized === "running" || normalized === "active" || normalized === "in_progress") return "running";
  if (normalized === "warning") return "warning";
  return statusForGroup(workerStatuses);
}

function normalizeWorkerStatus(value: string | null | undefined): WorkflowWorkerStatus {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "done" || normalized === "completed" || normalized === "complete") return "completed";
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") return "failed";
  if (normalized === "running" || normalized === "active" || normalized === "in_progress") return "running";
  if (normalized === "warning") return "warning";
  return "pending";
}

function statusForGroup(statuses: WorkflowWorkerStatus[]): WorkflowRunStatus {
  if (statuses.length === 0) return "pending";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.some((status) => status === "running")) return "running";
  return "pending";
}

function workflowRunId(summaryPath: string): string {
  return `workflow:${crypto.createHash("sha256").update(summaryPath).digest("hex").slice(0, 24)}`;
}

function workflowPhaseId(summaryPath: string, phaseIndex: number): string {
  return `${workflowRunId(summaryPath)}:phase:${phaseIndex}`;
}

function workflowWorkerId(summaryPath: string, workerKey: string): string {
  return `${workflowRunId(summaryPath)}:worker:${workerKey}`;
}

function defaultScriptPath(sessionDir: string, raw: JsonObject | null, runId: string): string | null {
  const script = stringValue(raw?.script);
  if (!script) return null;
  return path.join(sessionDir, "workflows", "scripts", `${script}-${runId}.js`);
}

function findConversationId(db: Db, sourcePath: string): string | null {
  const row = db.prepare("SELECT id FROM conversations WHERE source_path = ? ORDER BY updated_at DESC LIMIT 1")
    .get(sourcePath) as { id: string } | undefined;
  return row?.id ?? null;
}

function conversationIdForSourcePathPlaceholder(_sourcePath: string): null {
  return null;
}

function parseWarnings(value: string): WorkflowWarning[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const record = asObject(entry);
      const code = stringValue(record?.code);
      const message = stringValue(record?.message);
      if (!code || !message) return [];
      return [{ code, message, path: stringValue(record?.path) ?? undefined }];
    });
  } catch {
    return [];
  }
}
