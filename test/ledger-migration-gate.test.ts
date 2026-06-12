import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import {
  findLedgerIssueAcrossRepos,
  getLedgerIssueDetailForRoute,
  getLedgerIssueMigrationConfig,
  getReconciliationReport,
  listLedgerIssueSummaries,
  parseMigrationConfigPatch,
  reconcileIssueSummaries,
  runIssueReconciliation,
  updateLedgerIssueMigrationConfig,
} from "../src/ledger/issue-migration.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import {
  runGitBugSyncForRepos,
} from "../src/ledger/sync-runner.js";
import type {
  GitBugClient,
  GitBugCreateIssueInput,
  GitBugIssueDetail,
  GitBugIssueSummary,
  GitBugResult,
} from "../src/ledger/git-bug-client.js";
import { registerIssueRoutes, type IssueServer, type RouteHandler } from "../src/routes/issues.js";
import type { IssueRepoSummary } from "../src/types.js";
import type { RepoInfo } from "../src/work-scanner.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-migration-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function repo(id: string, name = id): RepoInfo {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  return {
    id,
    name,
    root,
    exists: true,
    default_branch: "main",
    excluded: false,
    user_modified: false,
    last_scanned_at: null,
  };
}

function fakeWorkScanner(repos: RepoInfo[]) {
  return {
    getRepos: () => repos,
    getRepoById: (idOrPath: string) => repos.find((item) =>
      item.id === idOrPath || item.name === idOrPath || item.root === idOrPath
    ),
    getBranches: () => [],
  };
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

interface TestResponse {
  statusCode: number;
  body: unknown;
  status(code: number): TestResponse;
  code(code: number): TestResponse;
  json(payload: unknown): void;
  send(payload: unknown): void;
  end(payload: string): void;
}

class TestIssueServer implements IssueServer {
  readonly handlers: Record<Method, Map<string, RouteHandler>> = {
    GET: new Map(),
    POST: new Map(),
    PUT: new Map(),
    PATCH: new Map(),
  };

  get(path: string, handler: RouteHandler): void {
    this.handlers.GET.set(path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.handlers.POST.set(path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.handlers.PUT.set(path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.handlers.PATCH.set(path, handler);
  }

  async invoke(
    method: Method,
    path: string,
    request: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<TestResponse> {
    const handler = this.handlers[method].get(path);
    if (!handler) throw new Error(`missing handler for ${method} ${path}`);
    const response = makeResponse();
    await handler({
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    }, response);
    return response;
  }
}

function makeResponse(): TestResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    code(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
    },
    send(payload: unknown) {
      this.body = payload;
    },
    end(payload: string) {
      this.body = JSON.parse(payload);
    },
  };
}

function createLedgerIssue(input: {
  repo: RepoInfo;
  alias: string;
  title?: string;
  body?: string;
  labels?: string[];
}) {
  const { project } = resolveProjectForCheckout(db, {
    root: input.repo.root,
    name: input.repo.name,
    workRepoId: input.repo.id,
    defaultBranch: input.repo.default_branch,
    remoteUrl: `git@github.com:mll/${input.repo.name}.git`,
  });
  const store = new LedgerStore(db);
  const issue = store.createIssue({
    project_id: project.id,
    title: input.title ?? "Ledger issue",
    body: input.body ?? "Body",
    status: "open",
    kind: "feature",
    priority: "normal",
    labels: input.labels ?? ["feature"],
    aliases: [{ alias_kind: "git_bug_human", alias: input.alias, external_id: input.alias, is_primary: true }],
  });
  return { project, issue, store };
}

function setMarkdownBodyEscapePolicy(value: "allow" | "warn" | "reject"): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('ledger.markdown_body_escape_policy', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(value, Date.now());
}

function summary(repoInfo: RepoInfo, issues: IssueRepoSummary["issues"]): IssueRepoSummary {
  return {
    repo_id: repoInfo.id,
    repo_name: repoInfo.name,
    repo_root: repoInfo.root,
    open_count: issues.filter((issue) => issue.status === "open").length,
    merged_count: 0,
    closed_count: issues.filter((issue) => issue.status === "closed").length,
    issues,
  };
}

describe("ledger issue migration config", () => {
  it("defaults to scanner reads, git-bug writes, shadow reports, and fallback", () => {
    expect(getLedgerIssueMigrationConfig(db)).toEqual({
      read_mode: "scanner",
      write_mode: "git_bug",
      shadow_report_enabled: true,
      fallback_on_ledger_error: true,
    });

    expect(updateLedgerIssueMigrationConfig(db, {
      read_mode: "shadow",
      write_mode: "ledger",
      fallback_on_ledger_error: false,
    })).toMatchObject({
      read_mode: "shadow",
      write_mode: "ledger",
      fallback_on_ledger_error: false,
    });
  });

  it("ignores invalid config mode strings instead of silently rolling back", () => {
    const patch = parseMigrationConfigPatch({
      read_mode: "scaner",
      write_mode: "ledger",
      shadow_report_enabled: false,
    });

    expect(patch).toEqual({
      write_mode: "ledger",
      shadow_report_enabled: false,
    });
  });
});

describe("ledger legacy issue projection", () => {
  it("maps ledger issues to existing issue API shapes", () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "abc123",
      title: "Projected issue",
      body: "Projected body",
      labels: ["feature", "parent:par123"],
    });
    store.addComment(issue.id, { body: "Comment", author_display: "Codex", actor_type: "agent" });
    const workScanner = fakeWorkScanner([repoInfo]);

    const summaries = listLedgerIssueSummaries(db, workScanner);
    const detail = getLedgerIssueDetailForRoute(db, workScanner, "mandible", "abc123");

    expect(summaries).toHaveLength(1);
    expect(summaries[0].issues[0]).toMatchObject({
      id: issue.short_id,
      repo_id: "repo-1",
      repo_name: "mandible",
      title: "Projected issue",
      description: "Projected body",
      parent_id: "par123",
    });
    expect(detail.ok && detail.detail.comments).toHaveLength(1);
  });

  it("reports global alias ambiguity instead of choosing the first match", () => {
    const first = repo("repo-1", "one");
    const second = repo("repo-2", "two");
    createLedgerIssue({ repo: first, alias: "dupe", title: "First" });
    createLedgerIssue({ repo: second, alias: "dupe", title: "Second" });

    expect(findLedgerIssueAcrossRepos(db, fakeWorkScanner([first, second]), "dupe")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("ledger reconciliation reports", () => {
  it("detects clean and mismatched issue projections", () => {
    const repoInfo = repo("repo-1", "mandible");
    const clean = summary(repoInfo, [{
      id: "abc123",
      repo_id: repoInfo.id,
      repo_name: repoInfo.name,
      title: "Same",
      status: "open",
      labels: ["feature"],
      author: "Codex",
      created_at: "2026-05-16T12:00:00.000Z",
      description: "Body",
    }]);
    const matching = summary(repoInfo, [{ ...clean.issues[0] }]);
    const mismatched = summary(repoInfo, [{ ...clean.issues[0], title: "Different", labels: ["bug"] }]);

    expect(reconcileIssueSummaries([clean], [matching]).status).toBe("clean");
    const report = reconcileIssueSummaries([clean], [mismatched]);
    expect(report.status).toBe("mismatch");
    expect(report.mismatches.map((mismatch) => mismatch.mismatch_type)).toEqual([
      "title_mismatch",
      "label_set_mismatch",
    ]);
  });

  it("does not report body or comment mismatches for list-only scanner summaries", () => {
    const repoInfo = repo("repo-1", "mandible");
    const scanner = summary(repoInfo, [{
      id: "abc123",
      repo_id: repoInfo.id,
      repo_name: repoInfo.name,
      title: "Same",
      status: "open",
      labels: ["feature"],
      author: "Codex",
      created_at: "2026-05-16T12:00:00.000Z",
      description: "",
    }]);
    const ledger = summary(repoInfo, [{
      ...scanner.issues[0],
      description: "Ledger body from imported first git-bug comment",
    }]);

    expect(reconcileIssueSummaries([scanner], [ledger]).mismatches).toEqual([]);
  });

  it("reports comment mismatches when detailed issue shapes are compared", () => {
    const repoInfo = repo("repo-1", "mandible");
    const scanner = summary(repoInfo, [{
      id: "abc123",
      repo_id: repoInfo.id,
      repo_name: repoInfo.name,
      title: "Same",
      status: "open",
      labels: ["feature"],
      author: "Codex",
      created_at: "2026-05-16T12:00:00.000Z",
      description: "Body",
      comments: [],
    }]);
    const ledger = summary(repoInfo, [{
      ...scanner.issues[0],
      comments: [{ id: "c1", author: "Codex", date: "2026-05-16T12:00:00.000Z", body: "Note" }],
    }]);

    expect(reconcileIssueSummaries([scanner], [ledger]).mismatches).toMatchObject([
      { mismatch_type: "comment_count_mismatch" },
    ]);
  });

  it("persists reconciliation reports and mismatch entries", () => {
    const repoInfo = repo("repo-1", "mandible");
    createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Ledger only" });
    const scannerSummary = summary(repoInfo, []);
    const fakeScanner = { getRepoSummaries: () => [scannerSummary] };

    const report = runIssueReconciliation(db, fakeScanner, fakeWorkScanner([repoInfo]), "shadow");
    const persisted = getReconciliationReport(db, report.id);

    expect(report.status).toBe("mismatch");
    expect(persisted?.mismatches).toHaveLength(1);
    expect(persisted?.mismatches[0].mismatch_type).toBe("extra_in_ledger");
  });
});

describe("ledger migration sync", () => {
  it("seeds projects/checkouts and imports registered repo issues", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const client = new FakeGitBugClient([
      makeDetail({
        id: "git-1",
        human_id: "abc123",
        title: "Imported issue",
        body: "Imported body",
        labels: ["feature"],
      }),
    ]);

    const sync = await runGitBugSyncForRepos({
      db,
      client,
      repos: [repoInfo],
      direction: "import",
    });
    const workScanner = fakeWorkScanner([repoInfo]);
    const summaries = listLedgerIssueSummaries(db, workScanner);
    const report = runIssueReconciliation(
      db,
      { getRepoSummaries: () => summaries },
      workScanner,
      "shadow",
    );

    expect(sync).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_projects").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_project_checkouts").get()).toMatchObject({ count: 1 });
    expect(summaries).toMatchObject([{
      repo_id: "repo-1",
      issues: [{ id: expect.stringMatching(/^[0-9a-f]{7,64}$/), title: "Imported issue" }],
    }]);
    expect(report.status).toBe("clean");
  });

  it("skips missing or excluded repos without blocking other imports", async () => {
    const active = repo("repo-1", "active");
    const missing = { ...repo("repo-2", "missing"), exists: false };
    const excluded = { ...repo("repo-3", "excluded"), excluded: true };
    const client = new FakeGitBugClient([
      makeDetail({ id: "git-1", human_id: "abc123", title: "Active issue" }),
    ]);

    const sync = await runGitBugSyncForRepos({
      db,
      client,
      repos: [active, missing, excluded],
      direction: "import",
    });

    expect(sync).toMatchObject({ total: 3, completed: 1, skipped: 2, failed: 0 });
    expect(sync.results.map((result) => result.status)).toEqual(["completed", "skipped", "skipped"]);
  });
});

describe("ledger issue route gate", () => {
  it("serves list, detail, context, and session routes from ledger read mode", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue } = createLedgerIssue({
      repo: repoInfo,
      alias: "abc123",
      title: "Route issue",
      body: "Route body",
      labels: ["feature"],
    });
    db.prepare(
      "INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("sess-1", "codex", "idle", "2026-05-16T12:00:00.000Z", "2026-05-16T12:00:00.000Z");
    db.prepare(
      "INSERT INTO session_issues (session_id, issue_id, repo_id, created_at) VALUES (?, ?, ?, ?)",
    ).run("sess-1", issue.short_id, repoInfo.id, 1);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger" });

    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const list = await server.invoke("GET", "/api/issues");
    expect(list.statusCode).toBe(200);
    expect(list.body).toMatchObject([{ repo_id: repoInfo.id, issues: [{ id: issue.short_id }] }]);

    const detail = await server.invoke("GET", "/api/issues/:repoId/:issueId", {
      params: { repoId: "mandible", issueId: issue.id.slice(0, 10) },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toMatchObject({ id: issue.short_id, title: "Route issue", description: "Route body" });

    const context = await server.invoke("GET", "/api/issues/:repoId/:issueId/context", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
    });
    expect(context.statusCode).toBe(200);
    expect(context.body).toMatchObject({
      issue: { id: issue.short_id, title: "Route issue" },
      sessions: [{ session_id: "sess-1" }],
    });

    const sessions = await server.invoke("GET", "/api/issues/:repoId/:issueId/sessions", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.body).toMatchObject([{ session_id: "sess-1", issue_id: issue.short_id }]);
  });

  it("guards dual writes and applies ledger writes only when explicitly configured", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Writable" });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    updateLedgerIssueMigrationConfig(db, { write_mode: "dual" });
    const guarded = await server.invoke("POST", "/api/issues/:repoId/:issueId/status", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
      body: { status: "closed" },
    });
    expect(guarded.statusCode).toBe(409);

    updateLedgerIssueMigrationConfig(db, { write_mode: "ledger" });
    const closed = await server.invoke("POST", "/api/issues/:repoId/:issueId/status", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
      body: { status: "closed" },
    });
    const comment = await server.invoke("POST", "/api/issues/:repoId/:issueId/comment", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
      body: { message: "Mandible note" },
    });
    const label = await server.invoke("POST", "/api/issues/:repoId/:issueId/label", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
      body: { action: "add", label: "reviewed" },
    });

    expect(closed.body).toMatchObject({ ok: true, source: "ledger" });
    expect(comment.body).toMatchObject({ ok: true, source: "ledger" });
    expect(label.body).toMatchObject({ ok: true, source: "ledger" });
    const detail = new LedgerStore(db).getIssueDetail(issue.id);
    expect(detail.status).toBe("closed");
    expect(detail.comments.map((row) => row.body)).toContain("Mandible note");
    expect(detail.labels.map((row) => row.label)).toContain("reviewed");
  });

  it("atomically reopens and comments through the ledger comment route", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue, store } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Closed writable" });
    store.setIssueStatus(issue.id, "closed", "fixed");
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("POST", "/api/ledger/issues/:issueId/comments", {
      params: { issueId: "abc123" },
      body: { message: "Scope extension", reopen: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "open",
      resolution: null,
      comments: [{ body: "Scope extension" }],
    });
    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id }).map((event) => event.event_type);
    expect(events).toContain("issue.reopened");
  });

  it("records advisory parent-role holders and requires override for live holders", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue, store } = createLedgerIssue({ repo: repoInfo, alias: "umb123", title: "Umbrella" });
    db.prepare(
      "INSERT INTO sessions (id, app, status, created_at, updated_at, last_active) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "sess-live",
      "codex",
      "active",
      "2026-06-12T12:00:00.000Z",
      "2026-06-12T12:05:00.000Z",
      "2026-06-12T12:05:00.000Z",
    );
    store.addIssueCheckpoint(issue.id, {
      kind: "parent-role",
      payload: { session_id: "sess-live", mechanism: "codex", assumed_at: 1 },
      actor_type: "agent",
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const status = await server.invoke("GET", "/api/ledger/issues/:issueId/parent-role", {
      params: { issueId: "umb123" },
    });
    const blocked = await server.invoke("POST", "/api/ledger/issues/:issueId/parent-role", {
      params: { issueId: "umb123" },
      body: { session_id: "sess-new", mechanism: "codex" },
    });
    const retaken = await server.invoke("POST", "/api/ledger/issues/:issueId/parent-role", {
      params: { issueId: "umb123" },
      body: { session_id: "sess-new", mechanism: "codex", override: true },
    });

    expect(status.body).toMatchObject({
      live_holder: { session_id: "sess-live", liveness: { has_live_agent: true } },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toMatchObject({ live_holder: { session_id: "sess-live" } });
    expect(retaken.statusCode).toBe(200);
    expect(retaken.body).toMatchObject({
      ok: true,
      parent_role: { holder: { session_id: "sess-new" } },
    });
  });

  it("builds a deterministic umbrella status fact packet", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umb123",
      title: "Umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      project_id: umbrella.project_id,
      title: "Child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi123", external_id: "chi123", is_primary: true }],
    });
    store.upsertIssueRelationship({
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });
    store.addIssueCheckpoint(umbrella.id, {
      kind: "delegation-manifest",
      payload: [{ issue: child.short_id, digest: "before", branch: "feature/child" }],
      actor_type: "agent",
    });
    store.addIssueCheckpoint(child.id, {
      kind: "closeout",
      payload: { worker_status: "done", branch: "feature/child", auth_request: null },
      actor_type: "agent",
    });
    store.addComment(child.id, { body: "Finished child", actor_type: "agent" });
    store.setWorkerStatus(child.id, "done");
    store.addIssueBranch(child.id, "feature/child");
    const now = Date.now();
    db.prepare(
      `INSERT INTO auth_requests (
        id, type, command, title, repo, base_branch, head_branch,
        execution_mode, status, created_at, updated_at, expires_at, output, approval_source
      ) VALUES (
        'auth_pending', 'merge', 'git merge feature/child', 'Merge child',
        ?, 'main', 'feature/child', 'daemon', 'pending', ?, ?, ?, '', 'manual'
      )`,
    ).run(repoInfo.id, now, now, now + 60_000);
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("GET", "/api/ledger/issues/:issueId/umbrella-status", {
      params: { issueId: "umb123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      umbrella: {
        short_id: umbrella.short_id,
        title: "Umbrella",
        current_revision_id: expect.any(String),
      },
      delegation_manifest: { kind: "delegation-manifest" },
      children: [
        {
          short_id: child.short_id,
          title: "Child",
          worker_status: "done",
          issue_branches: [{ branch: "feature/child" }],
          latest_comment: { body: "Finished child" },
          latest_closeout: { kind: "closeout" },
        },
      ],
      auth_queue: {
        pending_requests: [{ id: "auth_pending", head_branch: "feature/child" }],
      },
    });
    expect((response.body as { children: Array<{ body?: string }> }).children[0]).not.toHaveProperty("body");
  });

  it("inlines child issue details for deep umbrella status", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbdeep",
      title: "Deep umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      project_id: umbrella.project_id,
      title: "Deep child",
      body: "Deep child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "deepch", external_id: "deepch", is_primary: true }],
    });
    store.upsertIssueRelationship({
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });
    store.addIssueCheckpoint(child.id, {
      kind: "closeout",
      payload: { worker_status: "done", branch: "feature/deep", auth_request: null },
      actor_type: "agent",
    });
    store.addComment(child.id, { body: "Deep child latest comment", actor_type: "agent" });
    store.addIssueBranch(child.id, "feature/deep");

    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("GET", "/api/ledger/issues/:issueId/umbrella-status", {
      params: { issueId: "umbdeep" },
      query: { deep: "true" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      children: [
        {
          short_id: child.short_id,
          title: "Deep child",
          body: "Deep child body",
          current_revision_id: expect.any(String),
          kind: "feature",
          latest_comment: { body: "Deep child latest comment" },
          latest_closeout: { kind: "closeout" },
          issue_branches: [{ branch: "feature/deep" }],
          auth_requests: [],
          relationships: expect.any(Array),
          sessions: expect.any(Array),
          work_units: expect.any(Array),
        },
      ],
    });
  });

  it("reports umbrella children from structured relationship edges", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbedge",
      title: "Edge umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      project_id: umbrella.project_id,
      title: "Edge child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "edgchi", external_id: "edgchi", is_primary: true }],
    });
    store.linkRelationshipEdges({
      source_entity: { entity_type: "issue", entity_id: umbrella.id },
      target_entities: [{ entity_type: "issue", entity_id: child.id }],
      link_type: "parent_child",
      provenance: "manual",
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("GET", "/api/ledger/issues/:issueId/umbrella-status", {
      params: { issueId: "umbedge" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      children: [{ short_id: child.short_id, title: "Edge child" }],
      child_drift: { linked_child_refs: [child.short_id] },
    });
  });

  it("adopts umbrella children idempotently and refreshes the delegation manifest", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbadopt",
      title: "Adopt umbrella",
      labels: ["umbrella"],
    });
    const first = store.createIssue({
      project_id: umbrella.project_id,
      title: "First child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "adopta", external_id: "adopta", is_primary: true }],
    });
    const second = store.createIssue({
      project_id: umbrella.project_id,
      title: "Second child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "adoptb", external_id: "adoptb", is_primary: true }],
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const adopted = await server.invoke("POST", "/api/ledger/issues/:issueId/umbrella-adopt", {
      params: { issueId: "umbadopt" },
      body: { child_refs: ["adopta", "adoptb"] },
    });
    const adoptedAgain = await server.invoke("POST", "/api/ledger/issues/:issueId/umbrella-adopt", {
      params: { issueId: "umbadopt" },
      body: { child_refs: ["adopta", "adoptb"] },
    });

    expect(adopted.statusCode).toBe(200);
    expect(adopted.body).toMatchObject({
      operation: {
        kind: "adopt",
        requested_child_refs: ["adopta", "adoptb"],
        created_child_refs: [first.short_id, second.short_id],
      },
    });
    expect((adopted.body as { children: Array<{ short_id: string }> }).children)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ short_id: first.short_id }),
        expect.objectContaining({ short_id: second.short_id }),
      ]));
    expect(adoptedAgain.body).toMatchObject({
      operation: {
        kind: "adopt",
        created_child_refs: [],
        existing_child_refs: [first.short_id, second.short_id],
      },
    });
    expect(store.listRelationshipEdges({ source_issue_id: umbrella.id })).toHaveLength(2);
    const manifest = store.getLatestIssueCheckpoint(umbrella.id, "delegation-manifest");
    expect(manifest).not.toBeNull();
    expect(JSON.parse(manifest!.payload_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ short_id: first.short_id }),
      expect.objectContaining({ short_id: second.short_id }),
    ]));
  });

  it("reconciles only canonical Children table rows into edges and a manifest", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbrecon",
      title: "Reconcile umbrella",
      labels: ["umbrella"],
      body: [
        "Body reference that is not a child: [issue:notkid].",
        "",
        "## Children",
        "",
        "| issue | repo | scope | branch | state |",
        "| --- | --- | --- | --- | --- |",
        "| [issue:kid123] | mandible | child work | feature/kid | pending |",
      ].join("\n"),
    });
    const child = store.createIssue({
      project_id: umbrella.project_id,
      title: "Table child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "kid123", external_id: "kid123", is_primary: true }],
    });
    const nonChild = store.createIssue({
      project_id: umbrella.project_id,
      title: "Referenced only",
      body: "Referenced body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "notkid", external_id: "notkid", is_primary: true }],
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("POST", "/api/ledger/issues/:issueId/umbrella-reconcile", {
      params: { issueId: "umbrecon" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      children: [{ short_id: child.short_id, title: "Table child" }],
      operation: {
        kind: "reconcile",
        requested_child_refs: ["kid123"],
        created_child_refs: [child.short_id],
      },
    });
    const targets = store.listRelationshipEdges({ source_issue_id: umbrella.id })
      .map((edge) => edge.target_issue_id);
    expect(targets).toEqual([child.id]);
    expect(targets).not.toContain(nonChild.id);
    const manifest = store.getLatestIssueCheckpoint(umbrella.id, "delegation-manifest");
    expect(JSON.parse(manifest!.payload_json)).toMatchObject([{ short_id: child.short_id }]);
  });

  it("refreshes an umbrella manifest without changing child edges", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbmani",
      title: "Manifest umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      project_id: umbrella.project_id,
      title: "Manifest child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "manich", external_id: "manich", is_primary: true }],
    });
    store.linkRelationshipEdges({
      source_entity: { entity_type: "issue", entity_id: umbrella.id },
      target_entities: [{ entity_type: "issue", entity_id: child.id }],
      link_type: "parent_child",
      provenance: "manual",
    });
    const beforeEdges = store.listRelationshipEdges({ source_issue_id: umbrella.id }).map((edge) => edge.id);

    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("POST", "/api/ledger/issues/:issueId/umbrella-manifest-refresh", {
      params: { issueId: "umbmani" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      operation: {
        kind: "manifest-refresh",
        refreshed_child_refs: [child.short_id],
        delegation_manifest: { kind: "delegation-manifest" },
      },
      children: [{ short_id: child.short_id }],
    });
    expect(store.listRelationshipEdges({ source_issue_id: umbrella.id }).map((edge) => edge.id))
      .toEqual(beforeEdges);
    const manifest = store.getLatestIssueCheckpoint(umbrella.id, "delegation-manifest");
    expect(JSON.parse(manifest!.payload_json)).toMatchObject([{ short_id: child.short_id }]);
  });

  it("refuses parent-role assumption when the child table needs explicit reconcile", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbrole",
      title: "Role umbrella",
      labels: ["umbrella"],
      body: [
        "## Children",
        "",
        "| issue | scope | branch | state |",
        "| --- | --- | --- | --- |",
        "| [issue:rolekid] | child work | feature/role | pending |",
      ].join("\n"),
    });
    store.createIssue({
      project_id: umbrella.project_id,
      title: "Role child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "rolekid", external_id: "rolekid", is_primary: true }],
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("POST", "/api/ledger/issues/:issueId/parent-role", {
      params: { issueId: "umbrole" },
      body: { session_id: "sess-new", mechanism: "codex-thread" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      reconcile_command: `mandible umbrella reconcile ${umbrella.short_id}`,
      child_drift: { missing_edge_refs: [expect.any(String)] },
    });
  });

  it("creates ledger-native issues through the repo route", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger", write_mode: "ledger" });

    const created = await server.invoke("POST", "/api/issues/:repoId", {
      params: { repoId: repoInfo.name },
      body: {
        title: "Ledger-native issue",
        body: "Created through API",
        root: repoInfo.root,
        labels: ["feature"],
      },
    });
    const list = await server.invoke("GET", "/api/issues", {
      query: { repo: repoInfo.root, status: "open" },
    });

    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({
      title: "Ledger-native issue",
      source: "mandible",
      labels: ["feature"],
    });
    expect(list.body).toMatchObject([{ repo_root: repoInfo.root, issues: [{ title: "Ledger-native issue" }] }]);
    expect(db.prepare("SELECT source FROM ledger_issues").get()).toMatchObject({ source: "mandible" });
  });

  it("warns by default on likely escaped Markdown and preserves the body exactly", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger", write_mode: "ledger" });

    const escapedBody = "Created through API.\\n\\nDetails:\\n- item";
    const created = await server.invoke("POST", "/api/issues/:repoId", {
      params: { repoId: repoInfo.name },
      body: {
        title: "Escaped Markdown issue",
        body: escapedBody,
        root: repoInfo.root,
        labels: ["feature"],
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({
      title: "Escaped Markdown issue",
      body: escapedBody,
      markdown_body_warnings: [{ code: "literal_escaped_newlines" }],
    });
    expect(db.prepare("SELECT body FROM ledger_issues").get()).toMatchObject({ body: escapedBody });

    const issueId = (created.body as { id: string }).id;
    const escapedComment = "Escaped comment.\\n\\nDetails:\\n- item";
    const comment = await server.invoke("POST", "/api/ledger/issues/:issueId/comments", {
      params: { issueId },
      body: { body: escapedComment },
    });
    expect(comment.statusCode).toBe(200);
    expect(comment.body).toMatchObject({
      markdown_body_warnings: [{ code: "literal_escaped_newlines" }],
      comments: [{ body: escapedComment }],
    });
  });

  it("accepts real Markdown with newlines even when the policy rejects escaped bodies", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger", write_mode: "ledger" });
    setMarkdownBodyEscapePolicy("reject");

    const realMarkdown = "Created through API.\n\nDetails:\n- item";
    const created = await server.invoke("POST", "/api/issues/:repoId", {
      params: { repoId: repoInfo.name },
      body: {
        title: "Real Markdown issue",
        body: realMarkdown,
        root: repoInfo.root,
        labels: ["feature"],
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({ title: "Real Markdown issue", body: realMarkdown });
    expect((created.body as Record<string, unknown>).markdown_body_warnings).toBeUndefined();
  });

  it("rejects likely escaped Markdown issue and comment writes when configured", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Writable" });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger", write_mode: "ledger" });
    setMarkdownBodyEscapePolicy("reject");

    const rejectedIssue = await server.invoke("POST", "/api/issues/:repoId", {
      params: { repoId: repoInfo.name },
      body: {
        title: "Rejected issue",
        body: "Bad escaped body.\\n\\nDetails:\\n- item",
        root: repoInfo.root,
        labels: ["feature"],
      },
    });
    const rejectedComment = await server.invoke("POST", "/api/ledger/issues/:issueId/comments", {
      params: { issueId: issue.short_id },
      body: { body: "Bad escaped comment.\\n\\nDetails:\\n- item" },
    });

    expect(rejectedIssue.statusCode).toBe(422);
    expect(rejectedIssue.body).toMatchObject({
      error: "markdown body contains likely accidental escaped newlines",
      markdown_body_warnings: [{ code: "literal_escaped_newlines" }],
    });
    expect(rejectedComment.statusCode).toBe(422);
    expect(new LedgerStore(db).getIssueDetail(issue.id).comments).toHaveLength(0);
  });

  it("allows likely escaped Markdown comment writes when configured", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Writable" });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger", write_mode: "ledger" });
    setMarkdownBodyEscapePolicy("allow");

    const escapedBody = "Allowed escaped comment.\\n\\nDetails:\\n- item";
    const comment = await server.invoke("POST", "/api/ledger/issues/:issueId/comments", {
      params: { issueId: issue.short_id },
      body: { body: escapedBody },
    });

    expect(comment.statusCode).toBe(200);
    expect((comment.body as Record<string, unknown>).markdown_body_warnings).toBeUndefined();
    expect(new LedgerStore(db).getIssueDetail(issue.id).comments.map((row) => row.body)).toEqual([escapedBody]);
  });
});

