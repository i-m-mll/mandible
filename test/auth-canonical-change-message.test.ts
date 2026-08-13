import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalizeChangeMessage,
  changeMessageDigest,
} from "../src/auth-change-message.js";
import { AuthQueue } from "../src/auth-queue.js";
import { migrate } from "../src/db.js";
import { setupOperator } from "../src/users/store.js";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");
const CLI = path.join(process.cwd(), "bin", "mandible");

let repo = "";
let homeDir = "";
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

function candidate(base: string, head: string, requestId: string): {
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

function allowedSigner(): string {
  return `credential-test ${fs.readFileSync(`${key}.pub`, "utf8").trim()}`;
}

/** A stub of `GET /api/auth/request/:id` returning one fixed request body. */
async function serveRequest(
  body: Record<string, unknown>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/auth/request/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server did not bind");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Always spawn asynchronously when a test's own HTTP stub must answer: the
 * stub runs on this process's event loop, and spawnSync would block it until
 * the child's request had already timed out.
 */
function runAsync(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runMerge(
  extraEnv: Record<string, string>,
  atomic: { base: string; head: string; cached: ReturnType<typeof candidate> } | null,
): Promise<ProcResult> {
  const snippet = [
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source ${JSON.stringify(AUTH_MERGE)}`,
    "prompt_confirm() { printf 'y'; }",
    "run_merge_preflight() { :; }",
    "persist_atomic_marker() { printf '%s\\n' \"$1\" >&2; }",
    "cleanup_merged_worktrees() { :; }",
    "collect_declared_issues() { :; }",
    "main feature/canonical --into main",
  ].join("\n");
  return runAsync("bash", ["-c", snippet], repo, {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE),
    MANDIBLE_AUTH_ALLOWED_SIGNERS: allowedSigner(),
    ...(atomic
      ? {
          MANDIBLE_AUTH_ATOMIC: "1",
          MANDIBLE_AUTH_CANDIDATE_TREE_SHA: atomic.cached.tree,
          MANDIBLE_AUTH_CANDIDATE_PIN_SHA: atomic.cached.pin,
          MANDIBLE_AUTH_CANDIDATE_BASE_SHA: atomic.base,
          MANDIBLE_AUTH_CANDIDATE_HEAD_SHA: atomic.head,
          MANDIBLE_AUTH_CANDIDATE_REF: atomic.cached.ref,
        }
      : {}),
    ...extraEnv,
  });
}

/** Call one helper from auth-merge.sh without running the merge flow. */
function sourceHelper(snippet: string, env: Record<string, string> = {}): string {
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
        `source ${JSON.stringify(AUTH_MERGE)}`,
        snippet,
      ].join("\n"),
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE),
        ...env,
      },
    },
  );
  if (result.status !== 0) throw new Error(`helper failed: ${result.stderr}`);
  return result.stdout;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-canonical-msg-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-canonical-home-"));
  key = path.join(repo, "signing-key");
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Canonical Test"]);
  git(["config", "user.email", "canonical@example.invalid"]);
  git(["config", "gpg.format", "ssh"]);
  git(["config", "commit.gpgsign", "true"]);
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
    encoding: "utf8",
  });
  if (keygen.status !== 0) throw new Error(keygen.stderr);
  git(["config", "user.signingkey", key]);
  write("base.txt", "base\n");
  commit("base");
  git(["checkout", "-b", "feature/canonical"]);
  write("feature.txt", "feature\n");
  commit("feature\n\nMandible-Issue: 7d64d8f");
  git(["checkout", "main"]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("canonical change message bytes", () => {
  it("normalizes exactly the way git's own message cleanup does", () => {
    expect(canonicalizeChangeMessage("Merge x: y\r\n\r\n\r\nWhy:\r\nBecause.   \r\n\r\n\r\n")).toBe(
      "Merge x: y\n\nWhy:\nBecause.\n",
    );
    expect(canonicalizeChangeMessage("\n\n  \nsubject\n")).toBe("subject\n");
    expect(canonicalizeChangeMessage("")).toBe("");
    expect(canonicalizeChangeMessage("   \n\n")).toBe("");
    expect(canonicalizeChangeMessage(null)).toBe("");
  });

  it("is idempotent, so re-canonicalizing stored bytes cannot change the digest", () => {
    const once = canonicalizeChangeMessage("a  \n\n\nb\n\n");
    expect(canonicalizeChangeMessage(once)).toBe(once);
    expect(changeMessageDigest(once)).toBe(changeMessageDigest("a  \n\n\nb\n\n"));
  });

  it("has no digest for an empty message", () => {
    expect(changeMessageDigest("  \n")).toBeNull();
  });

  it("agrees byte for byte with the bash mirror in cli/auth-merge.sh", () => {
    const samples = [
      "Merge feature/x: outcome\n\nWhy:\nBecause.\n\nVerification:\nNot recorded\n\nMandible-Issue: 7d64d8f\n",
      "trailing spaces   \r\n\r\n\r\nand blank runs\n\n\n",
      "  leading blank lines\n",
      "unicode — em dash and ünïcödé\n",
    ];
    for (const sample of samples) {
      const encoded = Buffer.from(sample, "utf8").toString("base64");
      const observed = sourceHelper(
        `printf '%s' ${JSON.stringify(encoded)} | base64 --decode | canonicalize_change_message | change_message_digest`,
      ).trim();
      expect(observed).toBe(changeMessageDigest(sample));
    }
  });
});

describe("auth request CLI change message composition", () => {
  function submitAndCapture(args: string[], port: number): Promise<ProcResult> {
    return runAsync(CLI, args, repo, {
      ...process.env,
      HOME: homeDir,
      MANDIBLE_PORT: String(port),
      MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      ZELLIJ: "",
      TMUX: "",
    });
  }

  async function submitServer(): Promise<{
    port: number;
    bodies: Record<string, unknown>[];
    close: () => Promise<void>;
  }> {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/instance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow" } }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/check") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            check: {
              status: "clean",
              repo: path.basename(repo),
              base_branch: "main",
              head_branch: "feature/canonical",
              checked_requests: 0,
              conflicts: [],
            },
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/request") {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ request_id: "req_canonical" }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("submit server did not bind");
    return {
      port: address.port,
      bodies,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }

  it("composes the canonical template from prose plus machine-owned parts", async () => {
    const server = await submitServer();
    try {
      const messageFile = path.join(homeDir, "message.txt");
      fs.writeFileSync(
        messageFile,
        [
          "merge messages are now agent-authored",
          "",
          "Why:",
          "Merge commits carried no information about a delivery.",
          "",
          "Caveats:",
          "Legacy requests keep git's default message.",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await submitAndCapture(
        [
          "auth",
          "request",
          "feature/canonical",
          "--title",
          "Canonical change message",
          "--issue",
          "7d64d8f",
          "--closes-issue",
          "abc1234",
          "--message-file",
          messageFile,
          "--verification",
          "Focused vitest suites pass.",
          "--no-watch",
        ],
        server.port,
      );

      expect(result.status).toBe(0);
      expect(server.bodies).toHaveLength(1);
      const body = server.bodies[0]!;
      expect(body.canonical_message).toBe(true);
      expect(body.commit_message).toBe(
        [
          "Merge feature/canonical: merge messages are now agent-authored",
          "",
          "Why:",
          "Merge commits carried no information about a delivery.",
          "",
          "Verification:",
          "Focused vitest suites pass.",
          "",
          "Caveats:",
          "Legacy requests keep git's default message.",
          "",
          "Mandible-Issue: 7d64d8f",
          "Closes-Mandible-Issue: abc1234",
        ].join("\n"),
      );
    } finally {
      await server.close();
    }
  });

  it("defaults the machine-owned verification section to Not recorded", async () => {
    const server = await submitServer();
    try {
      const result = await submitAndCapture(
        [
          "auth",
          "request",
          "feature/canonical",
          "--title",
          "Canonical change message",
          "--issue",
          "7d64d8f",
          "--message",
          "outcome line\n\nWhy:\nBecause.",
          "--no-watch",
        ],
        server.port,
      );

      expect(result.status).toBe(0);
      const body = server.bodies[0]!;
      expect(body.commit_message).toBe(
        [
          "Merge feature/canonical: outcome line",
          "",
          "Why:",
          "Because.",
          "",
          "Verification:",
          "Not recorded",
          "",
          "Mandible-Issue: 7d64d8f",
        ].join("\n"),
      );
    } finally {
      await server.close();
    }
  });

  it("submits no change message at all when no message flag is given", async () => {
    const server = await submitServer();
    try {
      const result = await submitAndCapture(
        [
          "auth",
          "request",
          "feature/canonical",
          "--title",
          "No message",
          "--issue",
          "7d64d8f",
          "--no-watch",
        ],
        server.port,
      );

      expect(result.status).toBe(0);
      const body = server.bodies[0]!;
      expect(body.commit_message).toBeNull();
      expect(body.canonical_message).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("refuses agent-authored machine-owned sections and trailers", async () => {
    const server = await submitServer();
    try {
      for (const offending of [
        "outcome\n\nVerification:\nI promise it works.",
        "outcome\n\nWhy:\nBecause.\n\nMandible-Issue: deadbee",
        "outcome\n\nWhy:\nBecause.\n\nCloses-Mandible-Issue: deadbee",
        "outcome\n\n# a comment line",
      ]) {
        const result = await submitAndCapture(
          [
            "auth",
            "request",
            "feature/canonical",
            "--title",
            "Bad message",
            "--issue",
            "7d64d8f",
            "--message",
            offending,
            "--no-watch",
          ],
          server.port,
        );
        expect(result.status).toBe(2);
      }
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects conflicting message sources", async () => {
    const server = await submitServer();
    try {
      const both = await submitAndCapture(
        [
          "auth", "request", "feature/canonical", "--title", "x", "--issue", "7d64d8f",
          "--message", "a", "--message-file", "/dev/null", "--no-watch",
        ],
        server.port,
      );
      expect(both.status).toBe(2);
      expect(both.stderr).toContain("mutually exclusive");

      const legacy = await submitAndCapture(
        [
          "auth", "request", "feature/canonical", "--title", "x", "--issue", "7d64d8f",
          "--message", "a", "--commit-message", "b", "--no-watch",
        ],
        server.port,
      );
      expect(legacy.status).toBe(2);
      expect(legacy.stderr).toContain("--commit-message cannot be combined");
    } finally {
      await server.close();
    }
  });
});

describe("auth queue canonical message storage", () => {
  function newQueue(): { db: InstanceType<typeof Database>; queue: AuthQueue } {
    const db = new Database(":memory:");
    migrate(db);
    setupOperator(db, { slug: "canonical-test", display_name: "Canonical Test" });
    return { db, queue: new AuthQueue({ db, backgroundMaintenance: false }) };
  }

  it("stores canonical bytes and their digest when the submitter declares one", () => {
    const { db, queue } = newQueue();
    try {
      const raw = "Merge feature/x: outcome   \r\n\r\n\r\nWhy:\r\nBecause.\r\n\r\n";
      const request = queue.submit({
        command: "echo canonical",
        title: "Canonical",
        commit_message: raw,
        canonical_message: true,
      });
      const canonical = canonicalizeChangeMessage(raw);
      expect(request.commit_message).toBe(canonical);
      expect(request.commit_message_digest).toBe(changeMessageDigest(canonical));
      expect(queue.getRequest(request.id)?.commit_message_digest).toBe(
        request.commit_message_digest,
      );
    } finally {
      db.close();
    }
  });

  it("leaves free-form review text undigested", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit({
        command: "echo legacy",
        title: "Legacy",
        commit_message: "- one\n- two",
      });
      expect(request.commit_message).toBe("- one\n- two");
      expect(request.commit_message_digest).toBeNull();
    } finally {
      db.close();
    }
  });

  it("recomputes the digest for a pending edit", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit({
        command: "echo canonical",
        title: "Canonical",
        commit_message: "Merge feature/x: first\n\nWhy:\nBecause.\n",
        canonical_message: true,
      });
      const updated = queue.update(request.id, {
        commit_message: "Merge feature/x: second\n\nWhy:\nBecause.\n",
      });
      expect(updated.commit_message).toBe("Merge feature/x: second\n\nWhy:\nBecause.\n");
      expect(updated.commit_message_digest).toBe(
        changeMessageDigest(updated.commit_message ?? ""),
      );
      expect(updated.commit_message_digest).not.toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("refuses to mutate a canonical message once the request leaves pending", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit({
        command: "echo canonical",
        title: "Canonical",
        commit_message: "Merge feature/x: first\n\nWhy:\nBecause.\n",
        canonical_message: true,
      });
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);

      expect(() =>
        queue.update(request.id, { commit_message: "Merge feature/x: tampered\n" }),
      ).toThrow(expect.objectContaining({ status: 409 }));

      const stored = queue.getRequest(request.id);
      expect(stored?.commit_message).toBe(request.commit_message);
      expect(stored?.commit_message_digest).toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("still allows editing undigested review text on an approved request", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit({
        command: "echo legacy",
        title: "Legacy",
        commit_message: "- one",
      });
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);
      const updated = queue.update(request.id, { commit_message: "- two" });
      expect(updated.commit_message).toBe("- two");
      expect(updated.commit_message_digest).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("auth merge canonical message consumption", () => {
  const MESSAGE = [
    "Merge feature/canonical: agent-authored merge messages",
    "",
    "Why:",
    "A merge commit is the durable record of a delivery.",
    "",
    "Verification:",
    "Focused vitest suites pass.",
    "",
    "Mandible-Issue: 7d64d8f",
    "",
  ].join("\n");

  const DIGEST = changeMessageDigest(MESSAGE)!;

  it("commits the exact approved bytes on the atomic commit-tree path", async () => {
    const base = git(["rev-parse", "main"]);
    const head = git(["rev-parse", "feature/canonical"]);
    const cached = candidate(base, head, "canonical-atomic");
    const server = await serveRequest({
      id: "canonical-atomic",
      commit_message: MESSAGE,
      commit_message_digest: DIGEST,
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "canonical-atomic",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: DIGEST,
        },
        { base, head, cached },
      );

      expect(result.status).toBe(0);
      const merged = git(["rev-parse", "main"]);
      expect(git(["show", "-s", "--format=%B", merged])).toBe(MESSAGE.trimEnd());
      expect(result.stderr).toContain("using the approved canonical change message");
    } finally {
      await server.close();
    }
  });

  it("commits the exact approved bytes on the git merge path", async () => {
    const head = git(["rev-parse", "feature/canonical"]);
    const server = await serveRequest({
      id: "canonical-merge",
      commit_message: MESSAGE,
      commit_message_digest: DIGEST,
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "canonical-merge",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: DIGEST,
          MANDIBLE_AUTH_EXPECTED_HEAD_SHA: head,
        },
        null,
      );

      expect(result.status).toBe(0);
      const merged = git(["rev-parse", "main"]);
      expect(git(["show", "-s", "--format=%B", merged])).toBe(MESSAGE.trimEnd());
    } finally {
      await server.close();
    }
  });

  it("keeps git's default merge message when the request carries none", async () => {
    const head = git(["rev-parse", "feature/canonical"]);
    const server = await serveRequest({
      id: "no-message",
      commit_message: null,
      commit_message_digest: null,
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "no-message",
          MANDIBLE_AUTH_EXPECTED_HEAD_SHA: head,
        },
        null,
      );

      expect(result.status).toBe(0);
      const merged = git(["rev-parse", "main"]);
      expect(git(["show", "-s", "--format=%B", merged])).toBe(
        "Merge branch 'feature/canonical'",
      );
    } finally {
      await server.close();
    }
  });

  it("aborts without touching the repo when the served bytes do not match the digest", async () => {
    const base = git(["rev-parse", "main"]);
    const server = await serveRequest({
      id: "tampered",
      commit_message: `${MESSAGE}Tampered line\n`,
      commit_message_digest: DIGEST,
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "tampered",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: DIGEST,
        },
        null,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("digest mismatch");
      expect(git(["rev-parse", "main"])).toBe(base);
    } finally {
      await server.close();
    }
  });

  it("aborts when an approved message exists but cannot be fetched", async () => {
    const base = git(["rev-parse", "main"]);
    const result = await runMerge(
      {
        // Port 9 is the discard port: nothing answers, so the fetch fails.
        MANDIBLE_BASE: "http://127.0.0.1:9",
        MANDIBLE_PORT: "9",
        MANDIBLE_AUTH_REQUEST_ID: "unreachable",
        MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: DIGEST,
      },
      null,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be fetched");
    expect(git(["rev-parse", "main"])).toBe(base);
  });

  it("aborts when the approved message is gone from the request", async () => {
    const base = git(["rev-parse", "main"]);
    const server = await serveRequest({
      id: "dropped",
      commit_message: null,
      commit_message_digest: null,
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "dropped",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: DIGEST,
        },
        null,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no longer carries the approved canonical change message");
      expect(git(["rev-parse", "main"])).toBe(base);
    } finally {
      await server.close();
    }
  });
});

describe("closure safety of merge-message trailers", () => {
  // The auto-close scan reads `git log --format=%b base..HEAD`, a range that
  // includes the merge commit itself, so the canonical message's own trailers
  // are in scope. Reference-only trailers must stay inert.
  function scan(): string {
    return sourceHelper('collect_auto_close_issues "$(git rev-parse ORIG_HEAD)"', {
      MANDIBLE_BASE: "http://127.0.0.1:9",
      MANDIBLE_PORT: "9",
    });
  }

  it("does not auto-close from a reference-only Mandible-Issue trailer", () => {
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m",
      "Merge feature/canonical: outcome\n\nMandible-Issue: 7d64d8f", "feature/canonical"]);
    expect(git(["log", "-1", "--format=%B", "HEAD"])).toContain("Mandible-Issue: 7d64d8f");
    expect(scan().trim()).toBe("");
  });

  it("still collects an explicit Closes-Mandible-Issue trailer", () => {
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m",
      "Merge feature/canonical: outcome\n\nMandible-Issue: 7d64d8f\nCloses-Mandible-Issue: abc1234",
      "feature/canonical"]);
    expect(scan().trim()).toBe("abc1234");
  });
});
