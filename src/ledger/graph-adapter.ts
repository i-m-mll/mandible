import path from "node:path";
import type { Db } from "../db.js";
import { columnExists, tableExists } from "../db-introspection.js";
import { AttributionReadResolver, resolvedActorDisplay } from "../identity/read-projection.js";
import type { GraphEdge, GraphNode, GraphQueryParams } from "../types.js";
import { parseJsonObject } from "../row-coerce.js";
import type { SessionSummary } from "../contracts.js";
import { summarizeSessionKey } from "../session-summary.js";

interface ProjectInfo {
  project_id: string;
  repo_id: string;
  repo_name: string;
  repo_root: string;
  project_key?: string;
  candidates: string[];
}

interface IssueRow {
  id: string;
  short_id: string;
  project_id: string;
  title: string;
  body: string;
  status: string;
  resolution: string | null;
  kind: string;
  priority: string;
  author_actor_id: string | null;
  author_actor_type: string;
  author_display: string;
  author_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: string;
  created_at: number | string;
  updated_at: number | string;
  closed_at: number | string | null;
}

interface AliasRow {
  issue_id: string;
  alias_kind: string;
  alias: string;
  external_id: string;
  source: string;
  is_primary: number;
}

interface RelationshipRow {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  relationship_type: string;
  provenance: string;
  confidence: string;
  metadata_json: string;
  created_at: number | string;
}

interface AttachmentAnnotation {
  id: string;
  type: string;
  label: string;
  status?: string;
  target?: string;
  link_type?: string;
}

export interface LedgerIssueProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  issueNodeIds: Set<string>;
  issueNodeIdByLedgerId: Map<string, string>;
}


function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = new Date(trimmed).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function toIso(value: unknown): string | undefined {
  const ms = parseTimestamp(value);
  return ms !== null ? new Date(ms).toISOString() : undefined;
}

function maxTimestamp(...values: unknown[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    const ms = parseTimestamp(value);
    if (ms === null) continue;
    max = max === null ? ms : Math.max(max, ms);
  }
  return max;
}

function parseSince(since: string | undefined): number | null {
  if (!since) return null;
  if (/^\d{4}-/.test(since)) {
    const ms = new Date(since).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const relMatch = /^(\d+)(d|h|w|m)$/.exec(since);
  if (!relMatch) return null;
  const n = Number(relMatch[1]);
  const unit = relMatch[2];
  const unitMs = unit === "h"
    ? 60 * 60 * 1_000
    : unit === "d"
      ? 24 * 60 * 60 * 1_000
      : unit === "w"
        ? 7 * 24 * 60 * 60 * 1_000
        : 30 * 24 * 60 * 60 * 1_000;
  return Date.now() - (n * unitMs);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function basename(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return path.basename(value);
}

function candidateMatchesFilter(candidate: string | null | undefined, filter: string): boolean {
  if (!candidate) return false;
  return candidate === filter || path.basename(filter) === candidate || filter.endsWith(`/${candidate}`);
}

function activeRepoFilters(params: GraphQueryParams): string[] {
  return params.repos && params.repos.length > 0 ? params.repos : params.repo ? [params.repo] : [];
}

function matchesRepoFilter(info: ProjectInfo, params: GraphQueryParams): boolean {
  const filters = activeRepoFilters(params);
  if (filters.length === 0) return true;
  return filters.some((filter) => info.candidates.some((candidate) => candidateMatchesFilter(candidate, filter)));
}

function getProjectInfos(db: Db): Map<string, ProjectInfo> {
  if (!tableExists(db, "ledger_projects") || !tableExists(db, "ledger_project_checkouts")) {
    return new Map();
  }
  const projectKeyExpr = columnExists(db, "ledger_projects", "project_key") ? "p.project_key" : "''";
  const rows = db.prepare(
    `SELECT p.id AS project_id, ${projectKeyExpr} AS project_key, p.display_name, p.remote_identity,
            c.work_repo_id, c.root, c.name AS checkout_name, c.default_branch,
            c.updated_at AS checkout_updated_at
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id
      ORDER BY p.display_name, c.updated_at DESC`,
  ).all() as Array<{
    project_id: string;
    project_key: string;
    display_name: string;
    remote_identity: string;
    work_repo_id: string | null;
    root: string | null;
    checkout_name: string | null;
    default_branch: string | null;
    checkout_updated_at: number | null;
  }>;

  const byProject = new Map<string, ProjectInfo>();
  for (const row of rows) {
    const existing = byProject.get(row.project_id);
    const candidates = uniqueStrings([
      row.project_id,
      row.project_key,
      row.display_name,
      row.remote_identity,
      row.work_repo_id,
      row.root,
      basename(row.root),
      row.checkout_name,
    ]);

    if (!existing) {
      byProject.set(row.project_id, {
        project_id: row.project_id,
        repo_id: row.project_key || row.work_repo_id || row.root || row.project_id,
        repo_name: row.checkout_name ?? row.display_name ?? basename(row.root) ?? row.project_id,
        repo_root: row.root ?? "",
        project_key: row.project_key || undefined,
        candidates,
      });
      continue;
    }

    existing.candidates = uniqueStrings([...existing.candidates, ...candidates]);
    if (!existing.repo_root && row.root) existing.repo_root = row.root;
  }
  return byProject;
}

function rowsByIssue<T extends { issue_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.issue_id) ?? [];
    group.push(row);
    grouped.set(row.issue_id, group);
  }
  return grouped;
}

