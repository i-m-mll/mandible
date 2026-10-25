import type { Db } from "../db.js";
import { parseJsonObject } from "../row-coerce.js";
import type { TimelineLabelMembershipInterval } from "../types.js";
import {
  buildParentChildrenByIssueId,
  type IssueReference,
  type IssueRow,
  type LabelHistoryIndex,
  type ParentChildIndex,
} from "./issue-predicate.js";
import type { LedgerRelationshipEdge } from "./types.js";

/**
 * A project's issues and the relationships issue predicates read, loaded from
 * covering indexes. Parent-child edges and label history are read only when a
 * predicate first asks for them.
 */
export interface ProjectIssueSet {
  issues: IssueRow[];
  issueById: Map<string, IssueRow>;
  references: IssueReference[];
  parentChildren: ParentChildIndex;
  labelHistory: LabelHistoryIndex;
}

export const EMPTY_PROJECT_ISSUE_SET: ProjectIssueSet = {
  issues: [],
  issueById: new Map(),
  references: [],
  parentChildren: { childrenOf: () => [] },
  labelHistory: { intervalsForLabel: () => [] },
};

type LabelEventRow = {
  id: string;
  entity_id: string;
  payload_json: string;
  occurred_at: number;
  observed_at: number;
};

export function loadProjectIssueSet(db: Db, projectId: string): ProjectIssueSet {
  const issues = loadIssues(db, projectId);
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  return {
    issues,
    issueById,
    references: loadReferences(db, projectId),
    parentChildren: new ProjectParentChildren(db, projectId, issues),
    labelHistory: new ProjectLabelHistory(db, projectId, issueById),
  };
}

function loadIssues(db: Db, projectId: string): IssueRow[] {
  return db.prepare(
    `SELECT i.id, i.short_id, i.project_id, i.title, i.status, i.resolution, i.kind, i.priority,
            i.created_at, i.deleted_at,
            COALESCE((SELECT group_concat(l.label, char(31))
                        FROM ledger_labels l
                       WHERE l.issue_id = i.id AND l.deleted_at IS NULL), '') AS labels
       FROM ledger_issues i
      WHERE i.project_id = ?
      ORDER BY i.created_at ASC, i.short_id ASC, i.id ASC`,
  ).all(projectId) as IssueRow[];
}

function loadReferences(db: Db, projectId: string): IssueReference[] {
  return db.prepare(
    `SELECT s.source_issue_id, s.target_issue_id
       FROM ledger_issues i
       CROSS JOIN ledger_issue_relationship_sources s
      WHERE i.project_id = ?
        AND s.source_issue_id = i.id
        AND s.relationship_type = 'references'
        AND s.deleted_at IS NULL`,
  ).all(projectId) as IssueReference[];
}

class ProjectParentChildren implements ParentChildIndex {
  private childrenByIssueId: Map<string, string[]> | null = null;

  constructor(
    private readonly db: Db,
    private readonly projectId: string,
    private readonly issues: IssueRow[],
  ) {}

