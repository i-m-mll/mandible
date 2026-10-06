/**
 * Issue cda478c, umbrella 96c5090 — an umbrella's children are `parent_child`
 * relationship edges and nothing else, so the issue detail pane is where a
 * human reads membership.
 *
 * The load-bearing assertions here are on `partitionUmbrellaChildren`, the
 * exported predicate that decides which relationship rows are children: a red
 * there names a real defect (membership silently missing, or an issue listed
 * twice), not a changed class name. The single render case only confirms the
 * predicate is actually wired into the pane, and queries by accessible text
 * rather than markup so it does not pin presentation — see test/README.md.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { h } from "preact";

import {
  LedgerIssueDetail,
  partitionUmbrellaChildren,
} from "../ui/src/components/ledger/IssueDetail";
import type {
  LedgerIssueDetailProjection,
  LedgerIssueDetailRelationship,
  LedgerIssueSummaryRef,
} from "../ui/src/api";

function childRef(overrides: Partial<LedgerIssueSummaryRef> = {}): LedgerIssueSummaryRef {
  return {
    id: "issue-child-canonical",
    display_id: "d894231",
    project_id: "project-1",
    title: "Umbrella surfaces stop reading the body table",
    status: "open",
    resolution: null,
    kind: "feature",
    priority: "unknown",
    labels: [],
    ...overrides,
  };
}

function relationship(
  overrides: Partial<LedgerIssueDetailRelationship> = {},
): LedgerIssueDetailRelationship {
  return {
    id: "rel-1",
    direction: "outgoing",
    relationship_type: "parent_child",
    provenance: "manual",
    link_type: "parent_child", note: null,
    confidence: "certain",
    metadata: {},
    created_at: 1,
    updated_at: 1,
    related_issue: childRef(),
    ...overrides,
  };
}

function detail(overrides: Partial<LedgerIssueDetailProjection> = {}): LedgerIssueDetailProjection {
  return {
    work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
    id: "issue-umbrella-canonical",
    display_id: "96c5090",
    project: { work_repo_id: null,
      id: "project-1",
      project_key: "mandible",
      display_name: "Mandible",
      remote_identity: "",
      upstream_identity: "",
      repo_id: "mandible",
      repo_name: "mandible",
      repo_root: null,
      default_branch: "main",
    },
    title: "Umbrella: umbrella membership by relationship edges only",
    body: "",
    status: "open",
    resolution: null,
    kind: "feature",
    priority: "unknown",
    source: "mandible",
    author: {
      id: null,
      type: "mandible_user",
      display: "MLL",
      legacy_display: "MLL",
      attribution: null,
    },
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    aliases: [],
    labels: ["umbrella"],
    comments: [],
    checkpoints: [],
    timeline: [],
    relationships: [relationship()],
    work_units: [],
    sessions: [],
    auth_requests: [],
    associated_artifacts: [],
    detail_stage: "full",
    ...overrides,
  };
}

describe("partitionUmbrellaChildren", () => {
  it("claims outgoing parent_child edges as an umbrella's children", () => {
    const { children, rest } = partitionUmbrellaChildren(detail());
    expect(children.map((entry) => entry.related_issue?.display_id)).toEqual(["d894231"]);
    expect(rest).toEqual([]);
  });

  it("never claims a child twice: what the shelf shows leaves the relationship list", () => {
    const source = detail({
      relationships: [
        relationship({ id: "rel-child" }),
        relationship({ id: "rel-blocks", relationship_type: "blocks" }),
        relationship({ id: "rel-parent", direction: "incoming" }),
      ],
    });
    const { children, rest } = partitionUmbrellaChildren(source);

    expect(children.map((entry) => entry.id)).toEqual(["rel-child"]);
    expect(rest.map((entry) => entry.id)).toEqual(["rel-blocks", "rel-parent"]);
    // The partition is total and disjoint — no edge is dropped, none is shown twice.
    expect(children.length + rest.length).toBe(source.relationships.length);
  });

  it("shows canonical children for a feature without an umbrella label", () => {
    const source = detail({ labels: ["ui"] });
    const { children, rest } = partitionUmbrellaChildren(source);
    expect(children).toEqual(source.relationships);
    expect(rest).toEqual([]);
  });

  it("leaves an unresolved edge in the relationship list, where it stays visible", () => {
    const source = detail({ relationships: [relationship({ related_issue: null })] });
    const { children, rest } = partitionUmbrellaChildren(source);
    expect(children).toEqual([]);
    expect(rest.map((entry) => entry.id)).toEqual(["rel-1"]);
  });
});

describe("umbrella children shelf", () => {
  afterEach(cleanup);

  /**
   * Every row that opens an issue is a button, in the shelf and in the
   * relationship list alike, so counting the buttons that name a child counts
   * the ways a reader can reach it. Two means the pane listed it twice.
   */
  const rowsNaming = (displayId: string): HTMLElement[] =>
    screen.queryAllByRole("button").filter((el) => (el.textContent ?? "").includes(displayId));

  it("is wired into the pane: an umbrella lists its child exactly once", () => {
    render(h(LedgerIssueDetail, { detail: detail() }));

    fireEvent.click(screen.getByText("Children").closest("button")!);
    expect(rowsNaming("d894231")).toHaveLength(1);
    expect(screen.queryByText("Relationships")).toBeNull();
  });

  it("keeps a mixed umbrella's non-child edges in Relationships, still exactly once each", () => {
    render(h(LedgerIssueDetail, {
      detail: detail({
        relationships: [
          relationship({ id: "rel-child" }),
          relationship({
            id: "rel-blocks",
            relationship_type: "blocks",
            related_issue: childRef({ id: "issue-blocker", display_id: "7abe784", title: "Ledger migration" }),
          }),
        ],
      }),
    }));

    fireEvent.click(screen.getByText("Children").closest("button")!);
    fireEvent.click(screen.getByText("Relationships").closest("button")!);
    expect(rowsNaming("d894231")).toHaveLength(1);
    expect(rowsNaming("7abe784")).toHaveLength(1);
  });

  it("shows the children shelf for any kind with canonical children", () => {
    render(h(LedgerIssueDetail, { detail: detail({ labels: ["ui"] }) }));

    fireEvent.click(screen.getByText("Children").closest("button")!);
    expect(rowsNaming("d894231")).toHaveLength(1);
  });
});
