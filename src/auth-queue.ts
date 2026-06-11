import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

import { executeAuthCommand, type AuthExecutionResult } from "./auth-executor.js";
import {
  addAuthRequestAction,
  deleteAuthRequestAction,
  insertAuthRequestActions,
  listAuthRequestActions,
  normalizeAuthActionInputs,
  updateAuthRequestAction,
} from "./auth-actions.js";
import type { AuthApprovalContext, AuthAutoApprover } from "./auth-auto-approve.js";
import { isAuthMergeCommand, resolveAuthMergeExecutionContext } from "./auth-context.js";
import { AuthHookManager, type AuthHookExecutionResult } from "./auth-hooks.js";
import { getDb, resolvePrefix } from "./db.js";
import {
  applyAuthRequestLedgerCompletion,
  syncAuthRequestLedgerLinks,
} from "./ledger/operational-links.js";
import { broadcast as defaultBroadcast } from "./sse.js";
import type {
  AuthOutputChunk,
  AuthRequest,
  AuthRequestAction,
  AuthRequestInput,
  AuthRequestOutcome,
  AuthRequestStatus,
  AuthRequestType,
  SseEvent
} from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_RESOLVED_MS = 60 * 60 * 1000; // Show resolved items for 1 hour
// Bug: dd21c1e — valid auth request types
const VALID_AUTH_REQUEST_TYPES: AuthRequestType[] = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "preset-promote", "data-delete"
];

type MergeTreeResult =
  | { status: "clean"; tree: string; files: string[]; message: string }
  | { status: "conflict"; files: string[]; message: string }
  | { status: "error"; files: string[]; message: string };

export class AuthQueueError extends Error {
  readonly code: "not_found" | "invalid_status" | "invalid_command" | "merge_conflict";
  readonly status?: AuthRequestStatus;
  readonly details?: unknown;