function getAliasRows(db: Db): Map<string, AliasRow[]> {
  if (!tableExists(db, "ledger_issue_aliases")) return new Map();
  return rowsByIssue(db.prepare(
    `SELECT issue_id, alias_kind, alias, external_id, source, is_primary
       FROM ledger_issue_aliases
      ORDER BY is_primary DESC, alias_kind, alias`,
  ).all() as AliasRow[]);
}

function displayIssueId(issue: IssueRow): string {
  return issue.short_id || issue.id.slice(0, 7);
}

function getLabelsByIssue(db: Db): Map<string, string[]> {
  if (!tableExists(db, "ledger_labels")) return new Map();
  const grouped = rowsByIssue(db.prepare(
    `SELECT issue_id, label
       FROM ledger_labels
      WHERE deleted_at IS NULL
      ORDER BY label`,
  ).all() as Array<{ issue_id: string; label: string }>);
  return new Map(Array.from(grouped.entries()).map(([issueId, labels]) => [
    issueId,
    labels.map((row) => row.label),
  ]));
}

function getCommentStats(db: Db): Map<string, { count: number; latest_comment_at?: string }> {
  if (!tableExists(db, "ledger_comments")) return new Map();
  const rows = db.prepare(
    `SELECT issue_id, COUNT(*) AS count, MAX(created_at) AS latest_comment_at
       FROM ledger_comments
      WHERE deleted_at IS NULL
      GROUP BY issue_id`,
  ).all() as Array<{ issue_id: string; count: number; latest_comment_at: number | null }>;
  return new Map(rows.map((row) => [
    row.issue_id,
    { count: row.count, latest_comment_at: toIso(row.latest_comment_at) },
  ]));
}

function getAuthAnnotations(db: Db): Map<string, AttachmentAnnotation[]> {
  if (!tableExists(db, "ledger_auth_issue_links") || !tableExists(db, "auth_requests")) return new Map();
  const rows = db.prepare(
    `SELECT l.issue_id, l.auth_request_id, l.link_type, a.title, a.status
       FROM ledger_auth_issue_links l
       JOIN auth_requests a ON a.id = l.auth_request_id
      ORDER BY l.created_at DESC`,
  ).all() as Array<{
    issue_id: string;
    auth_request_id: string;
    link_type: string;
    title: string;
    status: string | null;
  }>;
  const grouped = new Map<string, AttachmentAnnotation[]>();
  for (const row of rows) {
    const annotations = grouped.get(row.issue_id) ?? [];
    annotations.push({
      id: `auth:${row.auth_request_id}:${row.link_type}`,
      type: "auth_request",
      label: row.title || row.auth_request_id,
      status: row.status ?? undefined,
      target: `auth_request:${row.auth_request_id}`,
      link_type: row.link_type,
    });
    grouped.set(row.issue_id, annotations);
  }
  return grouped;
}

