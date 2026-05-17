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

type Method = "GET" | "POST" | "PUT";

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
      id: "abc123",
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
    ).run("sess-1", "abc123", repoInfo.id, 1);
    updateLedgerIssueMigrationConfig(db, { read_mode: "ledger" });

    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const list = await server.invoke("GET", "/api/issues");
    expect(list.statusCode).toBe(200);
    expect(list.body).toMatchObject([{ repo_id: repoInfo.id, issues: [{ id: "abc123" }] }]);

    const detail = await server.invoke("GET", "/api/issues/:repoId/:issueId", {
      params: { repoId: "mandible", issueId: issue.id.slice(0, 10) },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toMatchObject({ id: "abc123", title: "Route issue", description: "Route body" });

    const context = await server.invoke("GET", "/api/issues/:repoId/:issueId/context", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
    });
    expect(context.statusCode).toBe(200);
    expect(context.body).toMatchObject({
      issue: { id: "abc123", title: "Route issue" },
      sessions: [{ session_id: "sess-1" }],
    });

    const sessions = await server.invoke("GET", "/api/issues/:repoId/:issueId/sessions", {
      params: { repoId: repoInfo.id, issueId: "abc123" },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.body).toMatchObject([{ session_id: "sess-1", issue_id: "abc123" }]);
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
});
