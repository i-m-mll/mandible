import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import type {
  GitBugClient,
  GitBugCreateIssueInput,
  GitBugIssueDetail,
  GitBugIssueSummary,
  GitBugResult,
} from "../src/ledger/git-bug-client.js";
import { exportGitBugOutbox } from "../src/ledger/git-bug-exporter.js";
import { importGitBugCheckout } from "../src/ledger/git-bug-importer.js";
import { formatKindLabel, formatPriorityLabel, parseGitBugLabel } from "../src/ledger/git-bug-labels.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { listLedgerSyncJobs, runGitBugSync } from "../src/ledger/sync-runner.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-gitbug-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createCheckout() {
  fs.mkdirSync(path.join(tempDir, "repo"), { recursive: true });
  return resolveProjectForCheckout(db, {
    root: path.join(tempDir, "repo"),
    remoteUrl: "git@github.com:mll/mandible.git",
    defaultBranch: "main",
  }).checkout;
}

describe("git-bug label mapping", () => {
  it("parses and formats namespaced labels and legacy parent labels", () => {
    expect(formatKindLabel("umbrella")).toBe("mandible:kind:umbrella");
    expect(formatPriorityLabel("high")).toBe("mandible:priority:high");
    expect(parseGitBugLabel("mandible:kind:not-a-kind")).toBeNull();
    expect(parseGitBugLabel("mandible:priority:not-a-priority")).toBeNull();
    expect(parseGitBugLabel("parent:abc123")).toEqual({
      kind: "legacy_parent",
      target_ref: "abc123",
      raw: "parent:abc123",
    });
    expect(parseGitBugLabel("mandible:blocked-by:abc123")).toMatchObject({
      kind: "relationship",
      relationship_type: "blocks",
      direction: "incoming",
      target_ref: "abc123",
    });
  });
});

describe("git-bug ledger import", () => {
  it("imports issues, comments, labels, and parent relationships idempotently", async () => {
    const checkout = createCheckout();
    const client = new FakeGitBugClient([
      makeDetail({
        id: "git-parent",
        human_id: "par123",
        title: "Parent",
        labels: ["mandible:kind:umbrella"],
      }),
      makeDetail({
        id: "git-child",
        human_id: "chi123",
        title: "Child",
        labels: ["parent:par123", "mandible:priority:high"],
        comments: [{ id: "comment-1", body: "Imported comment" }],
      }),
    ]);

    const first = await importGitBugCheckout({ db, client, checkout });
    const second = await importGitBugCheckout({ db, client, checkout });
    const store = new LedgerStore(db);
    const issues = store.listIssues({ project_id: checkout.project_id });
    const child = issues.find((issue) => issue.title === "Child");
    expect(child).toBeTruthy();
    const detail = store.getIssueDetail(child!.id);

    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(issues).toHaveLength(2);
    expect(detail.comments).toHaveLength(1);
    expect(detail.labels.map((label) => label.label)).toContain("parent:par123");
    expect(detail.incoming_relationships).toHaveLength(1);
    expect(detail.priority).toBe("high");
    expect(store.listConflicts({ status: "open" })).toHaveLength(0);
  });

  it("records conflicts for relationship labels whose targets cannot be resolved", async () => {
    const checkout = createCheckout();
    const client = new FakeGitBugClient([
      makeDetail({
        id: "git-child",
        human_id: "chi123",
        title: "Child",
        labels: ["parent:missing"],
      }),
    ]);

    const first = await importGitBugCheckout({ db, client, checkout });
    const second = await importGitBugCheckout({ db, client, checkout });

    const store = new LedgerStore(db);
    expect(first.conflicts).toBe(1);
    expect(second.conflicts).toBe(1);
    expect(store.listConflicts({ status: "open" })).toHaveLength(1);
  });
});

