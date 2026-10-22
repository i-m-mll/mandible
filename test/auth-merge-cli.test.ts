import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { registerTrashRoutes } from "../src/routes/trash.js";
import { Router } from "../src/server.js";
import { qualifiedRuntimeFixtureEnv } from "./helpers/runtime-fixture.js";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";

const fixtureRuntimeEnv = {
  MANDIBLE_RUNTIME: process.execPath,
  ...qualifiedRuntimeFixtureEnv(),
  GIT_OPTIONAL_LOCKS: "0",
};

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";
let server: http.Server | null = null;
let cleanupDb: Db | null = null;

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: homeDir,
      ...fixtureRuntimeEnv,
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      MANDIBLE_PORT: "9",
      ZELLIJ: "",
      TMUX: "",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: {
        HOME: homeDir,
        ...fixtureRuntimeEnv,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        MANDIBLE_PORT: "9",
        ZELLIJ: "",
        TMUX: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function listenForAuthCheck(
  check: Record<string, unknown> = {
    status: "clean",
    repo: "repo",
    base_branch: "main",
    head_branch: "feature/demo",
    checked_requests: 0,
    conflicts: [],
  },
): Promise<{ port: number; bodies: Record<string, unknown>[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/instance") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/auth/check") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ check }));
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({
        port: address.port,
        bodies,
        close: () => new Promise<void>((done, reject) => {
          server!.close((error) => (error ? reject(error) : done()));
          server = null;
        }),
      });
    });
  });
}

