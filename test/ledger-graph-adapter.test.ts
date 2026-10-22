import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  buildLedgerIssueProjection,
  getLedgerGraphFilterOptions,
} from "../src/ledger/graph-adapter.js";
import { linkAuthRequestToLedgerIssue, linkSessionToLedgerIssue } from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { GraphNode } from "../src/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-graph-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(name: string) {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name,
    defaultBranch: "main",
    remoteUrl: "",
  });
}

function createIssue(
  store: LedgerStore,
  projectId: string,
  alias: string,
  title: string,
  options: { kind?: "feature" | "umbrella"; status?: "open" | "closed"; labels?: string[] } = {},
) {
  return store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: projectId,
    title,
    body: `${title} body`,
    kind: options.kind ?? "feature",
    status: options.status ?? "open",
    resolution: options.status === "closed" ? "delivered" : null,
    source: "git_bug",
    labels: options.labels ?? [],
    aliases: [{ alias_kind: "git_bug_short", alias, source: "git_bug", is_primary: true }],
  });
}

function insertSession(id: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (id, app, status, agent_type, branch, cwd)
     VALUES (?, 'codex', ?, 'codex', 'feature/graph', ?)`,
  ).run(id, status, path.join(tempDir, "repo"));
}

function insertAuthRequest(id: string, repo: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_requests (
      id, type, command, title, repo, commit_message, issue_ids, issues,
      execution_mode, status, created_at, updated_at, expires_at, output,
      approval_source
    ) VALUES (?, 'merge', 'git merge feature/x', 'Merge feature/x', ?, NULL, NULL, NULL,
      'daemon', 'completed', ?, ?, ?, '', 'manual')`,
  ).run(id, repo, now, now, now + 60_000);
}

function findNode(nodes: GraphNode[], title: string): GraphNode {
  const node = nodes.find((item) => item.label === title);
  if (!node) throw new Error(`node not found: ${title}`);
  return node;
}

describe("ledger graph projection", () => {
  it("projects ledger issue relationships and attaches operational evidence in issue mode", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const parent = createIssue(
      store,
      checkout.project.id,
      "par1234",
      "Umbrella parent",
      { kind: "umbrella", labels: ["umbrella"] },
    );
    const child = createIssue(store, checkout.project.id, "chi1234", "Child issue");
    store.addComment(child.id, {
      ...SYSTEM_ACTOR,
      body: "Implementation note",
      author_display: "Codex",
      actor_type: "agent",
      source: "session",
    });
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      metadata: { order: 3 },
    });

    insertAuthRequest("auth_1", checkout.checkout.root);
    linkAuthRequestToLedgerIssue(db, {
      auth_request_id: "auth_1",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
      link_type: "resolves",
    });
    insertSession("sess_live", "active");
    insertSession("sess_dead", "dead");
    linkSessionToLedgerIssue(db, {
      session_id: "sess_live",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });
    linkSessionToLedgerIssue(db, {
      session_id: "sess_dead",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });

    const projection = buildLedgerIssueProjection(db, { mode: "issue", status: "all" });

    expect(projection).not.toBeNull();
    expect(projection?.nodes.map((node) => node.type)).toEqual(["issue", "issue"]);
    const parentNode = findNode(projection?.nodes ?? [], "Umbrella parent");
    const childNode = findNode(projection?.nodes ?? [], "Child issue");
    expect(projection?.edges).toEqual([
      expect.objectContaining({
        source: parentNode.id,
        target: childNode.id,
        type: "umbrella_child",
        edge_class: "semantic",
        provenance: "ledger_issue_relationships",
        metadata: expect.objectContaining({
          relationship_type: "parent_child",
          label_default_visible: false,
          layout: "hierarchical",
        }),
      }),
    ]);

    expect(parentNode.summary).toMatchObject({ children: 1, auth_evidence: 0 });
    expect(parentNode.detail?.layout).toMatchObject({ role: "umbrella_parent", rank: 0 });
    expect(childNode.summary).toMatchObject({
      comments: 1,
      parents: 1,
      auth_evidence: 1,
      live_sessions: 1,
      historical_sessions: 1,
    });
    expect(childNode.detail?.layout).toMatchObject({ role: "umbrella_child", rank: 1, order: 3 });
    expect(childNode.detail?.annotations).toEqual([
      expect.objectContaining({ type: "auth_request", target: "auth_request:auth_1", link_type: "resolves" }),
      expect.objectContaining({ type: "session", target: "session:sess_live", status: "live" }),
    ]);
  });

  it("uses project_key for issue node identity while accepting legacy checkout filters", () => {
    const checkout = createProject("Feedbax");
    db.prepare("UPDATE ledger_projects SET project_key = ? WHERE id = ?")
      .run("feedbax", checkout.project.id);
    db.prepare("UPDATE ledger_project_checkouts SET work_repo_id = ? WHERE project_id = ?")
      .run("20-widgets-widgets", checkout.project.id);
    const store = new LedgerStore(db);
    const issue = createIssue(store, checkout.project.id, "fbx1234", "Feedbax issue");
    const expectedNodeId = `issue:feedbax:${issue.short_id}`;

    const byKey = buildLedgerIssueProjection(db, {
      mode: "issue",
      status: "all",
      repos: ["feedbax"],
    });
    const byLegacy = buildLedgerIssueProjection(db, {
      mode: "issue",
      status: "all",
      repos: ["20-widgets-widgets"],
    });

    expect(byKey?.nodes).toHaveLength(1);
    expect(byKey?.nodes[0]).toMatchObject({
      id: expectedNodeId,
      repo_id: "feedbax",
      detail: expect.objectContaining({ project_id: checkout.project.id }),
    });
    expect(byLegacy?.nodes.map((node) => node.id)).toEqual([expectedNodeId]);
    expect(getLedgerGraphFilterOptions(db).repos).toEqual(
      expect.arrayContaining(["feedbax", "20-widgets-widgets", "Feedbax"]),
    );
  });

  it("applies issue since filters before deriving visible relationship edges", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const oldIssue = createIssue(store, checkout.project.id, "old1111", "Old issue");
    const recentIssue = createIssue(store, checkout.project.id, "new1111", "Recent issue");
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    const old = Date.parse("2026-05-01T12:00:00.000Z");
    db.prepare("UPDATE ledger_issues SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(old, old, oldIssue.id);
    db.prepare("UPDATE ledger_issues SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, recentIssue.id);
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: oldIssue.id,
      target_issue_id: recentIssue.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });

    const projection = buildLedgerIssueProjection(db, {
      mode: "issue",
      status: "all",
      since: "2026-05-15T00:00:00.000Z",
    });

    expect(projection?.nodes.map((node) => node.label)).toEqual(["Recent issue"]);
    expect(projection?.edges).toEqual([]);
  });

});