describe("git-bug ledger export", () => {
  it("exports local issue creation through pending outbox rows", async () => {
    const checkout = createCheckout();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const issue = store.createIssue({
      project_id: checkout.project_id,
      title: "Local issue",
      body: "Body",
      kind: "feature",
      priority: "high",
    });
    const client = new FakeGitBugClient([]);

    const result = await exportGitBugOutbox({
      db,
      client,
      project_id: checkout.project_id,
      repoRoot: checkout.root,
    });

    expect(result.applied).toBe(1);
    expect(client.createdInputs).toEqual([{
      title: "Local issue",
      body: "Body",
      labels: ["mandible:kind:feature", "mandible:priority:high"],
    }]);
    expect(store.findExternalRefForEntity({
      adapter: "git_bug",
      entity_type: "issue",
      entity_id: issue.id,
      external_kind: "git_bug_issue",
    })).toBeTruthy();
    expect(store.listOutbox({ status: "applied" })).toHaveLength(1);
  });

  it("turns remote hash divergence into conflicts instead of overwrites", async () => {
    const checkout = createCheckout();
    const remote = makeDetail({ id: "git-1", human_id: "abc123", title: "Remote" });
    const client = new FakeGitBugClient([remote]);
    await importGitBugCheckout({ db, client, checkout });
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const issue = store.listIssues({ project_id: checkout.project_id })[0];

    client.replaceDetail("abc123", makeDetail({ id: "git-1", human_id: "abc123", title: "Changed remotely" }));
    store.setLabel(issue.id, "mandible:priority:high", true);

    const result = await exportGitBugOutbox({
      db,
      client,
      project_id: checkout.project_id,
      repoRoot: checkout.root,
    });

    expect(result.conflicted).toBe(1);
    expect(store.listConflicts({ status: "open" })).toHaveLength(1);
    expect(store.listOutbox({ status: "conflicted" })).toHaveLength(1);
  });

  it("refreshes the remote cursor after applying git-bug mutations", async () => {
    const checkout = createCheckout();
    const client = new FakeGitBugClient([
      makeDetail({ id: "git-1", human_id: "abc123", title: "Remote" }),
    ]);
    await importGitBugCheckout({ db, client, checkout });
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const issue = store.listIssues({ project_id: checkout.project_id })[0];

    store.setLabel(issue.id, "mandible:priority:high", true);
    const first = await exportGitBugOutbox({
      db,
      client,
      project_id: checkout.project_id,
      repoRoot: checkout.root,
    });
    store.setLabel(issue.id, "mandible:kind:task", true);
    const second = await exportGitBugOutbox({
      db,
      client,
      project_id: checkout.project_id,
      repoRoot: checkout.root,
    });

    expect(first).toMatchObject({ applied: 1, conflicted: 0 });
    expect(second).toMatchObject({ applied: 1, conflicted: 0 });
    expect(store.listConflicts({ status: "open" })).toHaveLength(0);
  });

	  it("exports local title and body updates to git-bug", async () => {
    const checkout = createCheckout();
    const client = new FakeGitBugClient([
      makeDetail({ id: "git-1", human_id: "abc123", title: "Remote", body: "Old body" }),
    ]);
    await importGitBugCheckout({ db, client, checkout });
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const issue = store.listIssues({ project_id: checkout.project_id })[0];

    store.updateIssue(issue.id, { title: "Updated title", body: "Updated body" });
    const result = await exportGitBugOutbox({
      db,
      client,
      project_id: checkout.project_id,
      repoRoot: checkout.root,
    });
    const remote = await client.getIssue(checkout.root, "abc123");

    expect(result).toMatchObject({ applied: 1, conflicted: 0, failed: 0 });
    expect(remote.ok && remote.value.title).toBe("Updated title");
    expect(remote.ok && remote.value.description).toBe("Updated body");
	    expect(store.listConflicts({ status: "open" })).toHaveLength(0);
	  });

	  it("exports lifecycle status events to git-bug", async () => {
	    const checkout = createCheckout();
	    const client = new FakeGitBugClient([
	      makeDetail({ id: "git-1", human_id: "abc123", title: "Remote", status: "open" }),
	    ]);
	    await importGitBugCheckout({ db, client, checkout });
	    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
	    const issue = store.listIssues({ project_id: checkout.project_id })[0];

	    store.setIssueStatus(issue.id, "closed", "merged");
	    const closedResult = await exportGitBugOutbox({
	      db,
	      client,
	      project_id: checkout.project_id,
	      repoRoot: checkout.root,
	    });
	    const closedRemote = await client.getIssue(checkout.root, "abc123");

	    store.setIssueStatus(issue.id, "open", null);
	    const reopenedResult = await exportGitBugOutbox({
	      db,
	      client,
	      project_id: checkout.project_id,
	      repoRoot: checkout.root,
	    });
	    const reopenedRemote = await client.getIssue(checkout.root, "abc123");

	    expect(closedResult).toMatchObject({ applied: 1, conflicted: 0, failed: 0 });
	    expect(closedRemote.ok && closedRemote.value.status).toBe("closed");
	    expect(reopenedResult).toMatchObject({ applied: 1, conflicted: 0, failed: 0 });
	    expect(reopenedRemote.ok && reopenedRemote.value.status).toBe("open");
	    expect(store.listConflicts({ status: "open" })).toHaveLength(0);
	  });
	});

