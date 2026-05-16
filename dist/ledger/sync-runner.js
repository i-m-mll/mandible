import { createLedgerId } from "./ids.js";
import { exportGitBugOutbox } from "./git-bug-exporter.js";
import { importGitBugCheckout } from "./git-bug-importer.js";
export async function runGitBugSync(options) {
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
        const stats = {};
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
        const hasConflicts = (stats.import?.conflicts ?? 0) > 0 ||
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
    }
    catch (error) {
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
export function listLedgerSyncJobs(db, filters = {}) {
    if (filters.adapter && filters.status) {
        return db.prepare(`SELECT * FROM ledger_sync_jobs
       WHERE adapter = ? AND status = ?
       ORDER BY updated_at DESC`).all(filters.adapter, filters.status);
    }
    if (filters.adapter) {
        return db.prepare("SELECT * FROM ledger_sync_jobs WHERE adapter = ? ORDER BY updated_at DESC").all(filters.adapter);
    }
    return db.prepare("SELECT * FROM ledger_sync_jobs ORDER BY updated_at DESC").all();
}
function insertJob(db, job) {
    db.prepare(`INSERT INTO ledger_sync_jobs (
      id, adapter, project_id, checkout_id, root, direction, status,
      attempt_count, next_retry_at, started_at, finished_at, last_error,
      stats_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(job.id, job.adapter, job.project_id, job.checkout_id, job.root, job.direction, job.status, job.attempt_count, job.next_retry_at, job.started_at, job.finished_at, job.last_error, job.stats_json, job.created_at, job.updated_at);
}
function updateJob(db, id, patch) {
    const current = getJob(db, id);
    db.prepare(`UPDATE ledger_sync_jobs
     SET status = ?, next_retry_at = ?, finished_at = ?, last_error = ?,
         stats_json = ?, updated_at = ?
     WHERE id = ?`).run(patch.status ?? current.status, "next_retry_at" in patch ? patch.next_retry_at ?? null : current.next_retry_at, "finished_at" in patch ? patch.finished_at ?? null : current.finished_at, "last_error" in patch ? patch.last_error ?? null : current.last_error, patch.stats_json ?? current.stats_json, Date.now(), id);
}
function getJob(db, id) {
    const row = db.prepare("SELECT * FROM ledger_sync_jobs WHERE id = ?").get(id);
    if (!row)
        throw new Error(`Ledger sync job not found: ${id}`);
    return row;
}
