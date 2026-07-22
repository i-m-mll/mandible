import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { listLedgerIssueSummaries } from "../src/ledger/issue-projection.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

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
  it("omits descriptions, batches labels and counts, and derives parent refs", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);

    const parent = store.createIssue({
      project_id: checkout.project.id,
      title: "Umbrella",
      body: "Parent body",
      kind: "umbrella",
      labels: ["umbrella"],
      aliases: [{ alias_kind: "git_bug_human", alias: "par1234", is_primary: true }],
    });
    const child = store.createIssue({
      project_id: checkout.project.id,
      title: "Child",
      body: "Child body",
      kind: "feature",
      labels: ["feature", "zeta"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi1234", is_primary: true }],
    });
    const merged = store.createIssue({
      project_id: checkout.project.id,
      title: "Merged",
      body: "Merged body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "mer1234", is_primary: true }],
    });
    const closed = store.createIssue({
      project_id: checkout.project.id,
      title: "Closed",
      body: "Closed body",
      kind: "feature",
      labels: ["legacy", "parent:manual99"],
      aliases: [{ alias_kind: "git_bug_human", alias: "clo1234", is_primary: true }],
    });

    // Structured parent relationship: child -> parent (derives via alias).
    store.upsertIssueRelationship({
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });

    // Deleted label must not appear in the summary row.
    store.setLabel(child.id, "deleted-label", true);
    store.setLabel(child.id, "deleted-label", false);

    store.setIssueStatus(merged.id, "closed", "merged");
    store.setLabel(merged.id, "merged", true);
    store.setIssueStatus(closed.id, "closed", null);

    const summaries = listLedgerIssueSummaries(db, emptyScanner);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];

    expect(summary.open_count).toBe(2); // parent + child
    expect(summary.merged_count).toBe(1);
    expect(summary.closed_count).toBe(1);

    const byTitle = new Map(summary.issues.map((issue) => [issue.title, issue]));

    const childRow = byTitle.get("Child")!;
    // Description omitted from list rows.
    expect(childRow.description).toBeUndefined();
    // Active labels only, sorted; deleted label excluded.
    expect(childRow.labels).toEqual(["feature", "zeta"]);
    // Parent ref resolved from the incoming parent_child relationship, using the
    // same alias ordering (is_primary DESC, alias_kind) as the per-issue path —
    // the canonical alias (= issue id) sorts ahead of git_bug_human.
    expect(childRow.parent_id).toBe(parent.id);

    // Legacy parent:<id> label wins for parent ref derivation.
    const closedRow = byTitle.get("Closed")!;
    expect(closedRow.parent_id).toBe("manual99");

    // Issue with no parent has no parent_id.
    expect(byTitle.get("Umbrella")!.parent_id).toBeUndefined();
  });
});