  constructor(
    code: "not_found" | "invalid_status" | "invalid_command" | "merge_conflict",
    message: string,
    status?: AuthRequestStatus,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface AuthMergeCheckInput {
  repo?: string | null;
  base_branch?: string | null;
  head_branch?: string | null;
  cwd?: string | null;
  request_id?: string | null;
}

export interface AuthMergeConflict {
  scope: "target" | "queue";
  request_id: string | null;
  head_branch: string | null;
  files: string[];
  message: string;
}

export interface AuthMergeCheckReport {
  status: "clean" | "conflict" | "error" | "unknown";
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  checked_requests: number;
  conflicts: AuthMergeConflict[];
  reason?: string;
}

export interface AuthQueueOptions {
  db?: InstanceType<typeof Database>;
  now?: () => number;
  ttlMs?: number;
  broadcast?: (event: SseEvent) => void;
  executor?: typeof executeAuthCommand;
  hookManager?: AuthHookManager;
  autoApprover?: AuthAutoApprover;
}

export class AuthQueue {
  private readonly db: InstanceType<typeof Database>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly broadcast: (event: SseEvent) => void;
  private readonly executor: typeof executeAuthCommand;
  private readonly hookManager: AuthHookManager;
  private readonly autoApprover?: AuthAutoApprover;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly executionEnvs = new Map<string, NodeJS.ProcessEnv>();
  private executionChain: Promise<void> = Promise.resolve();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  // Bug: 4db692a — tracks whether the daemon is about to restart after a
  // self-merge. Exposed via isRebuilding so the health endpoint can include
  // it in the response, preventing the UI from reloading prematurely.
  private _rebuilding = false;

  constructor(options: AuthQueueOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.broadcast = options.broadcast ?? defaultBroadcast;
    this.executor = options.executor ?? executeAuthCommand;
    this.hookManager = options.hookManager ?? new AuthHookManager(this.db);
    this.autoApprover = options.autoApprover;
    this.recoverStuckRequests();
    this.startExpiryTimer();
  }

  /** Bug: 4db692a — whether the daemon is shutting down for a self-merge rebuild. */
  get isRebuilding(): boolean {
    return this._rebuilding;
  }

  private startExpiryTimer(): void {
    this.expiryTimer = setInterval(() => {
      if (this.disposed || !this.isDbOpen()) {
        this.stopExpiryTimer();
        return;
      }
      try {
        this.expireStale();
      } catch (error) {
        if (this.disposed || !this.isDbOpen()) {
          this.stopExpiryTimer();
          return;
        }
        throw error;
      }
    }, 30_000);
    this.expiryTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.stopExpiryTimer();
  }

  private stopExpiryTimer(): void {
    if (!this.expiryTimer) {
      return;
    }
    clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }

  private isDbOpen(): boolean {
    return (this.db as { open?: boolean }).open !== false;
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
    const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
    const cutoff = now - STUCK_THRESHOLD_MS;

    const recoveredSuccessIds: string[] = [];
    const recoveredFailureIds: string[] = [];
    const runRecovery = this.db.transaction(() => {
      // Case 1: approved/executing with output — check for merge evidence or
      // stale partial output from a killed executor.
      const withOutput = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') AND output IS NOT NULL AND output != '' AND exit_code IS NULL"
        )
        .all() as Record<string, unknown>[];

      const successUpdate = this.db.prepare(
        "UPDATE auth_requests SET status = 'completed', exit_code = 0, resolved_at = ?, updated_at = ? WHERE id = ?"
      );
      const failUpdate = this.db.prepare(
        "UPDATE auth_requests SET status = 'completed', exit_code = 1, resolved_at = ?, updated_at = ?, error = ? WHERE id = ?"
      );

      for (const row of withOutput) {
        const output = String(row.output ?? "");
        if (output.includes("Merge made by") || output.includes("Fast-forward")) {
          successUpdate.run(now, now, row.id);
          recoveredSuccessIds.push(String(row.id));
          continue;
        }
        if (Number(row.approved_at ?? 0) < cutoff) {
          failUpdate.run(
            now,
            now,
            "Stuck in approved state with partial output — execution interrupted (likely daemon restart)",
            row.id
          );
          recoveredFailureIds.push(String(row.id));
        }
      }

      // Case 2: approved with empty output, older than 5 minutes — execution interrupted
      // Bug: 68aa754 — stuck in approved state with no output means the executor
      // never ran or was killed before producing any output (likely daemon restart)
      const emptyApproved = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') AND (output IS NULL OR output = '') AND exit_code IS NULL AND approved_at < ?"
        )
        .all(cutoff) as Record<string, unknown>[];

      for (const row of emptyApproved) {
        failUpdate.run(now, now, "Stuck in approved state — execution interrupted (likely daemon restart)", row.id);
        recoveredFailureIds.push(String(row.id));
      }
    });

    runRecovery();

    for (const id of recoveredSuccessIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.afterSuccessfulMerge(recovered);
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(recovered)
        });
        console.log(
          `[auth-queue] recovered stuck request ${id}: merge succeeded but result was not recorded (daemon killed mid-execution)`
        );
      }
    }

    for (const id of recoveredFailureIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(recovered)
        });
      }
      console.log(
        `[auth-queue] recovered stuck request ${id}: approved but unfinished after 5min — marking as interrupted`
      );
    }

    this.sweepSuccessfulMergeFinalizers();
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
    const mergeCheck = this.checkMergeIndependence(payload);
    if (mergeCheck.status === "conflict") {
      const firstConflict = mergeCheck.conflicts[0];
      const files = firstConflict?.files.length ? ` (${firstConflict.files.join(", ")})` : "";
      throw new AuthQueueError(
        "merge_conflict",
        `Auth request conflicts with ${firstConflict?.scope === "queue" ? `pending request ${firstConflict.request_id?.slice(0, 8)}` : "the target branch"}${files}. Consolidate the branches onto an integration branch or rebase before submitting.`,
        undefined,
        mergeCheck
      );
    }

    const now = this.now();
    const request: AuthRequest = {
      id: randomUUID(),
      session_id: payload.session_id ?? null,
      type: payload.type ?? "merge",
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
      post_merge_handoff: payload.post_merge_handoff ?? null,
      issue_references: payload.issue_references ?? null,
      issue_closures: payload.issue_closures ?? payload.issues ?? null,
      issue_ids: extractIssueIdsFromCommitMessage(payload.commit_message),
      issues: payload.issues ?? null,
      depends_on_id: payload.depends_on_id ?? null,
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
      acknowledged_by: null,
      // Bug: 4e32923 — scope auth result delivery to the originating session +
      // its repo root, with null falling back to legacy broadcast behaviour.
      target_session_id: payload.target_session_id ?? null,
      target_repo_root: payload.target_repo_root ?? null,
      delivered_at: null,
      // Bug: 6d7411b — conversation_id persists across Claude Code resumes
      conversation_id: payload.conversation_id ?? null,
      approval_source: "manual",
      approval_lease_id: null
    };

    const stmt = this.db.prepare(
      `INSERT INTO auth_requests (
        id,
        session_id,
        type,
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
        post_merge_handoff,
        issue_references,
        issue_closures,
        issue_ids,
        issues,
        depends_on_id,
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
        acknowledged_by,
        target_session_id,
        target_repo_root,
        delivered_at,
        conversation_id,
        approval_source,
        approval_lease_id
      ) VALUES (
        @id,
        @session_id,
        @type,
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
        @post_merge_handoff,
        @issue_references,
        @issue_closures,
        @issue_ids,
        @issues,
        @depends_on_id,
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
        @acknowledged_by,
        @target_session_id,
        @target_repo_root,
        @delivered_at,
        @conversation_id,
        @approval_source,
        @approval_lease_id
      )`
    );

    const actions = normalizeAuthActionInputs(payload.actions);
    const insertRequest = this.db.transaction(() => {
      stmt.run({
        ...request,
        repo: request.repo ?? null,
        base_branch: request.base_branch ?? null,
        head_branch: request.head_branch ?? null,
        post_merge_handoff: request.post_merge_handoff ?? null,
        issue_references: request.issue_references ? JSON.stringify(request.issue_references) : null,
        issue_closures: request.issue_closures ? JSON.stringify(request.issue_closures) : null,
        issue_ids: request.issue_ids ? JSON.stringify(request.issue_ids) : null,
        issues: request.issues ? JSON.stringify(request.issues) : null
      });
      insertAuthRequestActions(this.db, request, actions, now);
    });

    insertRequest();

    this.syncLedgerLinksForRequest(request, false);

    this.broadcast({
      event: "auth:new",
      data: { request }
    });

    const approval = this.autoApprover?.getActiveApprovalContext() ?? null;
    if (approval) {
      try {
        return this.approve(request.id, approval);
      } catch (error) {
        console.warn(
          `[auth-queue] auto-approval failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return request;
  }

  listActions(requestId: string): AuthRequestAction[] {
    const request = this.requireRequest(requestId);
    return listAuthRequestActions(this.db, request.id);
  }

  addAction(requestId: string, input: unknown): AuthRequestAction {
    const request = this.requireActionEditableRequest(requestId);
    const action = addAuthRequestAction(this.db, request, input, this.now());
    this.broadcast({ event: "auth:updated", data: { request, action } });
    return action;
  }

  updateAction(requestId: string, actionId: string, input: unknown): AuthRequestAction {
    const request = this.requireActionEditableRequest(requestId);
    const action = updateAuthRequestAction(this.db, request, actionId, input, this.now());
    this.broadcast({ event: "auth:updated", data: { request, action } });
    return action;
  }

  deleteAction(requestId: string, actionId: string): AuthRequestAction {
    const request = this.requireActionEditableRequest(requestId);
    const action = deleteAuthRequestAction(this.db, request.id, actionId);
    this.broadcast({ event: "auth:updated", data: { request, deleted_action_id: action.id } });
    return action;
  }

  checkMergeIndependence(input: AuthMergeCheckInput): AuthMergeCheckReport {
    const repo = input.repo ?? null;
    const baseBranch = input.base_branch ?? null;
    const headBranch = input.head_branch ?? null;
    const cwd = input.cwd ?? null;

    if (!baseBranch || !headBranch || !cwd) {
      return {
        status: "unknown",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [],
        reason: "base_branch, head_branch, and cwd are required for merge checks"
      };
    }

    const candidateTarget = this.mergeTree(cwd, baseBranch, headBranch);
    if (candidateTarget.status === "error") {
      return {
        status: "error",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [],
        reason: candidateTarget.message
      };
    }
    if (candidateTarget.status === "conflict") {
      return {
        status: "conflict",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [{
          scope: "target",
          request_id: null,
          head_branch: headBranch,
          files: candidateTarget.files,
          message: candidateTarget.message
        }]
      };
    }

    let simulatedBase = baseBranch;
    let checked = 0;
    const pending = this.pendingMergeRequestsForCheck({
      repo,
      baseBranch,
      excludeId: input.request_id ?? null,
    });

    for (const request of pending) {
      if (!request.head_branch) {
        continue;
      }
      checked += 1;
      const pendingResult = this.mergeTree(cwd, simulatedBase, request.head_branch);
      if (pendingResult.status === "error") {
        return {
          status: "error",
          repo,
          base_branch: baseBranch,
          head_branch: headBranch,
          checked_requests: checked,
          conflicts: [],
          reason: pendingResult.message
        };
      }
      if (pendingResult.status === "conflict") {
        return {
          status: "conflict",
          repo,
          base_branch: baseBranch,
          head_branch: headBranch,
          checked_requests: checked,
          conflicts: [{
            scope: "queue",
            request_id: request.id,
            head_branch: request.head_branch,
            files: pendingResult.files,
            message: pendingResult.message
          }]
        };
      }
      simulatedBase = this.createSyntheticMergeCommit(
        cwd,
        pendingResult.tree!,
        simulatedBase,
        request.head_branch
      );
      const candidateAfterPending = this.mergeTree(cwd, simulatedBase, headBranch);
      if (candidateAfterPending.status === "error") {
        return {
          status: "error",
          repo,
          base_branch: baseBranch,
          head_branch: headBranch,
          checked_requests: checked,
          conflicts: [],
          reason: candidateAfterPending.message
        };
      }
      if (candidateAfterPending.status === "conflict") {
        return {
          status: "conflict",
          repo,
          base_branch: baseBranch,
          head_branch: headBranch,
          checked_requests: checked,
          conflicts: [{
            scope: "queue",
            request_id: request.id,
            head_branch: request.head_branch,
            files: candidateAfterPending.files,
            message: candidateAfterPending.message
          }]
        };
      }
    }

    return {
      status: "clean",
      repo,
      base_branch: baseBranch,
      head_branch: headBranch,
      checked_requests: checked,
      conflicts: []
    };
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
      "type",
      "title",
      "diff_summary",
      "commit_message",
      "spec_content",
      "post_merge_handoff",
      "repo",
      "base_branch",
      "head_branch",
      "files_changed",
      "additions",
      "deletions",
      "command",
      "cwd",
      "depends_on_id"
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

    if ("issue_references" in payload) {
      const refs = payload.issue_references as string[] | null | undefined;
      updates.push("issue_references = ?");
      values.push(refs && Array.isArray(refs) ? JSON.stringify(refs) : null);
    }

    if ("issue_closures" in payload) {
      const closures = payload.issue_closures as string[] | null | undefined;
      updates.push("issue_closures = ?");
      values.push(closures && Array.isArray(closures) ? JSON.stringify(closures) : null);
    }

    // Bug: 297677f — legacy issues is a close-on-merge JSON array.
    if ("issues" in payload) {
      const ci = payload.issues as string[] | null | undefined;
      updates.push("issues = ?");
      values.push(ci && Array.isArray(ci) ? JSON.stringify(ci) : null);
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
    this.syncLedgerLinksForRequest(updated, false);
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
          "status IN ('pending', 'approved', 'executing', 'expired', 'needs_rebase') " +
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

  /**
   * Bug: 4e32923 — mark an auth request as delivered to the owning session via
   * the MCP channel server. Once set, the row drops out of the owner's tier-1
   * inbox and won't escalate to tiers 2/3. Idempotent: re-delivery is a no-op
   * (existing delivered_at is preserved). Returns true if a row was updated,
   * false if the request is unknown.
   */
  markDelivered(id: string): boolean {
    const resolved = resolvePrefix(this.db, "auth_requests", "id", id);
    if (!resolved.ok) {
      return false;
    }
    const now = this.now();
    const result = this.db
      .prepare(
        "UPDATE auth_requests SET delivered_at = ?, updated_at = ? " +
          "WHERE id = ? AND delivered_at IS NULL"
      )
      .run(now, now, resolved.id);
    // changes === 0 either means unknown id or already delivered; both are
    // acceptable terminal states for an idempotent endpoint, so we return
    // true so long as the row exists.
    if (result.changes === 0) {
      const exists = this.db
        .prepare("SELECT 1 FROM auth_requests WHERE id = ?")
        .get(resolved.id);
      return exists != null;
    }
    return true;
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

  approve(id: string, approval?: AuthApprovalContext): AuthRequest {
    this.expireStale();
    let request = this.requireRequest(id);
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
    const executionContextUpdate = this.resolveExecutionContextBeforeApproval(request);
    if (executionContextUpdate) {
      this.db
        .prepare(
          "UPDATE auth_requests SET cwd = ?, target_repo_root = ?, repo = ?, updated_at = ? WHERE id = ?"
        )
        .run(
          executionContextUpdate.cwd,
          executionContextUpdate.target_repo_root,
          executionContextUpdate.repo,
          now,
          id
        );
      request = this.requireRequest(id);
    }

    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, updated_at = ?, approval_source = ?, approval_lease_id = ? WHERE id = ?"
      )
      .run(now, now, approval?.source ?? "manual", approval?.leaseId ?? null, id);

    const executing = this.requireRequest(id);
    if (approval?.env) {
      this.executionEnvs.set(executing.id, approval.env);
    }
    this.executeInBackground(executing);
    return executing;
  }

  private resolveExecutionContextBeforeApproval(
    request: AuthRequest
  ): { cwd: string; target_repo_root: string; repo: string | null } | null {
    if (request.execution_mode === "remote" || !isAuthMergeCommand(request)) {
      return null;
    }
    try {
      const resolved = resolveAuthMergeExecutionContext(this.db, request);
      return {
        cwd: resolved.executionCwd,
        target_repo_root: resolved.targetRepoRoot,
        repo: request.repo ?? resolved.repoName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid auth merge execution context.";
      throw new AuthQueueError(
        "invalid_command",
        `Auth merge request cannot be approved: ${message}`
      );
    }
  }

  autoApprovePending(approval: AuthApprovalContext): AuthRequest[] {
    const approved: AuthRequest[] = [];
    for (const request of this.listPending()) {
      try {
        approved.push(this.approve(request.id, approval));
      } catch (error) {
        console.warn(
          `[auth-queue] auto-approval failed for pending request ${request.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return approved;
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
    if (exitCode === 0) {
      this.afterSuccessfulMerge(completed);
    }
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

    const recoveredIds: string[] = [];
    const runRecovery = this.db.transaction(() => {
      const stuckRows = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') " +
            "AND exit_code IS NULL AND approved_at < ? " +
            "AND (output IS NULL OR output = '' OR (output NOT LIKE '%Merge made by%' AND output NOT LIKE '%Fast-forward%'))"
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
        recoveredIds.push(String(row.id));
      }
    });

    runRecovery();

    if (recoveredIds.length === 0) {
      return;
    }

    for (const id of recoveredIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(recovered)
        });
      }
      console.log(
        `[auth-queue] periodic recovery: stuck request ${id} approved >10min without merge evidence — marking as interrupted`
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
            onOutput: (chunk) => this.handleOutput(chunk),
            env: this.executionEnvs.get(request.id),
          });

          // Bug: 4afab83 — run post-auth hooks after successful execution,
          // BEFORE reporting completion. Hook failures don't change the
          // auth result (the merge already succeeded).
          if (result.exit_code === 0) {
            const mergedRequest = { ...request, ...this.getRequest(request.id) } as AuthRequest;
            const isSelfMerge = mergedRequest.repo === "mandible";

            // Bug: 87dfff0 — broadcast rebuilding SSE before hooks so the
            // UI shows the splash screen during the build step.
            // Bug: 4db692a — also set the _rebuilding flag so the health
            // endpoint returns rebuilding:true, preventing premature reload.
            if (isSelfMerge) {
              this._rebuilding = true;
              this.broadcast({ event: "mandible:rebuilding", data: {} });
            }

            try {
              const hookResults = await this.hookManager.executeHooks(
                mergedRequest,
                (hookLabel, text) => {
                  this.handleOutput({
                    request_id: request.id,
                    stream: "stderr",
                    text: `[hook: ${hookLabel}] ${text}`,
                    timestamp: Date.now(),
                  });
                },
              );
              for (const hr of hookResults) {
                const status = hr.exit_code === 0 ? "ok" : `failed (exit ${hr.exit_code})`;
                this.handleOutput({
                  request_id: request.id,
                  stream: "stderr",
                  text: `[hook: ${hr.label}] ${status} (${hr.duration_ms}ms)\n`,
                  timestamp: Date.now(),
                });
              }
            } catch (hookError) {
              console.warn(
                `[auth-queue] hook execution failed for request ${request.id}: ${hookError instanceof Error ? hookError.message : String(hookError)}`
              );
            }

          }

          // Store result and broadcast auth:resolved BEFORE scheduling
          // any self-rebuild exit, so the channel server receives the
          // SSE event while the daemon is still alive.
          this.storeExecutionResult(request.id, result, null);

          // Bug: 87dfff0 — after hooks complete (build finished), schedule
          // a graceful exit so launchd respawns with the new code.
          // Bug: 03d6cb0 — delay increased to 2s (from 0.5s) and moved
          // after storeExecutionResult so the auth:resolved SSE broadcast
          // has time to reach the channel server before the daemon exits.
          if (result.exit_code === 0) {
            const mergedForRestart = { ...request, ...this.getRequest(request.id) } as AuthRequest;
            if (mergedForRestart.repo === "mandible") {
              console.log("[auth-queue] self-merge detected, scheduling daemon restart (2s delay for event delivery)");
              setTimeout(() => process.exit(0), 2000);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Execution failed.";
          this.storeExecutionResult(request.id, null, message);
        } finally {
          this.inFlight.delete(request.id);
          this.executionEnvs.delete(request.id);
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

    // Bug: 929c6d0 — when the executor ran but exited non-zero, populate the
    // error column with the tail of the captured output so the agent receiving
    // the auth:resolved event can diagnose without a follow-up API call.
    let errorText = error;
    if (errorText == null && exitCode !== 0 && result != null) {
      errorText = tailLines(result.output, 20);
    }

    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = ?, error = ? WHERE id = ?"
      )
      .run(now, now, exitCode, errorText, id);

    const completed = this.requireRequest(id);
    // Bug: 2164775 — run idempotent success finalizers before the resolved
    // broadcast so consumers observe the resolved work-unit/ledger state.
    if (exitCode === 0) {
      this.afterSuccessfulMerge(completed);
    }
    this.broadcast({
      event: "auth:resolved",
      data: this.buildResolvedPayload(completed)
    });

    // Bug: 0c44fec — after a successful merge (exit_code=0), auto-dismiss any
    // other pending/failed requests targeting the same branch merge. These are
    // stale duplicates (retries, corrected-CWD resubmissions) — approving them
    // would waste a YubiKey tap on a branch that no longer exists.
  }

  private afterSuccessfulMerge(completed: AuthRequest): void {
    this.autoDismissDuplicates(completed);
    this.revalidatePendingMergeRequests(completed);
    this.applyLedgerCompletionForRequest(completed);
    // Bug: 8a281b3 — resolve work units on successful auth merge (best-effort;
    // work_units table may not exist in test DBs or fresh installs mid-migration)
    if (this.tableExists("work_units")) {
      try {
        this.resolveWorkUnitsOnMerge(completed);
      } catch (err) {
        console.warn(
          `[auth-queue] failed to resolve work units after merge: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private sweepSuccessfulMergeFinalizers(): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE type = 'merge' AND status = 'completed' AND exit_code = 0"
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      this.afterSuccessfulMerge(mapRow(row));
    }
  }

  private pendingMergeRequestsForCheck({
    repo,
    baseBranch,
    excludeId,
  }: {
    repo: string | null;
    baseBranch: string;
    excludeId: string | null;
  }): AuthRequest[] {
    const args: unknown[] = [baseBranch];
    let where = "type = 'merge' AND base_branch = ? AND head_branch IS NOT NULL " +
      "AND status IN ('pending', 'approved', 'executing')";
    if (repo) {
      where += " AND repo = ?";
      args.push(repo);
    }
    if (excludeId) {
      where += " AND id != ?";
      args.push(excludeId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_requests WHERE ${where} ` +
          "ORDER BY COALESCE(skipped_at, created_at) ASC, created_at ASC"
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map((row) => mapRow(row));
  }

  private mergeTree(
    cwd: string,
    base: string,
    head: string
  ): MergeTreeResult {
    try {
      const stdout = execFileSync("git", ["merge-tree", "--write-tree", base, head], {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      }).trim();
      const tree = stdout.split(/\s+/)[0] ?? "";
      if (!tree) {
        return { status: "error", files: [], message: "git merge-tree did not return a tree" };
      }
      return { status: "clean", tree, files: [], message: "clean" };
    } catch (error) {
      const output = outputFromExecError(error);
      if (isMergeTreeInfrastructureError(error)) {
        return {
          status: "error",
          files: [],
          message: output.trim() || errorMessage(error) || "git merge-tree infrastructure error"
        };
      }
      return {
        status: "conflict",
        files: conflictFilesFromMergeTreeOutput(output, cwd, base, head),
        message: output.trim() || "git merge-tree reported a conflict"
      };
    }
  }

  private createSyntheticMergeCommit(
    cwd: string,
    tree: string,
    firstParent: string,
    secondParent: string
  ): string {
    return execFileSync(
      "git",
      ["commit-tree", tree, "-p", firstParent, "-p", secondParent, "-m", "mandible auth check synthetic merge"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Mandible",
          GIT_AUTHOR_EMAIL: "mandible@localhost",
          GIT_COMMITTER_NAME: "Mandible",
          GIT_COMMITTER_EMAIL: "mandible@localhost"
        }
      }
    ).trim();
  }

  private revalidatePendingMergeRequests(completed: AuthRequest): void {
    if (!completed.repo || !completed.base_branch || !completed.cwd) {
      return;
    }
    const pending = this.pendingMergeRequestsForCheck({
      repo: completed.repo,
      baseBranch: completed.base_branch,
      excludeId: completed.id,
    }).filter((request) => request.status === "pending");
    if (pending.length === 0) {
      return;
    }

    const now = this.now();
    const markNeedsRebase = this.db.prepare(
      "UPDATE auth_requests SET status = 'needs_rebase', resolved_at = ?, updated_at = ?, error = ? WHERE id = ? AND status = 'pending'"
    );

    for (const request of pending) {
      const report = this.checkMergeIndependence({
        request_id: request.id,
        repo: request.repo,
        base_branch: request.base_branch,
        head_branch: request.head_branch,
        cwd: request.cwd ?? completed.cwd,
      });
      if (report.status !== "conflict") {
        continue;
      }
      const conflict = report.conflicts[0];
      const files = conflict?.files.length ? ` Files: ${conflict.files.join(", ")}.` : "";
      const reason =
        `Needs rebase: ${request.head_branch ?? request.id.slice(0, 8)} conflicts after ` +
        `${completed.head_branch ?? completed.id.slice(0, 8)} merged.${files}`;
      const result = markNeedsRebase.run(now, now, reason, request.id);
      if (result.changes === 0) {
        continue;
      }
      const invalidated = this.getRequest(request.id);
      if (invalidated) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(invalidated)
        });
        this.broadcast({
          event: "auth:needs_rebase",
          data: { request: invalidated, check: report }
        });
      }
    }
  }

  private syncLedgerLinksForRequest(request: AuthRequest, recordEvent: boolean): void {
    try {
      syncAuthRequestLedgerLinks(this.db, {
        auth_request_id: request.id,
        repo_ref: request.repo ?? request.cwd ?? request.target_repo_root ?? null,
        issue_references: request.issue_references ?? null,
        issue_closures: request.issue_closures ?? null,
        issue_ids: request.issue_ids ?? null,
        issues: request.issues ?? null,
        commit_message: request.commit_message,
        merge_output: request.output,
        recordEvent,
      });
    } catch {
      // Ledger tables are optional during staged migration and in fallback test DBs.
    }
  }

  private applyLedgerCompletionForRequest(request: AuthRequest): void {
    try {
      applyAuthRequestLedgerCompletion(this.db, {
        auth_request_id: request.id,
        repo_ref: request.repo ?? request.cwd ?? request.target_repo_root ?? null,
        issue_references: request.issue_references ?? null,
        issue_closures: request.issue_closures ?? null,
        issue_ids: request.issue_ids ?? null,
        issues: request.issues ?? null,
        commit_message: request.commit_message,
        merge_output: request.output,
        approval_source: request.approval_source,
        approval_lease_id: request.approval_lease_id,
      });
    } catch (error) {
      console.warn(
        `[auth-queue] failed to apply ledger completion for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
      );
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

  /**
   * When an auth request completes successfully (exit_code=0), resolve
   * associated work units:
   * 1. Work units whose auth_request_id matches the completed request
   * 2. Work units whose branch matches the auth request's head_branch
   * 3. Work units linked to explicit auth closure issue IDs
   * Bug: 8a281b3
   */
  private resolveWorkUnitsOnMerge(completed: AuthRequest): void {
    const now = this.now();
    const resolveStmt = this.db.prepare(
      "UPDATE work_units SET state = 'resolved', resolved_at = ? WHERE id = ? AND state IN ('open', 'committed')"
    );

    const resolvedIds = new Set<string>();

    // 1. Match by auth_request_id
    const byAuthId = this.db
      .prepare(
        "SELECT id FROM work_units WHERE auth_request_id = ? AND state IN ('open', 'committed')"
      )
      .all(completed.id) as Array<{ id: string }>;

    for (const row of byAuthId) {
      resolveStmt.run(now, row.id);
      resolvedIds.add(row.id);
    }

    // 2. Match by branch
    if (completed.head_branch) {
      const byBranch = this.db
        .prepare(
          "SELECT id FROM work_units WHERE branch = ? AND state IN ('open', 'committed')"
        )
        .all(completed.head_branch) as Array<{ id: string }>;

      for (const row of byBranch) {
        if (!resolvedIds.has(row.id)) {
          resolveStmt.run(now, row.id);
          resolvedIds.add(row.id);
        }
      }
    }

    // 3. Match by explicit close-on-merge issue IDs. Mandible-Issue trailers and
    // issue_references are provenance links, not completion signals.
    const closesIssues = completed.issue_closures ?? completed.issues ?? [];
    const allIssueIds = [...closesIssues];

    // Bug: f3dbb3e — bidirectional prefix match: the work unit may store a
    // short prefix of the issue ID, or the auth request may have a short prefix.
    // SQL LIKE only handles one direction, so we fetch all unresolved work units
    // and filter in JS.
    if (allIssueIds.length > 0) {
      const allUnresolved = this.db.prepare(
        "SELECT id, issue_id FROM work_units WHERE state IN ('open', 'committed')"
      ).all() as Array<{ id: string; issue_id: string }>;

      for (const issueId of allIssueIds) {
        const matching = allUnresolved.filter(row =>
          issueId.startsWith(row.issue_id) || row.issue_id.startsWith(issueId)
        );
        for (const row of matching) {
          if (!resolvedIds.has(row.id)) {
            resolveStmt.run(now, row.id);
            resolvedIds.add(row.id);
          }
        }
      }
    }

    // 4. Match by canonical ledger links, covering auth requests that were
    // linked by ledger issue ID rather than by legacy git-bug prefixes.
    if (
      this.tableExists("ledger_auth_issue_links") &&
      this.tableExists("ledger_work_unit_issue_links")
    ) {
      const byLedgerIssue = this.db.prepare(
        `SELECT DISTINCT wu.id
         FROM ledger_auth_issue_links ail
         JOIN work_units wu ON wu.ledger_issue_id = ail.issue_id
         WHERE ail.auth_request_id = ?
           AND ail.link_type IN ('resolves', 'fixed_by')
           AND wu.state IN ('open', 'committed')
         UNION
         SELECT DISTINCT wu.id
         FROM ledger_auth_issue_links ail
         JOIN ledger_work_unit_issue_links wil ON wil.issue_id = ail.issue_id
         JOIN work_units wu ON wu.id = wil.work_unit_id
         WHERE ail.auth_request_id = ?
           AND ail.link_type IN ('resolves', 'fixed_by')
           AND wu.state IN ('open', 'committed')`
      ).all(completed.id, completed.id) as Array<{ id: string }>;

      for (const row of byLedgerIssue) {
        if (!resolvedIds.has(row.id)) {
          resolveStmt.run(now, row.id);
          resolvedIds.add(row.id);
        }
      }
    }

    if (resolvedIds.size > 0) {
      console.log(
        `[auth-queue] resolved ${resolvedIds.size} work unit(s) after successful merge of ${completed.head_branch ?? completed.id.slice(0, 8)}`
      );
    }
  }

  private tableExists(table: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(row);
  }

  // Bug: 93c57c4 — derive outcome from lifecycle status + exit_code at read time.
  // Consumers should use `outcome` to determine the terminal result of a request;
  // `status` is reserved for lifecycle state (pending → executing → completed, etc.).
  private computeOutcome(request: AuthRequest): AuthRequestOutcome {
    switch (request.status) {
      case "rejected":
        return "rejected";
      case "dismissed":
        return "dismissed";
      case "expired":
        return "expired";
      case "needs_rebase":
        return "needs_rebase";
      case "completed":
        return (request.exit_code != null && request.exit_code !== 0) ? "failed" : "succeeded";
      default:
        // pending, executing, approved — still in lifecycle
        return null;
    }
  }

  private buildResolvedPayload(request: AuthRequest): Record<string, unknown> {
    // Bug: 929c6d0 — include tail of executor output when exit_code > 0 so the
    // agent receiving the event can diagnose without a follow-up API call. The
    // `error` field carries the stored error message (which now includes the
    // tail output for daemon-executed requests). `error_output` is a separate
    // field with the raw tail in case consumers want the unprocessed output.
    const errorOutput = (request.exit_code != null && request.exit_code !== 0 && request.output)
      ? tailLines(request.output, 20)
      : null;

    return {
      request_id: request.id,
      type: request.type,
      status: request.status,
      outcome: this.computeOutcome(request),
      exit_code: request.exit_code,
      error: request.error,
      error_output: errorOutput,
      resolved_at: request.resolved_at,
      // Bug: 4e32923 — include title and head_branch so the channel-server
      // can build a meaningful `notifications/claude/channel` payload without
      // a follow-up fetch. Pre-existing logging-message formatter already
      // reads these fields; they were missing from the payload before.
      title: request.title ?? null,
      head_branch: request.head_branch ?? null,
      // Bug: 4e32923 — emit owner session id so the MCP channel server can
      // filter auth:resolved events to only the originating session (and
      // legacy unscoped rows still broadcast via target_session_id == null).
      target_session_id: request.target_session_id,
      // Bug: 6d7411b — emit conversation_id so the channel server can match
      // events across session restarts within the same conversation.
      conversation_id: request.conversation_id
    };
  }

  private isFailedLike(request: AuthRequest): boolean {
    if (request.status === "expired" || request.status === "needs_rebase") {
      return true;
    }
    if (request.status !== "completed") {
      return false;
    }
    return request.exit_code != null && request.exit_code !== 0;
  }

  private requireActionEditableRequest(id: string): AuthRequest {
    const request = this.requireRequest(id);
    if (request.status !== "pending" && !this.isFailedLike(request)) {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot modify staged actions.`,
        request.status
      );
    }
    return request;
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

}

