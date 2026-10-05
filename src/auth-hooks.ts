/**
 * Auth hooks — configurable post-auth-action hooks.
 *
 * Replaces the hardcoded build_dist_if_src_changed / restart_mandible_if_dist_changed
 * logic that was previously in auth-merge.sh. Hooks are stored in the auth_hooks
 * table and executed after successful auth actions (merge, commit, etc.).
 *
 * Bug: 4afab83
 *
 * Issue 27241e6 — hook execution is durable, bounded, and honest:
 *
 *   - Execution state lives in `auth_hook_executions`, one row per
 *     (auth request, hook), written BEFORE the process is spawned. A daemon
 *     that dies between the merge and hook completion therefore leaves a
 *     durable record of unfinished convergence instead of losing it.
 *   - Each row snapshots the hook id and the exact command bytes plus their
 *     SHA-256 digest at the moment execution begins. A retry reruns those
 *     snapshotted bytes — it never reruns the merge, and it never silently
 *     substitutes a command the operator edited afterwards.
 *   - Execution is at-least-once with a bounded attempt budget. The row is the
 *     idempotency key: planning is INSERT OR IGNORE, so a resumed sweep adopts
 *     an existing row rather than starting a second run of the same hook.
 *   - The child process receives a scrubbed allowlist environment, never the
 *     daemon's full ambient `process.env`.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";

import { extractSuccessfulMergeCommitSha } from "./auth-signature-verification.js";
import { getDb } from "./db.js";
import type { Db } from "./db.js";
import type {
  AuthConvergence,
  AuthConvergenceHookSummary,
  AuthConvergenceState,
  AuthHook,
  AuthHookAlert,
  AuthHookExecutionResult,
  AuthHookInput,
  AuthHookRun,
  AuthHookRunAttempt,
  AuthHookRunState,
  AuthRequest,
  AuthRequestType,
} from "./types.js";

export type { AuthHookExecutionResult };

// Most hooks should finish quickly. The built-in Mandible hook may perform a
// cold Rust/Tauri release build after native changes, so it gets a deliberate
// longer ceiling instead of being killed halfway through bundle production.
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const MANDIBLE_REBUILD_HOOK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Issue 27241e6 — attempt budget for one (request, hook) pair. Three attempts
 * covers the realistic transient failures (a busy lock, a host that was mid
 * restart) without turning a genuinely broken hook into an unbounded retry
 * loop that never surfaces to the operator.
 */
export const AUTH_HOOK_MAX_ATTEMPTS = 3;

/** Persisted hook output is bounded so one runaway hook cannot bloat the DB. */
const MAX_PERSISTED_OUTPUT_CHARS = 64 * 1024;

export function authHookTimeoutMs(hookId: string): number {
  return hookId === "builtin-mandible-rebuild"
    ? MANDIBLE_REBUILD_HOOK_TIMEOUT_MS
    : DEFAULT_HOOK_TIMEOUT_MS;
}

// --- Execution environment contract (issue 27241e6) ---------------------------

/**
 * The only ambient variables a hook inherits. Everything else the daemon holds
 * — tokens, provider credentials, session ids, editor and shell customization,
 * `MANDIBLE_*` daemon configuration — is deliberately dropped, because a hook
 * command is operator-registered but not operator-supervised at run time.
 *
 * A hook that needs anything beyond this list must resolve it itself from the
 * repository it runs in, or the operator must widen this list deliberately.
 */
export const AUTH_HOOK_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/**
 * PATH is controlled rather than inherited: an inherited PATH lets whatever
 * launched the daemon decide which `git`, `node`, or `npm` a protected-merge
 * finalizer executes.
 */
export const AUTH_HOOK_BASE_PATH = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

/** Setting key an operator can use to replace the controlled hook PATH. */
export const AUTH_HOOK_PATH_SETTING = "auth_hooks.path";

export function authHookPath(db: Db | null, homeDir: string): string {
  const override = readSettingValue(db, AUTH_HOOK_PATH_SETTING);
  if (override && override.trim()) {
    return override.trim();
  }
  const userBins = homeDir
    ? [`${homeDir}/.local/bin`, `${homeDir}/.cargo/bin`, `${homeDir}/bin`]
    : [];
  return [...userBins, AUTH_HOOK_BASE_PATH].join(":");
}

