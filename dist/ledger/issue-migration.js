import { createHash } from "node:crypto";
import { createLedgerId } from "./ids.js";
import { LedgerStore } from "./store.js";
export function getLedgerIssueMigrationConfig(db) {
    const values = getSettings(db, [
        "ledger.issues.read_mode",
        "ledger.issues.write_mode",
        "ledger.issues.shadow_report_enabled",
        "ledger.issues.fallback_on_ledger_error",
    ]);
    return {
        read_mode: parseReadMode(values["ledger.issues.read_mode"]),
        write_mode: parseWriteMode(values["ledger.issues.write_mode"]),
        shadow_report_enabled: parseBool(values["ledger.issues.shadow_report_enabled"], true),
        fallback_on_ledger_error: parseBool(values["ledger.issues.fallback_on_ledger_error"], true),
    };
}
export function updateLedgerIssueMigrationConfig(db, patch) {
    const now = Date.now();
    const updates = [];
    if (patch.read_mode !== undefined)
        updates.push(["ledger.issues.read_mode", patch.read_mode]);
    if (patch.write_mode !== undefined)
        updates.push(["ledger.issues.write_mode", patch.write_mode]);
    if (patch.shadow_report_enabled !== undefined) {
        updates.push(["ledger.issues.shadow_report_enabled", String(patch.shadow_report_enabled)]);
    }
    if (patch.fallback_on_ledger_error !== undefined) {
        updates.push(["ledger.issues.fallback_on_ledger_error", String(patch.fallback_on_ledger_error)]);
    }
    const stmt = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    for (const [key, value] of updates) {
        stmt.run(key, value, now);
    }
    return getLedgerIssueMigrationConfig(db);
}
export function listLedgerIssueSummaries(db, workScanner) {
    const checkouts = listCheckouts(db, workScanner.getRepos());
    const store = new LedgerStore(db);
    const summaries = [];
    for (const checkout of checkouts) {
        const issues = store
            .listIssues({ project_id: checkout.project_id })
            .map((issue) => ledgerIssueToLegacyIssue(db, checkout, store.getIssueDetail(issue.id)));
        if (issues.length === 0)
            continue;
        summaries.push({
            repo_id: checkout.repo_id,
            repo_name: checkout.repo_name,
            repo_root: checkout.repo_root,
            open_count: issues.filter((issue) => issue.status === "open").length,
            merged_count: issues.filter((issue) => issue.status === "closed" && issue.labels.includes("merged")).length,
            closed_count: issues.filter((issue) => issue.status === "closed" && !issue.labels.includes("merged")).length,
            issues,
        });
    }
    return summaries.sort((a, b) => a.repo_name.localeCompare(b.repo_name));
}
export function findLedgerIssueAcrossRepos(db, workScanner, issueRef) {
    const checkouts = listCheckouts(db, workScanner.getRepos());
    const store = new LedgerStore(db);
    const matches = [];
    for (const checkout of checkouts) {
        const resolved = store.resolveIssueRef(issueRef, { project_id: checkout.project_id });
        if (resolved.ok) {
            matches.push(ledgerIssueToLegacyDetail(db, checkout, store.getIssueDetail(resolved.id)));
        }
        else if (resolved.error === "ambiguous") {
            return { ok: false, status: 409, error: "ambiguous issue reference" };
        }
    }
    if (matches.length === 1)
        return { ok: true, detail: matches[0] };
    if (matches.length > 1)
        return { ok: false, status: 409, error: "ambiguous issue reference" };
    return { ok: false, status: 404, error: "issue not found in ledger" };
}
export function getLedgerIssueDetailForRoute(db, workScanner, repoRef, issueRef) {
    const checkout = resolveCheckout(db, workScanner, repoRef);
    if (!checkout)
        return { ok: false, status: 404, error: "repo not found in ledger" };
    const store = new LedgerStore(db);
    const resolved = store.resolveIssueRef(issueRef, { project_id: checkout.project_id });
    if (!resolved.ok)
        return resolveError(resolved);
    return { ok: true, detail: ledgerIssueToLegacyDetail(db, checkout, store.getIssueDetail(resolved.id)) };
}
export function resolveLedgerIssueIdForRoute(db, workScanner, repoRef, issueRef) {
    const checkout = resolveCheckout(db, workScanner, repoRef);
    if (!checkout)
        return { ok: false, status: 404, error: "repo not found in ledger" };
    const resolved = new LedgerStore(db).resolveIssueRef(issueRef, { project_id: checkout.project_id });
    if (!resolved.ok)
        return resolveError(resolved);
    return { ok: true, issue_id: resolved.id, project_id: checkout.project_id, repo_id: checkout.repo_id };
}
export function reconcileIssueSummaries(scannerSummaries, ledgerSummaries, readMode = "shadow") {
    const started = Date.now();
    const mismatches = [];
    const scannerIssues = flattenIssues(scannerSummaries);
    const ledgerIssues = flattenIssues(ledgerSummaries);
    for (const [key, scannerIssue] of scannerIssues) {
        const ledgerIssue = ledgerIssues.get(key);
        if (!ledgerIssue) {
            mismatches.push({
                repo_id: scannerIssue.repo_id,
                issue_ref: scannerIssue.id,
                mismatch_type: "missing_in_ledger",
                scanner_value: summarizeIssue(scannerIssue),
                ledger_value: null,
            });
            continue;
        }
        compareIssues(scannerIssue, ledgerIssue, mismatches);
    }
    for (const [key, ledgerIssue] of ledgerIssues) {
        if (scannerIssues.has(key))
            continue;
        mismatches.push({
            repo_id: ledgerIssue.repo_id,
            issue_ref: ledgerIssue.id,
            mismatch_type: "extra_in_ledger",
            scanner_value: null,
            ledger_value: summarizeIssue(ledgerIssue),
        });
    }
    const scannerCounts = countIssues(scannerSummaries);
    const ledgerCounts = countIssues(ledgerSummaries);
    return {
        id: createLedgerId("rec", { now: started }),
        read_mode: readMode,
        status: mismatches.length === 0 ? "clean" : "mismatch",
        scanner_issue_count: scannerCounts.total,
        ledger_issue_count: ledgerCounts.total,
        scanner_open_count: scannerCounts.open,
        ledger_open_count: ledgerCounts.open,
        scanner_closed_count: scannerCounts.closed,
        ledger_closed_count: ledgerCounts.closed,
        mismatch_count: mismatches.length,
        summary: {
            repos: Array.from(new Set([...scannerSummaries, ...ledgerSummaries].map((summary) => summary.repo_id))).length,
        },
        error: null,
        started_at: started,
        finished_at: Date.now(),
        mismatches,
    };
}
export function runIssueReconciliation(db, issueScanner, workScanner, readMode = "shadow") {
    try {
        const report = reconcileIssueSummaries(issueScanner.getRepoSummaries(), listLedgerIssueSummaries(db, workScanner), readMode);
        persistReconciliationReport(db, report);
        return report;
    }
    catch (error) {
        const now = Date.now();
        const report = {
            id: createLedgerId("rec", { now }),
            read_mode: readMode,
            status: "failed",
            scanner_issue_count: 0,
            ledger_issue_count: 0,
            scanner_open_count: 0,
            ledger_open_count: 0,
            scanner_closed_count: 0,
            ledger_closed_count: 0,
            mismatch_count: 0,
            summary: {},
            error: error instanceof Error ? error.message : String(error),
            started_at: now,
            finished_at: Date.now(),
            mismatches: [],
        };
        persistReconciliationReport(db, report);
        return report;
    }
}
export function listReconciliationReports(db, limit = 20) {
    const rows = db.prepare(`SELECT * FROM ledger_reconciliation_reports
     ORDER BY COALESCE(finished_at, started_at) DESC
     LIMIT ?`).all(limit);
    return rows.map((row) => hydrateReport(db, row));
}
export function getReconciliationReport(db, id) {
    const row = db.prepare("SELECT * FROM ledger_reconciliation_reports WHERE id = ?").get(id);
    return row ? hydrateReport(db, row) : null;
}
export function parseMigrationConfigPatch(body) {
    const patch = {};
    if (!body)
        return patch;
    if (isReadMode(body.read_mode))
        patch.read_mode = body.read_mode;
    if (isWriteMode(body.write_mode))
        patch.write_mode = body.write_mode;
    if (typeof body.shadow_report_enabled === "boolean")
        patch.shadow_report_enabled = body.shadow_report_enabled;
    if (typeof body.fallback_on_ledger_error === "boolean") {
        patch.fallback_on_ledger_error = body.fallback_on_ledger_error;
    }
    return patch;
}
export function isLedgerWriteModeEnabled(config) {
    return config.write_mode === "dual" || config.write_mode === "ledger";
}
function getSettings(db, keys) {
    const out = {};
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    for (const key of keys) {
        const row = stmt.get(key);
        out[key] = row?.value;
    }
    return out;
}
function parseReadMode(value) {
    return isReadMode(value) ? value : "scanner";
}
function parseWriteMode(value) {
    return isWriteMode(value) ? value : "git_bug";
}
function isReadMode(value) {
    return value === "scanner" || value === "shadow" || value === "ledger";
}
function isWriteMode(value) {
    return value === "git_bug" || value === "dual" || value === "ledger";
}
function parseBool(value, fallback) {
    if (value === "true" || value === true)
        return true;
    if (value === "false" || value === false)
        return false;
    return fallback;
}
function listCheckouts(db, repos) {
    const repoById = new Map(repos.map((repo) => [repo.id, repo]));
    const repoByRoot = new Map(repos.map((repo) => [repo.root, repo]));
    const rows = db.prepare(`SELECT c.id AS checkout_id, c.project_id, c.work_repo_id, c.root, c.name, p.display_name
     FROM ledger_project_checkouts c
     JOIN ledger_projects p ON p.id = c.project_id
     ORDER BY c.name, c.root`).all();
    return rows.map((row) => {
        const repo = (row.work_repo_id ? repoById.get(row.work_repo_id) : undefined) ?? repoByRoot.get(row.root);
        return {
            project_id: row.project_id,
            checkout_id: row.checkout_id,
            repo_id: repo?.id ?? row.work_repo_id ?? row.project_id,
            repo_name: repo?.name ?? row.name ?? row.display_name,
            repo_root: repo?.root ?? row.root,
        };
    });
}
function resolveCheckout(db, workScanner, repoRef) {
    const repo = workScanner.getRepoById(repoRef);
    const checkouts = listCheckouts(db, workScanner.getRepos());
    return checkouts.find((checkout) => checkout.repo_id === repoRef ||
        checkout.repo_name === repoRef ||
        checkout.repo_root === repoRef ||
        checkout.project_id === repoRef ||
        (repo && checkout.repo_id === repo.id)) ?? null;
}
function ledgerIssueToLegacyIssue(db, checkout, detail) {
    const labels = detail.labels
        .filter((label) => label.deleted_at === null)
        .map((label) => label.label)
        .sort();
    return {
        id: displayIssueId(detail),
        repo_id: checkout.repo_id,
        repo_name: checkout.repo_name,
        title: detail.title,
        status: detail.status,
        labels,
        author: detail.author_display,
        created_at: new Date(detail.created_at).toISOString(),
        description: detail.body,
        parent_id: parentRef(db, detail, labels),
    };
}
function ledgerIssueToLegacyDetail(db, checkout, detail) {
    return {
        ...ledgerIssueToLegacyIssue(db, checkout, detail),
        comments: detail.comments
            .filter((comment) => comment.deleted_at === null)
            .map((comment) => ({
            id: comment.id,
            author: comment.author_display,
            date: new Date(comment.created_at).toISOString(),
            body: comment.body,
        })),
    };
}
function displayIssueId(detail) {
    return detail.aliases.find((alias) => alias.is_primary === 1 && alias.alias_kind !== "canonical")?.alias
        ?? detail.aliases.find((alias) => alias.alias_kind === "git_bug_human")?.alias
        ?? detail.aliases.find((alias) => alias.alias_kind !== "canonical")?.alias
        ?? detail.id;
}
function parentRef(db, detail, labels) {
    const legacy = labels.find((label) => label.startsWith("parent:"))?.slice("parent:".length);
    if (legacy)
        return legacy;
    const parent = detail.incoming_relationships.find((rel) => rel.relationship_type === "parent_child" && rel.deleted_at === null);
    if (!parent)
        return undefined;
    const row = db.prepare(`SELECT alias FROM ledger_issue_aliases
     WHERE issue_id = ? AND project_id = ?
     ORDER BY is_primary DESC, alias_kind
     LIMIT 1`).get(parent.source_issue_id, detail.project_id);
    return row?.alias ?? parent.source_issue_id;
}
function resolveError(resolved) {
    if (resolved.error === "ambiguous") {
        return { ok: false, status: 409, error: "ambiguous issue reference" };
    }
    return { ok: false, status: 404, error: "issue not found in ledger" };
}
function flattenIssues(summaries) {
    const out = new Map();
    for (const summary of summaries) {
        for (const issue of summary.issues) {
            out.set(issueKey(summary.repo_id, issue.id), { ...issue, repo_id: summary.repo_id, repo_name: summary.repo_name });
        }
    }
    return out;
}
function compareIssues(scanner, ledger, mismatches) {
    const base = { repo_id: scanner.repo_id, issue_ref: scanner.id };
    const scannerHasComments = "comments" in scanner;
    const ledgerHasComments = "comments" in ledger;
    const hasDetailedBody = scannerHasComments || ledgerHasComments || scanner.description.trim().length > 0;
    if (scanner.title !== ledger.title) {
        mismatches.push({ ...base, mismatch_type: "title_mismatch", scanner_value: scanner.title, ledger_value: ledger.title });
    }
    if (scanner.status !== ledger.status) {
        mismatches.push({ ...base, mismatch_type: "status_mismatch", scanner_value: scanner.status, ledger_value: ledger.status });
    }
    if (hasDetailedBody && hashText(scanner.description) !== hashText(ledger.description)) {
        mismatches.push({
            ...base,
            mismatch_type: "body_hash_mismatch",
            scanner_value: hashText(scanner.description),
            ledger_value: hashText(ledger.description),
        });
    }
    if (setKey(scanner.labels) !== setKey(ledger.labels)) {
        mismatches.push({
            ...base,
            mismatch_type: "label_set_mismatch",
            scanner_value: scanner.labels.slice().sort(),
            ledger_value: ledger.labels.slice().sort(),
        });
    }
    if ((scanner.parent_id ?? "") !== (ledger.parent_id ?? "")) {
        mismatches.push({
            ...base,
            mismatch_type: "parent_child_mismatch",
            scanner_value: scanner.parent_id ?? null,
            ledger_value: ledger.parent_id ?? null,
        });
    }
    if (!scannerHasComments && !ledgerHasComments) {
        return;
    }
    const scannerComments = scannerHasComments ? scanner.comments : [];
    const ledgerComments = ledgerHasComments ? ledger.comments : [];
    if (scannerComments.length !== ledgerComments.length) {
        mismatches.push({
            ...base,
            mismatch_type: "comment_count_mismatch",
            scanner_value: scannerComments.length,
            ledger_value: ledgerComments.length,
        });
    }
    else if (hashComments(scannerComments) !== hashComments(ledgerComments)) {
        mismatches.push({
            ...base,
            mismatch_type: "comment_hash_mismatch",
            scanner_value: hashComments(scannerComments),
            ledger_value: hashComments(ledgerComments),
        });
    }
}
function countIssues(summaries) {
    let total = 0;
    let open = 0;
    let closed = 0;
    for (const summary of summaries) {
        for (const issue of summary.issues) {
            total++;
            if (issue.status === "open")
                open++;
            if (issue.status === "closed")
                closed++;
        }
    }
    return { total, open, closed };
}
function persistReconciliationReport(db, report) {
    const insertReport = db.prepare(`INSERT INTO ledger_reconciliation_reports (
      id, read_mode, status, scanner_issue_count, ledger_issue_count,
      scanner_open_count, ledger_open_count, scanner_closed_count, ledger_closed_count,
      mismatch_count, summary_json, error, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMismatch = db.prepare(`INSERT INTO ledger_reconciliation_mismatches (
      id, report_id, project_id, repo_id, issue_ref, mismatch_type,
      scanner_value_json, ledger_value_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const apply = db.transaction(() => {
        insertReport.run(report.id, report.read_mode, report.status, report.scanner_issue_count, report.ledger_issue_count, report.scanner_open_count, report.ledger_open_count, report.scanner_closed_count, report.ledger_closed_count, report.mismatch_count, JSON.stringify(report.summary), report.error, report.started_at, report.finished_at);
        report.mismatches.forEach((mismatch, index) => {
            insertMismatch.run(mismatch.id ?? createLedgerId("mis", { now: report.started_at + index }), report.id, mismatch.project_id ?? "", mismatch.repo_id, mismatch.issue_ref, mismatch.mismatch_type, JSON.stringify(mismatch.scanner_value ?? null), JSON.stringify(mismatch.ledger_value ?? null), JSON.stringify(mismatch.metadata ?? {}), report.finished_at ?? Date.now());
        });
    });
    apply();
}
function hydrateReport(db, row) {
    const mismatchRows = db.prepare("SELECT * FROM ledger_reconciliation_mismatches WHERE report_id = ? ORDER BY created_at, id").all(row.id);
    return {
        id: row.id,
        read_mode: row.read_mode,
        status: row.status,
        scanner_issue_count: row.scanner_issue_count,
        ledger_issue_count: row.ledger_issue_count,
        scanner_open_count: row.scanner_open_count,
        ledger_open_count: row.ledger_open_count,
        scanner_closed_count: row.scanner_closed_count,
        ledger_closed_count: row.ledger_closed_count,
        mismatch_count: row.mismatch_count,
        summary: parseJsonRecord(row.summary_json),
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
        mismatches: mismatchRows.map((mismatch) => ({
            id: mismatch.id,
            project_id: mismatch.project_id || undefined,
            repo_id: mismatch.repo_id,
            issue_ref: mismatch.issue_ref,
            mismatch_type: mismatch.mismatch_type,
            scanner_value: parseJson(mismatch.scanner_value_json),
            ledger_value: parseJson(mismatch.ledger_value_json),
            metadata: parseJsonRecord(mismatch.metadata_json),
        })),
    };
}
function summarizeIssue(issue) {
    return {
        id: issue.id,
        title: issue.title,
        status: issue.status,
        labels: issue.labels.slice().sort(),
    };
}
function issueKey(repoId, issueId) {
    return `${repoId}\0${issueId}`;
}
function setKey(values) {
    return Array.from(new Set(values)).sort().join("\0");
}
function hashText(value) {
    return createHash("sha256").update(value ?? "").digest("hex");
}
function hashComments(comments) {
    return hashText(comments.map((comment) => `${comment.author}\0${comment.body}`).join("\0"));
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function parseJsonRecord(value) {
    const parsed = parseJson(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
}