/** Each issue's linked sessions, live ones listed, judged by the canonical session summary. */
function getSessionSummaries(db: Db, issueIds: Set<string>): Map<string, {
  live: AttachmentAnnotation[];
  historical_count: number;
  live_count: number;
}> {
  if (!tableExists(db, "ledger_session_issue_links")) return new Map();
  const rows = (db.prepare(
    `SELECT issue_id, session_id, link_type
       FROM ledger_session_issue_links
      ORDER BY COALESCE(last_seen_at, created_at) DESC`,
  ).all() as Array<{ issue_id: string; session_id: string; link_type: string }>)
    .filter((row) => issueIds.has(row.issue_id));

  const sessions = new Map<string, SessionSummary>();
  const summaries = new Map<string, { live: AttachmentAnnotation[]; historical_count: number; live_count: number }>();
  for (const row of rows) {
    const session = sessions.get(row.session_id) ?? summarizeSessionKey(db, row.session_id);
    sessions.set(row.session_id, session);
    const summary = summaries.get(row.issue_id) ?? { live: [], historical_count: 0, live_count: 0 };
    if (session.liveness === "stopped") {
      summary.historical_count += 1;
    } else {
      summary.live_count += 1;
      summary.live.push({
        id: `session:${row.session_id}:${row.link_type}`,
        type: "session",
        label: session.agent ?? session.provider ?? row.session_id,
        status: session.liveness,
        target: `session:${row.session_id}`,
        link_type: row.link_type,
      });
    }
    summaries.set(row.issue_id, summary);
  }
  return summaries;
}

function getRelationships(db: Db): RelationshipRow[] {
  if (!tableExists(db, "ledger_issue_relationships")) return [];
  return db.prepare(
    `SELECT id, source_issue_id, target_issue_id, relationship_type,
            provenance, confidence, metadata_json, created_at
       FROM ledger_issue_relationships
      WHERE deleted_at IS NULL
      ORDER BY relationship_type, created_at`,
  ).all() as RelationshipRow[];
}

function relationshipEdgeType(type: string): string {
  return type === "parent_child" ? "umbrella_child" : type;
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  parent_child: "Parent/child hierarchy",
  umbrella_child: "Parent/child hierarchy",
  parent: "Parent/child hierarchy",
  blocks: "Blocks",
  duplicate_of: "Duplicate of",
  related: "Related issue",
  references: "Text reference",
  fixed_by: "Fixed by",
  caused_by: "Caused by",
  implements: "Implements",
  tests: "Tests",
};

function relationshipDisplay(type: string): string {
  return RELATIONSHIP_LABELS[type] ?? type.replace(/_/g, " ");
}

function mergeActivityRows(
  activityByIssue: Map<string, number>,
  rows: Array<{ issue_id: string; activity_at: number | string | null }>,
): void {
  for (const row of rows) {
    const activityAt = maxTimestamp(row.activity_at);
    if (activityAt === null) continue;
    activityByIssue.set(row.issue_id, Math.max(activityByIssue.get(row.issue_id) ?? 0, activityAt));
  }
}

function getIssueActivityTimes(db: Db, issues: IssueRow[]): Map<string, number> {
  const activityByIssue = new Map<string, number>();
  for (const issue of issues) {
    activityByIssue.set(issue.id, maxTimestamp(issue.updated_at, issue.created_at) ?? 0);
  }

  if (tableExists(db, "ledger_comments")) {
    mergeActivityRows(activityByIssue, db.prepare(
      `SELECT issue_id,
              MAX(CASE
                WHEN updated_at IS NOT NULL AND updated_at > created_at THEN updated_at
                ELSE created_at
              END) AS activity_at
         FROM ledger_comments
        WHERE deleted_at IS NULL
        GROUP BY issue_id`,
    ).all() as Array<{ issue_id: string; activity_at: number | null }>);
  }

  if (tableExists(db, "ledger_auth_issue_links")) {
    if (tableExists(db, "auth_requests")) {
      mergeActivityRows(activityByIssue, db.prepare(
        `SELECT l.issue_id,
                MAX(CASE
                  WHEN a.updated_at IS NOT NULL
                    AND a.updated_at >= l.created_at
                    AND (a.resolved_at IS NULL OR a.updated_at >= a.resolved_at)
                    THEN a.updated_at
                  WHEN a.resolved_at IS NOT NULL
                    AND a.resolved_at >= l.created_at
                    THEN a.resolved_at
                  ELSE l.created_at
                END) AS activity_at
           FROM ledger_auth_issue_links l
           LEFT JOIN auth_requests a ON a.id = l.auth_request_id
          GROUP BY l.issue_id`,
      ).all() as Array<{ issue_id: string; activity_at: number | null }>);
    } else {
      mergeActivityRows(activityByIssue, db.prepare(
        `SELECT issue_id, MAX(created_at) AS activity_at
           FROM ledger_auth_issue_links
          GROUP BY issue_id`,
      ).all() as Array<{ issue_id: string; activity_at: number | null }>);
    }
  }

  if (tableExists(db, "ledger_session_issue_links")) {
    mergeActivityRows(activityByIssue, db.prepare(
      `SELECT issue_id, MAX(COALESCE(last_seen_at, created_at)) AS activity_at
         FROM ledger_session_issue_links
        GROUP BY issue_id`,
    ).all() as Array<{ issue_id: string; activity_at: number | null }>);
  }

  return activityByIssue;
}

function numberFromMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildLayoutHints(
  issueIds: Set<string>,
  relationships: RelationshipRow[],
): Map<string, Record<string, unknown>> {
  const parentEdges = relationships
    .filter((rel) => rel.relationship_type === "parent_child")
    .filter((rel) => issueIds.has(rel.source_issue_id) && issueIds.has(rel.target_issue_id));
  const childrenByParent = new Map<string, RelationshipRow[]>();
  const parentByChild = new Map<string, RelationshipRow[]>();
  for (const rel of parentEdges) {
    const children = childrenByParent.get(rel.source_issue_id) ?? [];
    children.push(rel);
    childrenByParent.set(rel.source_issue_id, children);
    const parents = parentByChild.get(rel.target_issue_id) ?? [];
    parents.push(rel);
    parentByChild.set(rel.target_issue_id, parents);
  }

  const ranks = new Map<string, number>();
  for (const id of issueIds) ranks.set(id, 0);
  for (let pass = 0; pass < issueIds.size; pass += 1) {
    let changed = false;
    for (const rel of parentEdges) {
      const parentRank = ranks.get(rel.source_issue_id) ?? 0;
      const childRank = Math.min(7, Math.max(ranks.get(rel.target_issue_id) ?? 0, parentRank + 1));
      if (childRank !== ranks.get(rel.target_issue_id)) {
        ranks.set(rel.target_issue_id, childRank);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const hints = new Map<string, Record<string, unknown>>();
  for (const issueId of issueIds) {
    const outgoing = childrenByParent.get(issueId) ?? [];
    const incoming = parentByChild.get(issueId) ?? [];
    const firstParent = incoming[0];
    const metadata = firstParent ? parseJsonObject(firstParent.metadata_json) : {};
    const order = numberFromMetadata(metadata, "order") ?? numberFromMetadata(metadata, "position");
    const hasChildren = outgoing.length > 0;
    const hasParent = incoming.length > 0;
    hints.set(issueId, {
      strategy: hasChildren || hasParent ? "hierarchical" : "component",
      role: hasChildren && hasParent
        ? "umbrella_child_parent"
        : hasChildren ? "umbrella_parent" : hasParent ? "umbrella_child" : "issue",
      group_id: firstParent?.source_issue_id ?? issueId,
      rank: ranks.get(issueId) ?? 0,
      order: order ?? 0,
      child_count: outgoing.length,
      parent_count: incoming.length,
    });
  }
  return hints;
}

export function countLedgerGraphIssues(db: Db, status: "open" | "all" = "all"): number | null {
  if (!tableExists(db, "ledger_issues")) return null;
  let sql = "SELECT COUNT(*) AS count FROM ledger_issues WHERE deleted_at IS NULL";
  if (status === "open") sql += " AND status = 'open'";
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

export function ledgerGraphHasIssues(db: Db): boolean {
  return (countLedgerGraphIssues(db, "all") ?? 0) > 0;
}

export function getLedgerGraphFilterOptions(db: Db): { repos: string[]; branches: string[] } {
  const repos = new Set<string>();
  const branches = new Set<string>();
  if (!tableExists(db, "ledger_project_checkouts") || !tableExists(db, "ledger_projects")) {
    return { repos: [], branches: [] };
  }
  const projectKeyExpr = columnExists(db, "ledger_projects", "project_key") ? "p.project_key" : "''";
  const rows = db.prepare(
    `SELECT ${projectKeyExpr} AS project_key, p.display_name, p.remote_identity,
            c.work_repo_id, c.root, c.name, c.default_branch
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id`,
  ).all() as Array<{
    project_key: string;
    display_name: string;
    remote_identity: string;
    work_repo_id: string | null;
    root: string | null;
    name: string | null;
    default_branch: string | null;
  }>;
  for (const row of rows) {
    for (const repo of uniqueStrings([
      row.name,
      row.project_key,
      row.display_name,
      row.work_repo_id,
      basename(row.root),
      row.remote_identity ? basename(row.remote_identity) : undefined,
    ])) {
      repos.add(repo);
    }
    if (row.default_branch) branches.add(row.default_branch);
  }
  return {
    repos: Array.from(repos).sort((a, b) => a.localeCompare(b)),
    branches: Array.from(branches).sort((a, b) => a.localeCompare(b)),
  };
}

export function buildLedgerIssueProjection(
  db: Db,
  params: GraphQueryParams,
): LedgerIssueProjection | null {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_projects")) {
    return null;
  }

  const projectInfos = getProjectInfos(db);
  const issueRows = db.prepare(
    `SELECT id, short_id, project_id, title, body, status, resolution, kind, priority,
            author_actor_id, author_actor_type, author_display,
            author_user_id, evidence_method, evidence_id, source,
            created_at, updated_at, closed_at
       FROM ledger_issues
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC`,
  ).all() as IssueRow[];
  const sinceMs = parseSince(params.since);
  const activityByIssue = getIssueActivityTimes(db, issueRows);
  const visibleIssues = issueRows.filter((issue) => {
    if (params.status === "open" && issue.status !== "open") return false;
    if (sinceMs !== null && (activityByIssue.get(issue.id) ?? 0) < sinceMs) return false;
    const project = projectInfos.get(issue.project_id);
    if (!project) return activeRepoFilters(params).length === 0;
    return matchesRepoFilter(project, params);
  });
  if (visibleIssues.length === 0) {
    return {
      nodes: [],
      edges: [],
      issueNodeIds: new Set(),
      issueNodeIdByLedgerId: new Map(),
    };
  }

  const visibleIssueIds = new Set(visibleIssues.map((issue) => issue.id));
  const aliasesByIssue = getAliasRows(db);
  const labelsByIssue = getLabelsByIssue(db);
  const commentStats = getCommentStats(db);
  const authByIssue = getAuthAnnotations(db);
  const sessionsByIssue = getSessionSummaries(db, visibleIssueIds);
  const relationships = getRelationships(db).filter((rel) =>
    visibleIssueIds.has(rel.source_issue_id) && visibleIssueIds.has(rel.target_issue_id)
  );
  const layoutHints = buildLayoutHints(visibleIssueIds, relationships);
  const attributionResolver = new AttributionReadResolver(db);

  const issueNodeIdByLedgerId = new Map<string, string>();
  const issueNodeIds = new Set<string>();
  for (const issue of visibleIssues) {
    const project = projectInfos.get(issue.project_id);
    const repoId = project?.repo_id ?? issue.project_id;
    const displayId = displayIssueId(issue);
    const nodeId = `issue:${repoId}:${displayId}`;
    issueNodeIdByLedgerId.set(issue.id, nodeId);
    issueNodeIds.add(nodeId);
  }

  const relationshipCounts = new Map<string, { incoming: number; outgoing: number; children: number; parents: number }>();
  for (const rel of relationships) {
    const source = relationshipCounts.get(rel.source_issue_id) ?? { incoming: 0, outgoing: 0, children: 0, parents: 0 };
    source.outgoing += 1;
    if (rel.relationship_type === "parent_child") source.children += 1;
    relationshipCounts.set(rel.source_issue_id, source);

    const target = relationshipCounts.get(rel.target_issue_id) ?? { incoming: 0, outgoing: 0, children: 0, parents: 0 };
    target.incoming += 1;
    if (rel.relationship_type === "parent_child") target.parents += 1;
    relationshipCounts.set(rel.target_issue_id, target);
  }

  const nodes: GraphNode[] = visibleIssues.map((issue) => {
    const project = projectInfos.get(issue.project_id);
    const aliases = aliasesByIssue.get(issue.id) ?? [];
    const labels = labelsByIssue.get(issue.id) ?? [];
    const authAnnotations = authByIssue.get(issue.id) ?? [];
    const sessionSummary = sessionsByIssue.get(issue.id) ?? { live: [], historical_count: 0, live_count: 0 };
    const comments = commentStats.get(issue.id);
    const relationshipSummary = relationshipCounts.get(issue.id) ?? { incoming: 0, outgoing: 0, children: 0, parents: 0 };
    const displayId = displayIssueId(issue);
    const nodeId = issueNodeIdByLedgerId.get(issue.id)!;
    const bodyExcerpt = issue.body.trim().slice(0, 360);
    const annotations = [...authAnnotations, ...sessionSummary.live];
    const graphActivityAt = activityByIssue.get(issue.id) ?? maxTimestamp(issue.updated_at, issue.created_at);
    const authorAttribution = attributionResolver.attribution({
      user_id: issue.author_user_id,
      evidence_method: issue.evidence_method,
      evidence_id: issue.evidence_id,
    });
    const authorDisplay = resolvedActorDisplay(
      issue.author_display,
      issue.author_actor_type,
      authorAttribution,
    );

    return {
      id: nodeId,
      type: "issue",
      label: issue.title,
      status: issue.status,
      labels,
      repo: project?.repo_name,
      repo_id: project?.repo_id ?? issue.project_id,
      created_at: toIso(issue.created_at),
      updated_at: toIso(issue.updated_at),
      summary: {
        issue_id: displayId,
        kind: issue.kind,
        priority: issue.priority,
        author: authorDisplay,
        comments: comments?.count ?? 0,
        children: relationshipSummary.children,
        parents: relationshipSummary.parents,
        auth_evidence: authAnnotations.length,
        live_sessions: sessionSummary.live_count,
        historical_sessions: sessionSummary.historical_count,
        graph_activity_at: toIso(graphActivityAt),
      },
      detail: {
        ledger_issue_id: issue.id,
        project_id: issue.project_id,
        repo_root: project?.repo_root,
        display_id: displayId,
        aliases: aliases.map((alias) => ({
          kind: alias.alias_kind,
          alias: alias.alias,
          source: alias.source,
          primary: alias.is_primary === 1,
        })),
        body_excerpt: bodyExcerpt || undefined,
        resolution: issue.resolution,
        source: issue.source,
        author_actor_id: issue.author_actor_id,
        author_actor_type: issue.author_actor_type,
        author_legacy_display: issue.author_display,
        author_attribution: authorAttribution,
        closed_at: toIso(issue.closed_at),
        issue_created_at: toIso(issue.created_at),
        issue_updated_at: toIso(issue.updated_at),
        graph_activity_at: toIso(graphActivityAt),
        graph_activity_time_fields: [
          "issue.updated_at",
          "issue.created_at",
          "comments.created_at/updated_at",
          "auth_links.created_at/auth.updated_at/resolved_at",
          "session_links.created_at/last_seen_at",
        ],
        latest_comment_at: comments?.latest_comment_at,
        relationship_counts: relationshipSummary,
        annotations,
        layout: layoutHints.get(issue.id),
      },
      actions: [{ id: "open-issue", label: "Open Issue", kind: "navigate", target: nodeId }],
      source: "ledger",
    };
  });

  const edges: GraphEdge[] = relationships.map((rel) => {
    const source = issueNodeIdByLedgerId.get(rel.source_issue_id)!;
    const target = issueNodeIdByLedgerId.get(rel.target_issue_id)!;
    const metadata = parseJsonObject(rel.metadata_json);
    return {
      id: `ledger_relationship:${rel.id}`,
      source,
      target,
      type: relationshipEdgeType(rel.relationship_type),
      edge_class: "semantic",
      provenance: "ledger_issue_relationships",
      confidence: rel.confidence,
      metadata: {
        ...metadata,
        relationship_id: rel.id,
        relationship_type: rel.relationship_type,
        relationship_label: relationshipDisplay(rel.relationship_type),
        relationship_provenance: rel.provenance,
        relationship_created_at: toIso(rel.created_at),
        source_ledger_issue_id: rel.source_issue_id,
        target_ledger_issue_id: rel.target_issue_id,
        label_default_visible: false,
        layout: rel.relationship_type === "parent_child" ? "hierarchical" : "semantic",
      },
    };
  });

  return { nodes, edges, issueNodeIds, issueNodeIdByLedgerId };
}