function git(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRepo(): void {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feature/demo"]);
  fs.writeFileSync(path.join(tempDir, "feature.txt"), "feature\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature"]);
  git(["checkout", "main"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-home-"));
  createRepo();
});

afterEach(async () => {
  cleanupDb?.close();
  cleanupDb = null;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth merge Mandible preflight", () => {

  it("aborts before dirty checks when git lock files are present", () => {
    const lockPath = path.join(tempDir, ".git", "index.lock");
    fs.writeFileSync(lockPath, "", "utf8");

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git lock file(s) are present before auth merge");
    expect(result.stderr).toContain(lockPath);
    expect(result.stderr).toContain("no owning process found");
    expect(result.stderr).toContain("Aborting before auth merge because git lock files are present");
    expect(result.stderr).not.toContain("Mandible merge preflight failed");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("fails closed when the reviewed target head is stale", async () => {
    const authCheck = await listenForAuthCheck();

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
      MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT: "1",
      MANDIBLE_AUTH_PREFLIGHT_BASE_SHA: "0000000000000000000000000000000000000000",
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(0);
    expect(result.stderr).toContain("Target main moved from reviewed base");
    expect(result.stderr).toContain("requeue and reapprove");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("preserves delegated signing git config overrides from the executor", async () => {
    const authCheck = await listenForAuthCheck();
    const baseSha = git(["rev-parse", "main"]);

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
      MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT: "1",
      MANDIBLE_AUTH_PREFLIGHT_BASE_SHA: baseSha,
      MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
      AUTH_MERGE_AUTO_CONFIRM: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "user.signingkey",
      GIT_CONFIG_VALUE_1: "/tmp/mandible-delegated.pub",
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(0);
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
    expect(result.stderr).not.toContain("No signing key configured");
    expect(result.stderr).toContain("checking signing configuration");
    expect(result.stderr).toContain("Reviewed base or head moved since auth submission");
  });

  it("blocks staged changes through Mandible auth check", async () => {
    const authCheck = await listenForAuthCheck({
      status: "error",
      repo: "repo",
      base_branch: "main",
      head_branch: "feature/demo",
      checked_requests: 0,
      conflicts: [],
      reason: "tracked worktree changes are present: staged.txt",
    });
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"]);

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(1);
    expect(result.stderr).toContain("tracked worktree changes are present: staged.txt");
    expect(result.stderr).toContain("Mandible merge preflight failed");
    expect(result.stderr).toContain("staged.txt");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("preserves interrupted legacy merge state", () => {
    git(["merge", "--no-ff", "--no-commit", "feature/demo"]);
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "unrelated local edit\n", "utf8");
    const before = git(["rev-parse", "main"]);
    const mergeHead = fs.readFileSync(path.join(tempDir, ".git", "MERGE_HEAD"), "utf8");
    const index = git(["write-tree"]);

    const result = run(["auth", "merge", "feature/demo"], tempDir, { MANDIBLE_AUTH_ATOMIC: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires operator recovery");
    expect(git(["rev-parse", "main"])).toBe(before);
    expect(git(["write-tree"])).toBe(index);
    expect(fs.readFileSync(path.join(tempDir, ".git", "MERGE_HEAD"), "utf8")).toBe(mergeHead);
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("unrelated local edit\n");
  });

});

// Child issue 8921e84: docs-branch promotion via a short-lived proxy branch.
// The post-merge worktree cleanup (cleanup_merged_worktrees) must never destroy
// the long-lived managed docs worktree. Promotion submits a disposable
// promote/docs/<ts> proxy branch; cleanup tears down only that proxy.
const AUTH_MERGE_SH = path.join(process.cwd(), "cli", "auth-merge.sh");

// Source auth-merge.sh (without running its main flow) and run one helper.
function runCleanupHelper(
  snippet: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const script = [
    "set -u",
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source ${JSON.stringify(AUTH_MERGE_SH)}`,
    snippet,
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      HOME: homeDir,
      ...fixtureRuntimeEnv,
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE_SH),
      MANDIBLE_AUTH_PROTECTED_BRANCHES: "main,develop",
      ZELLIJ: "",
      TMUX: "",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runCleanupHelperAsync(
  snippet: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const script = [
    "set -u",
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source ${JSON.stringify(AUTH_MERGE_SH)}`,
    snippet,
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      env: {
        HOME: homeDir,
        ...fixtureRuntimeEnv,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE_SH),
        MANDIBLE_AUTH_PROTECTED_BRANCHES: "main,develop",
        ZELLIJ: "",
        TMUX: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function provisionManagedDocsWorktree(branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, "_");
  const worktreeDir = path.join(tempDir, ".git", "mandible-docs-worktrees", safe);
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
  // Provision the docs branch + managed worktree the way the export backend does.
  git(["worktree", "add", "-b", branch, worktreeDir, "main"]);
  // A docs commit carrying the export-backend linked-commit trailer.
  fs.writeFileSync(path.join(worktreeDir, "doc.md"), "# doc\n", "utf8");
  git(["add", "doc.md"], worktreeDir);
  git(["commit", "-m", "doc export\n\nMandible-Issue: docs123"], worktreeDir);
  return worktreeDir;
}

describe("auth merge worktree cleanup preserves the docs branch", () => {
  it("tears down a promote/docs proxy worktree but leaves the docs worktree", async () => {
    const { port } = await listenForCleanup();
    const docsBranch = "docs/spaces";
    const docsWorktree = provisionManagedDocsWorktree(docsBranch);

    // Cut a disposable proxy branch + its own throwaway worktree from the docs head.
    const proxy = "promote/docs/20260101000000";
    const proxyWorktree = path.join(tempDir, "worktrees", "promote__docs__20260101000000");
    git(["worktree", "add", "-b", proxy, proxyWorktree, docsBranch]);

    expect(fs.existsSync(proxyWorktree)).toBe(true);
    expect(fs.existsSync(docsWorktree)).toBe(true);

    const result = await runCleanupHelperAsync(
      `cleanup_merged_worktrees ${JSON.stringify(proxy)} 0 ${JSON.stringify(docsBranch)}`,
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(result.status).toBe(0);

    // The disposable proxy worktree is gone through the trash service.
    expect(fs.existsSync(proxyWorktree)).toBe(false);
    const proxyRegistered = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: tempDir,
      encoding: "utf8",
    }).stdout;
    expect(proxyRegistered).not.toContain(proxyWorktree);

    // The long-lived docs branch + managed worktree survive untouched.
    expect(fs.existsSync(docsWorktree)).toBe(true);
    const docsExists = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${docsBranch}`],
      { cwd: tempDir },
    ).status;
    expect(docsExists).toBe(0);
  });

  it("refuses to tear down the managed docs worktree even on a direct docs-branch merge", () => {
    const docsBranch = "docs/spaces";
    const docsWorktree = provisionManagedDocsWorktree(docsBranch);

    const result = runCleanupHelper(
      `cleanup_merged_worktrees ${JSON.stringify(docsBranch)} 0`,
      tempDir,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Refusing to tear down managed docs worktree");

    // Docs branch + managed worktree must still be present.
    expect(fs.existsSync(docsWorktree)).toBe(true);
    const docsExists = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${docsBranch}`],
      { cwd: tempDir },
    ).status;
    expect(docsExists).toBe(0);
  });

});

function listenForCleanup(options: {
  canonicalProject?: boolean;
  trashPartialFailure?: boolean;
  workUnits?: Array<Record<string, unknown>>;
} = {}): Promise<{
  port: number;
  requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }>;
}> {
  const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
  cleanupDb = openDb(path.join(homeDir, "mandible.db"));
  addProject(cleanupDb, { project_key: "canonical-mandible", display_name: "Cleanup Test" }, 1);
  addOrUpdateCheckout(cleanupDb, "canonical-mandible", {
    root: fs.realpathSync(tempDir),
    name: "repo",
    default_branch: "main",
  }, 2);
  const trashRouter = new Router();
  registerTrashRoutes(trashRouter, cleanupDb);
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      } else if (req.method === "GET" && req.url?.startsWith("/api/projects/")) {
        if (options.canonicalProject === false) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: "ambiguous project" }));
        } else {
          res.end(JSON.stringify({ project: { project_key: "canonical-mandible" } }));
        }
      } else if (req.method === "POST" && req.url === "/api/v1/trash") {
        if (options.trashPartialFailure) {
          res.statusCode = 409;
          res.end(JSON.stringify({
            error: "snapshot is safe but local removal failed",
            code: "remove_failed",
            detail: {
              id: "trash-auth",
              outcome: {
                worktree_removed: true,
                branch_removed: false,
                worktree_path: "/reported/worktree/feature__dirty",
              },
            },
          }));
          return;
        }
        const answer = await trashRouter.invoke({
          method: "POST",
          url: req.url,
          body: raw ? JSON.parse(raw) : null,
        });
        res.statusCode = answer.status;
        res.end(JSON.stringify(answer.body));
      } else if (req.method === "GET" && req.url?.startsWith("/api/work-units?")) {
        res.end(JSON.stringify({ work_units: options.workUnits ?? [{ branch: "feature/sibling" }] }));
      } else if (req.method === "POST" && req.url === "/api/work-units/release") {
        res.end(JSON.stringify({ ok: true, released: 1, unchanged: false }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("cleanup server did not bind");
      resolve({ port: address.port, requests });
    });
  });
}