class FakeGitBugClient implements GitBugClient {
  private details = new Map<string, GitBugIssueDetail>();

  constructor(details: GitBugIssueDetail[]) {
    for (const detail of details) {
      this.details.set(detail.id, detail);
      this.details.set(detail.human_id, detail);
    }
  }

  async hasGitBugRefs(): Promise<GitBugResult<boolean>> {
    return ok(this.details.size > 0);
  }

  async listIssues(): Promise<GitBugResult<GitBugIssueSummary[]>> {
    const unique = Array.from(new Set(this.details.values()));
    return ok(unique.map(({ description: _description, comments: _comments, raw: _raw, ...summary }) => summary));
  }

  async getIssue(_repoRoot: string, ref: string): Promise<GitBugResult<GitBugIssueDetail>> {
    const detail = this.details.get(ref);
    return detail ? ok(detail) : fail("not found");
  }

  async createIssue(_repoRoot: string, _input: GitBugCreateIssueInput): Promise<GitBugResult<{ id: string }>> {
    return fail("not implemented");
  }

  async editTitle(): Promise<GitBugResult<void>> {
    return fail("not implemented");
  }

  async editComment(): Promise<GitBugResult<void>> {
    return fail("not implemented");
  }

  async setStatus(): Promise<GitBugResult<void>> {
    return fail("not implemented");
  }

