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
  TimelineLink,
  TimelineNormalizedRowSpec,
  TimelineRowOccurrence,
  TimelineRowOccurrenceKind,
  TimelineRowSpecRef,
  TimelineSourceEntityRef,
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
import {
  containsResidualPredicate,
  evaluatePredicate,
  intervalOverlapsWindow,
  labelList,
  predicateDiagnostic,
  resolveIssueId,
  type IssueReference,
  type IssueRow,
  type LabelHistoryIndex,
  type PredicateEvalContext,
} from "./issue-predicate.js";
import { appendTo, compareLabelIntervals, loadProjectIssueSet } from "./issue-predicate-context.js";
import { compareTimelineEvents, compareTimelineLinks, timelineTimeAxis } from "../timeline-pages.js";
import { AttributionReadResolver, resolvedActorDisplay } from "../identity/read-projection.js";
import { parseJsonObject } from "../row-coerce.js";
type ProjectRow = {
  id: string;
  display_name: string;
  repo_id: string | null;
  repo_name: string | null;
  repo_root: string | null;
};
type TimelineBacklinkSource = {
  source: LedgerIssueRelationshipSource;
  timestamp: number;
};
type IssueBodyRow = Pick<
  LedgerIssue,
  "id" | "body" | "source" | "author_actor_type" | "author_display" | "author_user_id" | "evidence_method" | "evidence_id"
>;
type CommentRow = {
  id: string;
  issue_id: string;
  ordinal: number;
  body: string;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
  source: string;
  author_actor_type: string;
  author_display: string;
  author_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
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
  actor_type: string;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
};
type InternalRowSpec = TimelineNormalizedRowSpec & {
  anchorIssue: IssueRow | null;
  legacyKind: TimelineRowOccurrenceKind | null;
  emitMembers: boolean;
  source: "root_policy" | "input" | "default_residual";
  occurrenceIndex: number;
  labelIntervals: TimelineLabelMembershipInterval[];
};

const DEFAULT_DEPTH = 1;
/**
 * How much one response may carry. A page holds the events of whole rows; it
 * stops taking rows once it holds `events` events or `ms` milliseconds have
 * passed since the request began, and always holds at least one row. The time
 * bound keeps a cold page cache from stretching a page past the event-loop
 * budget; the event bound keeps a warm page's response small. Clients request
 * the following pages from `page.next_row_offset`, and joining every page
 * gives the same projection wherever the pages were cut.
 */
export type TimelinePageBudget = { events: number; ms: number; now: () => number };

const DEFAULT_PAGE_BUDGET: TimelinePageBudget = { events: 3_000, ms: 40, now: () => performance.now() };
/**
 * Rows whose events one query batch loads, which bounds how far one load
 * overshoots the time budget. Past the deadline a page loads only its one
 * required row.
 */
const TIMELINE_PAGE_LOAD_ROWS = 16;
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
/**
 * Events of these types are recorded on another entity and name their issue in
 * `payload.issue_id`; every other Timeline event type is recorded on the issue.
 */
const LINKED_EVENT_TYPES: ReadonlySet<string> = new Set(
  (["auth_request", "commit", "session", "work_unit"] as const).flatMap((kind) => STATE_EVENT_TYPES_BY_KIND[kind]),
);

export function buildProjectTimelineProjection(
  db: Db,
  input: ProjectTimelineInput,
  budget: TimelinePageBudget = DEFAULT_PAGE_BUDGET,
): ProjectTimelineProjection {
  return db.transaction(() => buildProjectTimelineSnapshot(db, input, budget))();
}

