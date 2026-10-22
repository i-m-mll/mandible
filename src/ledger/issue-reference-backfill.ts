import type { Db } from "../db.js";
import { LedgerStore } from "./store.js";
import type { LedgerActorInput } from "./types.js";
import { resolveProjectRef } from "./project-registry.js";

export interface IssueReferenceBackfillOptions {
  project?: string;
  issue?: string;
  since?: number;
  until?: number;
}

export interface IssueReferenceBackfillResult {
  dry_run: boolean;
  scope: {
    project_id: string | null;
    issue_id: string | null;
    since: number | null;
    until: number | null;
  };
  processed: {
    issue_bodies: number;
    comments: number;
  };
  before: IssueReferenceBackfillCounts;
  after: IssueReferenceBackfillCounts;
  delta: IssueReferenceBackfillCounts;
  active_sources_by_type: Array<{ source_entity_type: string; count: number }>;
  validation: {
    bad_self_refs: number;
    dangling_targets: number;
  };
}

export interface IssueReferenceBackfillCounts {
  relationship_sources: number;
  active_sources: number;
  deleted_sources: number;
  derived_refs: number;
  events: number;
}

interface TextSource {
  source_issue_id: string;
  source_entity_type: "issue_body" | "comment";
  source_entity_id: string;
  body: string;
}

export function runIssueReferenceBackfill(
  db: Db,
  options: IssueReferenceBackfillOptions = {},
  resultOptions: { dryRun?: boolean; actor: LedgerActorInput },
): IssueReferenceBackfillResult {
  const projectId = options.project ? resolveProjectId(db, options.project) : null;
  const store = new LedgerStore(db, { broadcaster: () => undefined });
  const issueId = options.issue
    ? resolveIssueId(store, options.issue, projectId ?? undefined)
    : null;
  const before = collectCounts(db);
  const sources = listTextSources(db, {
    project_id: projectId,
    issue_id: issueId,
    since: options.since,
    until: options.until,
  });

  for (const source of sources) {
    store.reconcileTextIssueReferences({
      source_issue_id: source.source_issue_id,
      source_entity_type: source.source_entity_type,
      source_entity_id: source.source_entity_id,
      body: source.body,
      source: "system",
      actor: resultOptions.actor,
    });
  }

  const after = collectCounts(db);
  return {
    dry_run: resultOptions.dryRun ?? false,
    scope: {
      project_id: projectId,
      issue_id: issueId,
      since: options.since ?? null,
      until: options.until ?? null,
    },
    processed: {
      issue_bodies: sources.filter((source) => source.source_entity_type === "issue_body").length,
      comments: sources.filter((source) => source.source_entity_type === "comment").length,
    },
    before,
    after,
    delta: diffCounts(before, after),
    active_sources_by_type: db.prepare(
      `SELECT source_entity_type, COUNT(*) AS count
       FROM ledger_issue_relationship_sources
       WHERE deleted_at IS NULL
       GROUP BY source_entity_type
       ORDER BY source_entity_type`,
    ).all() as Array<{ source_entity_type: string; count: number }>,
    validation: {
      bad_self_refs: scalar(db,
        `SELECT COUNT(*) AS count
         FROM ledger_issue_relationship_sources
         WHERE source_issue_id = target_issue_id AND deleted_at IS NULL`),
      dangling_targets: scalar(db,
        `SELECT COUNT(*) AS count
         FROM ledger_issue_relationship_sources s
         LEFT JOIN ledger_issues i ON i.id = s.target_issue_id
         WHERE s.deleted_at IS NULL AND i.id IS NULL`),
    },
  };
}

function resolveProjectId(db: Db, ref: string): string {
  const resolved = resolveProjectRef(db, ref);
  if (resolved.ok) return resolved.project.id;
  if (resolved.reason === "unknown") throw new Error(`No ledger project matches repo/project scope '${ref}'.`);
  throw new Error(`Ambiguous repo/project scope '${ref}' matched projects: ${resolved.candidates.join(", ")}.`);
}

