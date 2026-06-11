import type { Db } from "../db.js";
import type {
  ProjectTimelineInput,
  ProjectTimelineNormalizedInput,
  ProjectTimelineProjection,
  TimelineEventKind,
  TimelineDiagnostic,
  TimelineDiagnostics,
  TimelineEvent,
  TimelineIssuePredicate,
  TimelineIssueRef,
  TimelineLabelMembershipInterval,
  TimelineLabelMembershipMode,
  TimelineLink,
  TimelineNormalizedRowSpec,
  TimelineRowOccurrence,
  TimelineRowOccurrenceKind,
  TimelineRowSpecRef,
  TimelineSourceEntityRef,
  TimelineTimeAxis,
} from "../types.js";
import type {
  LedgerIssue,
  LedgerIssueKind,
  LedgerIssueRelationshipSource,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
  LedgerRelationshipType,
} from "./types.js";
import { LEDGER_ISSUE_KINDS } from "./types.js";

type IssueRow = LedgerIssue & { labels: string };
type ProjectRow = {
  id: string;
  display_name: string;
  repo_id: string | null;
  repo_name: string | null;
  repo_root: string | null;
};
type CommentRow = {
  id: string;
  issue_id: string;
  ordinal: number;
  body: string;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
};
type StateEventRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  source: string;
  payload_json: string;
  occurred_at: number;
  observed_at: number;
};
type LabelRow = {
  issue_id: string;
  label: string;
  created_at: number;
  deleted_at: number | null;
};
type LabelHistoryIndex = {
  intervalsByLabel: Map<string, TimelineLabelMembershipInterval[]>;
};
type InternalRowSpec = TimelineNormalizedRowSpec & {
  anchorIssue: IssueRow | null;
  legacyKind: TimelineRowOccurrenceKind | null;
  emitMembers: boolean;
  labelIntervals: TimelineLabelMembershipInterval[];
};
type PredicateDiagnosticInput = {
  kind: "invalid_predicate" | "unmatched_predicate" | "cycle";
  message: string;
  row_spec_id?: string;
  issue_id?: string;
  target_issue_id?: string;
  predicate?: TimelineIssuePredicate;
  path?: string[];
};
type PredicateEvalContext = {
  allIssues: IssueRow[];
  issueById: Map<string, IssueRow>;
  relationshipSources: LedgerIssueRelationshipSource[];
  parentChildrenByIssueId: Map<string, string[]>;
  residualCoveredIssueIds: Set<string>;
  labelHistory: LabelHistoryIndex;
  window: { from: number | null; to: number | null };
  labelMembershipModeOverride?: TimelineLabelMembershipMode;
};

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 8;
const DEFAULT_STATUSES: LedgerIssueStatus[] = ["open"];
const DEFAULT_EVENT_KINDS: TimelineEventKind[] = [
  "auth_request",
  "body",
  "comment",
  "commit",
  "issue_state",
  "label",
];
const VALID_EVENT_KINDS = new Set<TimelineEventKind>([
  "auth_request",
  "backlink",
  "body",
  "comment",
  "commit",
  "issue_state",
  "label",
  "session",
  "state",
  "work_unit",
]);
const STATE_EVENT_TYPES_BY_KIND: Record<TimelineEventKind, string[]> = {
  auth_request: ["auth_request.issue_linked", "auth_request.completed"],
  backlink: [],
  body: [],
  comment: [],
  commit: ["commit.issue_linked"],
  issue_state: ["issue.updated", "issue.closed", "issue.reopened"],
  label: ["label.updated"],
  session: ["session.issue_linked"],
  state: ["issue.updated", "issue.closed", "issue.reopened"],
  work_unit: ["work_unit.issue_linked"],
};

