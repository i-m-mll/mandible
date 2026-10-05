// Quarantined: e9cd064 — registerAuthRoutes opens the production database.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../../src/auth-queue.js";
import { AuthAutoApproveManager } from "../../src/auth-auto-approve.js";
import { configureDaemonLogger, flushDaemonLogger } from "../../src/daemon-log.js";
import { migrate } from "../../src/db.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { createServer, Router } from "../../src/server.js";
import { SseManager } from "../../src/sse.js";
import { setupOperator } from "../../src/users/store.js";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");

let repo = "";
let key = "";

function git(args: string[], cwd = repo, env: Record<string, string> = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function write(name: string, content: string): void {
  const target = path.join(repo, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(message: string): string {
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

function candidate(base: string, head: string, requestId = "atomic-test"): {
  tree: string;
  pin: string;
  ref: string;
} {
  const tree = git(["merge-tree", "--write-tree", base, head]).split(/\s+/)[0]!;
  const pin = git(
    ["commit-tree", tree, "-p", base, "-p", head, "-m", `mandible auth candidate pin ${requestId}`],
    repo,
    {
      GIT_AUTHOR_NAME: "Mandible",
      GIT_AUTHOR_EMAIL: "mandible@localhost",
      GIT_COMMITTER_NAME: "Mandible",
      GIT_COMMITTER_EMAIL: "mandible@localhost",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:00 +0000",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:00 +0000",
    },
  );
  const ref = `refs/mandible/auth-candidates/${requestId}`;
  git(["update-ref", ref, pin]);
  return { tree, pin, ref };
}

function allowedSigner(keyPath = key, principal = "credential-test"): string {
  return `${principal} ${fs.readFileSync(`${keyPath}.pub`, "utf8").trim()}`;
}

function runAtomicAsync(
  base: string,
  head: string,
  cached: { tree: string; pin: string; ref: string },
  extraEnv: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const snippet = [
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source ${JSON.stringify(AUTH_MERGE)}`,
    "prompt_confirm() { printf 'y'; }",
    "run_merge_preflight() { :; }",
    "cleanup_merged_worktrees() { :; }",
    "collect_declared_issues() { :; }",
    "main feature/atomic --into main",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", snippet], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE),
        MANDIBLE_AUTH_ATOMIC: "1",
        MANDIBLE_AUTH_REQUEST_ID: "atomic-test",
        MANDIBLE_AUTH_CANDIDATE_TREE_SHA: cached.tree,
        MANDIBLE_AUTH_CANDIDATE_PIN_SHA: cached.pin,
        MANDIBLE_AUTH_CANDIDATE_BASE_SHA: base,
        MANDIBLE_AUTH_CANDIDATE_HEAD_SHA: head,
        MANDIBLE_AUTH_CANDIDATE_REF: cached.ref,
        MANDIBLE_AUTH_ALLOWED_SIGNERS: allowedSigner(),
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-atomic-"));
  key = path.join(repo, "signing-key");
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Atomic Test"]);
  git(["config", "user.email", "atomic@example.invalid"]);
  git(["config", "gpg.format", "ssh"]);
  git(["config", "commit.gpgsign", "true"]);
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
    encoding: "utf8",
  });
  if (keygen.status !== 0) throw new Error(keygen.stderr);
  git(["config", "user.signingkey", key]);
  write("base.txt", "base\n");
  commit("base");
  git(["checkout", "-b", "feature/atomic"]);
  write("feature.txt", "feature\n");
  commit("feature");
  git(["checkout", "main"]);
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("atomic auth merge", () => {

  it("durably checkpoints PREPARED and APPLIED through the real output endpoint", async () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    const db = new SqliteDatabase(":memory:");
    migrate(db);
    setupOperator(db, { slug: "atomic-endpoint", display_name: "Atomic Endpoint" });
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    const request = queue.submit({ command: "echo checkpoint", title: "Atomic checkpoint" });
    // Issue 08a5f04 (review F1) — the output endpoint is lifecycle-locked to
    // executing requests; the real merge posts its checkpoints mid-execution.
    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(request.id);
    const router = new Router();
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
    const server = createServer({
      db,
      sse: new SseManager(),
      logger: configureDaemonLogger(db),
      version: "test",
      router,
      getStartupInfo: () => null,
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    try {
      const result = await runAtomicAsync(base, head, cached, {
        MANDIBLE_AUTH_REQUEST_ID: request.id,
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      });
      expect(result.status).toBe(0);
      const output = queue.getRequest(request.id)?.output ?? "";
      expect(output).toContain("MANDIBLE_MERGE_PREPARED");
      expect(output).toContain("MANDIBLE_MERGE_APPLIED");
      expect(output.indexOf("MANDIBLE_MERGE_PREPARED")).toBeLessThan(
        output.indexOf("MANDIBLE_MERGE_APPLIED"),
      );
      expect(git(["rev-parse", "main"])).not.toBe(base);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      queue.dispose();
      flushDaemonLogger();
      db.close();
    }
  });

  // Issue 08a5f04 (review F3) — the daemon passes the reviewed head SHA as
  // MANDIBLE_AUTH_EXPECTED_HEAD_SHA on every daemon-started merge; the
  // non-atomic path verifies the live source against it and merges the exact
  // reviewed object.
  function runNonAtomic(
    extraEnv: Record<string, string> = {},
    mainArgs = "feature/atomic --into main",
  ): ReturnType<typeof spawnSync> {
    const snippet = [
      "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
      `source ${JSON.stringify(AUTH_MERGE)}`,
      "prompt_confirm() { printf 'y'; }",
      "run_merge_preflight() { :; }",
      "cleanup_merged_worktrees() { :; }",
      "collect_declared_issues() { :; }",
      `main ${mainArgs}`,
    ].join("\n");
    return spawnSync("bash", ["-c", snippet], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE),
        MANDIBLE_AUTH_REQUEST_ID: "nonatomic-test",
        ...extraEnv,
      },
    });
  }

  // Issue 060c9c8 — hierarchical merge support was removed from the executor:
  // the historical `--hierarchical` invocation is now an unknown option and
  // must exit before any merge work touches the repo.

  // Issue 060c9c8 — multiple positional sources are likewise no longer a
  // supported shape; the executor exits with usage before any merge work.

});
