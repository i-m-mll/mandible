import type { Db } from "../db.js";
import { mapWorkUnitRow, type WorkUnitLiveness } from "../work-unit-utils.js";
import type { WorkUnit } from "../types.js";
import { LedgerStore } from "./store.js";
import type {
  LedgerActorType,
  LedgerConflict,
  LedgerEventSource,
  LedgerIssue,
  LedgerIssueAlias,
  LedgerIssueKind,
  LedgerIssueRelationship,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerLabel,
  LedgerPriority,
  LedgerRelationshipProvenance,
  LedgerRelationshipType,
} from "./types.js";

export interface LedgerIssueDetailAlias {
  kind: string;
  alias: string;
  external_id: string;
  source: string;
  primary: boolean;
}

export interface LedgerIssueDetailActor {
  id: string | null;
  type: LedgerActorType;
  display: string;
}

export interface LedgerIssueDetailComment {
  id: string;
  body: string;
  author: LedgerIssueDetailActor;
  source: LedgerEventSource;
  created_at: number;
  updated_at: number | null;
}

export interface LedgerIssueSummaryRef {
  id: string;
  display_id: string;
  project_id: string;
  title: string;
  status: LedgerIssueStatus;
  resolution: LedgerIssueResolution | null;
  kind: LedgerIssueKind;
  priority: LedgerPriority;
  labels: string[];
}

export interface LedgerIssueDetailRelationship {
  id: string;
  direction: "incoming" | "outgoing";
  relationship_type: LedgerRelationshipType;
  provenance: LedgerRelationshipProvenance;
  confidence: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  related_issue: LedgerIssueSummaryRef | null;
}

export interface LedgerIssueDetailProject {
  id: string;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  repo_id: string | null;
  repo_name: string | null;
  repo_root: string | null;
  default_branch: string | null;
}

export interface LedgerIssueDetailWorkUnit extends WorkUnit {
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  last_seen_at: number | null;
  metadata: Record<string, unknown>;
  liveness: WorkUnitLiveness;
}

export interface LedgerIssueDetailSession {
  id: string;
  app: string;
  parent_id: string | null;
  status: string;
  branch: string | null;
  worktree: string | null;
  task: string | null;
  description: string | null;
  agent_type: string | null;
  created_at: string | null;
  updated_at: string | null;
  ended_at: string | null;
  last_active: string | null;
  has_conversation: boolean;
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  last_seen_at: number | null;
  metadata: Record<string, unknown>;
}

export interface LedgerIssueDetailAuthRequest {
  id: string;
  type: string;
  title: string;
  status: string;
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  created_at: number | null;
  approved_at: number | null;
  resolved_at: number | null;
  skipped_at: number | null;
  exit_code: number | null;
  error: string | null;
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  metadata: Record<string, unknown>;
}

