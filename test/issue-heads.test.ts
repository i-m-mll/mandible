import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { batchLedgerIssueHeads, getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { buildUmbrellaStatus } from "../src/routes/issues.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const SYSTEM_ACTOR = { attribution: systemAction() };

let tempDir = "";
let db: Db;
let store: LedgerStore;
let projectId = "";
let aliasCounter = 0;
let clock = 0;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-heads-"));
  db = migratedMemoryDb();
  setDb(db);
  store = new LedgerStore(db);
  aliasCounter = 0;
  clock = Date.now() + 1_000_000;
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  projectId = resolveProjectForCheckout(db, {
    root,
    name: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  }).project.id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const tick = () => (clock += 1);

function makeIssue(title: string, kind: "umbrella" | "feature" = "feature") {
  return store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: projectId,
    title,
    body: `${title} body`,
    kind,
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
    aliases: [{ alias_kind: "git_bug_short", alias: `iss${(aliasCounter += 1)}` }],
  });
}

function comment(issueId: string, body = "comment") {
  return store.addComment(issueId, { ...SYSTEM_ACTOR, body, created_at: tick() });
}

function linkParentChild(parentId: string, childId: string): void {
  store.linkRelationshipEdges({
    source_entity: { entity_type: "issue", entity_id: parentId },
    target_entities: [{ entity_type: "issue", entity_id: childId }],
    link_type: "parent_child",
    created_at: tick(),
    actor: SYSTEM_ACTOR,
  });
}

function linkLegacyParentChild(parentId: string, childId: string): void {
  store.upsertIssueRelationship({
    actor: SYSTEM_ACTOR,
    source_issue_id: parentId,
    target_issue_id: childId,
    relationship_type: "parent_child",
    provenance: "manual",
    created_at: tick(),
  });
}

function fixedHeadFixture() {
  for (const id of ["fixed-root", "fixed-inner", "fixed-shared", "fixed-empty"]) {
    store.createIssue({ ...SYSTEM_ACTOR, id, project_id: projectId, title: id, kind: "feature", created_at: 1 });
  }
  const link = (source: string, target: string, at: number) => store.linkRelationshipEdges({
    source_entity: { entity_type: "issue", entity_id: source },
    target_entities: [{ entity_type: "issue", entity_id: target }],
    link_type: "parent_child",
    created_at: at,
    actor: SYSTEM_ACTOR,
  });
  link("fixed-root", "fixed-inner", 200);
  link("fixed-inner", "fixed-shared", 201);
  link("fixed-shared", "fixed-root", 202);
  link("fixed-root", "fixed-root", 203);
  store.upsertIssueRelationship({ actor: SYSTEM_ACTOR, source_issue_id: "fixed-root",
    target_issue_id: "fixed-shared", relationship_type: "parent_child", provenance: "manual", created_at: 204 });
  const kept = store.addComment("fixed-shared", { ...SYSTEM_ACTOR, body: "comment", created_at: 1 });
  const deleted = store.addComment("fixed-root", { ...SYSTEM_ACTOR, body: "deleted", created_at: 1 });
  const checkpoint = store.addIssueCheckpoint("fixed-root", { ...SYSTEM_ACTOR, kind: "delegation-manifest", payload: [], created_at: 1 });
  db.prepare("DELETE FROM ledger_events").run();
  db.prepare("UPDATE ledger_comments SET id = 'fixed-comment' WHERE id = ?").run(kept.id);
  db.prepare("UPDATE ledger_comments SET id = 'fixed-deleted', deleted_at = 1 WHERE id = ?").run(deleted.id);
  db.prepare("UPDATE ledger_issue_checkpoints SET id = 'fixed-checkpoint' WHERE id = ?").run(checkpoint.id);
  db.prepare("UPDATE ledger_relationship_edges SET id = 'fixed-self' WHERE source_issue_id = target_issue_id").run();
  db.prepare("UPDATE ledger_issue_relationships SET id = 'fixed-legacy'").run();
  const insert = db.prepare(`INSERT INTO ledger_events
    (id, entity_type, entity_id, event_type, actor_type, source, payload_json, occurred_at, observed_at)
    VALUES (?, ?, ?, ?, 'agent', 'mandible', ?, ?, ?)`);
  // The two "tie-" ids share a timestamp and sort differently in UTF-8 bytes
  // and UTF-16 code units; the digest follows SQLite's byte order.
  for (const [id, type, entity, at] of [
    ["tie-\u{E000}", "issue", "fixed-root", 10],
    ["tie-\u{10000}", "issue", "fixed-root", 10],
    ["inner", "issue", "fixed-inner", 9],
    ["comment", "comment", "fixed-comment", 11],
    ["deleted", "comment", "fixed-deleted", 12],
    ["checkpoint", "issue_checkpoint", "fixed-checkpoint", 13],
    ["self", "relationship_edge", "fixed-self", 14],
    ["legacy", "issue_relationship", "fixed-legacy", 15],
    ["later", "issue", "fixed-shared", 30],
  ] as const) insert.run(id, type, entity, `${type}.changed`, '{"b":2,"a":1}', at, at);
}

