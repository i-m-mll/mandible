export type TimelineRootPolicy = 'coordination' | 'explicit' | 'coordination_and_explicit';
export type TimelineDensity = 'compact' | 'comfortable' | 'expanded';
export type TimelineEventKind = 'body' | 'comment' | 'state';
export type TimelineRowOccurrenceKind = 'root' | 'promoted_root' | 'explicit_root' | 'transient' | 'member';

// Re-export the browser-safe canonical issue kind so timeline predicates and
// issue views cannot drift into separate UI contracts.
import type { LedgerIssueKind } from './issues';
export type { LedgerIssueKind } from './issues';

// Canonical issue-predicate contract, shared with the backend
// (`TimelineIssuePredicate` in `src/types.ts`, evaluated by
// `src/ledger/issue-predicate.ts`). The label `membership` and the typed `kind`
// must match the backend shape so predicates round-trip through `/seed` and the
// Timeline projection identically.
export type TimelineLabelMembershipMode = 'now' | 'ever_in_window';
export type TimelineIssuePredicate =
  | { type: 'referenced_by'; issue_id: string }
  | { type: 'label'; name: string; membership?: TimelineLabelMembershipMode }
  | { type: 'kind'; kind: LedgerIssueKind }
  | { type: 'parent_subtree'; issue_id: string }
  | { type: 'residual' }
  | { type: 'and'; predicates: TimelineIssuePredicate[] }
  | { type: 'or'; predicates: TimelineIssuePredicate[] }
  | { type: 'not'; predicate: TimelineIssuePredicate };

export type TimelineFilterField = 'label' | 'kind' | 'referenced-by' | 'subtree';

export type TimelineFilterChip = {
  field: TimelineFilterField;
  values: string[];
  negated: boolean;
};

export type TimelineFilterRowSpec = {
  id: string;
  title: string;
  chips: TimelineFilterChip[];
  scope: TimelineIssuePredicate;
};

export type TimelineRowSpecInput = {
  id?: string;
  title?: string;
  anchor?: string | null;
  anchor_issue_id?: string | null;
  scope?: TimelineIssuePredicate | null;
};

export type TimelineTimeWindow = {
  from: number | null;
  to: number | null;
};

export type TimelinePaneVisibility = {
  inspector: boolean;
  inspectorWidth: number;
  diagnostics: boolean;
  rowList: boolean;
  rowListWidth: number;
};

export type TimelineViewState = {
  rootPolicy: TimelineRootPolicy;
  explicitRootIssueIds: string[];
  promotedRootIssueIds: string[];
  expandedEventIds: string[];
  expandedPaths: string[];
  selectedRowOccurrenceId: string | null;
  selectedEventId: string | null;
  selectedClusterId: string | null;
  timeWindow: TimelineTimeWindow;
  density: TimelineDensity;
  visibleEventTypes: TimelineEventKind[];
  includeClosed: boolean;
  filterRows: TimelineFilterRowSpec[];
  panes: TimelinePaneVisibility;
};

export type ProjectTimelineInput = {
  project_id?: string;
  project_ref?: string;
  root_policy?: TimelineRootPolicy;
  root_specs?: TimelineRowSpecInput[];
  root_row_specs?: TimelineRowSpecInput[];
  explicit_root_issue_ids?: string[];
  promoted_root_issue_ids?: string[];
  expanded_event_ids?: string[];
  expanded_paths?: string[];
  include_closed?: boolean;
  event_kinds?: TimelineEventKind[];
  depth?: number;
  from?: number;
  to?: number;
};

export type ProjectTimelineNormalizedInput = {
  project_id: string;
  root_policy: TimelineRootPolicy;
  root_specs: Required<Pick<TimelineRowSpecInput, 'id' | 'title' | 'anchor_issue_id' | 'scope'>>[];
  explicit_root_issue_ids: string[];
  promoted_root_issue_ids: string[];
  expanded_event_ids: string[];
  expanded_paths: string[];
  include_closed: boolean;
  statuses: string[];
  event_kinds: TimelineEventKind[];
  depth: number;
  from: number | null;
  to: number | null;
};

export type TimelineIssueRef = {
  id: string;
  display_id: string;
  project_id: string;
  title: string;
  status: string;
  resolution: string | null;
  kind: string;
  priority: string;
  labels: string[];
  deleted: boolean;
};

