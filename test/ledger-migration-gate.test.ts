import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import {
  listLedgerIssueSummaries,
} from "../src/ledger/issue-projection.js";
import { LedgerStore } from "../src/ledger/store.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { registerIssueRoutes, type IssueServer, type RouteHandler } from "../src/routes/issues.js";
import { setupOperator } from "../src/users/store.js";
import type { RepoInfo } from "../src/work-scanner.js";
import {
  SYSTEM_ACTOR,
  createLedgerIssue as createSharedLedgerIssue,
  createLedgerProject,
  migratedMemoryDb,
} from "./helpers/ledger-fixtures.js";
import { authenticatedTestIdentity } from "./helpers/authenticated-router.js";

let tempDir = "";
let db: Db;
let testOperator: ReturnType<typeof setupOperator>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-migration-"));
  db = migratedMemoryDb();
  setDb(db);
  testOperator = setupOperator(db, { display_name: "Route test operator" });
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
      client_identity: authenticatedTestIdentity(testOperator),
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
  const { project } = createLedgerProject(db, input.repo.root, {
    name: input.repo.name,
    workRepoId: input.repo.id,
    defaultBranch: input.repo.default_branch,
    remoteUrl: `git@github.com:mll/${input.repo.name}.git`,
  });
  const store = new LedgerStore(db);
  const issue = createSharedLedgerIssue(db, {
    store,
    project_id: project.id,
    title: input.title,
    body: input.body,
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

describe("ledger issue projection", () => {

  it("keeps canonical project keys on list summaries and rejects checkout ids as public filters", async () => {
    const repoInfo = repo("20-widgets-widgets", "Feedbax");
    const { issue } = createLedgerIssue({
      repo: repoInfo,
      alias: "fbx1234",
      title: "Feedbax synthesized issue",
    });
    db.prepare("UPDATE ledger_projects SET project_key = ? WHERE id = ?").run("feedbax", issue.project_id);
    const workScanner = fakeWorkScanner([repoInfo]);

    const summaries = listLedgerIssueSummaries(db, workScanner);
    const server = new TestIssueServer();
    registerIssueRoutes(server, workScanner as never);
    const byKey = await server.invoke("GET", "/api/issues", { query: { repo: "feedbax" } });
    const byLegacy = await server.invoke("GET", "/api/issues", { query: { repo: "20-widgets-widgets" } });

    expect(summaries).toMatchObject([{
      repo_id: "feedbax",
      project_key: "feedbax",
      issues: [{ id: issue.short_id, repo_id: "feedbax" }],
    }]);
    expect(byKey.body).toMatchObject([{
      repo_id: "feedbax",
      project_key: "feedbax",
      issues: [{ id: issue.short_id }],
    }]);
    expect(byLegacy.body).toEqual([]);
  });
});

describe("ledger relationship routes", () => {
  it("links and unlinks project-qualified issue refs while preserving bare aliases", async () => {
    const sourceRepo = repo("mandible", "mandible");
    const targetRepo = repo("feedbax", "feedbax");
    const { issue: source } = createLedgerIssue({
      repo: sourceRepo,
      alias: "source-alias",
      title: "Relationship source",
    });
    const { project: targetProject, issue: shortTarget } = createLedgerIssue({
      repo: targetRepo,
      alias: "short-target-alias",
      title: "Qualified short target",
    });
    const { issue: fullTarget } = createLedgerIssue({
      repo: targetRepo,
      alias: "full-target-alias",
      title: "Qualified full target",
    });
    const { issue: aliasTarget } = createLedgerIssue({
      repo: targetRepo,
      alias: "bare-target-alias",
      title: "Bare alias target",
    });
    const { issue: collidingSourceTarget } = createLedgerIssue({
      repo: sourceRepo,
      alias: "source-collision-alias",
      title: "Same short ID in source project",
    });
    db.prepare("UPDATE ledger_issues SET short_id = ? WHERE id = ?")
      .run(shortTarget.short_id, collidingSourceTarget.id);
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([sourceRepo, targetRepo]) as never);
    const targetRefs = [
      `${targetProject.project_key}/${shortTarget.short_id}`,
      `${targetProject.project_key}/${fullTarget.id}`,
      "bare-target-alias",
    ];

    const linked = await server.invoke("POST", "/api/ledger/relationships", {
      body: {
        source_ref: "source-alias",
        target_refs: targetRefs,
        link_type: "related",
      },
    });

    expect(linked.statusCode).toBe(200);
    expect(linked.body).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: shortTarget.id }),
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: fullTarget.id }),
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: aliasTarget.id }),
      ]),
    });

    const unlinked = await server.invoke("POST", "/api/ledger/relationships/unlink", {
      body: {
        source_ref: "source-alias",
        target_refs: targetRefs,
        link_type: "related",
      },
    });

    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.body).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: shortTarget.id }),
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: fullTarget.id }),
        expect.objectContaining({ source_issue_id: source.id, target_issue_id: aliasTarget.id }),
      ]),
    });
    expect(new LedgerStore(db).listRelationshipEdges({ source_issue_id: source.id })).toHaveLength(0);
  });
});