describe("git-bug sync jobs", () => {
  it("does not mark successful zero-conflict exports as conflicted", async () => {
    const checkout = createCheckout();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    store.createIssue({
      project_id: checkout.project_id,
      title: "Local issue",
      body: "Body",
      kind: "feature",
    });
    const client = new FakeGitBugClient([]);

    const job = await runGitBugSync({ db, client, checkout, direction: "export" });

    expect(job.status).toBe("completed");
    expect(JSON.parse(job.stats_json).export).toMatchObject({ applied: 1, conflicted: 0 });
  });

  it("marks retryable git-bug export failures retryable at the sync-job level", async () => {
    const checkout = createCheckout();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    store.createIssue({
      project_id: checkout.project_id,
      title: "Local issue",
      body: "Body",
      kind: "feature",
    });
    const client = new ExportLockingGitBugClient();

    const job = await runGitBugSync({ db, client, checkout, direction: "export" });

    expect(job.status).toBe("retryable");
    expect(job.next_retry_at).toBeGreaterThan(Date.now());
    expect(JSON.parse(job.stats_json).export).toMatchObject({ retryable: 1 });
  });

  it("marks lock-like failures retryable without blocking ledger writes", async () => {
    const checkout = createCheckout();
    const client = new LockingGitBugClient();
    const job = await runGitBugSync({ db, client, checkout, direction: "import" });
    const store = new LedgerStore(db);
    const issue = store.createIssue({ project_id: checkout.project_id, title: "Still writable" });

    expect(job.status).toBe("retryable");
    expect(job.next_retry_at).toBeGreaterThan(Date.now());
    expect(issue.id).toMatch(/^[0-9a-f]{64}$/);
    expect(listLedgerSyncJobs(db, { adapter: "git_bug" })).toHaveLength(1);
  });
});

class FakeGitBugClient implements GitBugClient {
  readonly createdTitles: string[] = [];
  readonly createdInputs: GitBugCreateIssueInput[] = [];
  private details = new Map<string, GitBugIssueDetail>();

  constructor(details: GitBugIssueDetail[]) {
    for (const detail of details) {
      this.replaceDetail(detail.human_id || detail.id, detail);
    }
  }

