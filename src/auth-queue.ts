import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { executeAuthCommand, type AuthExecutionResult } from "./auth-executor.js";
import {
  authorizedMergeSignerLines,
  extractSuccessfulMergeCommitSha,
  verifyAuthorizedMergeCommitSignature,
  verifySuccessfulMergeCommitSignature,
  type MergeSignatureVerification,
} from "./auth-signature-verification.js";
import {
  addAuthRequestAction,
  countAuthRequestActions,
  deleteAuthRequestAction,
  insertAuthRequestActions,
  listAuthRequestActions,
  normalizeAuthActionInputs,
  setAuthRequestActionVeto,
  updateAuthRequestAction,
} from "./auth-actions.js";
import type { AuthApprovalContext, AuthAutoApprover } from "./auth-auto-approve.js";
import {
  AuthExecutionContextError,
  isAuthMergeCommand,
  resolveAuthMergeExecutionContext,
  resolveBranchHeadSha,
} from "./auth-context.js";
import { AuthHookManager, type AuthHookExecutionResult } from "./auth-hooks.js";
import { canonicalRepoKeyForPath, canonicalRepoKeysForRef } from "./repo-identity.js";
import {
  defaultCodexThreadArchiver,
  listCompletedWorkerThreadArchiveCandidates,
  safeArchiveCodexThread,
  type CodexThreadArchiver,
} from "./codex-thread-archive.js";
import { getDaemonLogger } from "./daemon-log.js";
import { getDb, resolvePrefix } from "./db.js";
import {
  applyAuthRequestLedgerCompletion,
  resolveOperationalIssueRef,
  syncAuthRequestLedgerLinks,
} from "./ledger/operational-links.js";
import { getLedgerIssueHead } from "./ledger/issue-heads.js";
import { LedgerStore } from "./ledger/store.js";
import {
  assertEvidenceMethod,
  localDefaultAttribution,
  resolveSessionIdAttributionResult,
  systemAction,
  type AttributionContext,
} from "./identity/resolver.js";
import {
  AttributionReadResolver,
  authAttributionReadFields,
} from "./identity/read-projection.js";
import {
  addAttributionEvidence,
  getAttributionEvidence,
  getDelegatedSigningLease,
  getOperator,
  getUserById,
} from "./users/store.js";
import type {
  LedgerRelationshipType,
  LedgerWorkerStatus,
} from "./ledger/types.js";
import { broadcast as defaultBroadcast } from "./sse.js";
import type {
  AuthOutputChunk,
  AuthRequest,
  AuthRequestAction,
  AuthRequestInput,
  AuthRequestOutcome,
  AuthRequestStatus,
  AuthRequestSummary,
  AuthRequestType,
  SseEvent
} from "./types.js";

// Pending approvals are human-cadence, not machine-cadence — the queue is
// async by design, so the default TTL gives a week rather than a day.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_RESOLVED_MS = 60 * 60 * 1000; // Show resolved items for 1 hour

// Columns selected for the history list projection. Deliberately excludes the
// unbounded body blobs `diff_summary`, `spec_content`, and `output` so a
// 50–200 row list does not read or serialize megabytes of text per poll. The
// full body is served by the detail route and fetched on selection. Keep this
// list updated when a non-blob auth_requests column is added.
const AUTH_HISTORY_SUMMARY_COLUMNS = [
  "id", "session_id", "command", "title", "cwd", "status",
  "created_at", "updated_at", "approved_at", "resolved_at", "skipped_at",
  "expires_at", "exit_code", "error", "repo", "base_branch", "head_branch",
  "files_changed", "additions", "deletions", "execution_mode", "commit_message",
  "last_executed_at", "acknowledged_by", "post_merge_handoff", "issue_ids",
  "depends_on_id", "issues", "type", "target_session_id", "target_repo_root",
  "delivered_at", "conversation_id", "approval_source", "approval_lease_id",
  "issue_references", "issue_closures", "merge_preflight_base_sha",
  "merge_preflight_queue_fingerprint", "merge_head_sha", "merge_candidate_tree_sha",
  "merge_candidate_pin_sha", "merge_atomic_enabled", "merge_finalized_at",
].join(", ");

// Issue 75f52ac — off-loop git spawns for the background finalizer queue.
const execFileAsync = promisify(execFile);

// Issue 75f52ac — background finalizer queue tuning.
// Concurrency is 1 (steps touch shared tables); FIFO with dedup by request id.
const FINALIZER_MAX_QUEUED = 32;
// Per-step retry ceiling. A step that keeps throwing is marked failed after
// this many attempts (surfaced in auth:finalized) so the request still
// finalizes instead of looping forever.
const FINALIZER_MAX_ATTEMPTS = 3;
// Stage 3 finalizer steps in execution order. Durable per-step state is keyed
// by these names in auth_requests.merge_finalizer_state.
const FINALIZER_STEP_NAMES = [
  "revalidate_pending",
  "auto_dismiss_duplicates",
  "resolve_ancestry_work_units",
  "archive_worker_threads",
] as const;
type FinalizerStepName = (typeof FINALIZER_STEP_NAMES)[number];
// Issue 75f52ac — per-step output persisted alongside step state. The terminal
// auth:finalized payload is reconstructed from these persisted outputs rather
// than process-local accumulators, so a step whose output was produced on an
// EARLIER pass (or before a crash) is not lost when a later pass skips the
// already-done step or a fresh queue replays the row.
type FinalizerStepOutput = {
  resolved_work_unit_ids?: string[];
  archived_thread_count?: number;
};
type FinalizerStepState = {
  state: "pending" | "done" | "failed";
  attempts: number;
  error?: string;
  at: number;
  output?: FinalizerStepOutput;
};
// Issue fbf2a58 round 2 — a reserved (non-step) marker stored alongside the
// per-step finalizer state. It records that a merge was terminalized from
// repository evidence ALONE (an attributed merge that landed out-of-band with no
// daemon approval record). Such a row deliberately keeps merge_finalized_at NULL
// so finalizer sweeps keep revisiting it and can converge to full finalization
// once approval attribution appears; this marker keeps the partial merged/
// resolved broadcast idempotent across those repeated sweeps. It is not a
// FinalizerStepName, so the step loop and terminal-payload builder ignore it.
type EvidenceOnlyPartialMarker = { at: number };
type FinalizerState = Partial<Record<FinalizerStepName, FinalizerStepState>> & {
  evidence_only_partial?: EvidenceOnlyPartialMarker;
};

/**
 * Issue 75f52ac — bounded, single-concurrency FIFO queue that runs the heavy
 * post-merge finalizers off the daemon event loop. Dedups by request id; when
 * full, `enqueue` reports overflow (false) rather than throwing — the row stays
 * unfinalized and the periodic sweep re-enqueues it. `drain()` resolves once the
 * queue is fully idle (used by the self-merge restart drain and tests).
 */
class FinalizerQueue {
  private readonly ids: string[] = [];
  private readonly queued = new Set<string>();
  private processing = false;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly process: (id: string) => Promise<void>,
    private readonly maxQueued: number = FINALIZER_MAX_QUEUED,
  ) {}

  /** Returns false when the queue is full (overflow is a backstop, not an error). */
  enqueue(id: string): boolean {
    if (this.queued.has(id)) {
      return true;
    }
    if (this.ids.length >= this.maxQueued) {
      return false;
    }
    this.ids.push(id);
    this.queued.add(id);
    void this.run();
    return true;
  }

  get idle(): boolean {
    return !this.processing && this.ids.length === 0;
  }

  async drain(): Promise<void> {
    if (this.idle) {
      return;
    }
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private async run(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.ids.length > 0) {
        const id = this.ids.shift()!;
        this.queued.delete(id);
        try {
          await this.process(id);
        } catch {
          // process() is written to never throw; guard defensively so one bad
          // request cannot wedge the queue.
        }
      }
    } finally {
      this.processing = false;
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }
}
// Bug: dd21c1e — valid auth request types
const VALID_AUTH_REQUEST_TYPES: AuthRequestType[] = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "preset-promote", "data-delete"
];
const VALID_WORKER_STATUSES = ["none", "in_progress", "done", "blocked", "pivot-needed"];
const VALID_RELATIONSHIP_TYPES = [
  "parent_child",
  "blocks",
  "duplicate_of",
  "related",
  "references",
  "fixed_by",
  "caused_by",
  "implements",
  "tests",
];

const authLog = getDaemonLogger();

type MergeTreeResult =
  | { status: "clean"; tree: string; files: string[]; message: string }
  | { status: "conflict"; files: string[]; message: string }
  | { status: "error"; files: string[]; message: string };

type StaleMergeRecovery =
  | { outcome: "completed" }
  | { outcome: "atomic_applied"; mergeSha: string }
  | { outcome: "atomic_needs_recovery"; detail: string }
  | { outcome: "requeued"; detail: string }
  | { outcome: "failed"; detail: string };

export class AuthQueueError extends Error {
  readonly code: "not_found" | "invalid_status" | "invalid_command" | "merge_conflict" | "merge_check_failed";
  readonly status?: AuthRequestStatus;
  readonly details?: unknown;

  constructor(
    code: "not_found" | "invalid_status" | "invalid_command" | "merge_conflict" | "merge_check_failed",
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

// Issue fbf2a58 — a queued auth request whose head branch ref no longer exists
// (already merged and torn down, or manually deleted). Distinct from a merge
// conflict: it contributes no bytes and cannot be simulated, so it is reported
// as a stale-request condition with remediation rather than a conflict.
export interface AuthMergeStaleRequest {
  request_id: string;
  head_branch: string;
  message: string;
}

export interface AuthMergeCheckReport {
  status: "clean" | "conflict" | "error" | "unknown" | "stale_request";
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  checked_requests: number;
  conflicts: AuthMergeConflict[];
  // Issue fbf2a58 — populated only when status is "stale_request".
  stale_requests?: AuthMergeStaleRequest[];
  target_head_sha?: string | null;
  queue_fingerprint?: string | null;
  reason?: string;
}

export interface CodexArchiveReplayResult {
  request_id: string;
  archived: number;
  // Issue 75f52ac — count of candidates that HAD a provider handle but whose
  // codex archive CLI attempt failed (error/timeout). Distinct from
  // "definitively not archivable" candidates, which are filtered out of the
  // candidate list before any attempt. The Stage 3 finalizer step propagates a
  // non-zero count as a step failure so the bounded retry re-attempts it.
  attempt_failures: number;
  candidates: Array<{
    provider_session_id: string;
    console_session_id: string | null;
    mandible_session_id: string | null;
    issue_id: string;
    work_unit_id: string | null;
    archived: boolean;
  }>;
}

export interface AuthQueueOptions {
  db?: InstanceType<typeof Database>;
  now?: () => number;
  ttlMs?: number;
  broadcast?: (event: SseEvent) => void;
  executor?: typeof executeAuthCommand;
  hookManager?: AuthHookManager;
  autoApprover?: AuthAutoApprover;
  codexThreadArchiver?: CodexThreadArchiver;
  // Issue 93d978e — override the abandoned-work-unit merge-scan retention
  // window (default 30 days) so tests can exercise the retirement sweep.
  workUnitAbandonedScanRetentionMs?: number;
  // Issue ded17e6 — injectable process-restart hook so the self-merge drain
  // can be exercised without exiting the test runner. Defaults to process.exit.
  restartFn?: () => void;
  // Read-only preview instances expose auth status and independence checks but
  // must not recover, reconcile, expire, or finalize requests in the copied DB.
  backgroundMaintenance?: boolean;
}

const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REFS_HEADS_PREFIX = "refs/heads/";

/**
 * Issue 93d978e — batches merge-side work-unit ancestry checks.
 *
 * Replaces per-row `git merge-base --is-ancestor` spawns with a lazily built
 * per-`(repoRoot, target)` reachable-commit hash set (one `git rev-list <target>`)
 * plus one `git for-each-ref refs/heads` tip map per root. This is provably
 * equivalent to the per-row check: `is-ancestor A B` ⇔ `A ∈ rev-list(B)`
 * (inclusive of B itself). Unlike `for-each-ref --merged`, the reachable-set
 * approach still resolves deleted-branch `last_commit_hash` snapshots and
 * request-head-only evidence, so it preserves current semantics exactly.
 *
 * One instance is constructed per `workUnitsMergedByRequest` call and never
 * shared across requests — the repo state has changed by definition. Any git
 * failure resolves to `false`, matching the previous `gitIsAncestor` catch-all.
 */
class AncestryBatch {
  // key = `${root}\0${target}`; null = rev-list failed (cached, no re-spawn).
  private readonly reachable = new Map<string, Set<string> | null>();
  // per-root branch tip map; null = for-each-ref failed.
  private readonly tips = new Map<string, Map<string, string> | null>();

  // Issue 93d978e — true once any (root, target) rev-list build or any per-root
  // for-each-ref build failed (cached as null). A failed build makes every
  // ancestry test against it read as "not an ancestor", so a caller that mutates
  // state off those negatives (the abandoned-row retirement sweep) must skip the
  // pass rather than tombstone a genuinely merged snapshot that only looked
  // unmerged because the batch could not be built.
  hadFailure(): boolean {
    for (const value of this.reachable.values()) {
      if (value === null) return true;
    }
    for (const value of this.tips.values()) {
      if (value === null) return true;
    }
    return false;
  }

  // Issue 75f52ac — async so the rev-list / for-each-ref spawns run off the
  // daemon event loop inside the background finalizer queue. Same args,
  // timeouts, maxBuffer, and null-on-failure semantics as the previous sync
  // implementation; equivalence to per-row `git merge-base --is-ancestor` is
  // preserved (see class docstring).
  async isAncestor(root: string, candidate: string, target: string): Promise<boolean> {
    let resolved: string | null;
    if (GIT_OID_RE.test(candidate)) {
      resolved = candidate.toLowerCase();
    } else if (candidate.startsWith(REFS_HEADS_PREFIX)) {
      const name = candidate.slice(REFS_HEADS_PREFIX.length);
      resolved = (await this.tipsFor(root))?.get(name) ?? null;
    } else {
      resolved = null;
    }
    if (!resolved) return false;
    const set = await this.reachableFor(root, target);
    return set ? set.has(resolved) : false;
  }

  private async reachableFor(root: string, target: string): Promise<Set<string> | null> {
    const key = `${root}\0${target}`;
    const cached = this.reachable.get(key);
    if (cached !== undefined) return cached;
    let result: Set<string> | null = null;
    try {
      const { stdout } = await execFileAsync("git", ["rev-list", target], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024 * 1024,
      });
      result = new Set<string>();
      for (const line of String(stdout).split("\n")) {
        const sha = line.trim().toLowerCase();
        if (sha) result.add(sha);
      }
    } catch {
      result = null;
    }
    this.reachable.set(key, result);
    return result;
  }

  private async tipsFor(root: string): Promise<Map<string, string> | null> {
    const cached = this.tips.get(root);
    if (cached !== undefined) return cached;
    let result: Map<string, string> | null = null;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["for-each-ref", "--format=%(objectname) %(refname)", REFS_HEADS_PREFIX],
        { cwd: root, encoding: "utf8", timeout: 5000 },
      );
      const out = String(stdout);
      result = new Map<string, string>();
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const space = trimmed.indexOf(" ");
        if (space < 0) continue;
        const sha = trimmed.slice(0, space).toLowerCase();
        const refname = trimmed.slice(space + 1);
        const name = refname.startsWith(REFS_HEADS_PREFIX)
          ? refname.slice(REFS_HEADS_PREFIX.length)
          : refname;
        result.set(name, sha);
      }
    } catch {
      result = null;
    }
    this.tips.set(root, result);
    return result;
  }
}

export class AuthQueue {
  private readonly db: InstanceType<typeof Database>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly broadcast: (event: SseEvent) => void;
  private readonly executor: typeof executeAuthCommand;
  private readonly hookManager: AuthHookManager;
  private readonly autoApprover?: AuthAutoApprover;
  private readonly codexThreadArchiver: CodexThreadArchiver;
  // Issue 93d978e — abandoned work units older than this window are retired
  // from merge-side ancestry scans (reversible tombstone, not deletion).
  private readonly workUnitAbandonedScanRetentionMs: number;
  // Issue 93d978e — memoized presence of work_units.merge_scan_retired_at.
  // Lightweight test DBs that create work_units ad hoc lack the column; when
  // absent, both the scan filter and the retirement sweep are skipped.
  private workUnitRetirementColumn: boolean | undefined;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly executionEnvs = new Map<string, NodeJS.ProcessEnv>();
  // Issue ded17e6 — one execution chain per canonical repo identity. Merges in
  // distinct physical repos run concurrently; merges in the same repo (across
  // any path/symlink alias) stay strictly FIFO. Unresolvable identities share a
  // single conservative global chain (UNRESOLVED_CHAIN_KEY).
  private readonly executionChains = new Map<string, Promise<void>>();
  // Issue ded17e6 — injectable restart hook for the self-merge drain.
  private readonly restartFn: () => void;
  // Issue 75f52ac — bounded, idempotent, crash-safe queue that runs the heavy
  // post-merge finalizers (Stage 3) off the event loop after auth:resolved.
  private readonly finalizerQueue: FinalizerQueue;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  // Bug: 4db692a — tracks whether the daemon is about to restart after a
  // self-merge. Exposed via isRebuilding so the health endpoint can include
  // it in the response, preventing the UI from reloading prematurely.
  //
  // Bug: 681739e — while true, admission is closed: executeInBackground parks
  // any new execution (reverts it to pending) instead of starting a merge that
  // the imminent process.exit would kill mid-flight.
  private _rebuilding = false;
  // Bug: 681739e — durable marker (meta key) recording when a self-merge
  // scheduled the restart. On the next startup, requests approved before this
  // instant that never recorded a result are recovered immediately instead of
  // waiting out the multi-minute stuck-request threshold.
  private static readonly SELF_MERGE_SHUTDOWN_KEY = "auth_self_merge_shutdown_at";
  // Issue ded17e6 — shared chain for requests whose repo identity cannot be
  // resolved (deleted checkout, malformed request, non-merge command). These
  // serialize conservatively with each other, never with resolvable repos.
  private static readonly UNRESOLVED_CHAIN_KEY = "\0mandible-unresolved-repo\0";
  // Issue ded17e6 — cap on how long a self-merge restart waits for foreign-repo
  // executions to drain before forcing the restart (the shutdown marker plus
  // startup recovery is the backstop for anything still running).
  private static readonly SELF_MERGE_DRAIN_CAP_MS = 60_000;

