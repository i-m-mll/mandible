import { createLedgerId } from "./ids.js";
import { LedgerStore } from "./store.js";
export function ledgerOperationalLinksAvailable(db) {
    return tableExists(db, "ledger_issues") && tableExists(db, "ledger_work_unit_issue_links");
}
export function resolveOperationalIssueRef(db, issueRef, repoRef) {
    if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_issue_aliases")) {
        return { ok: false, error: "unavailable" };
    }
    const trimmed = issueRef.trim();
    if (!trimmed)
        return { ok: false, error: "not_found" };
    const store = new LedgerStore(db);
    const projectIds = candidateProjectIds(db, repoRef);
    if (projectIds.length === 0) {
        return withProject(db, store.resolveIssueRef(trimmed));
    }
    const matches = new Set();
    for (const projectId of projectIds) {
        const resolved = store.resolveIssueRef(trimmed, { project_id: projectId });
        if (resolved.ok) {
            matches.add(resolved.id);
        }
        else if (resolved.error === "ambiguous") {
            for (const match of resolved.matches)
                matches.add(match);
        }
    }
    if (matches.size === 0)
        return { ok: false, error: "not_found" };
    if (matches.size > 1) {
        return { ok: false, error: "ambiguous", matches: Array.from(matches).sort() };
    }
    return withProject(db, { ok: true, id: Array.from(matches)[0] });
}
export function linkWorkUnitToLedgerIssue(db, input) {
    if (!ledgerOperationalLinksAvailable(db)) {
        return { ok: false, error: "unavailable", source_table: "work_units", source_id: input.work_unit_id };
    }
    const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
    if (!resolved.ok) {
        return linkError("work_units", input.work_unit_id, input.issue_ref, input.repo_ref, resolved);
    }
    const now = input.now ?? Date.now();
    const linkType = input.link_type ?? "work_unit_tracks";
    const metadata = {
        legacy_issue_id: input.issue_ref,
        repo_id: input.repo_ref,
        ...(input.metadata ?? {}),
    };
    db.transaction(() => {
        db.prepare("UPDATE work_units SET ledger_issue_id = ? WHERE id = ?").run(resolved.issue_id, input.work_unit_id);
        db.prepare(`INSERT INTO ledger_work_unit_issue_links (
        work_unit_id, issue_id, link_type, source, created_at, last_seen_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_unit_id, issue_id, link_type) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json`).run(input.work_unit_id, resolved.issue_id, linkType, input.source ?? "work_unit", now, now, JSON.stringify(metadata));
    })();
    maybeRecordLinkEvent(db, input.recordEvent, {
        entity_type: "work_unit",
        entity_id: input.work_unit_id,
        event_type: "work_unit.issue_linked",
        source: "work_unit",
        project_id: resolved.project_id,
        payload: { work_unit_id: input.work_unit_id, issue_id: resolved.issue_id, link_type: linkType },
    });
    return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}
export function linkSessionToLedgerIssue(db, input) {
    if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_session_issue_links")) {
        return { ok: false, error: "unavailable", source_table: "session_issues", source_id: input.session_id };
    }
    const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
    if (!resolved.ok) {
        return linkError("session_issues", input.session_id, input.issue_ref, input.repo_ref, resolved);
    }
    const now = input.now ?? Date.now();
    const linkType = input.link_type ?? "worked_on";
    db.prepare(`INSERT INTO ledger_session_issue_links (
      session_id, issue_id, link_type, source, created_at, last_seen_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, issue_id, link_type) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      metadata_json = excluded.metadata_json`).run(input.session_id, resolved.issue_id, linkType, input.source ?? "session", now, now, JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref, ...(input.metadata ?? {}) }));
    maybeRecordLinkEvent(db, input.recordEvent, {
        entity_type: "session",
        entity_id: input.session_id,
        event_type: "session.issue_linked",
        source: "session",
        project_id: resolved.project_id,
        payload: { session_id: input.session_id, issue_id: resolved.issue_id, link_type: linkType },
    });
    return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}