// Bug: 929c6d0 — extract the last N lines from a string for error output summaries.
function tailLines(text: string, n: number): string | null {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const tail = lines.slice(-n);
  const result = tail.join("\n").trim();
  return result || null;
}

function extractIssueIdsFromCommitMessage(commitMessage: string | null | undefined): string[] | null {
  if (!commitMessage) return null;
  const refs: string[] = [];
  const regex = /^Mandible-Issue:\s+(\S+)/gm;
  let m;
  while ((m = regex.exec(commitMessage)) !== null) refs.push(m[1]);
  return refs.length > 0 ? refs : null;
}

function outputFromExecError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const maybe = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = Buffer.isBuffer(maybe.stdout) ? maybe.stdout.toString("utf8") : String(maybe.stdout ?? "");
  const stderr = Buffer.isBuffer(maybe.stderr) ? maybe.stderr.toString("utf8") : String(maybe.stderr ?? "");
  const message = typeof maybe.message === "string" ? maybe.message : "";
  return [stdout, stderr, message].filter(Boolean).join("\n");
}

function isMergeTreeInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function conflictFilesFromMergeTreeOutput(
  output: string,
  cwd: string,
  base: string,
  head: string
): string[] {
  const files = new Set<string>();
  const patterns = [
    /CONFLICT \([^)]+\): .* in (.+)$/gm,
    /^Auto-merging (.+)$/gm,
    /^changed in both\s+(.+)$/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1]?.trim();
      if (file) {
        files.add(file);
      }
    }
  }
  if (files.size === 0) {
    try {
      const diff = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
        cwd,
        encoding: "utf8",
      });
      for (const line of diff.split("\n")) {
        const file = line.trim();
        if (file) {
          files.add(file);
        }
      }
    } catch {
      // Best-effort context only; the merge-tree message remains authoritative.
    }
  }
  return Array.from(files).sort();
}

