import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { listLedgerIssueSummaries } from "../../src/ledger/issue-projection.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { LedgerStore } from "../../src/ledger/store.js";
import { systemAction } from "../../src/identity/resolver.js";

// Ledger writes require an explicit attribution context (main/user-system).
const SYSTEM_ACTOR = { attribution: systemAction() };

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-summary-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(name: string) {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name,
    workRepoId: name,
    defaultBranch: "main",
    remoteUrl: "",
  });
}

// listLedgerIssueSummaries only needs getRepos; checkouts come from the ledger.
const emptyScanner = { getRepos: () => [] };

describe("set-based issue summary projection", () => {
  it("uses the canonical project key instead of a path-derived scanner id", () => {
    const root = path.join(tempDir, "20 Widgets", "widgets");
    fs.mkdirSync(root, { recursive: true });
    const checkout = resolveProjectForCheckout(db, {
      root,
      name: "widgets",
      workRepoId: "20-widgets-widgets",
      defaultBranch: "main",
      remoteUrl: "https://github.com/example/widgets.git",
    });
    const store = new LedgerStore(db);
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Canonical route",
      body: "Hydrated detail",
      aliases: [{ alias_kind: "git_bug_human", alias: "abc1234", is_primary: true }],
    });

    const summaries = listLedgerIssueSummaries(db, {
      getRepos: () => [{
        id: "20-widgets-widgets",
        name: "widgets",
        root,
        exists: true,
        default_branch: "main",
        excluded: false,
        user_modified: false,
        last_scanned_at: null,
      }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      repo_id: "widgets",
      project_key: "widgets",
    });
    expect(summaries[0].issues[0].repo_id).toBe("widgets");
  });

  it("omits descriptions, batches labels and counts, and derives parent refs", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);

    const parent = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Umbrella",
      body: "Parent body",
      kind: "umbrella",
      labels: ["umbrella"],
      aliases: [{ alias_kind: "git_bug_human", alias: "par1234", is_primary: true }],
    });
    const child = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Child",
      body: "Child body",
      kind: "maintenance",
      labels: ["feature", "zeta"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi1234", is_primary: true }],
    });
    const merged = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Merged",
      body: "Merged body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "mer1234", is_primary: true }],
    });
    const closed = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Closed",
      body: "Closed body",
      kind: "feature",
      labels: ["legacy", "parent:manual99"],
      aliases: [{ alias_kind: "git_bug_human", alias: "clo1234", is_primary: true }],
    });

    // Structured parent relationship: parent -> child.
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: parent.id },
      target_entities: [{ entity_type: "issue", entity_id: child.id }],
      link_type: "parent_child",
      provenance: "manual",
    });

    // Deleted label must not appear in the summary row.
    store.setLabel(child.id, "deleted-label", true, "mandible", SYSTEM_ACTOR);
    store.setLabel(child.id, "deleted-label", false, "mandible", SYSTEM_ACTOR);

    store.setIssueStatus(merged.id, "closed", "delivered", SYSTEM_ACTOR);
    store.setLabel(merged.id, "merged", true, "mandible", SYSTEM_ACTOR);
    store.setIssueStatus(closed.id, "closed", "wontfix", SYSTEM_ACTOR);

    const summaries = listLedgerIssueSummaries(db, emptyScanner);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];

    expect(summary.open_count).toBe(2); // parent + child
    expect(summary.delivered_count).toBe(1);
    expect(summary.closed_count).toBe(2);

    const byTitle = new Map(summary.issues.map((issue) => [issue.title, issue]));

    const childRow = byTitle.get("Child")!;
    expect(childRow.kind).toBe("maintenance");
    expect(byTitle.get("Merged")!.resolution).toBe("delivered");
    // Description omitted from list rows.
    expect(childRow.description).toBeUndefined();
    // Active labels only, sorted; deleted label excluded.
    expect(childRow.labels).toEqual(["feature", "zeta"]);
    // Parent ref comes from the canonical edge and the parent's short id.
    expect(childRow.parent_id).toBe(parent.short_id);
    expect(childRow.parent_ids).toEqual([parent.id]);

    // Legacy parent:<id> labels no longer derive parentage.
    const closedRow = byTitle.get("Closed")!;
    expect(closedRow.parent_id).toBeUndefined();

    // Issue with no parent has no parent_id.
    expect(byTitle.get("Umbrella")!.parent_id).toBeUndefined();
  });
});
