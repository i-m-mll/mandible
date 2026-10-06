import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { getLedgerIssueHead, batchLedgerIssueHeads } from "../src/ledger/issue-heads.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { buildUmbrellaStatus } from "../src/routes/issues.js";

let tempDir = "";
let db: Db;
let store: LedgerStore;
let projectId = "";
let aliasCounter = 0;
const SYSTEM_ACTOR = { attribution: systemAction() };

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
    ...SYSTEM_ACTOR,
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
    actor: SYSTEM_ACTOR,
  });
}

function fixedHeadFixture() {
  for (const id of ["fixed-root", "fixed-inner", "fixed-shared", "fixed-empty"]) {
    store.createIssue({ ...SYSTEM_ACTOR, id, project_id: projectId, title: id, kind: "feature", created_at: 1 });
  }
  linkParentChild("fixed-root", "fixed-inner", 200);
  linkParentChild("fixed-inner", "fixed-shared", 201);
  linkParentChild("fixed-shared", "fixed-root", 202);
  linkParentChild("fixed-root", "fixed-root", 203);
  store.upsertIssueRelationship({ actor: SYSTEM_ACTOR, source_issue_id: "fixed-root",
    target_issue_id: "fixed-shared", relationship_type: "parent_child", provenance: "manual", created_at: 204 });
  const comment = store.addComment("fixed-shared", { ...SYSTEM_ACTOR, body: "comment", created_at: 1 });
  const deleted = store.addComment("fixed-root", { ...SYSTEM_ACTOR, body: "deleted", created_at: 1 });
  const checkpoint = store.addIssueCheckpoint("fixed-root", { ...SYSTEM_ACTOR, kind: "delegation-manifest", payload: [], created_at: 1 });
  db.prepare("DELETE FROM ledger_events").run();
  db.prepare("UPDATE ledger_comments SET id = 'fixed-comment' WHERE id = ?").run(comment.id);
  db.prepare("UPDATE ledger_comments SET id = 'fixed-deleted', deleted_at = 1 WHERE id = ?").run(deleted.id);
  db.prepare("UPDATE ledger_issue_checkpoints SET id = 'fixed-checkpoint' WHERE id = ?").run(checkpoint.id);
  db.prepare("UPDATE ledger_relationship_edges SET id = 'fixed-self' WHERE source_issue_id = target_issue_id").run();
  db.prepare("UPDATE ledger_issue_relationships SET id = 'fixed-legacy'").run();
  const insert = db.prepare(`INSERT INTO ledger_events
    (id, entity_type, entity_id, event_type, actor_type, source, payload_json, occurred_at, observed_at)
    VALUES (?, ?, ?, ?, 'agent', 'mandible', ?, ?, ?)`);
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

describe("subtree digests", () => {
  it("preserves fixed digest bytes from the independent pre-consolidation engines", () => {
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
    expect(batchLedgerIssueHeads(db, ["fixed-root", "fixed-inner"], options).get("fixed-root"))
      .toEqual(getLedgerIssueHead(db, "fixed-root", options));
  });

  it("keeps event reads set-based as the root count grows", () => {
    fixedHeadFixture();
    const roots = ["fixed-root", "fixed-inner", "fixed-shared", "fixed-empty"];
    for (let n = 0; n < 96; n++) {
      const id = `batch-root-${n}`;
      store.createIssue({ ...SYSTEM_ACTOR, id, project_id: projectId, title: id, kind: "feature" });
      roots.push(id);
    }
    const prepare = vi.spyOn(db, "prepare");
    try {
      for (const ids of [[roots[0]], roots, [...roots, ...roots]]) {
        prepare.mockClear();
        expect(batchLedgerIssueHeads(db, ids).size).toBe(new Set(ids).size);
        expect(prepare.mock.calls).toHaveLength(3);
        expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM ledger_events"))).toHaveLength(1);
      }
      prepare.mockClear();
      expect(batchLedgerIssueHeads(db, []).size).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

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
      ...SYSTEM_ACTOR,
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
      ...SYSTEM_ACTOR,
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
      actor: SYSTEM_ACTOR,
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });

    const before = getLedgerIssueHead(db, umbrella.id);
    store.addComment(child.id, {
      ...SYSTEM_ACTOR,
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
      ...SYSTEM_ACTOR,
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

  it("matches single-path digests for a descendant shared between two roots", () => {
    const u1 = makeIssue("Shared U1", "umbrella", ["umbrella"]);
    const u2 = makeIssue("Shared U2", "umbrella", ["umbrella"]);
    const shared = makeIssue("Shared child", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(u1.id, shared.id, (clock += 1));
    linkParentChild(u2.id, shared.id, (clock += 1));
    store.addComment(shared.id, {
      ...SYSTEM_ACTOR,
      body: "Activity under a shared descendant",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });

    const singleU1 = getLedgerIssueHead(db, u1.id);
    const singleU2 = getLedgerIssueHead(db, u2.id);
    const batch = batchLedgerIssueHeads(db, [u1.id, u2.id]);
    expect(batch.get(u1.id)?.digest).toBe(singleU1.digest);
    expect(batch.get(u1.id)?.subtree_digest).toBe(singleU1.subtree_digest);
    expect(batch.get(u2.id)?.digest).toBe(singleU2.digest);
    expect(batch.get(u2.id)?.subtree_digest).toBe(singleU2.subtree_digest);
    // Both roots see the shared child in their subtree.
    expect(batch.get(u1.id)?.subtree_digest).not.toBe(batch.get(u1.id)?.digest);
    expect(batch.get(u2.id)?.subtree_digest).not.toBe(batch.get(u2.id)?.digest);
  });

  it("matches single-path digests when a root is also a descendant of another root", () => {
    const outer = makeIssue("Outer root", "umbrella", ["umbrella"]);
    const inner = makeIssue("Inner root", "umbrella", ["umbrella"]);
    const leaf = makeIssue("Nested leaf", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(outer.id, inner.id, (clock += 1));
    linkParentChild(inner.id, leaf.id, (clock += 1));
    store.addComment(leaf.id, {
      ...SYSTEM_ACTOR,
      body: "Activity two levels below the outer root",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });

    const singleOuter = getLedgerIssueHead(db, outer.id);
    const singleInner = getLedgerIssueHead(db, inner.id);
    // `inner` is passed as a batch root AND is a descendant of `outer`.
    const batch = batchLedgerIssueHeads(db, [outer.id, inner.id]);
    expect(batch.get(outer.id)?.digest).toBe(singleOuter.digest);
    expect(batch.get(outer.id)?.subtree_digest).toBe(singleOuter.subtree_digest);
    expect(batch.get(inner.id)?.digest).toBe(singleInner.digest);
    expect(batch.get(inner.id)?.subtree_digest).toBe(singleInner.subtree_digest);
  });

  it("matches single-path own digest for a self-referential parent_child link", () => {
    // `issue link X X --type parent_child` is not rejected, so the relationship
    // event is attached to X as both endpoints. The batch path fetches it under
    // the source and target keys via UNION ALL; without (issue_id, event_id)
    // de-duplication the own-head digest double-counts it while the single path
    // counts it once. This asserts they stay byte-identical.
    const x = makeIssue("Self link", "umbrella", ["umbrella"]);
    let clock = Date.now();
    linkParentChild(x.id, x.id, (clock += 1));
    store.addComment(x.id, {
      ...SYSTEM_ACTOR,
      body: "Comment alongside a self-link",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });

    const single = getLedgerIssueHead(db, x.id);
    const batch = batchLedgerIssueHeads(db, [x.id]);
    expect(batch.get(x.id)?.digest).toBe(single.digest);
    expect(batch.get(x.id)?.subtree_digest).toBe(single.subtree_digest);
  });

  it("orders same-timestamp events by UTF-8 bytes to match the single path (case-mixed ids)", () => {
    // Two events sharing occurred_at AND observed_at are tie-broken by id. The
    // single path relies on SQLite's BINARY collation (`ORDER BY ... id`), a
    // memcmp over the stored UTF-8 bytes: 'B...' sorts before 'a...'. A
    // locale-aware comparator (`localeCompare`) reverses that pair, so the batch
    // path must use a byte-order tie-break to stay byte-identical. This test
    // fails against the `localeCompare` comparator.
    const issue = makeIssue("Tie ordering", "feature", ["feature"]);
    const ts = Date.now() + 1_000_000;
    const insert = db.prepare(
      `INSERT INTO ledger_events
         (id, entity_type, entity_id, event_type, actor_type, source, payload_json, occurred_at, observed_at)
       VALUES (?, 'issue', ?, ?, 'agent', 'mandible', ?, ?, ?)`,
    );
    insert.run("Btie-event", issue.id, "issue.updated", JSON.stringify({ n: 1 }), ts, ts);
    insert.run("atie-event", issue.id, "issue.updated", JSON.stringify({ n: 2 }), ts, ts);

    const single = getLedgerIssueHead(db, issue.id);
    const batch = batchLedgerIssueHeads(db, [issue.id]);
    expect(batch.get(issue.id)?.digest).toBe(single.digest);
    expect(batch.get(issue.id)?.subtree_digest).toBe(single.subtree_digest);
  });

  it("orders same-timestamp events with non-BMP ids by UTF-8 bytes, not UTF-16 code units", () => {
    // UTF-8 byte order and UTF-16 code-unit order diverge across the surrogate
    // range: U+E000 is UTF-8 `EE 80 80` / UTF-16 `E000`, while U+10000 is UTF-8
    // `F0 90 80 80` / UTF-16 `D800 DC00`. SQLite's BINARY collation (memcmp
    // over UTF-8) puts U+E000 first; a JS `<` string comparison (UTF-16 code
    // units) puts U+10000 first because D800 < E000. The batch tie-break must
    // compare UTF-8 bytes to match the single path's SQLite ordering, so this
    // test fails against a plain `<` code-unit comparator.
    const issue = makeIssue("Non-BMP tie ordering", "feature", ["feature"]);
    const ts = Date.now() + 2_000_000;
    const insert = db.prepare(
      `INSERT INTO ledger_events
         (id, entity_type, entity_id, event_type, actor_type, source, payload_json, occurred_at, observed_at)
       VALUES (?, 'issue', ?, ?, 'agent', 'mandible', ?, ?, ?)`,
    );
    insert.run("tie-\u{E000}-event", issue.id, "issue.updated", JSON.stringify({ n: 1 }), ts, ts);
    insert.run("tie-\u{10000}-event", issue.id, "issue.updated", JSON.stringify({ n: 2 }), ts, ts);

    const single = getLedgerIssueHead(db, issue.id);
    const batch = batchLedgerIssueHeads(db, [issue.id]);
    expect(batch.get(issue.id)?.digest).toBe(single.digest);
    expect(batch.get(issue.id)?.subtree_digest).toBe(single.subtree_digest);
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
      actor: SYSTEM_ACTOR,
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
    // And the reported count reflects that single distinct child, not two.
    expect(status.children[0]?.child_count).toBe(0);
  });

  it("reports child_count directly, deduping both-surface links and excluding soft-deleted edges", () => {
    const umbrella = makeIssue("Count umbrella", "umbrella", ["umbrella"]);
    const child = makeIssue("Count child", "umbrella", ["umbrella"]);
    const dual = makeIssue("Grandchild dual", "feature", ["feature"]);
    const removed = makeIssue("Grandchild removed", "feature", ["feature"]);
    const live = makeIssue("Grandchild live", "feature", ["feature"]);
    let clock = Date.now();
    linkParentChild(umbrella.id, child.id, (clock += 1));
    // `dual` is linked to `child` through both the structured edge graph and the
    // legacy relationship table; it must be counted once.
    linkParentChild(child.id, dual.id, (clock += 1));
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: child.id,
      target_issue_id: dual.id,
      relationship_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });
    // `removed` is linked then soft-deleted; it must NOT be counted.
    linkParentChild(child.id, removed.id, (clock += 1));
    store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: child.id },
      target_entities: [{ entity_type: "issue", entity_id: removed.id }],
      link_type: "parent_child",
      occurred_at: (clock += 1),
    });
    // `live` is a normal remaining edge.
    linkParentChild(child.id, live.id, (clock += 1));

    const status = buildUmbrellaStatus(db, umbrella.id) as {
      children: Array<{ id: string; child_count: number }>;
    };
    const summary = status.children.find((entry) => entry.id === child.id);
    // dual (deduped to 1) + live (1); removed is excluded → 2.
    expect(summary?.child_count).toBe(2);
  });
});
