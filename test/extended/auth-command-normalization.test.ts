import { approveFixtureRequest, createNoopHookManager } from "../helpers/auth-queue-fixtures.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthQueue, AuthQueueError } from "../../src/auth-queue.js";
import { AuthAutoApproveManager } from "../../src/auth-auto-approve.js";
import {
  canonicalAuthMergeCommands,
  normalizeLegacySingleSourceMergeCommand,
} from "../../src/auth-context.js";
import { setDb, type Db } from "../../src/db.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { Router } from "../../src/server.js";
import { createLedgerIssue, createMigratedDb as createSharedMigratedDb } from "../helpers/ledger-fixtures.js";
import { authenticatedTestRouter } from "../helpers/authenticated-router.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { addCredential } from "../../src/users/store.js";

// Issue 08a5f04 — channel-server compatibility with approve-time canonical
// command enforcement:
//  - unit coverage for the legacy single-source normalizer and the fail-closed
//    hostile-HOME guard on the canonical command space;
//  - route-level integration: a channel-tool-shaped submission (legacy
//    command, no base_branch) is normalized to the canonical form at POST
//    submission and is approvable, while a non-normalizable mutant shape is
//    stored as-is and refused at approval.

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeLegacySingleSourceMergeCommand", () => {
  it("normalizes exactly the legacy single-source shape for the resolved head", () => {
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge feature/x", "feature/x", "main"),
    ).toBe("mandible auth merge feature/x --into main");
  });

  it("returns null for every non-matching shape", () => {
    const cases: Array<[string | null, string, string]> = [
      // Already canonical — nothing to normalize.
      ["mandible auth merge feature/x --into main", "feature/x", "main"],
      // Branch argument differs from the resolved head.
      ["mandible auth merge feature/other", "feature/x", "main"],
      // Extra flags / hierarchical / multi-source shapes.
      ["mandible auth merge feature/x --force", "feature/x", "main"],
      ["mandible auth merge --hierarchical feature/x", "feature/x", "main"],
      ["mandible auth merge feature/x feature/y", "feature/x", "main"],
      // Different prefix or trailing shell content.
      ["/usr/local/bin/mandible auth merge feature/x", "feature/x", "main"],
      ["mandible auth merge feature/x && echo pwned", "feature/x", "main"],
      [null, "feature/x", "main"],
    ];
    for (const [command, head, base] of cases) {
      expect(normalizeLegacySingleSourceMergeCommand(command, head, base)).toBeNull();
    }
  });

  it("refuses unsafe resolved branch names", () => {
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge x", "x", "main;rm -rf"),
    ).toBeNull();
    expect(
      normalizeLegacySingleSourceMergeCommand("mandible auth merge -evil", "-evil", "main"),
    ).toBeNull();
  });
});

describe("canonicalAuthMergeCommands hostile-HOME guard", () => {
  it("includes the absolute-prefix variants for a safe home path", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/Users/normal_user-1.2");
    const commands = canonicalAuthMergeCommands("feature/x", "main");
    expect(commands).toContain("mandible auth merge feature/x --into main");
    expect(commands).toContain(
      "/Users/normal_user-1.2/.dotfiles/bin/mandible auth merge feature/x --into main",
    );
    expect(commands).toHaveLength(4);
  });

  it("fails closed to the bare prefix when the home path carries hostile bytes", () => {
    const hostileHomes = [
      "/Users/evil user", // whitespace splits words under bash -c
      "/Users/evil$(touch pwned)", // command substitution
      "/Users/evil;rm -rf ~", // command separator
      "/Users/evil`id`", // backtick substitution
      "relative/home", // not absolute
      "/Users/../etc", // traversal
      "", // unset
    ];
    for (const home of hostileHomes) {
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const commands = canonicalAuthMergeCommands("feature/x", "main");
      expect(commands).toEqual([
        "mandible auth merge feature/x --into main",
        "mandible auth merge feature/x --into main --preserve-head-branch",
      ]);
      vi.restoreAllMocks();
    }
  });
});

// --- Route-level integration: tool submission → POST normalization → approval ---

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createMergeRepo(headBranches: string[]): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cmd-norm-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  for (const branch of headBranches) {
    git(repo, ["checkout", "-b", branch, "main"]);
    fs.writeFileSync(path.join(repo, `${branch.replace(/\//g, "_")}.txt`), `${branch}\n`);
    git(repo, ["add", "."]);
    // The auth gate requires Mandible-Issue trailers on non-merge commits.
    git(repo, ["commit", "-m", `work on ${branch}\n\nMandible-Issue: abc1234`]);
    git(repo, ["checkout", "main"]);
  }
  return fs.realpathSync(repo);
}

function createMigratedDb(): Db {
  return createSharedMigratedDb({
    operator: { slug: "cmd-norm-operator", display_name: "Cmd Norm Operator" },
    agent: {
      slug: "cmd-norm-agent",
      display_name: "Cmd Norm Agent",
      sessionEnv: "cmd-norm-session",
    },
  });
}

function registerWorkRepo(db: Db, repoRoot: string): string {
  const project = resolveProjectForCheckout(db, {
    root: fs.realpathSync(repoRoot),
    name: path.basename(repoRoot),
    workRepoId: path.basename(repoRoot),
    defaultBranch: "main",
  });
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(path.basename(repoRoot), repoRoot, path.basename(repoRoot), "main");
  return project.project.id;
}