  async addComment(): Promise<GitBugResult<{ id?: string }>> {
    return fail("not implemented");
  }

  async addLabel(): Promise<GitBugResult<void>> {
    return fail("not implemented");
  }

  async removeLabel(): Promise<GitBugResult<void>> {
    return fail("not implemented");
  }
}

function makeDetail(input: {
  id: string;
  human_id: string;
  title: string;
  body?: string;
  status?: "open" | "closed";
  labels?: string[];
  comments?: Array<{ id: string; body: string }>;
}): GitBugIssueDetail {
  return {
    id: input.id,
    human_id: input.human_id,
    title: input.title,
    status: input.status ?? "open",
    labels: input.labels ?? [],
    author_name: "Codex",
    created_at: "2026-05-16T12:00:00.000Z",
    description: input.body ?? "",
    description_comment_id: `${input.human_id}-desc`,
    comments: (input.comments ?? []).map((comment) => ({
      id: comment.id,
      human_id: comment.id,
      author_name: "Codex",
      body: comment.body,
      created_at: "2026-05-16T12:00:00.000Z",
    })),
    raw: input,
  };
}

function ok<T>(value: T): GitBugResult<T> {
  return { ok: true, value, stdout: "", stderr: "", exit_code: 0 };
}

function fail<T>(error: string): GitBugResult<T> {
  return { ok: false, error, retry: "fatal", stdout: "", stderr: error, exit_code: 1 };
}
