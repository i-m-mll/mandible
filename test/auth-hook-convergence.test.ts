/**
 * Issue 27241e6 — probes for durable, honest, authorized post-merge hooks.
 *
 * Every database here is an in-memory or temp-dir database. Nothing in this
 * file may touch the production paths (~/.mandible, ~/.cache/mandible); the
 * production guard in src/db.ts exists for exactly this reason.
 */

import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_HOOK_ENV_ALLOWLIST,
  AuthHookManager,
  authHookCommandDigest,
  buildAuthHookEnv,
  convergenceStateFromRuns,
} from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addGrant } from "../src/permissions/store.js";
import { registerAuthHookRoutes } from "../src/routes/auth-hooks.js";
import { Router } from "../src/server.js";
import type { AuthHookRun, AuthRequest } from "../src/types.js";
import { createUser, setupOperator } from "../src/users/store.js";
import {
  createLedgerIssue,
  createLedgerProject,
  createMigratedDb,
} from "./helpers/ledger-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function plainDb(): Db {
  const db = new SqliteDatabase(":memory:");
  migrate(db);
  setupOperator(db, { slug: "hook-convergence", display_name: "Hook Convergence" }, 1);
  return db;
}

function fakeRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    id: "req-convergence-1",
    session_id: null,
    type: "merge",
    command: "echo merge",
    title: "Convergence probe",
    cwd: os.tmpdir(),
    diff_summary: null,
    commit_message: null,
    spec_content: null,
    repo: "probe-repo",
    base_branch: "main",
    head_branch: "feature/probe",
    execution_mode: "daemon",
    status: "completed",
    created_at: 1,
    updated_at: 1,
    last_executed_at: null,
    approved_at: null,
    resolved_at: null,
    skipped_at: null,
    expires_at: Date.now() + 86_400_000,
    exit_code: 0,
    output: "",
    error: null,
    acknowledged_by: null,
    ...overrides,
  } as AuthRequest;
}

/**
 * A hook that fails until a marker file exists. Paths are interpolated because
 * the hook environment is scrubbed — a hook cannot read an ambient variable the
 * test process happens to hold.
 */
function markerGatedCommand(marker: string): string {
  return `if [ -f "${marker}" ]; then echo converged; exit 0; else echo "not converged yet" >&2; exit 7; fi`;
}