function resolveIssueId(store: LedgerStore, ref: string, projectId?: string): string {
  const resolved = store.resolveIssueRef(ref, projectId ? { project_id: projectId } : undefined);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") {
    throw new Error(`Ambiguous issue scope '${ref}' matched issues: ${resolved.matches.join(", ")}.`);
  }
  throw new Error(`No issue matches scope '${ref}'.`);
}

function listTextSources(
  db: Db,
  filters: { project_id: string | null; issue_id: string | null; since?: number; until?: number },
): TextSource[] {
  const issueWhere = ["i.deleted_at IS NULL"];
  const issueParams: unknown[] = [];
  const commentWhere = ["c.deleted_at IS NULL", "i.deleted_at IS NULL"];
  const commentParams: unknown[] = [];

  if (filters.project_id) {
    issueWhere.push("i.project_id = ?");
    issueParams.push(filters.project_id);
    commentWhere.push("i.project_id = ?");
    commentParams.push(filters.project_id);
  }
  if (filters.issue_id) {
    issueWhere.push("i.id = ?");
    issueParams.push(filters.issue_id);
    commentWhere.push("c.issue_id = ?");
    commentParams.push(filters.issue_id);
  }
  if (filters.since !== undefined) {
    issueWhere.push("i.updated_at >= ?");
    issueParams.push(filters.since);
    commentWhere.push("COALESCE(c.updated_at, c.created_at) >= ?");
    commentParams.push(filters.since);
  }
  if (filters.until !== undefined) {
    issueWhere.push("i.updated_at <= ?");
    issueParams.push(filters.until);
    commentWhere.push("COALESCE(c.updated_at, c.created_at) <= ?");
    commentParams.push(filters.until);
  }

  const issueRows = db.prepare(
    `SELECT i.id AS source_issue_id,
            'issue_body' AS source_entity_type,
            i.id AS source_entity_id,
            i.body AS body
     FROM ledger_issues i
     WHERE ${issueWhere.join(" AND ")}
     ORDER BY i.updated_at, i.id`,
  ).all(...issueParams) as TextSource[];

  const commentRows = db.prepare(
    `SELECT c.issue_id AS source_issue_id,
            'comment' AS source_entity_type,
            c.id AS source_entity_id,
            c.body AS body
     FROM ledger_comments c
     JOIN ledger_issues i ON i.id = c.issue_id
     WHERE ${commentWhere.join(" AND ")}
     ORDER BY COALESCE(c.updated_at, c.created_at), c.id`,
  ).all(...commentParams) as TextSource[];

  return [...issueRows, ...commentRows];
}

function collectCounts(db: Db): IssueReferenceBackfillCounts {
  return {
    relationship_sources: scalar(db, "SELECT COUNT(*) AS count FROM ledger_issue_relationship_sources"),
    active_sources: scalar(db, "SELECT COUNT(*) AS count FROM ledger_issue_relationship_sources WHERE deleted_at IS NULL"),
    deleted_sources: scalar(db, "SELECT COUNT(*) AS count FROM ledger_issue_relationship_sources WHERE deleted_at IS NOT NULL"),
    derived_refs: scalar(db,
      `SELECT COUNT(*) AS count
       FROM ledger_issue_relationships
       WHERE relationship_type = 'references' AND provenance = 'derived' AND deleted_at IS NULL`),
    events: scalar(db, "SELECT COUNT(*) AS count FROM ledger_events"),
  };
}

function diffCounts(before: IssueReferenceBackfillCounts, after: IssueReferenceBackfillCounts): IssueReferenceBackfillCounts {
  return {
    relationship_sources: after.relationship_sources - before.relationship_sources,
    active_sources: after.active_sources - before.active_sources,
    deleted_sources: after.deleted_sources - before.deleted_sources,
    derived_refs: after.derived_refs - before.derived_refs,
    events: after.events - before.events,
  };
}

function scalar(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}
