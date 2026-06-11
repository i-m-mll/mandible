import type { Db } from "../db.js";
import type {
  ProjectTimelineInput,
  ProjectTimelineNormalizedInput,
  ProjectTimelineProjection,
  TimelineEventKind,
  TimelineDiagnostic,
  TimelineDiagnostics,
  TimelineEvent,
  TimelineIssueRef,
  TimelineLink,
  TimelineRowOccurrence,
  TimelineRowOccurrenceKind,
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
  "body",
  "comment",
  "commit",
  "issue_state",
  "label",
  "session",
  "work_unit",
]);
const STATE_EVENT_TYPES_BY_KIND: Record<TimelineEventKind, string[]> = {
  auth_request: ["auth_request.issue_linked", "auth_request.completed"],
  body: [],
  comment: [],
  commit: ["commit.issue_linked"],
  issue_state: ["issue.updated", "issue.closed", "issue.reopened"],
  label: ["label.updated"],
  session: ["session.issue_linked"],
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
  const relationshipSourcesByEventSource = groupRelationshipSources(relationshipSources);
  const referenceCounts = countActiveTargets(relationshipSources);
  const rows: TimelineRowOccurrence[] = [];
  const events: TimelineEvent[] = [];
  const links: TimelineLink[] = [];
  const cycles: TimelineDiagnostic[] = [];
  const depthLimits: TimelineDiagnostic[] = [];
  const filteredTargets: TimelineDiagnostic[] = [];
  const missingExpansions: TimelineDiagnostic[] = [];
  const childRowIdsByParent = new Map<string, string[]>();
  const expandedEvents = new Set(normalized.expanded_event_ids);
  const expandedPaths = new Set(normalized.expanded_paths);
  const expandedEventHits = new Set<string>();
  const visibleIssueIds = new Set<string>();
  const rootOccurrencesByIssue = new Map<string, number>();
  const eventToLinks = new Map<string, TimelineLink[]>();
  const rowById = new Map<string, TimelineRowOccurrence>();

  const rootIssues = selectRootIssues(issues, normalized);
  rootIssues.forEach((issue, index) => {
    const kind = rootKind(issue.id, normalized);
    addRow(issue, kind, null, null, 0, [`root:${issue.id}:${index}`], false);
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
            const child = addRow(
              target,
              "transient",
              row.id,
              event.id,
              childDepth,
              [...row.path, `event:${event.id}`, `issue:${target.id}`],
              cycle,
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
    visibleIssueIds.add(row.issue.id);
    if (row.kind === "root" || row.kind === "promoted_root" || row.kind === "explicit_root") {
      rootOccurrencesByIssue.set(row.issue.id, (rootOccurrencesByIssue.get(row.issue.id) ?? 0) + 1);
    }
    const rowLinks = links.filter((link) => link.source_row_id === row.id);
    row.expanded = rowLinks.some((link) => link.expanded_row_id !== null);
    rowById.set(row.id, row);
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
    }),
  };

  function addRow(
    issue: IssueRow,
    kind: TimelineRowOccurrenceKind,
    parentRowId: string | null,
    sourceEventId: string | null,
    depth: number,
    path: string[],
    cycle: boolean,
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
    };
    rows.push(row);
    if (parentRowId !== null) {
      const siblings = childRowIdsByParent.get(parentRowId) ?? [];
      siblings.push(row.id);
      childRowIdsByParent.set(parentRowId, siblings);
    }
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
    cycles: input.cycles,
    depth_limits: input.depthLimits,
    filtered_targets: input.filteredTargets,
    missing_expansions: input.missingExpansions,
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