describe("auth hook execution environment (issue 27241e6)", () => {
  it("hands the hook a scrubbed allowlist, never the daemon's ambient environment", () => {
    const db = plainDb();
    try {
      const env = buildAuthHookEnv(
        fakeRequest({
          merge_preflight_base_sha: "b".repeat(40),
          merge_head_sha: "c".repeat(40),
        }),
        {
          hook_id: "hook-1",
          hook_label: "Probe hook",
          attempt: 2,
          execution_id: "exec-1",
          command_digest: "a".repeat(64),
        },
        {
          db,
          source: {
            HOME: "/tmp/fake-home",
            USER: "probe",
            PATH: "/attacker/bin",
            AWS_SECRET_ACCESS_KEY: "leak-me",
            GITHUB_TOKEN: "leak-me-too",
            ANTHROPIC_API_KEY: "and-me",
            MANDIBLE_BASE: "http://127.0.0.1:19420",
            CLAUDECODE: "1",
            SSH_AUTH_SOCK: "/tmp/agent.sock",
          },
        },
      );

      // Secrets and daemon-private configuration never reach the child.
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.MANDIBLE_BASE).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();

      // The allowlisted facts do.
      expect(env.HOME).toBe("/tmp/fake-home");
      expect(env.USER).toBe("probe");

      // PATH is controlled by Mandible, not inherited from whatever launched it.
      expect(env.PATH).not.toContain("/attacker/bin");
      expect(env.PATH).toContain("/usr/bin");
      expect(env.PATH?.split(":").slice(0, 3)).toEqual([
        "/tmp/fake-home/.local/bin",
        "/tmp/fake-home/.cargo/bin",
        "/tmp/fake-home/bin",
      ]);

      // The documented hook contract.
      expect(env.MANDIBLE_HOOK_ID).toBe("hook-1");
      expect(env.MANDIBLE_HOOK_LABEL).toBe("Probe hook");
      expect(env.MANDIBLE_HOOK_ATTEMPT).toBe("2");
      expect(env.MANDIBLE_HOOK_EXECUTION_ID).toBe("exec-1");
      expect(env.MANDIBLE_AUTH_REQUEST_ID).toBe("req-convergence-1");
      expect(env.MANDIBLE_AUTH_REPO).toBe("probe-repo");
      expect(env.MANDIBLE_AUTH_MERGE_BASE_SHA).toBe("b".repeat(40));
      expect(env.MANDIBLE_AUTH_MERGE_HEAD_SHA).toBe("c".repeat(40));
      expect(env.CI).toBe("true");

      // Nothing outside the documented set leaks in.
      const documented = new Set([
        ...AUTH_HOOK_ENV_ALLOWLIST,
        "PATH",
        "TERM",
        "CI",
        "MANDIBLE_AUTH_REQUEST_ID",
        "MANDIBLE_AUTH_TYPE",
        "MANDIBLE_AUTH_REPO",
        "MANDIBLE_AUTH_BRANCH",
        "MANDIBLE_AUTH_BASE_BRANCH",
        "MANDIBLE_AUTH_MERGE_BASE_SHA",
        "MANDIBLE_AUTH_MERGE_HEAD_SHA",
        "MANDIBLE_HOOK_ID",
        "MANDIBLE_HOOK_LABEL",
        "MANDIBLE_HOOK_ATTEMPT",
        "MANDIBLE_HOOK_EXECUTION_ID",
        "MANDIBLE_HOOK_COMMAND_DIGEST",
      ]);
      for (const key of Object.keys(env)) {
        expect(documented.has(key)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("scrubs the real spawned process too, not just the computed env object", async () => {
    const db = plainDb();
    const dir = tempDir("mandible-hook-env-");
    const dump = path.join(dir, "env.txt");
    const previous = process.env.MANDIBLE_PROBE_SECRET;
    process.env.MANDIBLE_PROBE_SECRET = "must-not-leak";
    try {
      const manager = new AuthHookManager(db);
      manager.create({
        repo_pattern: "probe-repo",
        auth_type: "merge",
        command: `env > "${dump}"`,
        label: "Dump env",
        position: 0,
      });

      const results = await manager.executeHooks(fakeRequest({ cwd: dir }));
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);

      const dumped = fs.readFileSync(dump, "utf8");
      expect(dumped).not.toContain("MANDIBLE_PROBE_SECRET");
      expect(dumped).not.toContain("must-not-leak");
      expect(dumped).toContain("MANDIBLE_HOOK_ID=");
      expect(dumped).toContain("MANDIBLE_HOOK_ATTEMPT=1");
    } finally {
      if (previous === undefined) delete process.env.MANDIBLE_PROBE_SECRET;
      else process.env.MANDIBLE_PROBE_SECRET = previous;
      db.close();
    }
  });
});

describe("durable hook execution state (issue 27241e6)", () => {
  it("snapshots the hook id and command digest when execution begins", async () => {
    const db = plainDb();
    const dir = tempDir("mandible-hook-snapshot-");
    try {
      const manager = new AuthHookManager(db);
      const command = "echo snapshot-me";
      const hook = manager.create({
        repo_pattern: "probe-repo",
        auth_type: "merge",
        command,
        label: "Snapshot hook",
      });

      await manager.executeHooks(fakeRequest({ cwd: dir }));
      const run = manager.getRun("req-convergence-1", hook.id)!;
      expect(run.hook_id).toBe(hook.id);
      expect(run.command).toBe(command);
      expect(run.command_digest).toBe(authHookCommandDigest(command));
      expect(run.state).toBe("complete");

      // Editing the hook afterwards does not rewrite the executed snapshot —
      // that is what makes "which bytes actually ran?" answerable later.
      manager.update(hook.id, { command: "echo something-else" });
      expect(manager.getRun("req-convergence-1", hook.id)!.command).toBe(command);
    } finally {
      db.close();
    }
  });

  it("survives a daemon killed between the merge and hook completion, then converges on rerun", async () => {
    const db = plainDb();
    const dir = tempDir("mandible-hook-durable-");
    const marker = path.join(dir, "converged");
    let executorCalls = 0;
    try {
      const hookManager = new AuthHookManager(db);
      const hook = hookManager.create({
        repo_pattern: "durable-repo",
        auth_type: "merge",
        command: markerGatedCommand(marker),
        label: "Converge hook",
        position: 0,
      });

      const queue = new AuthQueue({
        db,
        hookManager,
        executor: async () => {
          executorCalls += 1;
          return { exit_code: 0, output: "merge-ok\n" };
        },
      });
      const request = queue.submit({
        command: 'echo "merge-ok"',
        title: "Durable convergence",
        repo: "durable-repo",
        cwd: dir,
      });
      queue.approve(request.id);
      await waitFor(() => queue.getRequest(request.id)?.status === "completed");

      // The merge succeeded and the queue is unblocked, but the hook did not.
      expect(executorCalls).toBe(1);
      expect(queue.getRequest(request.id)!.exit_code).toBe(0);
      expect(queue.convergenceForRequest(request.id).state).toBe("pending");

      // Simulate a daemon killed mid-attempt: the attempt was persisted before
      // the spawn, so the durable row is left in `running`.
      db.prepare("UPDATE auth_hook_executions SET state = 'running' WHERE auth_request_id = ?")
        .run(request.id);
      queue.dispose();
      expect(
        db.prepare("SELECT state, attempts FROM auth_hook_executions WHERE auth_request_id = ?")
          .get(request.id),
      ).toMatchObject({ state: "running", attempts: 1 });

      // The host condition that broke the hook is fixed, then a fresh daemon
      // boots over the same database and runs its normal startup recovery.
      // Nothing about the merge reruns.
      fs.writeFileSync(marker, "ok");
      const resumedQueue = new AuthQueue({
        db,
        hookManager: new AuthHookManager(db),
        executor: async () => {
          executorCalls += 1;
          return { exit_code: 0, output: "merge-ok\n" };
        },
      });
      await waitFor(() => resumedQueue.convergenceForRequest(request.id).state === "complete");

      expect(executorCalls).toBe(1);
      expect(resumedQueue.convergenceForRequest(request.id).state).toBe("complete");
      const run = new AuthHookManager(db).getRun(request.id, hook.id)!;
      expect(run.state).toBe("complete");
      expect(run.attempts).toBe(2);
      expect(run.attempt_history.map((entry) => entry.outcome)).toEqual(["failed", "ok"]);
      resumedQueue.dispose();
    } finally {
      db.close();
    }
  });

  it("bounds retries and reports merged / convergence failed", async () => {
    const db = plainDb();
    const dir = tempDir("mandible-hook-bounded-");
    try {
      const hookManager = new AuthHookManager(db);
      hookManager.create({
        repo_pattern: "bounded-repo",
        auth_type: "merge",
        command: "echo always-fails >&2; exit 3",
        label: "Broken hook",
        position: 0,
      });
      const queue = new AuthQueue({
        db,
        hookManager,
        backgroundMaintenance: false,
        executor: async () => ({ exit_code: 0, output: "merge-ok\n" }),
      });
      const request = queue.submit({
        command: 'echo "merge-ok"',
        title: "Bounded retry",
        repo: "bounded-repo",
        cwd: dir,
      });
      queue.approve(request.id);
      await waitFor(() => queue.getRequest(request.id)?.status === "completed");

      // Attempts 2 and 3 come from the resume sweep; the fourth is refused.
      await queue.resumeHookConvergence();
      await queue.resumeHookConvergence();
      await queue.resumeHookConvergence();

      const runs = hookManager.listRuns(request.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].attempts).toBe(3);
      expect(runs[0].max_attempts).toBe(3);
      expect(runs[0].state).toBe("failed");
      expect(runs[0].output).toContain("always-fails");
      expect(convergenceStateFromRuns(runs)).toBe("failed");
      expect(queue.convergenceForRequest(request.id).state).toBe("failed");

      // The merge itself is untouched: still completed, still exit 0.
      const merged = queue.getRequest(request.id)!;
      expect(merged.status).toBe("completed");
      expect(merged.exit_code).toBe(0);
      queue.dispose();
    } finally {
      db.close();
    }
  });

  it("creates exactly one deduplicated inbox alert per (request, hook)", async () => {
    const db = plainDb();
    const dir = tempDir("mandible-hook-alert-");
    try {
      const hookManager = new AuthHookManager(db);
      const hook = hookManager.create({
        repo_pattern: "alert-repo",
        auth_type: "merge",
        command: "exit 5",
        label: "Alerting hook",
        position: 0,
      });
      const queue = new AuthQueue({
        db,
        hookManager,
        backgroundMaintenance: false,
        executor: async () => ({ exit_code: 0, output: "merge-ok\n" }),
      });
      const request = queue.submit({
        command: 'echo "merge-ok"',
        title: "Dedup alert",
        repo: "alert-repo",
        cwd: dir,
      });
      queue.approve(request.id);
      await waitFor(() => queue.getRequest(request.id)?.status === "completed");
      await queue.resumeHookConvergence();
      await queue.resumeHookConvergence();
      await queue.resumeHookConvergence();

      const alerts = db
        .prepare("SELECT * FROM auth_hook_alerts WHERE auth_request_id = ?")
        .all(request.id) as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      expect(alerts[0].hook_id).toBe(hook.id);
      expect(String(alerts[0].detail)).toContain("merged but not live");
      expect(alerts[0].acknowledged_at).toBeNull();

      // No ledger issue is manufactured for a hook failure.
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM ledger_issues").get(),
      ).toEqual({ count: 0 });
      queue.dispose();
    } finally {
      db.close();
    }
  });
});

describe("convergence gates deferred issue closure (issue 27241e6)", () => {
  it("withholds issue closure while convergence is outstanding and applies it once the hook converges", async () => {
    const db = createMigratedDb({
      setGlobal: true,
      operator: { slug: "withhold-operator", display_name: "Withhold Operator" },
      agent: { slug: "withhold-agent", display_name: "Withhold Agent" },
      now: 1,
    });
    const dir = tempDir("mandible-hook-withhold-");
    const marker = path.join(dir, "converged");
    try {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-withhold-repo-"));
      tempDirs.push(repoRoot);
      const project = createLedgerProject(db, repoRoot, { defaultBranch: "main", remoteUrl: "" });
      const issue = createLedgerIssue(db, {
        project_id: project.project.id,
        title: "Withheld closure target",
        kind: "feature",
        priority: "normal",
        actor_type: "agent",
        author_display: "Codex",
        alias: "withhold1",
      });
      const repoName = path.basename(repoRoot);

      const hookManager = new AuthHookManager(db);
      hookManager.create({
        repo_pattern: repoName,
        auth_type: "merge",
        command: markerGatedCommand(marker),
        label: "Withholding hook",
        position: 0,
      });

      const queue = new AuthQueue({
        db,
        hookManager,
        backgroundMaintenance: false,
        executor: async () => ({ exit_code: 0, output: "merge-ok\n" }),
      });
      const request = queue.submit({
        command: 'echo "merge-ok"',
        title: "Withhold closure",
        cwd: repoRoot,
        repo: repoName,
        actions: [
          { kind: "comment_add", target_issue_ref: issue.short_id, payload: { body: "Closeout comment" } },
          { kind: "issue_close", target_issue_ref: issue.short_id, payload: {} },
        ],
      });
      queue.approve(request.id);
      await waitFor(() => queue.getRequest(request.id)?.status === "completed");

      // Merge succeeded; convergence did not. The closure stays staged and the
      // issue stays open, while the non-closure action still ran.
      expect(queue.convergenceForRequest(request.id).state).toBe("pending");
      const staged = queue.listActions(request.id);
      expect(staged.find((action) => action.kind === "comment_add")!.state).toBe("applied");
      expect(staged.find((action) => action.kind === "issue_close")!.state).toBe("staged");
      expect(new LedgerStore(db).getIssue(issue.id)!.status).toBe("open");

      // Once convergence completes the withheld closure is released.
      fs.writeFileSync(marker, "ok");
      await queue.resumeHookConvergence();

      expect(queue.convergenceForRequest(request.id).state).toBe("complete");
      const applied = queue.listActions(request.id);
      expect(applied.find((action) => action.kind === "issue_close")!.state).toBe("applied");
      expect(new LedgerStore(db).getIssue(issue.id)!.status).toBe("closed");
      queue.dispose();
    } finally {
      db.close();
    }
  });
});

describe("hook registration authority (issue 27241e6)", () => {
  it("denies hook mutation without the change_settings capability and allows it with the grant", async () => {
    const db = new SqliteDatabase(":memory:");
    const dir = tempDir("mandible-hook-authority-");
    try {
      migrate(db);
      setDb(db);
      setupOperator(db, { slug: "authority-operator", display_name: "Authority Operator" }, 1);
      setClientAuthMode(db, "strict");

      const authenticator = new ClientAuthenticator(db, { secretsDir: path.join(dir, "auth") });
      const router = new Router({ clientAuth: authenticator });
      registerAuthHookRoutes(router, new AuthHookManager(db));

      const agent = createUser(db, { slug: "hook-agent", kind: "agent", display_name: "Hook Agent" });
      const { token } = authenticator.mintApiToken(agent.id);
      const body = {
        repo_pattern: "authority-repo",
        auth_type: "merge",
        command: "echo take-over-the-machine",
        label: "Unauthorized hook",
      };

      // Anonymous: strict mode refuses the mutation outright.
      const anonymous = await router.invoke({
        method: "POST",
        url: "/api/auth/hooks",
        body,
        transport: "http",
      });
      expect(anonymous.status).toBe(401);

      // Authenticated but not authorized: authentication is not authorization.
      const unauthorized = await router.invoke({
        method: "POST",
        url: "/api/auth/hooks",
        body,
        credential: token,
        transport: "http",
      });
      expect(unauthorized.status).toBe(403);
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_hooks WHERE repo_pattern = 'authority-repo'").get())
        .toEqual({ count: 0 });

      // Reads stay open — inspecting the registry is not an authority change.
      const read = await router.invoke({
        method: "GET",
        url: "/api/auth/hooks",
        credential: token,
        transport: "http",
      });
      expect(read.status).toBe(200);

      // With the explicit prior operator grant, registration succeeds.
      addGrant(db, {
        subject_type: "user",
        subject: agent.id,
        resource_type: "global",
        permission: "change_settings",
      });
      const granted = await router.invoke({
        method: "POST",
        url: "/api/auth/hooks",
        body,
        credential: token,
        transport: "http",
      });
      expect(granted.status).toBe(201);
      const created = granted.body as { id: string; required: boolean };
      expect(created.required).toBe(true);

      // Update and delete carry the same fence.
      const authenticatorOnly = await router.invoke({
        method: "PUT",
        url: `/api/auth/hooks/${created.id}`,
        body: { command: "echo rewritten" },
        transport: "http",
      });
      expect(authenticatorOnly.status).toBe(401);

      const deleted = await router.invoke({
        method: "DELETE",
        url: `/api/auth/hooks/${created.id}`,
        credential: token,
        transport: "http",
      });
      expect(deleted.status).toBe(200);
    } finally {
      db.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

export type { AuthHookRun };
