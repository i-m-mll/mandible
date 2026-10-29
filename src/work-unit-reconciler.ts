import { parseAssignmentTarget } from "./work-unit-assignment.js";
import { hasArchivedResponsibility } from "./work-unit-worker.js";
import { mutateWorkUnit } from "./work-unit-history.js";
import fs from "node:fs";
import path from "node:path";
import { getDb, type Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { observeRepoIdentities, checkoutRootsForRef } from "./repo-identity.js";
import { freshSessionAliasResolver } from "./session-liveness.js";
import type { Logger } from "./types.js";
import type { WorkUnitSessionResolver } from "./work-unit-utils.js";
import { listLocalBranches } from "./work-scanner.js";

/**
 * Result of looking for an auth request that explains a missing branch.
 * `none` is a proven absence; `unknown` is a failed lookup. Only `none` may
 * abandon a work unit.
 */
type AuthPipelineMatch =
  | { status: "matched"; id: string; completed: boolean; resolved_at: number | null }
  | { status: "none" }
  | { status: "unknown" };

function workUnitDecisionState(db: Db, id: string): string {
  const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return JSON.stringify(row ? ["id", "state", "branch", "repo_id", "created_at", "assigned_session_id", "assignment_target_json", "worker_provider_session_id", "provider_session_id", "auth_request_id", "owner_user_id", "owner_credential_id", "custody_generation", "resolved_at"].map(key => row[key] ?? null) : null);
}

// Bug: 8a281b3 — periodic reconciler for work unit state consistency.
// Runs every 60s and performs three reconciliation passes:
// 1. Dead holder cleanup: clear assigned_session_id when its alias resolves to a stopped agent
// 2. Abandoned branch detection: committed → abandoned when Git confirms the branch is gone
// 3. Auto-commit detection: open → committed when branch has commits

const RECONCILE_INTERVAL_MS = 60_000;
export interface WorkUnitReconcilerOptions {
  /** Replaces the shared rule, whose Codex answers come from lock scans made for each pass. */
  resolveSession?: WorkUnitSessionResolver;
  now?: () => number;
}

export class WorkUnitReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;
  private readonly resolveSession: WorkUnitSessionResolver | undefined;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private pass: Promise<void> | null = null;
  private lastUnknownHolders = 0;

  constructor(logger: Logger, options: WorkUnitReconcilerOptions = {}) {
    this.logger = logger;
    this.resolveSession = options.resolveSession;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    void this.reconcile();
  }

  /** Stop the timer, cancel in-flight Git reads, and wait for the current pass. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort.abort();
    await this.pass;
  }

  /** Run all reconciliation passes; a call during a running pass joins it. */
  reconcile(): Promise<void> {
    this.pass ??= this.runPasses().finally(() => { this.pass = null; });
    return this.pass;
  }

  private async runPasses(): Promise<void> {
    try {
      const holders = await this.reconcileDeadHolders();
      const abandoned = await this.reconcileAbandonedBranches();
      const autoCommitted = await this.reconcileAutoCommit();

      const unknownChanged = holders.unknown !== this.lastUnknownHolders;
      this.lastUnknownHolders = holders.unknown;
      if (holders.cleared > 0 || abandoned > 0 || autoCommitted > 0 || unknownChanged) {
        this.logger(holders.unknown > 0 ? "warn" : "info", "work_unit_reconcile", {
          dead_sessions_cleared: holders.cleared,
          unknown_holders: holders.unknown,
          abandoned: abandoned,
          auto_committed: autoCommitted,
        });
      }
    } catch (error) {
      this.logger("warn", "work_unit_reconcile_failed", { error: String(error) });
    }
  }

  /**
   * Pass 1: Clear assigned_session_id on open and committed work units whose
   * holder alias resolves to a stopped agent. The work unit keeps its state and
   * reads as unassigned. A holder alias Mandible has never seen, or one whose
   * liveness check could not complete, is left in place and counted, since
   * nothing proves it stopped.
   */
  private async reconcileDeadHolders(): Promise<{ cleared: number; unknown: number }> {
    const db = getDb();
    const heldRows = () => db
      .prepare(
        `SELECT * FROM work_units
         WHERE assigned_session_id IS NOT NULL
           AND state IN ('open', 'committed')
         ORDER BY id`
      )
      .all() as Array<Record<string, unknown> & { id: string; assigned_session_id: string }>;
    const resolve = this.resolveSession ?? await freshSessionAliasResolver((probe) => {
      for (const row of heldRows()) probe(db, row.assigned_session_id);
    });
    const held = heldRows();

    const dead: typeof held = [];
    let unknown = 0;
    for (const row of held) {
      const liveness = resolve(db, row.assigned_session_id)?.liveness ?? "unknown";
      if (liveness === "stopped" && !hasArchivedResponsibility(db, row)) dead.push(row);
      else if (liveness === "unknown") unknown++;
    }
    if (dead.length === 0) return { cleared: 0, unknown };

    const clearStmt = db.prepare(
      `UPDATE work_units SET assigned_session_id = NULL
       WHERE id = ? AND assigned_session_id = ? AND state IN ('open', 'committed')`
    );
    const cleared = db.transaction(() => {
      let count = 0;
      for (const row of dead) {
        count += Number(mutateWorkUnit(db, row.id, () => clearStmt.run(row.id, row.assigned_session_id)).changes);
      }
      return count;
    })();
    return { cleared, unknown };
  }

  /**
   * Pass 3: Mark committed work units as abandoned when Git confirms their
   * branch is gone. The scanner's `branches` table is a cache refreshed only
   * on scans, so a miss there proves nothing; only Git's own refs do.
   */
  private async reconcileAbandonedBranches(): Promise<number> {
    const db = getDb();
    // Bug: f3dbb3e — skip work units in the auth pipeline (auth_request_id IS NOT NULL).
    // Their branch may be temporarily missing (just merged and cleaned up).
    const committed = db
      .prepare(
        `SELECT wu.id, wu.branch, wu.repo_id, wu.created_at,
                wu.assigned_session_id, wu.assignment_target_json, wu.worker_provider_session_id, wu.provider_session_id
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
        assignment_target_json: string | null;
        assigned_session_id: string | null;
        worker_provider_session_id: string | null;
        provider_session_id: string | null;
      }>;

    const starting = new Map(committed.map(row => [row.id, workUnitDecisionState(db, row.id)]));
    const identity = await observeRepoIdentities(db, committed.map(row => row.repo_id), [], this.abort.signal);
    const branchesByRoot = new Map<string, Promise<Set<string> | null>>();
    const gone: typeof committed = [];
    for (const row of committed) {
      if (await this.branchIsGone(db, row, branchesByRoot)) gone.push(row);
    }
    if (gone.length === 0) return 0;
    const results = await Promise.allSettled(gone.map(async row => [row.id, await this.matchingAuthPipelineRequest(row)] as const));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    const pipelines = new Map(results.map(result => {
      if (result.status !== "fulfilled") throw new Error("Unsettled work-unit pipeline observation");
      return result.value;
    }));
    const holderOf = (row: (typeof gone)[number]) => row.assigned_session_id
      ?? parseAssignmentTarget(row.assignment_target_json)?.session_id
      ?? row.worker_provider_session_id
      ?? row.provider_session_id;
    const resolve = this.resolveSession ?? await freshSessionAliasResolver((probe) => {
      for (const row of gone) {
        const sessionId = holderOf(row);
        if (sessionId) probe(db, sessionId);
      }
    });

    const abandonStmt = db.prepare(
      "UPDATE work_units SET state = 'abandoned' WHERE id = ? AND state = 'committed' AND auth_request_id IS NULL"
    );
    const resolveStmt = db.prepare(
      `UPDATE work_units
       SET state = 'resolved', resolved_at = COALESCE(resolved_at, ?),
           auth_request_id = COALESCE(auth_request_id, ?)
       WHERE id = ? AND state = 'committed'`
    );

    return db.transaction(() => {
      let count = 0;
      for (const row of gone) {
        this.abort.signal.throwIfAborted();
        identity.assertCurrent();
        if (workUnitDecisionState(db, row.id) !== starting.get(row.id)) continue;
        const pipeline = pipelines.get(row.id)!;
        if (!pipeline.isCurrent()) continue;
        const sessionId = holderOf(row);
        // The same canonical provider-session authority used by parent-role
        // and work-unit reads gets first refusal over this destructive state
        // transition; once the task stops, ordinary branch/auth proof applies.
        // A task whose liveness cannot be established gets the same refusal.
        const liveness = sessionId ? resolve(db, sessionId)?.liveness : undefined;
        if (liveness === "live" || liveness === "unknown") continue;
        // A branch may be deleted by auth-merge before the successful result
        // reaches Stage 2. Keep it committed while a same-repo request is
        // active, or resolve it here once that request proves success.
        const authRequest = pipeline.match;
        if (authRequest.status === "unknown") {
          // No evidence either way. Leave it committed for the next pass
          // rather than abandoning on a failed lookup.
          continue;
        }
        if (authRequest.status === "matched") {
          if (authRequest.completed) {
            mutateWorkUnit(db, row.id, () => resolveStmt.run(authRequest.resolved_at ?? Date.now(), authRequest.id, row.id));
          }
          continue;
        }
        count += Number(mutateWorkUnit(db, row.id, () => abandonStmt.run(row.id)).changes);
      }
      return count;
    })();
  }

  /**
   * True only when Git answers for every existing checkout of the unit's repo
   * and none of them has the branch. An unresolvable repo or a failed Git read
   * is not evidence of absence.
   */
  private async branchIsGone(
    db: Db,
    row: { branch: string; repo_id: string },
    branchesByRoot: Map<string, Promise<Set<string> | null>>,
  ): Promise<boolean> {
    const roots = checkoutRootsForRef(db, row.repo_id)
      .filter((root) => path.isAbsolute(root) && fs.existsSync(root));
    if (roots.length === 0) return false;
    for (const root of roots) {
      if (!branchesByRoot.has(root)) {
        branchesByRoot.set(root, listLocalBranches(root, this.abort.signal).then(
          (branches) => new Set(branches),
          (error) => {
            if (!this.abort.signal.aborted) {
              this.logger("warn", "work_unit_branch_read_failed", { repo_root: root, error: String(error) });
            }
            return null;
          },
        ));
      }
      const branches = await branchesByRoot.get(root);
      if (!branches || branches.has(row.branch)) return false;
    }
    return true;
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
  private async matchingAuthPipelineRequest(workUnit: {
    branch: string;
    repo_id: string;
    created_at: number;
  }): Promise<{ match: AuthPipelineMatch; isCurrent(): boolean }> {
    const db = getDb();
    if (!tableExists(db, "auth_requests")) return { match: { status: "none" }, isCurrent: () => !tableExists(db, "auth_requests") };
    try {
      const read = () => db.prepare(
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
      const requests = read();
      const identity = await observeRepoIdentities(db, [workUnit.repo_id, ...requests.flatMap(request => [request.target_repo_root, request.cwd, request.repo])], [], this.abort.signal);
      const isCurrent = () => {
        this.abort.signal.throwIfAborted();
        identity.assertCurrent();
        return JSON.stringify(read()) === JSON.stringify(requests);
      };
      const result = (match: AuthPipelineMatch) => ({ match, isCurrent });
      const workUnitKeys = identity.keysForRef(workUnit.repo_id);
      for (const request of requests) {
        const refs = [request.target_repo_root, request.cwd, request.repo].filter(
          (value): value is string => Boolean(value),
        );
        const requestKeys = new Set<string>();
        for (const ref of refs) {
          for (const key of identity.keysForRef(ref)) requestKeys.add(key);
        }
        const matches = workUnitKeys.size > 0 && requestKeys.size > 0
          ? [...workUnitKeys].some((key) => requestKeys.has(key))
          : refs.includes(workUnit.repo_id);
        if (matches) {
          return result({ status: "matched", id: request.id, completed: request.status === "completed", resolved_at: request.resolved_at });
        }
      }
      return result({ status: "none" });
    } catch (error) {
      this.abort.signal.throwIfAborted();
      this.logger("error", "work_unit_auth_match_query_failed", {
        work_unit_branch: workUnit.branch,
        repo_id: workUnit.repo_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { match: { status: "unknown" }, isCurrent: () => true };
    }
  }

  /**
   * Pass 4: Auto-transition open work units to committed when their branch
   * has commits ahead of the default branch (detected via the branches table).
   */
  private async reconcileAutoCommit(): Promise<number> {
    const db = getDb();
    const rows = db.prepare("SELECT id, branch, repo_id FROM work_units WHERE state = 'open' AND branch IS NOT NULL ORDER BY id").all() as Array<{ id: string; branch: string; repo_id: string }>;
    if (rows.length === 0) return 0;
    const readBranches = (branch: string) => db.prepare("SELECT repo_root FROM branches WHERE branch = ? AND ahead_default > 0 ORDER BY repo_root").all(branch) as Array<{ repo_root: string }>;
    const candidates = rows.map(row => ({ row, state: workUnitDecisionState(db, row.id), branches: readBranches(row.branch) }));
    const identity = await observeRepoIdentities(db, candidates.flatMap(({ row, branches }) => [row.repo_id, ...branches.map(branch => branch.repo_root)]), [], this.abort.signal);
    return db.transaction(() => {
      this.abort.signal.throwIfAborted();
      identity.assertCurrent();
      let count = 0;
      for (const { row, state, branches } of candidates) {
        if (workUnitDecisionState(db, row.id) !== state || JSON.stringify(readBranches(row.branch)) !== JSON.stringify(branches)) continue;
        const keys = identity.keysForRef(row.repo_id);
        const ahead = branches.some(branch => branch.repo_root === row.repo_id || [...identity.keysForRef(branch.repo_root)].some(key => keys.has(key)));
        if (ahead) count += Number(mutateWorkUnit(db, row.id, () => db.prepare("UPDATE work_units SET state = 'committed', activated_at = ? WHERE id = ? AND state = 'open'").run(this.now(), row.id)).changes);
      }
      return count;
    })();
  }
}
