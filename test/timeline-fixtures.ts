import fs from "node:fs";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
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
    authDone: LedgerIssue;
  };
  comments: {
    rootARefs: string;
    sharedNested: string;
    manyRefs: string;
  };
  operationalEvents: {
    authCompleted: string;
  };
}

const BASE = 1_800_000_000_000;
const SYSTEM_ACTOR = { attribution: systemAction() };

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
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Shared dependency",
    body: "Shared implementation body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "shared" }],
    created_at: BASE + 30,
  });
  const nested = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Nested dependency",
    body: "Nested implementation body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "nested" }],
    created_at: BASE + 40,
  });
  const cycle = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Cycle target",
    body: "Cycle body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "cycle" }],
    created_at: BASE + 50,
  });
  const closed = store.createIssue({
    ...SYSTEM_ACTOR,
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
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Deleted target",
    body: "Deleted target body.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "deleted" }],
    created_at: BASE + 70,
  });
  const loner = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Open loner",
    body: "No refs in or out.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "loner" }],
    created_at: BASE + 80,
  });
  const authDone = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Auth completed issue",
    body: "Auth completion should appear as an operational event.",
    kind: "feature",
    labels: ["feature"],
    aliases: [{ alias_kind: "git_bug_short", alias: "authdone" }],
    created_at: BASE + 90,
  });
  const rootA = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Coordination Alpha",
    body: `## Alpha plan\nBody refs [issue:${shared.short_id}] and [issue:${closed.short_id}].`,
    kind: "umbrella",
    labels: ["coordination", "timeline"],
    aliases: [{ alias_kind: "git_bug_short", alias: "roota" }],
    created_at: BASE + 10,
  });
  const rootB = store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: checkout.project.id,
    title: "Coordination Beta",
    body: `Beta also references [issue:${shared.short_id}] for repeated target coverage.`,
    kind: "umbrella",
    labels: ["coordination", "timeline"],
    aliases: [{ alias_kind: "git_bug_short", alias: "rootb" }],
    created_at: BASE + 20,
  });

  const rootARefs = store.addComment(rootA.id, {
    ...SYSTEM_ACTOR,
    id: "comment-root-a-refs",
    body: `Comment refs [issue:${shared.short_id}], [issue:${deleted.short_id}], and [issue:${cycle.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 110,
  }).id;
  const sharedNested = store.addComment(shared.id, {
    ...SYSTEM_ACTOR,
    id: "comment-shared-nested",
    body: `Nested ref [issue:${nested.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 120,
  }).id;
  const manyRefs = store.addComment(rootB.id, {
    ...SYSTEM_ACTOR,
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
    ...SYSTEM_ACTOR,
    id: "comment-cycle-back",
    body: `Cycle back to [issue:${rootA.short_id}].`,
    actor_type: "agent",
    author_display: "Codex",
    created_at: BASE + 140,
  });
  store.setLabel(shared.id, "needs-review", true, "mandible", SYSTEM_ACTOR);
  store.setLabel(nested.id, "needs-review", true, "mandible", SYSTEM_ACTOR);
  store.setLabel(shared.id, `parent:${rootA.short_id}`, true, "mandible", SYSTEM_ACTOR);
  store.setLabel(nested.id, `parent:${shared.short_id}`, true, "mandible", SYSTEM_ACTOR);
  store.setLabel(cycle.id, `parent:${nested.short_id}`, true, "mandible", SYSTEM_ACTOR);
  store.setLabel(shared.id, `parent:${cycle.short_id}`, true, "mandible", SYSTEM_ACTOR);
  store.setIssueStatus(rootA.id, "closed", "merged", SYSTEM_ACTOR);
  store.setIssueStatus(rootA.id, "open", null, SYSTEM_ACTOR);
  store.setLabel(rootB.id, "needs-review", true, "mandible", SYSTEM_ACTOR);
  store.setLabel(rootB.id, "needs-review", false, "mandible", SYSTEM_ACTOR);
  db.prepare(
    `UPDATE ledger_events
     SET occurred_at = ?, observed_at = ?
     WHERE event_type = 'label.updated'
       AND occurred_at < ?`,
  ).run(BASE + 155, BASE + 155, BASE);
  db.prepare(
    `UPDATE ledger_labels
     SET created_at = ?
     WHERE created_at < ?`,
  ).run(BASE + 155, BASE);
  const authCompleted = store.recordEvent({
    ...SYSTEM_ACTOR,
    entity_type: "auth_request",
    entity_id: "auth_timeline_1",
    event_type: "auth_request.completed",
    actor_type: "system",
    source: "auth_queue",
    project_id: checkout.project.id,
    enqueueOutbox: false,
    payload: {
      auth_request_id: "auth_timeline_1",
      issue_id: authDone.id,
      approval_source: "manual",
      approval_lease_id: null,
    },
    occurred_at: BASE + 190,
  });
  store.setIssueStatus(
    authDone.id,
    "closed",
    "merged",
    { ...SYSTEM_ACTOR, actor_type: "system", actor_id: null },
    "auth_queue",
  );
  db.prepare(
    `UPDATE ledger_events
     SET occurred_at = CASE event_type
       WHEN 'issue.closed' THEN ?
       WHEN 'issue.reopened' THEN ?
       ELSE occurred_at
     END
     WHERE entity_type = 'issue' AND entity_id = ? AND event_type IN ('issue.closed', 'issue.reopened')`,
  ).run(BASE + 150, BASE + 160, rootA.id);
  db.prepare(
    `UPDATE ledger_events
     SET occurred_at = CASE json_extract(payload_json, '$.present')
       WHEN 1 THEN ?
       ELSE ?
     END,
     observed_at = CASE json_extract(payload_json, '$.present')
       WHEN 1 THEN ?
       ELSE ?
     END
     WHERE entity_type = 'issue' AND entity_id = ? AND event_type = 'label.updated'`,
  ).run(BASE + 175, BASE + 180, BASE + 175, BASE + 180, rootB.id);
  db.prepare(
    `UPDATE ledger_labels
     SET created_at = ?, deleted_at = ?
     WHERE issue_id = ? AND label = 'needs-review'`,
  ).run(BASE + 175, BASE + 180, rootB.id);
  db.prepare(
    `UPDATE ledger_events
     SET occurred_at = ?, observed_at = ?
     WHERE entity_type = 'issue'
       AND entity_id = ?
       AND event_type = 'issue.closed'
       AND source = 'auth_queue'`,
  ).run(BASE + 195, BASE + 195, authDone.id);
  db.prepare("UPDATE ledger_issues SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(BASE + 170, BASE + 170, deleted.id);

  return {
    db,
    tempDir,
    project: {
      id: checkout.project.id,
      display_name: checkout.project.display_name,
    },
    issues: { rootA, rootB, shared, nested, cycle, closed, deleted, loner, authDone },
    comments: { rootARefs, sharedNested, manyRefs },
    operationalEvents: { authCompleted: authCompleted.id },
  };
}