  replaceDetail(ref: string, detail: GitBugIssueDetail): void {
    this.details.set(ref, detail);
    this.details.set(detail.id, detail);
    this.details.set(detail.human_id, detail);
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

  async createIssue(_repoRoot: string, input: GitBugCreateIssueInput): Promise<GitBugResult<{ id: string }>> {
    this.createdTitles.push(input.title);
    this.createdInputs.push(input);
    const id = `new-${this.createdTitles.length}`;
    const detail = makeDetail({ id, human_id: id, title: input.title, body: input.body, labels: input.labels ?? [] });
    this.replaceDetail(id, detail);
    return ok({ id });
  }

  async editTitle(_repoRoot: string, ref: string, title: string): Promise<GitBugResult<void>> {
    const detail = this.details.get(ref);
    if (!detail) return fail("not found");
    this.replaceDetail(ref, { ...detail, title, raw: { ...(detail.raw as object), title } });
    return ok(undefined);
  }

  async editComment(_repoRoot: string, commentId: string, body: string): Promise<GitBugResult<void>> {
    for (const detail of new Set(this.details.values())) {
      if (detail.description_comment_id === commentId) {
        const raw = detail.raw as { comments?: Array<Record<string, unknown>> };
        const comments = (raw.comments ?? []).map((comment, index) => (
          index === 0 ? { ...comment, message: body } : comment
        ));
        this.replaceDetail(detail.human_id || detail.id, {
          ...detail,
          description: body,
          raw: { ...raw, comments },
        });
        return ok(undefined);
      }
    }
    return fail("not found");
  }

  async setStatus(_repoRoot: string, ref: string, status: "open" | "closed"): Promise<GitBugResult<void>> {
    const detail = this.details.get(ref);
    if (!detail) return fail("not found");
    const next = { ...detail, status, raw: { ...(detail.raw as object), status } };
    this.replaceDetail(ref, next);
    return ok(undefined);
  }

  async addComment(): Promise<GitBugResult<{ id?: string }>> {
    return ok({ id: "new-comment" });
  }

  async addLabel(_repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>> {
    const detail = this.details.get(ref);
    if (!detail) return fail("not found");
    const labels = Array.from(new Set([...detail.labels, label]));
    this.replaceDetail(ref, { ...detail, labels, raw: { ...(detail.raw as object), labels } });
    return ok(undefined);
  }

  async removeLabel(_repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>> {
    const detail = this.details.get(ref);
    if (!detail) return fail("not found");
    const labels = detail.labels.filter((candidate) => candidate !== label);
    this.replaceDetail(ref, { ...detail, labels, raw: { ...(detail.raw as object), labels } });
    return ok(undefined);
  }
}

class ExportLockingGitBugClient extends FakeGitBugClient {
  constructor() {
    super([]);
  }

  async createIssue(): Promise<GitBugResult<{ id: string }>> {
    return fail("repository is locked by another git-bug process", "retryable");
  }
}

class LockingGitBugClient extends FakeGitBugClient {
  constructor() {
    super([makeDetail({ id: "git-1", human_id: "abc123", title: "Remote" })]);
  }

  async listIssues(): Promise<GitBugResult<GitBugIssueSummary[]>> {
    return fail("repository is locked by another git-bug process", "retryable");
  }
}

function makeDetail(input: {
  id: string;
  human_id: string;
  title: string;
  body?: string;
  labels?: string[];
  comments?: Array<{ id: string; body: string }>;
}): GitBugIssueDetail {
  const raw = {
    id: input.id,
    human_id: input.human_id,
    title: input.title,
    status: "open",
    labels: input.labels ?? [],
    author: { name: "Agent" },
    create_time: { time: "2026-05-16T12:00:00Z" },
    comments: [
      { id: "description", human_id: "description", author: { name: "Agent" }, message: input.body ?? "" },
      ...(input.comments ?? []).map((comment) => ({
        id: comment.id,
        human_id: comment.id,
        author: { name: "Agent" },
        message: comment.body,
        create_time: { time: "2026-05-16T12:01:00Z" },
      })),
    ],
  };
  return {
    id: input.id,
    human_id: input.human_id,
    title: input.title,
    status: "open",
    labels: input.labels ?? [],
    author_name: "Agent",
    created_at: "2026-05-16T12:00:00Z",
    description: input.body ?? "",
    description_comment_id: "description",
    comments: (input.comments ?? []).map((comment) => ({
      id: comment.id,
      human_id: comment.id,
      author_name: "Agent",
      body: comment.body,
      created_at: "2026-05-16T12:01:00Z",
    })),
    raw,
  };
}

function ok<T>(value: T): GitBugResult<T> {
  return { ok: true, value, stdout: "", stderr: "", exit_code: 0 };
}

function fail<T>(error: string, retry: "retryable" | "fatal" = "fatal"): GitBugResult<T> {
  return { ok: false, error, retry, stdout: "", stderr: error, exit_code: 1 };
}