export interface LedgerIssueDetailConflict {
  id: string;
  adapter: string;
  entity_type: string;
  entity_id: string;
  field: string;
  local_value: unknown;
  remote_value: unknown;
  base_value: unknown;
  status: string;
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface LedgerIssueDetailSyncJob {
  id: string;
  adapter: string;
  direction: string;
  status: string;
  attempt_count: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export interface LedgerIssueDetailSyncSummary {
  state: "clean" | "pending" | "failed" | "conflicted";
  outbox: Record<string, number>;
  open_conflicts: number;
  latest_jobs: LedgerIssueDetailSyncJob[];
}

export interface LedgerIssueDetailProjection {
  id: string;
  display_id: string;
  project: LedgerIssueDetailProject;
  title: string;
  body: string;
  status: LedgerIssueStatus;
  resolution: LedgerIssueResolution | null;
  kind: LedgerIssueKind;
  priority: LedgerPriority;
  source: LedgerEventSource;
  author: LedgerIssueDetailActor;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  aliases: LedgerIssueDetailAlias[];
  labels: string[];
  comments: LedgerIssueDetailComment[];
  relationships: LedgerIssueDetailRelationship[];
  work_units: LedgerIssueDetailWorkUnit[];
  sessions: LedgerIssueDetailSession[];
  auth_requests: LedgerIssueDetailAuthRequest[];
  conflicts: LedgerIssueDetailConflict[];
  sync: LedgerIssueDetailSyncSummary;
}

export function buildLedgerIssueDetailProjection(
  db: Db,
  issueId: string,
): LedgerIssueDetailProjection {
  const store = new LedgerStore(db);
  const detail = store.getIssueDetail(issueId);
  const aliases = detail.aliases.map(mapAlias);
  const labels = activeLabels(detail.labels);
  const comments = detail.comments
    .filter((comment) => comment.deleted_at === null)
    .map((comment) => ({
      id: comment.id,
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
    author: {
      id: detail.author_actor_id,
      type: detail.author_actor_type,
      display: detail.author_display || actorTypeLabel(detail.author_actor_type),
    },
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    closed_at: detail.closed_at,
    aliases,
    labels,
    comments,
    relationships,
    work_units: listWorkUnits(db, detail.id),
    sessions: listSessions(db, detail.id),
    auth_requests: listAuthRequests(db, detail.id),
    conflicts,
    sync,
  };
}

function buildRelationships(db: Db, issue: LedgerIssue & {
  outgoing_relationships: LedgerIssueRelationship[];
  incoming_relationships: LedgerIssueRelationship[];
}): LedgerIssueDetailRelationship[] {
  const rows = [
    ...issue.outgoing_relationships
      .filter((relationship) => relationship.deleted_at === null)
      .map((relationship) => ({ row: relationship, direction: "outgoing" as const, related: relationship.target_issue_id })),
    ...issue.incoming_relationships
      .filter((relationship) => relationship.deleted_at === null)
      .map((relationship) => ({ row: relationship, direction: "incoming" as const, related: relationship.source_issue_id })),
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

function listWorkUnits(db: Db, issueId: string): LedgerIssueDetailWorkUnit[] {
  if (!tableExists(db, "work_units")) return [];
  const hasLinks = tableExists(db, "ledger_work_unit_issue_links");
  const rows = hasLinks
    ? db.prepare(
        `SELECT wu.*, l.link_type, l.source AS link_source,
                l.created_at AS link_created_at, l.last_seen_at,
                l.metadata_json AS link_metadata_json
         FROM work_units wu
         LEFT JOIN ledger_work_unit_issue_links l
           ON l.work_unit_id = wu.id AND l.issue_id = ?
         WHERE wu.ledger_issue_id = ? OR l.issue_id = ?
         ORDER BY wu.created_at DESC`,
      ).all(issueId, issueId, issueId) as Array<Record<string, unknown>>
    : db.prepare(
        `SELECT wu.*, NULL AS link_type, NULL AS link_source,
                NULL AS link_created_at, NULL AS last_seen_at,
                '{}' AS link_metadata_json
         FROM work_units wu
         WHERE wu.ledger_issue_id = ?
         ORDER BY wu.created_at DESC`,
      ).all(issueId) as Array<Record<string, unknown>>;

  const seen = new Set<string>();
  const result: LedgerIssueDetailWorkUnit[] = [];
  for (const row of rows) {
    const workUnit = mapWorkUnitRow(row);
    if (!workUnit.id || seen.has(workUnit.id)) continue;
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

function listSessions(db: Db, issueId: string): LedgerIssueDetailSession[] {
  if (!tableExists(db, "ledger_session_issue_links") || !tableExists(db, "sessions")) return [];
  const rows = db.prepare(
    `SELECT l.session_id, l.link_type, l.source AS link_source,
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
       COALESCE(l.last_seen_at, l.created_at) DESC`,
  ).all(issueId) as Array<Record<string, unknown>>;

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

function listAuthRequests(db: Db, issueId: string): LedgerIssueDetailAuthRequest[] {
  if (!tableExists(db, "ledger_auth_issue_links") || !tableExists(db, "auth_requests")) return [];
  return db.prepare(
    `SELECT l.auth_request_id, l.link_type, l.source AS link_source,
            l.created_at AS link_created_at, l.metadata_json AS link_metadata_json,
            ar.type, ar.title, ar.status, ar.repo, ar.base_branch, ar.head_branch,
            ar.created_at, ar.approved_at, ar.resolved_at, ar.skipped_at,
            ar.exit_code, ar.error
     FROM ledger_auth_issue_links l
     LEFT JOIN auth_requests ar ON ar.id = l.auth_request_id
     WHERE l.issue_id = ?
     ORDER BY ar.created_at DESC, l.created_at DESC`,
  ).all(issueId).map((row: unknown) => {
    const record = row as Record<string, unknown>;
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

function listIssueConflicts(
  db: Db,
  issueId: string,
  commentIds: string[],
  relationshipIds: string[],
): LedgerIssueDetailConflict[] {
  if (!tableExists(db, "ledger_conflicts")) return [];
  const { sql, params } = entityWhere([
    ["issue", [issueId]],
    ["comment", commentIds],
    ["issue_relationship", relationshipIds],
  ]);
  if (!sql) return [];
  return db.prepare(
    `SELECT * FROM ledger_conflicts
     WHERE status = 'open' AND (${sql})
     ORDER BY created_at DESC`,
  ).all(...params).map((row: unknown) => mapConflict(row as LedgerConflict));
}

function buildSyncSummary(
  db: Db,
  issue: LedgerIssue,
  commentIds: string[],
  relationshipIds: string[],
  openConflicts: number,
): LedgerIssueDetailSyncSummary {
  const outbox: Record<string, number> = {};
  if (tableExists(db, "ledger_outbox") && tableExists(db, "ledger_events")) {
    const { sql, params } = entityWhere([
      ["issue", [issue.id]],
      ["comment", commentIds],
      ["issue_relationship", relationshipIds],
    ], "e");
    if (sql) {
      const rows = db.prepare(
        `SELECT o.status, COUNT(*) AS count
         FROM ledger_outbox o
         JOIN ledger_events e ON e.id = o.event_id
         WHERE ${sql}
         GROUP BY o.status`,
      ).all(...params) as Array<{ status: string; count: number }>;
      for (const row of rows) outbox[row.status] = row.count;
    }
  }

  const latest_jobs = tableExists(db, "ledger_sync_jobs")
    ? db.prepare(
        `SELECT id, adapter, direction, status, attempt_count, started_at,
                finished_at, last_error, updated_at
         FROM ledger_sync_jobs
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT 5`,
      ).all(issue.project_id).map((row: unknown) => {
        const record = row as Record<string, unknown>;
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

function getProjectInfo(db: Db, projectId: string): LedgerIssueDetailProject {
  const project = db.prepare(
    `SELECT id, display_name, remote_identity, upstream_identity
     FROM ledger_projects
     WHERE id = ?`,
  ).get(projectId) as {
    id: string;
    display_name: string;
    remote_identity: string;
    upstream_identity: string;
  } | undefined;
  const checkout = tableExists(db, "ledger_project_checkouts")
    ? db.prepare(
        `SELECT work_repo_id, name, root, default_branch
         FROM ledger_project_checkouts
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(projectId) as {
        work_repo_id: string | null;
        name: string;
        root: string;
        default_branch: string;
      } | undefined
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

function getIssueSummary(db: Db, issueId: string): LedgerIssueSummaryRef | null {
  const row = db.prepare(
    `SELECT id, project_id, title, status, resolution, kind, priority
     FROM ledger_issues
     WHERE id = ?`,
  ).get(issueId) as LedgerIssue | undefined;
  if (!row) return null;
  const labels = activeLabels(db.prepare(
    "SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label",
  ).all(issueId) as LedgerLabel[]);
  const aliases = db.prepare(
    "SELECT * FROM ledger_issue_aliases WHERE issue_id = ? ORDER BY is_primary DESC, alias_kind, alias",
  ).all(issueId) as LedgerIssueAlias[];
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

function computeWorkUnitLiveness(db: Db, workUnit: WorkUnit): WorkUnitLiveness {
  const empty: WorkUnitLiveness = {
    has_live_agent: false,
    agent_session_id: null,
    agent_status: null,
    is_processing: false,
    last_activity: null,
  };
  if (!workUnit.assigned_session_id || !tableExists(db, "sessions")) return empty;
  const row = db.prepare(
    "SELECT status, updated_at, last_active FROM sessions WHERE id = ?",
  ).get(workUnit.assigned_session_id) as { status?: string; updated_at?: string; last_active?: string | null } | undefined;
  if (!row) return empty;
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

function conversationSessionIds(db: Db, sessionIds: string[]): Set<string> {
  const unique = Array.from(new Set(sessionIds.filter(Boolean)));
  if (unique.length === 0 || !tableExists(db, "conversations")) return new Set();
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT DISTINCT session_id FROM conversations WHERE session_id IN (${placeholders})`,
  ).all(...unique) as Array<{ session_id: string }>;
  return new Set(rows.map((row) => row.session_id));
}

function entityWhere(
  groups: Array<[string, string[]]>,
  alias = "",
): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [entityType, ids] of groups) {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) continue;
    clauses.push(`(${prefix}entity_type = ? AND ${prefix}entity_id IN (${unique.map(() => "?").join(", ")}))`);
    params.push(entityType, ...unique);
  }
  return { sql: clauses.join(" OR "), params };
}

function activeLabels(labels: LedgerLabel[]): string[] {
  return labels
    .filter((label) => label.deleted_at === null)
    .map((label) => label.label)
    .sort((a, b) => a.localeCompare(b));
}

function mapAlias(alias: LedgerIssueAlias): LedgerIssueDetailAlias {
  return {
    kind: alias.alias_kind,
    alias: alias.alias,
    external_id: alias.external_id,
    source: alias.source,
    primary: alias.is_primary === 1,
  };
}

function displayIssueId(issue: Pick<LedgerIssue, "id">, aliases: LedgerIssueAlias[]): string {
  const preferred =
    aliases.find((alias) => alias.is_primary === 1 && alias.alias_kind !== "canonical") ??
    aliases.find((alias) => alias.alias_kind !== "canonical") ??
    aliases.find((alias) => alias.is_primary === 1) ??
    aliases[0];
  return preferred?.alias || issue.id;
}

function mapConflict(row: LedgerConflict): LedgerIssueDetailConflict {
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

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function tableExists(db: Db, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function actorTypeLabel(type: LedgerActorType): string {
  return type.replace(/_/g, " ");
}