export function linkAuthRequestToLedgerIssue(db, input) {
    if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_auth_issue_links")) {
        return { ok: false, error: "unavailable", source_table: "auth_requests", source_id: input.auth_request_id };
    }
    const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
    if (!resolved.ok) {
        return linkError("auth_requests", input.auth_request_id, input.issue_ref, input.repo_ref ?? "", resolved);
    }
    const now = input.now ?? Date.now();
    const linkType = input.link_type ?? "references";
    db.prepare(`INSERT INTO ledger_auth_issue_links (
      auth_request_id, issue_id, link_type, source, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(auth_request_id, issue_id, link_type) DO UPDATE SET
      metadata_json = excluded.metadata_json`).run(input.auth_request_id, resolved.issue_id, linkType, input.source ?? "auth_queue", now, JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref ?? "", ...(input.metadata ?? {}) }));
    maybeRecordLinkEvent(db, input.recordEvent, {
        entity_type: "auth_request",
        entity_id: input.auth_request_id,
        event_type: "auth_request.issue_linked",
        source: "auth_queue",
        project_id: resolved.project_id,
        payload: { auth_request_id: input.auth_request_id, issue_id: resolved.issue_id, link_type: linkType },
    });
    return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}
export function linkCommitToLedgerIssue(db, input) {
    if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_commit_issue_links")) {
        return { ok: false, error: "unavailable", source_table: "issue_resolutions", source_id: input.commit_sha };
    }
    const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
    if (!resolved.ok) {
        return linkError("issue_resolutions", input.commit_sha, input.issue_ref, input.repo_ref, resolved);
    }
    const now = input.now ?? Date.now();
    const linkType = input.link_type ?? "fixed_by";
    db.prepare(`INSERT INTO ledger_commit_issue_links (
      commit_sha, project_id, issue_id, link_type, source, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(commit_sha, issue_id, link_type) DO UPDATE SET
      metadata_json = excluded.metadata_json`).run(input.commit_sha, resolved.project_id, resolved.issue_id, linkType, input.source ?? "auth_queue", now, JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref, ...(input.metadata ?? {}) }));
    maybeRecordLinkEvent(db, input.recordEvent, {
        entity_type: "commit",
        entity_id: input.commit_sha,
        event_type: "commit.issue_linked",
        source: "auth_queue",
        project_id: resolved.project_id,
        payload: { commit_sha: input.commit_sha, issue_id: resolved.issue_id, link_type: linkType },
    });
    return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}
