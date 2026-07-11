import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { batchLedgerIssueHeads, buildUmbrellaStatus } from "../src/routes/issues.js";

let tempDir = "";
let db: Db;
let store: LedgerStore;
let projectId = "";
let aliasCounter = 0;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-subtree-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  store = new LedgerStore(db);
  aliasCounter = 0;
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  const checkout = resolveProjectForCheckout(db, {
    root,
    name: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  });
  projectId = checkout.project.id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeIssue(title: string, kind: "umbrella" | "feature", labels: string[]) {
  return store.createIssue({
    project_id: projectId,
    title,
    body: `${title} body`,
    kind,
    priority: "normal",
    labels,
    actor_type: "agent",
    author_display: "Codex",
    aliases: [{ alias_kind: "git_bug_short", alias: `iss${(aliasCounter += 1)}` }],
  });
}

function linkParentChild(parentId: string, childId: string, at: number): void {
  store.linkRelationshipEdges({
    source_entity: { entity_type: "issue", entity_id: parentId },
    target_entities: [{ entity_type: "issue", entity_id: childId }],
    link_type: "parent_child",
    created_at: at,
  });
}

describe("subtree digests", () => {
  it("propagates a grandchild change to ancestor subtree digests while leaving own digests stable", () => {
    const umbrella = makeIssue("Umbrella", "umbrella", ["umbrella"]);
    const sub = makeIssue("Sub umbrella", "umbrella", ["umbrella"]);
    const grandchild = makeIssue("Grandchild", "feature", ["feature"]);

    let clock = Date.now();
    linkParentChild(umbrella.id, sub.id, (clock += 1));
    linkParentChild(sub.id, grandchild.id, (clock += 1));

    const umbrellaBefore = getLedgerIssueHead(db, umbrella.id);
    const subBefore = getLedgerIssueHead(db, sub.id);
    const grandchildBefore = getLedgerIssueHead(db, grandchild.id);

    store.addComment(grandchild.id, {
      body: "Work two levels down",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });

    const umbrellaAfter = getLedgerIssueHead(db, umbrella.id);
    const subAfter = getLedgerIssueHead(db, sub.id);
    const grandchildAfter = getLedgerIssueHead(db, grandchild.id);

    // Own head digests of the ancestors are untouched.
    expect(umbrellaAfter.digest).toBe(umbrellaBefore.digest);
    expect(subAfter.digest).toBe(subBefore.digest);
    // The grandchild's own head changes.
    expect(grandchildAfter.digest).not.toBe(grandchildBefore.digest);

    // Subtree digests of the grandchild and every ancestor change.
    expect(grandchildAfter.subtree_digest).not.toBe(grandchildBefore.subtree_digest);
    expect(subAfter.subtree_digest).not.toBe(subBefore.subtree_digest);
    expect(umbrellaAfter.subtree_digest).not.toBe(umbrellaBefore.subtree_digest);
    expect(umbrellaAfter.subtree_last_event_kind).toBe("comment.created");
  });

  it("leaves subtree_digest equal to the own digest for a leaf issue", () => {
    const leaf = makeIssue("Leaf", "feature", ["feature"]);
    const head = getLedgerIssueHead(db, leaf.id);
    expect(head.subtree_digest).toBe(head.digest);
  });

  it("terminates and produces a stable subtree digest for a parent_child cycle", () => {
    const a = makeIssue("Cycle A", "umbrella", ["umbrella"]);
    const b = makeIssue("Cycle B", "umbrella", ["umbrella"]);
    let clock = Date.now();
    linkParentChild(a.id, b.id, (clock += 1));
    linkParentChild(b.id, a.id, (clock += 1));

    const first = getLedgerIssueHead(db, a.id);
    const second = getLedgerIssueHead(db, a.id);
    expect(first.subtree_digest).toBe(second.subtree_digest);

    // A change on B still reaches A's subtree despite the cycle.
    store.addComment(b.id, {
      body: "Cycle comment",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });
    const afterComment = getLedgerIssueHead(db, a.id);
    expect(afterComment.subtree_digest).not.toBe(first.subtree_digest);
  });

  it("includes descendants reachable only through the legacy relationships table", () => {
    const umbrella = makeIssue("Legacy umbrella", "umbrella", ["umbrella"]);
    const child = makeIssue("Legacy child", "feature", ["feature"]);
    let clock = Date.now();
    store.upsertIssueRelationship({
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });

    const before = getLedgerIssueHead(db, umbrella.id);
    store.addComment(child.id, {
      body: "Legacy descendant activity",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });
    const after = getLedgerIssueHead(db, umbrella.id);

    expect(after.digest).toBe(before.digest);
    expect(after.subtree_digest).not.toBe(before.subtree_digest);
  });

  it("computes matching subtree digests in the batched head path", () => {
    const umbrella = makeIssue("Batch umbrella", "umbrella", ["umbrella"]);
    const sub = makeIssue("Batch sub", "umbrella", ["umbrella"]);
    const grandchild = makeIssue("Batch grandchild", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(umbrella.id, sub.id, (clock += 1));
    linkParentChild(sub.id, grandchild.id, (clock += 1));
    store.addComment(grandchild.id, {
      body: "Batch path activity",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });

    const single = getLedgerIssueHead(db, umbrella.id);
    const batch = batchLedgerIssueHeads(db, [umbrella.id, sub.id]);
    const batchUmbrella = batch.get(umbrella.id);
    expect(batchUmbrella).toBeDefined();
    expect(batchUmbrella?.digest).toBe(single.digest);
    expect(batchUmbrella?.subtree_digest).toBe(single.subtree_digest);
    // The subtree digest of the umbrella differs from its own digest because the
    // grandchild comment lives below it.
    expect(batchUmbrella?.subtree_digest).not.toBe(batchUmbrella?.digest);
  });
});

describe("umbrella child flags", () => {
  it("adds kind and child_count to non-deep and deep child summaries", () => {
    const umbrella = makeIssue("Flags umbrella", "umbrella", ["umbrella"]);
    const subUmbrella = makeIssue("Flags sub", "umbrella", ["umbrella"]);
    const leaf = makeIssue("Flags leaf", "feature", ["feature"]);
    const grandchild = makeIssue("Flags grandchild", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(umbrella.id, subUmbrella.id, (clock += 1));
    linkParentChild(umbrella.id, leaf.id, (clock += 1));
    linkParentChild(subUmbrella.id, grandchild.id, (clock += 1));

    const shallow = buildUmbrellaStatus(db, umbrella.id) as {
      children: Array<{ id: string; kind: string; child_count: number }>;
    };
    const shallowById = new Map(shallow.children.map((child) => [child.id, child]));
    expect(shallowById.get(subUmbrella.id)?.kind).toBe("umbrella");
    expect(shallowById.get(subUmbrella.id)?.child_count).toBe(1);
    expect(shallowById.get(leaf.id)?.kind).toBe("feature");
    expect(shallowById.get(leaf.id)?.child_count).toBe(0);

    const deep = buildUmbrellaStatus(db, umbrella.id, { deep: true }) as {
      children: Array<{ id: string; kind: string; child_count: number }>;
    };
    const deepById = new Map(deep.children.map((child) => [child.id, child]));
    expect(deepById.get(subUmbrella.id)?.child_count).toBe(1);
    expect(deepById.get(leaf.id)?.child_count).toBe(0);
  });

  it("counts a child linked through both edge and legacy surfaces once", () => {
    const umbrella = makeIssue("Dedupe umbrella", "umbrella", ["umbrella"]);
    const child = makeIssue("Dedupe child", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(umbrella.id, child.id, (clock += 1));
    store.upsertIssueRelationship({
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });

    const status = buildUmbrellaStatus(db, umbrella.id) as {
      children: Array<{ id: string; child_count: number }>;
    };
    // The umbrella has exactly one distinct child even though it is linked twice.
    expect(status.children).toHaveLength(1);
  });
});
