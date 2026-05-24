import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  applyAuthRequestLedgerCompletion,
  linkAuthRequestToLedgerIssue,
  linkSessionToLedgerIssue,
  linkWorkUnitToLedgerIssue,
  resolveOperationalIssueRef,
  runOperationalLinkBackfill,
  syncAuthRequestLedgerLinks,
} from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-operational-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(name: string, remoteUrl = "") {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name,
    defaultBranch: "main",
    remoteUrl,
  });
}

function createIssue(projectId: string, alias: string, title = `Issue ${alias}`) {
  return new LedgerStore(db).createIssue({
    project_id: projectId,
    title,
    body: "Body",
    kind: "feature",
    source: "git_bug",
    aliases: [{ alias_kind: "git_bug_short", alias, source: "git_bug", is_primary: true }],
  });
}

function insertSession(id: string): void {
  db.prepare("INSERT INTO sessions (id, app, status) VALUES (?, 'codex', 'active')").run(id);
}

function insertWorkUnit(id: string, issueId: string, repoId: string): void {
  db.prepare(
    `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at)
     VALUES (?, ?, ?, ?, 'solo', 'open', ?)`,
  ).run(id, issueId, repoId, `feature/${id}`, Date.now());
}

function insertAuthRequest(input: {
	  id: string;
	  repo: string;
	  issueReferences?: string[] | null;
	  issueClosures?: string[] | null;
	  issueIds?: string[] | null;
	  issues?: string[] | null;
  commitMessage?: string | null;
}): void {
  const now = Date.now();
	db.prepare(
	  `INSERT INTO auth_requests (
	      id, type, command, title, repo, commit_message,
	      issue_references, issue_closures, issue_ids, issues,
	      execution_mode, status, created_at, updated_at, expires_at, output,
	      approval_source
	    ) VALUES (?, 'merge', 'git merge feature/x', 'Merge feature/x', ?, ?, ?, ?, ?, ?,
	      'daemon', 'pending', ?, ?, ?, '', 'manual')`,
	).run(
	  input.id,
	  input.repo,
	  input.commitMessage ?? null,
	  input.issueReferences ? JSON.stringify(input.issueReferences) : null,
	  input.issueClosures ? JSON.stringify(input.issueClosures) : null,
	  input.issueIds ? JSON.stringify(input.issueIds) : null,
	  input.issues ? JSON.stringify(input.issues) : null,
    now,
    now,
    now + 60_000,
  );
}

