import type { Db } from "../db.js";
import type { RepoInfo } from "../work-scanner.js";
import { createLedgerId } from "./ids.js";
import type { GitBugClient } from "./git-bug-client.js";
import { exportGitBugOutbox, type GitBugExportResult } from "./git-bug-exporter.js";
import { importGitBugCheckout, type GitBugImportResult } from "./git-bug-importer.js";
import { resolveProjectForCheckout } from "./projects.js";
import type { LedgerProjectCheckout } from "./types.js";

export type LedgerSyncDirection = "import" | "export" | "full";
export type LedgerSyncJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "retryable"
  | "conflicted";

export interface LedgerSyncJob {
  id: string;
  adapter: string;
  project_id: string;
  checkout_id: string | null;
  root: string;
  direction: LedgerSyncDirection;
  status: LedgerSyncJobStatus;
  attempt_count: number;
  next_retry_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  stats_json: string;
  created_at: number;
  updated_at: number;
}

export interface RunGitBugSyncOptions {
  db: Db;
  client: GitBugClient;
  checkout: Pick<LedgerProjectCheckout, "id" | "project_id" | "root">;
  direction: LedgerSyncDirection;
}

export interface RunGitBugSyncForReposOptions {
  db: Db;
  client: GitBugClient;
  repos: RepoInfo[];
  direction: LedgerSyncDirection;
  repoRefs?: string[];
}

export interface RepoGitBugSyncResult {
  repo_id: string;
  repo_name: string;
  root: string;
  project_id?: string;
  checkout_id?: string;
  status: "completed" | "failed" | "skipped" | LedgerSyncJobStatus;
  job_id?: string;
  error?: string;
  stats?: Record<string, unknown>;
}

export interface GitBugCorpusSyncResult {
  direction: LedgerSyncDirection;
  total: number;
  completed: number;
  failed: number;
  retryable: number;
  conflicted: number;
  skipped: number;
  results: RepoGitBugSyncResult[];
}

