import { getDb } from "./db.js";
// Bug: 8a281b3 — periodic reconciler for work unit state consistency.
// Runs every 60s and performs three reconciliation passes:
// 1. Dead session cleanup: clear assigned_session_id when session is dead
// 2. Abandoned branch detection: committed → abandoned when branch deleted
// 3. Auto-commit detection: open → committed when branch has commits
const RECONCILE_INTERVAL_MS = 60_000;
export class WorkUnitReconciler {
    timer = null;
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
        if (typeof this.timer === "object" && "unref" in this.timer) {
            this.timer.unref();
        }
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Run all reconciliation passes. Safe to call manually for testing. */
    reconcile() {
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
        }
        catch (error) {
            this.logger("warn", "work_unit_reconcile_failed", { error: String(error) });
        }
    }
    /**
     * Pass 1: Clear assigned_session_id for work units whose assigned session is dead/ended.
     * The work unit remains in its current state but shows as "unassigned" in liveness.
     */
    reconcileDeadSessions() {
        const db = getDb();
        // Find work units with assigned sessions that are dead or ended
        const stale = db
            .prepare(`SELECT wu.id FROM work_units wu
         JOIN sessions s ON wu.assigned_session_id = s.id
         WHERE wu.assigned_session_id IS NOT NULL
           AND wu.state IN ('open', 'committed')
           AND s.status IN ('dead', 'ended')`)
            .all();
        if (stale.length === 0)
            return 0;
        const clearStmt = db.prepare("UPDATE work_units SET assigned_session_id = NULL WHERE id = ?");
        for (const row of stale) {
            clearStmt.run(row.id);
        }
        return stale.length;
    }
    /**
     * Pass 2: Mark committed work units as abandoned when their branch no longer exists.
     * Uses the branches table from the work scanner to check branch existence.
     */
    reconcileAbandonedBranches() {
        const db = getDb();
        // Find committed work units with branches that don't exist in the branches table
        // A branch that was merged and deleted will not appear in the branches table.
        // Bug: f3dbb3e — skip work units in the auth pipeline (auth_request_id IS NOT NULL).
        // Their branch may be temporarily missing (just merged and cleaned up).
        const committed = db
            .prepare(`SELECT wu.id, wu.branch, wu.repo_id FROM work_units wu
         WHERE wu.state = 'committed' AND wu.branch IS NOT NULL
           AND wu.auth_request_id IS NULL`)
            .all();
        if (committed.length === 0)
            return 0;
        const checkBranch = db.prepare("SELECT 1 FROM branches WHERE branch = ? LIMIT 1");
        const abandonStmt = db.prepare("UPDATE work_units SET state = 'abandoned' WHERE id = ?");
        let count = 0;
        for (const row of committed) {
            const exists = checkBranch.get(row.branch);
            if (!exists) {
                // Also check if maybe the branch was resolved by an auth merge
                // (the auth-queue hook should have caught this, but this is a safety net)
                abandonStmt.run(row.id);
                count++;
            }
        }
        return count;
    }
    /**
     * Pass 3: Auto-transition open work units to committed when their branch
     * has commits ahead of the default branch (detected via the branches table).
     */
    reconcileAutoCommit() {
        const db = getDb();
        // Find open work units that have a branch with commits ahead of default
        const openWithBranch = db
            .prepare(`SELECT wu.id, wu.branch FROM work_units wu
         WHERE wu.state = 'open' AND wu.branch IS NOT NULL`)
            .all();
        if (openWithBranch.length === 0)
            return 0;
        const checkAhead = db.prepare("SELECT ahead_default FROM branches WHERE branch = ? AND ahead_default > 0 LIMIT 1");
        const commitStmt = db.prepare("UPDATE work_units SET state = 'committed', activated_at = ? WHERE id = ?");
        const now = Date.now();
        let count = 0;
        for (const row of openWithBranch) {
            const ahead = checkAhead.get(row.branch);
            if (ahead) {
                commitStmt.run(now, row.id);
                count++;
            }
        }
        return count;
    }
}