export function buildProjectTimelineProjection(
  db: Db,
  input: ProjectTimelineInput,
): ProjectTimelineProjection {
  const project = resolveProject(db, input);
  const issues = loadIssues(db, project.id);
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const issueRefs = new Map(issues.map((issue) => [issue.id, issueRef(issue)]));
  const normalized = normalizeInput(input, project.id, issueById);
  const relationshipSources = loadRelationshipSources(db, project.id);
  const labelHistory = loadLabelHistory(db, project.id, issues);
  const relationshipSourcesByEventSource = groupRelationshipSources(relationshipSources);
  const referenceCounts = countActiveTargets(relationshipSources);
  const rows: TimelineRowOccurrence[] = [];
  const events: TimelineEvent[] = [];
  const links: TimelineLink[] = [];
  const cycles: TimelineDiagnostic[] = [];
  const depthLimits: TimelineDiagnostic[] = [];
  const filteredTargets: TimelineDiagnostic[] = [];
  const missingExpansions: TimelineDiagnostic[] = [];
  const predicateDiagnostics: TimelineDiagnostic[] = [];
  const childRowIdsByParent = new Map<string, string[]>();
  const expandedEvents = new Set(normalized.expanded_event_ids);
  const expandedPaths = new Set(normalized.expanded_paths);
  const expandedEventHits = new Set<string>();
  const visibleIssueIds = new Set<string>();
  const rootOccurrencesByIssue = new Map<string, number>();
  const eventToLinks = new Map<string, TimelineLink[]>();
  const rowById = new Map<string, TimelineRowOccurrence>();

  const parentChildrenByIssueId = buildParentChildrenByIssueId(issues);
  const rootSpecs = buildRootSpecs({
    rawInput: input,
    normalized,
    issues,
    issueById,
    relationshipSources,
    parentChildrenByIssueId,
    labelHistory,
    diagnostics: predicateDiagnostics,
  });
  normalized.root_specs = hasRootSpecInput(input) ? rootSpecs.map(normalizedSpec) : [];
  rootSpecs.forEach((spec, index) => {
    if (spec.anchorIssue) {
      addIssueRow(
        spec.anchorIssue,
        spec.legacyKind ?? "root",
        null,
        null,
        0,
        [`root:${spec.anchorIssue.id}:${index}`],
        false,
        null,
      );
      return;
    }
    if (!spec.emitMembers || !spec.scope) {
      addFilterRootRow(spec, index);
      return;
    }
    const memberIds = evaluateRootScope(spec, {
      allIssues: issues,
      issueById,
      relationshipSources,
      parentChildrenByIssueId,
      labelHistory,
      window: { from: normalized.from, to: normalized.to },
      residualCoveredIssueIds: residualCoveredIssueIds(rootSpecs, spec, {
        allIssues: issues,
        issueById,
        relationshipSources,
        parentChildrenByIssueId,
        labelHistory,
        window: { from: normalized.from, to: normalized.to },
        residualCoveredIssueIds: new Set<string>(),
        labelMembershipModeOverride: "now",
      }, predicateDiagnostics),
    }, predicateDiagnostics);
    const memberIssues = Array.from(memberIds)
      .map((id) => issueById.get(id))
      .filter((issue): issue is IssueRow => (
        !!issue && issue.deleted_at === null && statusAllowed(issue.status, normalized)
      ))
      .sort(compareIssues);
    spec.labelIntervals = labelIntervalsForPredicate(
      spec.scope,
      new Set(memberIssues.map((issue) => issue.id)),
      labelHistory,
      {
        from: normalized.from,
        to: normalized.to,
      },
    );
    const filterRoot = addFilterRootRow(spec, index);
    memberIssues.forEach((issue) => {
        const cycle = filterRoot.path.includes(`issue:${issue.id}`);
        const member = addIssueRow(
          issue,
          "member",
          filterRoot.id,
          null,
          1,
          [`spec:${spec.id}`, `member:${issue.id}`],
          cycle,
          rowSpecRef(spec),
        );
        if (cycle) {
          cycles.push({
            kind: "cycle",
            message: "RowSpec member issue is already present in this row occurrence path.",
            row_id: member.id,
            issue_id: issue.id,
            target_issue_id: issue.id,
            depth: 1,
            path: member.path,
          });
        }
      });
  });

  for (let cursor = 0; cursor < rows.length; cursor += 1) {
    const row = rows[cursor];
    const rowEvents = buildEventsForRow(db, row, issueById, issueRefs, normalized);
    for (const event of rowEvents) {
      const eventSourceKey = sourceKey(event.source_entity.type, event.source_entity.id);
      const sourceRows = relationshipSourcesByEventSource.get(eventSourceKey) ?? [];
      const eventLinks: TimelineLink[] = [];
      for (const source of sourceRows) {
        const target = issueById.get(source.target_issue_id);
        if (!target) continue;
        const targetRef = issueRefs.get(target.id);
        const sourceRef = issueRefs.get(source.source_issue_id);
        if (!targetRef || !sourceRef) continue;
        const link: TimelineLink = {
          id: `link:${event.id}:${source.id}`,
          event_id: event.id,
          source_row_id: row.id,
          source_entity: event.source_entity,
          source_issue: sourceRef,
          target_issue: targetRef,
          relationship_id: source.relationship_id,
          relationship_type: source.relationship_type,
          ref_kind: source.ref_kind,
          raw_ref: source.raw_ref,
          normalized_ref: source.normalized_ref,
          derived: true,
          expanded_row_id: null,
          created_at: source.created_at,
        };
        eventLinks.push(link);
        links.push(link);

        const expandByEvent = expandedEvents.has(event.id);
        const expandByPath = expandedPaths.has(row.id) || expandedPaths.has(`${row.id}>${event.id}`);
        if (expandByEvent || expandByPath) {
          expandedEventHits.add(event.id);
          const childDepth = row.depth + 1;
          if (target.deleted_at !== null) {
            filteredTargets.push({
              kind: "deleted_target",
              message: "Expanded target issue is deleted and was not added as a visible row.",
              row_id: row.id,
              event_id: event.id,
              target_issue_id: target.id,
              depth: childDepth,
              path: row.path,
            });
          } else if (!statusAllowed(target.status, normalized)) {
            filteredTargets.push({
              kind: "filtered_target",
              message: "Expanded target issue is outside the timeline status filter.",
              row_id: row.id,
              event_id: event.id,
              target_issue_id: target.id,
              depth: childDepth,
              path: row.path,
            });
          } else if (childDepth > normalized.depth) {
            depthLimits.push({
              kind: "depth_limit",
              message: "Expanded target issue was not added because the depth limit was reached.",
              row_id: row.id,
              event_id: event.id,
              target_issue_id: target.id,
              depth: childDepth,
              path: row.path,
            });
          } else {
            const cycle = row.path.some((segment) => segment === `issue:${target.id}`);
            const child = addIssueRow(
              target,
              "transient",
              row.id,
              event.id,
              childDepth,
              [...row.path, `event:${event.id}`, `issue:${target.id}`],
              cycle,
              null,
            );
            link.expanded_row_id = child.id;
            if (cycle) {
              cycles.push({
                kind: "cycle",
                message: "Expansion reaches an issue already present in this row occurrence path.",
                row_id: child.id,
                event_id: event.id,
                issue_id: target.id,
                target_issue_id: target.id,
                depth: childDepth,
                path: child.path,
              });
            }
          }
        }
      }
      event.link_ids = eventLinks.map((link) => link.id);
      eventToLinks.set(event.id, eventLinks);
      events.push(event);
    }
  }

  for (const eventId of normalized.expanded_event_ids) {
    if (!eventToLinks.has(eventId) && !expandedEventHits.has(eventId)) {
      missingExpansions.push({
        kind: "missing_expansion_event",
        message: "Requested expanded event was not found in the visible projection.",
        event_id: eventId,
      });
    }
  }

  const orderedRows = orderRowsPreorder(rows, childRowIdsByParent);

  for (const row of orderedRows) {
    if (row.issue) visibleIssueIds.add(row.issue.id);
    if (row.issue && (row.kind === "root" || row.kind === "promoted_root" || row.kind === "explicit_root")) {
      rootOccurrencesByIssue.set(row.issue.id, (rootOccurrencesByIssue.get(row.issue.id) ?? 0) + 1);
    }
    const rowLinks = links.filter((link) => link.source_row_id === row.id);
    row.expanded = rowLinks.some((link) => link.expanded_row_id !== null)
      || (childRowIdsByParent.get(row.id)?.length ?? 0) > 0;
    rowById.set(row.id, row);
  }

  if (normalized.event_kinds.includes("backlink")) {
    events.push(...buildBacklinkEvents({
      db,
      relationshipSources,
      orderedRows,
      issueById,
      issueRefs,
      normalized,
    }));
  }

  events.sort(compareTimelineEvents);
  links.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  return {
    project,
    inputs: normalized,
    time_axis: timeAxis(events),
    rows: orderedRows,
    events,
    links,
    diagnostics: buildDiagnostics({
      issues,
      rows: orderedRows,
      visibleIssueIds,
      relationshipSources,
      referenceCounts,
      rootOccurrencesByIssue,
      cycles,
      depthLimits,
      filteredTargets,
      missingExpansions,
      predicateDiagnostics,
    }),
  };

  function addIssueRow(
    issue: IssueRow,
    kind: TimelineRowOccurrenceKind,
    parentRowId: string | null,
    sourceEventId: string | null,
    depth: number,
    path: string[],
    cycle: boolean,
    rowSpec: TimelineRowSpecRef | null,
  ): TimelineRowOccurrence {
    const occurrencePath = path.join("/");
    const row: TimelineRowOccurrence = {
      id: `row:${occurrencePath}`,
      issue: issueRefs.get(issue.id) ?? issueRef(issue),
      kind,
      parent_row_id: parentRowId,
      source_event_id: sourceEventId,
      depth,
      path: [`issue:${issue.id}`, ...path],
      expanded: false,
      cycle,
      hidden_reason: null,
      ...(rowSpec ? { row_spec: rowSpec } : {}),
    };
    rows.push(row);
    if (parentRowId !== null) {
      const siblings = childRowIdsByParent.get(parentRowId) ?? [];
      siblings.push(row.id);
      childRowIdsByParent.set(parentRowId, siblings);
    }
    return row;
  }

  function addFilterRootRow(spec: InternalRowSpec, index: number): TimelineRowOccurrence {
    const occurrencePath = `spec:${spec.id}:${index}`;
    const row: TimelineRowOccurrence = {
      id: `row:${occurrencePath}`,
      issue: null,
      row_spec: rowSpecRef(spec),
      kind: "root",
      parent_row_id: null,
      source_event_id: null,
      depth: 0,
      path: [`rowspec:${spec.id}`],
      expanded: false,
      cycle: false,
      hidden_reason: null,
    };
    rows.push(row);
    return row;
  }
}

