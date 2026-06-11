import fs from "node:fs";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { LedgerIssue } from "../src/ledger/types.js";

export interface TimelineFixture {
  db: Db;
  tempDir: string;
  project: { id: string; display_name: string };
  issues: {
    rootA: LedgerIssue;
    rootB: LedgerIssue;
    shared: LedgerIssue;
    nested: LedgerIssue;
    cycle: LedgerIssue;
    closed: LedgerIssue;
    deleted: LedgerIssue;
    loner: LedgerIssue;
  };
  comments: {
    rootARefs: string;
    sharedNested: string;
    manyRefs: string;
  };
}

const BASE = 1_800_000_000_000;

export function createTimelineFixture(tempDir: string): TimelineFixture {
  fs.mkdirSync(tempDir, { recursive: true });
  const db = openDb(path.join(tempDir, "mandible.db"));
  const checkout = resolveProjectForCheckout(db, {
    root: path.join(tempDir, "repo"),
    name: "timeline-fixture",
    workRepoId: "timeline-fixture",
    defaultBranch: "main",
    remoteUrl: "",
  });
  const store = new LedgerStore(db);

  const shared = store.createIssue({
    project_id: checkout.project.id,
    title: "Shared dependency",
    body: "Shared implementation body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "shared" }],
    created_at: BASE + 30,
  });
  const nested = store.createIssue({
    project_id: checkout.project.id,
    title: "Nested dependency",
    body: "Nested implementation body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "nested" }],
    created_at: BASE + 40,
  });
  const cycle = store.createIssue({
    project_id: checkout.project.id,
    title: "Cycle target",
    body: "Cycle body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "cycle" }],
    created_at: BASE + 50,
  });
  const closed = store.createIssue({
    project_id: checkout.project.id,
    title: "Closed target",
    body: "Closed target body.",
    status: "closed",
    resolution: "obsolete",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "closed" }],
    created_at: BASE + 60,
  });
  const deleted = store.createIssue({
    project_id: checkout.project.id,
    title: "Deleted target",
    body: "Deleted target body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "deleted" }],
    created_at: BASE + 70,
  });
  const loner = store.createIssue({
    project_id: checkout.project.id,
    title: "Open loner",
    body: "No refs in or out.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "loner" }],
    created_at: BASE + 80,
  });
  const rootA = store.createIssue({
    project_id: checkout.project.id,
    title: "Coordination Alpha",
    body: `## Alpha plan\nBody refs [issue:${shared.short_id}] and [issue:${closed.short_id}].`,
    kind: "umbrella",
    labels: ["coordination", "timeline"],
    aliases: [{ alias_kind: "git_bug_short", alias: "roota" }],
    created_at: BASE + 10,
  });
  const rootB = store.createIssue({
    project_id: checkout.project.id,
    title: "Coordination Beta",
    body: `Beta also references [issue:${shared.short_id}] for repeated target coverage.`,
    kind: "umbrella",
    labels: ["coordination", "timeline"],
    aliases: [{ alias_kind: "git_bug_short", alias: "rootb" }],
    created_at: BASE + 20,
  });

  const rootARefs = store.addComment(rootA.id, {
    id: "comment-root-a-refs",
    body: `Comment refs [issue:${shared.short_id}], [issue:${deleted.short_id}], and [issue:${cycle.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 110,
  }).id;
  const sharedNested = store.addComment(shared.id, {
    id: "comment-shared-nested",
    body: `Nested ref [issue:${nested.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 120,
  }).id;
  const manyRefs = store.addComment(rootB.id, {
    id: "comment-root-b-many-refs",
    body: [
      `Many refs [issue:${shared.short_id}]`,
      `[issue:${nested.short_id}]`,
      `[issue:${cycle.short_id}]`,
      `[issue:${closed.short_id}]`,
      `[issue:${deleted.short_id}]`,
    ].join(" "),
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 130,
  }).id;
  store.addComment(cycle.id, {
    id: "comment-cycle-back",
    body: `Cycle back to [issue:${rootA.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 140,
  });
  store.setLabel(shared.id, "needs-review", true);
  store.setLabel(nested.id, "needs-review", true);
  store.setLabel(shared.id, `parent:${rootA.short_id}`, true);
  store.setLabel(nested.id, `parent:${shared.short_id}`, true);
  store.setLabel(cycle.id, `parent:${nested.short_id}`, true);
  store.setLabel(shared.id, `parent:${cycle.short_id}`, true);
  store.setIssueStatus(rootA.id, "closed", "merged");
  store.setIssueStatus(rootA.id, "open", null);
  db.prepare(
    `UPDATE ledger_events
     SET occurred_at = CASE event_type
       WHEN 'issue.closed' THEN ?
       WHEN 'issue.reopened' THEN ?
       ELSE occurred_at
     END
     WHERE entity_type = 'issue' AND entity_id = ? AND event_type IN ('issue.closed', 'issue.reopened')`,
  ).run(BASE + 150, BASE + 160, rootA.id);
  db.prepare("UPDATE ledger_issues SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(BASE + 170, BASE + 170, deleted.id);

  return {
    db,
    tempDir,
    project: {
      id: checkout.project.id,
      display_name: checkout.project.display_name,
    },
    issues: { rootA, rootB, shared, nested, cycle, closed, deleted, loner },
    comments: { rootARefs, sharedNested, manyRefs },
  };
}