describe("ledger issue routes", () => {

  it("atomically reopens and comments through the ledger comment route", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue, store } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Closed writable" });
    store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);
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

  it("builds a deterministic umbrella status fact packet", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umb123",
      title: "Umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "Child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi123", external_id: "chi123", is_primary: true }],
    });
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });
    store.addIssueCheckpoint(umbrella.id, {
      ...SYSTEM_ACTOR,
      kind: "delegation-manifest",
      payload: [{ issue: child.short_id, digest: "before", branch: "feature/child" }],
      actor_type: "agent",
    });
    store.addIssueCheckpoint(child.id, {
      ...SYSTEM_ACTOR,
      kind: "closeout",
      payload: { worker_status: "done", branch: "feature/child", auth_request: null },
      actor_type: "agent",
    });
    store.addComment(child.id, { ...SYSTEM_ACTOR, body: "Finished child", actor_type: "agent" });
    store.setWorkerStatus(child.id, "done", SYSTEM_ACTOR);
    store.addIssueBranch(child.id, "feature/child", "primary", SYSTEM_ACTOR);
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
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "Deep child",
      body: "Deep child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "deepch", external_id: "deepch", is_primary: true }],
    });
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: umbrella.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });
    const linked = store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: child.id },
      target_entities: [{ entity_type: "issue", entity_id: umbrella.id }],
      link_type: "related",
      provenance: "manual",
      note: "Deep umbrella manual relationship",
    });
    store.addIssueCheckpoint(child.id, {
      ...SYSTEM_ACTOR,
      kind: "closeout",
      payload: { worker_status: "done", branch: "feature/deep", auth_request: null },
      actor_type: "agent",
    });
    store.addComment(child.id, { ...SYSTEM_ACTOR, body: "Deep child latest comment", actor_type: "agent" });
    store.addIssueBranch(child.id, "feature/deep", "primary", SYSTEM_ACTOR);

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
    expect((response.body as { children: Array<{ relationships: unknown[] }> }).children[0].relationships)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: linked.edges[0].id,
          direction: "outgoing",
          relationship_type: "related",
          link_type: "related",
          provenance: "manual",
          note: "Deep umbrella manual relationship",
          related_issue: expect.objectContaining({ display_id: umbrella.short_id }),
        }),
      ]));
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
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "First child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "adopta", external_id: "adopta", is_primary: true }],
    });
    const second = store.createIssue({
      ...SYSTEM_ACTOR,
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
    const manifestPayload = JSON.parse(manifest!.payload_json) as Array<Record<string, unknown>>;
    expect(manifestPayload).toEqual(expect.arrayContaining([
      expect.objectContaining({ short_id: first.short_id }),
      expect.objectContaining({ short_id: second.short_id }),
    ]));
    // The umbrella's own head is stored as an explicit self-baseline entry;
    // child entries never carry the self flag.
    expect(manifestPayload.filter((entry) => entry.self === true))
      .toEqual([expect.objectContaining({ short_id: umbrella.short_id, self: true })]);
    expect(manifestPayload
      .filter((entry) => entry.short_id !== umbrella.short_id)
      .every((entry) => !("self" in entry))).toBe(true);
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
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "Manifest child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "manich", external_id: "manich", is_primary: true }],
    });
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
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
    // Payload = the umbrella's self-baseline entry followed by child entries.
    expect(JSON.parse(manifest!.payload_json)).toMatchObject([
      { short_id: umbrella.short_id, self: true },
      { short_id: child.short_id },
    ]);
  });

  it("keeps a pinned refresh stable while preserving later own and descendant drift", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbstable",
      title: "Stable manifest umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "Stable manifest child",
      body: "Child body",
      kind: "umbrella",
      labels: ["umbrella"],
    });
    const grandchild = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: umbrella.project_id,
      title: "Stable manifest grandchild",
      body: "Grandchild body",
      kind: "feature",
      labels: ["feature"],
    });
    let clock = Date.now() - 10_000;
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: umbrella.id },
      target_entities: [{ entity_type: "issue", entity_id: child.id }],
      link_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: child.id },
      target_entities: [{ entity_type: "issue", entity_id: grandchild.id }],
      link_type: "parent_child",
      provenance: "manual",
      created_at: (clock += 1),
    });
    const unrelatedCheckpoint = store.addIssueCheckpoint(umbrella.id, {
      ...SYSTEM_ACTOR,
      kind: "closeout",
      payload: { worker_status: "done" },
      actor_type: "agent",
      created_at: (clock += 1),
    });
    const manifestWithoutSelf = store.addIssueCheckpoint(umbrella.id, {
      ...SYSTEM_ACTOR,
      kind: "delegation-manifest",
      payload: [],
      actor_type: "agent",
      created_at: (clock += 1),
    });

    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    const refreshed = await server.invoke(
      "POST",
      "/api/ledger/issues/:issueId/umbrella-manifest-refresh",
      { params: { issueId: "umbstable" } },
    );
    expect(refreshed.statusCode).toBe(200);
    const checkpoint = store.getLatestIssueCheckpoint(umbrella.id, "delegation-manifest")!;
    clock = checkpoint.created_at;
    const payload = JSON.parse(checkpoint.payload_json) as Array<{
      issue_id: string;
      digest: string;
      subtree_digest: string;
      self?: boolean;
    }>;
    const selfBaseline = payload.find((entry) => entry.self === true)!;
    const childBaseline = payload.find((entry) => entry.issue_id === child.id)!;
    expect(checkpoint.kind).toBe("delegation-manifest");
    expect(selfBaseline.issue_id).toBe(umbrella.id);

    const pinned = await server.invoke("GET", "/api/ledger/issues/:issueId/head", {
      params: { issueId: "umbstable" },
      query: { exclude_checkpoint: checkpoint.id },
    });
    expect(pinned.statusCode, JSON.stringify(pinned.body)).toBe(200);
    expect(pinned.body).toMatchObject({
      digest: selfBaseline.digest,
      subtree_digest: selfBaseline.subtree_digest,
    });
    expect(getLedgerIssueHead(db, umbrella.id).digest).not.toBe(selfBaseline.digest);

    for (const excludedId of [unrelatedCheckpoint.id, manifestWithoutSelf.id]) {
      const rejected = await server.invoke("GET", "/api/ledger/issues/:issueId/head", {
        params: { issueId: "umbstable" },
        query: { exclude_checkpoint: excludedId },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toEqual({
        error: "exclude_checkpoint must name this issue's self-baselined delegation manifest",
      });
    }

    store.addComment(grandchild.id, {
      ...SYSTEM_ACTOR,
      body: "Descendant drift after the pinned baseline",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (clock += 1),
    });
    const afterDescendant = getLedgerIssueHead(db, umbrella.id, {
      excludeCheckpointId: checkpoint.id,
    });
    const childAfterDescendant = getLedgerIssueHead(db, child.id);
    expect(afterDescendant.digest).toBe(selfBaseline.digest);
    expect(afterDescendant.subtree_digest).not.toBe(selfBaseline.subtree_digest);
    expect(childAfterDescendant.digest).toBe(childBaseline.digest);
    expect(childAfterDescendant.subtree_digest).not.toBe(childBaseline.subtree_digest);

    store.updateIssue(
      umbrella.id,
      { body: "Umbrella body drift after the pinned baseline" },
      { ...SYSTEM_ACTOR, source: "mandible" },
    );
    const afterOwnDrift = getLedgerIssueHead(db, umbrella.id, {
      excludeCheckpointId: checkpoint.id,
    });
    expect(afterOwnDrift.digest).not.toBe(selfBaseline.digest);
  });

  it("stores the self-baseline entry even for a zero-child manifest refresh", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue: umbrella, store } = createLedgerIssue({
      repo: repoInfo,
      alias: "umbzero",
      title: "Zero-child umbrella",
      labels: ["umbrella"],
    });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);

    const response = await server.invoke("POST", "/api/ledger/issues/:issueId/umbrella-manifest-refresh", {
      params: { issueId: "umbzero" },
    });

    expect(response.statusCode).toBe(200);
    const manifest = store.getLatestIssueCheckpoint(umbrella.id, "delegation-manifest");
    // A zero-child manifest still carries the umbrella's self-baseline entry
    // (with subtree_digest), so `issue changed --since-issue` can distinguish
    // it from a pre-upgrade checkpoint and classify a stable umbrella
    // "unchanged" instead of "unknown". An empty payload would be
    // indistinguishable from a legacy one.
    const payload = JSON.parse(manifest!.payload_json) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ short_id: umbrella.short_id, self: true });
    expect(typeof payload[0].digest).toBe("string");
    expect(typeof payload[0].subtree_digest).toBe("string");
  });

  it("warns by default on likely escaped Markdown and preserves the body exactly", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
    createLedgerProject(db, repoInfo.root, { name: repoInfo.name, workRepoId: repoInfo.id });
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

  it("rejects likely escaped Markdown issue and comment writes when configured", async () => {
    const repoInfo = repo("repo-1", "mandible");
    const { issue } = createLedgerIssue({ repo: repoInfo, alias: "abc123", title: "Writable" });
    const server = new TestIssueServer();
    registerIssueRoutes(server, fakeWorkScanner([repoInfo]) as never);
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

});