describe("issue heads", () => {
  it("keeps fixed digest bytes for a fixture with cycles, a self-link, both edge surfaces and tied timestamps", () => {
    fixedHeadFixture();
    const current = getLedgerIssueHead(db, "fixed-root");
    expect(current).toMatchObject({
      digest: "a8734c42bdc661f425aa13cd7625c6bda510e293bc6624804515c51084f28ad2",
      subtree_digest: "384296a42a8d7ad45a08515d84295673077314c6e420f02c9fe09ae4e5d89872",
      last_event_at: 15, last_event_kind: "issue_relationship.changed",
      subtree_last_event_at: 30, subtree_last_event_kind: "issue.changed",
    });
    const options = { at: 15, excludeCheckpointId: "fixed-checkpoint" };
    expect(getLedgerIssueHead(db, "fixed-root", options)).toMatchObject({
      digest: "2c90611b83c0b46855bfd288cbd46bc69ebb6395c789791d386301a99903f8a3",
      subtree_digest: "f9db15fffee4ff63fbab642fe55c1fea59df533bd97e27179aec21b6b188e6b1",
      subtree_last_event_at: 15, subtree_last_event_kind: "issue_relationship.changed",
    });
    const batch = batchLedgerIssueHeads(db, ["fixed-root", "fixed-inner", "fixed-empty", "missing"]);
    expect(batch.get("fixed-root")).toEqual(current);
    expect(batch.get("fixed-inner")?.digest).toBe("c676aacbec8524874be9013855cf8aefa7fecd2b573bd32f2bb93d85fd90347a");
    expect(batch.get("fixed-empty")).toMatchObject({
      digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      subtree_digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      last_event_at: null, last_event_kind: null, subtree_last_event_at: null, subtree_last_event_kind: null,
    });
    expect(batch.has("missing")).toBe(false);
    expect(() => getLedgerIssueHead(db, "missing")).toThrow("Ledger issue not found: missing");
  });

  type Issue = ReturnType<typeof makeIssue>;
  const mutations: Array<{
    name: string;
    setup?: (a: Issue, b: Issue) => void;
    apply: (a: Issue, b: Issue) => void;
    changes: Array<"a" | "b">;
    kind: string;
  }> = [
    { name: "comment", apply: (a) => comment(a.id), changes: ["a"], kind: "comment.created" },
    {
      name: "checkpoint",
      apply: (a) => store.addIssueCheckpoint(a.id, { ...SYSTEM_ACTOR, kind: "delegation-manifest", payload: [], created_at: tick() }),
      changes: ["a"],
      kind: "issue.checkpoint.created",
    },
    {
      name: "edge linked",
      apply: (a, b) => store.linkRelationshipEdges({
        actor: SYSTEM_ACTOR,
        source_entity: { entity_type: "issue", entity_id: a.id },
        target_entities: [{ entity_type: "issue", entity_id: b.id }],
        link_type: "references",
        created_at: tick(),
      }),
      changes: ["a", "b"],
      kind: "relationship.added",
    },
    {
      name: "edge unlinked",
      setup: (a, b) => store.linkRelationshipEdges({
        actor: SYSTEM_ACTOR,
        source_entity: { entity_type: "issue", entity_id: a.id },
        target_entities: [{ entity_type: "issue", entity_id: b.id }],
        link_type: "references",
        created_at: tick(),
      }),
      apply: (a, b) => store.unlinkRelationshipEdges({
        actor: SYSTEM_ACTOR,
        source_entity: { entity_type: "issue", entity_id: a.id },
        target_entities: [{ entity_type: "issue", entity_id: b.id }],
        link_type: "references",
        occurred_at: tick(),
      }),
      changes: ["a", "b"],
      kind: "relationship.removed",
    },
    {
      name: "stored relationship",
      apply: (a, b) => store.upsertIssueRelationship({
        actor: SYSTEM_ACTOR,
        source_issue_id: a.id,
        target_issue_id: b.id,
        relationship_type: "blocks",
        provenance: "manual",
        created_at: tick(),
      }),
      changes: ["a", "b"],
      kind: "relationship.upserted",
    },
  ];

  it.each(mutations)("changes exactly the touched issues' digests on $name", ({ setup, apply, changes, kind }) => {
    const issues = { a: makeIssue("A"), b: makeIssue("B"), idle: makeIssue("Idle") };
    setup?.(issues.a, issues.b);
    const before = Object.fromEntries(Object.entries(issues).map(([key, issue]) => [key, getLedgerIssueHead(db, issue.id)]));

    apply(issues.a, issues.b);

    for (const [key, issue] of Object.entries(issues)) {
      const after = getLedgerIssueHead(db, issue.id);
      if ((changes as string[]).includes(key)) {
        expect(after.digest, key).not.toBe(before[key].digest);
        expect(after.last_event_kind, key).toBe(kind);
      } else {
        expect(after.digest, key).toBe(before[key].digest);
      }
    }
  });

  it("recomputes a historical head at an event cutoff", () => {
    const issue = makeIssue("Historical");
    store.addIssueCheckpoint(issue.id, { ...SYSTEM_ACTOR, kind: "delegation-manifest", payload: [], created_at: tick() });
    const atCheckpoint = getLedgerIssueHead(db, issue.id);
    comment(issue.id, "later");
    const current = getLedgerIssueHead(db, issue.id);

    expect(getLedgerIssueHead(db, issue.id, { at: atCheckpoint.last_event_at ?? 0 }).digest).toBe(atCheckpoint.digest);
    expect(current.digest).not.toBe(atCheckpoint.digest);
  });

  it("propagates a grandchild change to every ancestor's subtree digest and to no own digest", () => {
    const umbrella = makeIssue("Umbrella", "umbrella");
    const sub = makeIssue("Sub umbrella", "umbrella");
    const grandchild = makeIssue("Grandchild");
    linkParentChild(umbrella.id, sub.id);
    linkParentChild(sub.id, grandchild.id);
    const ids = [umbrella.id, sub.id, grandchild.id];
    const before = ids.map((id) => getLedgerIssueHead(db, id));

    comment(grandchild.id, "Work two levels down");
    const after = ids.map((id) => getLedgerIssueHead(db, id));

    expect(after.map((head) => head.digest)).toEqual([before[0].digest, before[1].digest, expect.not.stringMatching(before[2].digest)]);
    after.forEach((head, index) => expect(head.subtree_digest).not.toBe(before[index].subtree_digest));
    expect(after[0].subtree_last_event_kind).toBe("comment.created");
    const leaf = getLedgerIssueHead(db, makeIssue("Leaf").id);
    expect(leaf.subtree_digest).toBe(leaf.digest);
  });

  it("terminates on a parent_child cycle and still sees changes across it", () => {
    const a = makeIssue("Cycle A", "umbrella");
    const b = makeIssue("Cycle B", "umbrella");
    linkParentChild(a.id, b.id);
    linkParentChild(b.id, a.id);
    const first = getLedgerIssueHead(db, a.id);
    expect(getLedgerIssueHead(db, a.id).subtree_digest).toBe(first.subtree_digest);

    comment(b.id);
    expect(getLedgerIssueHead(db, a.id).subtree_digest).not.toBe(first.subtree_digest);
  });

  it("includes descendants reachable only through the legacy relationships table", () => {
    const umbrella = makeIssue("Legacy umbrella", "umbrella");
    const child = makeIssue("Legacy child");
    linkLegacyParentChild(umbrella.id, child.id);
    const before = getLedgerIssueHead(db, umbrella.id);

    comment(child.id);
    const after = getLedgerIssueHead(db, umbrella.id);

    expect(after.digest).toBe(before.digest);
    expect(after.subtree_digest).not.toBe(before.subtree_digest);
  });

  it("gives every root of a multi-root batch the same head it has alone", () => {
    const outer = makeIssue("Outer", "umbrella");
    const inner = makeIssue("Inner", "umbrella");
    const sibling = makeIssue("Sibling", "umbrella");
    const shared = makeIssue("Shared leaf");
    linkParentChild(outer.id, inner.id);
    linkParentChild(inner.id, shared.id);
    linkParentChild(sibling.id, shared.id);
    comment(shared.id);

    const roots = [outer.id, inner.id, sibling.id];
    const batch = batchLedgerIssueHeads(db, roots);
    for (const id of roots) {
      expect(batch.get(id)).toEqual(getLedgerIssueHead(db, id));
      expect(batch.get(id)?.subtree_digest).not.toBe(batch.get(id)?.digest);
    }
  });
});