function createHarness(db: Db, repoRoot: string, branch: string): { router: Router; queue: AuthQueue } {
  const agent = db.prepare("SELECT id, slug FROM users WHERE slug = 'cmd-norm-agent'").get() as { id: string; slug: string };
  const credential = addCredential(db, agent.id, {
    type: "api_token",
    fingerprint: `cmd-norm-${branch}`,
  });
  const projectId = registerWorkRepo(db, repoRoot);
  const issue = createLedgerIssue(db, {
    project_id: projectId,
    title: "Command normalization delivery",
    aliases: [{ alias_kind: "git_bug_short", alias: "abc1234" }],
  });
  db.prepare(
    `INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, activated_at, last_commit_at,
       ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
     VALUES (?, ?, ?, ?, 'solo', 'committed', 1, 1, 1, ?, ?, ?, 1)`,
  ).run(`wu-${branch}`, "abc1234", projectId, branch, issue.id, agent.id, credential.id);
  const router = authenticatedTestRouter(agent, { credentialId: credential.id });
  const queue = new AuthQueue({
    db,
    executor: async () => ({
      exit_code: 1,
      signal: null,
      stdout: "",
      stderr: "fixture stop\n",
      output: "fixture stop\n",
      started_at: Date.now(),
      finished_at: Date.now(),
    }),
    hookManager: createNoopHookManager(),
  });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
  return { router, queue };
}

async function waitForTerminalStatus(queue: AuthQueue, id: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = queue.getRequest(id)?.status;
    if (status && status !== "executing" && status !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for terminal auth request status");
}

describe("legacy channel merge submissions (issue 08a5f04)", () => {
  it("normalizes the channel-tool legacy shape at POST and accepts it at approval", async () => {
    const repo = createMergeRepo(["feature/channel-legacy"]);
    const db = createMigratedDb();
    setDb(db);
    const { router, queue } = createHarness(db, repo, "feature/channel-legacy");
    try {

      // Exactly what the channel tool submits when it cannot resolve the base
      // pre-submission: legacy single-source command, no base_branch.
      const result = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: "mandible auth merge feature/channel-legacy",
          title: "Merge feature/channel-legacy",
          head_branch: "feature/channel-legacy",
          cwd: repo,
          session_id: "cmd-norm-session",
          issue_references: ["abc1234"],
        },
      });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const requestId = (result.body as { request_id: string }).request_id;

      // The reviewed row is already canonical: base resolved server-side and
      // the stored command rewritten at submission, never at approval.
      const stored = queue.getRequest(requestId);
      expect(stored?.base_branch).toBe("main");
      expect(stored?.command).toBe("mandible auth merge feature/channel-legacy --into main");

      // Approve-time canonical enforcement accepts the normalized row.
      const approved = await approveFixtureRequest(queue, requestId);
      expect(approved.status).toBe("executing");
      await waitForTerminalStatus(queue, requestId);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("accepts the canonical form the updated channel tool emits end-to-end", async () => {
    const repo = createMergeRepo(["feature/channel-canonical"]);
    const db = createMigratedDb();
    setDb(db);
    const { router, queue } = createHarness(db, repo, "feature/channel-canonical");
    try {

      const result = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: "mandible auth merge feature/channel-canonical --into main",
          title: "Merge feature/channel-canonical",
          head_branch: "feature/channel-canonical",
          base_branch: "main",
          cwd: repo,
          session_id: "cmd-norm-session",
          issue_references: ["abc1234"],
        },
      });
      expect(result.status).toBe(201);
      const requestId = (result.body as { request_id: string }).request_id;

      const stored = queue.getRequest(requestId);
      expect(stored?.command).toBe(
        "mandible auth merge feature/channel-canonical --into main",
      );
      expect((await approveFixtureRequest(queue, requestId)).status).toBe("executing");
      await waitForTerminalStatus(queue, requestId);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("stores a non-normalizable mutant shape as-is and refuses it at approval", async () => {
    const repo = createMergeRepo(["feature/channel-mutant"]);
    const db = createMigratedDb();
    setDb(db);
    const { router, queue } = createHarness(db, repo, "feature/channel-mutant");
    try {

      const mutant = "mandible auth merge feature/channel-mutant --force";
      const result = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: mutant,
          title: "Merge feature/channel-mutant",
          head_branch: "feature/channel-mutant",
          base_branch: "main",
          cwd: repo,
          session_id: "cmd-norm-session",
          issue_references: ["abc1234"],
        },
      });
      expect(result.status).toBe(201);
      const requestId = (result.body as { request_id: string }).request_id;

      // Not the exact legacy single-source shape → stored untouched.
      expect(queue.getRequest(requestId)?.command).toBe(mutant);

      // ...and refused by approve-time canonical enforcement.
      await expect(approveFixtureRequest(queue, requestId)).rejects.toThrow(/does not match the canonical form/);
      let code: string | null = null;
      try {
        await approveFixtureRequest(queue, requestId);
      } catch (error) {
        code = error instanceof AuthQueueError ? error.code : null;
      }
      expect(code).toBe("invalid_command");
      expect(queue.getRequest(requestId)?.status).toBe("pending");
    } finally {
      queue.dispose();
      db.close();
    }
  });
});