export type TimelineRowSpecRef = {
  id: string;
  title: string;
  anchor_issue_id: string | null;
  scope: TimelineIssuePredicate | null;
};

export type TimelineSourceEntityRef = {
  type: 'issue_body' | 'comment' | 'issue_state';
  id: string;
  issue_id: string;
};

export type TimelineRowOccurrence = {
  id: string;
  issue: TimelineIssueRef | null;
  row_spec?: TimelineRowSpecRef | null;
  kind: TimelineRowOccurrenceKind;
  parent_row_id: string | null;
  source_event_id: string | null;
  depth: number;
  path: string[];
  expanded: boolean;
  cycle: boolean;
  hidden_reason: string | null;
};

export type TimelineEvent = {
  id: string;
  row_id: string;
  issue: TimelineIssueRef;
  source_entity: TimelineSourceEntityRef;
  kind: TimelineEventKind;
  timestamp: number;
  ordinal: number;
  display_headline: string;
  headline_source: string;
  author?: {
    display: string;
    legacy_display: string;
    attribution: {
      user: {
        id: string;
        display_name: string;
        kind: 'human' | 'agent' | 'system' | 'external';
      } | null;
      evidence_method: string | null;
      evidence_id: string | null;
      credential: { id: string; type: string; label: string | null } | null;
    } | null;
    source: string | null;
  } | null;
  body: string | null;
  state: {
    event_type: string;
    status: string | null;
    resolution: string | null;
  } | null;
  link_ids: string[];
};

export type TimelineLink = {
  id: string;
  event_id: string;
  source_row_id: string;
  source_entity: TimelineSourceEntityRef;
  source_issue: TimelineIssueRef;
  target_issue: TimelineIssueRef;
  relationship_id: string;
  relationship_type: string;
  ref_kind: string;
  raw_ref: string;
  normalized_ref: string;
  derived: boolean;
  expanded_row_id: string | null;
  created_at: number;
};

export type TimelineDiagnostic = {
  kind: string;
  message: string;
  row_id?: string;
  event_id?: string;
  issue_id?: string;
  target_issue_id?: string;
  depth?: number;
  path?: string[];
};

export type TimelineDiagnostics = {
  total_issues: number;
  deleted_issues: number;
  root_count: number;
  reachable_from_roots_count: number;
  unreferenced_open_issue_ids: string[];
  loner_open_issue_ids: string[];
  derived_reference_count: number;
  repeated_reference_target_issue_ids: string[];
  multi_root_issue_ids: string[];
  cycles: TimelineDiagnostic[];
  depth_limits: TimelineDiagnostic[];
  filtered_targets: TimelineDiagnostic[];
  missing_expansions: TimelineDiagnostic[];
};

export type ProjectTimelineProjection = {
  project: {
    id: string;
    display_name: string;
    repo_id: string | null;
    repo_name: string | null;
    repo_root: string | null;
  };
  inputs: ProjectTimelineNormalizedInput;
  time_axis: {
    start: number | null;
    end: number | null;
    event_count: number;
  };
  rows: TimelineRowOccurrence[];
  events: TimelineEvent[];
  links: TimelineLink[];
  diagnostics: TimelineDiagnostics;
};

/** One response of `POST /api/timeline/project`; see `src/timeline-pages.ts`. */
export type ProjectTimelinePage = ProjectTimelineProjection & {
  page: { row_offset: number; next_row_offset: number | null };
};

export const DEFAULT_TIMELINE_VIEW_STATE: TimelineViewState = {
  rootPolicy: 'coordination_and_explicit',
  explicitRootIssueIds: [],
  promotedRootIssueIds: [],
  expandedEventIds: [],
  expandedPaths: [],
  selectedRowOccurrenceId: null,
  selectedEventId: null,
  selectedClusterId: null,
  timeWindow: { from: null, to: null },
  density: 'comfortable',
  visibleEventTypes: ['body', 'comment', 'state'],
  includeClosed: false,
  filterRows: [],
  panes: {
    inspector: true,
    inspectorWidth: 350,
    diagnostics: false,
    rowList: true,
    rowListWidth: 300,
  },
};
