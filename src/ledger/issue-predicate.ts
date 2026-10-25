import type {
  TimelineDiagnostic,
  TimelineIssuePredicate,
  TimelineLabelMembershipInterval,
  TimelineLabelMembershipMode,
} from "../types.js";
import type {
  LedgerIssue,
  LedgerIssueKind,
  LedgerIssueRelationshipSource,
} from "./types.js";
import { LEDGER_ISSUE_KINDS } from "./types.js";

/**
 * Shared backend issue-predicate evaluator.
 *
 * This is the single implementation of {@link evaluatePredicate} consumed by
 * both the Timeline projection (`timeline-projection.ts`) and the Spaces
 * `/seed` endpoint. The predicate shape is the canonical
 * {@link TimelineIssuePredicate} defined in `src/types.ts` (mirrored for the UI
 * in `ui/src/types/timeline.ts`). Keep this module free of Timeline-specific
 * concerns so other surfaces can reuse it.
 */

/** The issue fields predicates, Timeline rows, and Spaces seeding read for every project issue. */
export type IssueRow = Pick<
  LedgerIssue,
  "id" | "short_id" | "project_id" | "title" | "status" | "resolution" | "kind" | "priority" | "created_at" | "deleted_at"
> & { labels: string };

/** One live `references` relationship source, reduced to the issues it joins. */
export type IssueReference = Pick<LedgerIssueRelationshipSource, "source_issue_id" | "target_issue_id">;

export interface ParentChildIndex {
  childrenOf(issueId: string): readonly string[];
}

export interface LabelHistoryIndex {
  intervalsForLabel(label: string): readonly TimelineLabelMembershipInterval[];
}

export interface PredicateEvalContext {
  allIssues: IssueRow[];
  issueById: Map<string, IssueRow>;
  references: readonly IssueReference[];
  parentChildren: ParentChildIndex;
  residualCoveredIssueIds: Set<string>;
  labelHistory: LabelHistoryIndex;
  window: { from: number | null; to: number | null };
  labelMembershipModeOverride?: TimelineLabelMembershipMode;
}

export interface PredicateDiagnosticInput {
  kind: "invalid_predicate" | "unmatched_predicate" | "cycle";
  message: string;
  row_spec_id?: string;
  issue_id?: string;
  target_issue_id?: string;
  predicate?: TimelineIssuePredicate;
  path?: string[];
}

const LABEL_SEPARATOR = "\x1f";

/** Split the packed `labels` column into a sorted list of label names. */
export function labelList(issue: IssueRow): string[] {
  return issue.labels
    ? issue.labels.split(LABEL_SEPARATOR).filter((label) => label.length > 0).sort()
    : [];
}

/** Resolve a canonical issue id or short id to a canonical id, or null. */
export function resolveIssueId(ref: string, issues: Map<string, IssueRow>): string | null {
  if (issues.has(ref)) return ref;
  for (const issue of issues.values()) {
    if (issue.short_id === ref) return issue.id;
  }
  return null;
}

export function predicateDiagnostic(input: PredicateDiagnosticInput): TimelineDiagnostic {
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

export function intervalOverlapsWindow(
  interval: TimelineLabelMembershipInterval,
  window: { from: number | null; to: number | null },
): boolean {
  const end = interval.end ?? Number.POSITIVE_INFINITY;
  if (window.from !== null && end < window.from) return false;
  if (window.to !== null && interval.start > window.to) return false;
  return true;
}

export function normalizeLabelMembershipMode(value: unknown): TimelineLabelMembershipMode {
  return value === "ever_in_window" ? "ever_in_window" : "now";
}

export function containsResidualPredicate(predicate: TimelineIssuePredicate): boolean {
  if (predicate.type === "residual") return true;
  if (predicate.type === "and" || predicate.type === "or") {
    return predicate.predicates.some(containsResidualPredicate);
  }
  if (predicate.type === "not") return containsResidualPredicate(predicate.predicate);
  return false;
}

/** Build the parent → children adjacency map from canonical relationship edges. */
export function buildParentChildrenByIssueId(
  issues: IssueRow[],
  edges: ReadonlyArray<Pick<LedgerIssueRelationshipSource, "source_issue_id" | "target_issue_id" | "deleted_at">> = [],
): Map<string, string[]> {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.deleted_at !== null || !issueById.has(edge.target_issue_id)) continue;
    const list = children.get(edge.source_issue_id) ?? [];
    list.push(edge.target_issue_id);
    children.set(edge.source_issue_id, list);
  }
  for (const [parentId, list] of children) {
    children.set(parentId, Array.from(new Set(list)).sort());
  }
  return children;
}

function union(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
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
    for (const childId of context.parentChildren.childrenOf(issueId)) {
      result.add(childId);
      visit(childId, [...path, `issue:${childId}`]);
    }
    visiting.delete(issueId);
    visited.add(issueId);
  };

  visit(rootId, [`issue:${rootId}`]);
  return result;
}

/**
 * Evaluate an issue predicate against a {@link PredicateEvalContext}, returning
 * the set of matching canonical issue ids. Invalid or unmatched predicate
 * shapes are reported by appending {@link TimelineDiagnostic} entries to
 * `diagnostics`; the function never throws on malformed input.
 */
export function evaluatePredicate(
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
      return new Set(context.references
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
        return new Set(context.labelHistory.intervalsForLabel(name)
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