function orderRowsPreorder(
  rows: TimelineRowOccurrence[],
  childRowIdsByParent: Map<string, string[]>,
): TimelineRowOccurrence[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const ordered: TimelineRowOccurrence[] = [];
  const visited = new Set<string>();

  const visit = (row: TimelineRowOccurrence) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    ordered.push(row);
    for (const childId of childRowIdsByParent.get(row.id) ?? []) {
      const child = rowById.get(childId);
      if (child) visit(child);
    }
  };

  for (const row of rows) {
    if (row.parent_row_id === null) visit(row);
  }
  for (const row of rows) {
    visit(row);
  }

  return ordered;
}

function normalizeInput(
  input: ProjectTimelineInput,
  projectId: string,
  issues: Map<string, IssueRow>,
): ProjectTimelineNormalizedInput {
  const includeClosed = input.include_closed === true;
  const statuses = normalizeStatuses(input.statuses, includeClosed);
  return {
    project_id: projectId,
    root_policy: input.root_policy ?? "coordination_and_explicit",
    root_specs: [],
    explicit_root_issue_ids: normalizeIssueIds(input.explicit_root_issue_ids, issues),
    promoted_root_issue_ids: normalizeIssueIds(input.promoted_root_issue_ids, issues),
    expanded_event_ids: uniqueStrings(input.expanded_event_ids),
    expanded_paths: uniqueStrings(input.expanded_paths),
    include_closed: includeClosed,
    statuses,
    event_kinds: normalizeEventKinds(input.event_kinds),
    depth: clampDepth(input.depth),
    from: numberOrNull(input.from),
    to: numberOrNull(input.to),
  };
}

function resolveProject(db: Db, input: ProjectTimelineInput): ProjectRow {
  const ref = input.project_id ?? input.project_ref;
  if (!ref) throw new Error("project_id or project_ref is required");
  const row = db.prepare(
    `SELECT p.id, p.display_name,
            COALESCE(c.work_repo_id, NULL) AS repo_id,
            COALESCE(c.name, NULL) AS repo_name,
            COALESCE(c.root, NULL) AS repo_root
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id
      WHERE p.id = ? OR p.display_name = ? OR c.work_repo_id = ? OR c.name = ? OR c.root = ?
      ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END, c.created_at ASC
      LIMIT 1`,
  ).get(ref, ref, ref, ref, ref, ref) as ProjectRow | undefined;
  if (!row) throw new Error("timeline project not found");
  return row;
}

function loadIssues(db: Db, projectId: string): IssueRow[] {
  return db.prepare(
    `SELECT i.*,
            COALESCE(group_concat(l.label, char(31)), '') AS labels
       FROM ledger_issues i
       LEFT JOIN ledger_labels l ON l.issue_id = i.id AND l.deleted_at IS NULL
      WHERE i.project_id = ?
      GROUP BY i.id
      ORDER BY i.created_at ASC, i.short_id ASC, i.id ASC`,
  ).all(projectId) as IssueRow[];
}

function loadRelationshipSources(db: Db, projectId: string): LedgerIssueRelationshipSource[] {
  return db.prepare(
    `SELECT s.*
       FROM ledger_issue_relationship_sources s
       JOIN ledger_issues source ON source.id = s.source_issue_id
      WHERE source.project_id = ?
        AND s.relationship_type = 'references'
        AND s.deleted_at IS NULL
      ORDER BY s.created_at ASC, s.id ASC`,
  ).all(projectId) as LedgerIssueRelationshipSource[];
}

function loadLabelHistory(db: Db, projectId: string, issues: IssueRow[]): LabelHistoryIndex {
  const labelRows = db.prepare(
    `SELECT l.issue_id, l.label, l.created_at, l.deleted_at
       FROM ledger_labels l
       JOIN ledger_issues i ON i.id = l.issue_id
      WHERE i.project_id = ?
      ORDER BY l.issue_id ASC, l.label ASC, l.created_at ASC`,
  ).all(projectId) as LabelRow[];
  const labelEvents = db.prepare(
    `SELECT e.id, e.entity_type, e.entity_id, e.event_type, e.source, e.payload_json, e.occurred_at, e.observed_at
       FROM ledger_events e
       JOIN ledger_issues i ON i.id = e.entity_id
      WHERE i.project_id = ?
        AND e.entity_type = 'issue'
        AND e.event_type = 'label.updated'
      ORDER BY e.entity_id ASC, e.occurred_at ASC, e.observed_at ASC, e.id ASC`,
  ).all(projectId) as StateEventRow[];
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const eventsByIssueLabel = new Map<string, StateEventRow[]>();
  for (const event of labelEvents) {
    const payload = parseJsonObject(event.payload_json);
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    if (!label || !issueById.has(event.entity_id)) continue;
    const key = issueLabelKey(event.entity_id, label);
    const events = eventsByIssueLabel.get(key) ?? [];
    events.push(event);
    eventsByIssueLabel.set(key, events);
  }

  const keys = new Set<string>([
    ...labelRows.map((row) => issueLabelKey(row.issue_id, row.label)),
    ...eventsByIssueLabel.keys(),
  ]);
  const intervalsByLabel = new Map<string, TimelineLabelMembershipInterval[]>();
  const rowByKey = new Map(labelRows.map((row) => [issueLabelKey(row.issue_id, row.label), row]));

  for (const key of keys) {
    const row = rowByKey.get(key);
    const events = eventsByIssueLabel.get(key) ?? [];
    const [issueId, label] = splitIssueLabelKey(key);
    const issue = issueById.get(issueId);
    if (!issue) continue;
    const intervals = intervalsForIssueLabel({ issue, label, row, events });
    const labelIntervals = intervalsByLabel.get(label) ?? [];
    labelIntervals.push(...intervals);
    intervalsByLabel.set(label, labelIntervals);
  }

  for (const intervals of intervalsByLabel.values()) intervals.sort(compareLabelIntervals);
  return { intervalsByLabel };
}

