import { mapWorkUnitRow } from "../work-unit-utils.js";
import { LedgerStore } from "./store.js";
export function buildLedgerIssueDetailProjection(db, issueId) {
    const store = new LedgerStore(db);
    const detail = store.getIssueDetail(issueId);
    const aliases = detail.aliases.map(mapAlias);
    const labels = activeLabels(detail.labels);
    const comments = detail.comments
        .filter((comment) => comment.deleted_at === null)
        .map((comment) => ({
        id: comment.id,
        ordinal: comment.ordinal,
        body: comment.body,
        author: {
            id: comment.author_actor_id,
            type: comment.author_actor_type,
            display: comment.author_display || actorTypeLabel(comment.author_actor_type),
        },
        source: comment.source,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
    }));
    const relationships = buildRelationships(db, detail);
    const author = {
        id: detail.author_actor_id,
        type: detail.author_actor_type,
        display: detail.author_display || actorTypeLabel(detail.author_actor_type),
    };
    const timeline = buildTimeline(db, detail, comments, author);
    const conflicts = listIssueConflicts(db, detail.id, comments.map((comment) => comment.id), relationships.map((rel) => rel.id));
    const sync = buildSyncSummary(db, detail, comments.map((comment) => comment.id), relationships.map((rel) => rel.id), conflicts.length);
    return {
        id: detail.id,
        display_id: displayIssueId(detail, detail.aliases),
        project: getProjectInfo(db, detail.project_id),
        title: detail.title,
        body: detail.body,
        status: detail.status,
        resolution: detail.resolution,
        kind: detail.kind,
        priority: detail.priority,
        source: detail.source,
        author,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
        closed_at: detail.closed_at,
        aliases,
        labels,
        comments,
        timeline,
        relationships,
        work_units: listWorkUnits(db, detail.id),
        sessions: listSessions(db, detail.id),
        auth_requests: listAuthRequests(db, detail.id),
        conflicts,
        sync,
    };
}
function buildRelationships(db, issue) {
    const rows = [
        ...issue.outgoing_relationships
            .filter((relationship) => relationship.deleted_at === null)
            .map((relationship) => ({ row: relationship, direction: "outgoing", related: relationship.target_issue_id })),
        ...issue.incoming_relationships
            .filter((relationship) => relationship.deleted_at === null)
            .map((relationship) => ({ row: relationship, direction: "incoming", related: relationship.source_issue_id })),
    ];
    return rows.map(({ row, direction, related }) => ({
        id: row.id,
        direction,
        relationship_type: row.relationship_type,
        provenance: row.provenance,
        confidence: row.confidence,
        metadata: parseJsonObject(row.metadata_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
        related_issue: getIssueSummary(db, related),
    }));
}
function buildTimeline(db, issue, comments, issueAuthor) {
    const entries = [{
            id: `${issue.id}:body`,
            kind: "body",
            ordinal: 0,
            body: issue.body,
            author: issueAuthor,
            source: issue.source,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
        }];
    for (const comment of comments) {
        entries.push({
            id: comment.id,
            kind: "comment",
            comment_id: comment.id,
            ordinal: comment.ordinal,
            body: comment.body,
            author: comment.author,
            source: comment.source,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
        });
    }
    const events = db.prepare(`SELECT * FROM ledger_events
     WHERE entity_type = 'issue'
       AND entity_id = ?
       AND event_type IN ('issue.updated', 'issue.closed', 'issue.reopened')
     ORDER BY occurred_at, observed_at`).all(issue.id);
    for (const event of events) {
        const payload = parseJsonObject(event.payload_json);
        const patch = parsePatch(payload);
        const status = lifecycleStatusForEvent(event.event_type)
            ?? (typeof patch.status === "string" ? patch.status : null);
        const resolution = typeof patch.resolution === "string" ? patch.resolution : null;
        if (!status && !("resolution" in patch))
            continue;
        entries.push({
            id: event.id,
            kind: "state",
            event_type: event.event_type,
            status,
            resolution,
            author: {
                id: event.actor_id,
                type: event.actor_type,
                display: actorTypeLabel(event.actor_type),
            },
            source: event.source,
            created_at: event.occurred_at,
            payload,
        });
    }
    return entries.sort((a, b) => {
        if (a.created_at !== b.created_at)
            return a.created_at - b.created_at;
        const order = { body: 0, comment: 1, state: 2 };
        return order[a.kind] - order[b.kind];
    });
}
function parsePatch(payload) {
    const patch = payload.patch;
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
        return patch;
    }
    return payload;
}
function lifecycleStatusForEvent(eventType) {
    if (eventType === "issue.closed")
        return "closed";
    if (eventType === "issue.reopened")
        return "open";
    return null;
}
function listWorkUnits(db, issueId) {
    if (!tableExists(db, "work_units"))
        return [];
    const hasLinks = tableExists(db, "ledger_work_unit_issue_links");
    const rows = hasLinks
        ? db.prepare(`SELECT wu.*, l.link_type, l.source AS link_source,
                l.created_at AS link_created_at, l.last_seen_at,
                l.metadata_json AS link_metadata_json
         FROM work_units wu
         LEFT JOIN ledger_work_unit_issue_links l
           ON l.work_unit_id = wu.id AND l.issue_id = ?
         WHERE wu.ledger_issue_id = ? OR l.issue_id = ?
         ORDER BY wu.created_at DESC`).all(issueId, issueId, issueId)
        : db.prepare(`SELECT wu.*, NULL AS link_type, NULL AS link_source,
                NULL AS link_created_at, NULL AS last_seen_at,
                '{}' AS link_metadata_json
         FROM work_units wu
         WHERE wu.ledger_issue_id = ?
         ORDER BY wu.created_at DESC`).all(issueId);
    const seen = new Set();
    const result = [];
    for (const row of rows) {
        const workUnit = mapWorkUnitRow(row);
        if (!workUnit.id || seen.has(workUnit.id))
            continue;
        seen.add(workUnit.id);
        result.push({
            ...workUnit,
            link_type: stringOr(row.link_type, workUnit.ledger_issue_id === issueId ? "work_unit_tracks" : ""),
            link_source: stringOr(row.link_source, "work_unit"),
            link_created_at: numberOrNull(row.link_created_at),
            last_seen_at: numberOrNull(row.last_seen_at),
            metadata: parseJsonObject(stringOr(row.link_metadata_json, "{}")),
            liveness: computeWorkUnitLiveness(db, workUnit),
        });
    }
    return result;
}
function listSessions(db, issueId) {
    if (!tableExists(db, "ledger_session_issue_links") || !tableExists(db, "sessions"))
        return [];
    const rows = db.prepare(`SELECT l.session_id, l.link_type, l.source AS link_source,
            l.created_at AS link_created_at, l.last_seen_at,
            l.metadata_json AS link_metadata_json,
            s.app, s.parent_id, s.status, s.branch, s.worktree, s.task,
            s.description, s.agent_type, s.created_at, s.updated_at,
            s.ended_at, s.last_active
     FROM ledger_session_issue_links l
     LEFT JOIN sessions s ON s.id = l.session_id
     WHERE l.issue_id = ?
     ORDER BY
       CASE WHEN s.status IN ('active','idle') THEN 0 ELSE 1 END,
       COALESCE(l.last_seen_at, l.created_at) DESC`).all(issueId);
    const conversationSessions = conversationSessionIds(db, rows.map((row) => String(row.session_id ?? "")));
    return rows.map((row) => ({
        id: String(row.session_id ?? ""),
        app: stringOr(row.app, ""),
        parent_id: nullableString(row.parent_id),
        status: stringOr(row.status, "unknown"),
        branch: nullableString(row.branch),
        worktree: nullableString(row.worktree),
        task: nullableString(row.task),
        description: nullableString(row.description),
        agent_type: nullableString(row.agent_type),
        created_at: nullableString(row.created_at),
        updated_at: nullableString(row.updated_at),
        ended_at: nullableString(row.ended_at),
        last_active: nullableString(row.last_active),
        has_conversation: conversationSessions.has(String(row.session_id ?? "")),
        link_type: stringOr(row.link_type, "worked_on"),
        link_source: stringOr(row.link_source, "session"),
        link_created_at: numberOrNull(row.link_created_at),
        last_seen_at: numberOrNull(row.last_seen_at),
        metadata: parseJsonObject(stringOr(row.link_metadata_json, "{}")),
    }));
}
function listAuthRequests(db, issueId) {
    if (!tableExists(db, "ledger_auth_issue_links") || !tableExists(db, "auth_requests"))
        return [];
    return db.prepare(`SELECT l.auth_request_id, l.link_type, l.source AS link_source,
            l.created_at AS link_created_at, l.metadata_json AS link_metadata_json,
            ar.type, ar.title, ar.status, ar.repo, ar.base_branch, ar.head_branch,
            ar.created_at, ar.approved_at, ar.resolved_at, ar.skipped_at,
            ar.exit_code, ar.error
     FROM ledger_auth_issue_links l
     LEFT JOIN auth_requests ar ON ar.id = l.auth_request_id
     WHERE l.issue_id = ?
     ORDER BY ar.created_at DESC, l.created_at DESC`).all(issueId).map((row) => {
        const record = row;
        return {
            id: String(record.auth_request_id ?? ""),
            type: stringOr(record.type, "merge"),
            title: stringOr(record.title, ""),
            status: stringOr(record.status, "unknown"),
            repo: nullableString(record.repo),
            base_branch: nullableString(record.base_branch),
            head_branch: nullableString(record.head_branch),
            created_at: numberOrNull(record.created_at),
            approved_at: numberOrNull(record.approved_at),
            resolved_at: numberOrNull(record.resolved_at),
            skipped_at: numberOrNull(record.skipped_at),
            exit_code: numberOrNull(record.exit_code),
            error: nullableString(record.error),
            link_type: stringOr(record.link_type, "references"),
            link_source: stringOr(record.link_source, "auth_queue"),
            link_created_at: numberOrNull(record.link_created_at),
            metadata: parseJsonObject(stringOr(record.link_metadata_json, "{}")),
        };
    });
}
function listIssueConflicts(db, issueId, commentIds, relationshipIds) {
    if (!tableExists(db, "ledger_conflicts"))
        return [];
    const { sql, params } = entityWhere([
        ["issue", [issueId]],
        ["comment", commentIds],
        ["issue_relationship", relationshipIds],
    ]);
    if (!sql)
        return [];
    return db.prepare(`SELECT * FROM ledger_conflicts
     WHERE status = 'open' AND (${sql})
     ORDER BY created_at DESC`).all(...params).map((row) => mapConflict(row));
}
function buildSyncSummary(db, issue, commentIds, relationshipIds, openConflicts) {
    const outbox = {};
    if (tableExists(db, "ledger_outbox") && tableExists(db, "ledger_events")) {
        const { sql, params } = entityWhere([
            ["issue", [issue.id]],
            ["comment", commentIds],
            ["issue_relationship", relationshipIds],
        ], "e");
        if (sql) {
            const rows = db.prepare(`SELECT o.status, COUNT(*) AS count
         FROM ledger_outbox o
         JOIN ledger_events e ON e.id = o.event_id
         WHERE ${sql}
         GROUP BY o.status`).all(...params);
            for (const row of rows)
                outbox[row.status] = row.count;
        }
    }
    const latest_jobs = tableExists(db, "ledger_sync_jobs")
        ? db.prepare(`SELECT id, adapter, direction, status, attempt_count, started_at,
                finished_at, last_error, updated_at
         FROM ledger_sync_jobs
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT 5`).all(issue.project_id).map((row) => {
            const record = row;
            return {
                id: String(record.id ?? ""),
                adapter: stringOr(record.adapter, ""),
                direction: stringOr(record.direction, ""),
                status: stringOr(record.status, ""),
                attempt_count: Number(record.attempt_count ?? 0),
                started_at: numberOrNull(record.started_at),
                finished_at: numberOrNull(record.finished_at),
                last_error: nullableString(record.last_error),
                updated_at: Number(record.updated_at ?? 0),
            };
        })
        : [];
    const failed = (outbox.failed ?? 0) + (outbox.conflicted ?? 0);
    const pending = (outbox.pending ?? 0) + (outbox.processing ?? 0);
    return {
        state: openConflicts > 0 ? "conflicted" : failed > 0 ? "failed" : pending > 0 ? "pending" : "clean",
        outbox,
        open_conflicts: openConflicts,
        latest_jobs,
    };
}
function getProjectInfo(db, projectId) {
    const project = db.prepare(`SELECT id, display_name, remote_identity, upstream_identity
     FROM ledger_projects
     WHERE id = ?`).get(projectId);
    const checkout = tableExists(db, "ledger_project_checkouts")
        ? db.prepare(`SELECT work_repo_id, name, root, default_branch
         FROM ledger_project_checkouts
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`).get(projectId)
        : undefined;
    return {
        id: project?.id ?? projectId,
        display_name: project?.display_name ?? projectId,
        remote_identity: project?.remote_identity ?? "",
        upstream_identity: project?.upstream_identity ?? "",
        repo_id: checkout?.work_repo_id ?? null,
        repo_name: checkout?.name ?? null,
        repo_root: checkout?.root ?? null,
        default_branch: checkout?.default_branch ?? null,
    };
}
function getIssueSummary(db, issueId) {
    const row = db.prepare(`SELECT id, short_id, project_id, title, status, resolution, kind, priority
     FROM ledger_issues
     WHERE id = ?`).get(issueId);
    if (!row)
        return null;
    const labels = activeLabels(db.prepare("SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label").all(issueId));
    const aliases = db.prepare("SELECT * FROM ledger_issue_aliases WHERE issue_id = ? ORDER BY is_primary DESC, alias_kind, alias").all(issueId);
    return {
        id: row.id,
        display_id: displayIssueId(row, aliases),
        project_id: row.project_id,
        title: row.title,
        status: row.status,
        resolution: row.resolution,
        kind: row.kind,
        priority: row.priority,
        labels,
    };
}
function computeWorkUnitLiveness(db, workUnit) {
    const empty = {
        has_live_agent: false,
        agent_session_id: null,
        agent_status: null,
        is_processing: false,
        last_activity: null,
    };
    if (!workUnit.assigned_session_id || !tableExists(db, "sessions"))
        return empty;
    const row = db.prepare("SELECT status, updated_at, last_active FROM sessions WHERE id = ?").get(workUnit.assigned_session_id);
    if (!row)
        return empty;
    const status = row.status ?? "unknown";
    const lastActive = row.last_active || row.updated_at || null;
    return {
        has_live_agent: status === "active" || status === "idle",
        agent_session_id: workUnit.assigned_session_id,
        agent_status: status,
        is_processing: status === "active",
        last_activity: lastActive ? Date.parse(lastActive) : null,
    };
}
function conversationSessionIds(db, sessionIds) {
    const unique = Array.from(new Set(sessionIds.filter(Boolean)));
    if (unique.length === 0 || !tableExists(db, "conversations"))
        return new Set();
    const placeholders = unique.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT DISTINCT session_id FROM conversations WHERE session_id IN (${placeholders})`).all(...unique);
    return new Set(rows.map((row) => row.session_id));
}
function entityWhere(groups, alias = "") {
    const prefix = alias ? `${alias}.` : "";
    const clauses = [];
    const params = [];
    for (const [entityType, ids] of groups) {
        const unique = Array.from(new Set(ids.filter(Boolean)));
        if (unique.length === 0)
            continue;
        clauses.push(`(${prefix}entity_type = ? AND ${prefix}entity_id IN (${unique.map(() => "?").join(", ")}))`);
        params.push(entityType, ...unique);
    }
    return { sql: clauses.join(" OR "), params };
}
function activeLabels(labels) {
    return labels
        .filter((label) => label.deleted_at === null)
        .map((label) => label.label)
        .sort((a, b) => a.localeCompare(b));
}
function mapAlias(alias) {
    return {
        kind: alias.alias_kind,
        alias: alias.alias,
        external_id: alias.external_id,
        source: alias.source,
        primary: alias.is_primary === 1,
    };
}
function displayIssueId(issue, _aliases) {
    return issue.short_id || issue.id.slice(0, 7);
}
function mapConflict(row) {
    return {
        id: row.id,
        adapter: row.adapter,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        field: row.field,
        local_value: parseJsonValue(row.local_value_json),
        remote_value: parseJsonValue(row.remote_value_json),
        base_value: parseJsonValue(row.base_value_json),
        status: row.status,
        resolution: row.resolution,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
    };
}
function parseJsonObject(value) {
    const parsed = parseJsonValue(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
}
function parseJsonValue(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function tableExists(db, table) {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(row);
}
function stringOr(value, fallback) {
    return typeof value === "string" ? value : fallback;
}
function nullableString(value) {
    return typeof value === "string" ? value : null;
}
function numberOrNull(value) {
    return typeof value === "number" ? value : null;
}
function actorTypeLabel(type) {
    return type.replace(/_/g, " ");
}