describe("ledger operational links", () => {
  it("resolves issue refs by checkout scope and reports ambiguity without scope", () => {
    const first = createProject("alpha");
    const second = createProject("beta");
    const firstIssue = createIssue(first.project.id, "same123", "Alpha issue");
    const secondIssue = createIssue(second.project.id, "same123", "Beta issue");

    const ambiguous = resolveOperationalIssueRef(db, "same123");
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous).toMatchObject({
      error: "ambiguous",
      matches: [firstIssue.id, secondIssue.id].sort(),
    });

    expect(resolveOperationalIssueRef(db, "same123", first.checkout.root)).toEqual({
      ok: true,
      issue_id: firstIssue.id,
      project_id: first.project.id,
    });
  });

  it("links work units, sessions, and auth requests to canonical ledger issues", () => {
    const project = createProject("repo");
    const issue = createIssue(project.project.id, "abc1234");
    insertWorkUnit("wu_1", "abc1234", project.checkout.root);
    insertSession("sess_1");
    insertAuthRequest({
      id: "auth_1",
      repo: project.checkout.root,
      issueIds: ["abc1234"],
      commitMessage: "Merge work\n\nBug: abc1234\n",
    });

    const workResult = linkWorkUnitToLedgerIssue(db, {
      work_unit_id: "wu_1",
      issue_ref: "abc1234",
      repo_ref: project.checkout.root,
    });
    const sessionResult = linkSessionToLedgerIssue(db, {
      session_id: "sess_1",
      issue_ref: "abc1234",
      repo_ref: project.checkout.root,
    });
	const authResults = syncAuthRequestLedgerLinks(db, {
	  auth_request_id: "auth_1",
	  repo_ref: project.checkout.root,
	  issue_ids: ["abc1234"],
	  commit_message: "Merge work\n\nBug: abc1234\n",
    });

    expect(workResult).toMatchObject({ ok: true, issue_id: issue.id });
    expect(sessionResult).toMatchObject({ ok: true, issue_id: issue.id });
    expect(authResults).toHaveLength(1);
    expect(authResults[0]).toMatchObject({ ok: true, issue_id: issue.id });
    expect(
      db.prepare("SELECT ledger_issue_id FROM work_units WHERE id = 'wu_1'").get(),
    ).toEqual({ ledger_issue_id: issue.id });
    expect(
      db.prepare("SELECT issue_id, link_type FROM ledger_session_issue_links WHERE session_id = 'sess_1'").get(),
    ).toEqual({ issue_id: issue.id, link_type: "worked_on" });
	expect(
	  db.prepare("SELECT issue_id, link_type FROM ledger_auth_issue_links WHERE auth_request_id = 'auth_1'").get(),
	).toEqual({ issue_id: issue.id, link_type: "references" });
  });

  it("backfills legacy operational rows and persists unresolved mismatches", () => {
    const project = createProject("repo");
    const issue = createIssue(project.project.id, "good123");
    insertWorkUnit("wu_good", "good123", project.checkout.root);
    insertWorkUnit("wu_missing", "missing123", project.checkout.root);

    const report = runOperationalLinkBackfill(db);

    expect(report.status).toBe("incomplete");
    expect(report.source_counts.work_units).toBe(2);
    expect(report.resolved_count).toBe(1);
    expect(report.unresolved_count).toBe(1);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        source_table: "work_units",
        source_id: "wu_missing",
        issue_ref: "missing123",
        mismatch_type: "not_found",
      }),
    ]);
    expect(
      db.prepare("SELECT ledger_issue_id FROM work_units WHERE id = 'wu_good'").get(),
    ).toEqual({ ledger_issue_id: issue.id });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ledger_operational_link_mismatches WHERE report_id = ?").get(report.id),
    ).toEqual({ count: 1 });
  });

  it("closes only explicitly resolving auth links when an auth request completes", () => {
    const project = createProject("repo");
    const resolvedIssue = createIssue(project.project.id, "done123", "Resolved issue");
    const referencedIssue = createIssue(project.project.id, "note123", "Referenced issue");
	insertAuthRequest({
	  id: "auth_2",
	  repo: project.checkout.root,
	  issueClosures: ["done123"],
	});
    linkAuthRequestToLedgerIssue(db, {
      auth_request_id: "auth_2",
      issue_ref: "note123",
      repo_ref: project.checkout.root,
      link_type: "references",
    });

	const results = applyAuthRequestLedgerCompletion(db, {
	  auth_request_id: "auth_2",
	  repo_ref: project.checkout.root,
	  issue_closures: ["done123"],
	  approval_source: "manual",
	  approval_lease_id: "lease_1",
    });

    expect(results).toHaveLength(1);
    expect(new LedgerStore(db).getIssue(resolvedIssue.id)).toMatchObject({
      status: "closed",
      resolution: "merged",
    });
    expect(new LedgerStore(db).getIssue(referencedIssue.id)).toMatchObject({
      status: "open",
      resolution: null,
    });
    expect(
      new LedgerStore(db)
        .listEvents({ entity_type: "issue", entity_id: resolvedIssue.id })
        .some((event) => event.event_type === "issue.updated" && event.source === "auth_queue"),
    ).toBe(true);
    expect(
      new LedgerStore(db)
        .listEvents({ entity_type: "auth_request", entity_id: "auth_2" })
        .some((event) => event.event_type === "auth_request.completed"),
    ).toBe(true);
  });
});