  childrenOf(issueId: string): readonly string[] {
    this.childrenByIssueId ??= buildParentChildrenByIssueId(this.issues, this.db.prepare(
      `SELECT *
         FROM ledger_relationship_edges
        WHERE target_project_id = ?
          AND source_entity_type = 'issue'
          AND target_entity_type = 'issue'
          AND link_type = 'parent_child'
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    ).all(this.projectId) as LedgerRelationshipEdge[]);
    return this.childrenByIssueId.get(issueId) ?? [];
  }
}

class ProjectLabelHistory implements LabelHistoryIndex {
  private readonly intervalsByLabel = new Map<string, TimelineLabelMembershipInterval[]>();

  constructor(
    private readonly db: Db,
    private readonly projectId: string,
    private readonly issueById: Map<string, IssueRow>,
  ) {}

  intervalsForLabel(label: string): readonly TimelineLabelMembershipInterval[] {
    let intervals = this.intervalsByLabel.get(label);
    if (!intervals) {
      intervals = loadLabelIntervals(this.db, this.projectId, this.issueById, label);
      this.intervalsByLabel.set(label, intervals);
    }
    return intervals;
  }
}

function loadLabelIntervals(
  db: Db,
  projectId: string,
  issueById: Map<string, IssueRow>,
  label: string,
): TimelineLabelMembershipInterval[] {
  const rowByIssue = new Map((db.prepare(
    `SELECT l.issue_id, l.label, l.created_at, l.deleted_at
       FROM ledger_labels l
      WHERE l.label = ?
        AND l.issue_id IN (SELECT id FROM ledger_issues WHERE project_id = ?)`,
  ).all(label, projectId) as LabelRow[]).map((row) => [row.issue_id, row]));
  const labelEvents = db.prepare(
    `SELECT e.id, e.entity_type, e.entity_id, e.event_type, e.source, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
      WHERE e.entity_type = 'issue'
        AND e.event_type = 'label.updated'
        AND json_extract(e.payload_json, '$.label') = ?
        AND e.entity_id IN (SELECT id FROM ledger_issues WHERE project_id = ?)
      ORDER BY e.entity_id ASC, e.occurred_at ASC, e.observed_at ASC, e.id ASC`,
  ).all(label, projectId) as LabelEventRow[];
  const eventsByIssue = new Map<string, LabelEventRow[]>();
  for (const event of labelEvents) {
    if (issueById.has(event.entity_id)) appendTo(eventsByIssue, event.entity_id, event);
  }

  const intervals: TimelineLabelMembershipInterval[] = [];
  for (const issueId of new Set([...rowByIssue.keys(), ...eventsByIssue.keys()])) {
    const issue = issueById.get(issueId);
    if (!issue) continue;
    intervals.push(...intervalsForIssueLabel({
      issue,
      label,
      row: rowByIssue.get(issueId),
      events: eventsByIssue.get(issueId) ?? [],
    }));
  }
  return intervals.sort(compareLabelIntervals);
}

export function appendTo<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

type LabelRow = {
  issue_id: string;
  label: string;
  created_at: number;
  deleted_at: number | null;
};

function intervalsForIssueLabel(input: {
  issue: IssueRow;
  label: string;
  row?: LabelRow;
  events: LabelEventRow[];
}): TimelineLabelMembershipInterval[] {
  const intervals: TimelineLabelMembershipInterval[] = [];
  let openStart: number | null = null;
  let openDegraded = false;
  let sawAdd = false;
  let sawRemove = false;

  for (const event of input.events) {
    const payload = parseJsonObject(event.payload_json);
    if (payload.present === true) {
      sawAdd = true;
      if (openStart === null) {
        openStart = event.occurred_at;
        openDegraded = false;
      }
      continue;
    }
    if (payload.present === false) {
      sawRemove = true;
      if (openStart === null) {
        intervals.push({
          issue_id: input.issue.id,
          label: input.label,
          start: input.row?.created_at ?? input.issue.created_at,
          end: event.occurred_at,
          degraded: true,
        });
      } else {
        intervals.push({
          issue_id: input.issue.id,
          label: input.label,
          start: openStart,
          end: event.occurred_at,
          degraded: openDegraded,
        });
      }
      openStart = null;
      openDegraded = false;
    }
  }

  if (openStart !== null) {
    intervals.push({
      issue_id: input.issue.id,
      label: input.label,
      start: openStart,
      end: null,
      degraded: openDegraded,
    });
  }
  if (input.row && input.row.deleted_at === null && !sawAdd) {
    intervals.push({
      issue_id: input.issue.id,
      label: input.label,
      start: input.row.created_at,
      end: null,
      degraded: input.events.length > 0,
    });
  }
  if (input.row && input.row.deleted_at !== null && input.events.length === 0) {
    intervals.push({
      issue_id: input.issue.id,
      label: input.label,
      start: input.row.created_at,
      end: input.row.deleted_at,
      degraded: true,
    });
  }
  if (input.row && input.row.deleted_at !== null && sawAdd && !sawRemove) {
    intervals.push({
      issue_id: input.issue.id,
      label: input.label,
      start: input.row.created_at,
      end: input.row.deleted_at,
      degraded: true,
    });
  }

  return intervals
    .filter((interval) => interval.end === null || interval.start <= interval.end)
    .sort(compareLabelIntervals);
}

export function compareLabelIntervals(
  a: TimelineLabelMembershipInterval,
  b: TimelineLabelMembershipInterval,
): number {
  if (a.start !== b.start) return a.start - b.start;
  const aEnd = a.end ?? Number.POSITIVE_INFINITY;
  const bEnd = b.end ?? Number.POSITIVE_INFINITY;
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.issue_id !== b.issue_id) return a.issue_id.localeCompare(b.issue_id);
  return a.label.localeCompare(b.label);
}