function intervalsForIssueLabel(input: {
  issue: IssueRow;
  label: string;
  row?: LabelRow;
  events: StateEventRow[];
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

function labelIntervalsForPredicate(
  predicate: TimelineIssuePredicate | null,
  issueIds: Set<string>,
  labelHistory: LabelHistoryIndex,
  window: { from: number | null; to: number | null },
): TimelineLabelMembershipInterval[] {
  const labels = labelsInPredicate(predicate);
  if (labels.size === 0 || issueIds.size === 0) return [];
  const intervals: TimelineLabelMembershipInterval[] = [];
  for (const label of labels) {
    for (const interval of labelHistory.intervalsByLabel.get(label) ?? []) {
      if (!issueIds.has(interval.issue_id) || !intervalOverlapsWindow(interval, window)) continue;
      intervals.push(interval);
    }
  }
  return intervals.sort(compareLabelIntervals);
}

function labelsInPredicate(predicate: TimelineIssuePredicate | null): Set<string> {
  const labels = new Set<string>();
  if (!predicate) return labels;
  if (predicate.type === "label") {
    const name = typeof predicate.name === "string" ? predicate.name.trim() : "";
    if (name) labels.add(name);
  } else if (predicate.type === "and" || predicate.type === "or") {
    for (const child of predicate.predicates) {
      for (const label of labelsInPredicate(child)) labels.add(label);
    }
  } else if (predicate.type === "not") {
    for (const label of labelsInPredicate(predicate.predicate)) labels.add(label);
  }
  return labels;
}

function intervalOverlapsWindow(
  interval: TimelineLabelMembershipInterval,
  window: { from: number | null; to: number | null },
): boolean {
  const end = interval.end ?? Number.POSITIVE_INFINITY;
  if (window.from !== null && end < window.from) return false;
  if (window.to !== null && interval.start > window.to) return false;
  return true;
}

function groupRelationshipSources(
  sources: LedgerIssueRelationshipSource[],
): Map<string, LedgerIssueRelationshipSource[]> {
  const groups = new Map<string, LedgerIssueRelationshipSource[]>();
  for (const source of sources) {
    const key = sourceKey(source.source_entity_type, source.source_entity_id);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  return groups;
}

function selectRootIssues(
  issues: IssueRow[],
  input: ProjectTimelineNormalizedInput,
): IssueRow[] {
  const explicit = new Set([...input.explicit_root_issue_ids, ...input.promoted_root_issue_ids]);
  return issues.filter((issue) => {
    if (issue.deleted_at !== null || !statusAllowed(issue.status, input)) return false;
    const labels = labelList(issue);
    const coordination = labels.includes("coordination");
    if (input.root_policy === "coordination") return coordination || input.promoted_root_issue_ids.includes(issue.id);
    if (input.root_policy === "explicit") return explicit.has(issue.id);
    return coordination || explicit.has(issue.id);
  });
}

function buildRootSpecs(input: {
  rawInput: ProjectTimelineInput;
  normalized: ProjectTimelineNormalizedInput;
  issues: IssueRow[];
  issueById: Map<string, IssueRow>;
  relationshipSources: LedgerIssueRelationshipSource[];
  parentChildrenByIssueId: Map<string, string[]>;
  labelHistory: LabelHistoryIndex;
  diagnostics: TimelineDiagnostic[];
}): InternalRowSpec[] {
  const explicitSpecs = input.rawInput.root_specs ?? input.rawInput.root_row_specs;
  if (!explicitSpecs?.length) {
    return selectRootIssues(input.issues, input.normalized).map((issue, index) => ({
      id: `legacy:${issue.id}:${index}`,
      title: issue.title,
      anchor_issue_id: issue.id,
      scope: labelList(issue).includes("coordination")
        ? { type: "referenced_by", issue_id: issue.id }
        : null,
      anchorIssue: issue,
      legacyKind: rootKind(issue.id, input.normalized),
      emitMembers: false,
      labelIntervals: [],
    }));
  }

  return explicitSpecs.map((spec, index) => {
    const anchorRef = spec.anchor_issue_id ?? spec.anchor ?? null;
    const anchorIssue = typeof anchorRef === "string"
      ? input.issueById.get(resolveIssueId(anchorRef, input.issueById) ?? "") ?? null
      : null;
    const id = cleanSpecId(spec.id) ?? `input:${index}`;
    if (anchorRef && !anchorIssue) {
      input.diagnostics.push(predicateDiagnostic({
        kind: "invalid_predicate",
        message: "RowSpec anchor issue was not found.",
        row_spec_id: id,
        issue_id: anchorRef,
      }));
    }
    const normalized: InternalRowSpec = {
      id,
      title: spec.title?.trim() || anchorIssue?.title || `Filter ${index + 1}`,
      anchor_issue_id: anchorIssue?.id ?? null,
      scope: normalizePredicate(spec.scope ?? null),
      anchorIssue,
      legacyKind: null,
      emitMembers: anchorIssue === null,
      labelIntervals: [],
    };
    if (!normalized.anchorIssue && !normalized.scope) {
      input.diagnostics.push(predicateDiagnostic({
        kind: "invalid_predicate",
        message: "Anchor-less RowSpec requires a scope predicate.",
        row_spec_id: id,
      }));
    }
    return normalized;
  });
}

function hasRootSpecInput(input: ProjectTimelineInput): boolean {
  return (input.root_specs?.length ?? input.root_row_specs?.length ?? 0) > 0;
}

function normalizedSpec(spec: InternalRowSpec): TimelineNormalizedRowSpec {
  return {
    id: spec.id,
    title: spec.title,
    anchor_issue_id: spec.anchor_issue_id,
    scope: spec.scope,
  };
}

function rowSpecRef(spec: InternalRowSpec): TimelineRowSpecRef {
  return {
    ...normalizedSpec(spec),
    ...(spec.labelIntervals.length > 0 ? { label_intervals: spec.labelIntervals } : {}),
  };
}

function evaluateRootScope(
  spec: InternalRowSpec,
  context: PredicateEvalContext,
  diagnostics: TimelineDiagnostic[],
): Set<string> {
  if (!spec.scope) return new Set<string>();
  const result = evaluatePredicate(spec.scope, context, spec.id, diagnostics);
  if (result.size === 0) {
    diagnostics.push(predicateDiagnostic({
      kind: "unmatched_predicate",
      message: "RowSpec scope did not match any issues.",
      row_spec_id: spec.id,
      predicate: spec.scope,
    }));
  }
  return result;
}

function evaluatePredicate(
  predicate: TimelineIssuePredicate,
  context: PredicateEvalContext,
  rowSpecId: string,
  diagnostics: TimelineDiagnostic[],
): Set<string> {
  if (!predicate || typeof predicate !== "object" || typeof predicate.type !== "string") {
    diagnostics.push(predicateDiagnostic({
      kind: "invalid_predicate",
      message: "RowSpec predicate must be an object with a type.",
      row_spec_id: rowSpecId,
    }));
    return new Set<string>();
  }
  switch (predicate.type) {
    case "referenced_by": {
      if (typeof predicate.issue_id !== "string") {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "referenced_by predicate requires an issue_id string.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const sourceId = resolveIssueId(predicate.issue_id, context.issueById);
      if (!sourceId) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "referenced_by predicate source issue was not found.",
          row_spec_id: rowSpecId,
          issue_id: predicate.issue_id,
          predicate,
        }));
        return new Set<string>();
      }
      return new Set(context.relationshipSources
        .filter((source) => source.source_issue_id === sourceId)
        .map((source) => source.target_issue_id));
    }
    case "label": {
      if (typeof predicate.name !== "string") {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "label predicate requires a name string.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const name = predicate.name.trim();
      if (!name) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "label predicate requires a non-empty name.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const membership = context.labelMembershipModeOverride ?? normalizeLabelMembershipMode(predicate.membership);
      if (membership === "ever_in_window") {
        return new Set((context.labelHistory.intervalsByLabel.get(name) ?? [])
          .filter((interval) => intervalOverlapsWindow(interval, context.window))
          .map((interval) => interval.issue_id));
      }
      return new Set(context.allIssues
        .filter((issue) => labelList(issue).includes(name))
        .map((issue) => issue.id));
    }
    case "kind": {
      if (typeof predicate.kind !== "string" || !LEDGER_ISSUE_KINDS.includes(predicate.kind as LedgerIssueKind)) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "kind predicate used an unknown issue kind.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      return new Set(context.allIssues
        .filter((issue) => issue.kind === predicate.kind)
        .map((issue) => issue.id));
    }
    case "parent_subtree": {
      if (typeof predicate.issue_id !== "string") {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "parent_subtree predicate requires an issue_id string.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const rootId = resolveIssueId(predicate.issue_id, context.issueById);
      if (!rootId) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "parent_subtree predicate root issue was not found.",
          row_spec_id: rowSpecId,
          issue_id: predicate.issue_id,
          predicate,
        }));
        return new Set<string>();
      }
      return parentSubtreeIssueIds(rootId, context, rowSpecId, predicate, diagnostics);
    }
    case "residual":
      return new Set(context.allIssues
        .map((issue) => issue.id)
        .filter((id) => !context.residualCoveredIssueIds.has(id)));
    case "and": {
      if (!Array.isArray(predicate.predicates) || !predicate.predicates.length) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "and predicate requires at least one child predicate.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const [first, ...rest] = predicate.predicates.map((child) => (
        evaluatePredicate(child, context, rowSpecId, diagnostics)
      ));
      return rest.reduce((acc, next) => intersection(acc, next), first ?? new Set<string>());
    }
    case "or": {
      if (!Array.isArray(predicate.predicates) || !predicate.predicates.length) {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "or predicate requires at least one child predicate.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      return predicate.predicates.reduce((acc, child) => (
        union(acc, evaluatePredicate(child, context, rowSpecId, diagnostics))
      ), new Set<string>());
    }
    case "not": {
      if (!predicate.predicate || typeof predicate.predicate !== "object") {
        diagnostics.push(predicateDiagnostic({
          kind: "invalid_predicate",
          message: "not predicate requires a child predicate.",
          row_spec_id: rowSpecId,
          predicate,
        }));
        return new Set<string>();
      }
      const excluded = evaluatePredicate(predicate.predicate, context, rowSpecId, diagnostics);
      return new Set(context.allIssues.map((issue) => issue.id).filter((id) => !excluded.has(id)));
    }
    default:
      diagnostics.push(predicateDiagnostic({
        kind: "invalid_predicate",
        message: "RowSpec predicate type is not supported.",
        row_spec_id: rowSpecId,
        predicate,
      }));
      return new Set<string>();
  }
}

