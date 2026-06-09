import type { Db } from "../db.js";
import { resolveArtifactRef } from "../provider-artifacts.js";
import type { ArtifactRecord, WorkUnit } from "../types.js";
import { mapWorkUnitRow, type WorkUnitLiveness } from "../work-unit-utils.js";
import { LedgerStore } from "./store.js";
import type {
  LedgerActorType,
  LedgerConflict,
  LedgerEvent,
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
  ordinal: number;
  body: string;
  author: LedgerIssueDetailActor;
  source: LedgerEventSource;
  created_at: number;
  updated_at: number | null;
}

export type LedgerIssueTimelineEntry =
  | {
      id: string;
      kind: "body";
      ordinal: 0;
      body: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: "comment";
      comment_id: string;
      ordinal: number;
      body: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: "state";
      event_type: string;
      status: LedgerIssueStatus | null;
      resolution: LedgerIssueResolution | null;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      payload: Record<string, unknown>;
    };

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

export interface LedgerIssueDetailArtifactLink {
  id: string;
  entity_type: string;
  entity_id: string;
  link_type: string;
  role: string | null;
  repo_id: string | null;
  provider_id: string | null;
  source: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface LedgerIssueDetailAssociatedArtifact {
  id: string;
  algorithm: string;
  content_hash: string;
  uri: string;
  media_type: string | null;
  role: string | null;
  provider_id: string | null;
  manifest_id: string | null;
  custody_mode: ArtifactRecord["custody_mode"];
  availability: ArtifactRecord["availability"];
  created_at: number;
  refs: string[];
  links: LedgerIssueDetailArtifactLink[];
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
  timeline: LedgerIssueTimelineEntry[];
  relationships: LedgerIssueDetailRelationship[];
  work_units: LedgerIssueDetailWorkUnit[];
  sessions: LedgerIssueDetailSession[];
  auth_requests: LedgerIssueDetailAuthRequest[];
  associated_artifacts: LedgerIssueDetailAssociatedArtifact[];
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
  const associatedArtifacts = listAssociatedArtifacts(db, detail.id, detail.body, comments);

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
    associated_artifacts: associatedArtifacts,
    conflicts,
    sync,
  };
}

function listAssociatedArtifacts(
  db: Db,
  issueId: string,
  issueBody: string,
  comments: LedgerIssueDetailComment[],
): LedgerIssueDetailAssociatedArtifact[] {
  if (!tableExists(db, "artifacts")) return [];
  const artifacts = new Map<string, LedgerIssueDetailAssociatedArtifact>();

  for (const row of listExplicitArtifactRows(db, issueId, comments.map((comment) => comment.id))) {
    const artifact = artifactFromIssueDetailRow(row);
    if (!artifact) continue;
    upsertAssociatedArtifact(artifacts, artifact, {
      link: artifactLinkFromIssueDetailRow(row),
    });
  }

  if (tableExists(db, "artifact_aliases")) {
    const refs = extractArtifactRefs([issueBody, ...comments.map((comment) => comment.body)]);
    for (const ref of refs) {
      try {
        const resolution = resolveArtifactRef(db, ref);
        if (!resolution.artifact) continue;
        upsertAssociatedArtifact(artifacts, resolution.artifact, { ref });
      } catch {
        // A malformed or temporarily unsupported ref should not break issue detail.
      }
    }
  }

  return Array.from(artifacts.values()).sort((a, b) => {
    const linkPriority = Number(b.links.length > 0) - Number(a.links.length > 0);
    if (linkPriority !== 0) return linkPriority;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id.localeCompare(b.id);
  });
}

