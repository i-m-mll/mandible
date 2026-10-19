import { describe, expect, it } from "vitest";
import {
  buildParentChildrenByIssueId,
  containsResidualPredicate,
  evaluatePredicate,
  intervalOverlapsWindow,
  labelList,
  normalizeLabelMembershipMode,
  resolveIssueId,
  type IssueRow,
  type LabelHistoryIndex,
  type PredicateEvalContext,
} from "../src/ledger/issue-predicate.js";
import type { LedgerIssueRelationshipSource } from "../src/ledger/types.js";
import type {
  TimelineDiagnostic,
  TimelineIssuePredicate,
  TimelineLabelMembershipInterval,
} from "../src/types.js";

const LABEL_SEPARATOR = "\x1f";

function issueRow(overrides: Partial<IssueRow> & { id: string }): IssueRow {
  const labels = Array.isArray((overrides as { labelsList?: string[] }).labelsList)
    ? (overrides as { labelsList?: string[] }).labelsList!.join(LABEL_SEPARATOR)
    : overrides.labels ?? "";
  return {
    id: overrides.id,
    short_id: overrides.short_id ?? overrides.id,
    project_id: "prj",
    title: overrides.title ?? `Issue ${overrides.id}`,
    body: "",
    status: overrides.status ?? "open",
    worker_status: "none",
    resolution: null,
    kind: overrides.kind ?? "feature",
    priority: "normal",
    author_actor_id: null,
    author_actor_type: "agent",
    author_display: "test",
    source: "mandible",
    created_at: overrides.created_at ?? 0,
    updated_at: 0,
    closed_at: null,
    deleted_at: overrides.deleted_at ?? null,
    labels,
  };
}

function makeIssue(id: string, kind: IssueRow["kind"], labelsList: string[], shortId?: string): IssueRow {
  return issueRow({ id, kind, labels: labelsList.join(LABEL_SEPARATOR), short_id: shortId ?? id });
}

function relationshipSource(sourceIssueId: string, targetIssueId: string): LedgerIssueRelationshipSource {
  return {
    id: `${sourceIssueId}->${targetIssueId}`,
    relationship_id: `${sourceIssueId}->${targetIssueId}`,
    source_entity_type: "issue_body",
    source_entity_id: sourceIssueId,
    source_issue_id: sourceIssueId,
    target_issue_id: targetIssueId,
    relationship_type: "references",
    ref_kind: "issue",
    raw_ref: targetIssueId,
    normalized_ref: targetIssueId,
    metadata_json: "{}",
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  };
}

interface ContextOverrides {
  issues?: IssueRow[];
  relationshipSources?: LedgerIssueRelationshipSource[];
  parentEdges?: Array<{ source_issue_id: string; target_issue_id: string; deleted_at: number | null }>;
  residualCoveredIssueIds?: Set<string>;
  labelHistory?: LabelHistoryIndex;
  window?: { from: number | null; to: number | null };
  labelMembershipModeOverride?: PredicateEvalContext["labelMembershipModeOverride"];
}

function makeContext(overrides: ContextOverrides = {}): PredicateEvalContext {
  const issues = overrides.issues ?? [];
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  return {
    allIssues: issues,
    issueById,
    relationshipSources: overrides.relationshipSources ?? [],
    parentChildrenByIssueId: buildParentChildrenByIssueId(issues, overrides.parentEdges),
    residualCoveredIssueIds: overrides.residualCoveredIssueIds ?? new Set<string>(),
    labelHistory: overrides.labelHistory ?? { intervalsByLabel: new Map() },
    window: overrides.window ?? { from: null, to: null },
    labelMembershipModeOverride: overrides.labelMembershipModeOverride,
  };
}

function evalIds(predicate: TimelineIssuePredicate, context: PredicateEvalContext): {
  ids: string[];
  diagnostics: TimelineDiagnostic[];
} {
  const diagnostics: TimelineDiagnostic[] = [];
  const result = evaluatePredicate(predicate, context, "spec", diagnostics);
  return { ids: [...result].sort(), diagnostics };
}

