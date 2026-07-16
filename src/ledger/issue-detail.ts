import type { Db } from "../db.js";
import { columnExists, tableExists } from "../db-introspection.js";
import {
  getArtifact,
  resolveArtifactLinkRef,
  resolveArtifactSurfaceRefReadonlyFull,
} from "../provider-artifacts.js";
import type { ArtifactRecord, WorkUnit } from "../types.js";
import { mapWorkUnitRow, type WorkUnitLiveness } from "../work-unit-utils.js";
import { LedgerStore } from "./store.js";
import type {
  LedgerActorType,
  LedgerComment,
  LedgerConflict,
  LedgerEvent,
  LedgerEventSource,
  LedgerIssue,
  LedgerIssueAlias,
  LedgerIssueBranch,
  LedgerIssueBranchRole,
  LedgerIssueCheckpoint,
  LedgerIssueKind,
  LedgerIssueRelationship,
  LedgerRelationshipEdge,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerLabel,
  LedgerPriority,
  LedgerRelationshipProvenance,
  LedgerRelationshipType,
  LedgerWorkerStatus,
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

export interface LedgerIssueDetailCheckpoint {
  id: string;
  issue_id: string;
  kind: string;
  payload: unknown;
  author: LedgerIssueDetailActor;
  source: LedgerEventSource;
  created_at: number;
}

export interface LedgerIssueDetailBranch {
  branch: string;
  role: LedgerIssueBranchRole;
  created_at: number;
  updated_at: number;
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
    }
  | {
      id: string;
      kind: "event";
      event_type: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      payload: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "checkpoint";
      checkpoint_id: string;
      checkpoint_kind: string;
      payload: unknown;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
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
  link_type: LedgerRelationshipType;
  provenance: LedgerRelationshipProvenance;
  note: string | null;
  confidence: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  related_issue: LedgerIssueSummaryRef | null;
}

export interface LedgerIssueDetailProject {
  id: string;
  // Issue: 3d85f43 — stable canonical project slug, independent of display_name
  // and of the path-derived WorkScanner work_repo_id.
  project_key: string | null;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  repo_id: string | null;
  // The path-derived WorkScanner id for the representative checkout. Local
  // discovery metadata only; surfaced so auth-queue/work-unit matching (which
  // keys off this id) keeps working now that repo_id is the canonical key.
  work_repo_id: string | null;
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
  link_kind: "pinned" | "living";
  series_id: string | null;
  series_ref: string | null;
  resolved_version_no: number | null;
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
  pin_state: "pinned" | "living";
  is_latest: boolean | null;
  resolved_version_no: number | null;
  series_id: string | null;
  warnings: string[];
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
  worker_status: LedgerWorkerStatus;
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
  issue_branches: LedgerIssueDetailBranch[];
  comments: LedgerIssueDetailComment[];
  checkpoints: LedgerIssueDetailCheckpoint[];
  timeline: LedgerIssueTimelineEntry[];
  relationships: LedgerIssueDetailRelationship[];
  work_units: LedgerIssueDetailWorkUnit[];
  sessions: LedgerIssueDetailSession[];
  auth_requests: LedgerIssueDetailAuthRequest[];
  associated_artifacts: LedgerIssueDetailAssociatedArtifact[];
  conflicts: LedgerIssueDetailConflict[];
  sync: LedgerIssueDetailSyncSummary;
  detail_stage?: "initial" | "full";
  timeline_partial?: boolean;
}

export interface LedgerIssueDetailBuildProfile {
  stage: "initial" | "full";
  total_ms: number;
  phases: Array<{ name: string; ms: number }>;
  counts: Record<string, number>;
}

export function buildLedgerIssueDetailProjection(db: Db, issueId: string): LedgerIssueDetailProjection {
  return buildLedgerIssueDetailProjectionWithProfile(db, issueId).projection;
}

export function buildLedgerIssueDetailInitialProjection(
  db: Db,
  issueId: string,
  options: { commentLimit?: number } = {},
): LedgerIssueDetailProjection {
  return buildLedgerIssueDetailProjectionWithProfile(db, issueId, {
    stage: "initial",
    commentLimit: options.commentLimit,
  }).projection;
}

export function buildLedgerIssueDetailProjectionWithProfile(
  db: Db,
  issueId: string,
  options: {
    stage?: "initial" | "full";
    commentLimit?: number;
    includeProfile?: boolean;
  } = {},
): { projection: LedgerIssueDetailProjection; profile?: LedgerIssueDetailBuildProfile } {
  const stage = options.stage ?? "full";
  const phases: Array<{ name: string; ms: number }> = [];
  const started = performance.now();
  const measure = <T>(name: string, fn: () => T): T => {
    const phaseStarted = performance.now();
    try {
      return fn();
    } finally {
      if (options.includeProfile) {
        phases.push({ name, ms: roundMs(performance.now() - phaseStarted) });
      }
    }
  };

  const store = new LedgerStore(db);
  const issue = measure("issue", () => store.getIssue(issueId));
  const aliases = measure("aliases", () => store.listAliases(issueId));
  const labels = measure("labels", () => (
    db.prepare("SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label").all(issueId) as LedgerLabel[]
  ));
  const branches = measure("branches", () => store.listIssueBranches(issueId));
  const rawComments = stage === "initial"
    ? measure("comments", () => listInitialComments(db, issueId, options.commentLimit ?? 50))
    : measure("comments", () => (
        db.prepare("SELECT * FROM ledger_comments WHERE issue_id = ? ORDER BY created_at").all(issueId) as LedgerComment[]
      ));
  const comments = rawComments
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
  const rawCheckpoints = stage === "initial"
    ? []
    : measure("checkpoints", () => store.listIssueCheckpoints(issueId));
  const checkpoints = rawCheckpoints.map(mapCheckpoint);
  const relationshipInputs = stage === "initial"
    ? { outgoing: [], incoming: [] }
    : measure("relationship_rows", () => ({
        outgoing: db.prepare(
          "SELECT * FROM ledger_issue_relationships WHERE source_issue_id = ? ORDER BY created_at",
        ).all(issueId) as LedgerIssueRelationship[],
        incoming: db.prepare(
          "SELECT * FROM ledger_issue_relationships WHERE target_issue_id = ? ORDER BY created_at",
        ).all(issueId) as LedgerIssueRelationship[],
      }));
  const detail = {
    ...issue,
    aliases,
    comments: rawComments,
    checkpoints: rawCheckpoints,
    labels,
    branches,
    outgoing_relationships: relationshipInputs.outgoing,
    incoming_relationships: relationshipInputs.incoming,
  };
  const mappedAliases = aliases.map(mapAlias);
  const activeIssueLabels = activeLabels(labels);
  const relationships = stage === "initial" ? [] : measure("relationships", () => buildRelationships(db, detail));
  const author = {
    id: issue.author_actor_id,
    type: issue.author_actor_type,
    display: issue.author_display || actorTypeLabel(issue.author_actor_type),
  };
  const timeline = stage === "initial"
    ? buildInitialTimeline(issue, comments, author)
    : measure("timeline", () => buildTimeline(db, issue, comments, checkpoints, author, measure));
  const conflicts = stage === "initial"
    ? []
    : measure("conflicts", () => listIssueConflicts(
        db,
        issue.id,
        comments.map((comment) => comment.id),
        relationships.map((rel) => rel.id),
      ));
  const sync = stage === "initial"
    ? emptySyncSummary()
    : measure("sync", () => buildSyncSummary(
        db,
        issue,
        comments.map((comment) => comment.id),
        relationships.map((rel) => rel.id),
        conflicts.length,
      ));
  const associatedArtifacts = stage === "initial"
    ? []
    : measure("associated_artifacts", () => listAssociatedArtifacts(db, issue.id, issue.body, comments));
  const workUnits = stage === "initial" ? [] : measure("work_units", () => listWorkUnits(db, issue.id));
  const sessions = stage === "initial" ? [] : measure("sessions", () => listSessions(db, issue.id));
  const authRequests = stage === "initial" ? [] : measure("auth_requests", () => listAuthRequests(db, issue.id));
  const timelinePartial = stage === "initial" && (options.commentLimit ?? 50) > 0 && comments.length >= (options.commentLimit ?? 50);

  const projection: LedgerIssueDetailProjection = {
    id: issue.id,
    display_id: displayIssueId(issue, aliases),
    project: measure("project", () => getProjectInfo(db, issue.project_id)),
    title: issue.title,
    body: issue.body,
    status: issue.status,
    worker_status: issue.worker_status,
    resolution: issue.resolution,
    kind: issue.kind,
    priority: issue.priority,
    source: issue.source,
    author,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    aliases: mappedAliases,
    labels: activeIssueLabels,
    issue_branches: branches.map(mapIssueBranch),
    comments,
    checkpoints,
    timeline,
    relationships,
    work_units: workUnits,
    sessions,
    auth_requests: authRequests,
    associated_artifacts: associatedArtifacts,
    conflicts,
    sync,
    detail_stage: stage,
    timeline_partial: timelinePartial,
  };

  return {
    projection,
    profile: options.includeProfile
      ? {
          stage,
          total_ms: roundMs(performance.now() - started),
          phases,
          counts: {
            comments: comments.length,
            checkpoints: checkpoints.length,
            timeline: timeline.length,
            relationships: relationships.length,
            work_units: workUnits.length,
            sessions: sessions.length,
            auth_requests: authRequests.length,
            associated_artifacts: associatedArtifacts.length,
            conflicts: conflicts.length,
          },
        }
      : undefined,
  };
}

function listInitialComments(db: Db, issueId: string, limit: number): LedgerComment[] {
  if (limit <= 0) return [];
  return db.prepare(
    `SELECT * FROM ledger_comments
     WHERE issue_id = ? AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT ?`,
  ).all(issueId, limit) as LedgerComment[];
}

function buildInitialTimeline(
  issue: LedgerIssue,
  comments: LedgerIssueDetailComment[],
  issueAuthor: LedgerIssueDetailActor,
): LedgerIssueTimelineEntry[] {
  return [
    {
      id: `${issue.id}:body`,
      kind: "body",
      ordinal: 0,
      body: issue.body,
      author: issueAuthor,
      source: issue.source,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    ...comments.map((comment) => ({
      id: comment.id,
      kind: "comment" as const,
      comment_id: comment.id,
      ordinal: comment.ordinal,
      body: comment.body,
      author: comment.author,
      source: comment.source,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    })),
  ];
}

function emptySyncSummary(): LedgerIssueDetailSyncSummary {
  return {
    state: "clean",
    outbox: {},
    open_conflicts: 0,
    latest_jobs: [],
  };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mapIssueBranch(branch: LedgerIssueBranch): LedgerIssueDetailBranch {
  return {
    branch: branch.branch,
    role: branch.role,
    created_at: branch.created_at,
    updated_at: branch.updated_at,
  };
}

function mapCheckpoint(checkpoint: LedgerIssueCheckpoint): LedgerIssueDetailCheckpoint {
  return {
    id: checkpoint.id,
    issue_id: checkpoint.issue_id,
    kind: checkpoint.kind,
    payload: parseJsonValue(checkpoint.payload_json),
    author: {
      id: checkpoint.author_actor_id,
      type: checkpoint.author_actor_type,
      display: checkpoint.author_display || actorTypeLabel(checkpoint.author_actor_type),
    },
    source: checkpoint.source,
    created_at: checkpoint.created_at,
  };
}

function listAssociatedArtifacts(
  db: Db,
  issueId: string,
  issueBody: string,
  comments: LedgerIssueDetailComment[],
): LedgerIssueDetailAssociatedArtifact[] {
  if (!tableExists(db, "artifacts") && !tableExists(db, "artifact_blob")) return [];
  const artifacts = new Map<string, LedgerIssueDetailAssociatedArtifact>();

  for (const row of listExplicitArtifactRows(db, issueId, comments.map((comment) => comment.id))) {
    const link = artifactLinkFromIssueDetailRow(row);
    const resolved = resolveIssueDetailLinkArtifact(db, row, link);
    if (!resolved.artifact) continue;
    upsertAssociatedArtifact(artifacts, resolved.artifact, {
      link: resolved.link,
      pinState: resolved.pinState,
      isLatest: resolved.isLatest,
      resolvedVersionNo: resolved.resolvedVersionNo,
      seriesId: resolved.seriesId,
      warnings: resolved.warnings,
    });
  }

  if (tableExists(db, "artifact_aliases")) {
    const refs = extractArtifactRefs([issueBody, ...comments.map((comment) => comment.body)]);
    for (const ref of refs) {
      try {
        const resolution = resolveArtifactLinkRef(db, ref);
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
  const hasCanonicalTargets = columnExists(db, "artifact_links", "blob_id")
    && columnExists(db, "artifact_links", "target_type")
    && columnExists(db, "artifact_links", "target_id")
    && tableExists(db, "artifact_blob");
  return db.prepare(
    `SELECT
        a.id AS artifact_id, a.algorithm, a.content_hash, a.uri, a.media_type,
        a.role AS artifact_role, a.provider_id AS artifact_provider_id,
        a.manifest_id, a.custody_mode, a.availability,
        a.created_at AS artifact_created_at,
        l.id AS link_id, l.entity_type, l.entity_id, l.link_type,
        l.role AS link_role, l.repo_id AS link_repo_id,
        l.provider_id AS link_provider_id, l.source AS link_source,
        l.metadata_json AS link_metadata_json, l.link_kind, l.series_id, l.series_ref,
        ${hasCanonicalTargets ? "b.id" : "NULL"} AS canonical_blob_id,
        ${hasCanonicalTargets ? "l.target_type" : "NULL"} AS canonical_target_type,
        ${hasCanonicalTargets ? "l.target_id" : "NULL"} AS canonical_target_id,
        l.created_at AS link_created_at, l.updated_at AS link_updated_at
       FROM artifact_links l
       LEFT JOIN artifacts a ON a.id = l.artifact_id
       ${hasCanonicalTargets ? "LEFT JOIN artifact_blob b ON b.id = l.blob_id" : ""}
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
  source: {
    ref?: string;
    link?: LedgerIssueDetailArtifactLink;
    pinState?: "pinned" | "living";
    isLatest?: boolean | null;
    resolvedVersionNo?: number | null;
    seriesId?: string | null;
    warnings?: string[];
  },
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
      pin_state: source.pinState ?? "pinned",
      is_latest: source.isLatest ?? null,
      resolved_version_no: source.resolvedVersionNo ?? null,
      series_id: source.seriesId ?? null,
      warnings: [...(source.warnings ?? [])],
      refs: [],
      links: [],
    };
    artifacts.set(artifact.id, entry);
  } else {
    if (source.pinState === "living") entry.pin_state = "living";
    if (source.pinState === "living") {
      if (source.isLatest !== undefined) entry.is_latest = source.isLatest;
      if (source.resolvedVersionNo !== undefined) entry.resolved_version_no = source.resolvedVersionNo;
      if (source.seriesId !== undefined) entry.series_id = source.seriesId;
    }
    for (const warning of source.warnings ?? []) {
      if (!entry.warnings.includes(warning)) entry.warnings.push(warning);
    }
  }
  if (source.ref && !entry.refs.includes(source.ref)) entry.refs.push(source.ref);
  if (source.link && !entry.links.some((link) => link.id === source.link?.id)) {
    entry.links.push(source.link);
  }
}

type IssueDetailLinkedArtifact = Pick<
  ArtifactRecord,
  "id" | "algorithm" | "content_hash" | "uri" | "media_type" | "role" | "provider_id" |
  "manifest_id" | "custody_mode" | "availability" | "created_at"
>;

type ResolvedIssueDetailLink = {
  artifact: IssueDetailLinkedArtifact | null;
  link: LedgerIssueDetailArtifactLink;
  pinState: "pinned" | "living";
  isLatest: boolean | null;
  resolvedVersionNo: number | null;
  seriesId: string | null;
  warnings: string[];
};

function resolveIssueDetailLinkArtifact(
  db: Db,
  row: Record<string, unknown>,
  link: LedgerIssueDetailArtifactLink,
): ResolvedIssueDetailLink {
  const canonicalBlobId = nullableString(row.canonical_blob_id);
  const fallback = canonicalBlobId
    ? getArtifact(db, canonicalBlobId)
    : artifactFromIssueDetailRow(row);
  if (link.link_kind !== "living") {
    return {
      artifact: fallback,
      link,
      pinState: "pinned",
      isLatest: null,
      resolvedVersionNo: null,
      seriesId: link.series_id,
      warnings: [],
    };
  }

  const canonicalArtifactId = row.canonical_target_type === "artifact"
    ? nullableString(row.canonical_target_id)
    : null;
  const ref = canonicalArtifactId
    ? canonicalArtifactId.replace(/^artifact:/i, "artifact-series:")
    : link.series_ref ?? link.series_id;
  if (!ref) {
    return livingFallback(fallback, link, ["living_series_unresolved"]);
  }

  try {
    const resolution = resolveArtifactSurfaceRefReadonlyFull(db, ref);
    if (resolution.artifact) {
      const resolvedSeriesId = resolution.series?.id ?? link.series_id;
      const resolvedVersionNo = resolution.version?.version_no ?? null;
      return {
        artifact: resolution.artifact,
        link: { ...link, series_id: resolvedSeriesId, resolved_version_no: resolvedVersionNo },
        pinState: "living",
        isLatest: resolution.version && resolution.series
          ? resolution.series.latest_version_id === resolution.version.id
          : null,
        resolvedVersionNo,
        seriesId: resolvedSeriesId,
        warnings: [...(resolution.warnings ?? [])],
      };
    }
    return livingFallback(fallback, link, [
      ...(resolution.warnings ?? []),
      "living_series_unresolved",
    ]);
  } catch {
    return livingFallback(fallback, link, ["living_series_unresolved"]);
  }
}

function livingFallback(
  artifact: ReturnType<typeof artifactFromIssueDetailRow>,
  link: LedgerIssueDetailArtifactLink,
  warnings: string[],
): ResolvedIssueDetailLink {
  const uniqueWarnings = Array.from(new Set(warnings));
  return {
    artifact,
    link: { ...link, resolved_version_no: null },
    pinState: "living",
    isLatest: null,
    resolvedVersionNo: null,
    seriesId: link.series_id,
    warnings: uniqueWarnings,
  };
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
    link_kind: row.link_kind === "living" ? "living" : "pinned",
    series_id: nullableString(row.series_id),
    series_ref: nullableString(row.series_ref),
    resolved_version_no: null,
    created_at: Number(row.link_created_at ?? 0),
    updated_at: Number(row.link_updated_at ?? 0),
  };
}

function buildRelationships(db: Db, issue: LedgerIssue & {
  outgoing_relationships: LedgerIssueRelationship[];
  incoming_relationships: LedgerIssueRelationship[];
}): LedgerIssueDetailRelationship[] {
  const relationshipRows = [
    ...issue.outgoing_relationships
      .filter((relationship) => relationship.deleted_at === null)
      .map((relationship) => ({ row: relationship, direction: "outgoing" as const, related: relationship.target_issue_id })),
    ...issue.incoming_relationships
      .filter((relationship) => relationship.deleted_at === null)
      .map((relationship) => ({ row: relationship, direction: "incoming" as const, related: relationship.source_issue_id })),
  ];

  const relationships: LedgerIssueDetailRelationship[] = relationshipRows.map(({ row, direction, related }) => ({
    id: row.id,
    direction,
    relationship_type: row.relationship_type,
    link_type: row.relationship_type,
    provenance: row.provenance,
    note: null,
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    related_issue: getIssueSummary(db, related),
  }));

  const edgeRows = listIssueRelationshipEdges(db, issue.id);
  for (const { row, direction, related } of edgeRows) {
    relationships.push({
      id: row.id,
      direction,
      relationship_type: row.link_type,
      link_type: row.link_type,
      provenance: row.provenance,
      note: row.note,
      confidence: "observed",
      metadata: parseJsonObject(row.metadata_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
      related_issue: getIssueSummary(db, related),
    });
  }

  return relationships;
}

function listIssueRelationshipEdges(
  db: Db,
  issueId: string,
): Array<{
  row: LedgerRelationshipEdge;
  direction: "incoming" | "outgoing";
  related: string;
}> {
  if (!tableExists(db, "ledger_relationship_edges")) return [];
  const rows = db.prepare(
    `SELECT * FROM ledger_relationship_edges
     WHERE deleted_at IS NULL
       AND (
         source_issue_id = ?
         OR target_issue_id = ?
       )
     ORDER BY created_at, id`,
  ).all(issueId, issueId) as LedgerRelationshipEdge[];

  return rows.flatMap((row) => {
    const entries: Array<{
      row: LedgerRelationshipEdge;
      direction: "incoming" | "outgoing";
      related: string;
    }> = [];
    if (row.source_issue_id === issueId && row.target_issue_id) {
      entries.push({ row, direction: "outgoing", related: row.target_issue_id });
    }
    if (row.target_issue_id === issueId && row.source_issue_id) {
      entries.push({ row, direction: "incoming", related: row.source_issue_id });
    }
    return entries;
  });
}

function buildTimeline(
  db: Db,
  issue: LedgerIssue,
  comments: LedgerIssueDetailComment[],
  checkpoints: LedgerIssueDetailCheckpoint[],
  issueAuthor: LedgerIssueDetailActor,
  measure: <T>(name: string, fn: () => T) => T = (_name, fn) => fn(),
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

  for (const checkpoint of checkpoints) {
    entries.push({
      id: checkpoint.id,
      kind: "checkpoint",
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      payload: checkpoint.payload,
      author: checkpoint.author,
      source: checkpoint.source,
      created_at: checkpoint.created_at,
    });
  }

  const events = measure("timeline:issue_events", () => db.prepare(
    `SELECT * FROM ledger_events
     WHERE entity_type = 'issue'
       AND entity_id = ?
       AND event_type IN ('issue.updated', 'issue.closed', 'issue.reopened')
     ORDER BY occurred_at, observed_at`,
  ).all(issue.id) as LedgerEvent[]);
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

  const relationshipEntityKeys = measure("timeline:relationship_event_keys", () => (
    listRelationshipTimelineEntityKeys(db, issue.id)
  ));
  const relationshipEvents = measure("timeline:relationship_events", () => (
    listRelationshipTimelineEvents(db, relationshipEntityKeys)
  ));
  for (const event of relationshipEvents) {
    entries.push({
      id: event.id,
      kind: "event",
      event_type: event.event_type,
      author: {
        id: event.actor_id,
        type: event.actor_type,
        display: actorTypeLabel(event.actor_type),
      },
      source: event.source,
      created_at: event.occurred_at,
      payload: parseJsonObject(event.payload_json),
    });
  }

  return entries.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    const order = { body: 0, comment: 1, state: 2, event: 3, checkpoint: 4 };
    return order[a.kind] - order[b.kind];
  });
}

function listRelationshipTimelineEntityKeys(
  db: Db,
  issueId: string,
): Array<{ entity_type: "relationship_edge" | "issue_relationship"; entity_id: string }> {
  const keys: Array<{ entity_type: "relationship_edge" | "issue_relationship"; entity_id: string }> = [];
  if (tableExists(db, "ledger_relationship_edges")) {
    const rows = db.prepare(
      `SELECT id FROM ledger_relationship_edges
       WHERE source_issue_id = ? OR target_issue_id = ?`,
    ).all(issueId, issueId) as Array<{ id: string }>;
    for (const row of rows) keys.push({ entity_type: "relationship_edge", entity_id: row.id });
  }
  if (tableExists(db, "ledger_issue_relationships")) {
    const rows = db.prepare(
      `SELECT id FROM ledger_issue_relationships
       WHERE source_issue_id = ? OR target_issue_id = ?`,
    ).all(issueId, issueId) as Array<{ id: string }>;
    for (const row of rows) keys.push({ entity_type: "issue_relationship", entity_id: row.id });
  }
  return keys;
}

function listRelationshipTimelineEvents(
  db: Db,
  keys: Array<{ entity_type: "relationship_edge" | "issue_relationship"; entity_id: string }>,
): LedgerEvent[] {
  if (keys.length === 0) return [];
  const events: LedgerEvent[] = [];
  const byType = new Map<"relationship_edge" | "issue_relationship", string[]>();
  for (const key of keys) {
    const ids = byType.get(key.entity_type) ?? [];
    ids.push(key.entity_id);
    byType.set(key.entity_type, ids);
  }
  for (const [entityType, ids] of byType) {
    for (const chunk of chunkStrings([...new Set(ids)], 400)) {
      const placeholders = chunk.map(() => "?").join(", ");
      events.push(...db.prepare(
        `SELECT * FROM ledger_events
         WHERE entity_type = ?
           AND entity_id IN (${placeholders})
           AND event_type IN ('relationship.added', 'relationship.removed')
         ORDER BY occurred_at, observed_at`,
      ).all(entityType, ...chunk) as LedgerEvent[]);
    }
  }
  return events.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at - b.occurred_at;
    return a.observed_at - b.observed_at;
  });
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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
    `SELECT id, project_key, display_name, remote_identity, upstream_identity
     FROM ledger_projects
     WHERE id = ?`,
  ).get(projectId) as {
    id: string;
    project_key: string;
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
  // Issue: 3d85f43 — the canonical project key is the route/display identity.
  // Prefer it for `repo_id` so projections surface `feedbax`, not the
  // path-derived WorkScanner id `20-feedbax-feedbax`; fall back to work_repo_id
  // only when a key is somehow absent.
  const projectKey = project?.project_key && project.project_key !== "" ? project.project_key : null;
  return {
    id: project?.id ?? projectId,
    project_key: projectKey,
    display_name: project?.display_name ?? projectId,
    remote_identity: project?.remote_identity ?? "",
    upstream_identity: project?.upstream_identity ?? "",
    repo_id: projectKey ?? checkout?.work_repo_id ?? null,
    work_repo_id: checkout?.work_repo_id ?? null,
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

const ARTIFACT_REF_PATTERN = /\[((?:artifact|artifact-series|artifact-version|artifact-blob):[^\]\s]+)\]/gi;
const DIRECT_NAV_SCHEMES = new Set(["http", "https", "mailto"]);

function extractArtifactRefs(sources: string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    ARTIFACT_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARTIFACT_REF_PATTERN.exec(source))) {
      const ref = normalizeAuthoredArtifactRef(trimTrailingPunctuation(match[1] ?? match[2] ?? match[0]));
      if (!isArtifactLikeRef(ref) || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function normalizeAuthoredArtifactRef(ref: string): string {
  const wrapped = /^artifact:([a-z][a-z0-9+.-]*:\/\/.+)$/i.exec(ref);
  return wrapped ? wrapped[1] : ref;
}

function isArtifactLikeRef(ref: string): boolean {
  const scheme = schemeForRef(ref);
  if (scheme === "artifact") {
    return !/^artifact:sha256:/i.test(ref) && !/^artifact:[a-f0-9]{7,64}$/i.test(ref);
  }
  if (scheme === "artifact-series") return true;
  if (scheme === "artifact-version") return true;
  if (scheme === "artifact-blob") return true;
  return Boolean(scheme && ref.includes("://") && !DIRECT_NAV_SCHEMES.has(scheme));
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
