// Issue 608d1db — auth-request duplicate detection is scoped to the repository.
//
// A branch name is unique only within a repo. `feature/<issue>-<slug>` naming
// makes cross-repo collisions likely for exactly the case that produces two
// requests at once: one program delivered across two repos. Matching on
// (head_branch, base_branch) alone refused the second repo's request as a
// duplicate of the first repo's, and the refusal echoed the caller's own title
// back with a success exit, so the missing delivery was invisible.
import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { clearRepoIdentityCache } from "../src/repo-identity.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { addCredential } from "../src/users/store.js";
import { createLedgerIssue, createLedgerProject } from "./helpers/auth-queue-fixtures.js";

const SHARED_BRANCH = "feature/5bd2a6d-tasks-program";

let db: Db | null = null;
let testRequesterUserId = "";
let testRequesterCredentialId = "";
const tempRoots: string[] = [];

// Minimal registrar mirroring test/inbox-scoping.test.ts: injects an
// authenticated client identity so POST /api/auth/request reaches the handler.
class TestRouteResponse implements ResponseLike {
  statusCode = 200;
  body: unknown;

  status(code: number): ResponseLike {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): void {
    this.body = payload;
  }
}

class TestRouteRegistrar implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();

  get(_path: string, _handler: RouteHandler): void {}
  post(path: string, handler: RouteHandler): void {
    this.handlers.set(`POST ${path}`, handler);
  }
  put(_path: string, _handler: RouteHandler): void {}
  patch(_path: string, _handler: RouteHandler): void {}
  delete(_path: string, _handler: RouteHandler): void {}

  async invoke(
    method: string,
    routePath: string,
    body: unknown,
  ): Promise<TestRouteResponse> {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) {
      throw new Error(`missing handler for ${method} ${routePath}`);
    }
    const response = new TestRouteResponse();
    await handler({
      method,
      url: routePath,
      params: {},
      query: {},
      body,
      client_identity: {
        user_id: testRequesterUserId,
        slug: "auth-dedup-test",
        method: "api_token",
        credential_id: testRequesterCredentialId,
        source: "in_process",
      },
    } satisfies RequestLike, response);
    return response;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** A real Git checkout, so canonical repo identity actually resolves. */
function createRepo(label: string): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `mandible-dedup-${label}-`)),
  );
  tempRoots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Mandible Test"]);
  git(root, ["config", "user.email", "mandible-test@localhost"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["checkout", "-b", SHARED_BRANCH]);
  fs.writeFileSync(path.join(root, "feature.txt"), `${label}\n`, "utf8");
  git(root, ["add", "."]);
  // The route's auth-merge gate requires Mandible-Issue references on the
  // non-merge commits being submitted.
  git(root, ["commit", "-m", `${label}\n\nMandible-Issue: 608d1db`]);
  git(root, ["checkout", "main"]);
  registerWorkRepo(root);
  const project = createLedgerProject(db!, root);
  const issue = createLedgerIssue(db!, project.project.id, "608d1db", `Dedup ${label}`);
  db!.prepare(`INSERT INTO work_units
    (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
     ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
    VALUES (?, '608d1db', ?, ?, 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
    .run(crypto.randomUUID(), project.project.project_key, SHARED_BRANCH, issue.id,
      testRequesterUserId, testRequesterCredentialId);
  return root;
}

/**
 * The auth-merge route only accepts a target_repo_root it can resolve to a
 * registered work repo.
 */
function registerWorkRepo(root: string): void {
  db?.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, 'main', 1, 0)`,
  ).run(path.basename(root), root, path.basename(root));
}

function createQueue(): AuthQueue {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  testRequesterUserId = setupOperator(db, {
    slug: "auth-dedup-test",
    display_name: "Auth Dedup Test",
  }).id;
  testRequesterCredentialId = addCredential(db, testRequesterUserId, {
    type: "api_token",
    fingerprint: `auth-dedup-${crypto.randomUUID()}`,
  }).id;
  setDb(db);
  return new AuthQueue({ db });
}

function submission(repoRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    command: `mandible auth merge ${SHARED_BRANCH} --into main`,
    title: `Merge ${SHARED_BRANCH}`,
    repo: path.basename(repoRoot),
    cwd: repoRoot,
    target_repo_root: repoRoot,
    head_branch: SHARED_BRANCH,
    base_branch: "main",
    issue_references: ["608d1db"],
    ...overrides,
  };
}

beforeEach(() => {
  // Canonical repo keys are memoized per input path for the process lifetime.
  clearRepoIdentityCache();
});

