import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { executeAuthCommand, type AuthExecutionResult } from "./auth-executor.js";
import { getDb, resolvePrefix } from "./db.js";
import { broadcast as defaultBroadcast } from "./sse.js";
import type {
  AuthOutputChunk,
  AuthRequest,
  AuthRequestInput,
  AuthRequestStatus,
  SseEvent
} from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_RESOLVED_MS = 60 * 60 * 1000; // Show resolved items for 1 hour

export class AuthQueueError extends Error {
  readonly code: "not_found" | "invalid_status" | "invalid_command";
  readonly status?: AuthRequestStatus;

  constructor(
    code: "not_found" | "invalid_status" | "invalid_command",
    message: string,
    status?: AuthRequestStatus
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface AuthQueueOptions {
  db?: InstanceType<typeof Database>;
  now?: () => number;
  ttlMs?: number;
  broadcast?: (event: SseEvent) => void;
  executor?: typeof executeAuthCommand;
}

export class AuthQueue {
  private readonly db: InstanceType<typeof Database>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly broadcast: (event: SseEvent) => void;
  private readonly executor: typeof executeAuthCommand;
  private readonly inFlight = new Map<string, Promise<void>>();
  private executionChain: Promise<void> = Promise.resolve();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AuthQueueOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.broadcast = options.broadcast ?? defaultBroadcast;
    this.executor = options.executor ?? executeAuthCommand;
    this.ensureSchema();
    this.recoverStuckRequests();
    this.startExpiryTimer();
  }

  private startExpiryTimer(): void {
    this.expiryTimer = setInterval(() => this.expireStale(), 30_000);
    this.expiryTimer.unref();
  }

  /**
   * Recover auth requests that got stuck in 'approved' status because the
   * daemon was killed (e.g. by the post-merge hook) before the executor could
   * record the result.
   *
   * Two cases:
   * 1. Approved with output containing merge evidence → mark completed (exit 0)
   * 2. Approved with empty/no output, older than 5 min → mark completed (exit 1)
   *    as interrupted execution (Bug: 68aa754)
   */
  private recoverStuckRequests(): void {
    const now = this.now();

    // Case 1: approved/executing with output — check for merge evidence
    const withOutput = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') AND output IS NOT NULL AND output != '' AND exit_code IS NULL"
      )
      .all() as Record<string, unknown>[];

    const successUpdate = this.db.prepare(
      "UPDATE auth_requests SET status = 'completed', exit_code = 0, resolved_at = ?, updated_at = ? WHERE id = ?"
    );

    for (const row of withOutput) {
      const output = String(row.output ?? "");
      if (output.includes("Merge made by") || output.includes("Fast-forward")) {
        successUpdate.run(now, now, row.id);
        const recovered = this.getRequest(String(row.id));
        if (recovered) {
          this.broadcast({
            event: "auth:resolved",
            data: this.buildResolvedPayload(recovered)
          });
        }
        console.log(
          `[auth-queue] recovered stuck request ${row.id}: merge succeeded but result was not recorded (daemon killed mid-execution)`
        );
      }
    }

    // Case 2: approved with empty output, older than 5 minutes — execution interrupted
    // Bug: 68aa754 — stuck in approved state with no output means the executor
    // never ran or was killed before producing any output (likely daemon restart)
    const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
    const cutoff = now - STUCK_THRESHOLD_MS;

    const emptyApproved = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') AND (output IS NULL OR output = '') AND exit_code IS NULL AND approved_at < ?"
      )
      .all(cutoff) as Record<string, unknown>[];

    const failUpdate = this.db.prepare(
      "UPDATE auth_requests SET status = 'completed', exit_code = 1, resolved_at = ?, updated_at = ?, error = ? WHERE id = ?"
    );

