import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  buildLedgerIssueProjection,
  countLedgerGraphIssues,
  getLedgerGraphFilterOptions,
} from "../src/ledger/graph-adapter.js";
import { linkAuthRequestToLedgerIssue, linkSessionToLedgerIssue } from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { GraphNode } from "../src/types.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-graph-"));
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
    project_id: projectId,
    title,
    body: `${title} body`,
    kind: options.kind ?? "feature",
    status: options.status ?? "open",
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
      body: "Implementation note",
      author_display: "Codex",
      actor_type: "agent",
      source: "session",
    });
    store.upsertIssueRelationship({
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
    expect(projection?.edges).toEqual([
      expect.objectContaining({
        source: expect.stringContaining("par1234"),
        target: expect.stringContaining("chi1234"),
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

    const parentNode = findNode(projection?.nodes ?? [], "Umbrella parent");
    const childNode = findNode(projection?.nodes ?? [], "Child issue");
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
      expect.objectContaining({ type: "session", target: "session:sess_live", status: "active" }),
    ]);
  });

  it("uses ledger project candidates for repo filters and mode counts", () => {
    const alpha = createProject("alpha");
    const beta = createProject("beta");
    const store = new LedgerStore(db);
    createIssue(store, alpha.project.id, "alp1111", "Alpha issue");
    createIssue(store, beta.project.id, "bet1111", "Beta issue", { status: "closed" });

    const alphaProjection = buildLedgerIssueProjection(db, {
      mode: "issue",
      status: "all",
      repos: ["alpha"],
    });

    expect(alphaProjection?.nodes.map((node) => node.label)).toEqual(["Alpha issue"]);
    expect(countLedgerGraphIssues(db, "all")).toBe(2);
    expect(countLedgerGraphIssues(db, "open")).toBe(1);
    expect(getLedgerGraphFilterOptions(db).repos).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });
});
