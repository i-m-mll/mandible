import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthQueue } from "../src/auth-queue.js";
import { extractAtomicMergeState } from "../src/auth-signature-verification.js";
import { configureDaemonLogger, flushDaemonLogger } from "../src/daemon-log.js";
import { resetDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { setupOperator } from "../src/users/store.js";
import { createAuthCheckRepo, commitOnBranch } from "./helpers/auth-queue-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { preparedGitFixture } from "./helpers/prepared-git-fixture.js";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");

it("persists independently parseable prepared and applied checkpoint lines", () => {
  const prepared = { merge_sha: "a".repeat(40), base_sha: "b".repeat(40), head_sha: "c".repeat(40), tree_sha: "d".repeat(40) };
  const applied = { merge_sha: prepared.merge_sha, base_sha: prepared.base_sha };
  const result = spawnSync("bash", ["-c", [
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1 MANDIBLE_AUTH_REQUEST_ID=checkpoint-test",
    'source "$MANDIBLE_TEST_AUTH_MERGE"',
    'auth_merge_http_request() { printf \'%s\\n\' "$3" >> "$MANDIBLE_TEST_CHECKPOINTS"; }',
    'persist_atomic_marker "$MANDIBLE_TEST_PREPARED"',
    'persist_atomic_marker "$MANDIBLE_TEST_APPLIED"',
  ].join("\n")], {
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_TEST_AUTH_MERGE: AUTH_MERGE,
      MANDIBLE_TEST_CHECKPOINTS: path.join(repo, "checkpoints.jsonl"),
      MANDIBLE_TEST_PREPARED: `MANDIBLE_MERGE_PREPARED ${JSON.stringify(prepared)}`,
      MANDIBLE_TEST_APPLIED: `MANDIBLE_MERGE_APPLIED ${JSON.stringify(applied)}` },
  });
  expect(result.status, result.stderr).toBe(0);
  const chunks = fs.readFileSync(path.join(repo, "checkpoints.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line).chunk as string);
  expect(extractAtomicMergeState(chunks.join(""))).toEqual({ prepared, applied, invalid: false });
});

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

function atomicInvocation(
  base: string,
  head: string,
  cached: { tree: string; pin: string; ref: string },
  extraEnv: Record<string, string>,
  stubCheckpoint: boolean,
): { args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } } {
  const snippet = [
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source ${JSON.stringify(AUTH_MERGE)}`,
    "prompt_confirm() { printf 'y'; }",
    "run_merge_preflight() { :; }",
    ...(stubCheckpoint ? ["persist_atomic_marker() { printf '%s\\n' \"$1\" >&2; }"] : []),
    "cleanup_merged_worktrees() { :; }",
    "collect_declared_issues() { :; }",
    "main feature/atomic --into main",
  ].join("\n");
  return {
    args: ["-c", snippet],
    options: {
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
    },
  };
}

function runAtomic(
  base: string,
  head: string,
  cached: { tree: string; pin: string; ref: string },
  extraEnv: Record<string, string> = {},
  stubCheckpoint = true,
): ReturnType<typeof spawnSync> {
  const { args, options } = atomicInvocation(base, head, cached, extraEnv, stubCheckpoint);
  return spawnSync("bash", args, { ...options, encoding: "utf8" });
}

/** For a run whose checkpoints reach a server on this process's event loop. */
function runAtomicAsync(
  base: string,
  head: string,
  cached: { tree: string; pin: string; ref: string },
  extraEnv: Record<string, string>,
): Promise<{ status: number | null; stderr: string }> {
  const { args, options } = atomicInvocation(base, head, cached, extraEnv, false);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", args, options);
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

const atomicRepo = preparedGitFixture("auth-atomic", (root) => {
  const repo = createAuthCheckRepo();
  const key = path.join(repo, ".git", "signing-key");
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
    encoding: "utf8", timeout: 5_000,
  });
  if (keygen.status !== 0) throw new Error(keygen.stderr);
  commitOnBranch(repo, "feature/atomic", { "feature.txt": "feature\n" });
  fs.appendFileSync(path.join(repo, ".git", "config"), "\n[gpg]\n format = ssh\n[commit]\n gpgsign = true\n");
  fs.cpSync(repo, root, { recursive: true });
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-atomic-"));
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("atomic auth merge", () => {
  beforeEach(() => {
    atomicRepo.copyInto(repo);
    key = path.join(repo, ".git", "signing-key");
    fs.appendFileSync(path.join(repo, ".git", "config"), `\n[user]\n signingkey = ${JSON.stringify(key)}\n`);
  });

  it("creates the exact trusted merge commit, CAS-updates, safely syncs, and preserves untracked files", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    write("scratch.txt", "keep\n");

    const result = runAtomic(base, head, cached);

    expect(result.status).toBe(0);
    const merged = git(["rev-parse", "main"]);
    expect(git(["show", "-s", "--format=%P", merged])).toBe(`${base} ${head}`);
    expect(git(["rev-parse", `${merged}^{tree}`])).toBe(cached.tree);
    expect(git(["show", "-s", "--format=%B", merged])).toBe("Merge branch 'feature/atomic'");
    expect(git(["status", "--porcelain", "--untracked-files=no"])).toBe("");
    expect(fs.readFileSync(path.join(repo, "scratch.txt"), "utf8")).toBe("keep\n");
    expect(result.stderr).toContain("Good \"git\" signature");
    expect(result.stderr.indexOf("MANDIBLE_MERGE_PREPARED")).toBeLessThan(
      result.stderr.indexOf("MANDIBLE_MERGE_APPLIED"),
    );
    expect(result.stderr).toContain("MANDIBLE_MERGE_RESULT");
  });

  it("preserves protected ref, index, files, and merge state when signing fails or is cancelled", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    const index = git(["write-tree"]);
    const contents = fs.readFileSync(path.join(repo, "shared.txt"), "utf8");
    const signer = path.join(repo, "cancelled-signer");
    fs.writeFileSync(signer, "#!/bin/sh\necho 'signing cancelled' >&2\nexit 130\n", { mode: 0o755 });
    git(["config", "gpg.ssh.program", signer]);
    const result = runAtomic(base, head, cached);
    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(git(["write-tree"])).toBe(index);
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(contents);
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(result.stderr).not.toContain("MANDIBLE_MERGE_PREPARED");
  });

  it("durably checkpoints PREPARED and APPLIED through the real output endpoint", async () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    const db = migratedMemoryDb();
    setupOperator(db, { slug: "atomic-endpoint", display_name: "Atomic Endpoint" });
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  command: "echo checkpoint", title: "Atomic checkpoint" }));
    // Issue 08a5f04 (review F1) — the output endpoint is lifecycle-locked to
    // executing requests; the real merge posts its checkpoints mid-execution.
    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(request.id);
    const router = new Router();
    // Issue e9cd064 — routes bound to the queue's database never reach the singleton.
    resetDb({ reason: "auth routes must use the queue's database" });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
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
      expect(result.status, result.stderr).toBe(0);
      const output = (await queue.getRequest(request.id))?.output ?? "";
      expect(output).toContain("MANDIBLE_MERGE_PREPARED");
      expect(output).toContain("MANDIBLE_MERGE_APPLIED");
      expect(output.indexOf("MANDIBLE_MERGE_PREPARED")).toBeLessThan(
        output.indexOf("MANDIBLE_MERGE_APPLIED"),
      );
      expect(git(["rev-parse", "main"])).not.toBe(base);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (await queue.dispose());
      flushDaemonLogger();
      db.close();
    }
  });

  it("does not move the target when the durable checkpoint endpoint is unreachable", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);

    const result = runAtomic(base, head, cached, {
      MANDIBLE_AUTH_REQUEST_ID: "unreachable-checkpoint",
      MANDIBLE_BASE: "http://127.0.0.1:1",
    }, false);

    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).toContain("Could not durably record the prepared merge commit");
  });

  it("rejects an unauthorized signer before CAS and leaves the worktree untouched", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    const other = path.join(repo, "other-key");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);

    const result = runAtomic(base, head, cached, {
      MANDIBLE_AUTH_ALLOWED_SIGNERS: allowedSigner(other, "other-credential"),
    });

    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(git(["status", "--porcelain", "--untracked-files=no"])).toBe("");
    expect(result.stderr).toContain("not trusted for the approving user");
  });

  it("ignores a repository-provided ssh verifier program during the trust gate", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    const fakeVerifier = path.join(repo, "fake-verifier");
    fs.writeFileSync(fakeVerifier, [
      "#!/bin/sh",
      "case \" $* \" in *\" -Y verify \"*) exit 0 ;; esac",
      "exec /usr/bin/ssh-keygen \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });
    git(["config", "gpg.ssh.program", fakeVerifier]);
    const other = path.join(repo, "other-key");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);

    const result = runAtomic(base, head, cached, {
      MANDIBLE_AUTH_ALLOWED_SIGNERS: allowedSigner(other, "other-credential"),
    });

    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).toContain("not trusted for the approving user");
  });

  it("rejects reviewed-head drift before signing or ref mutation", () => {
    const base = git(["rev-parse", "main"]);
    const reviewedHead = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, reviewedHead);
    git(["checkout", "feature/atomic"]);
    write("moved.txt", "moved\n");
    commit("move head");
    git(["checkout", "main"]);

    const result = runAtomic(base, reviewedHead, cached);

    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).toContain("moved since auth submission");
  });

  it("rejects a missing retained pin with otherwise unchanged reviewed inputs", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    git(["update-ref", "-d", cached.ref, cached.pin]);

    const result = runAtomic(base, head, cached);

    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).toContain("stale or unavailable");
    expect(result.stderr).not.toContain("MANDIBLE_MERGE_PREPARED");
  });

  it("leaves an untracked collision intact and reports applied-needs-recovery after CAS", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    write("feature.txt", "local collision\n");

    const result = runAtomic(base, head, cached);

    expect(result.status).toBe(75);
    expect(git(["rev-parse", "main"])).not.toBe(base);
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8")).toBe("local collision\n");
    expect(result.stderr).toContain("MANDIBLE_MERGE_APPLIED");
    expect(result.stderr).toContain("recovery is required");
  });

  it("refuses a CAS race without applying the signed candidate", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const cached = candidate(base, head);
    git(["checkout", "-b", "race", "main"]);
    write("race.txt", "race\n");
    const raceSha = commit("race");
    git(["checkout", "main"]);
    const realGit = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-atomic-race-"));
    const marker = path.join(fakeBin, "raced");
    const wrapper = path.join(fakeBin, "git");
    fs.writeFileSync(wrapper, [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == update-ref && \"$*\" == *\"refs/heads/main\"* && ! -e \"$MANDIBLE_RACE_MARKER\" ]]; then",
      "  : > \"$MANDIBLE_RACE_MARKER\"",
      "  \"$MANDIBLE_REAL_GIT\" update-ref refs/heads/main \"$MANDIBLE_RACE_SHA\" \"$MANDIBLE_RACE_BASE\"",
      "fi",
      "exec \"$MANDIBLE_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });

    try {
      const result = runAtomic(base, head, cached, {
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        MANDIBLE_REAL_GIT: realGit,
        MANDIBLE_RACE_MARKER: marker,
        MANDIBLE_RACE_SHA: raceSha,
        MANDIBLE_RACE_BASE: base,
      });
      expect(result.status).not.toBe(0);
      expect(git(["rev-parse", "main"])).toBe(raceSha);
      expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
      expect(result.stderr).toContain("compare-and-swap refused");
      expect(result.stderr).toContain("MANDIBLE_MERGE_PREPARED");
      expect(result.stderr).not.toContain("MANDIBLE_MERGE_APPLIED");
      expect(result.stderr).not.toContain("MANDIBLE_MERGE_RESULT");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses direct execution before signing or protected state changes", () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);
    const index = git(["write-tree"]);
    const result = runAtomic(base, head, candidate(base, head), { MANDIBLE_AUTH_ATOMIC: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reviewed signed candidate");
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(git(["write-tree"])).toBe(index);
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

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
  it("refuses the removed --hierarchical flag as an unknown option", () => {
    const base = git(["rev-parse", "main"]);

    const result = runNonAtomic({}, "--hierarchical feature/atomic --into main");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option: --hierarchical");
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).not.toContain("MANDIBLE_MERGE_RESULT");
  });

  // Issue 060c9c8 — multiple positional sources are likewise no longer a
  // supported shape; the executor exits with usage before any merge work.
  it("refuses multiple source branches with a usage error", () => {
    const base = git(["rev-parse", "main"]);

    const result = runNonAtomic({}, "feature/atomic feature/other --into main");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(git(["rev-parse", "main"])).toBe(base);
    expect(result.stderr).not.toContain("MANDIBLE_MERGE_RESULT");
  });
});

describe("SHA-256 atomic auth merge", () => {
  it("accepts SHA-256 repository object ids", () => {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-atomic-sha256-"));
    key = path.join(repo, "signing-key");
    git(["init", "--object-format=sha256", "-b", "main"]);
    git(["config", "user.name", "Atomic Test"]);
    git(["config", "user.email", "atomic@example.invalid"]);
    git(["config", "gpg.format", "ssh"]);
    git(["config", "user.signingkey", key]);
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    write("base.txt", "base\n");
    commit("base");
    git(["checkout", "-b", "feature/atomic"]);
    write("feature.txt", "feature\n");
    commit("feature");
    git(["checkout", "main"]);
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/atomic"]);

    const result = runAtomic(base, head, candidate(base, head));

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).toBe(0);
    expect(git(["rev-parse", "main"])).toMatch(/^[0-9a-f]{64}$/);
  });
});
