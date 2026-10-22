import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalizeChangeMessage,
  changeMessageDigest,
  isCanonicalChangeMessage,
  validateCanonicalChangeMessage,
} from "../src/auth-change-message.js";
import { AuthQueue } from "../src/auth-queue.js";
import { setupOperator } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");
const CLI = path.join(process.cwd(), "bin", "mandible");

let repo = "";
let homeDir = "";
let keyDir = "";
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

// One signing key for the whole file: key generation is the slowest step here
// and nothing in these tests depends on a per-test key identity.
beforeAll(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-canonical-key-"));
  key = path.join(keyDir, "signing-key");
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
    encoding: "utf8",
  });
  if (keygen.status !== 0) throw new Error(keygen.stderr);
});

afterAll(() => {
  fs.rmSync(keyDir, { recursive: true, force: true });
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-canonical-msg-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-canonical-home-"));
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Canonical Test"]);
  git(["config", "user.email", "canonical@example.invalid"]);
  git(["config", "gpg.format", "ssh"]);
  git(["config", "commit.gpgsign", "true"]);
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

  it("is idempotent", () => {
    const once = canonicalizeChangeMessage("a  \n\n\nb\n\n");
    expect(canonicalizeChangeMessage(once)).toBe(once);
    expect(isCanonicalChangeMessage(once)).toBe(true);
  });

  it("digests the exact bytes given, without normalizing them first", () => {
    const canonical = "subject\n";
    const sloppy = "subject   \n\n";
    // Two different byte strings must produce two different digests even
    // though they share a canonical form: the digest binds what is stored.
    expect(changeMessageDigest(sloppy)).not.toBe(changeMessageDigest(canonical));
    expect(changeMessageDigest(canonical)).toBe(
      changeMessageDigest(canonicalizeChangeMessage(sloppy)),
    );
  });

  it("recognizes non-canonical bytes so callers can fail closed", () => {
    expect(isCanonicalChangeMessage("subject\n")).toBe(true);
    expect(isCanonicalChangeMessage("subject")).toBe(false);
    expect(isCanonicalChangeMessage("subject\n\n")).toBe(false);
    expect(isCanonicalChangeMessage("subject  \n")).toBe(false);
    expect(isCanonicalChangeMessage("")).toBe(false);
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
      // Exact-byte digest parity.
      expect(
        sourceHelper(
          `printf '%s' ${JSON.stringify(encoded)} | base64 --decode | change_message_digest`,
        ).trim(),
      ).toBe(changeMessageDigest(sample));
      // Canonicalization parity.
      expect(
        sourceHelper(
          `printf '%s' ${JSON.stringify(encoded)} | base64 --decode | canonicalize_change_message | change_message_digest`,
        ).trim(),
      ).toBe(changeMessageDigest(canonicalizeChangeMessage(sample)));
    }
  });
});