function createFeatureWorktree(branch: string): string {
  const safe = branch.replace(/\//g, "__");
  const worktree = path.join(tempDir, "worktrees", safe);
  git(["worktree", "add", "-b", branch, worktree, "main"]);
  return worktree;
}

function commitFile(worktree: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(worktree, filename), content, "utf8");
  git(["add", filename], worktree);
  git(["commit", "-m", `add ${filename}`], worktree);
}

describe("auth merge reversible cleanup", () => {

  it("sends a dirty merged worktree through daemon trash custody", async () => {
    const { port, requests } = await listenForCleanup();
    const branch = "feature/dirty";
    const worktree = createFeatureWorktree(branch);
    commitFile(worktree, "dirty.txt", "committed\n");
    git(["merge", "--no-ff", "--no-edit", branch], tempDir);
    fs.writeFileSync(path.join(worktree, "residue.sqlite"), "untracked fixture residue\n", "utf8");

    const result = await runCleanupHelperAsync(
      `cleanup_merged_worktrees ${JSON.stringify(branch)} 0 main abc123`,
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("trashed merged branch feature/dirty");
    expect(result.stderr).toContain("worktrees/feature__dirty is gone");
    expect(fs.existsSync(worktree)).toBe(false);
    const snapshotRef = git(["for-each-ref", "--format=%(refname)", "refs/mandible/trash/"], tempDir);
    expect(git(["show", `${snapshotRef}:residue.sqlite`], tempDir)).toBe("untracked fixture residue");
    expect(result.stderr).toContain("No further work may happen there");
    expect(requests.find((request) => request.url === "/api/v1/trash")?.body).toMatchObject({
      branch,
      reason: "merged",
      actor: "auth-merge",
      merged_into: "main",
      issue_refs: ["abc123"],
      checkout_root: git(["rev-parse", "--show-toplevel"], tempDir),
    });
  });

  it("releases the exact work unit of a merged worktree with its observed generation", async () => {
    const branch = "feature/released";
    const { port, requests } = await listenForCleanup({
      workUnits: [{ id: "wu-released", branch, state: "committed", custody_generation: 3, auth_request_id: null }],
    });
    const worktree = createFeatureWorktree(branch);
    commitFile(worktree, "released.txt", "released\n");
    git(["merge", "--no-ff", "--no-edit", branch], tempDir);
    fs.appendFileSync(path.join(tempDir, ".git", "info", "exclude"), ".issue\n", "utf8");
    fs.writeFileSync(path.join(worktree, ".issue"), "cd64f1a\n", "utf8");

    const result = await runCleanupHelperAsync(
      `cleanup_merged_worktrees ${JSON.stringify(branch)} 0 main`,
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(result.status).toBe(0);
    expect(requests.some((request) => (
      request.method === "GET" && request.url?.includes(`branch=${encodeURIComponent(branch)}`)
    ))).toBe(true);
    expect(requests.filter((request) => request.url === "/api/work-units/release").map((request) => request.body))
      .toEqual([{ id: "wu-released", expected_generation: 3 }]);
    expect(result.stderr).toContain("note: released work unit for feature/released");
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it("preserves sibling candidates when canonical project identity cannot be resolved", async () => {
    const { port, requests } = await listenForCleanup({ canonicalProject: false });
    const sibling = "feature/sibling-preserved";
    const worktree = createFeatureWorktree(sibling);
    commitFile(worktree, "preserved.txt", "preserved\n");
    git(["merge", "--no-ff", "--no-edit", sibling], tempDir);

    const result = await runCleanupHelperAsync(
      "cleanup_merged_worktrees feature/missing-head 0 main abc123",
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Preserved sibling work-unit branches");
    expect(result.stderr).toContain("canonical project identity could not be resolved uniquely");
    expect(fs.existsSync(worktree)).toBe(true);
    expect(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${sibling}`], { cwd: tempDir }).status)
      .toBe(0);
    expect(requests.some((request) => request.url?.startsWith("/api/projects/"))).toBe(true);
    expect(requests.some((request) => request.url?.startsWith("/api/work-units?"))).toBe(false);
  });

  it("preserves protected, app-managed, and git-ambiguous candidates", async () => {
    const appBranch = "feature/app-managed";
    const appWorktree = path.join(tempDir, ".codex", "worktrees", "app-managed");
    fs.mkdirSync(path.dirname(appWorktree), { recursive: true });
    git(["worktree", "add", "-b", appBranch, appWorktree, "main"]);
    commitFile(appWorktree, "app.txt", "app\n");
    git(["merge", "--no-ff", "--no-edit", appBranch], tempDir);

    const appResult = runCleanupHelper(
      `cleanup_merged_worktrees ${JSON.stringify(appBranch)} 0 main`,
      tempDir,
    );
    expect(appResult.stderr).toContain("preserved feature/app-managed: app-managed worktree");
    expect(fs.existsSync(appWorktree)).toBe(true);

    git(["branch", "release"], tempDir);
    const protectedResult = runCleanupHelper("cleanup_merged_worktrees release 0 main", tempDir, {
      MANDIBLE_AUTH_PROTECTED_BRANCHES: "main,develop,release",
    });
    expect(protectedResult.stderr).toContain("preserved release: configured protected branch");
    expect(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/release"], { cwd: tempDir }).status).toBe(0);

    const ambiguous = "feature/not-merged";
    const ambiguousWorktree = createFeatureWorktree(ambiguous);
    commitFile(ambiguousWorktree, "ambiguous.txt", "unique\n");
    const { port } = await listenForCleanup();
    const ambiguousResult = await runCleanupHelperAsync(
      `cleanup_merged_worktrees ${JSON.stringify(ambiguous)} 0 main`,
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(ambiguousResult.stderr).toContain("cannot prove merged or patch-equivalent");
    expect(fs.existsSync(ambiguousWorktree)).toBe(true);
  });

  it("preserves merge-only tree changes that git cherry cannot see", async () => {
    const { port } = await listenForCleanup();
    const feature = "feature/merge-only";
    const featureWorktree = createFeatureWorktree(feature);
    const side = "feature/merge-side";
    const sideWorktree = createFeatureWorktree(side);
    // The fixture needs main's cherry-pick to reproduce the *identical* commit
    // object, so `git cherry` reports nothing at all. Without pinned dates the
    // two commits only match when they happen to land in the same wall-clock
    // second, which makes this test fail whenever the run's timing shifts.
    const fixedDates = {
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
    };
    fs.writeFileSync(path.join(sideWorktree, "side.txt"), "shared side change\n", "utf8");
    git(["add", "side.txt"], sideWorktree);
    git(["commit", "-m", "add side.txt"], sideWorktree, fixedDates);
    git(["cherry-pick", side], tempDir, fixedDates);

    git(["merge", "--no-ff", "--no-commit", side], featureWorktree);
    fs.writeFileSync(path.join(featureWorktree, "merge-only.txt"), "unique merge resolution\n", "utf8");
    git(["add", "merge-only.txt"], featureWorktree);
    git(["commit", "-m", "merge with unique tree bytes"], featureWorktree);

    expect(git(["cherry", "main", feature], tempDir)).toBe("");
    const result = await runCleanupHelperAsync(
      `cleanup_merged_worktrees ${JSON.stringify(feature)} 0 main`,
      tempDir,
      { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("cannot prove merged or patch-equivalent");
    expect(fs.existsSync(featureWorktree)).toBe(true);
    expect(git(["show", `${feature}:merge-only.txt`], tempDir)).toBe("unique merge resolution");
  });

});