function buildProjectTimelineSnapshot(db: Db, input: ProjectTimelineInput, budget: TimelinePageBudget): ProjectTimelineProjection {
  const ledgerWatermark = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS watermark FROM ledger_events").get() as { watermark: number }).watermark;
  const deadline = budget.now() + budget.ms;
  const project = resolveProject(db, input);
  const issueSet = loadProjectIssueSet(db, project.id);
  const { issues, issueById, references, labelHistory } = issueSet;
  const issueRefs = new Map(issues.map((issue) => [issue.id, issueRef(issue)]));
  const normalized = normalizeInput(input, project.id, issueById);
  const eventSource = new TimelineEventSource(db, normalized, issueById);
  const attributionResolver = new AttributionReadResolver(db);
  const referenceCounts = countActiveTargets(references);
  const predicateContext: Omit<PredicateEvalContext, "residualCoveredIssueIds"> = {
    allIssues: issues,
    issueById,
    references,
    parentChildren: issueSet.parentChildren,
    labelHistory,
    window: { from: normalized.from, to: normalized.to },
  };
  const rows: TimelineRowOccurrence[] = [];
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
  const linksByRowId = new Map<string, TimelineLink[]>();

  const rootSpecs = buildRootSpecs({
    rawInput: input,
    normalized,
    issues,
    issueById,
    diagnostics: predicateDiagnostics,
  });
  normalized.root_specs = rootSpecs
    .filter((spec) => spec.source !== "root_policy")
    .map(normalizedSpec);
  rootSpecs.forEach((spec) => {
    if (spec.anchorIssue) {
      addIssueRow(
        spec.anchorIssue,
        spec.legacyKind ?? "root",
        null,
        null,
        0,
        spec.source === "root_policy"
          ? [`root:${spec.anchorIssue.id}:${spec.occurrenceIndex}`]
          : [`spec:${spec.id}:${spec.occurrenceIndex}`, `anchor:${spec.anchorIssue.id}`],
        false,
        spec.source === "root_policy" ? null : rowSpecRef(spec),
      );
      return;
    }
    if (!spec.emitMembers || !spec.scope) {
      addFilterRootRow(spec);
      return;
    }
    const memberIds = evaluateRootScope(spec, {
      ...predicateContext,
      residualCoveredIssueIds: residualCoveredIssueIds(rootSpecs, spec, {
        ...predicateContext,
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
    const filterRoot = addFilterRootRow(spec);
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

  const eventsByRowId = new Map<string, TimelineEvent[]>();
  const rowMayExpand = rowMayHoldExpansion(normalized);

  for (let cursor = 0; cursor < rows.length; cursor += 1) {
    const row = rows[cursor];
    if (!rowMayExpand(row)) continue;
    if (row.issue && !eventSource.has(row.issue.id)) {
      eventSource.load(rows.slice(cursor).filter(rowMayExpand).flatMap(issueIdOfRow));
    }
    materializeRow(row);
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
    const rowLinks = linksByRowId.get(row.id) ?? [];
    row.expanded = rowLinks.some((link) => link.expanded_row_id !== null)
      || (childRowIdsByParent.get(row.id)?.length ?? 0) > 0;
    rowById.set(row.id, row);
  }

  const rowOffset = pageRowOffset(input.row_offset, orderedRows.length);
  const events: TimelineEvent[] = [];
  const links: TimelineLink[] = [];
  let cursor = rowOffset;
  while (
    cursor < orderedRows.length
    && (cursor === rowOffset || (events.length < budget.events && budget.now() < deadline))
  ) {
    const row = orderedRows[cursor];
    if (row.issue && !eventSource.has(row.issue.id)) {
      const batch = budget.now() < deadline ? TIMELINE_PAGE_LOAD_ROWS : 1;
      eventSource.load(orderedRows.slice(cursor, cursor + batch).flatMap(issueIdOfRow));
    }
    events.push(...materializeRow(row), ...buildBacklinkEvents(row, eventSource, issueRefs, normalized));
    links.push(...linksByRowId.get(row.id) ?? []);
    cursor += 1;
  }

  events.sort(compareTimelineEvents);
  links.sort(compareTimelineLinks);

  return {
    project,
    inputs: normalized,
    time_axis: timelineTimeAxis(events),
    rows: orderedRows,
    events,
    links,
    diagnostics: buildDiagnostics({
      issues,
      rows: orderedRows,
      visibleIssueIds,
      references,
      referenceCounts,
      rootOccurrencesByIssue,
      cycles,
      depthLimits,
      filteredTargets,
      missingExpansions,
      predicateDiagnostics,
    }),
    page: {
      ledger_watermark: ledgerWatermark,
      row_offset: rowOffset,
      next_row_offset: cursor < orderedRows.length ? cursor : null,
    },
  };

  function materializeRow(row: TimelineRowOccurrence): TimelineEvent[] {
    const built = eventsByRowId.get(row.id);
    if (built) return built;
    const rowEvents = buildEventsForRow(
      row,
      issueById,
      issueRefs,
      normalized,
      eventSource,
      attributionResolver,
    );
    for (const event of rowEvents) {
      const eventSourceKey = sourceKey(event.source_entity.type, event.source_entity.id);
      const sourceRows = eventSource.relationshipSources(eventSourceKey);
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
        appendTo(linksByRowId, row.id, link);

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
    }
    eventsByRowId.set(row.id, rowEvents);
    return rowEvents;
  }

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

  function addFilterRootRow(spec: InternalRowSpec): TimelineRowOccurrence {
    const occurrencePath = `spec:${spec.id}:${spec.occurrenceIndex}`;
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

function issueIdOfRow(row: TimelineRowOccurrence): string[] {
  return row.issue ? [row.issue.id] : [];
}

/**
 * Whether a row may hold an expanded event. Event ids begin with
 * `event:<row id>:`, so a prefix match over-approximates and never misses one;
 * the projection materializes these rows on every page so the row tree is the
 * same whichever page is asked for.
 */
function rowMayHoldExpansion(input: ProjectTimelineNormalizedInput): (row: TimelineRowOccurrence) => boolean {
  const paths = new Set(input.expanded_paths);
  const pathPrefixes = input.expanded_paths.filter((path) => path.includes(">"));
  return (row) => {
    if (!row.issue) return false;
    if (paths.has(row.id)) return true;
    const pathPrefix = `${row.id}>`;
    const eventPrefix = `event:${row.id}:`;
    return pathPrefixes.some((path) => path.startsWith(pathPrefix))
      || input.expanded_event_ids.some((eventId) => eventId.startsWith(eventPrefix));
  };
}

function pageRowOffset(value: number | undefined, rowCount: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(rowCount, Math.floor(value)));
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
            COALESCE(NULLIF(p.project_key, ''), c.work_repo_id, NULL) AS repo_id,
            COALESCE(c.name, NULL) AS repo_name,
            COALESCE(c.root, NULL) AS repo_root
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id
      WHERE p.id = ? OR p.project_key = ? OR p.display_name = ?
         OR c.work_repo_id = ? OR c.name = ? OR c.root = ?
      ORDER BY CASE WHEN p.id = ? OR p.project_key = ? THEN 0 ELSE 1 END, c.created_at ASC
      LIMIT 1`,
  ).get(ref, ref, ref, ref, ref, ref, ref, ref) as ProjectRow | undefined;
  if (!row) throw new Error("timeline project not found");
  return row;
}

/**
 * What a row's events are built from — the issue body, comments, state events,
 * and the references those texts make — read by issue id only once a row shows
 * the issue.
 */
class TimelineEventSource {
  readonly stateEventTypes: string[];
  private readonly issueEventTypes: string[];
  private readonly linkedEventTypes: string[];
  private readonly includeBody: boolean;
  private readonly includeComments: boolean;
  private readonly loaded = new Set<string>();
  private readonly bodyByIssue = new Map<string, IssueBodyRow>();
  private readonly commentsByIssue = new Map<string, CommentRow[]>();
  private readonly stateEventsByIssue = new Map<string, StateEventRow[]>();
  private readonly referencesBySourceEntity = new Map<string, LedgerIssueRelationshipSource[]>();
  private readonly includeBacklinks: boolean;
  private readonly backlinksByTarget = new Map<string, TimelineBacklinkSource[]>();

  constructor(
    private readonly db: Db,
    input: ProjectTimelineNormalizedInput,
    private readonly issueById: Map<string, IssueRow>,
  ) {
    this.includeBacklinks = eventKindEnabled(input, "backlink");
    this.includeBody = eventKindEnabled(input, "body");
    this.includeComments = eventKindEnabled(input, "comment");
    this.stateEventTypes = selectedStateEventTypes(input);
    this.issueEventTypes = this.stateEventTypes.filter((type) => !LINKED_EVENT_TYPES.has(type));
    this.linkedEventTypes = this.stateEventTypes.filter((type) => LINKED_EVENT_TYPES.has(type));
  }

  has(issueId: string): boolean {
    return this.loaded.has(issueId);
  }

  body(issueId: string): IssueBodyRow | undefined {
    return this.bodyByIssue.get(issueId);
  }

  comments(issueId: string): CommentRow[] {
    return this.commentsByIssue.get(issueId) ?? [];
  }

  stateEvents(issueId: string): StateEventRow[] {
    return this.stateEventsByIssue.get(issueId) ?? [];
  }

  relationshipSources(sourceEntityKey: string): LedgerIssueRelationshipSource[] {
    return this.referencesBySourceEntity.get(sourceEntityKey) ?? [];
  }

  backlinks(targetIssueId: string): TimelineBacklinkSource[] {
    return this.backlinksByTarget.get(targetIssueId) ?? [];
  }

  load(issueIds: Iterable<string>): void {
    const pending = Array.from(new Set(issueIds)).filter((id) => !this.loaded.has(id));
    if (pending.length === 0) return;
    for (const id of pending) this.loaded.add(id);
    const ids = JSON.stringify(pending);
    if (this.includeBody) {
      this.loadBodies(ids);
      this.loadReferences("issue_body", ids);
    }
    if (this.includeComments) {
      const commentIds = this.loadComments(ids);
      this.loadReferences("comment", JSON.stringify(commentIds));
    }
    if (this.stateEventTypes.length > 0) this.loadStateEvents(ids);
    if (this.includeBacklinks) this.loadBacklinks(ids);
  }

  private loadBacklinks(targetIds: string): void {
    const sources = this.db.prepare(
      `SELECT *
         FROM ledger_issue_relationship_sources
        WHERE target_issue_id IN (SELECT value FROM json_each(?))
          AND relationship_type = 'references'
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    ).all(targetIds) as LedgerIssueRelationshipSource[];
    const commentIds = sources
      .filter((source) => source.source_entity_type === "comment")
      .map((source) => source.source_entity_id);
    const comments = new Map((this.db.prepare(
      `SELECT id, issue_id, created_at
         FROM ledger_comments
        WHERE id IN (SELECT value FROM json_each(?))
          AND deleted_at IS NULL`,
    ).all(JSON.stringify(commentIds)) as Array<Pick<CommentRow, "id" | "issue_id" | "created_at">>)
      .map((comment) => [comment.id, comment]));
    for (const source of sources) {
      appendTo(this.backlinksByTarget, source.target_issue_id, {
        source,
        timestamp: this.backlinkTimestamp(source, comments),
      });
    }
  }

  private backlinkTimestamp(
    source: LedgerIssueRelationshipSource,
    comments: Map<string, Pick<CommentRow, "id" | "issue_id" | "created_at">>,
  ): number {
    const sourceIssue = this.issueById.get(source.source_issue_id);
    if (source.source_entity_type === "issue_body" && sourceIssue) return sourceIssue.created_at;
    if (source.source_entity_type === "comment") {
      const comment = comments.get(source.source_entity_id);
      if (comment && comment.issue_id === source.source_issue_id) return comment.created_at;
    }
    return source.created_at;
  }

  private loadBodies(ids: string): void {
    const rows = this.db.prepare(
      `SELECT id, body, source, author_actor_type, author_display, author_user_id,
              evidence_method, evidence_id
         FROM ledger_issues
        WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(ids) as IssueBodyRow[];
    for (const row of rows) this.bodyByIssue.set(row.id, row);
  }

  private loadReferences(sourceEntityType: LedgerIssueRelationshipSource["source_entity_type"], ids: string): void {
    const rows = this.db.prepare(
      `SELECT *
         FROM ledger_issue_relationship_sources
        WHERE source_entity_type = ?
          AND source_entity_id IN (SELECT value FROM json_each(?))
          AND relationship_type = 'references'
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    ).all(sourceEntityType, ids) as LedgerIssueRelationshipSource[];
    for (const row of rows) {
      appendTo(this.referencesBySourceEntity, sourceKey(row.source_entity_type, row.source_entity_id), row);
    }
  }

  private loadComments(ids: string): string[] {
    const rows = this.db.prepare(
      `SELECT c.id, c.issue_id, c.ordinal, c.body, c.created_at, c.updated_at, c.deleted_at,
              c.source, c.author_actor_type, c.author_display, c.author_user_id,
              c.evidence_method, c.evidence_id
         FROM ledger_comments c
        WHERE c.issue_id IN (SELECT value FROM json_each(?))
          AND c.deleted_at IS NULL
        ORDER BY c.issue_id ASC, c.ordinal ASC, c.created_at ASC`,
    ).all(ids) as CommentRow[];
    for (const row of rows) appendTo(this.commentsByIssue, row.issue_id, row);
    return rows.map((row) => row.id);
  }

  private loadStateEvents(ids: string): void {
    const issueEvents = this.issueEventTypes.length === 0 ? [] : this.db.prepare(
      `SELECT id, entity_type, entity_id, event_type, source, payload_json,
              occurred_at, observed_at, actor_type, actor_user_id,
              evidence_method, evidence_id
         FROM ledger_events INDEXED BY idx_ledger_events_issue_type
        WHERE entity_type = 'issue'
          AND entity_id IN (SELECT value FROM json_each(?))
          AND event_type IN (${placeholders(this.issueEventTypes)})`,
    ).all(ids, ...this.issueEventTypes) as StateEventRow[];
    const linkedEvents = this.linkedEventTypes.length === 0 ? [] : this.db.prepare(
      `SELECT id, entity_type, entity_id, event_type, source, payload_json,
              occurred_at, observed_at, actor_type, actor_user_id,
              evidence_method, evidence_id,
              json_extract(payload_json, '$.issue_id') AS linked_issue_id
         FROM ledger_events
        WHERE entity_type != 'issue'
          AND json_extract(payload_json, '$.issue_id') IN (SELECT value FROM json_each(?))
          AND event_type IN (${placeholders(this.linkedEventTypes)})`,
    ).all(ids, ...this.linkedEventTypes) as Array<StateEventRow & { linked_issue_id: string }>;
    const touched = new Set<string>();
    for (const event of issueEvents) {
      appendTo(this.stateEventsByIssue, event.entity_id, event);
      touched.add(event.entity_id);
    }
    for (const { linked_issue_id: issueId, ...event } of linkedEvents) {
      appendTo(this.stateEventsByIssue, issueId, event);
      touched.add(issueId);
    }
    for (const issueId of touched) this.stateEventsByIssue.get(issueId)?.sort(compareStateEvents);
  }
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
    for (const interval of labelHistory.intervalsForLabel(label)) {
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

function selectRootIssues(
  issues: IssueRow[],
  input: ProjectTimelineNormalizedInput,
): IssueRow[] {
  const explicit = new Set([...input.explicit_root_issue_ids, ...input.promoted_root_issue_ids]);
  return issues.filter((issue) => {
    if (issue.deleted_at !== null || !statusAllowed(issue.status, input)) return false;
    const tracker = issue.kind === "tracker";
    if (input.root_policy === "coordination") return tracker || input.promoted_root_issue_ids.includes(issue.id);
    if (input.root_policy === "explicit") return explicit.has(issue.id);
    return tracker || explicit.has(issue.id);
  });
}

function buildRootSpecs(input: {
  rawInput: ProjectTimelineInput;
  normalized: ProjectTimelineNormalizedInput;
  issues: IssueRow[];
  issueById: Map<string, IssueRow>;
  diagnostics: TimelineDiagnostic[];
}): InternalRowSpec[] {
  const explicitSpecs = input.rawInput.root_specs ?? input.rawInput.root_row_specs;
  const rootPolicySpecs: InternalRowSpec[] = selectRootIssues(input.issues, input.normalized).map((issue, index) => ({
    id: `legacy:${issue.id}:${index}`,
    title: issue.title,
    anchor_issue_id: issue.id,
      scope: issue.kind === "tracker"
        ? { type: "referenced_by", issue_id: issue.id }
        : null,
      anchorIssue: issue,
      legacyKind: rootKind(issue.id, input.normalized),
      emitMembers: false,
    source: "root_policy" as const,
    occurrenceIndex: index,
    labelIntervals: [],
  }));

  const inputSpecs = (explicitSpecs ?? []).map((spec, index) => {
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
      source: "input" as const,
      occurrenceIndex: index,
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
  const specs = [...rootPolicySpecs, ...inputSpecs];
  const hasFilterRows = inputSpecs.some((spec) => spec.anchorIssue === null);
  if (!inputSpecs.some((spec) => spec.scope && containsResidualPredicate(spec.scope))) {
    specs.push({
      id: uniqueSpecId("residual", specs),
      title: "Residual issues",
      anchor_issue_id: null,
      scope: { type: "residual" },
      anchorIssue: null,
      legacyKind: null,
      emitMembers: hasFilterRows,
      source: "default_residual",
      occurrenceIndex: inputSpecs.length,
      labelIntervals: [],
    });
  }
  return specs;
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

function residualCoveredIssueIds(
  specs: InternalRowSpec[],
  residualSpec: InternalRowSpec,
  context: PredicateEvalContext,
  diagnostics: TimelineDiagnostic[],
): Set<string> {
  const covered = new Set<string>();
  for (const spec of specs) {
    if (
      spec.source !== "input"
      || spec.anchorIssue !== null
      || spec.id === residualSpec.id
      || !spec.scope
      || containsResidualPredicate(spec.scope)
    ) {
      continue;
    }
    for (const issueId of evaluatePredicate(spec.scope, context, spec.id, diagnostics)) {
      covered.add(issueId);
    }
  }
  return covered;
}

function rootKind(issueId: string, input: ProjectTimelineNormalizedInput): TimelineRowOccurrenceKind {
  if (input.promoted_root_issue_ids.includes(issueId)) return "promoted_root";
  if (input.explicit_root_issue_ids.includes(issueId)) return "explicit_root";
  return "root";
}

function buildEventsForRow(
  row: TimelineRowOccurrence,
  issueById: Map<string, IssueRow>,
  issueRefs: Map<string, TimelineIssueRef>,
  input: ProjectTimelineNormalizedInput,
  eventSource: TimelineEventSource,
  attributionResolver: AttributionReadResolver,
): TimelineEvent[] {
  if (!row.issue) return [];
  const issue = issueById.get(row.issue.id);
  if (!issue) return [];
  const result: TimelineEvent[] = [];
  if (eventKindEnabled(input, "body")) {
    const body = eventSource.body(issue.id);
    if (!body) throw new Error(`Timeline issue ${issue.id} has no body row`);
    addIfInWindow(result, {
      id: `event:${row.id}:body`,
      row_id: row.id,
      issue: issueRefs.get(issue.id) ?? issueRef(issue),
      source_entity: { type: "issue_body", id: issue.id, issue_id: issue.id },
      kind: "body",
      timestamp: issue.created_at,
      ordinal: 0,
      ...headlineForText(issue.title, body.body),
      author: timelineAuthor(attributionResolver, {
        legacy_display: body.author_display,
        actor_type: body.author_actor_type,
        user_id: body.author_user_id,
        evidence_method: body.evidence_method,
        evidence_id: body.evidence_id,
        source: body.source,
      }),
      body: body.body,
      state: null,
      backlink: null,
      link_ids: [],
    }, input);
  }

  const comments = eventKindEnabled(input, "comment")
    ? eventSource.comments(issue.id)
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
        author: timelineAuthor(attributionResolver, {
          legacy_display: comment.author_display,
          actor_type: comment.author_actor_type,
          user_id: comment.author_user_id,
          evidence_method: comment.evidence_method,
          evidence_id: comment.evidence_id,
          source: comment.source,
        }),
        body: comment.body,
        state: null,
        backlink: null,
        link_ids: [],
      }, input);
    }
  }

  const stateEventTypes = eventSource.stateEventTypes;
  if (stateEventTypes.length === 0) return result.sort(compareTimelineEvents);
  const stateEvents = eventSource.stateEvents(issue.id);
  let stateOrdinal = comments.length + 1;
  const hasAuthCompletion = stateEvents.some((event) => (
    event.event_type === "auth_request.completed"
  ));
  for (const event of stateEvents) {
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
      author: timelineAuthor(attributionResolver, {
        legacy_display: event.actor_type.replace(/_/g, " "),
        actor_type: event.actor_type,
        user_id: event.actor_user_id,
        evidence_method: event.evidence_method,
        evidence_id: event.evidence_id,
        source: event.source,
      }),
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

function timelineAuthor(
  resolver: AttributionReadResolver,
  input: {
    legacy_display: string;
    actor_type: string;
    user_id: string | null;
    evidence_method: string | null;
    evidence_id: string | null;
    source: string | null;
  },
): NonNullable<TimelineEvent["author"]> {
  const attribution = resolver.attribution(input);
  return {
    display: resolvedActorDisplay(input.legacy_display, input.actor_type, attribution),
    legacy_display: input.legacy_display,
    attribution,
    source: input.source,
  };
}

function eventKindEnabled(input: ProjectTimelineNormalizedInput, kind: TimelineEventKind): boolean {
  return input.event_kinds.includes(kind);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function selectedStateEventTypes(input: ProjectTimelineNormalizedInput): string[] {
  const eventTypes = new Set<string>();
  for (const kind of input.event_kinds) {
    for (const eventType of STATE_EVENT_TYPES_BY_KIND[kind]) eventTypes.add(eventType);
  }
  return Array.from(eventTypes).sort();
}

function buildBacklinkEvents(
  row: TimelineRowOccurrence,
  eventSource: TimelineEventSource,
  issueRefs: Map<string, TimelineIssueRef>,
  normalized: ProjectTimelineNormalizedInput,
): TimelineEvent[] {
  const backlinkEvents: TimelineEvent[] = [];
  if (!row.issue) return backlinkEvents;
  for (const { source, timestamp } of eventSource.backlinks(row.issue.id)) {
    const sourceIssue = issueRefs.get(source.source_issue_id);
    const targetIssue = issueRefs.get(source.target_issue_id);
    const sourceEntity = sourceEntityForRelationshipSource(source);
    if (!sourceIssue || !targetIssue || !sourceEntity) continue;
    addIfInWindow(backlinkEvents, {
      id: `event:${row.id}:backlink:${source.id}`,
      row_id: row.id,
      issue: targetIssue,
      source_entity: sourceEntity,
      kind: "backlink",
      timestamp,
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
    }, normalized);
  }
  return backlinkEvents;
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
  references: readonly IssueReference[];
  referenceCounts: Map<string, number>;
  rootOccurrencesByIssue: Map<string, number>;
  cycles: TimelineDiagnostic[];
  depthLimits: TimelineDiagnostic[];
  filteredTargets: TimelineDiagnostic[];
  missingExpansions: TimelineDiagnostic[];
  predicateDiagnostics: TimelineDiagnostic[];
}): TimelineDiagnostics {
  const liveIssues = input.issues.filter((issue) => issue.deleted_at === null);
  const referencedTargets = new Set(input.references.map((source) => source.target_issue_id));
  const referencingSources = new Set(input.references.map((source) => source.source_issue_id));
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
    derived_reference_count: input.references.length,
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

function countActiveTargets(sources: readonly IssueReference[]): Map<string, number> {
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

function normalizePredicate(predicate: TimelineIssuePredicate | null): TimelineIssuePredicate | null {
  if (!predicate || typeof predicate !== "object") return null;
  return predicate;
}

function cleanSpecId(id: string | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "-") : null;
}

function uniqueSpecId(base: string, specs: InternalRowSpec[]): string {
  const existing = new Set(specs.map((spec) => spec.id));
  if (!existing.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
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

function compareStateEvents(a: StateEventRow, b: StateEventRow): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at - b.occurred_at;
  if (a.observed_at !== b.observed_at) return a.observed_at - b.observed_at;
  return a.id.localeCompare(b.id);
}


export type {
  LedgerIssueKind,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
  LedgerRelationshipType,
};