export function syncAuthRequestLedgerLinks(db, input) {
    const refs = new Map();
    for (const ref of input.issue_ids ?? [])
        refs.set(ref, "references");
    for (const ref of extractIssueRefsFromCommitMessage(input.commit_message))
        refs.set(ref, "references");
    for (const ref of input.issue_references ?? [])
        refs.set(ref, "references");
    for (const ref of input.issue_closures ?? [])
        refs.set(ref, "resolves");
    // Legacy issues were documented as close-on-merge; preserve that meaning.
    for (const ref of input.issues ?? [])
        refs.set(ref, "resolves");
    const results = [];
    for (const [ref, linkType] of refs) {
        results.push(linkAuthRequestToLedgerIssue(db, {
            auth_request_id: input.auth_request_id,
            issue_ref: ref,
            repo_ref: input.repo_ref,
            link_type: linkType,
            metadata: { source_fields: sourceFieldsForAuthRef(ref, input) },
            recordEvent: input.recordEvent,
        }));
    }
    return results;
}
export function applyAuthRequestLedgerCompletion(db, input) {
    const results = syncAuthRequestLedgerLinks(db, { ...input, recordEvent: true });
    if (!ledgerOperationalLinksAvailable(db))
        return results;
    const store = new LedgerStore(db);
    const linked = db.prepare(`SELECT issue_id, link_type FROM ledger_auth_issue_links
     WHERE auth_request_id = ? AND link_type IN ('resolves', 'fixed_by')`).all(input.auth_request_id);
    const uniqueIssueIds = Array.from(new Set(linked.map((row) => row.issue_id)));
    for (const issueId of uniqueIssueIds) {
        const issue = store.getIssue(issueId);
        store.recordEvent({
            entity_type: "auth_request",
            entity_id: input.auth_request_id,
            event_type: "auth_request.completed",
            actor_type: "system",
            source: "auth_queue",
            project_id: issue.project_id,
            enqueueOutbox: false,
            payload: {
                auth_request_id: input.auth_request_id,
                issue_id: issueId,
                approval_source: input.approval_source ?? null,
                approval_lease_id: input.approval_lease_id ?? null,
            },
        });
        store.setIssueStatus(issueId, "closed", input.resolution ?? "merged", { actor_type: "system", actor_id: input.approval_lease_id ?? null }, "auth_queue");
    }
    return results;
}
export function runOperationalLinkBackfill(db) {
    const started = Date.now();
    const report = {
        id: createLedgerId("opb", { now: started }),
        status: "clean",
        resolved_count: 0,
        unresolved_count: 0,
        ambiguous_count: 0,
        source_counts: {},
        error: null,
        started_at: started,
        finished_at: null,
        mismatches: [],
    };
    try {
        backfillWorkUnits(db, report);
        backfillSessions(db, report);
        backfillAuthRequests(db, report);
        backfillCommitResolutions(db, report);
        report.status = report.mismatches.length === 0 ? "clean" : "incomplete";
        report.finished_at = Date.now();
        persistOperationalLinkReport(db, report);
        return report;
    }
    catch (error) {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
        report.finished_at = Date.now();
        persistOperationalLinkReport(db, report);
        return report;
    }
}
export function listOperationalLinkReports(db, limit = 20) {
    if (!tableExists(db, "ledger_operational_link_reports"))
        return [];
    const rows = db.prepare("SELECT * FROM ledger_operational_link_reports ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?").all(limit);
    return rows.map((row) => hydrateOperationalLinkReport(db, row));
}
function backfillWorkUnits(db, report) {
    if (!tableExists(db, "work_units"))
        return;
    const rows = db.prepare("SELECT id, issue_id, repo_id FROM work_units").all();
    report.source_counts.work_units = rows.length;
    for (const row of rows) {
        const result = linkWorkUnitToLedgerIssue(db, {
            work_unit_id: row.id,
            issue_ref: row.issue_id,
            repo_ref: row.repo_id,
            source: "system",
            recordEvent: false,
        });
        tally(report, result, "work_units", row.id, row.issue_id, row.repo_id);
    }
}
function backfillSessions(db, report) {
    if (!tableExists(db, "session_issues"))
        return;
    const rows = db.prepare("SELECT session_id, issue_id, repo_id, created_at FROM session_issues").all();
    report.source_counts.session_issues = rows.length;
    for (const row of rows) {
        const result = linkSessionToLedgerIssue(db, {
            session_id: row.session_id,
            issue_ref: row.issue_id,
            repo_ref: row.repo_id,
            source: "system",
            now: row.created_at,
            recordEvent: false,
        });
        tally(report, result, "session_issues", row.session_id, row.issue_id, row.repo_id);
    }
}
function backfillAuthRequests(db, report) {
    if (!tableExists(db, "auth_requests"))
        return;
    const rows = db.prepare(`SELECT id, repo, cwd, target_repo_root, issue_references, issue_closures,
            issue_ids, issues, commit_message
     FROM auth_requests`).all();
    report.source_counts.auth_requests = rows.length;
    for (const row of rows) {
        const repoRef = stringOrNull(row.repo) ?? stringOrNull(row.cwd) ?? stringOrNull(row.target_repo_root);
        const results = syncAuthRequestLedgerLinks(db, {
            auth_request_id: String(row.id),
            repo_ref: repoRef,
            issue_references: parseStringArray(row.issue_references),
            issue_closures: parseStringArray(row.issue_closures),
            issue_ids: parseStringArray(row.issue_ids),
            issues: parseStringArray(row.issues),
            commit_message: stringOrNull(row.commit_message),
            recordEvent: false,
        });
        if (results.length === 0)
            continue;
        for (const result of results) {
            tally(report, result, "auth_requests", String(row.id), result.issue_ref ?? "", repoRef ?? "");
        }
    }
}
function backfillCommitResolutions(db, report) {
    if (!tableExists(db, "issue_resolutions"))
        return;
    const rows = db.prepare("SELECT issue_id, commit_sha, repo_id, resolved_at FROM issue_resolutions").all();
    report.source_counts.issue_resolutions = rows.length;
    for (const row of rows) {
        const result = linkCommitToLedgerIssue(db, {
            commit_sha: row.commit_sha,
            issue_ref: row.issue_id,
            repo_ref: row.repo_id,
            source: "system",
            now: row.resolved_at,
            recordEvent: false,
        });
        tally(report, result, "issue_resolutions", row.commit_sha, row.issue_id, row.repo_id);
    }
}
function tally(report, result, sourceTable, sourceId, issueRef, repoId) {
    if (result.ok) {
        report.resolved_count++;
        return;
    }
    if (result.error === "ambiguous") {
        report.ambiguous_count++;
    }
    else {
        report.unresolved_count++;
    }
    report.mismatches.push({
        source_table: sourceTable,
        source_id: sourceId,
        repo_id: repoId,
        issue_ref: issueRef,
        mismatch_type: result.error,
        metadata: { matches: result.matches ?? [] },
    });
}
function persistOperationalLinkReport(db, report) {
    if (!tableExists(db, "ledger_operational_link_reports"))
        return;
    const insertReport = db.prepare(`INSERT INTO ledger_operational_link_reports (
      id, status, resolved_count, unresolved_count, ambiguous_count,
      source_counts_json, error, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMismatch = db.prepare(`INSERT INTO ledger_operational_link_mismatches (
      id, report_id, source_table, source_id, repo_id, issue_ref,
      mismatch_type, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        insertReport.run(report.id, report.status, report.resolved_count, report.unresolved_count, report.ambiguous_count, JSON.stringify(report.source_counts), report.error, report.started_at, report.finished_at);
        report.mismatches.forEach((mismatch, index) => {
            insertMismatch.run(mismatch.id ?? createLedgerId("opm", { now: report.started_at + index }), report.id, mismatch.source_table, mismatch.source_id, mismatch.repo_id, mismatch.issue_ref, mismatch.mismatch_type, JSON.stringify(mismatch.metadata ?? {}), report.finished_at ?? Date.now());
        });
    })();
}
function hydrateOperationalLinkReport(db, row) {
    const mismatches = db.prepare("SELECT * FROM ledger_operational_link_mismatches WHERE report_id = ? ORDER BY created_at, id").all(row.id);
    return {
        id: row.id,
        status: row.status,
        resolved_count: row.resolved_count,
        unresolved_count: row.unresolved_count,
        ambiguous_count: row.ambiguous_count,
        source_counts: parseJsonNumberRecord(row.source_counts_json),
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
        mismatches: mismatches.map((mismatch) => ({
            id: mismatch.id,
            source_table: mismatch.source_table,
            source_id: mismatch.source_id,
            repo_id: mismatch.repo_id,
            issue_ref: mismatch.issue_ref,
            mismatch_type: mismatch.mismatch_type,
            metadata: parseJsonObject(mismatch.metadata_json),
        })),
    };
}
function withProject(db, resolved) {
    if (!resolved.ok) {
        return resolved.error === "ambiguous"
            ? { ok: false, error: "ambiguous", matches: resolved.matches }
            : { ok: false, error: "not_found" };
    }
    const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?").get(resolved.id);
    return row ? { ok: true, issue_id: resolved.id, project_id: row.project_id } : { ok: false, error: "not_found" };
}
function linkError(sourceTable, sourceId, issueRef, repoId, error) {
    return {
        ...error,
        source_table: sourceTable,
        source_id: sourceId,
        issue_ref: issueRef,
        repo_id: repoId,
    };
}
function maybeRecordLinkEvent(db, recordEvent, input) {
    if (recordEvent === false)
        return;
    new LedgerStore(db).recordEvent({
        ...input,
        actor_type: "system",
        enqueueOutbox: false,
    });
}
function candidateProjectIds(db, repoRef) {
    const trimmed = repoRef?.trim();
    if (!trimmed || !tableExists(db, "ledger_project_checkouts"))
        return [];
    const ids = new Set();
    const checkoutRows = db.prepare(`SELECT project_id FROM ledger_project_checkouts
     WHERE work_repo_id = ? OR root = ? OR name = ? OR project_id = ?`).all(trimmed, trimmed, trimmed, trimmed);
    for (const row of checkoutRows)
        ids.add(row.project_id);
    const projectRows = db.prepare(`SELECT id FROM ledger_projects
     WHERE id = ? OR display_name = ? OR remote_identity = ? OR upstream_identity = ?`).all(trimmed, trimmed, trimmed, trimmed);
    for (const row of projectRows)
        ids.add(row.id);
    return Array.from(ids).sort();
}
function sourceFieldsForAuthRef(ref, input) {
    const fields = [];
    if ((input.issue_references ?? []).includes(ref))
        fields.push("issue_references");
    if ((input.issue_closures ?? []).includes(ref))
        fields.push("issue_closures");
    if ((input.issue_ids ?? []).includes(ref))
        fields.push("issue_ids");
    if ((input.issues ?? []).includes(ref))
        fields.push("issues");
    if (extractIssueRefsFromCommitMessage(input.commit_message).includes(ref))
        fields.push("commit_message");
    return fields;
}
function extractIssueRefsFromCommitMessage(commitMessage) {
    if (!commitMessage)
        return [];
    const refs = [];
    const regex = /^Bug:\s+(\S+)/gm;
    let match;
    while ((match = regex.exec(commitMessage)) !== null) {
        refs.push(match[1]);
    }
    return refs;
}
function parseStringArray(value) {
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string");
    }
    if (typeof value !== "string" || !value.trim())
        return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
    }
    catch {
        return null;
    }
}
function stringOrNull(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function tableExists(db, table) {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(row);
}
function parseJsonObject(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function parseJsonNumberRecord(value) {
    const parsed = parseJsonObject(value);
    const record = {};
    for (const [key, item] of Object.entries(parsed)) {
        if (typeof item === "number")
            record[key] = item;
    }
    return record;
}