export async function runGitBugSync(options: RunGitBugSyncOptions): Promise<LedgerSyncJob> {
  const now = Date.now();
  const jobId = createLedgerId("job", { now });
  insertJob(options.db, {
    id: jobId,
    adapter: "git_bug",
    project_id: options.checkout.project_id,
    checkout_id: options.checkout.id,
    root: options.checkout.root,
    direction: options.direction,
    status: "running",
    attempt_count: 1,
    next_retry_at: null,
    started_at: now,
    finished_at: null,
    last_error: null,
    stats_json: "{}",
    created_at: now,
    updated_at: now,
  });

  try {
    const stats: { import?: GitBugImportResult; export?: GitBugExportResult } = {};
    if (options.direction === "import" || options.direction === "full") {
      stats.import = await importGitBugCheckout({
        db: options.db,
        client: options.client,
        checkout: options.checkout,
      });
    }
    if (options.direction === "export" || options.direction === "full") {
      stats.export = await exportGitBugOutbox({
        db: options.db,
        client: options.client,
        project_id: options.checkout.project_id,
        repoRoot: options.checkout.root,
      });
    }
    const hasRetryableFailures = (stats.export?.retryable ?? 0) > 0;
    const hasFailures = (stats.export?.failed ?? 0) > 0;
    const hasConflicts =
      (stats.import?.conflicts ?? 0) > 0 ||
      (stats.export?.conflicted ?? 0) > 0;
    const status = hasRetryableFailures
      ? "retryable"
      : hasConflicts
        ? "conflicted"
        : hasFailures
          ? "failed"
          : "completed";
    updateJob(options.db, jobId, {
      status,
      finished_at: Date.now(),
      next_retry_at: hasRetryableFailures ? Date.now() + 30_000 : null,
      last_error: hasRetryableFailures
        ? "One or more git-bug export rows failed with a retryable error"
        : hasFailures
          ? "One or more git-bug export rows failed"
          : null,
      stats_json: JSON.stringify(stats),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = message.toLowerCase().includes("lock") || message.toLowerCase().includes("timed out");
    updateJob(options.db, jobId, {
      status: retryable ? "retryable" : "failed",
      finished_at: Date.now(),
      next_retry_at: retryable ? Date.now() + 30_000 : null,
      last_error: message,
    });
  }

  return getJob(options.db, jobId);
}

export async function runGitBugSyncForRepos(
  options: RunGitBugSyncForReposOptions,
): Promise<GitBugCorpusSyncResult> {
  const selected = selectRepos(options.repos, options.repoRefs);
  const results: RepoGitBugSyncResult[] = [];

  for (const repo of selected) {
    if (!repo.exists || repo.excluded) {
      results.push({
        repo_id: repo.id,
        repo_name: repo.name,
        root: repo.root,
        status: "skipped",
        error: repo.excluded ? "repo is excluded" : "repo path does not exist",
      });
      continue;
    }

    try {
      const { project, checkout } = resolveProjectForCheckout(options.db, {
        root: repo.root,
        name: repo.name,
        workRepoId: repo.id,
        defaultBranch: repo.default_branch,
      });
      const job = await runGitBugSync({
        db: options.db,
        client: options.client,
        checkout,
        direction: options.direction,
      });
      results.push({
        repo_id: repo.id,
        repo_name: repo.name,
        root: repo.root,
        project_id: project.id,
        checkout_id: checkout.id,
        status: job.status,
        job_id: job.id,
        error: job.last_error ?? undefined,
        stats: parseStats(job.stats_json),
      });
    } catch (error) {
      results.push({
        repo_id: repo.id,
        repo_name: repo.name,
        root: repo.root,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summarizeCorpusSync(options.direction, results);
}

export function listLedgerSyncJobs(
  db: Db,
  filters: { adapter?: string; status?: LedgerSyncJobStatus } = {},
): LedgerSyncJob[] {
  if (filters.adapter && filters.status) {
    return db.prepare(
      `SELECT * FROM ledger_sync_jobs
       WHERE adapter = ? AND status = ?
       ORDER BY updated_at DESC`,
    ).all(filters.adapter, filters.status) as LedgerSyncJob[];
  }
  if (filters.adapter) {
    return db.prepare(
      "SELECT * FROM ledger_sync_jobs WHERE adapter = ? ORDER BY updated_at DESC",
    ).all(filters.adapter) as LedgerSyncJob[];
  }
  return db.prepare("SELECT * FROM ledger_sync_jobs ORDER BY updated_at DESC").all() as LedgerSyncJob[];
}

function insertJob(db: Db, job: LedgerSyncJob): void {
  db.prepare(
    `INSERT INTO ledger_sync_jobs (
      id, adapter, project_id, checkout_id, root, direction, status,
      attempt_count, next_retry_at, started_at, finished_at, last_error,
      stats_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.adapter,
    job.project_id,
    job.checkout_id,
    job.root,
    job.direction,
    job.status,
    job.attempt_count,
    job.next_retry_at,
    job.started_at,
    job.finished_at,
    job.last_error,
    job.stats_json,
    job.created_at,
    job.updated_at,
  );
}

function updateJob(db: Db, id: string, patch: Partial<LedgerSyncJob>): void {
  const current = getJob(db, id);
  db.prepare(
    `UPDATE ledger_sync_jobs
     SET status = ?, next_retry_at = ?, finished_at = ?, last_error = ?,
         stats_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    "next_retry_at" in patch ? patch.next_retry_at ?? null : current.next_retry_at,
    "finished_at" in patch ? patch.finished_at ?? null : current.finished_at,
    "last_error" in patch ? patch.last_error ?? null : current.last_error,
    patch.stats_json ?? current.stats_json,
    Date.now(),
    id,
  );
}

function getJob(db: Db, id: string): LedgerSyncJob {
  const row = db.prepare("SELECT * FROM ledger_sync_jobs WHERE id = ?").get(id) as LedgerSyncJob | undefined;
  if (!row) throw new Error(`Ledger sync job not found: ${id}`);
  return row;
}

function selectRepos(repos: RepoInfo[], repoRefs: string[] | undefined): RepoInfo[] {
  if (!repoRefs || repoRefs.length === 0) return repos;
  const wanted = new Set(repoRefs);
  return repos.filter((repo) =>
    wanted.has(repo.id) ||
    wanted.has(repo.name) ||
    wanted.has(repo.root)
  );
}

function summarizeCorpusSync(
  direction: LedgerSyncDirection,
  results: RepoGitBugSyncResult[],
): GitBugCorpusSyncResult {
  let completed = 0;
  let failed = 0;
  let retryable = 0;
  let conflicted = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.status === "completed") completed++;
    else if (result.status === "retryable") retryable++;
    else if (result.status === "conflicted") conflicted++;
    else if (result.status === "skipped") skipped++;
    else if (result.status === "failed") failed++;
  }
  return {
    direction,
    total: results.length,
    completed,
    failed,
    retryable,
    conflicted,
    skipped,
    results,
  };
}

function parseStats(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