function residualCoveredIssueIds(
  specs: InternalRowSpec[],
  residualSpec: InternalRowSpec,
  context: PredicateEvalContext,
  diagnostics: TimelineDiagnostic[],
): Set<string> {
  const covered = new Set<string>();
  for (const spec of specs) {
    if (spec.id === residualSpec.id || !spec.scope || containsResidualPredicate(spec.scope)) continue;
    for (const issueId of evaluatePredicate(spec.scope, context, spec.id, diagnostics)) {
      covered.add(issueId);
    }
  }
  return covered;
}

function containsResidualPredicate(predicate: TimelineIssuePredicate): boolean {
  if (predicate.type === "residual") return true;
  if (predicate.type === "and" || predicate.type === "or") {
    return predicate.predicates.some(containsResidualPredicate);
  }
  if (predicate.type === "not") return containsResidualPredicate(predicate.predicate);
  return false;
}

function buildParentChildrenByIssueId(issues: IssueRow[]): Map<string, string[]> {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const children = new Map<string, string[]>();
  for (const issue of issues) {
    for (const label of labelList(issue)) {
      if (!label.startsWith("parent:")) continue;
      const parentId = resolveIssueId(label.slice("parent:".length), issueById);
      if (!parentId) continue;
      const list = children.get(parentId) ?? [];
      list.push(issue.id);
      children.set(parentId, list);
    }
  }
  for (const list of children.values()) list.sort();
  return children;
}