    for (const row of emptyApproved) {
      failUpdate.run(now, now, "Stuck in approved state — execution interrupted (likely daemon restart)", row.id);
      const recovered = this.getRequest(String(row.id));
      if (recovered) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(recovered)
        });
      }
      console.log(
        `[auth-queue] recovered stuck request ${row.id}: approved but no output after 5min — marking as interrupted`
      );
    }
  }

  /**
   * Find an existing pending request that would be a duplicate of the given
   * payload. Returns the existing request if found, or null.
   *
   * Bug: 16985e8 — agents can accidentally submit the same request multiple
   * times (retry logic, curl fallback). We check two conditions:
   * 1. Same session_id + same title (same agent, same logical operation)
   * 2. Same head_branch + same base_branch (any session, branch can only merge once)
   */
  findDuplicate(payload: AuthRequestInput): AuthRequest | null {
    // Check by same branch pair first (strongest signal — a branch can only
    // merge once regardless of which session submitted it)
    if (payload.head_branch && payload.base_branch) {
      const byBranch = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE head_branch = ? AND base_branch = ? " +
            "AND status IN ('pending', 'approved', 'executing') LIMIT 1"
        )
        .get(payload.head_branch, payload.base_branch) as Record<string, unknown> | undefined;
      if (byBranch) {
        return mapRow(byBranch);
      }
    }

    // Fall back to session + title match
    if (payload.session_id && payload.title) {
      const bySession = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE session_id = ? AND title = ? " +
            "AND status = 'pending' LIMIT 1"
        )
        .get(payload.session_id, payload.title) as Record<string, unknown> | undefined;
      if (bySession) {
        return mapRow(bySession);
      }
    }

    return null;
  }

  submit(payload: AuthRequestInput): AuthRequest {
    const now = this.now();
    const request: AuthRequest = {
      id: randomUUID(),
      session_id: payload.session_id ?? null,
      command: payload.command,
      title: payload.title,
      cwd: payload.cwd ?? null,
      diff_summary: payload.diff_summary ?? null,
      commit_message: payload.commit_message ?? null,
      spec_content: payload.spec_content ?? null,
      repo: payload.repo,
      base_branch: payload.base_branch,
      head_branch: payload.head_branch,
      files_changed: payload.files_changed ?? 0,
      additions: payload.additions ?? 0,
      deletions: payload.deletions ?? 0,
      execution_mode: payload.execution_mode ?? "daemon",
      status: "pending",
      created_at: now,
      updated_at: now,
      last_executed_at: null,
      approved_at: null,
      resolved_at: null,
      skipped_at: null,
      expires_at: now + this.ttlMs,
      exit_code: null,
      output: "",
      error: null,
      acknowledged_by: null
    };

    const stmt = this.db.prepare(
      `INSERT INTO auth_requests (
        id,
        session_id,
        command,
        title,
        cwd,
        diff_summary,
        commit_message,
        spec_content,
        repo,
        base_branch,
        head_branch,
        files_changed,
        additions,
        deletions,
        execution_mode,
        status,
        created_at,
        updated_at,
        last_executed_at,
        approved_at,
        resolved_at,
        skipped_at,
        expires_at,
        exit_code,
        output,
        error,
        acknowledged_by
      ) VALUES (
        @id,
        @session_id,
        @command,
        @title,
        @cwd,
        @diff_summary,
        @commit_message,
        @spec_content,
        @repo,
        @base_branch,
        @head_branch,
        @files_changed,
        @additions,
        @deletions,
        @execution_mode,
        @status,
        @created_at,
        @updated_at,
        @last_executed_at,
        @approved_at,
        @resolved_at,
        @skipped_at,
        @expires_at,
        @exit_code,
        @output,
        @error,
        @acknowledged_by
      )`
    );

    stmt.run({
      ...request,
      repo: request.repo ?? null,
      base_branch: request.base_branch ?? null,
      head_branch: request.head_branch ?? null
    });

    this.broadcast({
      event: "auth:new",
      data: { request }
    });

    return request;
  }

  getRequest(id: string): AuthRequest | null {
    this.expireStale();
    // Bug: caa157e — support UUID prefix matching
    const resolved = resolvePrefix(this.db, "auth_requests", "id", id);
    if (!resolved.ok) {
      return null;
    }
    const row = this.db
      .prepare("SELECT * FROM auth_requests WHERE id = ?")
      .get(resolved.id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  update(
    id: string,
    fields: Partial<AuthRequestInput> & { status?: "pending" | "dismissed" }
  ): AuthRequest {
    this.expireStale();
    const request = this.getRequest(id);
    if (!request) {
      throw { status: 404, message: "Not found" };
    }

    const isFailed = this.isFailedLike(request);
    // Bug: 68aa754 — also allow modifications from "approved"/"executing" status
    // (stuck execution recovery: approved/executing -> pending or -> dismissed)
    const isApproved = request.status === "approved" || request.status === "executing";
    if (request.status !== "pending" && !isFailed && !isApproved) {
      throw {
        status: 409,
        message: "Can only modify pending, failed, or approved requests"
      };
    }

    const resetToPending = (isFailed || isApproved) && fields.status === "pending";

    const allowedFields = [
      "title",
      "diff_summary",
      "commit_message",
      "spec_content",
      "repo",
      "base_branch",
      "head_branch",
      "files_changed",
      "additions",
      "deletions",
      "command",
      "cwd"
    ];
    const updates: string[] = [];
    const values: unknown[] = [];
    const payload = fields as Record<string, unknown>;

    for (const field of allowedFields) {
      if (field in payload && payload[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(payload[field]);
      }
    }

    // For a retry-via-update (failed/approved -> pending), reset execution state
    if (resetToPending) {
      const now = this.now();
      updates.push("status = 'pending'");
      updates.push("resolved_at = NULL");
      updates.push("approved_at = NULL");
      updates.push("exit_code = NULL");
      updates.push("error = NULL");
      updates.push("output = ''");
      updates.push("expires_at = ?");
      values.push(now + this.ttlMs);
    }

    // Bug: 68aa754 — allow dismissing approved requests via update
    const dismissFromApproved = isApproved && fields.status === "dismissed";
    if (dismissFromApproved) {
      const now = this.now();
      updates.push("status = 'dismissed'");
      updates.push("resolved_at = ?");
      values.push(now);
    }

    if (updates.length === 0) {
      throw { status: 400, message: "No fields to update" };
    }

    updates.push("updated_at = ?");
    values.push(this.now());
    values.push(id);

    this.db
      .prepare(`UPDATE auth_requests SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    const updated = this.getRequest(id)!;
    const eventType = resetToPending ? "auth:new"
      : dismissFromApproved ? "auth:resolved"
      : "auth:updated";
    this.broadcast({
      event: eventType,
      data: dismissFromApproved
        ? this.buildResolvedPayload(updated)
        : { request: updated }
    });
    return updated;
  }

  listPending(): AuthRequest[] {
    this.expireStale();
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status = 'pending' " +
          "ORDER BY COALESCE(skipped_at, created_at) ASC, created_at ASC"
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapRow(row));
  }

  /** Return pending + approved + failed/expired + recent history for the UI. */
  listActive(): AuthRequest[] {
    this.expireStale();
    const cutoff = this.now() - RECENT_RESOLVED_MS;
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE " +
          "status IN ('pending', 'approved', 'executing', 'expired') " +
          "OR (status = 'completed' AND exit_code IS NOT NULL AND exit_code != 0) " +
          "OR (status IN ('completed', 'rejected', 'dismissed') AND resolved_at >= ?) " +
          "ORDER BY created_at ASC"
      )
      .all(cutoff) as Record<string, unknown>[];
    return rows.map((row) => mapRow(row));
  }

  /** Return resolved items (completed/rejected/dismissed) ordered by most recent first. */
  listHistory(limit = 50): AuthRequest[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status IN ('completed', 'rejected', 'dismissed') " +
          "ORDER BY resolved_at DESC LIMIT ?"
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => mapRow(row));
  }

  retry(id: string): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    if (!this.isFailedLike(request)) {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot retry.`,
        request.status
      );
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'pending', resolved_at = NULL, " +
          "approved_at = NULL, exit_code = NULL, error = NULL, output = '', " +
          "updated_at = ?, expires_at = ? WHERE id = ?"
      )
      .run(now, now + this.ttlMs, id);

    const retried = this.requireRequest(id);
    this.broadcast({
      event: "auth:new",
      data: { request: retried }
    });

    return retried;
  }

  requeue(id: string): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    if (!this.isFailedLike(request)) {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot requeue.`,
        request.status
      );
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'pending', resolved_at = NULL, " +
          "approved_at = NULL, exit_code = NULL, error = NULL, output = '', " +
          "updated_at = ?, expires_at = ? WHERE id = ?"
      )
      .run(now, now + this.ttlMs, id);

    const requeued = this.requireRequest(id);
    this.broadcast({
      event: "auth:new",
      data: { request: requeued }
    });

    return requeued;
  }

  dismiss(id: string): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    // Bug: 68aa754 — allow dismissing approved requests (stuck execution recovery)
    // Also allow dismissing pending requests (force-dismiss from the UI).
    if (!this.isFailedLike(request) && request.status !== "approved" && request.status !== "executing" && request.status !== "pending") {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot dismiss.`,
        request.status
      );
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(now, now, id);

    const dismissed = this.requireRequest(id);
    this.broadcast({
      event: "auth:resolved",
      data: this.buildResolvedPayload(dismissed)
    });

    return dismissed;
  }

  delete(id: string, reason: string): void {
    const request = this.requireRequest(id);
    this.db.prepare("DELETE FROM auth_requests WHERE id = ?").run(id);
    console.log(`[auth-queue] deleted request ${id} (${reason})`);
    this.broadcast({
      event: "auth:deleted",
      data: { request_id: id }
    });
  }

  approve(id: string): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    if (request.status !== "pending") {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot approve.`,
        request.status
      );
    }

    // Bug: 58d93ee — guard against null/empty command before spawning execution
    if (!request.command || !request.command.trim()) {
      throw new AuthQueueError(
        "invalid_command",
        "Auth request has no command set — update the request with a valid command before approving"
      );
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(now, now, id);

    const executing = this.requireRequest(id);
    this.executeInBackground(executing);
    return executing;
  }

  reject(id: string, reason = "Rejected by user."): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    if (request.status !== "pending") {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot reject.`,
        request.status
      );
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'rejected', resolved_at = ?, updated_at = ?, error = ? WHERE id = ?"
      )
      .run(now, now, reason, id);

    const rejected = this.requireRequest(id);
    this.broadcast({
      event: "auth:resolved",
      data: this.buildResolvedPayload(rejected)
    });

    return rejected;
  }

  skip(id: string): AuthRequest {
    this.expireStale();
    const request = this.requireRequest(id);
    if (request.status !== "pending") {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot skip.`,
        request.status
      );
    }

    const now = this.now();
    this.db
      .prepare("UPDATE auth_requests SET skipped_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);

    return this.requireRequest(id);
  }

  appendOutput(id: string, chunk: string): AuthRequest {
    this.expireStale();
    this.requireRequest(id);
    const timestamp = this.now();
    this.handleOutput({
      request_id: id,
      stream: "stdout",
      text: chunk,
      timestamp
    });
    return this.requireRequest(id);
  }

  setResult(id: string, exitCode: number, output: string, error?: string): AuthRequest {
    this.expireStale();
    this.requireRequest(id);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?"
      )
      .run(now, now, exitCode, output, error ?? null, id);

    const completed = this.requireRequest(id);
    this.broadcast({
      event: "auth:resolved",
      data: this.buildResolvedPayload(completed)
    });
    return completed;
  }

  expireStale(): AuthRequest[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status = 'pending' AND expires_at <= ?"
      )
      .all(now) as Record<string, unknown>[];

    if (rows.length === 0) {
      // Still run the stuck-approved check even when nothing expired
      this.recoverStuckApproved();
      return [];
    }

    const update = this.db.prepare(
      "UPDATE auth_requests SET status = 'expired', resolved_at = expires_at, updated_at = ?, error = ? WHERE id = ?"
    );

    const tx = this.db.transaction((expiredRows: Record<string, unknown>[]) => {
      for (const row of expiredRows) {
        update.run(now, "Expired.", row.id);
      }
    });

    tx(rows);

    const expiredRequests = rows.map((row) => ({
      ...mapRow(row),
      status: "expired" as AuthRequestStatus,
      resolved_at: Number(row.expires_at),
      updated_at: now,
      error: "Expired."
    }));
    for (const expired of expiredRequests) {
      this.broadcast({
        event: "auth:resolved",
        data: this.buildResolvedPayload(expired)
      });
    }

    // Bug: 831cb3e — periodic stuck-approved recovery (same logic as
    // recoverStuckRequests Case 2, but runs every 30s during daemon lifetime)
    this.recoverStuckApproved();

    return expiredRequests;
  }

  /**
   * Recover requests stuck in 'approved'/'executing' with no output for >10 min.
   * Called periodically from expireStale() so stuck requests are recovered at
   * runtime, not only at startup. Uses the same logic as recoverStuckRequests()
   * Case 2 but with a longer threshold (10 min vs 5 min at startup) since the
   * daemon is known to be running.
   * Bug: 831cb3e
   */
  private recoverStuckApproved(): void {
    const now = this.now();
    const STUCK_RUNTIME_THRESHOLD_MS = 10 * 60 * 1000;
    const cutoff = now - STUCK_RUNTIME_THRESHOLD_MS;

    const stuckRows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') " +
          "AND (output IS NULL OR output = '') AND exit_code IS NULL AND approved_at < ?"
      )
      .all(cutoff) as Record<string, unknown>[];

    if (stuckRows.length === 0) {
      return;
    }

    const failUpdate = this.db.prepare(
      "UPDATE auth_requests SET status = 'completed', exit_code = 1, resolved_at = ?, updated_at = ?, error = ? WHERE id = ?"
    );

    for (const row of stuckRows) {
      failUpdate.run(
        now,
        now,
        "Stuck in approved state for >10 minutes — execution interrupted (periodic recovery)",
        row.id
      );
      const recovered = this.getRequest(String(row.id));
      if (recovered) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(recovered)
        });
      }
      console.log(
        `[auth-queue] periodic recovery: stuck request ${row.id} approved >10min with no output — marking as interrupted`
      );
    }
  }

  private executeInBackground(request: AuthRequest): void {
    // Remote-mode requests are executed by an external process — the daemon
    // only manages state transitions. Do not spawn a local executor.
    if (request.execution_mode === "remote") {
      return;
    }

    if (this.inFlight.has(request.id)) {
      return;
    }

    const runPromise = this.executionChain
      .catch(() => undefined)
      .then(async () => {
        try {
          const executedAt = Date.now();
          this.db
            .prepare(
              "UPDATE auth_requests SET last_executed_at = ?, updated_at = ? WHERE id = ?"
            )
            .run(executedAt, executedAt, request.id);
          const result = await this.executor({
            request_id: request.id,
            command: request.command,
            cwd: request.cwd,
            onOutput: (chunk) => this.handleOutput(chunk)
          });
          this.storeExecutionResult(request.id, result, null);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Execution failed.";
          this.storeExecutionResult(request.id, null, message);
        } finally {
          this.inFlight.delete(request.id);
        }
      });

    this.executionChain = runPromise.catch(() => undefined);
    this.inFlight.set(request.id, runPromise);
  }

  private handleOutput(chunk: AuthOutputChunk): void {
    this.db
      .prepare("UPDATE auth_requests SET output = output || ?, updated_at = ? WHERE id = ?")
      .run(chunk.text, chunk.timestamp, chunk.request_id);

    this.broadcast({
      event: "auth:output",
      data: chunk
    });
  }

  private storeExecutionResult(
    id: string,
    result: AuthExecutionResult | null,
    error: string | null
  ): void {
    const now = this.now();
    // Bug: f690657 — when result is null (executor threw before the child
    // process exited), use exit_code=1 rather than null. exit_code=null is
    // treated by isFailedLike as "no exit code yet" which makes completed+null
    // look like a successful completion, hiding the failure from the user.
    const exitCode = result != null ? (result.exit_code ?? 1) : 1;

    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = ?, error = ? WHERE id = ?"
      )
      .run(now, now, exitCode, error, id);

    const completed = this.requireRequest(id);
    this.broadcast({
      event: "auth:resolved",
      data: this.buildResolvedPayload(completed)
    });

    // Bug: 0c44fec — after a successful merge (exit_code=0), auto-dismiss any
    // other pending/failed requests targeting the same branch merge. These are
    // stale duplicates (retries, corrected-CWD resubmissions) — approving them
    // would waste a YubiKey tap on a branch that no longer exists.
    if (exitCode === 0) {
      this.autoDismissDuplicates(completed);
    }
  }

  private autoDismissDuplicates(completed: AuthRequest): void {
    if (!completed.base_branch || !completed.head_branch) {
      return;
    }

    const now = this.now();
    // Find sibling requests targeting the same branch merge that are still
    // actionable (pending, expired, or failed-completed). Approved requests are
    // excluded — they may already be executing and need separate handling.
    const siblings = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE id != ? AND base_branch = ? AND head_branch = ? " +
          "AND (status IN ('pending', 'expired') " +
          "OR (status = 'completed' AND exit_code IS NOT NULL AND exit_code != 0))"
      )
      .all(
        completed.id,
        completed.base_branch,
        completed.head_branch
      ) as Record<string, unknown>[];

    if (siblings.length === 0) {
      return;
    }

    const dismissStmt = this.db.prepare(
      "UPDATE auth_requests SET status = 'dismissed', resolved_at = ?, updated_at = ?, " +
        "error = ? WHERE id = ?"
    );
    const reason = `Auto-dismissed: ${completed.head_branch} → ${completed.base_branch} was successfully merged by request ${completed.id.slice(0, 8)}`;

    for (const row of siblings) {
      dismissStmt.run(now, now, reason, row.id);
      const dismissed = this.getRequest(String(row.id));
      if (dismissed) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(dismissed)
        });
        console.log(
          `[auth-queue] auto-dismissed duplicate request ${row.id} after successful merge of ${completed.head_branch}`
        );
      }
    }
  }

  private buildResolvedPayload(request: AuthRequest): Record<string, unknown> {
    return {
      request_id: request.id,
      status: request.status,
      exit_code: request.exit_code,
      error: request.error,
      resolved_at: request.resolved_at
    };
  }

  private isFailedLike(request: AuthRequest): boolean {
    if (request.status === "expired") {
      return true;
    }
    if (request.status !== "completed") {
      return false;
    }
    return request.exit_code != null && request.exit_code !== 0;
  }

  private requireRequest(id: string): AuthRequest {
    // Bug: caa157e — surface ambiguous prefix errors before falling through to getRequest
    const resolved = resolvePrefix(this.db, "auth_requests", "id", id);
    if (!resolved.ok && resolved.error === "ambiguous") {
      throw new AuthQueueError(
        "not_found",
        `Ambiguous prefix '${id}' — matches ${resolved.count} requests. Use a longer prefix.`
      );
    }
    const request = this.getRequest(resolved.ok ? resolved.id : id);
    if (!request) {
      throw new AuthQueueError("not_found", "Request not found.");
    }
    return request;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        command TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        diff_summary TEXT,
        commit_message TEXT,
        spec_content TEXT,
        repo TEXT,
        base_branch TEXT,
        head_branch TEXT,
        files_changed INTEGER DEFAULT 0,
        additions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        execution_mode TEXT NOT NULL DEFAULT 'daemon',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_executed_at INTEGER,
        approved_at INTEGER,
        resolved_at INTEGER,
        skipped_at INTEGER,
        expires_at INTEGER NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        acknowledged_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_requests_status_created
        ON auth_requests(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_auth_requests_queue
        ON auth_requests(status, skipped_at, created_at);
    `);
  }
}

