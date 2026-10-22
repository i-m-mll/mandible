import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import {
  AttributionReadResolver,
  resolvedActorDisplay,
} from "../identity/read-projection.js";
import type { ArtifactIdentityResolution } from "../artifact-identity.js";
import {
  getArtifact,
  projectArtifactPublicValue,
  resolveArtifactIdentity,
  resolvedArtifactRecord,
} from "../provider-artifacts.js";
import type { ArtifactRecord } from "../types.js";
import { computeWorkUnitLiveness, mapWorkUnitRow } from "../work-unit-utils.js";
import { summarizeSessionKey } from "../session-summary.js";
import { parseAuthoredReferences } from "./authored-references.js";
import { LedgerStore } from "./store.js";
import { effectiveWorkerStatus, listIssueBranches } from "./issue-work-state.js";
import type {
  LedgerActorType,
  LedgerComment,
  LedgerEvent,
  LedgerIssue,
  LedgerIssueAlias,
  LedgerIssueCheckpoint,
  LedgerIssueRelationship,
  LedgerRelationshipEdge,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerLabel,
} from "./types.js";

import type {
  LedgerIssueDetailAlias,
  LedgerIssueDetailActor,
  LedgerIssueDetailComment,
  LedgerIssueDetailCheckpoint,
  LedgerIssueTimelineEntry,
  LedgerIssueSummaryRef,
  LedgerIssueWorkMetadata,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailProject,
  LedgerIssueDetailWorkUnit,
  LedgerIssueDetailSession,
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailArtifactLink,
  LedgerIssueDetailAssociatedArtifact,
  LedgerIssueDetailProjection,
} from "../issue-detail-contract.js";
export type {
  LedgerIssueDetailAlias,
  LedgerIssueDetailActor,
  LedgerIssueDetailComment,
  LedgerIssueDetailCheckpoint,
  LedgerIssueDetailBranch,
  LedgerIssueTimelineEntry,
  LedgerIssueSummaryRef,
  LedgerIssueWorkMetadata,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailProject,
  LedgerIssueDetailWorkUnit,
  LedgerIssueDetailSession,
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailArtifactLink,
  LedgerIssueDetailAssociatedArtifact,
  LedgerIssueDetailProjection,
} from "../issue-detail-contract.js";

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
  const attributionResolver = new AttributionReadResolver(db);
  const issue = measure("issue", () => store.getIssue(issueId));
  const aliases = measure("aliases", () => store.listAliases(issueId));
  const labels = measure("labels", () => (
    db.prepare("SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label").all(issueId) as LedgerLabel[]
  ));
  const branches = measure("branches", () => listIssueBranches(db, issueId));
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
      author: mapActor(attributionResolver, {
        actor_id: comment.author_actor_id,
        actor_type: comment.author_actor_type,
        legacy_display: comment.author_display,
        user_id: comment.author_user_id,
        evidence_method: comment.evidence_method,
        evidence_id: comment.evidence_id,
      }),
      source: comment.source,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    }));
  const rawCheckpoints = stage === "initial"
    ? []
    : measure("checkpoints", () => store.listIssueCheckpoints(issueId));
  const checkpoints = rawCheckpoints.map((checkpoint) => mapCheckpoint(checkpoint, attributionResolver));
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
    outgoing_relationships: relationshipInputs.outgoing,
    incoming_relationships: relationshipInputs.incoming,
  };
  const mappedAliases = aliases.map(mapAlias);
  const activeIssueLabels = activeLabels(labels);
  const relationships = stage === "initial" ? [] : measure("relationships", () => buildRelationships(db, detail));
  const workMetadata = measure("work_notes_and_dependencies", () => getLedgerIssueWorkMetadata(db, issue.id));
  const author = mapActor(attributionResolver, {
    actor_id: issue.author_actor_id,
    actor_type: issue.author_actor_type,
    legacy_display: issue.author_display,
    user_id: issue.author_user_id,
    evidence_method: issue.evidence_method,
    evidence_id: issue.evidence_id,
  });
  const timeline = stage === "initial"
    ? buildInitialTimeline(issue, comments, author)
    : measure("timeline", () => buildTimeline(
        db,
        issue,
        comments,
        checkpoints,
        author,
        attributionResolver,
        measure,
      ));
  const associatedArtifacts = stage === "initial"
    ? []
    : measure("associated_artifacts", () => listAssociatedArtifacts(db, issue.id, issue.body, comments));
  const workUnits = stage === "initial" ? [] : measure("work_units", () => listWorkUnits(db, issue.id));
  const sessions = stage === "initial"
    ? []
    : measure("sessions", () => listSessions(db, issue.id, attributionResolver));
  const authRequests = stage === "initial"
    ? []
    : measure("auth_requests", () => listAuthRequests(db, issue.id, attributionResolver));
  const timelinePartial = stage === "initial" && (options.commentLimit ?? 50) > 0 && comments.length >= (options.commentLimit ?? 50);

  const projection: LedgerIssueDetailProjection = {
    id: issue.id,
    display_id: displayIssueId(issue, aliases),
    project: measure("project", () => getProjectInfo(db, issue.project_id)),
    title: issue.title,
    body: issue.body,
    work_notes: workMetadata.work_notes,
    work_notes_revision: workMetadata.work_notes_revision,
    status: issue.status,
    worker_status: effectiveWorkerStatus(db, issue.id),
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
    issue_branches: branches,
    comments,
    checkpoints,
    timeline,
    relationships,
    dependencies: workMetadata.dependencies,
    dependency_warning: workMetadata.dependency_warning,
    work_units: workUnits,
    sessions,
    auth_requests: authRequests,
    associated_artifacts: associatedArtifacts,
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

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mapCheckpoint(
  checkpoint: LedgerIssueCheckpoint,
  attributionResolver: AttributionReadResolver,
): LedgerIssueDetailCheckpoint {
  return {
    id: checkpoint.id,
    issue_id: checkpoint.issue_id,
    kind: checkpoint.kind,
    payload: parseJsonValue(checkpoint.payload_json),
    author: mapActor(attributionResolver, {
      actor_id: checkpoint.author_actor_id,
      actor_type: checkpoint.author_actor_type,
      legacy_display: checkpoint.author_display,
      user_id: checkpoint.author_user_id,
      evidence_method: checkpoint.evidence_method,
      evidence_id: checkpoint.evidence_id,
    }),
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
  if (!tableExists(db, "artifact_blob")) return [];
  const artifacts = new Map<string, Omit<LedgerIssueDetailAssociatedArtifact, "ref">>();

  for (const row of listExplicitArtifactRows(db, issueId, comments.map((comment) => comment.id))) {
    const link = artifactLinkFromIssueDetailRow(row);
    const resolved = resolveIssueDetailLinkArtifact(db, row, link);
    if (!resolved.artifact) continue;
    upsertAssociatedArtifact(artifacts, resolved.artifact, {
      link: resolved.link,
      title: resolved.title,
      logicalName: resolved.logicalName,
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
        const resolution = resolveArtifactIdentity(db, ref, "link");
        if (!resolvedArtifactRecord(resolution)) continue;
        const displayIdentity = artifactDisplayIdentity(resolution);
        upsertAssociatedArtifact(artifacts, resolvedArtifactRecord(resolution)!, {
          ref,
          title: displayIdentity.title,
          logicalName: displayIdentity.logicalName,
        });
      } catch {
        // A malformed or temporarily unsupported ref should not break issue detail.
      }
    }
  }

  const sorted = Array.from(artifacts.values()).sort((a, b) => {
    const linkPriority = Number(b.links.length > 0) - Number(a.links.length > 0);
    if (linkPriority !== 0) return linkPriority;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id.localeCompare(b.id);
  });
  return projectArtifactPublicValue(db, sorted) as LedgerIssueDetailAssociatedArtifact[];
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
        l.id AS link_id, l.entity_type, l.entity_id, l.link_type,
        l.role AS link_role, l.repo_id AS link_repo_id,
        l.provider_id AS link_provider_id, l.source AS link_source,
        l.metadata_json AS link_metadata_json, l.link_kind, l.series_ref,
        l.blob_id AS canonical_blob_id,
        l.target_type AS canonical_target_type,
        l.target_id AS canonical_target_id,
        l.created_at AS link_created_at, l.updated_at AS link_updated_at
       FROM artifact_links l
      WHERE ${groups.join(" OR ")}
      ORDER BY l.created_at DESC, l.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
}

function upsertAssociatedArtifact(
  artifacts: Map<string, Omit<LedgerIssueDetailAssociatedArtifact, "ref">>,
  artifact: Pick<
    ArtifactRecord,
    "id" | "algorithm" | "content_hash" | "uri" | "media_type" | "role" | "provider_id" |
    "manifest_id" | "custody_mode" | "availability" | "created_at"
  >,
  source: {
    ref?: string;
    link?: LedgerIssueDetailArtifactLink;
    title?: string | null;
    logicalName?: string | null;
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
      title: source.title ?? null,
      logical_name: source.logicalName ?? null,
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
    if (!entry.title && source.title) entry.title = source.title;
    if (!entry.logical_name && source.logicalName) entry.logical_name = source.logicalName;
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
  title: string | null;
  logicalName: string | null;
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
  const fallback = canonicalBlobId ? getArtifact(db, canonicalBlobId) : null;
  if (link.link_kind !== "living") {
    const targetRef = row.canonical_target_type === "artifact_version"
      || row.canonical_target_type === "artifact"
      ? nullableString(row.canonical_target_id)
      : null;
    const resolution = targetRef
      ? resolveArtifactIdentity(db, targetRef, "surface")
      : null;
    const displayIdentity = artifactDisplayIdentity(resolution);
    return {
      artifact: resolvedArtifactRecord(resolution) ?? fallback,
      link,
      title: displayIdentity.title,
      logicalName: displayIdentity.logicalName,
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
    const resolution = resolveArtifactIdentity(db, ref, "surface");
    if (resolvedArtifactRecord(resolution)) {
      const logical = resolution.logical_artifact;
      const version = resolution.artifact_version;
      const resolvedSeriesId = logical ? seriesRefForLogicalArtifact(logical.id) : link.series_id;
      const resolvedVersionNo = version?.version_no ?? null;
      return {
        artifact: resolvedArtifactRecord(resolution),
        link: { ...link, series_id: resolvedSeriesId, resolved_version_no: resolvedVersionNo },
        ...artifactDisplayIdentity(resolution),
        pinState: "living",
        isLatest: version && logical ? logical.latest_version_id === version.id : null,
        resolvedVersionNo,
        seriesId: resolvedSeriesId,
        warnings: [...resolution.warnings],
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
  artifact: ResolvedIssueDetailLink["artifact"],
  link: LedgerIssueDetailArtifactLink,
  warnings: string[],
): ResolvedIssueDetailLink {
  const uniqueWarnings = Array.from(new Set(warnings));
  return {
    artifact,
    link: { ...link, resolved_version_no: null },
    title: null,
    logicalName: null,
    pinState: "living",
    isLatest: null,
    resolvedVersionNo: null,
    seriesId: link.series_id,
    warnings: uniqueWarnings,
  };
}

/** The authored `artifact-series:` spelling of a canonical logical artifact. */
function seriesRefForLogicalArtifact(artifactId: string): string {
  return artifactId.replace(/^artifact:/i, "artifact-series:");
}

function artifactDisplayIdentity(
  resolution: ArtifactIdentityResolution | null,
): { title: string | null; logicalName: string | null } {
  const logical = resolution?.logical_artifact;
  return {
    title: logical?.title ?? null,
    logicalName: logical?.logical_name ?? null,
  };
}

function artifactLinkFromIssueDetailRow(row: Record<string, unknown>): LedgerIssueDetailArtifactLink {
  const targetType = row.canonical_target_type === "artifact"
    || row.canonical_target_type === "artifact_version"
    || row.canonical_target_type === "artifact_blob"
    ? row.canonical_target_type
    : null;
  const targetId = nullableString(row.canonical_target_id);
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
    series_id: targetType === "artifact" && targetId ? seriesRefForLogicalArtifact(targetId) : null,
    series_ref: nullableString(row.series_ref),
    resolved_version_no: null,
    target_type: targetType,
    target_id: targetId,
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
  attributionResolver: AttributionReadResolver,
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
       AND event_type IN ('issue.updated', 'issue.work_notes_updated', 'issue.closed', 'issue.reopened')
     ORDER BY occurred_at, observed_at`,
  ).all(issue.id) as LedgerEvent[]);
  for (const event of events) {
    const payload = parseJsonObject(event.payload_json);
    if (event.event_type === "issue.work_notes_updated") {
      entries.push({
        id: event.id,
        kind: "event",
        event_type: event.event_type,
        author: mapActor(attributionResolver, {
          actor_id: event.actor_id,
          actor_type: event.actor_type,
          legacy_display: actorTypeLabel(event.actor_type),
          user_id: event.actor_user_id,
          evidence_method: event.evidence_method,
          evidence_id: event.evidence_id,
        }),
        source: event.source,
        created_at: event.occurred_at,
        payload,
      });
      continue;
    }
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
      author: mapActor(attributionResolver, {
        actor_id: event.actor_id,
        actor_type: event.actor_type,
        legacy_display: actorTypeLabel(event.actor_type),
        user_id: event.actor_user_id,
        evidence_method: event.evidence_method,
        evidence_id: event.evidence_id,
      }),
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
      author: mapActor(attributionResolver, {
        actor_id: event.actor_id,
        actor_type: event.actor_type,
        legacy_display: actorTypeLabel(event.actor_type),
        user_id: event.actor_user_id,
        evidence_method: event.evidence_method,
        evidence_id: event.evidence_id,
      }),
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

function listSessions(
  db: Db,
  issueId: string,
  attributionResolver: AttributionReadResolver,
): LedgerIssueDetailSession[] {
  if (!tableExists(db, "ledger_session_issue_links")) return [];
  const rows = db.prepare(
    `SELECT session_id, link_type, source AS link_source, created_at AS link_created_at,
            last_seen_at, metadata_json AS link_metadata_json
     FROM ledger_session_issue_links
     WHERE issue_id = ?
     ORDER BY COALESCE(last_seen_at, created_at) DESC`,
  ).all(issueId) as Array<Record<string, unknown>>;
  const sessions = rows.map((row) => {
    const summary = summarizeSessionKey(db, String(row.session_id ?? ""));
    return {
      ...summary,
      owner: attributionResolver.user(summary.process?.owner_user_id ?? null),
      has_conversation: summary.conversation_id !== null,
      link_type: stringOr(row.link_type, "worked_on"),
      link_source: stringOr(row.link_source, "session"),
      link_created_at: numberOrNull(row.link_created_at),
      last_seen_at: numberOrNull(row.last_seen_at),
      metadata: parseJsonObject(stringOr(row.link_metadata_json, "{}")),
    };
  });
  return sessions.sort((a, b) => Number(b.liveness === "live") - Number(a.liveness === "live"));
}

function listAuthRequests(
  db: Db,
  issueId: string,
  attributionResolver: AttributionReadResolver,
): LedgerIssueDetailAuthRequest[] {
  if (!tableExists(db, "ledger_auth_issue_links") || !tableExists(db, "auth_requests")) return [];
  return db.prepare(
    `SELECT l.auth_request_id, l.link_type, l.source AS link_source,
            l.created_at AS link_created_at, l.metadata_json AS link_metadata_json,
            ar.type, ar.title, ar.status, ar.repo, ar.base_branch, ar.head_branch,
            ar.created_at, ar.approved_at, ar.resolved_at, ar.skipped_at,
            ar.exit_code, ar.error, ar.requested_by_user_id,
            ar.approved_by_user_id, ar.execution_evidence_id
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
      requester: attributionResolver.user(nullableString(record.requested_by_user_id)),
      approver: attributionResolver.user(nullableString(record.approved_by_user_id)),
      execution_evidence: attributionResolver.attribution({
        evidence_id: nullableString(record.execution_evidence_id),
      }),
      link_type: stringOr(record.link_type, "references"),
      link_source: stringOr(record.link_source, "auth_queue"),
      link_created_at: numberOrNull(record.link_created_at),
      metadata: parseJsonObject(stringOr(record.link_metadata_json, "{}")),
    };
  });
}

/** The project's route and display identity: the `<project>` of `<project>/<id>` issue refs. */
export function projectRouteRef(db: Db, projectId: string): string {
  return getProjectInfo(db, projectId).repo_id ?? projectId;
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
  // path-derived WorkScanner ids such as `20-widgets-widgets`; fall back to work_repo_id
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
    project_ref: projectRouteRef(db, row.project_id),
    title: row.title,
    status: row.status,
    resolution: row.resolution,
    kind: row.kind,
    priority: row.priority,
    labels,
  };
}

export function getLedgerIssueWorkMetadata(db: Db, issueId: string): LedgerIssueWorkMetadata {
  const issue = db.prepare(
    "SELECT work_notes FROM ledger_issues WHERE id = ?",
  ).get(issueId) as { work_notes?: string } | undefined;
  const revision = db.prepare(
    `SELECT id FROM ledger_body_revisions
      WHERE entity_type = 'issue_work_notes' AND entity_id = ?
      ORDER BY revision_no DESC
      LIMIT 1`,
  ).get(issueId) as { id?: string } | undefined;
  const dependencyIds = new Set<string>();
  const canonical = db.prepare(
    `SELECT source_issue_id FROM ledger_issue_relationships
      WHERE target_issue_id = ?
        AND relationship_type = 'blocks'
        AND deleted_at IS NULL`,
  ).all(issueId) as Array<{ source_issue_id: string }>;
  for (const row of canonical) {
    if (row.source_issue_id !== issueId) dependencyIds.add(row.source_issue_id);
  }
  if (tableExists(db, "ledger_relationship_edges")) {
    const edges = db.prepare(
      `SELECT source_issue_id FROM ledger_relationship_edges
        WHERE target_issue_id = ?
          AND source_entity_type = 'issue'
          AND target_entity_type = 'issue'
          AND link_type = 'blocks'
          AND deleted_at IS NULL`,
    ).all(issueId) as Array<{ source_issue_id: string }>;
    for (const row of edges) {
      if (row.source_issue_id !== issueId) dependencyIds.add(row.source_issue_id);
    }
  }
  const dependencies = Array.from(dependencyIds)
    .map((dependencyId) => getIssueSummary(db, dependencyId))
    .filter((dependency): dependency is LedgerIssueSummaryRef => dependency !== null)
    .sort((left, right) => left.display_id.localeCompare(right.display_id) || left.id.localeCompare(right.id));
  return {
    work_notes: issue?.work_notes ?? "",
    work_notes_revision: revision?.id ?? null,
    dependencies,
    dependency_warning: dependencies.some((dependency) => dependency.status === "open"),
  };
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

const DIRECT_NAV_SCHEMES = new Set(["http", "https", "mailto"]);

function extractArtifactRefs(sources: string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const match of parseAuthoredReferences(source, { includeProtected: true })) {
      if (!match.kind.startsWith("artifact")) continue;
      const ref = normalizeAuthoredArtifactRef(trimTrailingPunctuation(`${match.kind}:${match.target}`));
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
    return !/^artifact:sha256:/i.test(ref);
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

function mapActor(
  attributionResolver: AttributionReadResolver,
  input: {
    actor_id: string | null;
    actor_type: LedgerActorType;
    legacy_display: string;
    user_id: string | null;
    evidence_method: string | null;
    evidence_id: string | null;
  },
): LedgerIssueDetailActor {
  const attribution = attributionResolver.attribution(input);
  return {
    id: input.actor_id,
    type: input.actor_type,
    display: resolvedActorDisplay(
      input.legacy_display,
      actorTypeLabel(input.actor_type),
      attribution,
    ),
    legacy_display: input.legacy_display,
    attribution,
  };
}