function parentSubtreeIssueIds(
  rootId: string,
  context: PredicateEvalContext,
  rowSpecId: string,
  predicate: TimelineIssuePredicate,
  diagnostics: TimelineDiagnostic[],
): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (issueId: string, path: string[]) => {
    if (visiting.has(issueId)) {
      diagnostics.push(predicateDiagnostic({
        kind: "cycle",
        message: "parent_subtree predicate encountered a parent-label cycle.",
        row_spec_id: rowSpecId,
        issue_id: issueId,
        target_issue_id: issueId,
        predicate,
        path,
      }));
      return;
    }
    if (visited.has(issueId)) return;
    visiting.add(issueId);
    for (const childId of context.parentChildrenByIssueId.get(issueId) ?? []) {
      result.add(childId);
      visit(childId, [...path, `issue:${childId}`]);
    }
    visiting.delete(issueId);
    visited.add(issueId);
  };

  visit(rootId, [`issue:${rootId}`]);
  return result;
}

function rootKind(issueId: string, input: ProjectTimelineNormalizedInput): TimelineRowOccurrenceKind {
  if (input.promoted_root_issue_ids.includes(issueId)) return "promoted_root";
  if (input.explicit_root_issue_ids.includes(issueId)) return "explicit_root";
  return "root";
}

function buildEventsForRow(
  db: Db,
  row: TimelineRowOccurrence,
  issueById: Map<string, IssueRow>,
  issueRefs: Map<string, TimelineIssueRef>,
  input: ProjectTimelineNormalizedInput,
): TimelineEvent[] {
  if (!row.issue) return [];
  const issue = issueById.get(row.issue.id);
  if (!issue) return [];
  const result: TimelineEvent[] = [];
  if (eventKindEnabled(input, "body")) {
    addIfInWindow(result, {
      id: `event:${row.id}:body`,
      row_id: row.id,
      issue: issueRefs.get(issue.id) ?? issueRef(issue),
      source_entity: { type: "issue_body", id: issue.id, issue_id: issue.id },
      kind: "body",
      timestamp: issue.created_at,
      ordinal: 0,
      ...headlineForText(issue.title, issue.body),
      body: issue.body,
      state: null,
      backlink: null,
      link_ids: [],
    }, input);
  }

  const comments = eventKindEnabled(input, "comment")
    ? db.prepare(
      `SELECT id, issue_id, ordinal, body, created_at, updated_at, deleted_at
         FROM ledger_comments
        WHERE issue_id = ? AND deleted_at IS NULL
        ORDER BY ordinal ASC, created_at ASC`,
    ).all(issue.id) as CommentRow[]
    : [];
  if (eventKindEnabled(input, "comment")) {
    for (const comment of comments) {
      addIfInWindow(result, {
        id: `event:${row.id}:comment:${comment.id}`,
        row_id: row.id,
        issue: issueRefs.get(issue.id) ?? issueRef(issue),
        source_entity: { type: "comment", id: comment.id, issue_id: issue.id },
        kind: "comment",
        timestamp: comment.created_at,
        ordinal: comment.ordinal,
        ...headlineForText(issue.title, comment.body),
        body: comment.body,
        state: null,
        backlink: null,
        link_ids: [],
      }, input);
    }
  }

  const stateEventTypes = selectedStateEventTypes(input);
  if (stateEventTypes.length === 0) return result.sort(compareTimelineEvents);
  const stateEvents = db.prepare(
    `SELECT id, entity_type, entity_id, event_type, source, payload_json, occurred_at, observed_at
       FROM ledger_events
      WHERE (
          entity_type = 'issue'
          AND entity_id = ?
        )
        AND event_type IN (${stateEventTypes.map(() => "?").join(", ")})
      UNION ALL
      SELECT id, entity_type, entity_id, event_type, source, payload_json, occurred_at, observed_at
        FROM ledger_events
       WHERE event_type IN (${stateEventTypes.map(() => "?").join(", ")})
         AND entity_type != 'issue'
      ORDER BY occurred_at ASC, observed_at ASC, id ASC`,
  ).all(issue.id, ...stateEventTypes, ...stateEventTypes) as StateEventRow[];
  let stateOrdinal = comments.length + 1;
  const hasAuthCompletion = stateEvents.some((event) => (
    event.event_type === "auth_request.completed"
    && stateEventBelongsToIssue(event, issue.id)
  ));
  for (const event of stateEvents) {
    if (!stateEventBelongsToIssue(event, issue.id)) continue;
    if (event.event_type === "issue.closed" && event.source === "auth_queue" && hasAuthCompletion) continue;
    const parsed = parseStatePayload(event);
    if (!parsed) continue;
    addIfInWindow(result, {
      id: `event:${row.id}:state:${event.id}`,
      row_id: row.id,
      issue: issueRefs.get(issue.id) ?? issueRef(issue),
      source_entity: { type: "issue_state", id: event.id, issue_id: issue.id },
      kind: "state",
      timestamp: event.occurred_at,
      ordinal: stateOrdinal,
      display_headline: parsed.headline,
      headline_source: "state",
      body: null,
      state: {
        event_type: event.event_type,
        status: parsed.status,
        resolution: parsed.resolution,
        payload: parsed.payload,
      },
      backlink: null,
      link_ids: [],
    }, input);
    stateOrdinal += 1;
  }

  return result.sort(compareTimelineEvents);
}

function eventKindEnabled(input: ProjectTimelineNormalizedInput, kind: TimelineEventKind): boolean {
  return input.event_kinds.includes(kind);
}

function selectedStateEventTypes(input: ProjectTimelineNormalizedInput): string[] {
  const eventTypes = new Set<string>();
  for (const kind of input.event_kinds) {
    for (const eventType of STATE_EVENT_TYPES_BY_KIND[kind]) eventTypes.add(eventType);
  }
  return Array.from(eventTypes).sort();
}

function stateEventBelongsToIssue(event: StateEventRow, issueId: string): boolean {
  if (event.entity_type === "issue") return event.entity_id === issueId;
  return parseJsonObject(event.payload_json).issue_id === issueId;
}