afterEach(() => {
  db?.close();
  db = null;
  clearRepoIdentityCache();
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("auth request duplicate detection is repo-scoped", () => {
  it("queues the same branch name submitted from two different repos", () => {
    const queue = createQueue();
    const repoA = createRepo("alpha");
    const repoB = createRepo("beta");

    const first = queue.submit(submission(repoA));

    // The reported bug: this returned `first` and the second repo's delivery
    // was never queued.
    expect(queue.findDuplicate(submission(repoB))).toBeNull();

    const second = queue.submit(submission(repoB));
    expect(second.id).not.toBe(first.id);

    const queued = queue
      .listActive()
      .filter((request) => request.head_branch === SHARED_BRANCH);
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((request) => request.repo))).toEqual(
      new Set([path.basename(repoA), path.basename(repoB)]),
    );
  });

  it("still refuses the same branch resubmitted in the same repo", () => {
    const queue = createQueue();
    const repoA = createRepo("alpha");

    const first = queue.submit(submission(repoA));
    const duplicate = queue.findDuplicate(submission(repoA));

    expect(duplicate).not.toBeNull();
    expect(duplicate!.id).toBe(first.id);
  });

  it("matches the same repo across a name-only and a path-only submission", () => {
    // Canonical identity, not string equality: one side carries only the repo
    // string, the other only the checkout path.
    const queue = createQueue();
    const repoA = createRepo("alpha");

    const first = queue.submit(
      submission(repoA, { cwd: null, target_repo_root: null }),
    );
    const duplicate = queue.findDuplicate(
      submission(repoA, { repo: undefined }),
    );

    expect(duplicate?.id).toBe(first.id);
  });

  it("treats a linked worktree of the same repo as the same repo", () => {
    const queue = createQueue();
    const repoA = createRepo("alpha");
    const worktree = path.join(path.dirname(repoA), `${path.basename(repoA)}-wt`);
    tempRoots.push(worktree);
    git(repoA, ["worktree", "add", "--detach", worktree, "main"]);

    const first = queue.submit(submission(repoA));
    // Same physical repo, different path and different basename.
    const duplicate = queue.findDuplicate(
      submission(repoA, {
        repo: path.basename(worktree),
        cwd: worktree,
        target_repo_root: worktree,
      }),
    );

    expect(duplicate?.id).toBe(first.id);
  });

  it("scopes the session+title fallback to the repo as well", () => {
    // One agent session delivering one program across two repos reuses the
    // title, so an unscoped session+title match reintroduces the same bug.
    const queue = createQueue();
    const repoA = createRepo("alpha");
    const repoB = createRepo("beta");
    const sessionId = "session-cross-repo";

    queue.submit(
      submission(repoA, { session_id: sessionId, head_branch: undefined, base_branch: undefined }),
    );

    expect(
      queue.findDuplicate(
        submission(repoB, {
          session_id: sessionId,
          head_branch: undefined,
          base_branch: undefined,
        }),
      ),
    ).toBeNull();
  });

  describe("rows that predate repo capture", () => {
    it("does not let a null-repo row swallow a repo-identified submission", () => {
      const queue = createQueue();
      const repoA = createRepo("alpha");

      // A legacy row: same branch pair, no repo evidence of any kind.
      queue.submit({
        command: `mandible auth merge ${SHARED_BRANCH} --into main`,
        title: `Merge ${SHARED_BRANCH}`,
        head_branch: SHARED_BRANCH,
        base_branch: "main",
      });

      expect(queue.findDuplicate(submission(repoA))).toBeNull();
    });

    it("keeps deduping two submissions that both carry no repo evidence", () => {
      // The 16985e8 retry protection must survive on legacy rows.
      const queue = createQueue();
      const payload = {
        command: `mandible auth merge ${SHARED_BRANCH} --into main`,
        title: `Merge ${SHARED_BRANCH}`,
        head_branch: SHARED_BRANCH,
        base_branch: "main",
      };

      const first = queue.submit(payload);
      expect(queue.findDuplicate(payload)?.id).toBe(first.id);
    });

    it("does not crash when a recorded repo path no longer exists", () => {
      // A queued request whose checkout was since deleted: no canonical key
      // resolves on that side, so the comparison falls back to repo strings.
      const queue = createQueue();
      const repoA = createRepo("alpha");
      const repoB = createRepo("beta");
      const missing = path.join(os.tmpdir(), "mandible-dedup-deleted-repo");

      const stale = queue.submit(submission(repoB, { repo: "deleted-repo" }));
      db!
        .prepare("UPDATE auth_requests SET cwd = ?, target_repo_root = ? WHERE id = ?")
        .run(missing, missing, stale.id);
      clearRepoIdentityCache();

      // Different repo string, unresolvable path — not a duplicate, no throw.
      expect(() => queue.findDuplicate(submission(repoA))).not.toThrow();
      expect(queue.findDuplicate(submission(repoA))).toBeNull();
      // Same repo string still dedups on the string fallback.
      expect(
        queue.findDuplicate(submission(repoA, { repo: "deleted-repo" }))?.id,
      ).toBe(stale.id);
    });
  });
});

describe("POST /api/auth/request duplicate refusal", () => {
  async function postRequest(
    app: TestRouteRegistrar,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.invoke("POST", "/api/auth/request", body);
    return { status: response.statusCode, body: response.body as Record<string, unknown> };
  }

  function createRouter(queue: AuthQueue): TestRouteRegistrar {
    const app = new TestRouteRegistrar();
    registerAuthRoutes(app, queue, new AuthAutoApproveManager({ db: db! }));
    return app;
  }

  it("accepts the second repo's request for a same-named branch", async () => {
    const queue = createQueue();
    const router = createRouter(queue);
    const repoA = createRepo("alpha");
    const repoB = createRepo("beta");

    const first = await postRequest(router, submission(repoA));
    const second = await postRequest(router, submission(repoB));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.request_id).not.toBe(first.body.request_id);
  });

  it("reports the stored request's own identity, never the caller's input", async () => {
    const queue = createQueue();
    const router = createRouter(queue);
    const repoA = createRepo("alpha");

    const stored = await postRequest(
      router,
      submission(repoA, { title: "Stored request title" }),
    );
    expect(stored.status).toBe(201);

    const refused = await postRequest(
      router,
      submission(repoA, { title: "Caller supplied title" }),
    );

    expect(refused.status).toBe(409);
    expect(refused.body.request_id).toBe(stored.body.request_id);
    expect(refused.body.existing).toMatchObject({
      id: stored.body.request_id,
      status: "pending",
      title: "Stored request title",
      repo: path.basename(repoA),
      head_branch: SHARED_BRANCH,
      base_branch: "main",
    });
    // The refusal must never hand back the title the caller just passed.
    expect(JSON.stringify(refused.body)).not.toContain("Caller supplied title");
    expect(String(refused.body.error)).toContain("Nothing was queued");
  });
});