describe("umbrella child summaries", () => {
  type Summary = { children: Array<{ id: string; kind: string; child_count: number }> };

  it("reports each child's kind and direct child count, shallow and deep", () => {
    const umbrella = makeIssue("Flags umbrella", "umbrella");
    const sub = makeIssue("Flags sub", "umbrella");
    const leaf = makeIssue("Flags leaf");
    linkParentChild(umbrella.id, sub.id);
    linkParentChild(umbrella.id, leaf.id);
    linkParentChild(sub.id, makeIssue("Flags grandchild").id);

    for (const deep of [false, true]) {
      const children = new Map((buildUmbrellaStatus(db, umbrella.id, { deep }) as Summary).children.map((child) => [child.id, child]));
      expect(children.get(sub.id)).toMatchObject({ kind: "umbrella", child_count: 1 });
      expect(children.get(leaf.id)).toMatchObject({ kind: "feature", child_count: 0 });
    }
  });

  it("counts a child linked on both edge surfaces once and drops unlinked edges", () => {
    const umbrella = makeIssue("Count umbrella", "umbrella");
    const child = makeIssue("Count child", "umbrella");
    const dual = makeIssue("Grandchild dual");
    const removed = makeIssue("Grandchild removed");
    linkParentChild(umbrella.id, child.id);
    linkLegacyParentChild(umbrella.id, child.id);
    linkParentChild(child.id, dual.id);
    linkLegacyParentChild(child.id, dual.id);
    linkParentChild(child.id, removed.id);
    store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: child.id },
      target_entities: [{ entity_type: "issue", entity_id: removed.id }],
      link_type: "parent_child",
      occurred_at: tick(),
    });
    linkParentChild(child.id, makeIssue("Grandchild live").id);

    const { children } = buildUmbrellaStatus(db, umbrella.id) as Summary;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ id: child.id, child_count: 2 });
  });
});
