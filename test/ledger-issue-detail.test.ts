import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import {
  linkAuthRequestToLedgerIssue,
  linkSessionToLedgerIssue,
  linkWorkUnitToLedgerIssue,
} from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-detail-"));
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

function insertSession(id: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (id, app, status, branch, task, created_at, updated_at, last_active)
     VALUES (?, 'codex', ?, 'feature/detail', 'Implement detail', ?, ?, ?)`,
  ).run(id, status, "2026-05-16T12:00:00.000Z", "2026-05-16T12:05:00.000Z", "2026-05-16T12:05:00.000Z");
}

function insertAuthRequest(id: string, repoRoot: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_requests (
      id, type, command, title, repo, base_branch, head_branch,
      execution_mode, status, created_at, updated_at, resolved_at,
      expires_at, output, approval_source
    ) VALUES (?, 'merge', 'git merge feature/detail', 'Merge feature/detail',
      ?, 'main', 'feature/detail', 'daemon', 'completed', ?, ?, ?, ?, '', 'manual')`,
  ).run(id, repoRoot, now, now, now, now + 60_000);
}

describe("ledger issue detail projection", () => {
  it("projects comments, relationships, operational evidence, sync, and conflicts", () => {
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
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi1234", is_primary: true }],
    });
    store.addComment(child.id, {
      body: "Implementation note",
      actor_type: "agent",
      author_display: "Codex",
      source: "session",
    });
    store.upsertIssueRelationship({
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      metadata: { order: 2 },
    });

    insertSession("sess_live", "active");
    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, assigned_session_id,
        created_at, ledger_issue_id
      ) VALUES ('wu_1', 'chi1234', 'repo', 'feature/detail', 'solo', 'open', 'sess_live', ?, ?)`,
    ).run(Date.now(), child.id);
    linkWorkUnitToLedgerIssue(db, {
      work_unit_id: "wu_1",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });
    linkSessionToLedgerIssue(db, {
      session_id: "sess_live",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });
    insertAuthRequest("auth_1", checkout.checkout.root);
    linkAuthRequestToLedgerIssue(db, {
      auth_request_id: "auth_1",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
      link_type: "resolves",
    });
    store.recordConflict({
      adapter: "git_bug",
      project_id: checkout.project.id,
      entity_type: "issue",
      entity_id: child.id,
      field: "relationship_label",
      local_value: null,
      remote_value: { target_ref: "missing" },
      source: "git_bug",
    });

    const projection = buildLedgerIssueDetailProjection(db, child.id);

    expect(projection).toMatchObject({
      id: child.id,
      display_id: "chi1234",
      project: { repo_id: "repo", repo_name: "repo" },
      title: "Child",
      body: "Child body",
      labels: ["feature"],
      sync: { state: "conflicted", open_conflicts: 1 },
    });
    expect(projection.comments).toMatchObject([
      { body: "Implementation note", author: { type: "agent", display: "Codex" }, source: "session" },
    ]);
    expect(projection.relationships).toMatchObject([
      {
        direction: "incoming",
        relationship_type: "parent_child",
        related_issue: { display_id: "par1234", title: "Umbrella" },
      },
    ]);
    expect(projection.work_units).toMatchObject([
      {
        id: "wu_1",
        branch: "feature/detail",
        liveness: { has_live_agent: true, agent_session_id: "sess_live" },
      },
    ]);
    expect(projection.sessions).toMatchObject([
      { id: "sess_live", status: "active", link_type: "worked_on" },
    ]);
    expect(projection.auth_requests).toMatchObject([
      { id: "auth_1", status: "completed", link_type: "resolves" },
    ]);
    expect(projection.conflicts[0].remote_value).toEqual({ target_ref: "missing" });
  });

  it("resolves conflicts without applying remote values implicitly", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      project_id: checkout.project.id,
      title: "Conflicted",
      aliases: [{ alias_kind: "git_bug_human", alias: "abc123", is_primary: true }],
    });
    const conflict = store.recordConflict({
      adapter: "git_bug",
      project_id: checkout.project.id,
      entity_type: "issue",
      entity_id: issue.id,
      field: "title",
      local_value: "Local",
      remote_value: "Remote",
      source: "git_bug",
    });

    const resolved = store.resolveConflict(conflict.id, {
      resolution: "keep_mandible",
      actor_type: "mandible_user",
      author_display: "Mandible",
    });

    expect(resolved).toMatchObject({ status: "resolved", resolution: "keep_mandible" });
    expect(store.getIssue(issue.id).title).toBe("Conflicted");
    expect(buildLedgerIssueDetailProjection(db, issue.id).conflicts).toEqual([]);
  });
});
