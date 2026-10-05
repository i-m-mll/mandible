import { getDb, type Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { canonicalRepoKeysForRef } from "./repo-identity.js";
import { isSessionAliasLive } from "./session-liveness.js";
import type { Logger } from "./types.js";

/**
 * Result of looking for an auth request that explains a missing branch.
 * `none` is a proven absence; `unknown` is a failed lookup. Only `none` may
 * abandon a work unit.
 */
type AuthPipelineMatch =
  | { status: "matched"; id: string; completed: boolean; resolved_at: number | null }
  | { status: "none" }
  | { status: "unknown" };

// Bug: 8a281b3 — periodic reconciler for work unit state consistency.
// Runs every 60s and performs three reconciliation passes:
// 1. Dead session cleanup: clear assigned_session_id when session is dead
// 2. Abandoned branch detection: committed → abandoned when branch deleted
// 3. Auto-commit detection: open → committed when branch has commits

const RECONCILE_INTERVAL_MS = 60_000;

export class WorkUnitReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;
  private readonly sessionIsLive: (db: Db, sessionId: string) => boolean;

  constructor(
    logger: Logger,
    options: { sessionIsLive?: (db: Db, sessionId: string) => boolean } = {},
  ) {
    this.logger = logger;
    this.sessionIsLive = options.sessionIsLive ?? isSessionAliasLive;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    this.reconcile();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run all reconciliation passes. Safe to call manually for testing. */
  reconcile(): void {
    try {
      const deadCleared = this.reconcileDeadSessions();
      const abandoned = this.reconcileAbandonedBranches();
      const autoCommitted = this.reconcileAutoCommit();

      if (deadCleared > 0 || abandoned > 0 || autoCommitted > 0) {
        this.logger("info", "work_unit_reconcile", {
          dead_sessions_cleared: deadCleared,
          abandoned: abandoned,
          auto_committed: autoCommitted,
        });
      }
    } catch (error) {
      this.logger("warn", "work_unit_reconcile_failed", { error: String(error) });
    }
  }

  /**
   * Pass 1: Clear assigned_session_id for work units whose assigned session is dead/ended.
   * The work unit remains in its current state but shows as "unassigned" in liveness.
   */
  private reconcileDeadSessions(): number {
    const db = getDb();

    const run = db.transaction(() => {
      // Find work units with assigned sessions that are dead or ended
      const stale = db
        .prepare(
          `SELECT wu.id FROM work_units wu
           JOIN sessions s ON wu.assigned_session_id = s.id
           WHERE wu.assigned_session_id IS NOT NULL
             AND wu.state IN ('open', 'committed')
             AND s.status IN ('dead', 'ended')
           ORDER BY wu.id`
        )
        .all() as Array<{ id: string }>;

      if (stale.length === 0) return 0;

      const clearStmt = db.prepare(
        "UPDATE work_units SET assigned_session_id = NULL WHERE id = ?"
      );

      for (const row of stale) {
        clearStmt.run(row.id);
      }

      return stale.length;
    });

    return run();
  }

  /**
   * Pass 2: Mark committed work units as abandoned when their branch no longer exists.
   * Uses the branches table from the work scanner to check branch existence.
   */
  private reconcileAbandonedBranches(): number {
    const db = getDb();

    const run = db.transaction(() => {
      // Find committed work units with branches that don't exist in the branches table
      // A branch that was merged and deleted will not appear in the branches table.
      // Bug: f3dbb3e — skip work units in the auth pipeline (auth_request_id IS NOT NULL).
      // Their branch may be temporarily missing (just merged and cleaned up).
      const committed = db
        .prepare(
          `SELECT wu.id, wu.branch, wu.repo_id, wu.created_at,
                  wu.assigned_session_id, wu.worker_provider_session_id, wu.provider_session_id
             FROM work_units wu
           WHERE wu.state = 'committed' AND wu.branch IS NOT NULL
             AND wu.auth_request_id IS NULL
           ORDER BY wu.id`
        )
        .all() as Array<{
          id: string;
          branch: string;
          repo_id: string;
          created_at: number;
          assigned_session_id: string | null;
          worker_provider_session_id: string | null;
          provider_session_id: string | null;
        }>;

      if (committed.length === 0) return 0;

      const checkBranch = db.prepare(
        "SELECT repo_root FROM branches WHERE branch = ?"
      );

      const abandonStmt = db.prepare(
        "UPDATE work_units SET state = 'abandoned' WHERE id = ?"
      );
      const resolveStmt = db.prepare(
        `UPDATE work_units
         SET state = 'resolved', resolved_at = COALESCE(resolved_at, ?),
             auth_request_id = COALESCE(auth_request_id, ?)
         WHERE id = ? AND state = 'committed'`
      );

      let count = 0;
      for (const row of committed) {
        const workUnitKeys = canonicalRepoKeysForRef(db, row.repo_id);
        const exists = (checkBranch.all(row.branch) as Array<{ repo_root: string }>).some(branch =>
          branch.repo_root === row.repo_id || [...canonicalRepoKeysForRef(db, branch.repo_root)]
            .some(key => workUnitKeys.has(key)));
        if (!exists) {
          const sessionId = row.assigned_session_id
            ?? row.worker_provider_session_id
            ?? row.provider_session_id;
          // A scanner miss is not proof that a live task abandoned its work.
          // The same canonical provider-session authority used by parent-role
          // and work-unit reads gets first refusal over this destructive state
          // transition; once the task stops, ordinary branch/auth proof applies.
          if (sessionId && this.sessionIsLive(db, sessionId)) continue;
          // A branch may be deleted by auth-merge before the successful result
          // reaches Stage 2. Keep it committed while a same-repo request is
          // active, or resolve it here once that request proves success.
          const authRequest = this.matchingAuthPipelineRequest(row);
          if (authRequest.status === "unknown") {
            // No evidence either way. Leave it committed for the next pass
            // rather than abandoning on a failed lookup.
            continue;
          }
          if (authRequest.status === "matched") {
            if (authRequest.completed) {
              resolveStmt.run(authRequest.resolved_at ?? Date.now(), authRequest.id, row.id);
            }
            continue;
          }
          abandonStmt.run(row.id);
          count++;
        }
      }

      return count;
    });

    return run();
  }

  /**
   * Whether an auth request in flight explains this work unit's missing branch.
   *
   * Three outcomes, not two. The caller ABANDONS a committed work unit when no
   * request matches, so "the query failed" and "no request matches" must not
   * share a return value — a SQL error used to abandon a work unit whose merge
   * may well have succeeded. The legitimate legacy-schema case is already
   * handled by the `tableExists` precondition above the try, so the catch only
   * ever fires on a real failure.
   */
  private matchingAuthPipelineRequest(workUnit: {
    branch: string;
    repo_id: string;
    created_at: number;
  }): AuthPipelineMatch {
    const db = getDb();
    if (!tableExists(db, "auth_requests")) return { status: "none" };
    try {
      const requests = db.prepare(
        `SELECT id, repo, cwd, target_repo_root, status, resolved_at
         FROM auth_requests
         WHERE type = 'merge' AND head_branch = ? AND created_at >= ?
           AND (
             status IN ('pending', 'approved', 'executing')
             OR (status = 'completed' AND exit_code = 0)
           )`
      ).all(workUnit.branch, workUnit.created_at) as Array<{
        id: string;
        repo: string | null;
        cwd: string | null;
        target_repo_root: string | null;
        status: string;
        resolved_at: number | null;
      }>;
      const workUnitKeys = canonicalRepoKeysForRef(db, workUnit.repo_id);
      for (const request of requests) {
        const refs = [request.target_repo_root, request.cwd, request.repo].filter(
          (value): value is string => Boolean(value),
        );
        const requestKeys = new Set<string>();
        for (const ref of refs) {
          for (const key of canonicalRepoKeysForRef(db, ref)) requestKeys.add(key);
        }
        const matches = workUnitKeys.size > 0 && requestKeys.size > 0
          ? [...workUnitKeys].some((key) => requestKeys.has(key))
          : refs.includes(workUnit.repo_id);
        if (matches) {
          return {
            status: "matched",
            id: request.id,
            completed: request.status === "completed",
            resolved_at: request.resolved_at,
          };
        }
      }
      return { status: "none" };
    } catch (error) {
      this.logger("error", "work_unit_auth_match_query_failed", {
        work_unit_branch: workUnit.branch,
        repo_id: workUnit.repo_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "unknown" };
    }
  }

  /**
   * Pass 3: Auto-transition open work units to committed when their branch
   * has commits ahead of the default branch (detected via the branches table).
   */
  private reconcileAutoCommit(): number {
    const db = getDb();

    const run = db.transaction(() => {
      // Find open work units that have a branch with commits ahead of default
      const openWithBranch = db
        .prepare(
          `SELECT wu.id, wu.branch, wu.repo_id FROM work_units wu
           WHERE wu.state = 'open' AND wu.branch IS NOT NULL
           ORDER BY wu.id`
        )
        .all() as Array<{ id: string; branch: string; repo_id: string }>;

      if (openWithBranch.length === 0) return 0;

      const checkAhead = db.prepare(
        "SELECT repo_root FROM branches WHERE branch = ? AND ahead_default > 0"
      );

      const commitStmt = db.prepare(
        "UPDATE work_units SET state = 'committed', activated_at = ? WHERE id = ?"
      );

      const now = Date.now();
      let count = 0;
      for (const row of openWithBranch) {
        const workUnitKeys = canonicalRepoKeysForRef(db, row.repo_id);
        const ahead = (checkAhead.all(row.branch) as Array<{ repo_root: string }>).some(branch =>
          branch.repo_root === row.repo_id || [...canonicalRepoKeysForRef(db, branch.repo_root)]
            .some(key => workUnitKeys.has(key)));
        if (ahead) {
          commitStmt.run(now, row.id);
          count++;
        }
      }

      return count;
    });

    return run();
  }
}