describe("canonical change message envelope validation", () => {
  const FIELDS = {
    verification: "Focused suites pass.",
    issueReferences: ["7d64d8f"],
    issueClosures: ["abc1234"],
  };
  const VALID = [
    "Merge feature/x: outcome",
    "",
    "Why:",
    "Because.",
    "",
    "Verification:",
    "Focused suites pass.",
    "",
    "Mandible-Issue: 7d64d8f",
    "Mandible-Issue: abc1234",
    "",
  ].join("\n");

  it("accepts a message whose machine-owned envelope matches the structured fields", () => {
    expect(validateCanonicalChangeMessage(VALID, FIELDS)).toBeNull();
  });




  it("refuses a Verification section that does not match the structured field", () => {
    const forged = VALID.replace("Focused suites pass.", "I promise it works.");
    expect(validateCanonicalChangeMessage(forged, FIELDS)).toContain("Verification");

    const doubled = VALID.replace(
      "Why:\nBecause.",
      "Why:\nBecause.\n\nVerification:\nFocused suites pass.",
    );
    expect(validateCanonicalChangeMessage(doubled, FIELDS)).toContain("exactly one");
  });

  it("refuses a '#'-leading line anywhere", () => {
    const forged = VALID.replace("Because.", "Because.\n#not a comment to git");
    expect(validateCanonicalChangeMessage(forged, FIELDS)).toContain("'#'");
  });


  it("constrains the verification text itself", () => {
    for (const verification of ["", "   ", "one\n\ntwo", "#comment"]) {
      expect(validateCanonicalChangeMessage(VALID, { ...FIELDS, verification })).not.toBeNull();
    }
    expect(validateCanonicalChangeMessage(VALID, { ...FIELDS, verification: undefined }))
      .toContain("requires the structured 'verification' field");
  });

  it("refuses bytes that are not already canonical", () => {
    expect(validateCanonicalChangeMessage(`${VALID}\n`, FIELDS)).toContain("canonical form");
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
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
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
      expect(body.verification).toBe("Focused vitest suites pass.");
      // The closure issue is referenced, never closed, by the message: closure
      // stays with the structured issue_closures field.
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
        ].join("\n"),
      );
      expect(String(body.commit_message)).not.toContain("Closes-Mandible-Issue");
      expect(body.issue_closures).toEqual(["abc1234"]);
    } finally {
      await server.close();
    }
  });

  it("refuses a merge request without a change message or verification, naming the flag", async () => {
    const server = await submitServer();
    try {
      const base = ["auth", "request", "feature/canonical", "--title", "x", "--issue", "7d64d8f"];
      const noMessage = await submitAndCapture([...base, "--verification", "ok", "--no-watch"], server.port);
      expect(noMessage.status).toBe(2);
      expect(noMessage.stderr).toContain("(--message <text> | --message-file <file>): the canonical change message");
      expect(noMessage.stderr).not.toContain("--verification <text>:");

      const noVerification = await submitAndCapture(
        [...base, "--message", "outcome\n\nWhy:\nBecause.", "--no-watch"], server.port);
      expect(noVerification.status).toBe(2);
      expect(noVerification.stderr).toContain("--verification <text>: the checks you ran");
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("refuses agent-authored Verification headings and comment lines", async () => {
    const server = await submitServer();
    try {
      for (const offending of [
        "outcome\n\nVerification:\nI promise it works.",
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
            "--verification",
            "ok",
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
          "--message", "a", "--message-file", "/dev/null", "--verification", "ok", "--no-watch",
        ],
        server.port,
      );
      expect(both.status).toBe(2);
      expect(both.stderr).toContain("Arguments do not match");
    } finally {
      await server.close();
    }
  });

  it("constrains the machine-owned verification text", async () => {
    const server = await submitServer();
    try {
      for (const verification of ["   ", "one\n\ntwo", "#comment"]) {
        const result = await submitAndCapture(
          [
            "auth", "request", "feature/canonical", "--title", "x", "--issue", "7d64d8f",
            "--message", "outcome\n\nWhy:\nBecause.", "--verification", verification,
            "--no-watch",
          ],
          server.port,
        );
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("--verification");
      }
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("refuses whitespace in structured issue references", async () => {
    const server = await submitServer();
    try {
      const result = await submitAndCapture(
        [
          "auth", "request", "feature/canonical", "--title", "x",
          "--issue", "7d64d8f\nMandible-Issue: deadbee",
          "--message", "outcome\n\nWhy:\nBecause.", "--verification", "ok", "--no-watch",
        ],
        server.port,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("whitespace or newlines");
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("auth queue canonical message storage", () => {
  function newQueue(): { db: InstanceType<typeof SqliteDatabase>; queue: AuthQueue } {
    const db = migratedMemoryDb();
    setupOperator(db, { slug: "canonical-test", display_name: "Canonical Test" });
    return { db, queue: new AuthQueue({ db, backgroundMaintenance: false }) };
  }

  const VERIFICATION = "Focused suites pass.";
  function message(subject: string): string {
    return [
      `Merge feature/x: ${subject}`,
      "",
      "Why:",
      "Because.",
      "",
      "Verification:",
      VERIFICATION,
      "",
      "Mandible-Issue: 7d64d8f",
      "",
    ].join("\n");
  }
  function canonicalSubmission(subject: string): Parameters<AuthQueue["submit"]>[0] {
    return {
      command: "echo canonical",
      title: "Canonical",
      commit_message: message(subject),
      canonical_message: true,
      verification: VERIFICATION,
      issue_references: ["7d64d8f"],
    };
  }

  it("stores canonical bytes and their digest when the submitter declares one", () => {
    const { db, queue } = newQueue();
    try {
      const raw = message("outcome").replace(/\n/g, "\r\n").concat("\r\n\r\n");
      const request = queue.submit({ ...canonicalSubmission("outcome"), commit_message: raw });
      const canonical = canonicalizeChangeMessage(raw);
      expect(request.commit_message).toBe(canonical);
      // The digest binds the stored octets exactly, terminal newline included.
      expect(request.commit_message_digest).toBe(changeMessageDigest(canonical));
      expect(isCanonicalChangeMessage(request.commit_message ?? "")).toBe(true);
      expect(queue.getRequest(request.id)?.commit_message_digest).toBe(
        request.commit_message_digest,
      );
    } finally {
      db.close();
    }
  });

  it("refuses a canonical submission whose envelope does not match the structured fields", () => {
    const { db, queue } = newQueue();
    try {
      const opaque = queue.submit({
        ...canonicalSubmission("opaque issue-looking text"),
        commit_message: message("opaque issue-looking text").replace(
          "Mandible-Issue: 7d64d8f", "Closes-Mandible-Issue: deadbee"),
      });
      expect(opaque.issue_references).toEqual(["7d64d8f"]);
      expect(opaque.issue_closures).toBeNull();
      expect(opaque.issue_ids).toBeNull();

      expect(() =>
        queue.submit({
          ...canonicalSubmission("outcome"),
          commit_message: message("outcome").replace("Because.", "Because.\n#stripped by git"),
        }),
      ).toThrow(expect.objectContaining({ status: 400 }));

      expect(() =>
        queue.submit({ ...canonicalSubmission("outcome"), verification: "Something else." }),
      ).toThrow(expect.objectContaining({ status: 400 }));

      expect(() =>
        queue.submit({ ...canonicalSubmission("outcome"), verification: undefined }),
      ).toThrow(expect.objectContaining({ status: 400 }));

      expect(queue.submit({
        ...canonicalSubmission("new references"), issue_references: ["7d64d8f", "deadbee"],
      }).issue_references).toEqual(["7d64d8f", "deadbee"]);
    } finally {
      db.close();
    }
  });

  it("uses structured fields for reference-only ledger links", () => {
    const { db, queue } = newQueue();
    try {
      // Reference-only structured fields never create closure links.
      const request = queue.submit(canonicalSubmission("outcome"));

      const links = db.prepare(
        "SELECT issue_id, link_type FROM ledger_auth_issue_links WHERE auth_request_id = ?",
      ).all(request.id) as Array<{ issue_id: string; link_type: string }>;
      expect(links.every((link) => link.link_type !== "resolves")).toBe(true);
      expect(links.every((link) => link.link_type !== "fixed_by")).toBe(true);
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
      const request = queue.submit(canonicalSubmission("first"));
      const updated = queue.update(request.id, {
        commit_message: message("second"),
        verification: VERIFICATION,
      });
      expect(updated.commit_message).toBe(message("second"));
      expect(updated.commit_message_digest).toBe(changeMessageDigest(message("second")));
      expect(updated.commit_message_digest).not.toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("demotes a canonical message to review text on an explicit canonical_message false", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit(canonicalSubmission("first"));
      expect(request.commit_message_digest).not.toBeNull();

      // A false-only update must be applied, not rejected as "no fields" and
      // not silently ignored.
      const demoted = queue.update(request.id, { canonical_message: false });
      expect(demoted.commit_message).toBe(request.commit_message);
      expect(demoted.commit_message_digest).toBeNull();

      // ...and it can be promoted back while still pending.
      const promoted = queue.update(request.id, {
        canonical_message: true,
        verification: VERIFICATION,
      });
      expect(promoted.commit_message_digest).toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("refuses to mutate a canonical message once the request leaves pending", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit(canonicalSubmission("first"));
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);

      expect(() =>
        queue.update(request.id, { commit_message: message("tampered"), verification: VERIFICATION }),
      ).toThrow(expect.objectContaining({ status: 409 }));
      // Demotion is a mutation of the frozen binding too.
      expect(() => queue.update(request.id, { canonical_message: false })).toThrow(
        expect.objectContaining({ status: 409 }),
      );

      const stored = queue.getRequest(request.id);
      expect(stored?.commit_message).toBe(request.commit_message);
      expect(stored?.commit_message_digest).toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("refuses editing undigested review text after approval", () => {
    const { db, queue } = newQueue();
    try {
      const request = queue.submit({
        command: "echo legacy",
        title: "Legacy",
        commit_message: "- one",
      });
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);
      expect(() => queue.update(request.id, { commit_message: "- two" }))
        .toThrow(/Only pending requests can be revised/);
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

  const DIGEST = changeMessageDigest(MESSAGE);

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

  it("refuses the retired direct git merge path without changing protected state", async () => {
    const base = git(["rev-parse", "main"]);
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

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("require a reviewed signed candidate");
      expect(git(["rev-parse", "main"])).toBe(base);
    } finally {
      await server.close();
    }
  });

  it("keeps git's default merge message when the request carries none", async () => {
    const base = git(["rev-parse", "main"]);
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
        { base, head: git(["rev-parse", "feature/canonical"]), cached: candidate(base, git(["rev-parse", "feature/canonical"]), "canonical-message-check") },
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
        { base, head: git(["rev-parse", "feature/canonical"]), cached: candidate(base, git(["rev-parse", "feature/canonical"]), "canonical-message-check") },
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
      { base, head: git(["rev-parse", "feature/canonical"]), cached: candidate(base, git(["rev-parse", "feature/canonical"]), "canonical-message-check") },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be fetched");
    expect(git(["rev-parse", "main"])).toBe(base);
  });

  it("aborts when the stored bytes are not in canonical form", async () => {
    const base = git(["rev-parse", "main"]);
    // Bytes whose digest is honest but whose shape is not canonical: hashing a
    // normalized copy would have let this through and then committed something
    // else.
    const sloppy = `${MESSAGE}\n`;
    const server = await serveRequest({
      id: "sloppy",
      commit_message: sloppy,
      commit_message_digest: changeMessageDigest(sloppy),
    });
    try {
      const result = await runMerge(
        {
          MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
          MANDIBLE_PORT: String(server.port),
          MANDIBLE_AUTH_REQUEST_ID: "sloppy",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: changeMessageDigest(sloppy),
        },
        { base, head: git(["rev-parse", "feature/canonical"]), cached: candidate(base, git(["rev-parse", "feature/canonical"]), "canonical-message-check") },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not in canonical form");
      expect(git(["rev-parse", "main"])).toBe(base);
    } finally {
      await server.close();
    }
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
        { base, head: git(["rev-parse", "feature/canonical"]), cached: candidate(base, git(["rev-parse", "feature/canonical"]), "canonical-message-check") },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no longer carries the approved canonical change message");
      expect(git(["rev-parse", "main"])).toBe(base);
    } finally {
      await server.close();
    }
  });
});

describe("commit prose cannot select issue closures", () => {
  it("ignores historical closure text during merge cleanup", () => {
    git(["-c", "commit.gpgsign=false", "merge", "--no-ff", "-m",
      "Merge feature/canonical: outcome\n\nCloses-Mandible-Issue: abc1234", "feature/canonical"]);
    expect(sourceHelper('collect_cleanup_issue_ids', { MANDIBLE_AUTH_REQUEST_ID: "" }).trim()).toBe("");
  });
});