function buildBacklinkEvents(input: {
  db: Db;
  relationshipSources: LedgerIssueRelationshipSource[];
  orderedRows: TimelineRowOccurrence[];
  issueById: Map<string, IssueRow>;
  issueRefs: Map<string, TimelineIssueRef>;
  normalized: ProjectTimelineNormalizedInput;
}): TimelineEvent[] {
  const backlinkEvents: TimelineEvent[] = [];
  const targetRows = new Map<string, TimelineRowOccurrence[]>();
  for (const row of input.orderedRows) {
    if (!row.issue) continue;
    const rows = targetRows.get(row.issue.id) ?? [];
    rows.push(row);
    targetRows.set(row.issue.id, rows);
  }

  for (const source of input.relationshipSources) {
    const rows = targetRows.get(source.target_issue_id) ?? [];
    if (rows.length === 0) continue;
    const sourceIssue = input.issueRefs.get(source.source_issue_id);
    const targetIssue = input.issueRefs.get(source.target_issue_id);
    const sourceEntity = sourceEntityForRelationshipSource(source);
    if (!sourceIssue || !targetIssue || !sourceEntity) continue;
    const sourceTimestamp = sourceTimestampForRelationshipSource(source, input.db, input.issueById);
    for (const row of rows) {
      addIfInWindow(backlinkEvents, {
        id: `event:${row.id}:backlink:${source.id}`,
        row_id: row.id,
        issue: targetIssue,
        source_entity: sourceEntity,
        kind: "backlink",
        timestamp: sourceTimestamp,
        ordinal: Number.MAX_SAFE_INTEGER,
        display_headline: `Referenced by ${sourceIssue.display_id}`,
        headline_source: "backlink",
        body: source.raw_ref,
        state: null,
        backlink: {
          relationship_source_id: source.id,
          relationship_id: source.relationship_id,
          relationship_type: source.relationship_type,
          source_issue: sourceIssue,
          target_issue: targetIssue,
          source_entity: sourceEntity,
          ref_kind: source.ref_kind,
          raw_ref: source.raw_ref,
          normalized_ref: source.normalized_ref,
          derived: true,
        },
        link_ids: [],
      }, input.normalized);
    }
  }

  return backlinkEvents.sort(compareTimelineEvents);
}

function sourceEntityForRelationshipSource(
  source: LedgerIssueRelationshipSource,
): TimelineSourceEntityRef | null {
  if (source.source_entity_type === "issue_body") {
    return { type: "issue_body", id: source.source_entity_id, issue_id: source.source_issue_id };
  }
  if (source.source_entity_type === "comment") {
    return { type: "comment", id: source.source_entity_id, issue_id: source.source_issue_id };
  }
  return null;
}

function sourceTimestampForRelationshipSource(
  source: LedgerIssueRelationshipSource,
  db: Db,
  issueById: Map<string, IssueRow>,
): number {
  const sourceIssue = issueById.get(source.source_issue_id);
  if (source.source_entity_type === "issue_body" && sourceIssue) return sourceIssue.created_at;
  if (source.source_entity_type === "comment") {
    const comment = db.prepare(
      `SELECT created_at
         FROM ledger_comments
        WHERE id = ? AND issue_id = ? AND deleted_at IS NULL`,
    ).get(source.source_entity_id, source.source_issue_id) as Pick<CommentRow, "created_at"> | undefined;
    if (comment) return comment.created_at;
  }
  return source.created_at;
}

function addIfInWindow(events: TimelineEvent[], event: TimelineEvent, input: ProjectTimelineNormalizedInput): void {
  if (input.from !== null && event.timestamp < input.from) return;
  if (input.to !== null && event.timestamp > input.to) return;
  events.push(event);
}

function parseStatePayload(event: StateEventRow): {
  status: LedgerIssueStatus | null;
  resolution: LedgerIssueResolution | null;
  headline: string;
  payload: Record<string, unknown>;
} | null {
  const payload = parseJsonObject(event.payload_json);
  const patch = typeof payload.patch === "object" && payload.patch !== null && !Array.isArray(payload.patch)
    ? payload.patch as Record<string, unknown>
    : payload;
  const status = event.event_type === "issue.closed"
    ? "closed"
    : event.event_type === "issue.reopened"
      ? "open"
      : typeof patch.status === "string"
        ? patch.status as LedgerIssueStatus
        : null;
  const resolution = typeof patch.resolution === "string"
    ? patch.resolution as LedgerIssueResolution
    : null;
  const label = typeof payload.label === "string" ? payload.label : "";
  const linkType = typeof payload.link_type === "string" ? payload.link_type : "";
  const authRequestId = typeof payload.auth_request_id === "string" ? payload.auth_request_id : "";
  const commitSha = typeof payload.commit_sha === "string" ? payload.commit_sha : "";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const workUnitId = typeof payload.work_unit_id === "string" ? payload.work_unit_id : "";
  if (!status && !("resolution" in patch) && event.event_type === "issue.updated") return null;
  return {
    status,
    resolution,
    payload,
    headline: stateHeadline({
      event_type: event.event_type,
      status,
      resolution,
      label,
      present: payload.present === true,
      link_type: linkType,
      auth_request_id: authRequestId,
      commit_sha: commitSha,
      session_id: sessionId,
      work_unit_id: workUnitId,
    }),
  };
}

function stateHeadline(input: {
  event_type: string;
  status: LedgerIssueStatus | null;
  resolution: LedgerIssueResolution | null;
  label: string;
  present: boolean;
  link_type: string;
  auth_request_id: string;
  commit_sha: string;
  session_id: string;
  work_unit_id: string;
}): string {
  if (input.event_type === "label.updated") {
    return input.label
      ? `Label ${input.label} ${input.present ? "added" : "removed"}`
      : "Label updated";
  }
  if (input.event_type === "commit.issue_linked") {
    return input.commit_sha
      ? `Commit ${input.commit_sha.slice(0, 12)} linked`
      : "Commit linked";
  }
  if (input.event_type === "auth_request.issue_linked") {
    return input.auth_request_id
      ? `Auth request ${input.auth_request_id} linked`
      : "Auth request linked";
  }
  if (input.event_type === "auth_request.completed") {
    return input.auth_request_id
      ? `Auth request ${input.auth_request_id} completed`
      : "Auth request completed";
  }
  if (input.event_type === "session.issue_linked") {
    return input.session_id ? `Session ${input.session_id} linked` : "Session linked";
  }
  if (input.event_type === "work_unit.issue_linked") {
    return input.work_unit_id ? `Work unit ${input.work_unit_id} linked` : "Work unit linked";
  }
  if (input.status === "closed") {
    return `Closed${input.resolution ? ` as ${input.resolution}` : ""}`;
  }
  if (input.status === "open") return "Reopened";
  return "Issue state changed";
}