  constructor(options: AuthQueueOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const broadcast = options.broadcast ?? defaultBroadcast;
    this.broadcast = (event) => broadcast(projectAuthAttributionEvent(this.db, event));
    this.executor = options.executor ?? executeAuthCommand;
    this.hookManager = options.hookManager ?? new AuthHookManager(this.db);
    this.autoApprover = options.autoApprover;
    this.codexThreadArchiver = options.codexThreadArchiver ?? defaultCodexThreadArchiver;
    this.workUnitAbandonedScanRetentionMs =
      options.workUnitAbandonedScanRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.restartFn = options.restartFn ?? (() => process.exit(0));
    // Issue 75f52ac — construct the finalizer queue before any recovery pass:
    // recovery re-runs finalizeSuccessfulMerge, which enqueues Stage 3 work.
    this.finalizerQueue = new FinalizerQueue((id) => this.runBackgroundFinalizers(id));
    // Bug: 681739e — fast-recover executions orphaned by a self-merge restart
    // before the generic (threshold-based) stuck-request recovery runs.
    if (options.backgroundMaintenance !== false) {
      this.recoverSelfMergeShutdown();
      this.recoverStuckRequests();
      // Issue fbf2a58 — reconcile merge requests whose merge already landed but
      // whose finalization write was lost (e.g. a terminal-executed auth-merge
      // whose post-merge dist rebuild restarted the daemon before the finalize
      // committed). Runs after the stuck-request recovery so it only inspects
      // rows the other recovery paths left pending/approved.
      this.reconcileAlreadyMergedRequests();
      this.startExpiryTimer();
    }
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
        // Issue 75f52ac — crash/overflow backstop: re-run any successful merge
        // whose finalizers never completed, but only when the queue is idle so
        // the 30 s tick never piles work onto an already-busy queue.
        if (this.finalizerQueue.idle) {
          this.sweepSuccessfulMergeFinalizers();
          // Issue fbf2a58 — periodic backstop for merges whose finalization was
          // lost while the queue was idle (mirrors the startup reconciliation).
          this.reconcileAlreadyMergedRequests();
        }
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
   * Merge recovery is based on repository state, never console text. A head
   * already contained in the base is finalized successfully. A cleanly
   * identifiable interrupted merge is aborted and requeued for approval. Any
   * state whose provenance cannot be proven fails closed without mutating Git.
   */
  private recoverStuckRequests(): void {
    const now = this.now();
    const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
    const cutoff = now - STUCK_THRESHOLD_MS;

    const { recoveredSuccessIds, recoveredFailureIds, requeuedIds } =
      this.recoverStaleExecutions(cutoff, "daemon restart");

    for (const id of recoveredSuccessIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        // Issue 75f52ac — staged: emits auth:merged → Stage 2 → auth:resolved,
        // then enqueues Stage 3 finalizers. finalizeSuccessfulMerge attaches
        // signature/execution evidence on the critical path before auth:resolved,
        // matching the prior recovery broadcast behaviour.
        this.finalizeSuccessfulMerge(recovered);
        authLog("warn", "auth_request_recovered_success", {
          subsystem: "auth",
          auth_request_id: id,
          reason: "merge_succeeded_result_not_recorded",
        });
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
      authLog("warn", "auth_request_recovered_interrupted", {
        subsystem: "auth",
        auth_request_id: id,
        reason: "approved_unfinished_after_5min",
      });
    }

    for (const id of requeuedIds) {
      const requeued = this.getRequest(id);
      if (requeued) {
        this.broadcast({ event: "auth:updated", data: { request: requeued } });
      }
      authLog("warn", "auth_request_recovered_requeued", {
        subsystem: "auth",
        auth_request_id: id,
        reason: "interrupted_merge_aborted_safely",
      });
    }

    this.sweepSuccessfulMergeFinalizers();
  }

  /**
   * Issue fbf2a58 — reconcile merge requests whose merge already landed but
   * whose status finalization was lost.
   *
   * A terminal-executed `mandible auth merge` in the Mandible repo triggers a
   * post-merge dist rebuild that restarts the daemon. If the finalize write
   * races that restart it can be lost, leaving the request 'pending'/'approved'
   * even though its head is already merged. The stale row then poisons queue
   * preflight (its torn-down branch reads as a conflict) until it is deleted by
   * hand.
   *
   * This pass finalizes any pending/approved merge request whose head branch is
   * already an ancestor of — or tree-equivalent to — its target branch,
   * mirroring the branch_reap_proof logic in cli/auth-merge.sh. Requests whose
   * merge cannot be proven from Git are left untouched: reconciliation never
   * guesses.
   */
  private reconcileAlreadyMergedRequests(): void {
    let rows: Record<string, unknown>[];
    try {
      rows = this.db
        .prepare(
          "SELECT * FROM auth_requests WHERE type = 'merge' AND status IN ('pending', 'approved') " +
            "AND exit_code IS NULL AND merge_finalized_at IS NULL"
        )
        .all() as Record<string, unknown>[];
    } catch {
      // Fresh/partial DBs mid-migration: nothing to reconcile.
      return;
    }
    if (rows.length === 0) {
      return;
    }

    const now = this.now();
    const complete = this.db.prepare(
      "UPDATE auth_requests SET status = 'completed', exit_code = 0, resolved_at = ?, " +
        "updated_at = ?, error = NULL, merge_head_sha = COALESCE(merge_head_sha, ?) " +
        "WHERE id = ? AND status IN ('pending', 'approved') AND exit_code IS NULL"
    );

    for (const row of rows) {
      const request = mapRow(row);
      if (!isAuthMergeCommand(request)) {
        continue;
      }
      const proof = this.reapProofForRequest(request);
      if (!proof) {
        continue;
      }
      const updated = complete.run(now, now, proof.headSha, request.id);
      if (updated.changes !== 1) {
        continue;
      }
      const recovered = this.getRequest(request.id);
      if (recovered) {
        this.finalizeReconciledMerge(recovered);
      }
      authLog("warn", "auth_request_reconciled_already_merged", {
        subsystem: "auth",
        auth_request_id: request.id,
        reason:
          proof.proof === "merged"
            ? "head_is_ancestor_of_target"
            : "head_tree_equivalent_to_target",
        head_sha: proof.headSha,
      });
    }
  }

  /**
   * Issue fbf2a58 — finalize a merge request that startup reconciliation proved
   * already landed. The row is already status='completed'/exit_code=0 (so it has
   * dropped out of the pending set and no longer poisons preflight); this drives
   * the broadcasts, ledger completion, and Stage 3 finalizers.
   *
   * Attribution note: the normal finalizer demands an approving user for
   * post-v109 attributed merges. That holds when the merge was approved through
   * the daemon and only its final status write was lost. But the reported
   * incident merged out-of-band in a terminal with no daemon approval record, so
   * the attributed evidence path cannot run — Git proves the merge landed, but
   * the daemon never observed who authorized it. In that case terminalize the
   * row from repository evidence alone (completed + merged/resolved broadcasts)
   * without fabricating an approver.
   *
   * This is the shared convergence dispatcher: it is invoked both by startup
   * reconciliation and by the periodic finalizer sweep, so a row that was
   * partially terminalized without an approver is re-examined on every sweep and
   * completes the skipped stages (attributed ledger completion, work-unit
   * resolution, thread archiving) as soon as approval attribution appears.
   */
  private finalizeReconciledMerge(request: AuthRequest): void {
    const attributedMerge = isAuthMergeCommand(request) && Boolean(request.requested_by_user_id);
    const hasApprovalEvidence =
      request.execution_evidence_id != null || request.approved_by_user_id != null;
    if (!attributedMerge || hasApprovalEvidence) {
      // Legacy (system-attributed) merge, or an attributed merge that was
      // approved through the daemon before its finalization write was lost:
      // the standard finalizer records evidence and runs every stage. When this
      // path runs for a row that was previously evidence-only terminalized (its
      // approval attribution has since appeared), full finalization now completes
      // and sets merge_finalized_at — the convergence step.
      this.finalizeSuccessfulMerge(request);
      return;
    }

    // Attributed merge with no daemon approval record: authorized out-of-band.
    //
    // Issue fbf2a58 round 2 — PARTIAL ("evidence-only") terminalization. The row
    // is already status='completed'/exit_code=0 (set by the reconcile UPDATE), so
    // it is terminal for the queue and UI and no longer poisons preflight. We
    // deliberately DO NOT write merge_finalized_at here: that column is the
    // finalizer sweep's exclusion key, and setting it would permanently strand
    // the stages we cannot yet run without an approver identity (attributed
    // ledger completion incl. issue closures, work-unit resolution, thread
    // archival). Instead we leave merge_finalized_at NULL so every later sweep
    // revisits this row, and record a distinct evidence_only_partial marker so
    // the partial merged/resolved broadcast stays idempotent across sweeps. When
    // approval attribution later appears (approved_by_user_id / execution_
    // evidence_id populated), a sweep re-enters this method, takes the full
    // finalizer branch above, runs the skipped stages, and finally writes
    // merge_finalized_at — full convergence.
    if (this.hasEvidenceOnlyPartialMarker(request)) {
      // Already partially terminalized; nothing new until attribution appears.
      return;
    }
    const now = this.now();
    this.markEvidenceOnlyPartialFinalization(request, now);
    const finalized = this.getRequest(request.id);
    if (finalized) {
      this.broadcast({ event: "auth:merged", data: this.buildMergedPayload(finalized) });
      this.broadcast({ event: "auth:resolved", data: this.buildResolvedPayload(finalized) });
    }
    authLog("warn", "auth_request_reconciled_without_approval_attribution", {
      subsystem: "auth",
      auth_request_id: request.id,
      reason: "merge_landed_out_of_band_no_daemon_approval",
    });
  }

  /**
   * Issue fbf2a58 round 2 — whether a row has been evidence-only (partially)
   * terminalized: a completed merge that lacks approval attribution and so has
   * not yet run full finalization. Detected from the durable marker in
   * merge_finalizer_state rather than merge_finalized_at, which stays NULL so the
   * sweep keeps revisiting for convergence.
   */
  private hasEvidenceOnlyPartialMarker(request: AuthRequest): boolean {
    return this.readFinalizerState(request.id).evidence_only_partial != null;
  }

  /**
   * Issue fbf2a58 round 2 — record the evidence-only partial-finalization marker.
   * Persists merge_head_sha (the head branch may be torn down before convergence)
   * but deliberately NOT merge_finalized_at, so finalizer sweeps keep visiting the
   * row until approval attribution allows full finalization.
   */
  private markEvidenceOnlyPartialFinalization(request: AuthRequest, at: number): void {
    if (request.merge_head_sha != null) {
      this.db
        .prepare(
          "UPDATE auth_requests SET merge_head_sha = COALESCE(merge_head_sha, ?), updated_at = ? WHERE id = ?"
        )
        .run(request.merge_head_sha, at, request.id);
    }
    const state = this.readFinalizerState(request.id);
    state.evidence_only_partial = { at };
    this.writeFinalizerState(request.id, state);
  }

  /**
   * Issue fbf2a58 — prove that a merge request's head is already contained in
   * its target branch, mirroring branch_reap_proof in cli/auth-merge.sh.
   *
   * Ancestry (`git merge-base --is-ancestor`) is the primary proof; a synthetic
   * merge that reproduces the target's exact tree (`git merge-tree --write-tree`
   * tree-equivalence) is the merge-aware fallback for squash/rebase landings.
   * The head commit comes from the live branch ref, falling back to a recorded
   * merge_head_sha when the branch was already torn down. Returns null when
   * nothing is checkable so the caller leaves the request alone.
   */
  private reapProofForRequest(
    request: AuthRequest,
  ): { proof: "merged" | "tree-equivalent"; headSha: string } | null {
    const cwd = request.target_repo_root ?? request.cwd;
    if (!cwd || !request.base_branch) {
      return null;
    }
    try {
      const git = (args: string[]): string =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        }).trim();
      const verify = (rev: string): string | null => {
        try {
          const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]);
          return sha || null;
        } catch {
          return null;
        }
      };

      // Issue fbf2a58 round 2 — a recorded merge_head_sha is AUTHORITATIVE. It
      // pins the exact commit whose merge this request represents, so the proof
      // must be taken against it, never against a live head-branch ref that may
      // have been recreated or force-moved after the merge landed. If a live ref
      // exists and disagrees with the pinned sha, the branch is no longer the one
      // that was merged (e.g. a fresh branch recreated at the target tip, for
      // which "T is an ancestor of T" would falsely prove completion): refuse to
      // reconcile, log the mismatch, and leave the request pending. The live ref
      // is used only when no merge_head_sha was ever recorded.
      let headSha: string | null = null;
      if (request.merge_head_sha) {
        const recorded = verify(request.merge_head_sha);
        if (!recorded) {
          // The pinned commit is not present in this repo — nothing safely
          // checkable. Never guess.
          return null;
        }
        if (request.head_branch) {
          const liveHead = verify(`refs/heads/${request.head_branch}`);
          if (liveHead && liveHead !== recorded) {
            authLog("warn", "auth_reconcile_head_sha_mismatch", {
              subsystem: "auth",
              auth_request_id: request.id,
              head_branch: request.head_branch,
              recorded_merge_head_sha: recorded,
              live_head_sha: liveHead,
              reason: "head_ref_disagrees_with_recorded_merge_head_sha",
            });
            return null;
          }
        }
        headSha = recorded;
      } else if (request.head_branch) {
        headSha = verify(`refs/heads/${request.head_branch}`);
      }
      if (!headSha) {
        // Nothing checkable — never guess.
        return null;
      }

      const targetOid = verify(`refs/heads/${request.base_branch}`);
      if (!targetOid) {
        return null;
      }

      // Ancestry proof.
      try {
        git(["merge-base", "--is-ancestor", headSha, targetOid]);
        return { proof: "merged", headSha };
      } catch {
        // Not an ancestor — fall through to tree-equivalence.
      }

      // Tree-equivalence proof: a synthetic merge that yields the target's exact
      // tree contributes no bytes (covers squash/rebase-style landings).
      let targetTree: string | null;
      try {
        targetTree = git(["rev-parse", "--verify", `${targetOid}^{tree}`]) || null;
      } catch {
        targetTree = null;
      }
      if (!targetTree) {
        return null;
      }
      const merged = this.mergeTree(cwd, targetOid, headSha);
      if (merged.status === "clean" && merged.tree === targetTree) {
        return { proof: "tree-equivalent", headSha };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Bug: 681739e — recover executions orphaned by a self-merge restart.
   *
   * A Mandible self-merge exits the daemon (~2 s after completing) so launchd
   * respawns the rebuilt code. Any request that was in-flight or queued at that
   * moment is killed without recording a result and would otherwise sit
   * 'executing'/'approved' until the 5-minute stuck-request threshold fires.
   *
   * The self-merge records a durable shutdown timestamp before exiting. On the
   * next startup we recover every request approved before that instant that
   * never recorded a result, using the shutdown time as the cutoff so recovery
   * is immediate rather than threshold-gated. The marker is consumed (one-shot)
   * so a later clean startup does not re-trigger recovery.
   */
  private recoverSelfMergeShutdown(): void {
    const shutdownAt = this.consumeSelfMergeShutdown();
    if (shutdownAt == null) {
      return;
    }
    // approved_at strictly less than the cutoff is recovered; +1 makes the
    // comparison inclusive of requests approved at the recorded instant.
    const result = this.recoverStaleExecutions(shutdownAt + 1, "self-merge restart");
    this.emitRecoveredExecutions(result);
    authLog("info", "auth_self_merge_shutdown_recovered", {
      subsystem: "auth",
      shutdown_at: shutdownAt,
      recovered_success: result.recoveredSuccessIds.length,
      recovered_failure: result.recoveredFailureIds.length,
      requeued: result.requeuedIds.length,
    });
  }

  /**
   * Broadcast and finalize the outcome of a stale-execution recovery pass.
   * Successful merges run idempotent success finalizers before the resolved
   * broadcast; requeued requests emit an updated event so clients re-render the
   * pending row.
   */
  private emitRecoveredExecutions(result: {
    recoveredSuccessIds: string[];
    recoveredFailureIds: string[];
    requeuedIds: string[];
  }): void {
    for (const id of result.recoveredSuccessIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.finalizeSuccessfulMerge(recovered);
      }
    }
    for (const id of result.recoveredFailureIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.broadcast({ event: "auth:resolved", data: this.buildResolvedPayload(recovered) });
      }
    }
    for (const id of result.requeuedIds) {
      const requeued = this.getRequest(id);
      if (requeued) {
        this.broadcast({ event: "auth:updated", data: { request: requeued } });
      }
    }
  }

  /** Bug: 681739e — durably record the instant a self-merge scheduled its restart. */
  private recordSelfMergeShutdown(at: number): void {
    try {
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(AuthQueue.SELF_MERGE_SHUTDOWN_KEY, String(at));
    } catch (error) {
      authLog("warn", "auth_self_merge_shutdown_record_failed", {
        subsystem: "auth",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Bug: 681739e — read and clear the self-merge shutdown marker (one-shot). */
  private consumeSelfMergeShutdown(): number | null {
    let raw: string | undefined;
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(AuthQueue.SELF_MERGE_SHUTDOWN_KEY) as { value?: string } | undefined;
      raw = row?.value;
      if (raw != null) {
        this.db.prepare("DELETE FROM meta WHERE key = ?").run(AuthQueue.SELF_MERGE_SHUTDOWN_KEY);
      }
    } catch {
      return null;
    }
    if (raw == null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Bug: 681739e — park a request that cannot start because a self-merge
   * restart is in progress. The execution never began, so the repository is
   * untouched; revert the row to pending (dropping the just-issued approval) so
   * it survives the restart and can be re-approved against the rebuilt code.
   */
  private parkExecutionForRestart(request: AuthRequest): void {
    this.inFlight.delete(request.id);
    this.executionEnvs.delete(request.id);
    const now = this.now();
    try {
      this.db
        .prepare(
          // Issue fbf2a58 round 2 — drop the just-issued approval FULLY, matching
          // the recoverStaleExecutions requeue path: clearing status/timestamps
          // but leaving approved_by_user_id (or execution_evidence_id) set would
          // leave stale approval attribution on a row awaiting reapproval, which
          // a later evidence-driven finalizer could mistake for a live approval
          // and use to run full finalization. A parked row must carry no approval
          // evidence until it is genuinely re-approved against the rebuilt code.
          `UPDATE auth_requests SET status = 'pending', resolved_at = NULL, approved_at = NULL,
           exit_code = NULL, error = NULL, output = '', expires_at = ?, updated_at = ?,
           approval_source = 'manual', approval_lease_id = NULL,
           approved_by_user_id = NULL, execution_evidence_id = NULL
           WHERE id = ? AND status = 'executing' AND exit_code IS NULL`
        )
        .run(now + this.ttlMs, now, request.id);
    } catch (error) {
      authLog("warn", "auth_execution_park_failed", {
        subsystem: "auth",
        auth_request_id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const parked = this.getRequest(request.id);
    if (parked) {
      this.broadcast({ event: "auth:updated", data: { request: parked } });
    }
    authLog("info", "auth_execution_parked_for_restart", {
      subsystem: "auth",
      auth_request_id: request.id,
    });
  }

  private recoverStaleExecutions(
    cutoff: number,
    context: string,
    excludeInFlight = false,
  ): { recoveredSuccessIds: string[]; recoveredFailureIds: string[]; requeuedIds: string[] } {
    const now = this.now();
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE status IN ('approved', 'executing') " +
          "AND exit_code IS NULL AND approved_at < ?"
      )
      .all(cutoff) as Record<string, unknown>[];
    const recoveredSuccessIds: string[] = [];
    const recoveredFailureIds: string[] = [];
    const requeuedIds: string[] = [];

    const complete = this.db.prepare(
      "UPDATE auth_requests SET status = 'completed', exit_code = ?, resolved_at = ?, updated_at = ?, error = ? WHERE id = ?"
    );
    const requeue = this.db.prepare(
      `UPDATE auth_requests SET status = 'pending', resolved_at = NULL, approved_at = NULL,
       exit_code = NULL, error = NULL, output = '', expires_at = ?, updated_at = ?,
       approval_source = 'manual', approval_lease_id = NULL,
       approved_by_user_id = NULL, execution_evidence_id = NULL WHERE id = ?`
    );

    for (const row of rows) {
      const request = mapRow(row);
      if (excludeInFlight && this.inFlight.has(request.id)) {
        continue;
      }
      if (request.type === "merge" && isAuthMergeCommand(request)) {
        if (request.merge_atomic_enabled) {
          this.scheduleAtomicRecovery(request);
          continue;
        }
        const recovery = this.inspectStaleMerge(request);
        if (recovery.outcome === "completed") {
          complete.run(0, now, now, null, request.id);
          recoveredSuccessIds.push(request.id);
        } else if (recovery.outcome === "atomic_applied") {
          this.scheduleAtomicRecovery(request);
        } else if (recovery.outcome === "atomic_needs_recovery") {
          this.db.prepare("UPDATE auth_requests SET error = ?, updated_at = ? WHERE id = ?")
            .run(`Atomic merge applied and needs recovery: ${recovery.detail}`, now, request.id);
        } else if (recovery.outcome === "requeued") {
          this.dropMergeCandidate(request);
          requeue.run(now + this.ttlMs, now, request.id);
          requeuedIds.push(request.id);
        } else {
          complete.run(1, now, now, `Interrupted auth merge (${context}): ${recovery.detail}`, request.id);
          recoveredFailureIds.push(request.id);
        }
        continue;
      }

      complete.run(1, now, now, `Execution interrupted (${context}); repository recovery is unavailable for this request type.`, request.id);
      recoveredFailureIds.push(request.id);
    }

    return { recoveredSuccessIds, recoveredFailureIds, requeuedIds };
  }

  private inspectStaleMerge(request: AuthRequest): StaleMergeRecovery {
    const checkoutPaths = [request.cwd, request.target_repo_root].filter(
      (value): value is string => Boolean(value),
    );
    if (checkoutPaths.length === 0 || !request.base_branch || !request.head_branch) {
      return { outcome: "failed", detail: "missing repository, base branch, or head branch metadata" };
    }

    try {
      const gitAt = (cwd: string, args: string[]): string => execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
      const identities = checkoutPaths.map((path) => ({
        topLevel: realpathSync(gitAt(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"])),
        commonDir: realpathSync(gitAt(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
      }));
      const identity = identities[0];
      if (!identity || identities.some(
        (candidate) => candidate.topLevel !== identity.topLevel || candidate.commonDir !== identity.commonDir,
      )) {
        return { outcome: "failed", detail: "cwd and target_repo_root do not identify the same Git checkout" };
      }
      const cwd = identity.topLevel;
      const git = (args: string[]): string => gitAt(cwd, args);

      const expectedHead = request.merge_head_sha ?? git([
        "rev-parse", "--verify", `refs/heads/${request.head_branch}^{commit}`,
      ]);
      if (request.merge_atomic_enabled) {
        return this.inspectAtomicAppliedMerge(request, cwd, git, expectedHead);
      }
      try {
        git(["merge-base", "--is-ancestor", expectedHead, `refs/heads/${request.base_branch}`]);
        return { outcome: "completed" };
      } catch {
        // A non-zero ancestor check is the expected interrupted/unmerged case.
      }

      const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
      const mergeHeadPath = join(gitDir, "MERGE_HEAD");
      const trackedStatus = git(["status", "--porcelain", "--untracked-files=no"]);
      if (!existsSync(mergeHeadPath)) {
        if (!trackedStatus) {
          return { outcome: "requeued", detail: "executor stopped before changing the repository" };
        }
        return { outcome: "failed", detail: "tracked changes exist without MERGE_HEAD; provenance is ambiguous" };
      }

      const currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (currentBranch !== request.base_branch) {
        return { outcome: "failed", detail: `MERGE_HEAD is on ${currentBranch}, not requested base ${request.base_branch}` };
      }
      const mergeHeads = git(["rev-parse", "--verify", "MERGE_HEAD"]).split(/\s+/).filter(Boolean);
      if (mergeHeads.length !== 1 || mergeHeads[0] !== expectedHead) {
        return { outcome: "failed", detail: "MERGE_HEAD does not match the requested head commit" };
      }
      if (!trackedStatus) {
        return { outcome: "failed", detail: "MERGE_HEAD exists without staged merge changes" };
      }
      if (git(["diff", "--name-only", "--diff-filter=U"])) {
        return { outcome: "failed", detail: "merge has unresolved conflicts" };
      }
      const hasUnstagedChanges = trackedStatus.split(/\r?\n/).some((line) => line.length >= 2 && line[1] !== " ");
      if (hasUnstagedChanges) {
        return { outcome: "failed", detail: "merge checkout also contains unstaged tracked changes" };
      }
      const head = git(["rev-parse", "HEAD"]);
      const originalHead = git(["rev-parse", "ORIG_HEAD"]);
      if (head !== originalHead) {
        return { outcome: "failed", detail: "HEAD no longer matches the merge's recorded ORIG_HEAD" };
      }
      const expectedMerge = this.mergeTree(cwd, head, expectedHead);
      if (expectedMerge.status !== "clean") {
        return { outcome: "failed", detail: `could not derive the expected merge tree: ${expectedMerge.message}` };
      }
      const indexTree = git(["write-tree"]);
      if (indexTree !== expectedMerge.tree) {
        return { outcome: "failed", detail: "staged index does not match the expected merge tree" };
      }

      git(["merge", "--abort"]);
      const remainingStatus = git(["status", "--porcelain", "--untracked-files=no"]);
      if (existsSync(mergeHeadPath) || remainingStatus) {
        return { outcome: "failed", detail: "git merge --abort did not restore a clean tracked checkout" };
      }
      return { outcome: "requeued", detail: "interrupted merge was aborted safely" };
    } catch (error) {
      return {
        outcome: "failed",
        detail: `repository inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private inspectAtomicAppliedMerge(
    request: AuthRequest,
    cwd: string,
    git: (args: string[]) => string,
    expectedHead: string,
  ): StaleMergeRecovery {
    const baseSha = request.merge_preflight_base_sha;
    const candidateTree = request.merge_candidate_tree_sha;
    if (!baseSha || !candidateTree || !request.base_branch || !request.approved_by_user_id) {
      return { outcome: "failed", detail: "atomic merge recovery metadata is incomplete" };
    }
    const atomicState = extractAtomicMergeState(request.output);
    const prepared = atomicState.prepared;
    if (!prepared) {
      if (atomicState.applied) {
        return { outcome: "atomic_needs_recovery", detail: "applied checkpoint has no matching prepared commit" };
      }
      return { outcome: "requeued", detail: "atomic executor stopped before preparing a commit" };
    }
    if (
      prepared.base_sha !== baseSha || prepared.head_sha !== expectedHead ||
      prepared.tree_sha !== candidateTree ||
      (atomicState.applied && atomicState.applied.merge_sha !== prepared.merge_sha)
    ) {
      return { outcome: "failed", detail: "durable atomic state does not match the reviewed inputs" };
    }
    const targetSha = git(["rev-parse", "--verify", `refs/heads/${request.base_branch}^{commit}`]);
    if (targetSha === baseSha) {
      return { outcome: "requeued", detail: "prepared atomic commit was not applied" };
    }
    if (targetSha !== prepared.merge_sha) {
      return { outcome: "failed", detail: "target ref does not match the durable prepared merge commit" };
    }
    const parents = git(["show", "-s", "--format=%P", prepared.merge_sha]).split(/\s+/).filter(Boolean);
    const targetTree = git(["rev-parse", "--verify", `${prepared.merge_sha}^{tree}`]);
    if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== expectedHead || targetTree !== candidateTree) {
      return { outcome: "failed", detail: "target ref does not match the pinned atomic merge commit" };
    }
    const lease = request.approval_lease_id
      ? getDelegatedSigningLease(this.db, request.approval_lease_id)
      : null;
    const credentialId = lease?.owner_user_id === request.approved_by_user_id
      ? lease.credential_id
      : null;
    const signature = verifyAuthorizedMergeCommitSignature(
      this.db,
      cwd,
      prepared.merge_sha,
      request.approved_by_user_id,
      credentialId,
    );
    if (!signature.verified) {
      return { outcome: "failed", detail: `atomic merge signature is not authorized: ${signature.reason}` };
    }
    const currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (currentBranch !== request.base_branch) {
      return { outcome: "atomic_needs_recovery", detail: "protected worktree is not on the target branch" };
    }
    const indexTree = git(["write-tree"]);
    const trackedStatus = git(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"]);
    if (indexTree === candidateTree && !trackedStatus) {
      return { outcome: "atomic_applied", mergeSha: prepared.merge_sha };
    }
    const baseTree = git(["rev-parse", "--verify", `${baseSha}^{tree}`]);
    if (indexTree !== baseTree) {
      return { outcome: "atomic_needs_recovery", detail: "protected index is neither the pinned base nor merge tree" };
    }
    try {
      git(["diff", "--quiet"]);
      git(["read-tree", "-m", "-u", baseSha, prepared.merge_sha]);
    } catch (error) {
      return {
        outcome: "atomic_needs_recovery",
        detail: `collision-safe worktree synchronization is blocked: ${errorMessage(error) ?? String(error)}`,
      };
    }
    const syncedIndex = git(["write-tree"]);
    const syncedStatus = git(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"]);
    if (syncedIndex !== candidateTree || syncedStatus) {
      return { outcome: "atomic_needs_recovery", detail: "protected worktree synchronization did not converge" };
    }
    return { outcome: "atomic_applied", mergeSha: prepared.merge_sha };
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

  async replayCodexThreadArchives(requestId: string): Promise<CodexArchiveReplayResult> {
    const request = this.getRequest(requestId);
    if (!request) {
      throw new AuthQueueError("not_found", "Request not found.");
    }
    if (request.type !== "merge" || request.status !== "completed" || request.exit_code !== 0) {
      throw new AuthQueueError(
        "invalid_status",
        "Codex archive replay requires a completed successful merge request.",
        request.status,
      );
    }
    return this.archiveCompletedWorkerThreads(request, { logSummary: false });
  }

  submit(payload: AuthRequestInput, requestedByUserId?: string): AuthRequest {
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
    if (mergeCheck.status === "error") {
      throw new AuthQueueError(
        "merge_check_failed",
        `Auth request merge preflight failed: ${mergeCheck.reason ?? "unknown error"}`,
        undefined,
        mergeCheck
      );
    }

    let candidateTreeSha: string | null = null;
    if (
      mergeCheck.status === "clean" && payload.cwd && payload.merge_head_sha &&
      mergeCheck.target_head_sha
    ) {
      const candidate = this.mergeTree(payload.cwd, mergeCheck.target_head_sha, payload.merge_head_sha);
      if (candidate.status === "clean") candidateTreeSha = candidate.tree;
    }

    const now = this.now();
    const requesterUserId = this.resolveRequesterUserId(payload, requestedByUserId);
    const request: AuthRequest = {
      id: randomUUID(),
      session_id: payload.session_id ?? null,
      requested_by_user_id: requesterUserId,
      approved_by_user_id: null,
      execution_evidence_id: null,
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
      merge_head_sha: payload.merge_head_sha ?? null,
      merge_candidate_tree_sha: candidateTreeSha,
      merge_candidate_pin_sha: null,
      merge_atomic_enabled: false,
      merge_preflight_base_sha: mergeCheck.status === "clean" ? mergeCheck.target_head_sha ?? null : null,
      merge_preflight_queue_fingerprint: mergeCheck.status === "clean" ? mergeCheck.queue_fingerprint ?? null : null,
      merge_finalized_at: null,
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
        requested_by_user_id,
        approved_by_user_id,
        execution_evidence_id,
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
        merge_head_sha,
        merge_candidate_tree_sha,
        merge_candidate_pin_sha,
        merge_atomic_enabled,
        merge_preflight_base_sha,
        merge_preflight_queue_fingerprint,
        merge_finalized_at,
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
        @requested_by_user_id,
        @approved_by_user_id,
        @execution_evidence_id,
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
        @merge_head_sha,
        @merge_candidate_tree_sha,
        @merge_candidate_pin_sha,
        @merge_atomic_enabled,
        @merge_preflight_base_sha,
        @merge_preflight_queue_fingerprint,
        @merge_finalized_at,
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
        merge_head_sha: request.merge_head_sha ?? null,
        merge_candidate_tree_sha: request.merge_candidate_tree_sha ?? null,
        merge_candidate_pin_sha: request.merge_candidate_pin_sha ?? null,
        merge_atomic_enabled: request.merge_atomic_enabled ? 1 : 0,
        merge_preflight_base_sha: request.merge_preflight_base_sha ?? null,
        merge_preflight_queue_fingerprint: request.merge_preflight_queue_fingerprint ?? null,
        merge_finalized_at: request.merge_finalized_at,
        post_merge_handoff: request.post_merge_handoff ?? null,
        issue_references: request.issue_references ? JSON.stringify(request.issue_references) : null,
        issue_closures: request.issue_closures ? JSON.stringify(request.issue_closures) : null,
        issue_ids: request.issue_ids ? JSON.stringify(request.issue_ids) : null,
        issues: request.issues ? JSON.stringify(request.issues) : null
      });
      insertAuthRequestActions(this.db, request, actions, now);
    });

    request.merge_candidate_pin_sha = this.cacheMergeCandidate(request);
    try {
      insertRequest();
    } catch (error) {
      this.dropMergeCandidate(request);
      throw error;
    }

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
        authLog("warn", "auth_auto_approval_failed", {
          subsystem: "auth",
          auth_request_id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return request;
  }

  private resolveRequesterUserId(
    payload: AuthRequestInput,
    requestedByUserId?: string,
  ): string {
    const explicit = requestedByUserId?.trim();
    if (explicit) {
      const user = getUserById(this.db, explicit);
      if (!user || user.status !== "active") {
        throw new Error(`Auth requester user '${explicit}' is not active.`);
      }
      return user.id;
    }
    if (payload.session_id) {
      const resolved = resolveSessionIdAttributionResult(this.db, payload.session_id);
      if (resolved.status === "conflict") {
        throw new Error("Auth requester session claims resolve to conflicting users.");
      }
      if (resolved.status === "resolved") return resolved.attribution.user_id;
    }
    // This fallback is unreachable over HTTP (issue a64d2de execution-context
    // determination): the transport route resolveAuthRequester REJECTS a request
    // with 401 when it can neither authenticate a bearer identity nor resolve an
    // unambiguous session binding, and otherwise passes the resolved principal
    // (a managed agent included) here as `requestedByUserId`. So a managed-agent
    // request can never silently become the operator through this seam — it is
    // resolved to the agent or refused. Only a trusted IN-PROCESS caller (a
    // daemon-internal submission with no explicit requester and no session) lands
    // here, which is a genuine local-operator context; the env-marker gate used
    // for the process-local CLI lanes deliberately does NOT apply, since it would
    // read the daemon's own env rather than any per-request context.
    return localDefaultAttribution(this.db).user_id;
  }

  private resolveApproverUserId(candidate?: string): string {
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active") {
      throw new Error("Auth approval requires an active configured operator.");
    }
    const userId = candidate?.trim() || operator.id;
    if (userId !== operator.id) {
      throw new Error("Auth approval identity does not match the configured operator.");
    }
    return operator.id;
  }

  listActions(requestId: string): AuthRequestAction[] {
    const request = this.requireRequest(requestId);
    return listAuthRequestActions(this.db, request.id);
  }

  countActions(requestId: string): number {
    const request = this.requireRequest(requestId);
    return countAuthRequestActions(this.db, request.id);
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

  setActionVeto(requestId: string, actionId: string, vetoed: boolean): AuthRequestAction {
    const request = this.requireActionVetoableRequest(requestId);
    const action = setAuthRequestActionVeto(this.db, request.id, actionId, vetoed, this.now());
    this.broadcast({ event: "auth:updated", data: { request: this.requireRequest(request.id), action } });
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

    const worktreeReady = this.checkMergeWorktreeReady(cwd);
    if (worktreeReady.status === "error") {
      return {
        status: "error",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [],
        reason: worktreeReady.message
      };
    }

    const targetHeadSha = this.resolveBranchHeadForCheck(cwd, baseBranch);
    if (!targetHeadSha) {
      return {
        status: "error",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [],
        reason: `could not resolve target branch head for ${baseBranch}`
      };
    }

    const pending = this.pendingMergeRequestsForCheck({
      repo,
      baseBranch,
      excludeId: input.request_id ?? null,
    });
    const queueFingerprint = this.mergeQueueFingerprint(pending);

    const candidateTarget = this.mergeTree(cwd, baseBranch, headBranch);
    if (candidateTarget.status === "error") {
      return {
        status: "error",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: 0,
        conflicts: [],
        target_head_sha: targetHeadSha,
        queue_fingerprint: queueFingerprint,
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
        }],
        target_head_sha: targetHeadSha,
        queue_fingerprint: queueFingerprint
      };
    }

    let simulatedBase = baseBranch;
    let checked = 0;
    const staleRequests: AuthMergeStaleRequest[] = [];

    for (const request of pending) {
      if (!request.head_branch) {
        continue;
      }
      // Issue fbf2a58 — a queued request whose head branch ref no longer exists
      // (already merged and torn down, or manually deleted) contributes no bytes
      // and cannot be simulated. `git merge-tree` against a missing ref fails and
      // would otherwise read as a conflict/dirty-tree error, poisoning preflight
      // for every other request. Classify it as a stale-request condition with a
      // clear remediation hint instead, skip it, and keep checking the rest.
      if (this.resolveBranchHeadForCheck(cwd, request.head_branch) === null) {
        staleRequests.push({
          request_id: request.id,
          head_branch: request.head_branch,
          message:
            `Queued auth request ${request.id} references head branch ` +
            `'${request.head_branch}', which no longer exists in ${cwd} ` +
            `(already merged and torn down, or deleted). Reconcile the auth ` +
            `queue or dismiss the stale request before rechecking.`,
        });
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
          target_head_sha: targetHeadSha,
          queue_fingerprint: queueFingerprint,
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
          }],
          target_head_sha: targetHeadSha,
          queue_fingerprint: queueFingerprint
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
          target_head_sha: targetHeadSha,
          queue_fingerprint: queueFingerprint,
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
          }],
          target_head_sha: targetHeadSha,
          queue_fingerprint: queueFingerprint
        };
      }
    }

    // Issue fbf2a58 — a genuine conflict among live queued requests already
    // returned above and takes precedence. If the only anomaly is queued
    // requests whose head branch was torn down, surface that as a stale-request
    // condition (with remediation) rather than falsely reporting "clean".
    if (staleRequests.length > 0) {
      return {
        status: "stale_request",
        repo,
        base_branch: baseBranch,
        head_branch: headBranch,
        checked_requests: checked,
        conflicts: [],
        stale_requests: staleRequests,
        target_head_sha: targetHeadSha,
        queue_fingerprint: queueFingerprint,
        reason:
          `${staleRequests.length} queued request(s) reference a head branch ` +
          `that no longer exists; reconcile the auth queue or dismiss them.`,
      };
    }

    return {
      status: "clean",
      repo,
      base_branch: baseBranch,
      head_branch: headBranch,
      checked_requests: checked,
      conflicts: [],
      target_head_sha: targetHeadSha,
      queue_fingerprint: queueFingerprint
    };
  }

  getRequest(id: string): AuthRequest | null {
    this.expireStale();
    // Bug: caa157e — support UUID prefix matching
    const resolved = resolvePrefix(this.db, "auth_requests", "id", id);
    if (!resolved.ok) {
      return null;
    }
    return this.readRequestByExactId(resolved.id);
  }

  getSignatureVerification(id: string): Record<string, unknown> | null {
    const request = this.requireRequest(id);
    return this.signatureVerificationForRequest(request);
  }

  private readRequestByExactId(id: string): AuthRequest | null {
    const row = this.db
      .prepare("SELECT * FROM auth_requests WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  private signatureVerificationForRequest(request: AuthRequest): Record<string, unknown> | null {
    if (!request.execution_evidence_id) return null;
    const evidence = getAttributionEvidence(this.db, request.execution_evidence_id);
    if (!evidence || evidence.evidence_method !== "credential_signature") return null;
    return {
      evidence_id: evidence.id,
      verified_at: evidence.verified_at,
      verified: evidence.details.verified === true,
      commit_sha: evidence.details.commit_sha ?? null,
      target_head_sha: evidence.details.target_head_sha ?? null,
      fingerprint: evidence.details.fingerprint ?? null,
      credential_id: evidence.credential_id,
      user_id: evidence.details.signer_user_id ?? null,
      reason: evidence.details.reason ?? null,
      authorization_evidence_id: evidence.details.authorization_evidence_id ?? null,
      authorization_evidence_method: evidence.details.authorization_evidence_method ?? null,
    };
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
      "merge_head_sha",
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
    const invalidatesMergeCandidate = ["repo", "base_branch", "head_branch", "merge_head_sha", "cwd"]
      .some((field) => field in payload);
    if (invalidatesMergeCandidate) {
      updates.push("merge_preflight_base_sha = NULL");
      updates.push("merge_preflight_queue_fingerprint = NULL");
      updates.push("merge_candidate_tree_sha = NULL");
      updates.push("merge_candidate_pin_sha = NULL");
      updates.push("merge_atomic_enabled = 0");
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
      updates.push("approved_by_user_id = NULL");
      updates.push("execution_evidence_id = NULL");
      updates.push("approval_source = 'manual'");
      updates.push("approval_lease_id = NULL");
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
    if (invalidatesMergeCandidate || dismissFromApproved) {
      this.dropMergeCandidate(request);
    }

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

  /**
   * List projection for the history sidebar: resolved items without the
   * unbounded body blobs (`diff_summary`, `spec_content`, `output`) and with
   * `action_count` resolved in a single batched query instead of one COUNT
   * per row. The detail route serves the full body on selection.
   */
  listHistorySummaries(limit = 50): AuthRequestSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${AUTH_HISTORY_SUMMARY_COLUMNS} FROM auth_requests ` +
          "WHERE status IN ('completed', 'rejected', 'dismissed') " +
          "ORDER BY resolved_at DESC LIMIT ?"
      )
      .all(limit) as Record<string, unknown>[];
    if (rows.length === 0) {
      return [];
    }
    const counts = this.countActionsForRequests(rows.map((row) => String(row.id)));
    return rows.map((row) => {
      const mapped = mapRow(row);
      // Omit the blob keys entirely so the client can distinguish "not loaded"
      // (undefined) from a genuinely empty body (null from the detail route).
      const { diff_summary, spec_content, output, ...summary } = mapped;
      void diff_summary;
      void spec_content;
      void output;
      return { ...summary, action_count: counts.get(String(row.id)) ?? 0 };
    });
  }

  /** Batched action counts for a set of request ids (avoids per-row N+1). */
  private countActionsForRequests(ids: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (ids.length === 0) {
      return counts;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT auth_request_id, COUNT(*) AS count FROM auth_request_actions ` +
          `WHERE auth_request_id IN (${placeholders}) GROUP BY auth_request_id`
      )
      .all(...ids) as Array<{ auth_request_id: string; count: number }>;
    for (const row of rows) {
      counts.set(String(row.auth_request_id), Number(row.count));
    }
    return counts;
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
          "approved_at = NULL, approved_by_user_id = NULL, execution_evidence_id = NULL, " +
          "approval_source = 'manual', approval_lease_id = NULL, " +
          "exit_code = NULL, error = NULL, output = '', " +
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
          "approved_at = NULL, approved_by_user_id = NULL, execution_evidence_id = NULL, " +
          "approval_source = 'manual', approval_lease_id = NULL, " +
          "exit_code = NULL, error = NULL, output = '', " +
          "updated_at = ?, expires_at = ? WHERE id = ?"
      )
      .run(now, now + this.ttlMs, id);
    this.dropMergeCandidate(request);

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
    this.dropMergeCandidate(request);

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
    this.dropMergeCandidate(request);
    authLog("info", "auth_request_deleted", { subsystem: "auth", auth_request_id: id, reason });
    this.broadcast({
      event: "auth:deleted",
      data: { request_id: id }
    });
  }

  approve(id: string, approval?: AuthApprovalContext, approvedByUserId?: string): AuthRequest {
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
          "UPDATE auth_requests SET cwd = ?, target_repo_root = ?, repo = ?, merge_head_sha = COALESCE(merge_head_sha, ?), updated_at = ? WHERE id = ?"
        )
        .run(
          executionContextUpdate.cwd,
          executionContextUpdate.target_repo_root,
          executionContextUpdate.repo,
          executionContextUpdate.merge_head_sha,
          now,
          id
        );
      request = this.requireRequest(id);
    }

    // Manual approval is always the direct interactive signing path. Automated
    // callers pass their delegated approval context explicitly.
    const effectiveApproval = approval;
    const approverUserId = this.resolveApproverUserId(
      effectiveApproval?.approverUserId ?? approvedByUserId,
    );
    const approvalLease = effectiveApproval?.leaseId
      ? getDelegatedSigningLease(this.db, effectiveApproval.leaseId)
      : null;
    if (effectiveApproval) {
      if (!approvalLease) {
        throw new AuthQueueError("invalid_command", "Delegated approval lease is missing.");
      }
      if (approvalLease.owner_user_id !== approverUserId) {
        throw new AuthQueueError("invalid_command", "Delegated approval lease is owned by another approver.");
      }
      if (now < approvalLease.minted_at || now >= approvalLease.expires_at) {
        throw new AuthQueueError("invalid_command", "Delegated approval lease is not currently valid.");
      }
    }
    const exactCredentialId = approvalLease?.credential_id ?? null;
    const signerLines = authorizedMergeSignerLines(this.db, approverUserId, exactCredentialId);
    if (effectiveApproval && isAuthMergeCommand(request) && signerLines.length === 0) {
      throw new AuthQueueError(
        "invalid_command",
        "Delegated approval lease has no active authorized signing credential.",
      );
    }
    const candidateExact = Boolean(
      request.merge_candidate_pin_sha &&
      request.cwd &&
      request.base_branch &&
      request.merge_preflight_base_sha === this.resolveBranchHeadForCheck(request.cwd, request.base_branch) &&
      this.mergeCandidatePinIsValid(request)
    );
    if (request.merge_candidate_pin_sha && !candidateExact) {
      throw new AuthQueueError(
        "merge_check_failed",
        "Reviewed merge inputs or retained candidate changed; requeue and reapprove this request.",
      );
    }
    const atomicEnabled = Boolean(
      request.execution_mode !== "remote" &&
      isAuthMergeCommand(request) &&
      candidateExact &&
      !/(^|\s)--hierarchical(?:\s|$)/.test(request.command) &&
      !this.hasNativeMergeHooks(request.cwd) &&
      signerLines.length > 0
    );
    this.db
      .prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, updated_at = ?, approval_source = ?, approval_lease_id = ?, approved_by_user_id = ?, execution_evidence_id = NULL, merge_atomic_enabled = ? WHERE id = ?"
      )
      .run(
        now,
        now,
        effectiveApproval?.source ?? "manual",
        effectiveApproval?.leaseId ?? null,
        approverUserId,
        atomicEnabled ? 1 : 0,
        id,
      );

    const executing = this.requireRequest(id);
    const executionEnv = {
      ...(effectiveApproval?.env ?? {}),
      ...this.approveTimePreflightEnv(executing),
    };
    if (atomicEnabled) {
      const identity = this.gitCommitIdentity(executing.cwd);
      executionEnv.MANDIBLE_AUTH_ATOMIC = "1";
      executionEnv.MANDIBLE_AUTH_ALLOWED_SIGNERS = signerLines.join("\n");
      executionEnv.GIT_AUTHOR_NAME = identity.name;
      executionEnv.GIT_AUTHOR_EMAIL = identity.email;
      executionEnv.GIT_COMMITTER_NAME = identity.name;
      executionEnv.GIT_COMMITTER_EMAIL = identity.email;
    }
    if (Object.keys(executionEnv).length > 0) {
      this.executionEnvs.set(executing.id, executionEnv);
    }
    this.broadcast({ event: "auth:updated", data: { request: executing } });
    this.executeInBackground(executing);
    return executing;
  }

  private resolveExecutionContextBeforeApproval(
    request: AuthRequest
  ): { cwd: string; target_repo_root: string; repo: string | null; merge_head_sha: string } | null {
    if (request.execution_mode === "remote" || !isAuthMergeCommand(request)) {
      return null;
    }
    try {
      const resolved = resolveAuthMergeExecutionContext(this.db, request);
      if (request.merge_head_sha && request.merge_head_sha !== resolved.headSha) {
        throw new AuthExecutionContextError(
          `Head branch ${resolved.headBranch} moved from reviewed commit ${request.merge_head_sha} to ${resolved.headSha}.`,
        );
      }
      return {
        cwd: resolved.executionCwd,
        target_repo_root: resolved.targetRepoRoot,
        repo: request.repo ?? resolved.repoName,
        merge_head_sha: resolved.headSha,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid auth merge execution context.";
      throw new AuthQueueError(
        "invalid_command",
        `Auth merge request cannot be approved: ${message}`
      );
    }
  }

  private approveTimePreflightEnv(request: AuthRequest): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (
      request.merge_candidate_tree_sha &&
      request.merge_candidate_pin_sha &&
      request.merge_preflight_base_sha &&
      request.merge_head_sha
    ) {
      env.MANDIBLE_AUTH_CANDIDATE_TREE_SHA = request.merge_candidate_tree_sha;
      env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA = request.merge_candidate_pin_sha;
      env.MANDIBLE_AUTH_CANDIDATE_BASE_SHA = request.merge_preflight_base_sha;
      env.MANDIBLE_AUTH_CANDIDATE_HEAD_SHA = request.merge_head_sha;
      env.MANDIBLE_AUTH_CANDIDATE_REF = this.mergeCandidateRef(request.id);
    }
    if (this.canReuseSubmitPreflight(request)) {
      env.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT = "1";
      env.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA = request.merge_preflight_base_sha!;
      env.MANDIBLE_AUTH_PREFLIGHT_QUEUE_FINGERPRINT = request.merge_preflight_queue_fingerprint ?? "";
    }
    return env;
  }

  private mergeCandidatePinIsValid(request: AuthRequest): boolean {
    if (
      !request.cwd ||
      !request.merge_candidate_tree_sha ||
      !request.merge_candidate_pin_sha ||
      !request.merge_preflight_base_sha ||
      !request.merge_head_sha
    ) return false;
    try {
      const git = (args: string[]): string => execFileSync("git", args, {
        cwd: request.cwd!,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
      return (
        git(["cat-file", "-t", request.merge_candidate_pin_sha]) === "commit" &&
        git(["rev-parse", `${request.merge_candidate_pin_sha}^{tree}`]) === request.merge_candidate_tree_sha &&
        git(["rev-parse", `${request.merge_candidate_pin_sha}^1`]) === request.merge_preflight_base_sha &&
        git(["rev-parse", `${request.merge_candidate_pin_sha}^2`]) === request.merge_head_sha &&
        git(["rev-parse", this.mergeCandidateRef(request.id)]) === request.merge_candidate_pin_sha
      );
    } catch {
      return false;
    }
  }

  private mergeCandidateRef(requestId: string): string {
    return `refs/mandible/auth-candidates/${requestId}`;
  }

  private hasNativeMergeHooks(cwd: string | null): boolean {
    if (!cwd) return true;
    for (const name of ["pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-merge"]) {
      try {
        const hookPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        }).trim();
        accessSync(hookPath, fsConstants.X_OK);
        return true;
      } catch {
        // Missing or non-executable hook: continue checking the remaining names.
      }
    }
    return false;
  }

  private gitCommitIdentity(cwd: string | null): { name: string; email: string } {
    if (!cwd) throw new AuthQueueError("invalid_command", "Atomic merge repository path is unavailable.");
    const read = (key: string): string => execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
    const name = read("user.name");
    const email = read("user.email");
    if (!name || !email) {
      throw new AuthQueueError("invalid_command", "Atomic merge requires configured Git author identity.");
    }
    return { name, email };
  }

  private cacheMergeCandidate(request: AuthRequest): string | null {
    if (
      !isAuthMergeCommand(request) ||
      !request.cwd ||
      !request.merge_candidate_tree_sha ||
      !request.merge_preflight_base_sha ||
      !request.merge_head_sha
    ) return null;
    try {
      const pinSha = this.createMergeCandidatePin(request);
      execFileSync(
        "git",
        ["update-ref", this.mergeCandidateRef(request.id), pinSha, ""],
        {
          cwd: request.cwd,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          stdio: "ignore",
        },
      );
      return pinSha;
    } catch (error) {
      authLog("warn", "auth_merge_candidate_cache_unavailable", {
        subsystem: "auth",
        auth_request_id: request.id,
        error: errorMessage(error) ?? "git object cache failure",
      });
      return null;
    }
  }

  private createMergeCandidatePin(request: AuthRequest): string {
    if (
      !request.cwd ||
      !request.merge_candidate_tree_sha ||
      !request.merge_preflight_base_sha ||
      !request.merge_head_sha
    ) throw new Error("merge candidate pin inputs are incomplete");
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    execFileSync("git", ["cat-file", "-e", `${request.merge_candidate_tree_sha}^{tree}`], {
      cwd: request.cwd,
      env,
      stdio: "ignore",
    });
    const pinSha = execFileSync(
      "git",
      [
        "commit-tree",
        request.merge_candidate_tree_sha,
        "-p",
        request.merge_preflight_base_sha,
        "-p",
        request.merge_head_sha,
        "-m",
        `mandible auth candidate pin ${request.id}`,
      ],
      {
        cwd: request.cwd,
        env: {
          ...env,
          GIT_AUTHOR_NAME: "Mandible",
          GIT_AUTHOR_EMAIL: "mandible@localhost",
          GIT_COMMITTER_NAME: "Mandible",
          GIT_COMMITTER_EMAIL: "mandible@localhost",
          GIT_AUTHOR_DATE: "1970-01-01T00:00:00 +0000",
          GIT_COMMITTER_DATE: "1970-01-01T00:00:00 +0000",
        },
        encoding: "utf8",
      },
    ).trim();
    if (!GIT_OID_RE.test(pinSha)) throw new Error("git commit-tree did not return a pin commit");
    return pinSha;
  }

  private dropMergeCandidate(request: AuthRequest): void {
    if (!request.merge_candidate_pin_sha) return;
    try {
      if (request.cwd) {
        execFileSync(
          "git",
          ["update-ref", "-d", this.mergeCandidateRef(request.id), request.merge_candidate_pin_sha],
          {
            cwd: request.cwd,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
            stdio: "ignore",
          },
        );
      }
      this.db.prepare(
        `UPDATE auth_requests SET merge_candidate_tree_sha = NULL,
          merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0, updated_at = ? WHERE id = ?`,
      ).run(this.now(), request.id);
    } catch (error) {
      authLog("warn", "auth_merge_candidate_cleanup_failed", {
        subsystem: "auth",
        auth_request_id: request.id,
        error: errorMessage(error) ?? String(error),
      });
    }
  }

  private canReuseSubmitPreflight(request: AuthRequest): boolean {
    if (!isAuthMergeCommand(request) || !request.cwd || !request.base_branch) {
      return false;
    }
    if (!request.merge_preflight_base_sha || !request.merge_preflight_queue_fingerprint) {
      return false;
    }
    const currentBaseSha = this.resolveBranchHeadForCheck(request.cwd, request.base_branch);
    if (currentBaseSha !== request.merge_preflight_base_sha) {
      return false;
    }
    const currentQueueFingerprint = this.mergeQueueFingerprint(this.pendingMergeRequestsForCheck({
      repo: request.repo ?? null,
      baseBranch: request.base_branch,
      excludeId: request.id,
    }));
    return currentQueueFingerprint === request.merge_preflight_queue_fingerprint;
  }

  private async prepareAuthExecution(request: AuthRequest): Promise<void> {
    if (!this.needsPresenceChallenge(request)) {
      return;
    }
    this.handleOutput({
      request_id: request.id,
      stream: "stderr",
      text: "Auth phase: waiting for YubiKey touch for delegated signing...\n",
      timestamp: Date.now(),
    });
    const approval = await this.autoApprover!.presenceChallenge!(60);
    const refreshed = this.requireRequest(request.id);
    if (!refreshed.approved_by_user_id || approval.approverUserId !== refreshed.approved_by_user_id) {
      throw new Error("Refreshed delegated signing approver does not match the approved request.");
    }
    const lease = getDelegatedSigningLease(this.db, approval.leaseId);
    const now = this.now();
    if (
      !lease || lease.owner_user_id !== refreshed.approved_by_user_id ||
      now < lease.minted_at || now > lease.expires_at
    ) {
      throw new Error("Refreshed delegated signing lease is not valid for the approved request.");
    }
    const signerLines = refreshed.merge_atomic_enabled
      ? authorizedMergeSignerLines(
          this.db,
          refreshed.approved_by_user_id,
          lease.credential_id,
        )
      : [];
    if (refreshed.merge_atomic_enabled && signerLines.length === 0) {
      throw new Error("Delegated signing lease has no active authorized credential for atomic merge.");
    }
    this.executionEnvs.set(request.id, {
      ...(this.executionEnvs.get(request.id) ?? {}),
      ...approval.env,
      ...(refreshed.merge_atomic_enabled
        ? { MANDIBLE_AUTH_ALLOWED_SIGNERS: signerLines.join("\n") }
        : {}),
    });
    this.db
      .prepare("UPDATE auth_requests SET approval_source = ?, approval_lease_id = ?, updated_at = ? WHERE id = ?")
      .run(approval.source, approval.leaseId, now, request.id);
    this.handleOutput({
      request_id: request.id,
      stream: "stderr",
      text: "Auth phase: delegated signing key ready; starting git work...\n",
      timestamp: Date.now(),
    });
  }

  private attachDelegatedExecutionEvidence(
    requestId: string,
    approval: AuthApprovalContext,
    verifiedAt: number = this.now(),
  ): AuthRequest {
    const request = this.requireRequest(requestId);
    if (request.execution_evidence_id) return request;
    if (!request.approved_by_user_id || request.approved_by_user_id !== approval.approverUserId) {
      throw new Error("Auth execution evidence approver does not match the approved request.");
    }
    const lease = getDelegatedSigningLease(this.db, approval.leaseId);
    if (!lease) {
      throw new Error(`Delegated signing lease '${approval.leaseId}' is not registered.`);
    }
    if (
      lease.owner_user_id !== request.approved_by_user_id ||
      verifiedAt < lease.minted_at ||
      verifiedAt > lease.expires_at
    ) {
      throw new Error("Delegated signing lease is not valid for this approver and execution time.");
    }
    const evidenceMethod = approval.source === "auto_lease"
      ? "delegated_lease"
      : "hardware_presence";
    assertEvidenceMethod(evidenceMethod);
    const evidence = addAttributionEvidence(this.db, {
      evidence_method: evidenceMethod,
      credential_id: lease.credential_id,
      lease_id: lease.id,
      details: {
        auth_request_id: request.id,
        authorizer_user_id: request.approved_by_user_id,
        executor_user_id: systemAction().user_id,
        approval_source: approval.source,
      },
    }, verifiedAt);
    this.db.prepare(
      "UPDATE auth_requests SET execution_evidence_id = ?, updated_at = ? WHERE id = ? AND execution_evidence_id IS NULL",
    ).run(evidence.id, verifiedAt, request.id);
    return this.requireRequest(request.id);
  }

  private ensureSuccessfulExecutionEvidence(request: AuthRequest): AuthRequest {
    if (!isAuthMergeCommand(request) || request.execution_evidence_id) return request;
    // Rows predating v109 remain untouched and retain their legacy system-only
    // completion attribution.
    if (!request.requested_by_user_id) return request;
    if (!request.approved_by_user_id) {
      throw new Error("Attributed auth merge completed without an approving user.");
    }
    if (
      request.approval_lease_id &&
      (request.approval_source === "auto_lease" || request.approval_source === "presence_challenge")
    ) {
      return this.attachDelegatedExecutionEvidence(
        request.id,
        {
          source: request.approval_source,
          leaseId: request.approval_lease_id,
          approverUserId: request.approved_by_user_id,
          env: {},
        },
        request.last_executed_at ?? request.resolved_at ?? this.now(),
      );
    }
    if (request.approval_source !== "manual") {
      throw new Error(`Unsupported attributed auth approval source '${request.approval_source}'.`);
    }
    const verifiedAt = request.resolved_at ?? this.now();
    const evidence = addAttributionEvidence(this.db, {
      evidence_method: "hardware_presence",
      details: {
        auth_request_id: request.id,
        authorizer_user_id: request.approved_by_user_id,
        executor_user_id: systemAction().user_id,
        approval_source: "manual",
        verification_basis: "successful_interactive_merge_execution",
      },
    }, verifiedAt);
    this.db.prepare(
      "UPDATE auth_requests SET execution_evidence_id = ?, updated_at = ? WHERE id = ? AND execution_evidence_id IS NULL",
    ).run(evidence.id, verifiedAt, request.id);
    return this.requireRequest(request.id);
  }

  private finalizationAttribution(request: AuthRequest): AttributionContext {
    if (!request.execution_evidence_id) {
      if (request.requested_by_user_id && isAuthMergeCommand(request)) {
        throw new Error("Attributed auth merge finalization requires execution evidence.");
      }
      const legacy = systemAction();
      if (request.approved_by_user_id) legacy.authorizer_user_id = request.approved_by_user_id;
      return legacy;
    }
    if (!request.approved_by_user_id) {
      throw new Error("Auth execution evidence is missing its approving user.");
    }
    const evidence = getAttributionEvidence(this.db, request.execution_evidence_id);
    if (!evidence) {
      throw new Error(`Auth execution evidence '${request.execution_evidence_id}' is missing.`);
    }
    assertEvidenceMethod(evidence.evidence_method);
    if (evidence.details.authorizer_user_id !== request.approved_by_user_id) {
      throw new Error("Auth execution evidence authorizer does not match the approved request.");
    }
    return {
      user_id: systemAction().user_id,
      evidence_method: evidence.evidence_method,
      evidence_id: evidence.id,
      authorizer_user_id: request.approved_by_user_id,
    };
  }

  private needsPresenceChallenge(request: AuthRequest): boolean {
    return request.approval_source === "presence_challenge" &&
      !this.executionEnvs.get(request.id)?.SSH_AUTH_SOCK &&
      Boolean(this.autoApprover?.presenceChallenge);
  }

  autoApprovePending(approval: AuthApprovalContext): AuthRequest[] {
    const approved: AuthRequest[] = [];
    for (const request of this.listPending()) {
      try {
        approved.push(this.approve(request.id, approval));
      } catch (error) {
        authLog("warn", "auth_auto_approval_failed", {
          subsystem: "auth",
          auth_request_id: request.id,
          pending: true,
          error: error instanceof Error ? error.message : String(error),
        });
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
    this.dropMergeCandidate(request);

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
    const request = this.requireRequest(id);
    // main: an attributed auth merge result may only be recorded while the
    // request is actually executing, and a successful attributed merge requires
    // an approving user. These guards run before any state mutation.
    if (isAuthMergeCommand(request) && request.requested_by_user_id !== null && request.status !== "executing") {
      throw new AuthQueueError(
        "invalid_status",
        `Attributed auth merge result cannot be recorded while request is ${request.status}.`,
        request.status,
      );
    }
    if (
      exitCode === 0 &&
      isAuthMergeCommand(request) &&
      request.requested_by_user_id !== null &&
      request.approved_by_user_id === null
    ) {
      throw new AuthQueueError(
        "invalid_status",
        "Attributed auth merge results require an approving user before completion.",
        request.status,
      );
    }
    const now = this.now();
    // Record completion atomically with execution-signature evidence, then run
    // the staged lifecycle (Issue 75f52ac): merged → Stage 2 → resolved → Stage 3.
    const completed = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = ?, output = ?, error = ? WHERE id = ?"
        )
        .run(now, now, exitCode, output, error ?? null, id);
      const stored = this.requireRequest(id);
      return exitCode === 0 ? this.ensureSuccessfulExecutionEvidence(stored) : stored;
    })();
    if (exitCode === 0) {
      this.finalizeSuccessfulMerge(completed);
    } else {
      this.broadcast({
        event: "auth:resolved",
        data: this.buildResolvedPayload(completed)
      });
    }
    this.dropMergeCandidate(completed);
    return this.requireRequest(id);
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
      this.dropMergeCandidate(expired);
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

    const { recoveredSuccessIds, recoveredFailureIds, requeuedIds } =
      this.recoverStaleExecutions(cutoff, "periodic recovery", true);

    if (recoveredSuccessIds.length + recoveredFailureIds.length + requeuedIds.length === 0) {
      return;
    }

    for (const id of recoveredSuccessIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.finalizeSuccessfulMerge(recovered);
      }
      authLog("warn", "auth_request_periodic_recovery_success", {
        subsystem: "auth",
        auth_request_id: id,
        reason: "merged_head_observed_in_base",
      });
    }
    for (const id of recoveredFailureIds) {
      const recovered = this.getRequest(id);
      if (recovered) {
        this.broadcast({ event: "auth:resolved", data: this.buildResolvedPayload(recovered) });
      }
    }
    for (const id of requeuedIds) {
      const requeued = this.getRequest(id);
      if (requeued) {
        this.broadcast({ event: "auth:updated", data: { request: requeued } });
      }
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

    // Bug: 681739e — admission is closed while a self-merge restart is pending.
    // Park the request now rather than chaining an execution that the imminent
    // process.exit would kill mid-merge.
    if (this._rebuilding) {
      this.parkExecutionForRestart(request);
      return;
    }

    // Issue ded17e6 — chain onto this request's canonical repo identity so only
    // same-repo merges serialize; distinct repos proceed concurrently.
    const chainKey = this.chainKeyForRequest(request);
    const prior = this.executionChains.get(chainKey) ?? Promise.resolve();
    const runPromise = prior
      .catch(() => undefined)
      .then(async () => {
        let executionResult: AuthExecutionResult | null = null;
        try {
          // Bug: 681739e — a self-merge restart may have been scheduled after
          // this execution was chained but before it reached the head of the
          // queue. Re-check admission here so it parks instead of starting.
          if (this._rebuilding) {
            this.parkExecutionForRestart(request);
            return;
          }
          await this.prepareAuthExecution(request);
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
          executionResult = result;

          const durableAtomic = extractAtomicMergeState(this.requireRequest(request.id).output);
          if (result.exit_code !== 0 && request.merge_atomic_enabled && durableAtomic.prepared) {
            const inspection = this.inspectStaleMerge(this.requireRequest(request.id));
            if (inspection.outcome === "atomic_applied") {
              try {
                await this.finishRecoveredAtomicMerge(request, inspection.mergeSha);
              } catch (error) {
                const recoveryAt = this.now();
                this.db.prepare("UPDATE auth_requests SET error = ?, updated_at = ? WHERE id = ?")
                  .run(`Atomic merge applied and needs recovery: ${errorMessage(error) ?? String(error)}`, recoveryAt, request.id);
              }
              return;
            }
            if (inspection.outcome === "atomic_needs_recovery") {
              const recoveryAt = this.now();
              this.db.prepare("UPDATE auth_requests SET error = ?, updated_at = ? WHERE id = ?")
                .run(`Atomic merge applied and needs recovery: ${inspection.detail}`, recoveryAt, request.id);
              return;
            }
          }

          // Bug: 4afab83 — run post-auth hooks after successful execution,
          // BEFORE reporting completion. Hook failures don't change the
          // auth result (the merge already succeeded).
          if (result.exit_code === 0) await this.runPostSuccessHooks(request);

          // Store result and broadcast auth:resolved BEFORE scheduling
          // any self-rebuild exit, so the channel server receives the
          // SSE event while the daemon is still alive.
          this.storeExecutionResult(request.id, result, null);

          // Bug: 87dfff0 — after hooks complete (build finished), schedule
          // a graceful exit so launchd respawns with the new code.
          // Bug: 03d6cb0 — delay increased to 2s (from 0.5s) and moved
          // after storeExecutionResult so the auth:resolved SSE broadcast
          // has time to reach the channel server before the daemon exits.
          if (result.exit_code === 0) this.schedulePostSuccessRestart(request);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Execution failed.";
          if (executionResult?.exit_code === 0) {
            authLog("error", "auth_success_finalization_deferred", {
              subsystem: "auth",
              auth_request_id: request.id,
              error: message,
            });
          } else {
            this.storeExecutionResult(request.id, null, message);
          }
        } finally {
          this.inFlight.delete(request.id);
          this.executionEnvs.delete(request.id);
        }
      });

    const tail = runPromise.catch(() => undefined);
    this.executionChains.set(chainKey, tail);
    this.inFlight.set(request.id, runPromise);
    // Bound map growth: drop the chain entry once this settles, but only if no
    // later request has already chained onto it (admission is synchronous, so
    // the stored tail is authoritative at this microtask).
    void tail.finally(() => {
      if (this.executionChains.get(chainKey) === tail) {
        this.executionChains.delete(chainKey);
      }
    });
  }

  /**
   * Issue ded17e6 — canonical execution-chain key for a request. Merge requests
   * carry `target_repo_root` (populated at approval) and `cwd`; both resolve to
   * the realpath'd Git common dir. Anything unresolvable shares the conservative
   * global chain so unknown identities never run concurrently with each other.
   */
  private chainKeyForRequest(request: AuthRequest): string {
    return (
      canonicalRepoKeyForPath(request.target_repo_root ?? request.cwd) ??
      AuthQueue.UNRESOLVED_CHAIN_KEY
    );
  }

  private scheduleAtomicRecovery(request: AuthRequest): void {
    if (this.inFlight.has(request.id)) return;
    const chainKey = this.chainKeyForRequest(request);
    const prior = this.executionChains.get(chainKey) ?? Promise.resolve();
    const promise = prior.catch(() => undefined).then(async () => {
      const refreshed = this.requireRequest(request.id);
      const inspection = this.inspectStaleMerge(refreshed);
      if (inspection.outcome === "atomic_applied") {
        await this.finishRecoveredAtomicMerge(refreshed, inspection.mergeSha);
        return;
      }
      if (inspection.outcome === "requeued") {
        this.dropMergeCandidate(refreshed);
        const now = this.now();
        this.db.prepare(
          `UPDATE auth_requests SET status = 'pending', resolved_at = NULL, approved_at = NULL,
            exit_code = NULL, error = NULL, output = '', expires_at = ?, updated_at = ?,
            approval_source = 'manual', approval_lease_id = NULL,
            approved_by_user_id = NULL, execution_evidence_id = NULL WHERE id = ?`,
        ).run(now + this.ttlMs, now, request.id);
        const requeued = this.requireRequest(request.id);
        this.broadcast({ event: "auth:updated", data: { request: requeued } });
        return;
      }
      const detail = "detail" in inspection ? inspection.detail : inspection.outcome;
      const now = this.now();
      this.db.prepare("UPDATE auth_requests SET error = ?, updated_at = ? WHERE id = ?")
        .run(`Atomic merge applied and needs recovery: ${detail}`, now, request.id);
    }).catch((error) => {
      const now = this.now();
      this.db.prepare("UPDATE auth_requests SET error = ?, updated_at = ? WHERE id = ?")
        .run(`Atomic merge applied and needs recovery: ${errorMessage(error) ?? String(error)}`, now, request.id);
    })
      .finally(() => {
        this.inFlight.delete(request.id);
        if (this.executionChains.get(chainKey) === tail) this.executionChains.delete(chainKey);
      });
    const tail = promise.then(() => undefined);
    this.executionChains.set(chainKey, tail);
    this.inFlight.set(request.id, promise);
  }

  private async finishRecoveredAtomicMerge(request: AuthRequest, mergeSha: string): Promise<void> {
    const refreshed = this.requireRequest(request.id);
    const inspection = this.inspectStaleMerge(refreshed);
    if (inspection.outcome !== "atomic_applied" || inspection.mergeSha !== mergeSha) {
      const detail = "detail" in inspection ? inspection.detail : inspection.outcome;
      throw new Error(`atomic recovery proof failed: ${detail}`);
    }
    const marker = await this.runRecoveredAtomicCleanup(refreshed, mergeSha);
    this.handleOutput({
      request_id: refreshed.id,
      stream: "stderr",
      text: `${marker}\n`,
      timestamp: Date.now(),
    });
    await this.runPostSuccessHooks(refreshed);
    const at = this.now();
    this.storeExecutionResult(refreshed.id, {
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: `${marker}\n`,
      output: `${marker}\n`,
      started_at: at,
      finished_at: at,
    }, null);
    this.schedulePostSuccessRestart(refreshed);
  }

  private async runRecoveredAtomicCleanup(request: AuthRequest, mergeSha: string): Promise<string> {
    if (!request.head_branch || !request.base_branch) return atomicMergeResultLine(request, mergeSha);
    const script = join(process.env.MANDIBLE_CLI_DIR ?? join(process.cwd(), "cli"), "auth-merge.sh");
    if (!existsSync(script)) {
      throw new Error(`auth merge cleanup helper is unavailable at ${script}`);
    }
    const preserve = /(^|\s)--preserve-head-branch(?:\s|$)/.test(request.command) ? "1" : "0";
    const issueIds = [...new Set([
      ...(request.issue_closures ?? []),
      ...(request.issue_ids ?? []),
    ])].join("\n");
    const result = await execFileAsync(
      "bash",
      [
        "-c",
        'source "$1"; cleanup_merged_worktrees "$2" "$3" "$4" "$5"; record_auth_merge_result "$6"',
        "mandible-atomic-recovery",
        script,
        request.head_branch,
        preserve,
        request.base_branch,
        issueIds,
        request.merge_preflight_base_sha ?? "",
      ],
      {
        cwd: request.cwd ?? request.target_repo_root ?? undefined,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          MANDIBLE_AUTH_MERGE_SOURCE_ONLY: "1",
          MANDIBLE_AUTH_REQUEST_ID: request.id,
        },
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const markerLine = output.split(/\r?\n/).find((line) => line.includes("MANDIBLE_MERGE_RESULT "));
    return markerLine
      ? markerLine.slice(markerLine.indexOf("MANDIBLE_MERGE_RESULT "))
      : atomicMergeResultLine(request, mergeSha);
  }

  private async runPostSuccessHooks(request: AuthRequest): Promise<void> {
    const mergedRequest = { ...request, ...this.getRequest(request.id) } as AuthRequest;
    if (mergedRequest.repo === "mandible") {
      this._rebuilding = true;
      this.broadcast({ event: "mandible:rebuilding", data: {} });
    }
    try {
      const hookResults = await this.hookManager.executeHooks(mergedRequest, (hookLabel, text) => {
        this.handleOutput({ request_id: request.id, stream: "stderr", text: `[hook: ${hookLabel}] ${text}`, timestamp: Date.now() });
      });
      for (const result of hookResults) {
        const status = result.exit_code === 0 ? "ok" : `failed (exit ${result.exit_code})`;
        this.handleOutput({ request_id: request.id, stream: "stderr", text: `[hook: ${result.label}] ${status} (${result.duration_ms}ms)\n`, timestamp: Date.now() });
      }
    } catch (error) {
      authLog("warn", "auth_hook_execution_failed", { subsystem: "auth", auth_request_id: request.id, error: errorMessage(error) ?? String(error) });
    }
  }

  private schedulePostSuccessRestart(request: AuthRequest): void {
    const merged = { ...request, ...this.getRequest(request.id) } as AuthRequest;
    if (merged.repo !== "mandible") return;
    this._rebuilding = true;
    this.recordSelfMergeShutdown(this.now());
    authLog("info", "auth_self_merge_restart_scheduled", {
      subsystem: "auth", auth_request_id: request.id, delay_ms: 2000,
      drain_cap_ms: AuthQueue.SELF_MERGE_DRAIN_CAP_MS,
    });
    void this.drainAndRestart(request.id);
  }

  /**
   * Issue ded17e6 — after a successful self-merge, drain any foreign-repo
   * executions still in flight (up to the drain cap) before restarting so a
   * concurrent unrelated merge is not killed mid-flight, then restart. The
   * durable shutdown marker plus startup recovery remains the backstop when the
   * drain times out.
   */
  private async drainAndRestart(selfRequestId: string): Promise<void> {
    const foreign = [...this.inFlight.entries()]
      .filter(([id]) => id !== selfRequestId)
      .map(([, promise]) => promise);
    // Issue 75f52ac — also let the background finalizer queue drain within the
    // same drain cap so in-flight Stage 3 work is not killed by the exit. The
    // durable merge_finalized_at IS NULL marker plus the startup sweep is the
    // backstop for anything still running when the cap is hit.
    const drainTargets: Array<Promise<unknown>> = [...foreign, this.finalizerQueue.drain()];
    if (drainTargets.length > 0) {
      await Promise.race([
        Promise.allSettled(drainTargets),
        new Promise<void>((resolve) =>
          setTimeout(resolve, AuthQueue.SELF_MERGE_DRAIN_CAP_MS)
        ),
      ]);
    }
    // Bug: 03d6cb0 — preserve the SSE-flush delay before exit so auth:resolved
    // reaches the channel server before the daemon goes down.
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    this.restartFn();
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

    // Record the completion atomically with execution-signature evidence
    // (main: evidence must be durable with the completed row, before any
    // broadcast). The staged lifecycle then owns merged → resolved → finalized;
    // duplicate auto-dismiss (0c44fec) now runs in Stage 3 (autoDismissDuplicates).
    const completed = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = ?, error = ? WHERE id = ?"
        )
        .run(now, now, exitCode, errorText, id);
      const stored = this.requireRequest(id);
      return exitCode === 0 ? this.ensureSuccessfulExecutionEvidence(stored) : stored;
    })();
    if (exitCode === 0) {
      // Issue 75f52ac — staged lifecycle: merged → Stage 2 → resolved → Stage 3.
      this.finalizeSuccessfulMerge(completed);
    } else {
      this.broadcast({
        event: "auth:resolved",
        data: this.buildResolvedPayload(completed)
      });
    }
    this.dropMergeCandidate(completed);
  }

  /**
   * Issue 75f52ac — the single post-merge entry point. Splits the old
   * afterSuccessfulMerge into three stages by cost:
   *
   *   Stage 1 (auth:merged): broadcast immediately (merge type only) — the
   *     perceived-latency fix. The UI flips the row here, before any finalizer.
   *   Stage 2 (sync, then auth:resolved): pure-SQLite finalizers whose completed
   *     state consumers rely on at auth:resolved — persist merge_head_sha,
   *     deferred ledger completion (incl. issue closes), and direct work-unit
   *     resolution. auth:resolved keeps its exact prior shape/semantics.
   *   Stage 3 (async queue, then auth:finalized): the heavy git/codex spawns —
   *     pending-request revalidation, duplicate auto-dismiss, ancestry work-unit
   *     resolution + retention sweep, and worker-thread archiving.
   *
   * Failures (exit_code != 0), rejections, and expiries never reach here; they
   * emit auth:resolved only, unchanged.
   */
  private finalizeSuccessfulMerge(completed: AuthRequest): void {
    // Idempotent: an already-finalized merge needs no re-processing.
    if (completed.type === "merge" && completed.merge_finalized_at != null) {
      return;
    }

    // Stage 1 — broadcast auth:merged immediately (merge type only).
    if (completed.type === "merge") {
      this.broadcast({ event: "auth:merged", data: this.buildMergedPayload(completed) });
    }

    // Signature and execution evidence stay on the critical path, before
    // auth:resolved: main verifies the merge signature against registered
    // credentials and finalizes signature evidence here rather than deferring it
    // to the background finalizer queue. Both helpers are idempotent, so
    // re-running them after the atomic execution-evidence write in
    // setResult/storeExecutionResult (and on the recovery paths that call in
    // directly) is safe.
    const attributed = this.ensureSuccessfulExecutionEvidence(completed);
    const evidenced = this.attachSuccessfulSignatureEvidence(attributed);

    // Stage 2 — critical, pure-SQLite finalizers.
    const mergeHeadSha = evidenced.merge_head_sha ?? this.resolveMergeHeadShaForRequest(evidenced);
    if (evidenced.type === "merge" && mergeHeadSha && evidenced.merge_head_sha == null) {
      // Persist merge_head_sha now: the head branch may be deleted before Stage 3
      // runs, and later steps depend on it for ancestry evidence.
      this.db
        .prepare(
          "UPDATE auth_requests SET merge_head_sha = COALESCE(merge_head_sha, ?), updated_at = ? WHERE id = ?"
        )
        .run(mergeHeadSha, this.now(), evidenced.id);
    }
    const finalized: AuthRequest = { ...evidenced, merge_head_sha: mergeHeadSha };
    this.applyLedgerCompletionForRequest(finalized);
    // Bug: 8a281b3 — resolve work units on successful auth merge (best-effort;
    // work_units table may not exist in test DBs or fresh installs mid-migration).
    // Only the DB-only direct matches run here; ancestry scans are Stage 3.
    if (this.tableExists("work_units")) {
      try {
        this.resolveDirectWorkUnitsOnMerge(finalized);
      } catch (err) {
        authLog("warn", "auth_work_units_resolve_failed", {
          subsystem: "auth",
          auth_request_id: finalized.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stage 2 complete — consumers (channel server, UI) observe resolved
    // ledger/work-unit state here. Shape/semantics unchanged from before.
    this.broadcast({ event: "auth:resolved", data: this.buildResolvedPayload(finalized) });

    // Stage 3 — enqueue the heavy finalizers. Overflow is a backstop, not an
    // error: the row stays merge_finalized_at IS NULL and the periodic sweep
    // re-enqueues it.
    if (!this.finalizerQueue.enqueue(completed.id)) {
      authLog("info", "auth_finalizer_enqueue_overflow", {
        subsystem: "auth",
        auth_request_id: completed.id,
      });
    }
  }

  /**
   * Issue 75f52ac — Stage 3 processor run by the FinalizerQueue. Per-step durable
   * state in merge_finalizer_state makes it crash-safe: a daemon restart mid-way
   * resumes the remaining steps. Each step is idempotent, so a crash between the
   * JSON update and the step effect re-runs the step without double-applying.
   * A step that throws is retried up to FINALIZER_MAX_ATTEMPTS across sweeps;
   * after that it is marked failed (surfaced in auth:finalized) so the request
   * still finalizes. Never throws.
   */
  private async runBackgroundFinalizers(requestId: string): Promise<void> {
    // Issue 75f52ac — bail cleanly if the queue was disposed or its DB closed
    // between enqueue and processing (common in tests that dispose right after a
    // successful setResult). Anything left unfinalized is picked up by the
    // startup sweep on the next daemon boot.
    if (this.disposed || !this.isDbOpen()) {
      return;
    }
    // Exact-id lookup (not getRequest): the queue holds the precise id, so we
    // must not prefix-resolve it, and this avoids getRequest's expireStale side
    // effect on the background path.
    const row = this.db
      .prepare("SELECT * FROM auth_requests WHERE id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) {
      return;
    }
    const request = mapRow(row);
    if (request.status !== "completed" || request.exit_code !== 0) {
      return;
    }
    if (request.merge_finalized_at != null) {
      return;
    }

    const mergeHeadSha = request.merge_head_sha ?? this.resolveMergeHeadShaForRequest(request);
    const finalized: AuthRequest = { ...request, merge_head_sha: mergeHeadSha };
    const state = this.readFinalizerState(requestId);

    const steps: Array<{ name: FinalizerStepName; run: () => Promise<FinalizerStepOutput | void> }> = [
      {
        name: "revalidate_pending",
        run: async () => {
          await this.revalidatePendingMergeRequests(finalized);
        },
      },
      {
        name: "auto_dismiss_duplicates",
        run: async () => {
          await this.autoDismissDuplicates(finalized);
        },
      },
      {
        name: "resolve_ancestry_work_units",
        run: async () => {
          if (this.tableExists("work_units")) {
            const resolved = await this.resolveAncestryWorkUnitsOnMerge(finalized);
            return { resolved_work_unit_ids: resolved };
          }
          return { resolved_work_unit_ids: [] };
        },
      },
      {
        name: "archive_worker_threads",
        run: async () => {
          const archiveResult = await this.archiveCompletedWorkerThreads(finalized);
          // Issue 75f52ac — a candidate with a provider handle whose codex
          // archive CLI attempt failed (error/timeout) must not silently resolve
          // this step: propagate it as a step failure so the FinalizerQueue's
          // bounded retry (FINALIZER_MAX_ATTEMPTS, then failed-and-surfaced) owns
          // it. Handle-less "definitively not archivable" candidates are already
          // excluded from the list, so any attempt failure here is retryable.
          if (archiveResult.attempt_failures > 0) {
            throw new Error(
              `codex thread archive failed for ${archiveResult.attempt_failures} candidate(s)`,
            );
          }
          return { archived_thread_count: archiveResult.archived };
        },
      },
    ];

    for (const step of steps) {
      // A concurrent dispose/close aborts the pass; the sweep resumes it later.
      if (this.disposed || !this.isDbOpen()) {
        return;
      }
      const entry = state[step.name];
      if (entry?.state === "done" || entry?.state === "failed") {
        continue;
      }
      try {
        const output = await step.run();
        // Persist the step's output into its durable state entry so the terminal
        // payload survives later passes that skip this (now done) step and
        // survives a crash/replay of the row.
        state[step.name] = {
          state: "done",
          attempts: (entry?.attempts ?? 0) + 1,
          at: this.now(),
          ...(output && Object.keys(output).length > 0 ? { output } : {}),
        };
      } catch (err) {
        const attempts = (entry?.attempts ?? 0) + 1;
        const message = err instanceof Error ? err.message : String(err);
        state[step.name] = {
          state: attempts >= FINALIZER_MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          error: message,
          at: this.now(),
        };
        authLog("warn", "auth_finalizer_step_failed", {
          subsystem: "auth",
          auth_request_id: requestId,
          step: step.name,
          attempts,
          error: message,
        });
      }
      this.writeFinalizerState(requestId, state);
    }

    // Finalize only once every step is terminal (done or failed@max). A step
    // still eligible for retry leaves the row unfinalized for the periodic sweep.
    const allTerminal = FINALIZER_STEP_NAMES.every((name) => {
      const entry = state[name];
      return entry?.state === "done" || entry?.state === "failed";
    });
    if (!allTerminal) {
      return;
    }

    // At-least-once delivery contract (integration reconciliation, issue 75f52ac):
    // broadcast auth:finalized BEFORE writing the durable merge_finalized_at
    // marker. The periodic/startup sweep excludes marker-set rows, so a marker
    // written before the broadcast would permanently drop the event if the daemon
    // died in between. Broadcasting first means a crash after the broadcast but
    // before the marker write causes the next sweep to re-finalize and emit a
    // DUPLICATE auth:finalized — consumers tolerate this because finalization
    // handling (cache/graph invalidation, work-unit reconciliation) is idempotent.
    const finalizedAt = this.now();
    const finalizedRowData = this.db
      .prepare("SELECT * FROM auth_requests WHERE id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    const finalizedRow = finalizedRowData ? mapRow(finalizedRowData) : finalized;
    // The durable marker has not been written yet; surface the timestamp we are
    // about to persist in the payload so it matches the durable row.
    finalizedRow.merge_finalized_at = finalizedRow.merge_finalized_at ?? finalizedAt;
    const failedSteps = FINALIZER_STEP_NAMES.filter((name) => state[name]?.state === "failed");
    if (failedSteps.length > 0) {
      authLog("warn", "auth_finalizer_completed_with_failures", {
        subsystem: "auth",
        auth_request_id: requestId,
        failed_steps: failedSteps,
      });
    }
    this.broadcast({
      event: "auth:finalized",
      data: this.buildFinalizedPayload(finalizedRow, state),
    });
    this.markSuccessfulMergeFinalized(finalized, mergeHeadSha, finalizedAt);
  }

  /** Test / self-merge restart hook — resolve once all enqueued finalizers settle. */
  async drainFinalizers(): Promise<void> {
    await this.finalizerQueue.drain();
  }

  private readFinalizerState(id: string): FinalizerState {
    let raw: string | null | undefined;
    try {
      const row = this.db
        .prepare("SELECT merge_finalizer_state FROM auth_requests WHERE id = ?")
        .get(id) as { merge_finalizer_state?: string | null } | undefined;
      raw = row?.merge_finalizer_state;
    } catch {
      return {};
    }
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as FinalizerState) : {};
    } catch {
      return {};
    }
  }

  private writeFinalizerState(id: string, state: FinalizerState): void {
    if (this.disposed || !this.isDbOpen()) {
      return;
    }
    try {
      this.db
        .prepare("UPDATE auth_requests SET merge_finalizer_state = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(state), this.now(), id);
    } catch (error) {
      authLog("warn", "auth_finalizer_state_write_failed", {
        subsystem: "auth",
        auth_request_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private attachSuccessfulSignatureEvidence(request: AuthRequest): AuthRequest {
    if (!isAuthMergeCommand(request) || !request.requested_by_user_id) return request;

    const authorizationEvidence = request.execution_evidence_id
      ? getAttributionEvidence(this.db, request.execution_evidence_id)
      : null;
    if (authorizationEvidence?.evidence_method === "credential_signature") return request;

    const commitSha = extractSuccessfulMergeCommitSha(request.output);
    const cwd = request.target_repo_root ?? request.cwd;
    let targetHeadSha: string | null = null;
    if (cwd && request.base_branch) {
      try {
        targetHeadSha = resolveBranchHeadSha(cwd, request.base_branch);
      } catch {
        targetHeadSha = null;
      }
    }
    let verification: MergeSignatureVerification;
    try {
      verification = verifySuccessfulMergeCommitSignature(
        this.db,
        cwd,
        commitSha,
        targetHeadSha,
      );
    } catch {
      verification = {
        verified: false,
        commit_sha: commitSha,
        fingerprint: null,
        credential_id: null,
        user_id: null,
        reason: "verification_error",
      };
    }
    const verifiedAt = request.resolved_at ?? this.now();
    return this.db.transaction(() => {
      const current = this.readRequestByExactId(request.id);
      if (!current) throw new Error(`Auth request '${request.id}' disappeared during finalization.`);
      if (current.execution_evidence_id !== (authorizationEvidence?.id ?? null)) {
        const existing = current.execution_evidence_id
          ? getAttributionEvidence(this.db, current.execution_evidence_id)
          : null;
        if (existing?.evidence_method === "credential_signature") return current;
        throw new Error("Auth execution evidence changed during signature finalization.");
      }

      const evidence = addAttributionEvidence(this.db, {
        evidence_method: "credential_signature",
        credential_id: verification.credential_id,
        details: {
          auth_request_id: request.id,
          authorizer_user_id: request.approved_by_user_id,
          executor_user_id: systemAction().user_id,
          approval_source: request.approval_source,
          verified: verification.verified,
          commit_sha: verification.commit_sha,
          target_head_sha: targetHeadSha,
          fingerprint: verification.fingerprint,
          signer_user_id: verification.user_id,
          reason: verification.reason,
          authorization_evidence_id: authorizationEvidence?.id ?? null,
          authorization_evidence_method: authorizationEvidence?.evidence_method ?? null,
        },
      }, verifiedAt);
      const update = this.db.prepare(
        "UPDATE auth_requests SET execution_evidence_id = ?, updated_at = ? WHERE id = ? AND execution_evidence_id IS ?",
      ).run(evidence.id, verifiedAt, request.id, authorizationEvidence?.id ?? null);
      if (update.changes !== 1) {
        throw new Error("Auth signature evidence pointer update was not applied.");
      }
      const finalized = this.readRequestByExactId(request.id);
      if (!finalized) throw new Error(`Auth request '${request.id}' disappeared during finalization.`);
      return finalized;
    })();
  }

  private sweepSuccessfulMergeFinalizers(): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM auth_requests WHERE type = 'merge' AND status = 'completed' AND exit_code = 0 AND merge_finalized_at IS NULL"
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      // Issue fbf2a58 round 2 — dispatch through finalizeReconciledMerge (not
      // finalizeSuccessfulMerge directly) so evidence-only partially-terminalized
      // rows are handled by the convergence dispatcher: a normal completed merge
      // routes straight to full finalization exactly as before, but a merge that
      // landed out-of-band without approval attribution is re-checked and only
      // converges to full finalization (merge_finalized_at set) once attribution
      // appears, instead of being permanently excluded from the sweep.
      this.finalizeReconciledMerge(mapRow(row));
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
    const mapped = rows.map((row) => mapRow(row));
    // Issue ded17e6 — repo filtering moved out of SQL so it can be canonical.
    // A null repo means "no repo constraint" (unchanged), otherwise keep only
    // rows whose repo denotes the same physical repo (path/symlink/string alias
    // aware, with exact-string fallback).
    if (!repo) {
      return mapped;
    }
    const repoKeys = canonicalRepoKeysForRef(this.db, repo);
    return mapped.filter((request) => this.repoRefsMatch(repo, repoKeys, request.repo ?? null));
  }

  private mergeQueueFingerprint(requests: AuthRequest[]): string {
    const payload = requests.map((request) => ({
      id: request.id,
      status: request.status,
      head_branch: request.head_branch ?? null,
      merge_head_sha: request.merge_head_sha ?? null,
      skipped_at: request.skipped_at ?? null,
      created_at: request.created_at,
    }));
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private resolveBranchHeadForCheck(cwd: string, branch: string): string | null {
    try {
      return resolveBranchHeadSha(cwd, branch);
    } catch {
      return null;
    }
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
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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

  private checkMergeWorktreeReady(cwd: string): { status: "clean" } | { status: "error"; message: string } {
    try {
      const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
        cwd,
        encoding: "utf8",
      }).trim();
      if (gitDir && existsSync(join(gitDir, "MERGE_HEAD"))) {
        return {
          status: "error",
          message: "merge already in progress; resume or abort it before running merge preflight"
        };
      }

      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }).replace(/\r?\n$/, "");
      if (!status.trim()) {
        return { status: "clean" };
      }
      const files = status
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 20)
        .map((line) => line.length > 3 ? line.slice(3) : line.trim());
      return {
        status: "error",
        message: `tracked worktree changes are present: ${files.join(", ")}`
      };
    } catch (error) {
      return {
        status: "error",
        message: errorMessage(error) || "could not inspect worktree status"
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

  // Issue 75f52ac — Stage 3 finalizer step. checkMergeIndependence stays
  // synchronous (it is shared with the submit-time preflight), but the loop
  // yields to the event loop between pending requests so a long revalidation
  // pass does not monopolise the daemon after auth:resolved.
  private async revalidatePendingMergeRequests(completed: AuthRequest): Promise<void> {
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
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      this.executeDeferredLedgerActions(request);
      applyAuthRequestLedgerCompletion(this.db, {
        auth_request_id: request.id,
        repo_ref: request.repo ?? request.cwd ?? request.target_repo_root ?? null,
        issue_references: request.issue_references ?? null,
        // Legacy close columns are synthesized into transient issue_close
        // actions above so there remains one close-on-merge execution path.
        issue_closures: null,
        issue_ids: request.issue_ids ?? null,
        issues: null,
        commit_message: request.commit_message,
        merge_output: request.output,
        approval_source: request.approval_source,
        approval_lease_id: request.approval_lease_id,
        approved_by_user_id: request.approved_by_user_id,
        execution_evidence_id: request.execution_evidence_id,
      });
    } catch (error) {
      authLog("warn", "auth_ledger_completion_failed", {
        subsystem: "auth",
        auth_request_id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private executeDeferredLedgerActions(request: AuthRequest): void {
    const persistedActions = this.tableExists("auth_request_actions")
      ? listAuthRequestActions(this.db, request.id)
      : [];
    const hasPersistedActions = persistedActions.length > 0;
    const actions = hasPersistedActions ? persistedActions : this.legacyIssueCloseActions(request);
    for (const action of actions) {
      if (action.state === "vetoed") {
        this.removeActionResolveLink(request, action);
        continue;
      }
      if (action.state !== "staged") {
        continue;
      }
      try {
        const outcome = this.applyDeferredLedgerAction(request, action);
        if (!action.id.startsWith("legacy:")) {
          this.recordActionOutcome(action.id, outcome.state, outcome.detail, outcome.appliedAt);
        }
      } catch (error) {
        if (!action.id.startsWith("legacy:")) {
          this.recordActionOutcome(
            action.id,
            "failed",
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
        authLog("warn", "auth_deferred_action_failed", {
          subsystem: "auth",
          auth_request_id: request.id,
          action_id: action.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private applyDeferredLedgerAction(
    request: AuthRequest,
    action: AuthRequestAction,
  ): { state: "applied" | "skipped_stale"; detail: string | null; appliedAt: number | null } {
    const repoRef = request.repo ?? request.cwd ?? request.target_repo_root ?? null;
    const resolved = resolveOperationalIssueRef(this.db, action.target_issue_ref, repoRef);
    if (!resolved.ok) {
      throw new Error(`target issue ${action.target_issue_ref} could not be resolved: ${resolved.error}`);
    }
    const store = new LedgerStore(this.db);
    const issueId = resolved.issue_id;
    const now = this.now();
    const currentDigest = getLedgerIssueHead(this.db, issueId).digest;
    const digestMoved = Boolean(action.target_digest && action.target_digest !== currentDigest);
    if (action.kind === "issue_close" && digestMoved && action.payload.on_stale === "skip") {
      this.removeActionResolveLink(request, action, issueId);
      return {
        state: "skipped_stale",
        detail: `Skipped because target digest moved from ${action.target_digest} to ${currentDigest}`,
        appliedAt: null,
      };
    }

    const detail = digestMoved
      ? `Applied after target digest moved from ${action.target_digest} to ${currentDigest}`
      : null;
    // The legacy actor tuple ('agent' + session id + display) is FROZEN — it is
    // hashed into stable event ids, so it stays byte-identical to base behavior
    // (umbrella 8e2e8b2 / issue 92813cc). The real principal is recorded in the
    // parallel user-attribution columns: auth-queue ledger writes are applied by
    // the daemon on merge, so they attribute to the system user. The
    // approving human is carried as the authorizer in the attached evidence.
    const actor = {
      actor_type: "agent" as const,
      actor_id: request.session_id ?? request.target_session_id ?? null,
      author_display: "Mandible auth action",
      attribution: this.finalizationAttribution(request),
    };
    switch (action.kind) {
      case "comment_add":
        if (!this.tableRowExists("ledger_comments", this.actionEntityId("comment", action.id))) {
          store.addComment(issueId, {
            id: this.actionEntityId("comment", action.id),
            body: stringPayload(action.payload, "body"),
            source: "auth_queue",
            created_at: now,
            ...actor,
          });
        }
        break;
      case "issue_close":
        if (typeof action.payload.reason_comment === "string" && action.payload.reason_comment.trim()) {
          const commentId = this.actionEntityId("comment", action.id);
          if (!this.tableRowExists("ledger_comments", commentId)) {
            store.addComment(issueId, {
              id: commentId,
              body: action.payload.reason_comment,
              source: "auth_queue",
              created_at: now,
              ...actor,
            });
          }
        }
        applyAuthRequestLedgerCompletion(this.db, {
          auth_request_id: request.id,
          repo_ref: repoRef,
          issue_closures: [action.target_issue_ref],
          merge_output: request.output,
          approval_source: request.approval_source,
          approval_lease_id: request.approval_lease_id,
          approved_by_user_id: request.approved_by_user_id,
          execution_evidence_id: request.execution_evidence_id,
        });
        break;
      case "worker_status_set": {
        const value = stringPayload(action.payload, "value");
        if (!VALID_WORKER_STATUSES.includes(value)) {
          throw new Error(`invalid worker status: ${value}`);
        }
        store.setWorkerStatus(issueId, value as LedgerWorkerStatus, actor, "auth_queue");
        break;
      }
      case "label_add":
        store.setLabel(issueId, stringPayload(action.payload, "label"), true, "auth_queue", actor);
        break;
      case "label_rm":
        store.setLabel(issueId, stringPayload(action.payload, "label"), false, "auth_queue", actor);
        break;
      case "checkpoint_add": {
        const checkpointId = this.actionEntityId("chk", action.id);
        if (!this.tableRowExists("ledger_issue_checkpoints", checkpointId)) {
          store.addIssueCheckpoint(issueId, {
            id: checkpointId,
            kind: stringPayload(action.payload, "kind"),
            payload: action.payload.payload ?? null,
            source: "auth_queue",
            created_at: now,
            ...actor,
          });
        }
        break;
      }
      case "link_add": {
        const linkType = typeof action.payload.type === "string" ? action.payload.type : "references";
        if (!VALID_RELATIONSHIP_TYPES.includes(linkType)) {
          throw new Error(`invalid relationship type: ${linkType}`);
        }
        const target = resolveOperationalIssueRef(this.db, stringPayload(action.payload, "target"), repoRef);
        if (!target.ok) {
          throw new Error(`link target ${action.payload.target} could not be resolved: ${target.error}`);
        }
        store.linkRelationshipEdges({
          source_entity: { entity_type: "issue", entity_id: issueId },
          target_entities: [{ entity_type: "issue", entity_id: target.issue_id }],
          link_type: linkType as LedgerRelationshipType,
          note: typeof action.payload.note === "string" ? action.payload.note : null,
          action_id: action.id,
          source: "auth_queue",
          actor,
          created_at: now,
        });
        break;
      }
    }
    return { state: "applied", detail, appliedAt: now };
  }

  private legacyIssueCloseActions(request: AuthRequest): AuthRequestAction[] {
    const refs = request.issue_closures ?? request.issues ?? [];
    return refs.map((ref, index) => ({
      id: `legacy:${request.id}:${index + 1}:${ref}`,
      auth_request_id: request.id,
      ordinal: index + 1,
      kind: "issue_close",
      target_issue_ref: ref,
      payload: {},
      state: "staged",
      target_digest: null,
      staged_at: request.created_at,
      updated_at: request.updated_at,
      applied_at: null,
      outcome_detail: null,
    }));
  }

  private recordActionOutcome(
    actionId: string,
    state: "applied" | "failed" | "skipped_stale",
    detail: string | null,
    appliedAt: number | null,
  ): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE auth_request_actions
       SET state = ?, applied_at = ?, updated_at = ?, outcome_detail = ?
       WHERE id = ? AND state = 'staged'`,
    ).run(state, appliedAt, now, detail, actionId);
  }

  private removeActionResolveLink(request: AuthRequest, action: AuthRequestAction, issueId?: string): void {
    if (!this.tableExists("ledger_auth_issue_links")) return;
    let resolvedIssueId = issueId;
    if (!resolvedIssueId) {
      const resolved = resolveOperationalIssueRef(
        this.db,
        action.target_issue_ref,
        request.repo ?? request.cwd ?? request.target_repo_root ?? null,
      );
      if (!resolved.ok) return;
      resolvedIssueId = resolved.issue_id;
    }
    this.db.prepare(
      `DELETE FROM ledger_auth_issue_links
       WHERE auth_request_id = ? AND issue_id = ? AND link_type = 'resolves'
         AND metadata_json LIKE '%auth_request_actions%'`,
    ).run(request.id, resolvedIssueId);
  }

  private actionEntityId(prefix: string, actionId: string): string {
    return `${prefix}_${actionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }

  private tableRowExists(table: string, id: string): boolean {
    if (!this.tableExists(table)) return false;
    const row = this.db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).get(id);
    return Boolean(row);
  }

  private actionOutcomeSummary(requestId: string): Array<Record<string, unknown>> {
    if (!this.tableExists("auth_request_actions")) return [];
    return listAuthRequestActions(this.db, requestId).map((action) => ({
      id: action.id,
      ordinal: action.ordinal,
      kind: action.kind,
      target_issue_ref: action.target_issue_ref,
      state: action.state,
      applied_at: action.applied_at,
      outcome_detail: action.outcome_detail,
    }));
  }

  // Issue 75f52ac — Stage 3 finalizer step; isMergedIntoBase now spawns git via
  // async execFile, so this and shouldAutoDismissDuplicate are async.
  private async autoDismissDuplicates(completed: AuthRequest): Promise<void> {
    if (!completed.base_branch || !completed.head_branch) {
      return;
    }

    const now = this.now();
    // Find sibling requests targeting the same branch merge that are still
    // actionable (pending, expired, or failed-completed). Approved requests are
    // excluded — they may already be executing and need separate handling.
    const args: unknown[] = [
      completed.id,
      completed.base_branch,
      completed.head_branch,
    ];
    // Issue ded17e6 — repo filtering moved out of SQL so sibling matching is
    // canonical (path/symlink/string alias aware). A null completed.repo keeps
    // the original "match only null-repo siblings" behavior via the string
    // fallback in repoRefsMatch.
    const where =
      "id != ? AND base_branch = ? AND head_branch = ? " +
      "AND (status IN ('pending', 'expired') " +
      "OR (status = 'completed' AND exit_code IS NOT NULL AND exit_code != 0))";

    const completedRepo = completed.repo ?? null;
    const completedKeys = canonicalRepoKeysForRef(this.db, completedRepo);
    const siblings = (this.db
      .prepare(
        `SELECT * FROM auth_requests WHERE ${where}`
      )
      .all(...args) as Record<string, unknown>[])
      .filter((row) => this.repoRefsMatch(completedRepo, completedKeys, (row.repo as string | null) ?? null));

    if (siblings.length === 0) {
      return;
    }

    const dismissStmt = this.db.prepare(
      "UPDATE auth_requests SET status = 'dismissed', resolved_at = ?, updated_at = ?, " +
        "error = ? WHERE id = ?"
    );
    const reason = `Auto-dismissed: ${completed.head_branch} → ${completed.base_branch} was successfully merged by request ${completed.id.slice(0, 8)}`;

    for (const row of siblings) {
      const sibling = mapRow(row);
      if (!(await this.shouldAutoDismissDuplicate(completed, sibling))) {
        continue;
      }
      dismissStmt.run(now, now, reason, sibling.id);
      const dismissed = this.getRequest(sibling.id);
      if (dismissed) {
        this.broadcast({
          event: "auth:resolved",
          data: this.buildResolvedPayload(dismissed)
        });
        authLog("info", "auth_duplicate_auto_dismissed", {
          subsystem: "auth",
          auth_request_id: row.id,
          completed_request_id: completed.id,
          head_branch: completed.head_branch,
        });
      }
    }
  }

  private async shouldAutoDismissDuplicate(completed: AuthRequest, sibling: AuthRequest): Promise<boolean> {
    if (completed.resolved_at != null && sibling.created_at > completed.resolved_at) {
      return false;
    }
    if (completed.merge_head_sha && sibling.merge_head_sha) {
      return completed.merge_head_sha === sibling.merge_head_sha ||
        (await this.isMergedIntoBase(completed, sibling.merge_head_sha));
    }
    if (sibling.merge_head_sha) {
      return this.isMergedIntoBase(completed, sibling.merge_head_sha);
    }
    return completed.resolved_at != null && sibling.created_at <= completed.resolved_at;
  }

  // Issue 75f52ac — async execFile so the Stage 3 auto-dismiss step runs off the
  // event loop.
  private async isMergedIntoBase(completed: AuthRequest, sha: string): Promise<boolean> {
    if (!completed.base_branch) {
      return false;
    }
    const cwd = completed.target_repo_root ?? completed.cwd;
    if (!cwd) {
      return false;
    }
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", sha, `refs/heads/${completed.base_branch}`],
        { cwd, encoding: "utf8", timeout: 5000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  private resolveMergeHeadShaForRequest(request: AuthRequest): string | null {
    if (!request.head_branch) {
      return null;
    }
    const cwd = request.target_repo_root ?? request.cwd;
    if (!cwd) {
      return null;
    }
    try {
      return resolveBranchHeadSha(cwd, request.head_branch);
    } catch {
      return null;
    }
  }

  private markSuccessfulMergeFinalized(
    request: AuthRequest,
    mergeHeadSha: string | null,
    finalizedAt: number = this.now(),
  ): void {
    if (request.type !== "merge") {
      return;
    }
    this.db
      .prepare(
        "UPDATE auth_requests SET merge_head_sha = COALESCE(merge_head_sha, ?), merge_finalized_at = COALESCE(merge_finalized_at, ?), updated_at = ? WHERE id = ?"
      )
      .run(mergeHeadSha, finalizedAt, finalizedAt, request.id);
  }

  /**
   * Issue 75f52ac — Stage 2 (synchronous, DB-only) work-unit resolution.
   * Consumers rely on this completed state at auth:resolved, so it runs before
   * that broadcast. Covers the matches that never spawn git:
   * 1. Work units whose auth_request_id matches the completed request
   * 2. Work units whose branch matches the auth request's head_branch
   * 4. Work units linked to explicit auth closure issue IDs
   * 5. Work units linked by canonical ledger auth-issue links
   * The ancestry scan (original step 3) and retention sweep spawn git and move
   * to Stage 3 (resolveAncestryWorkUnitsOnMerge). Bug: 8a281b3.
   */
  private resolveDirectWorkUnitsOnMerge(completed: AuthRequest): string[] {
    const now = this.now();
    const resolveStmt = this.db.prepare(
      `UPDATE work_units
       SET state = 'resolved', resolved_at = ?, auth_request_id = COALESCE(auth_request_id, ?)
       WHERE id = ? AND state IN ('open', 'committed')`
    );

    const resolvedIds = new Set<string>();
    const explicitClosureIssueRefs = this.explicitClosureIssueRefs(completed);

    // 1. Match by auth_request_id
    const byAuthId = this.db
      .prepare(
        "SELECT id FROM work_units WHERE auth_request_id = ? AND state IN ('open', 'committed')"
      )
      .all(completed.id) as Array<{ id: string }>;

    for (const row of byAuthId) {
      resolveStmt.run(now, completed.id, row.id);
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
          resolveStmt.run(now, completed.id, row.id);
          resolvedIds.add(row.id);
        }
      }
    }

    // 4. Match by explicit close-on-merge issue IDs. Mandible-Issue trailers and
    // issue_references are provenance links, not completion signals.
    const allIssueIds = [...explicitClosureIssueRefs];

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
            resolveStmt.run(now, completed.id, row.id);
            resolvedIds.add(row.id);
          }
        }
      }
    }

    // 5. Match by canonical ledger links, covering auth requests linked by a
    // ledger issue ID rather than by historical compatibility prefixes.
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
          resolveStmt.run(now, completed.id, row.id);
          resolvedIds.add(row.id);
        }
      }
    }

    if (resolvedIds.size > 0) {
      authLog("info", "auth_work_units_resolved", {
        subsystem: "auth",
        auth_request_id: completed.id,
        resolved_count: resolvedIds.size,
        head_branch: completed.head_branch,
      });
    }
    return [...resolvedIds];
  }

  /**
   * Issue 75f52ac — Stage 3 (async) ancestry-based work-unit resolution plus the
   * retention sweep. Matches child feature branches merged through an integration
   * branch (original step 3 of resolveWorkUnitsOnMerge); auth-merge may delete
   * those branches before the scanner runs, so it prefers the scanner's
   * last_commit_hash snapshot. Idempotent: guarded UPDATEs skip already-resolved
   * rows, and the retirement sweep is NULL-guarded. Returns the resolved ids.
   */
  private async resolveAncestryWorkUnitsOnMerge(completed: AuthRequest): Promise<string[]> {
    const now = this.now();
    const recoverMergedStmt = this.db.prepare(
      `UPDATE work_units
       SET state = 'resolved', resolved_at = ?
       WHERE id = ? AND state IN ('open', 'committed', 'abandoned')`
    );
    const recoverClosedMergedStmt = this.db.prepare(
      `UPDATE work_units
       SET state = 'resolved', resolved_at = ?, auth_request_id = COALESCE(auth_request_id, ?)
       WHERE id = ? AND state IN ('open', 'committed', 'abandoned')`
    );

    const resolvedIds = new Set<string>();
    const explicitClosureIssueRefs = this.explicitClosureIssueRefs(completed);

    // Issue 93d978e — one batch per pass; its per-(root,target) git build
    // outcomes gate the retirement sweep below.
    const batch = new AncestryBatch();
    for (const row of await this.workUnitsMergedByRequest(completed, batch)) {
      if (!resolvedIds.has(row.id)) {
        if (this.workUnitMatchesIssueRefs(row, explicitClosureIssueRefs)) {
          recoverClosedMergedStmt.run(now, completed.id, row.id);
        } else {
          recoverMergedStmt.run(now, row.id);
        }
        resolvedIds.add(row.id);
      }
    }

    // Issue 93d978e — retire abandoned rows that have aged past the retention
    // window from future merge-side ancestry scans. Runs AFTER the scan so the
    // current merge still gets its chance at every stale row. This is a
    // reversible tombstone (clearing merge_scan_retired_at re-admits the row),
    // not a deletion — state and provenance are preserved. The NULL guard keeps
    // it idempotent across finalizer re-runs.
    //
    // Integration reconciliation: skip the sweep entirely when the ancestry
    // batch had any git build failure this pass. A failed rev-list/for-each-ref
    // makes every ancestry test read as "not an ancestor", so a genuinely merged
    // deleted-branch snapshot would look unmerged; retiring off those false
    // negatives could tombstone real merges and exclude them from future
    // automatic resolution. A transient git failure must not cost data.
    if (this.workUnitsHaveRetirementColumn()) {
      if (batch.hadFailure()) {
        authLog("warn", "auth_work_units_scan_retirement_skipped", {
          subsystem: "auth",
          auth_request_id: completed.id,
          reason: "ancestry_batch_build_failed",
        });
      } else {
        const retireCutoff = now - this.workUnitAbandonedScanRetentionMs;
        const retired = this.db.prepare(
          `UPDATE work_units SET merge_scan_retired_at = ?
           WHERE state = 'abandoned' AND merge_scan_retired_at IS NULL
             AND COALESCE(last_commit_at, continuation_at, activated_at, created_at) < ?`
        ).run(now, retireCutoff);
        if (retired.changes > 0) {
          authLog("info", "auth_work_units_scan_retired", {
            subsystem: "auth",
            auth_request_id: completed.id,
            retired_count: retired.changes,
          });
        }
      }
    }

    if (resolvedIds.size > 0) {
      authLog("info", "auth_work_units_resolved", {
        subsystem: "auth",
        auth_request_id: completed.id,
        resolved_count: resolvedIds.size,
        head_branch: completed.head_branch,
        scope: "ancestry",
      });
    }
    return [...resolvedIds];
  }

  // Issue 93d978e — memoized presence of the merge_scan_retired_at column.
  // Lightweight test DBs that create work_units ad hoc lack it; when false,
  // the retirement filter and sweep are skipped so behavior matches pre-107.
  private workUnitsHaveRetirementColumn(): boolean {
    if (this.workUnitRetirementColumn === undefined) {
      try {
        const cols = this.db
          .prepare("PRAGMA table_info(work_units)")
          .all() as Array<{ name: string }>;
        this.workUnitRetirementColumn = cols.some(
          (col) => col.name === "merge_scan_retired_at",
        );
      } catch {
        this.workUnitRetirementColumn = false;
      }
    }
    return this.workUnitRetirementColumn;
  }

  // Issue 75f52ac — async so the batched ancestry git spawns run off the event
  // loop inside the Stage 3 finalizer queue.
  private async workUnitsMergedByRequest(completed: AuthRequest, batch: AncestryBatch): Promise<Array<{
    id: string;
    issue_id: string;
    ledger_issue_id: string | null;
  }>> {
    if (completed.type !== "merge" || !completed.base_branch) {
      return [];
    }
    // Issue 93d978e — retired abandoned rows are excluded from merge scans;
    // guarded so DBs without the column behave exactly as before.
    const retirementFilter = this.workUnitsHaveRetirementColumn()
      ? "AND (wu.state != 'abandoned' OR wu.merge_scan_retired_at IS NULL)"
      : "";
    const candidates = this.db.prepare(
      `SELECT
         wu.id,
         wu.issue_id,
         wu.ledger_issue_id,
         wu.repo_id,
         wu.state,
         wu.branch,
         b.repo_root,
         b.last_commit_hash
       FROM work_units wu
       LEFT JOIN branches b ON b.branch = wu.branch
       WHERE wu.state IN ('open', 'committed', 'abandoned')
         AND wu.branch IS NOT NULL
         ${retirementFilter}
         AND (wu.auth_request_id IS NULL OR wu.auth_request_id = ?)
       ORDER BY wu.id`
    ).all(completed.id) as Array<{
      id: string;
      issue_id: string;
      ledger_issue_id: string | null;
      repo_id: string;
      state: string;
      branch: string;
      repo_root: string | null;
      last_commit_hash: string | null;
    }>;

    const repoRoots = this.authRequestRepoRoots(completed);
    // Issue ded17e6 — canonical repo identity for the completed request, computed
    // once. Unifies path/symlink aliases and the `dotfiles`/`.dotfiles` repo-string
    // mismatch so those work units resolve on merge.
    const requestKeys = this.canonicalKeysForRequest(completed);
    // Issue 93d978e — the caller owns one batch per pass so its git-build
    // outcomes (see AncestryBatch.hadFailure) can gate the retirement sweep;
    // the reachable-commit sets and branch tip maps are cached for this request
    // only (the repo changed by definition).
    const resolved = new Map<string, {
      id: string;
      issue_id: string;
      ledger_issue_id: string | null;
    }>();
    for (const row of candidates) {
      if (row.branch === completed.head_branch) {
        continue;
      }
      if (!this.workUnitRepoMatchesRequest(row.repo_id, completed, repoRoots, requestKeys)) {
        continue;
      }
      const branchSnapshotMatchesRequest = row.repo_root
        ? this.workUnitRepoMatchesRequest(row.repo_root, completed, repoRoots, requestKeys)
        : true;
      const roots = [...repoRoots];
      if (row.repo_root && branchSnapshotMatchesRequest) roots.unshift(row.repo_root);
      const uniqueRoots = [...new Set(roots.filter(Boolean))];
      const lastCommitHash = branchSnapshotMatchesRequest ? row.last_commit_hash : null;
      let merged = false;
      for (const root of uniqueRoots) {
        if (await this.workUnitBranchWasMerged(
          root,
          row.branch,
          lastCommitHash,
          completed,
          { requestHeadOnly: row.state === "abandoned" },
          batch,
        )) {
          merged = true;
          break;
        }
      }
      if (merged) {
        resolved.set(row.id, {
          id: row.id,
          issue_id: row.issue_id,
          ledger_issue_id: row.ledger_issue_id,
        });
      }
    }
    return [...resolved.values()];
  }

  private explicitClosureIssueRefs(completed: AuthRequest): Set<string> {
    const refs = new Set<string>();
    for (const value of completed.issue_closures ?? completed.issues ?? []) {
      if (value) refs.add(value);
    }
    if (!this.tableExists("ledger_issues") || refs.size === 0) {
      return refs;
    }

    const resolvedRefs = new Set(refs);
    for (const ref of refs) {
      try {
        const rows = this.tableExists("ledger_issue_aliases")
          ? this.db.prepare(
            `SELECT id FROM ledger_issues WHERE id = ? OR short_id = ?
             UNION
             SELECT issue_id AS id FROM ledger_issue_aliases WHERE alias = ?`,
          ).all(ref, ref, ref) as Array<{ id: string }>
          : this.db.prepare(
            "SELECT id FROM ledger_issues WHERE id = ? OR short_id = ?",
          ).all(ref, ref) as Array<{ id: string }>;
        for (const row of rows) {
          resolvedRefs.add(row.id);
        }
      } catch {
        // Lightweight test DBs may not have all ledger compatibility tables.
      }
    }
    return resolvedRefs;
  }

  private workUnitMatchesIssueRefs(
    workUnit: { issue_id: string | null; ledger_issue_id: string | null },
    issueRefs: Set<string>,
  ): boolean {
    if (issueRefs.size === 0) return false;
    for (const candidate of [workUnit.issue_id, workUnit.ledger_issue_id]) {
      if (!candidate) continue;
      for (const issueRef of issueRefs) {
        if (issueRef === candidate || issueRef.startsWith(candidate) || candidate.startsWith(issueRef)) {
          return true;
        }
      }
    }
    return false;
  }

  private authRequestRepoRoots(completed: AuthRequest): string[] {
    const roots = new Set<string>();
    for (const value of [completed.target_repo_root, completed.cwd]) {
      if (value) roots.add(value);
    }
    if (completed.repo) {
      try {
        const rows = this.db.prepare(
          `SELECT root FROM work_repos
           WHERE id = ? OR name = ? OR root = ?`
        ).all(completed.repo, completed.repo, completed.repo) as Array<{ root: string }>;
        for (const row of rows) roots.add(row.root);
      } catch {
        // work_repos is unavailable in some lightweight tests.
      }
    }
    return [...roots];
  }

  private workUnitRepoMatchesRequest(
    repoValue: string,
    completed: AuthRequest,
    repoRoots: string[],
    requestKeys: Set<string>,
  ): boolean {
    // Issue ded17e6 — canonical identity match first. Resolve the work unit's
    // repo value (a repo string like "dotfiles" or a checkout root path) to its
    // canonical keys and match against the request's precomputed key set. This
    // is what makes work unit repo_id="dotfiles" resolve against request
    // repo=".dotfiles" when the registry roots both at one physical repo.
    if (requestKeys.size > 0) {
      for (const key of canonicalRepoKeysForRef(this.db, repoValue)) {
        if (requestKeys.has(key)) {
          return true;
        }
      }
      const pathKey = canonicalRepoKeyForPath(repoValue);
      if (pathKey && requestKeys.has(pathKey)) {
        return true;
      }
    }
    // String-based fallback (unchanged) — never matches less than before.
    if (!completed.repo && repoRoots.length === 0) {
      return true;
    }
    if (repoValue === completed.repo || repoRoots.includes(repoValue)) {
      return true;
    }
    const suffix = `/${repoValue}`;
    return Boolean(completed.repo?.endsWith(suffix)) || repoRoots.some((root) => root.endsWith(suffix));
  }

  /**
   * Issue ded17e6 — the canonical repo keys reachable from a completed request:
   * its resolved execution roots (target_repo_root, cwd) plus every key its
   * free-form `repo` string resolves to through the registry.
   */
  private canonicalKeysForRequest(request: AuthRequest): Set<string> {
    const keys = new Set<string>();
    for (const path of [request.target_repo_root, request.cwd]) {
      const key = canonicalRepoKeyForPath(path);
      if (key) {
        keys.add(key);
      }
    }
    for (const key of canonicalRepoKeysForRef(this.db, request.repo)) {
      keys.add(key);
    }
    return keys;
  }

  /**
   * Issue ded17e6 — do two free-form repo refs denote the same physical repo?
   * When both resolve to canonical keys, canonical identity is authoritative
   * (intersection required). When either side resolves to no key (registry-less
   * DBs, deleted checkouts), fall back to today's exact string comparison so no
   * previously-matching pair stops matching.
   */
  private repoRefsMatch(refA: string | null, keysA: Set<string>, refB: string | null): boolean {
    const keysB = canonicalRepoKeysForRef(this.db, refB);
    if (keysA.size > 0 && keysB.size > 0) {
      for (const key of keysA) {
        if (keysB.has(key)) {
          return true;
        }
      }
      return false;
    }
    return refA === refB;
  }

  private async workUnitBranchWasMerged(
    repoRoot: string,
    branch: string,
    lastCommitHash: string | null,
    completed: AuthRequest,
    options: { requestHeadOnly?: boolean } = {},
    batch?: AncestryBatch,
  ): Promise<boolean> {
    // Abandoned work needs request-specific evidence; base ancestry alone can
    // match stale work that landed before this auth request.
    const targets = options.requestHeadOnly
      ? [
          completed.merge_head_sha,
          !completed.merge_head_sha && completed.head_branch ? `refs/heads/${completed.head_branch}` : null,
        ].filter((value): value is string => Boolean(value))
      : [
          completed.merge_head_sha,
          completed.base_branch ? `refs/heads/${completed.base_branch}` : null,
        ].filter((value): value is string => Boolean(value));

    const candidates = [
      lastCommitHash && /^[0-9a-f]{40}$/i.test(lastCommitHash) ? lastCommitHash : null,
      `refs/heads/${branch}`,
    ].filter((value): value is string => Boolean(value));

    // Issue 93d978e — route through the per-request batch when supplied so the
    // reachable-commit set is built once per (root, target); fall back to the
    // per-row spawn only for callers that do not pass a batch.
    for (const candidate of candidates) {
      for (const target of targets) {
        const merged = batch
          ? await batch.isAncestor(repoRoot, candidate, target)
          : this.gitIsAncestor(repoRoot, candidate, target);
        if (merged) {
          return true;
        }
      }
    }
    return false;
  }

  private gitIsAncestor(cwd: string, candidate: string, target: string): boolean {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", candidate, target], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async archiveCompletedWorkerThreads(
    completed: AuthRequest,
    options: { logSummary?: boolean } = {},
  ): Promise<CodexArchiveReplayResult> {
    const result: CodexArchiveReplayResult = {
      request_id: completed.id,
      archived: 0,
      attempt_failures: 0,
      candidates: [],
    };
    if (completed.type !== "merge") {
      return result;
    }
    const logSummary = options.logSummary ?? true;
    try {
      const candidates = listCompletedWorkerThreadArchiveCandidates(this.db, completed);
      for (const candidate of candidates) {
        const archived = await safeArchiveCodexThread(this.codexThreadArchiver, candidate.provider_session_id);
        if (archived) {
          result.archived += 1;
        } else {
          // Every candidate has a provider handle (listing filters out the
          // handle-less "definitively not archivable" rows), so a false result
          // means the codex archive CLI attempt failed (error/timeout).
          result.attempt_failures += 1;
        }
        result.candidates.push({ ...candidate, archived });
      }
      if (logSummary && result.archived > 0) {
        authLog("info", "auth_completed_worker_threads_archived", {
          subsystem: "auth",
          auth_request_id: completed.id,
          archived_count: result.archived,
          head_branch: completed.head_branch,
        });
      }
    } catch (err) {
      // Candidate-listing failure (e.g. a transient DB error) is also a
      // retryable attempt failure, not a definitive completion.
      result.attempt_failures += 1;
      authLog("warn", "auth_completed_worker_thread_archive_failed", {
        subsystem: "auth",
        auth_request_id: completed.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return result;
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
      conversation_id: request.conversation_id,
      execution_evidence_id: request.execution_evidence_id,
      signature_verification: this.signatureVerificationForRequest(request),
      action_outcomes: this.actionOutcomeSummary(request.id)
    };
  }

  // Issue 75f52ac — auth:merged payload: the resolved shape minus action_outcomes
  // (deferred ledger actions have not run yet at Stage 1). The UI flips the row
  // on this event; the follow-up auth:resolved carries action_outcomes.
  private buildMergedPayload(request: AuthRequest): Record<string, unknown> {
    const { action_outcomes: _actionOutcomes, ...rest } = this.buildResolvedPayload(request);
    return rest;
  }

  // Issue 75f52ac — auth:finalized payload: emitted once every Stage 3 step is
  // terminal. Surfaces per-step outcomes (including failures), the ancestry
  // work units resolved in Stage 3, and the archived-thread count.
  private buildFinalizedPayload(
    request: AuthRequest,
    state: FinalizerState,
  ): Record<string, unknown> {
    const steps = FINALIZER_STEP_NAMES.map((name) => {
      const entry = state[name];
      return {
        name,
        state: entry?.state ?? "skipped",
        attempts: entry?.attempts ?? 0,
        ...(entry?.error ? { error: entry.error } : {}),
      };
    });
    // Issue 75f52ac — reconstruct outputs from the persisted per-step state so a
    // step whose output was produced on an earlier pass (or before a crash) is
    // reported correctly, rather than reading process-local accumulators that
    // reset every pass and stay empty when the step is skipped as already-done.
    return {
      request_id: request.id,
      merge_finalized_at: request.merge_finalized_at ?? null,
      steps,
      resolved_work_unit_ids:
        state.resolve_ancestry_work_units?.output?.resolved_work_unit_ids ?? [],
      archived_thread_count:
        state.archive_worker_threads?.output?.archived_thread_count ?? 0,
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

  private requireActionVetoableRequest(id: string): AuthRequest {
    const request = this.requireRequest(id);
    if (request.status !== "pending") {
      throw new AuthQueueError(
        "invalid_status",
        `Request is ${request.status}, cannot change action veto state.`,
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

function projectAuthAttributionEvent(
  db: InstanceType<typeof Database>,
  event: SseEvent,
): SseEvent {
  if (event.event !== "auth:new" && event.event !== "auth:updated") return event;
  if (!event.data || typeof event.data !== "object") return event;
  const data = event.data as Record<string, unknown>;
  if (!data.request || typeof data.request !== "object") return event;
  const request = data.request as AuthRequest;
  return {
    ...event,
    data: {
      ...data,
      request: {
        ...request,
        ...authAttributionReadFields(new AttributionReadResolver(db), request),
      },
    },
  };
}

// Bug: 929c6d0 — extract the last N lines from a string for error output summaries.
function tailLines(text: string, n: number): string | null {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const tail = lines.slice(-n);
  const result = tail.join("\n").trim();
  return result || null;
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
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

type AtomicMarker = {
  merge_sha: string;
  base_sha?: string;
  head_sha?: string;
  tree_sha?: string;
};

function extractAtomicMergeState(output: string): {
  prepared: Required<AtomicMarker> | null;
  applied: AtomicMarker | null;
} {
  let prepared: Required<AtomicMarker> | null = null;
  let applied: AtomicMarker | null = null;
  for (const line of output.split(/\r?\n/)) {
    for (const [prefix, kind] of [
      ["MANDIBLE_MERGE_PREPARED ", "prepared"],
      ["MANDIBLE_MERGE_APPLIED ", "applied"],
    ] as const) {
      const index = line.indexOf(prefix);
      if (index < 0) continue;
      try {
        const value = JSON.parse(line.slice(index + prefix.length)) as AtomicMarker;
        if (!GIT_OID_RE.test(value.merge_sha ?? "")) continue;
        if (kind === "prepared") {
          if (
            GIT_OID_RE.test(value.base_sha ?? "") && GIT_OID_RE.test(value.head_sha ?? "") &&
            GIT_OID_RE.test(value.tree_sha ?? "")
          ) prepared = value as Required<AtomicMarker>;
        } else if (!value.base_sha || GIT_OID_RE.test(value.base_sha)) {
          applied = value;
        }
      } catch {
        // Malformed markers never become recovery authority.
      }
    }
  }
  return { prepared, applied };
}

function atomicMergeResultLine(request: AuthRequest, mergeSha: string): string {
  return `MANDIBLE_MERGE_RESULT ${JSON.stringify({
    merge_sha: mergeSha,
    repo_id: request.repo ?? null,
    auto_close_issues: [],
    declared_issues: request.issue_closures ?? [],
  })}`;
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
    requested_by_user_id: row.requested_by_user_id == null ? null : String(row.requested_by_user_id),
    approved_by_user_id: row.approved_by_user_id == null ? null : String(row.approved_by_user_id),
    execution_evidence_id: row.execution_evidence_id == null ? null : String(row.execution_evidence_id),
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
    merge_head_sha: row.merge_head_sha == null ? null : String(row.merge_head_sha),
    merge_candidate_tree_sha: row.merge_candidate_tree_sha == null
      ? null
      : String(row.merge_candidate_tree_sha),
    merge_candidate_pin_sha: row.merge_candidate_pin_sha == null
      ? null
      : String(row.merge_candidate_pin_sha),
    merge_atomic_enabled: row.merge_atomic_enabled === 1 || row.merge_atomic_enabled === true,
    merge_preflight_base_sha: row.merge_preflight_base_sha == null ? null : String(row.merge_preflight_base_sha),
    merge_preflight_queue_fingerprint: row.merge_preflight_queue_fingerprint == null
      ? null
      : String(row.merge_preflight_queue_fingerprint),
    merge_finalized_at: row.merge_finalized_at == null ? null : Number(row.merge_finalized_at),
    // Issue 75f52ac — durable per-step finalizer state (raw JSON string); detail
    // views and crash recovery read it. Kept as a string to match the column.
    merge_finalizer_state: row.merge_finalizer_state == null ? null : String(row.merge_finalizer_state),
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