describe("issue-predicate helpers", () => {
  it("splits and sorts packed labels", () => {
    expect(labelList(makeIssue("a", "feature", ["z", "a", "m"]))).toEqual(["a", "m", "z"]);
    expect(labelList(makeIssue("a", "feature", []))).toEqual([]);
  });

  it("resolves canonical id or short id", () => {
    const issues = [makeIssue("issue-1", "feature", [], "i1")];
    const map = new Map(issues.map((issue) => [issue.id, issue]));
    expect(resolveIssueId("issue-1", map)).toBe("issue-1");
    expect(resolveIssueId("i1", map)).toBe("issue-1");
    expect(resolveIssueId("missing", map)).toBeNull();
  });

  it("normalizes label membership mode", () => {
    expect(normalizeLabelMembershipMode("ever_in_window")).toBe("ever_in_window");
    expect(normalizeLabelMembershipMode("now")).toBe("now");
    expect(normalizeLabelMembershipMode(undefined)).toBe("now");
    expect(normalizeLabelMembershipMode("garbage")).toBe("now");
  });

  it("detects window overlap with open intervals", () => {
    const interval = (start: number, end: number | null): TimelineLabelMembershipInterval => ({
      issue_id: "x",
      label: "l",
      start,
      end,
      degraded: false,
    });
    expect(intervalOverlapsWindow(interval(10, 20), { from: 15, to: 25 })).toBe(true);
    expect(intervalOverlapsWindow(interval(10, 12), { from: 15, to: 25 })).toBe(false);
    expect(intervalOverlapsWindow(interval(30, null), { from: null, to: 25 })).toBe(false);
    expect(intervalOverlapsWindow(interval(10, null), { from: null, to: null })).toBe(true);
  });

  it("recurses into compound predicates for residual detection", () => {
    expect(containsResidualPredicate({ type: "residual" })).toBe(true);
    expect(containsResidualPredicate({ type: "label", name: "x" })).toBe(false);
    expect(containsResidualPredicate({
      type: "and",
      predicates: [{ type: "label", name: "x" }, { type: "not", predicate: { type: "residual" } }],
    })).toBe(true);
  });

  it("builds a sorted parent-children adjacency map from canonical edges", () => {
    const issues = [
      makeIssue("root", "umbrella", [], "r"),
      makeIssue("child-b", "feature", ["parent:r"], "cb"),
      makeIssue("child-a", "feature", ["parent:r"], "ca"),
    ];
    const map = buildParentChildrenByIssueId(issues, [
      { source_issue_id: "root", target_issue_id: "child-b", deleted_at: null },
      { source_issue_id: "root", target_issue_id: "child-a", deleted_at: null },
    ]);
    expect(map.get("root")).toEqual(["child-a", "child-b"]);
  });
});

