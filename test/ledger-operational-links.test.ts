import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  applyAuthRequestLedgerCompletion,
  linkAuthRequestToLedgerIssue,
  linkSessionToLedgerIssue,
  linkWorkUnitToLedgerIssue,
  recordAuthRequestMergeSucceededFact,
  resolveOperationalIssueRef,
  runOperationalLinkBackfill,
  syncAuthRequestLedgerLinks,
} from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { LEDGER_EVENT_CREATED, ledgerSseTypeForEvent } from "../src/ledger/event-contract.js";
import { SseManager, setSseManager } from "../src/sse.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

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
    ...SYSTEM_ACTOR,
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
  it("records one request-scoped merge success fact without issue links and on retry", () => {
    const project = createProject("unlinked");
    insertAuthRequest({ id: "auth_unlinked", repo: project.checkout.root });
    db.prepare(
      `UPDATE auth_requests
          SET status = 'completed', exit_code = 0, resolved_at = 12345,
              updated_at = 12345, base_branch = 'develop',
              commit_message_digest = ?
        WHERE id = ?`,
    ).run("a".repeat(64), "auth_unlinked");

    const input = {
      auth_request_id: "auth_unlinked",
      repo_ref: project.checkout.root,
    };
    recordAuthRequestMergeSucceededFact(db, input.auth_request_id);
    recordAuthRequestMergeSucceededFact(db, input.auth_request_id);

    expect(db.prepare(
      `SELECT auth_request_id, project_id, base_branch, completed_at, canonical_message
         FROM auth_request_merge_succeeded_facts`,
    ).all()).toEqual([{
      auth_request_id: "auth_unlinked",
      project_id: project.project.id,
      base_branch: "develop",
      completed_at: 12345,
      canonical_message: 1,
    }]);
    expect(new LedgerStore(db).listEvents({
      entity_type: "auth_request",
      entity_id: "auth_unlinked",
    })).toEqual([]);
    db.prepare("DELETE FROM auth_requests WHERE id = ?").run("auth_unlinked");
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM auth_request_merge_succeeded_facts WHERE auth_request_id = ?",
    ).get("auth_unlinked")).toEqual({ count: 1 });
  });

  it("keeps one merge success fact while preserving per-linked-issue completion events", () => {
    const project = createProject("multi-linked");
    const first = createIssue(project.project.id, "first11");
    const second = createIssue(project.project.id, "second2");
    insertAuthRequest({
      id: "auth_multi",
      repo: project.checkout.root,
      issueClosures: ["first11", "second2"],
    });
    db.prepare(
      `UPDATE auth_requests
          SET status = 'completed', exit_code = 0, resolved_at = 23456,
              updated_at = 23456, base_branch = 'main'
        WHERE id = ?`,
    ).run("auth_multi");

    recordAuthRequestMergeSucceededFact(db, "auth_multi");
    applyAuthRequestLedgerCompletion(db, {
      auth_request_id: "auth_multi",
      repo_ref: project.checkout.root,
      issue_closures: ["first11", "second2"],
    });

    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM auth_request_merge_succeeded_facts WHERE auth_request_id = ?",
    ).get("auth_multi")).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM ledger_events
        WHERE entity_type = 'auth_request' AND entity_id = ?
          AND event_type = 'auth_request.completed'`,
    ).get("auth_multi")).toEqual({ count: 2 });
    expect(new LedgerStore(db).getIssue(first.id).status).toBe("closed");
    expect(new LedgerStore(db).getIssue(second.id).status).toBe("closed");
  });

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

  it("resolves an issue in another project from a repo's scope, bare or project-qualified", () => {
    const home = createProject("gamma");
    const other = createProject("delta");
    const issue = createIssue(other.project.id, "cross77");
    const expected = { ok: true, issue_id: issue.id, project_id: other.project.id };

    expect(resolveOperationalIssueRef(db, "cross77", home.checkout.root)).toEqual(expected);
    expect(resolveOperationalIssueRef(db, `${other.project.project_key}/cross77`, home.checkout.root)).toEqual(expected);
    expect(resolveOperationalIssueRef(db, "missing9", home.checkout.root)).toEqual({ ok: false, error: "not_found" });
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
      commitMessage: "Merge work\n\nMandible-Issue: abc1234\n",
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
	  issue_references: ["abc1234"],
	  commit_message: "Merge work\n\nMandible-Issue: abc1234\n",
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

  it("ignores all issue-looking text in auth commit messages", () => {
    const project = createProject("trailers");
    const referenced = createIssue(project.project.id, "abc1234");
    const closed = createIssue(project.project.id, "def5678");
    createIssue(project.project.id, "badcafe", "Legacy generic issue");
    insertAuthRequest({
      id: "auth_trailers",
      repo: project.checkout.root,
      commitMessage: [
        "Merge work",
        "",
        "Mandible-Issue: abc1234",
        "Closes-Mandible-Issue: def5678",
        "Bug: badcafe",
        "Closes: badcafe",
        "Resolves: badcafe",
      ].join("\n"),
    });

    const results = syncAuthRequestLedgerLinks(db, {
      auth_request_id: "auth_trailers",
      repo_ref: project.checkout.root,
      commit_message: [
        "Merge work",
        "",
        "Mandible-Issue: abc1234",
        "Closes-Mandible-Issue: def5678",
        "Bug: badcafe",
        "Closes: badcafe",
        "Resolves: badcafe",
      ].join("\n"),
    });

    expect(results).toEqual([]);
    expect(db.prepare("SELECT * FROM ledger_auth_issue_links WHERE auth_request_id = 'auth_trailers'").all()).toEqual([]);
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
    db.prepare(
      `UPDATE auth_requests
          SET status = 'completed', exit_code = 0, resolved_at = 34567,
              updated_at = 34567, base_branch = 'main'
        WHERE id = ?`,
    ).run("auth_2");
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
      merge_output: 'MANDIBLE_MERGE_RESULT {"merge_sha":"abc123def4567890","declared_issues":["done123"],"auto_close_issues":[]}',
      approval_source: "manual",
      approval_lease_id: "lease_1",
    });

    expect(results).toHaveLength(1);
    expect(new LedgerStore(db).getIssue(resolvedIssue.id)).toMatchObject({
      status: "closed",
      resolution: "delivered",
    });
    expect(new LedgerStore(db).getIssue(referencedIssue.id)).toMatchObject({
      status: "open",
      resolution: null,
    });
    expect(
      new LedgerStore(db)
        .listEvents({ entity_type: "issue", entity_id: resolvedIssue.id })
        .some((event) => (
          event.event_type === "issue.closed" &&
          event.source === "auth_queue" &&
          /^[0-9a-f]{64}$/.test(event.id)
        )),
    ).toBe(true);
    expect(
      new LedgerStore(db)
        .listEvents({ entity_type: "auth_request", entity_id: "auth_2" })
        .some((event) => event.event_type === "auth_request.completed"),
    ).toBe(true);
    expect(
      db.prepare("SELECT commit_sha FROM issue_resolutions WHERE issue_id = ?").get("done123"),
    ).toEqual({ commit_sha: "abc123def4567890" });
    expect(
      db.prepare(
        "SELECT label FROM ledger_labels WHERE issue_id = ? AND label = 'merged' AND deleted_at IS NULL",
      ).get(resolvedIssue.id),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?")
        .get(resolvedIssue.id),
    ).toEqual({ count: 0 });
    const timelineEvents = new LedgerStore(db)
      .listEvents({ entity_type: "issue", entity_id: resolvedIssue.id })
      .filter((event) => event.event_type === "issue.closed");
    const completedEvent = new LedgerStore(db)
      .listEvents({ entity_type: "auth_request", entity_id: "auth_2" })
      .find((event) => event.event_type === "auth_request.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.occurred_at).toBeLessThanOrEqual(timelineEvents[0].occurred_at);
  });

  it("ignores retired automatic-closure metadata", () => {
    const project = createProject("repo");
    const resolvedIssue = createIssue(project.project.id, "done789", "Trailer issue");
    insertAuthRequest({
      id: "auth_3",
      repo: project.checkout.root,
    });

    applyAuthRequestLedgerCompletion(db, {
      auth_request_id: "auth_3",
      repo_ref: project.checkout.root,
      merge_output: 'MANDIBLE_MERGE_RESULT {"merge_sha":"fed456abc1237890","declared_issues":[],"auto_close_issues":["done789"]}',
      approval_source: "manual",
    });

    expect(new LedgerStore(db).getIssue(resolvedIssue.id)).toMatchObject({
      status: "open",
    });
    expect(
      db.prepare(
        "SELECT link_type FROM ledger_auth_issue_links WHERE auth_request_id = ? AND issue_id = ?",
      ).get("auth_3", resolvedIssue.id),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?")
        .get(resolvedIssue.id),
    ).toEqual({ count: 0 });
  });

  it("does not replay an old auth closure after an issue is reopened", async () => {
    const project = createProject("repo");
    const resolvedIssue = createIssue(project.project.id, "oldbug1", "Reopened issue");
    const store = new LedgerStore(db);
    insertAuthRequest({
      id: "auth_replay",
      repo: project.checkout.root,
      issues: ["oldbug1"],
    });

    applyAuthRequestLedgerCompletion(db, {
      auth_request_id: "auth_replay",
      repo_ref: project.checkout.root,
      issues: ["oldbug1"],
      approval_source: "manual",
    });
    const resolvedAt = Date.now();
    db.prepare(
      "UPDATE auth_requests SET status = 'completed', resolved_at = ?, updated_at = ?, exit_code = 0 WHERE id = ?",
    ).run(resolvedAt, resolvedAt, "auth_replay");

    await new Promise((resolve) => setTimeout(resolve, 2));
    store.setIssueStatus(
      resolvedIssue.id,
      "open",
      null,
      { actor_type: "mandible_user", ...SYSTEM_ACTOR },
      "mandible",
    );
    const reopenedAt = store
      .listEvents({ entity_type: "issue", entity_id: resolvedIssue.id })
      .find((event) => event.event_type === "issue.reopened")?.occurred_at;

    expect(reopenedAt).toBeGreaterThan(resolvedAt);

    applyAuthRequestLedgerCompletion(db, {
      auth_request_id: "auth_replay",
      repo_ref: project.checkout.root,
      issues: ["oldbug1"],
      approval_source: "manual",
    });

    expect(store.getIssue(resolvedIssue.id)).toMatchObject({
      status: "open",
      resolution: null,
    });
    const closeEvents = store
      .listEvents({ entity_type: "issue", entity_id: resolvedIssue.id })
      .filter((event) => event.event_type === "issue.closed");
    expect(closeEvents).toHaveLength(1);
  });
});

// A committed ledger mutation must also survive the daemon's real SSE validator.
it("publishes a committed work-unit link through the actual SseManager", () => {
  const project = createProject("sse-link-project");
  const issue = createIssue(project.project.id, "sse-link-issue");
  insertWorkUnit("sse-linked-work", issue.id, project.project.id);
  const manager = new SseManager();
  const published = vi.spyOn(manager, "broadcast"); // Call through to validation.
  setSseManager(manager);
  try {
    expect(linkWorkUnitToLedgerIssue(db, {
      work_unit_id: "sse-linked-work", issue_ref: issue.id, repo_ref: project.project.id,
    })).toMatchObject({ ok: true, issue_id: issue.id });
    expect(db.prepare("SELECT ledger_issue_id FROM work_units WHERE id = ?").get("sse-linked-work"))
      .toEqual({ ledger_issue_id: issue.id });
    const events = new LedgerStore(db).listEvents({ entity_type: "work_unit", entity_id: "sse-linked-work" });
    expect(events).toHaveLength(1);
    expect(published.mock.calls.map(([event]) => event.type)).toEqual([
      ledgerSseTypeForEvent("work_unit.issue_linked"), LEDGER_EVENT_CREATED,
    ]);
    expect(published.mock.calls[1][0].data).toMatchObject({ id: events[0].id, entity_id: "sse-linked-work" });
    expect(() => manager.broadcast({ type: "ledger:unregistered", data: {} } as never))
      .toThrow("Invalid domain event envelope");
  } finally { published.mockRestore(); manager.closeAll(); setSseManager(null); }
});