function listExplicitArtifactRows(
  db: Db,
  issueId: string,
  commentIds: string[],
): Array<Record<string, unknown>> {
  if (!tableExists(db, "artifact_links")) return [];
  const groups: string[] = ["(l.entity_type = 'issue' AND l.entity_id = ?)"];
  const params: string[] = [issueId];
  const uniqueCommentIds = Array.from(new Set(commentIds.filter(Boolean)));
  if (uniqueCommentIds.length > 0) {
    groups.push(`(l.entity_type = 'comment' AND l.entity_id IN (${uniqueCommentIds.map(() => "?").join(", ")}))`);
    params.push(...uniqueCommentIds);
  }
  return db.prepare(
    `SELECT
        a.id AS artifact_id, a.algorithm, a.content_hash, a.uri, a.media_type,
        a.role AS artifact_role, a.provider_id AS artifact_provider_id,
        a.manifest_id, a.custody_mode, a.availability,
        a.created_at AS artifact_created_at,
        l.id AS link_id, l.entity_type, l.entity_id, l.link_type,
        l.role AS link_role, l.repo_id AS link_repo_id,
        l.provider_id AS link_provider_id, l.source AS link_source,
        l.metadata_json AS link_metadata_json,
        l.created_at AS link_created_at, l.updated_at AS link_updated_at
       FROM artifact_links l
       JOIN artifacts a ON a.id = l.artifact_id
      WHERE ${groups.join(" OR ")}
      ORDER BY l.created_at DESC, a.created_at DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
}

function upsertAssociatedArtifact(
  artifacts: Map<string, LedgerIssueDetailAssociatedArtifact>,
  artifact: Pick<
    ArtifactRecord,
    "id" | "algorithm" | "content_hash" | "uri" | "media_type" | "role" | "provider_id" |
    "manifest_id" | "custody_mode" | "availability" | "created_at"
  >,
  source: { ref?: string; link?: LedgerIssueDetailArtifactLink },
): void {
  let entry = artifacts.get(artifact.id);
  if (!entry) {
    entry = {
      id: artifact.id,
      algorithm: artifact.algorithm,
      content_hash: artifact.content_hash,
      uri: artifact.uri,
      media_type: artifact.media_type,
      role: artifact.role,
      provider_id: artifact.provider_id,
      manifest_id: artifact.manifest_id,
      custody_mode: artifact.custody_mode,
      availability: artifact.availability,
      created_at: artifact.created_at,
      refs: [],
      links: [],
    };
    artifacts.set(artifact.id, entry);
  }
  if (source.ref && !entry.refs.includes(source.ref)) entry.refs.push(source.ref);
  if (source.link && !entry.links.some((link) => link.id === source.link?.id)) {
    entry.links.push(source.link);
  }
}

function artifactFromIssueDetailRow(
  row: Record<string, unknown>,
): Pick<
  ArtifactRecord,
  "id" | "algorithm" | "content_hash" | "uri" | "media_type" | "role" | "provider_id" |
  "manifest_id" | "custody_mode" | "availability" | "created_at"
> | null {
  const id = stringOr(row.artifact_id, "");
  if (!id) return null;
  return {
    id,
    algorithm: stringOr(row.algorithm, "sha256"),
    content_hash: stringOr(row.content_hash, ""),
    uri: stringOr(row.uri, id),
    media_type: nullableString(row.media_type),
    role: nullableString(row.artifact_role),
    provider_id: nullableString(row.artifact_provider_id),
    manifest_id: nullableString(row.manifest_id),
    custody_mode: artifactCustodyMode(row.custody_mode),
    availability: artifactAvailability(row.availability),
    created_at: Number(row.artifact_created_at ?? 0),
  };
}

function artifactLinkFromIssueDetailRow(row: Record<string, unknown>): LedgerIssueDetailArtifactLink {
  return {
    id: stringOr(row.link_id, ""),
    entity_type: stringOr(row.entity_type, ""),
    entity_id: stringOr(row.entity_id, ""),
    link_type: stringOr(row.link_type, "references"),
    role: nullableString(row.link_role),
    repo_id: nullableString(row.link_repo_id),
    provider_id: nullableString(row.link_provider_id),
    source: stringOr(row.link_source, "artifact_registry"),
    metadata: parseJsonObject(stringOr(row.link_metadata_json, "{}")),
    created_at: Number(row.link_created_at ?? 0),
    updated_at: Number(row.link_updated_at ?? 0),
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

function buildTimeline(
  db: Db,
  issue: LedgerIssue,
  comments: LedgerIssueDetailComment[],
  issueAuthor: LedgerIssueDetailActor,
): LedgerIssueTimelineEntry[] {
  const entries: LedgerIssueTimelineEntry[] = [{
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

  const events = db.prepare(
    `SELECT * FROM ledger_events
     WHERE entity_type = 'issue'
       AND entity_id = ?
       AND event_type IN ('issue.updated', 'issue.closed', 'issue.reopened')
     ORDER BY occurred_at, observed_at`,
  ).all(issue.id) as LedgerEvent[];
  for (const event of events) {
    const payload = parseJsonObject(event.payload_json);
    const patch = parsePatch(payload);
    const status = lifecycleStatusForEvent(event.event_type)
      ?? (typeof patch.status === "string" ? patch.status as LedgerIssueStatus : null);
    const resolution = typeof patch.resolution === "string" ? patch.resolution as LedgerIssueResolution : null;
    if (!status && !("resolution" in patch)) continue;
    if (isNoopStateEvent(payload, status, resolution)) continue;
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
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    const order = { body: 0, comment: 1, state: 2 };
    return order[a.kind] - order[b.kind];
  });
}

function parsePatch(payload: Record<string, unknown>): Record<string, unknown> {
  const patch = payload.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  return payload;
}

function isNoopStateEvent(
  payload: Record<string, unknown>,
  status: LedgerIssueStatus | null,
  resolution: LedgerIssueResolution | null
): boolean {
  if (status && payload.previous_status === status) {
    const previousResolution = payload.previous_resolution;
    return previousResolution === undefined || previousResolution === resolution;
  }
  return false;
}

function lifecycleStatusForEvent(eventType: string): LedgerIssueStatus | null {
  if (eventType === "issue.closed") return "closed";
  if (eventType === "issue.reopened") return "open";
  return null;
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
    `SELECT id, short_id, project_id, title, status, resolution, kind, priority
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

function displayIssueId(issue: Pick<LedgerIssue, "id" | "short_id">, _aliases: LedgerIssueAlias[]): string {
  return issue.short_id || issue.id.slice(0, 7);
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

const ARTIFACT_REF_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|artifact:sha256:[0-9a-f]{7,64}|artifact:[0-9a-f]{7,64}|sha256:[0-9a-f]{7,64})/gi;
const DIRECT_NAV_SCHEMES = new Set(["http", "https", "mailto"]);

function extractArtifactRefs(sources: string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    ARTIFACT_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARTIFACT_REF_PATTERN.exec(source))) {
      const ref = trimTrailingPunctuation(match[0]);
      if (!isArtifactLikeRef(ref) || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function isArtifactLikeRef(ref: string): boolean {
  const scheme = schemeForRef(ref);
  if (scheme === "artifact") {
    return /^(?:artifact(?::|:\/\/)sha256[:/][0-9a-f]{7,64}|artifact:[0-9a-f]{7,64})$/i.test(ref);
  }
  if (scheme === "sha256") return /^sha256:[0-9a-f]{7,64}$/i.test(ref);
  return Boolean(scheme && !DIRECT_NAV_SCHEMES.has(scheme));
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

function schemeForRef(ref: string): string | null {
  const match = ref.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : null;
}

function artifactCustodyMode(value: unknown): ArtifactRecord["custody_mode"] {
  return value === "link" || value === "copy" || value === "managed" || value === "external"
    ? value
    : "managed";
}

function artifactAvailability(value: unknown): ArtifactRecord["availability"] {
  return value === "present" || value === "missing" || value === "stale" ||
    value === "unchecked" || value === "remote_only" || value === "pinned"
    ? value
    : "unchecked";
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