describe("evaluatePredicate", () => {
  it("matches label membership by current labels", () => {
    const context = makeContext({
      issues: [
        makeIssue("a", "feature", ["needs-review"]),
        makeIssue("b", "feature", []),
        makeIssue("c", "bug", ["needs-review"]),
      ],
    });
    expect(evalIds({ type: "label", name: "needs-review" }, context).ids).toEqual(["a", "c"]);
  });

  it("matches ever-in-window label membership from history", () => {
    const issues = [makeIssue("a", "feature", []), makeIssue("b", "feature", [])];
    const context = makeContext({
      issues,
      window: { from: 100, to: 200 },
      labelHistory: {
        intervalsByLabel: new Map([
          ["needs-review", [
            { issue_id: "a", label: "needs-review", start: 150, end: 160, degraded: false },
            { issue_id: "b", label: "needs-review", start: 300, end: null, degraded: false },
          ]],
        ]),
      },
    });
    expect(evalIds({ type: "label", name: "needs-review", membership: "ever_in_window" }, context).ids)
      .toEqual(["a"]);
  });

  it("honors labelMembershipModeOverride", () => {
    const issues = [makeIssue("a", "feature", ["needs-review"])];
    const context = makeContext({
      issues,
      labelMembershipModeOverride: "now",
      labelHistory: {
        intervalsByLabel: new Map([
          ["needs-review", [{ issue_id: "z", label: "needs-review", start: 0, end: null, degraded: false }]],
        ]),
      },
    });
    // override forces "now", so history ("z") is ignored and current labels ("a") win
    expect(evalIds({ type: "label", name: "needs-review", membership: "ever_in_window" }, context).ids)
      .toEqual(["a"]);
  });

  it("matches issue kind and rejects unknown kinds with a diagnostic", () => {
    const context = makeContext({
      issues: [makeIssue("a", "feature", []), makeIssue("b", "umbrella", [])],
    });
    expect(evalIds({ type: "kind", kind: "feature" }, context).ids).toEqual(["a"]);

    const bad = evalIds({ type: "kind", kind: "nope" as never }, context);
    expect(bad.ids).toEqual([]);
    expect(bad.diagnostics).toEqual([
      expect.objectContaining({ kind: "invalid_predicate" }),
    ]);
  });

  it("matches referenced_by targets and resolves the source by short id", () => {
    const context = makeContext({
      issues: [makeIssue("src", "umbrella", [], "s"), makeIssue("t1", "feature", []), makeIssue("t2", "feature", [])],
      relationshipSources: [relationshipSource("src", "t1"), relationshipSource("src", "t2")],
    });
    expect(evalIds({ type: "referenced_by", issue_id: "s" }, context).ids).toEqual(["t1", "t2"]);
  });

  it("expands a parent subtree and reports cycles", () => {
    const issues = [
      makeIssue("root", "umbrella", [], "r"),
      makeIssue("child", "feature", ["parent:r"], "c"),
      makeIssue("grand", "feature", ["parent:c"], "g"),
      makeIssue("loop", "feature", ["parent:g"], "l"),
    ];
    // introduce a cycle: grand's parent label also points back through loop
    issues[2] = makeIssue("grand", "feature", ["parent:c", "parent:l"], "g");
    const context = makeContext({
      issues,
      parentEdges: [
        { source_issue_id: "root", target_issue_id: "child", deleted_at: null },
        { source_issue_id: "child", target_issue_id: "grand", deleted_at: null },
        { source_issue_id: "grand", target_issue_id: "loop", deleted_at: null },
        { source_issue_id: "loop", target_issue_id: "grand", deleted_at: null },
      ],
    });
    const result = evalIds({ type: "parent_subtree", issue_id: "r" }, context);
    expect(result.ids).toEqual(["child", "grand", "loop"]);
    expect(result.diagnostics.some((d) => d.kind === "cycle")).toBe(true);
  });

  it("returns the residual complement", () => {
    const context = makeContext({
      issues: [makeIssue("a", "feature", []), makeIssue("b", "feature", []), makeIssue("c", "feature", [])],
      residualCoveredIssueIds: new Set(["a"]),
    });
    expect(evalIds({ type: "residual" }, context).ids).toEqual(["b", "c"]);
  });

  it("combines predicates with and/or/not", () => {
    const context = makeContext({
      issues: [
        makeIssue("a", "feature", ["needs-review"]),
        makeIssue("b", "feature", []),
        makeIssue("c", "umbrella", ["needs-review"]),
      ],
    });
    expect(evalIds({
      type: "and",
      predicates: [{ type: "kind", kind: "feature" }, { type: "label", name: "needs-review" }],
    }, context).ids).toEqual(["a"]);

    expect(evalIds({
      type: "or",
      predicates: [{ type: "kind", kind: "umbrella" }, { type: "label", name: "needs-review" }],
    }, context).ids).toEqual(["a", "c"]);

    expect(evalIds({
      type: "not",
      predicate: { type: "label", name: "needs-review" },
    }, context).ids).toEqual(["b"]);
  });

  it("reports diagnostics for malformed predicate shapes", () => {
    const context = makeContext({ issues: [makeIssue("a", "feature", [])] });
    expect(evalIds(null as never, context).diagnostics).toEqual([
      expect.objectContaining({ kind: "invalid_predicate" }),
    ]);
    expect(evalIds({ type: "and", predicates: [] }, context).diagnostics).toEqual([
      expect.objectContaining({ kind: "invalid_predicate" }),
    ]);
    expect(evalIds({ type: "referenced_by", issue_id: "missing" }, context).diagnostics).toEqual([
      expect.objectContaining({ kind: "invalid_predicate" }),
    ]);
  });
});