function mapRow(row: Record<string, unknown>): AuthRequest {
  // Bug: ba9687f — parse issue_ids JSON array from DB
  let issueIds: string[] | null = null;
  if (row.issue_ids != null) {
    try {
      issueIds = JSON.parse(String(row.issue_ids));
    } catch {
      issueIds = null;
    }
  }

  let issueReferences: string[] | null = null;
  if (row.issue_references != null) {
    try {
      issueReferences = JSON.parse(String(row.issue_references));
    } catch {
      issueReferences = null;
    }
  }

  let issueClosures: string[] | null = null;
  if (row.issue_closures != null) {
    try {
      issueClosures = JSON.parse(String(row.issue_closures));
    } catch {
      issueClosures = null;
    }
  }

  // Bug: 297677f — parse issues JSON array from DB
  let parsedIssues: string[] | null = null;
  if (row.issues != null) {
    try {
      parsedIssues = JSON.parse(String(row.issues));
    } catch {
      parsedIssues = null;
    }
  }

  // Bug: dd21c1e — parse type column, default to 'merge' for backward compat
  const rawType = row.type == null ? "merge" : String(row.type);
  const type: AuthRequestType = VALID_AUTH_REQUEST_TYPES.includes(rawType as AuthRequestType)
    ? (rawType as AuthRequestType)
    : "merge";

  return {
    id: String(row.id),
    session_id: row.session_id == null ? null : String(row.session_id),
    type,
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
    post_merge_handoff: row.post_merge_handoff == null ? null : String(row.post_merge_handoff),
    issue_references: issueReferences,
    issue_closures: issueClosures ?? parsedIssues,
    issue_ids: issueIds,
    issues: parsedIssues,
    depends_on_id: row.depends_on_id == null ? null : String(row.depends_on_id),
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
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by),
    // Bug: 4e32923 — owner session + repo root + channel-delivery watermark.
    target_session_id: row.target_session_id == null ? null : String(row.target_session_id),
    target_repo_root: row.target_repo_root == null ? null : String(row.target_repo_root),
    delivered_at: row.delivered_at == null ? null : Number(row.delivered_at),
    // Bug: 6d7411b — conversation_id for cross-resume matching
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    approval_source: row.approval_source == null ? "manual" : String(row.approval_source),
    approval_lease_id: row.approval_lease_id == null ? null : String(row.approval_lease_id)
  };
}