function readSettingValue(db: Db | null, key: string): string | null {
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

export interface AuthHookEnvContext {
  hook_id: string;
  hook_label: string;
  attempt: number;
  execution_id: string;
  command_digest: string;
}

/**
 * Build the scrubbed environment for one hook attempt. Callers must never merge
 * `process.env` into the result — the whole point of this function is that the
 * hook contract is an explicit allowlist plus the documented MANDIBLE_* facts.
 */
export function buildAuthHookEnv(
  request: AuthRequest,
  context: AuthHookEnvContext,
  options: { db?: Db | null; source?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const key of AUTH_HOOK_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  if (!env.HOME) {
    // A hook with no HOME cannot resolve `~/.local/bin` or a git config; fall
    // back to the process owner's home rather than handing it an empty string.
    try {
      env.HOME = os.homedir();
    } catch {
      /* no home resolvable — leave unset */
    }
  }
  env.PATH = authHookPath(options.db ?? null, env.HOME ?? "");
  // A finalizer is non-interactive by construction; say so rather than letting
  // a hook inherit an interactive terminal's capabilities.
  env.TERM = "dumb";
  env.CI = "true";

  env.MANDIBLE_AUTH_REQUEST_ID = request.id;
  env.MANDIBLE_AUTH_TYPE = request.type;
  env.MANDIBLE_AUTH_REPO = request.repo ?? "";
  env.MANDIBLE_AUTH_BRANCH = request.head_branch ?? "";
  env.MANDIBLE_AUTH_BASE_BRANCH = request.base_branch ?? "";
  // These reviewed revisions stay stable after the protected checkout moves
  // on. Post-merge hooks must use them instead of retry-time HEAD when deciding
  // which convergence work the original merge required.
  env.MANDIBLE_AUTH_MERGE_BASE_SHA = request.merge_preflight_base_sha ?? "";
  env.MANDIBLE_AUTH_MERGE_HEAD_SHA = request.merge_head_sha ?? "";
  env.MANDIBLE_AUTH_MERGE_COMMIT_SHA = extractSuccessfulMergeCommitSha(request.output) ?? "";
  env.MANDIBLE_HOOK_ID = context.hook_id;
  env.MANDIBLE_HOOK_LABEL = context.hook_label;
  env.MANDIBLE_HOOK_ATTEMPT = String(context.attempt);
  env.MANDIBLE_HOOK_EXECUTION_ID = context.execution_id;
  env.MANDIBLE_HOOK_COMMAND_DIGEST = context.command_digest;
  return env;
}

export function authHookCommandDigest(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// --- Convergence projection ---------------------------------------------------

/**
 * Issue 27241e6 — the honest answer to "is this merge live?".
 *
 *   none      — no hook was registered for this request; merged is all there is
 *   complete  — every planned hook run reached `complete`
 *   failed    — a required hook exhausted its attempts
 *   pending   — a run is still runnable (never attempted, or retryable)
 *
 * `failed` outranks `pending`: once a required hook is terminally failed the
 * request is not going to converge on its own, and saying "pending" would be
 * the same dishonesty this issue exists to remove.
 */
export function convergenceStateFromRuns(runs: readonly AuthHookRun[]): AuthConvergenceState {
  if (runs.length === 0) return "none";
  if (runs.some((run) => run.required && run.state === "failed")) return "failed";
  if (runs.some((run) => run.state === "pending" || run.state === "running")) return "pending";
  return "complete";
}

export function summarizeConvergenceRun(run: AuthHookRun): AuthConvergenceHookSummary {
  return {
    hook_id: run.hook_id,
    label: run.hook_label,
    state: run.state,
    required: run.required,
    attempts: run.attempts,
    max_attempts: run.max_attempts,
    exit_code: run.exit_code,
    command_digest: run.command_digest,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

export class AuthHookManager {
  private readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /**
   * Find all enabled hooks matching a given repo name and auth type.
   * Matching rules:
   * - repo_pattern "*" matches all repos
   * - Otherwise, exact match against the repo name
   * - auth_type must match exactly
   */
  findMatchingHooks(repoName: string | undefined, authType: AuthRequestType): AuthHook[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hooks
         WHERE enabled = 1
           AND auth_type = ?
           AND (repo_pattern = '*' OR repo_pattern = ?)
         ORDER BY position ASC, created_at ASC`
      )
      .all(authType, repoName ?? "") as Record<string, unknown>[];

    return rows.map(mapHookRow);
  }

  // --- Durable execution state ------------------------------------------------

  private hasDurableTables(): boolean {
    try {
      const row = this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_hook_executions'",
        )
        .get() as { present?: number } | undefined;
      return row?.present === 1;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the matching hooks for this request into durable rows. Idempotent:
   * an existing row for (request, hook) wins, so replanning after a crash
   * adopts the in-progress record and its attempt count rather than resetting
   * the attempt budget.
   */
  planRuns(request: AuthRequest, additionalHooks: AuthHook[] = []): AuthHookRun[] {
    if (!this.hasDurableTables()) return [];
    const hooks = [...additionalHooks, ...this.findMatchingHooks(request.repo, request.type)];
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO auth_hook_executions (
         id, auth_request_id, hook_id, hook_label, command, command_digest,
         position, required, state, attempts, max_attempts, exit_code, output,
         attempt_history, started_at, finished_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, '', '[]', NULL, NULL, ?, ?)`,
    );
    const plan = this.db.transaction((entries: AuthHook[]) => {
      for (const hook of entries) {
        insert.run(
          randomUUID(),
          request.id,
          hook.id,
          hook.label,
          hook.command,
          authHookCommandDigest(hook.command),
          hook.position,
          hook.required ? 1 : 0,
          AUTH_HOOK_MAX_ATTEMPTS,
          now,
          now,
        );
      }
    });
    plan(hooks);
    return this.listRuns(request.id);
  }

  listRuns(authRequestId: string): AuthHookRun[] {
    if (!this.hasDurableTables()) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hook_executions
         WHERE auth_request_id = ?
         ORDER BY position ASC, created_at ASC`,
      )
      .all(authRequestId) as Record<string, unknown>[];
    return rows.map(mapRunRow);
  }

  getRun(authRequestId: string, hookId: string): AuthHookRun | null {
    if (!this.hasDurableTables()) return null;
    const row = this.db
      .prepare("SELECT * FROM auth_hook_executions WHERE auth_request_id = ? AND hook_id = ?")
      .get(authRequestId, hookId) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : null;
  }

  convergence(authRequestId: string): AuthConvergence {
    const runs = this.listRuns(authRequestId);
    return {
      state: convergenceStateFromRuns(runs),
      hooks: runs.map(summarizeConvergenceRun),
    };
  }

  /**
   * Auth request ids with at least one runnable hook row. Used by the daemon's
   * startup and periodic sweeps to resume convergence lost to a crash.
   */
  listRequestIdsWithRunnableHooks(limit = 50): string[] {
    if (!this.hasDurableTables()) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT auth_request_id FROM auth_hook_executions
         WHERE state = 'pending'
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ auth_request_id: string }>;
    return rows.map((row) => String(row.auth_request_id));
  }

  /**
   * Startup-only recovery: every `running` row in the database belongs to a
   * process that no longer exists, because this one has not spawned anything
   * yet. Converts them back to `pending` (or `failed` when the attempt budget
   * is gone) so the resume sweep can pick them up.
   */
  reclaimAllInterruptedRuns(): number {
    if (!this.hasDurableTables()) return 0;
    const rows = this.db
      .prepare("SELECT DISTINCT auth_request_id FROM auth_hook_executions WHERE state = 'running'")
      .all() as Array<{ auth_request_id: string }>;
    for (const row of rows) {
      this.reclaimInterruptedRuns(String(row.auth_request_id));
    }
    return rows.length;
  }

  /**
   * A row left `running` means the daemon died while the child was alive. The
   * attempt was already charged (it was persisted before the spawn), so this
   * only decides whether the budget allows another one.
   *
   * Only ever call this for rows that cannot still be running: at daemon
   * startup (a fresh process owns no children) or for a request whose inline
   * execution this process is about to perform. A live `running` row must stay
   * `running`, because that state is what stops a concurrent sweep from
   * spawning a second copy of the same hook.
   */
  reclaimInterruptedRuns(authRequestId: string): AuthHookRun[] {
    if (!this.hasDurableTables()) return [];
    const now = Date.now();
    for (const run of this.listRuns(authRequestId)) {
      if (run.state !== "running") continue;
      const history = [...run.attempt_history];
      const last = history[history.length - 1];
      if (!last || last.attempt !== run.attempts) {
        history.push({
          attempt: run.attempts,
          started_at: run.started_at ?? now,
          finished_at: now,
          exit_code: null,
          duration_ms: now - (run.started_at ?? now),
          outcome: "interrupted",
        });
      }
      const exhausted = run.attempts >= run.max_attempts;
      this.db
        .prepare(
          `UPDATE auth_hook_executions
           SET state = ?, attempt_history = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          exhausted ? "failed" : "pending",
          JSON.stringify(history),
          exhausted ? now : null,
          now,
          run.id,
        );
    }
    return this.listRuns(authRequestId);
  }

  /**
   * Grant one more attempt to a terminally failed run so an operator can retry
   * after fixing the host condition. Only the hook command reruns.
   */
  grantRetry(authRequestId: string, hookId?: string): number {
    if (!this.hasDurableTables()) return 0;
    const now = Date.now();
    const runs = this.listRuns(authRequestId).filter(
      (run) => run.state === "failed" && (!hookId || run.hook_id === hookId),
    );
    for (const run of runs) {
      this.db
        .prepare(
          `UPDATE auth_hook_executions
           SET state = 'pending', max_attempts = ?, finished_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(run.attempts + 1, now, run.id);
    }
    return runs.length;
  }

  /**
   * Execute all matching hooks for a completed auth request.
   *
   * Hooks run sequentially in position order. If a hook fails, subsequent hooks
   * still run: the merge already succeeded and the queue must not block. The
   * failure is not swallowed — it lives in the durable row and surfaces as
   * `merged / convergence failed`.
   */
  async executeHooks(
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
    options: { reusePlan?: boolean } = {},
  ): Promise<AuthHookExecutionResult[]> {
    if (!this.hasDurableTables()) {
      // Legacy/partial DBs (old fixtures) keep the pre-27241e6 behaviour rather
      // than losing hook execution entirely.
      const hooks = this.findMatchingHooks(request.repo, request.type);
      const results: AuthHookExecutionResult[] = [];
      for (const hook of hooks) {
        results.push(await this.spawnHook(hook.id, hook.label, hook.command, request, {
          attempt: 1,
          executionId: `ephemeral:${hook.id}`,
          onOutput,
        }));
      }
      return results;
    }

    if (!options.reusePlan) this.planRuns(request);
    this.reclaimInterruptedRuns(request.id);
    return this.runPending(request, onOutput);
  }

  /**
   * Run every runnable row for this request, oldest position first. Safe to
   * call repeatedly: rows that are already terminal are skipped, and rows whose
   * attempt budget is exhausted are marked failed rather than retried forever.
   */
  async runPending(
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult[]> {
    const results: AuthHookExecutionResult[] = [];
    if (!this.hasDurableTables()) return results;

    for (const planned of this.listRuns(request.id)) {
      const run = this.getRun(request.id, planned.hook_id);
      // `running` is deliberately not runnable: it is the marker that some
      // process already spawned this hook, and honouring it is what keeps a
      // concurrent sweep from starting a second copy.
      if (!run || run.state !== "pending") continue;
      if (run.attempts >= run.max_attempts) {
        this.markRunFailedExhausted(run);
        continue;
      }
      results.push(await this.runOnce(run, request, onOutput));
    }
    return results;
  }

  private markRunFailedExhausted(run: AuthHookRun): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE auth_hook_executions SET state = 'failed', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, now, run.id);
  }

  /**
   * One attempt against one durable row. The attempt counter and `running`
   * state are committed BEFORE the spawn, so a daemon killed mid-hook leaves
   * evidence that the attempt happened instead of an attempt budget that can
   * be burned forever by crash-looping.
   */
  private async runOnce(
    run: AuthHookRun,
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult> {
    const attempt = run.attempts + 1;
    const startedAt = Date.now();
    this.db
      .prepare(
        `UPDATE auth_hook_executions
         SET state = 'running', attempts = ?, started_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempt, startedAt, startedAt, run.id);

    const result = await this.spawnHook(run.hook_id, run.hook_label, run.command, request, {
      attempt,
      executionId: run.id,
      commandDigest: run.command_digest,
      onOutput,
    });

    const finishedAt = Date.now();
    const ok = result.exit_code === 0;
    const history: AuthHookRunAttempt[] = [
      ...run.attempt_history,
      {
        attempt,
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        outcome: ok ? "ok" : result.exit_code === null ? "timeout" : "failed",
      },
    ];
    const exhausted = attempt >= run.max_attempts;
    const nextState: AuthHookRunState = ok ? "complete" : exhausted ? "failed" : "pending";
    this.db
      .prepare(
        `UPDATE auth_hook_executions
         SET state = ?, exit_code = ?, output = ?, attempt_history = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextState,
        result.exit_code,
        truncateOutput(result.output),
        JSON.stringify(history),
        ok || exhausted ? finishedAt : null,
        finishedAt,
        run.id,
      );
    return result;
  }

  private spawnHook(
    hookId: string,
    hookLabel: string,
    command: string,
    request: AuthRequest,
    options: {
      attempt: number;
      executionId: string;
      commandDigest?: string;
      onOutput?: (hookLabel: string, text: string) => void;
    },
  ): Promise<AuthHookExecutionResult> {
    const startedAt = Date.now();
    const cwd = request.cwd ?? undefined;
    const timeoutMs = authHookTimeoutMs(hookId);
    const env = buildAuthHookEnv(
      request,
      {
        hook_id: hookId,
        hook_label: hookLabel,
        attempt: options.attempt,
        execution_id: options.executionId,
        command_digest: options.commandDigest ?? authHookCommandDigest(command),
      },
      { db: this.db },
    );

    return new Promise<AuthHookExecutionResult>((resolve) => {
      let output = "";
      let settled = false;

      const child = spawn("bash", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Issue 27241e6 — scrubbed allowlist, never `...process.env`.
        env,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: null,
          output: output + "\n[hook timed out after " + (timeoutMs / 1000) + "s]",
          duration_ms: Date.now() - startedAt,
        });
      }, timeoutMs);

      const handleChunk = (data: Buffer): void => {
        const text = data.toString("utf8");
        output += text;
        options.onOutput?.(hookLabel, text);
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: 1,
          output: output + "\n[hook error: " + error.message + "]",
          duration_ms: Date.now() - startedAt,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: typeof code === "number" ? code : 1,
          output,
          duration_ms: Date.now() - startedAt,
        });
      });
    });
  }

  // --- Deduplicated failure alerts ---------------------------------------------

  /**
   * Record at most one alert per (request, hook). The UNIQUE constraint is the
   * dedup: a second required-hook failure for the same pair updates the detail
   * on the existing open alert instead of creating another inbox entry. No
   * ledger issue is created — a transient host failure is not a repairable
   * defect, and manufacturing an issue for each one is churn.
   */
  recordFailureAlert(request: AuthRequest, run: AuthHookRun, detail: string): AuthHookAlert | null {
    if (!this.hasDurableTables()) return null;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO auth_hook_alerts (
           id, auth_request_id, hook_id, hook_label, session_id, repo, detail,
           created_at, updated_at, acknowledged_at, acknowledged_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(auth_request_id, hook_id) DO UPDATE SET
           detail = excluded.detail,
           hook_label = excluded.hook_label,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        request.id,
        run.hook_id,
        run.hook_label,
        request.target_session_id ?? request.session_id ?? null,
        request.repo ?? null,
        detail,
        now,
        now,
      );
    return this.getAlert(request.id, run.hook_id);
  }

  getAlert(authRequestId: string, hookId: string): AuthHookAlert | null {
    if (!this.hasDurableTables()) return null;
    const row = this.db
      .prepare("SELECT * FROM auth_hook_alerts WHERE auth_request_id = ? AND hook_id = ?")
      .get(authRequestId, hookId) as Record<string, unknown> | undefined;
    return row ? mapAlertRow(row) : null;
  }

  listOpenAlerts(limit = 50): AuthHookAlert[] {
    if (!this.hasDurableTables()) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hook_alerts
         WHERE acknowledged_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapAlertRow);
  }

  acknowledgeAlert(id: string, by: string): boolean {
    if (!this.hasDurableTables()) return false;
    const info = this.db
      .prepare(
        "UPDATE auth_hook_alerts SET acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND acknowledged_at IS NULL",
      )
      .run(Date.now(), by, Date.now(), id) as { changes?: number };
    return (info.changes ?? 0) > 0;
  }

  /** Clear the open alert for a pair that has since converged. */
  resolveAlert(authRequestId: string, hookId: string): void {
    if (!this.hasDurableTables()) return;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE auth_hook_alerts SET acknowledged_at = ?, acknowledged_by = COALESCE(acknowledged_by, 'convergence'), updated_at = ? WHERE auth_request_id = ? AND hook_id = ? AND acknowledged_at IS NULL",
      )
      .run(now, now, authRequestId, hookId);
  }

  // --- CRUD ---

  list(): AuthHook[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_hooks ORDER BY position ASC, created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapHookRow);
  }

  get(id: string): AuthHook | null {
    const row = this.db
      .prepare("SELECT * FROM auth_hooks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapHookRow(row) : null;
  }

  create(input: AuthHookInput): AuthHook {
    const now = Date.now();
    const id = randomUUID();
    const withRequired = this.hasRequiredColumn();
    const args: unknown[] = [
      id,
      input.repo_pattern,
      input.auth_type,
      input.command,
      input.label,
      input.enabled !== false ? 1 : 0,
      input.position ?? 100,
    ];
    if (withRequired) args.push(input.required === false ? 0 : 1);
    args.push(now, now);
    this.db
      .prepare(
        `INSERT INTO auth_hooks
           (id, repo_pattern, auth_type, command, label, enabled, builtin, position${withRequired ? ", required" : ""}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?${withRequired ? ", ?" : ""}, ?, ?)`,
      )
      .run(...args);
    return this.get(id)!;
  }

  update(id: string, fields: Partial<AuthHookInput> & { enabled?: boolean }): AuthHook | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (fields.repo_pattern !== undefined) {
      updates.push("repo_pattern = ?");
      values.push(fields.repo_pattern);
    }
    if (fields.auth_type !== undefined) {
      updates.push("auth_type = ?");
      values.push(fields.auth_type);
    }
    if (fields.command !== undefined) {
      updates.push("command = ?");
      values.push(fields.command);
    }
    if (fields.label !== undefined) {
      updates.push("label = ?");
      values.push(fields.label);
    }
    if (fields.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(fields.enabled ? 1 : 0);
    }
    if (fields.position !== undefined) {
      updates.push("position = ?");
      values.push(fields.position);
    }
    if (fields.required !== undefined && this.hasRequiredColumn()) {
      updates.push("required = ?");
      values.push(fields.required ? 1 : 0);
    }

    if (updates.length === 0) return existing;

    updates.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db
      .prepare(`UPDATE auth_hooks SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.builtin) {
      throw new Error("Cannot delete built-in hooks. Disable them instead.");
    }
    this.db.prepare("DELETE FROM auth_hooks WHERE id = ?").run(id);
    return true;
  }

  private requiredColumnPresent: boolean | null = null;

  private hasRequiredColumn(): boolean {
    if (this.requiredColumnPresent !== null) return this.requiredColumnPresent;
    try {
      const columns = this.db.prepare("PRAGMA table_info(auth_hooks)").all() as Array<{ name: string }>;
      this.requiredColumnPresent = columns.some((column) => column.name === "required");
    } catch {
      this.requiredColumnPresent = false;
    }
    return this.requiredColumnPresent;
  }
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_PERSISTED_OUTPUT_CHARS) return text;
  return `[output truncated to the last ${MAX_PERSISTED_OUTPUT_CHARS} characters]\n` +
    text.slice(text.length - MAX_PERSISTED_OUTPUT_CHARS);
}

function mapHookRow(row: Record<string, unknown>): AuthHook {
  return {
    id: String(row.id),
    repo_pattern: String(row.repo_pattern ?? "*"),
    auth_type: String(row.auth_type ?? "merge") as AuthRequestType,
    command: String(row.command ?? ""),
    label: String(row.label ?? ""),
    enabled: row.enabled === 1 || row.enabled === true,
    builtin: row.builtin === 1 || row.builtin === true,
    position: typeof row.position === "number" ? row.position : 0,
    // Absent column (pre-v138 fixture) means the pre-27241e6 world, where every
    // hook was implicitly load-bearing.
    required: row.required === undefined ? true : row.required === 1 || row.required === true,
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

function mapRunRow(row: Record<string, unknown>): AuthHookRun {
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    hook_id: String(row.hook_id),
    hook_label: String(row.hook_label ?? ""),
    command: String(row.command ?? ""),
    command_digest: String(row.command_digest ?? ""),
    position: typeof row.position === "number" ? row.position : 0,
    required: row.required === 1 || row.required === true,
    state: String(row.state ?? "pending") as AuthHookRunState,
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? AUTH_HOOK_MAX_ATTEMPTS),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    output: String(row.output ?? ""),
    attempt_history: parseAttemptHistory(row.attempt_history),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

function parseAttemptHistory(raw: unknown): AuthHookRunAttempt[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthHookRunAttempt[]) : [];
  } catch {
    return [];
  }
}

function mapAlertRow(row: Record<string, unknown>): AuthHookAlert {
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    hook_id: String(row.hook_id),
    hook_label: String(row.hook_label ?? ""),
    session_id: row.session_id == null ? null : String(row.session_id),
    repo: row.repo == null ? null : String(row.repo),
    detail: String(row.detail ?? ""),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    acknowledged_at: row.acknowledged_at == null ? null : Number(row.acknowledged_at),
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by),
  };
}