function buildDiagnostics(input: {
  issues: IssueRow[];
  rows: TimelineRowOccurrence[];
  visibleIssueIds: Set<string>;
  relationshipSources: LedgerIssueRelationshipSource[];
  referenceCounts: Map<string, number>;
  rootOccurrencesByIssue: Map<string, number>;
  cycles: TimelineDiagnostic[];
  depthLimits: TimelineDiagnostic[];
  filteredTargets: TimelineDiagnostic[];
  missingExpansions: TimelineDiagnostic[];
  predicateDiagnostics: TimelineDiagnostic[];
}): TimelineDiagnostics {
  const liveIssues = input.issues.filter((issue) => issue.deleted_at === null);
  const referencedTargets = new Set(input.relationshipSources.map((source) => source.target_issue_id));
  const referencingSources = new Set(input.relationshipSources.map((source) => source.source_issue_id));
  const unreferencedOpen = liveIssues
    .filter((issue) => issue.status === "open" && !input.visibleIssueIds.has(issue.id) && !referencedTargets.has(issue.id))
    .map((issue) => issue.id)
    .sort();
  const loners = liveIssues
    .filter((issue) => issue.status === "open" && !input.visibleIssueIds.has(issue.id) && !referencedTargets.has(issue.id) && !referencingSources.has(issue.id))
    .map((issue) => issue.id)
    .sort();

  return {
    total_issues: input.issues.length,
    deleted_issues: input.issues.filter((issue) => issue.deleted_at !== null).length,
    root_count: input.rows.filter((row) => row.parent_row_id === null).length,
    reachable_from_roots_count: input.visibleIssueIds.size,
    unreferenced_open_issue_ids: unreferencedOpen,
    loner_open_issue_ids: loners,
    derived_reference_count: input.relationshipSources.length,
    repeated_reference_target_issue_ids: Array.from(input.referenceCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(),
    multi_root_issue_ids: Array.from(input.rootOccurrencesByIssue.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(),
    cycles: [
      ...input.cycles,
      ...input.predicateDiagnostics.filter((item) => item.kind === "cycle"),
    ],
    depth_limits: input.depthLimits,
    filtered_targets: input.filteredTargets,
    missing_expansions: input.missingExpansions,
    predicate_diagnostics: input.predicateDiagnostics,
    invalid_predicates: input.predicateDiagnostics.filter((item) => item.kind === "invalid_predicate"),
    unmatched_predicates: input.predicateDiagnostics.filter((item) => item.kind === "unmatched_predicate"),
  };
}

function countActiveTargets(sources: LedgerIssueRelationshipSource[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.target_issue_id, (counts.get(source.target_issue_id) ?? 0) + 1);
  }
  return counts;
}

function issueRef(issue: IssueRow): TimelineIssueRef {
  return {
    id: issue.id,
    display_id: issue.short_id || issue.id.slice(0, 7),
    project_id: issue.project_id,
    title: issue.title,
    status: issue.status,
    resolution: issue.resolution,
    kind: issue.kind,
    priority: issue.priority,
    labels: labelList(issue),
    deleted: issue.deleted_at !== null,
  };
}

function labelList(issue: IssueRow): string[] {
  return issue.labels
    ? issue.labels.split("\x1f").filter((label) => label.length > 0).sort()
    : [];
}

function headlineForText(issueTitle: string, text: string): {
  display_headline: string;
  headline_source: "title" | "markdown_heading" | "body_excerpt";
} {
  const heading = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) {
    return {
      display_headline: heading.replace(/^#{1,6}\s+/, "").trim().slice(0, 120),
      headline_source: "markdown_heading",
    };
  }
  const excerpt = text.replace(/\s+/g, " ").trim();
  if (excerpt) {
    return { display_headline: excerpt.slice(0, 120), headline_source: "body_excerpt" };
  }
  return { display_headline: issueTitle, headline_source: "title" };
}

function normalizeStatuses(statuses: LedgerIssueStatus[] | undefined, includeClosed: boolean): LedgerIssueStatus[] {
  if (statuses?.length) {
    return Array.from(new Set(statuses.filter((status) => status === "open" || status === "closed"))).sort();
  }
  return includeClosed ? ["closed", "open"] : DEFAULT_STATUSES;
}

function normalizeEventKinds(kinds: TimelineEventKind[] | undefined): TimelineEventKind[] {
  if (!kinds?.length) return [...DEFAULT_EVENT_KINDS];
  const result: TimelineEventKind[] = [];
  for (const kind of kinds) {
    if (VALID_EVENT_KINDS.has(kind) && !result.includes(kind)) result.push(kind);
  }
  return result;
}

function normalizeIssueIds(ids: string[] | undefined, issues: Map<string, IssueRow>): string[] {
  if (!ids) return [];
  const result: string[] = [];
  for (const raw of ids) {
    const id = resolveIssueId(raw, issues);
    if (id && !result.includes(id)) result.push(id);
  }
  return result;
}

function resolveIssueId(ref: string, issues: Map<string, IssueRow>): string | null {
  if (issues.has(ref)) return ref;
  for (const issue of issues.values()) {
    if (issue.short_id === ref) return issue.id;
  }
  return null;
}

function normalizePredicate(predicate: TimelineIssuePredicate | null): TimelineIssuePredicate | null {
  if (!predicate || typeof predicate !== "object") return null;
  return predicate;
}

function cleanSpecId(id: string | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "-") : null;
}

function predicateDiagnostic(input: PredicateDiagnosticInput): TimelineDiagnostic {
  return {
    kind: input.kind,
    message: input.message,
    row_spec_id: input.row_spec_id,
    issue_id: input.issue_id,
    target_issue_id: input.target_issue_id,
    predicate: input.predicate,
    path: input.path,
  };
}

function union(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
}

function normalizeLabelMembershipMode(value: unknown): TimelineLabelMembershipMode {
  return value === "ever_in_window" ? "ever_in_window" : "now";
}

function issueLabelKey(issueId: string, label: string): string {
  return `${issueId}\x1f${label}`;
}

function splitIssueLabelKey(key: string): [string, string] {
  const separator = key.indexOf("\x1f");
  if (separator === -1) return [key, ""];
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function compareLabelIntervals(
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

function compareIssues(a: IssueRow, b: IssueRow): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.short_id !== b.short_id) return a.short_id.localeCompare(b.short_id);
  return a.id.localeCompare(b.id);
}

function statusAllowed(status: LedgerIssueStatus, input: ProjectTimelineNormalizedInput): boolean {
  return input.statuses.includes(status);
}

function uniqueStrings(value: string[] | undefined): string[] {
  if (!value) return [];
  return Array.from(new Set(value.filter((item) => typeof item === "string" && item.trim().length > 0)));
}

function clampDepth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DEPTH;
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(value)));
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function timeAxis(events: TimelineEvent[]): TimelineTimeAxis {
  if (events.length === 0) return { start: null, end: null, event_count: 0 };
  const timestamps = events.map((event) => event.timestamp);
  return {
    start: Math.min(...timestamps),
    end: Math.max(...timestamps),
    event_count: events.length,
  };
}

function compareTimelineEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.row_id !== b.row_id) return a.row_id.localeCompare(b.row_id);
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.id.localeCompare(b.id);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export type {
  LedgerIssueKind,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
  LedgerRelationshipType,
};