function mapRow(row: Record<string, unknown>): AuthRequest {
  return {
    id: String(row.id),
    session_id: row.session_id == null ? null : String(row.session_id),
    command: String(row.command),
    title: String(row.title),
    cwd: row.cwd == null ? null : String(row.cwd),
    diff_summary: row.diff_summary == null ? null : String(row.diff_summary),
    commit_message: row.commit_message == null ? null : String(row.commit_message),
    spec_content: row.spec_content == null ? null : String(row.spec_content),
    repo: row.repo == null ? undefined : String(row.repo),
    base_branch: row.base_branch == null ? undefined : String(row.base_branch),
    head_branch: row.head_branch == null ? undefined : String(row.head_branch),
    files_changed: row.files_changed == null ? undefined : Number(row.files_changed),
    additions: row.additions == null ? undefined : Number(row.additions),
    deletions: row.deletions == null ? undefined : Number(row.deletions),
    execution_mode:
      row.execution_mode === "remote" || row.execution_mode === "daemon"
        ? (row.execution_mode as "remote" | "daemon")
        : "daemon",
    status: row.status as AuthRequestStatus,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_executed_at: row.last_executed_at == null ? null : Number(row.last_executed_at),
    approved_at: row.approved_at == null ? null : Number(row.approved_at),
    resolved_at: row.resolved_at == null ? null : Number(row.resolved_at),
    skipped_at: row.skipped_at == null ? null : Number(row.skipped_at),
    expires_at: Number(row.expires_at),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    output: String(row.output ?? ""),
    error: row.error == null ? null : String(row.error),
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by)
  };
}
