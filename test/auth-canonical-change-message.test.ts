import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let repo = "";
let homeDir = "";
let keyDir = "";
let key = "";
let repoTemplate = "";
let repoTemplateRefs = "";

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

afterAll(() => {
  if (repoTemplate) {
    expect(git(["show-ref", "--head"], repoTemplate)).toBe(repoTemplateRefs);
    expect(git(["status", "--porcelain"], repoTemplate)).toBe("");
  }
  if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
});

function useGitRepo(): void {
  beforeAll(() => {
    if (repoTemplate) return;
    keyDir = fs.mkdtempSync(path.join(testRuntimeRoot, "mandible-canonical-key-"));
    key = path.join(keyDir, "signing-key");
    const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
      encoding: "utf8",
    });
    if (keygen.status !== 0) throw new Error(keygen.stderr);

    repo = path.join(keyDir, "repo-template");
    fs.mkdirSync(repo);
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
    repoTemplate = repo;
    repoTemplateRefs = git(["show-ref", "--head"], repoTemplate);
  });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(testRuntimeRoot, "mandible-canonical-msg-"));
    fs.cpSync(repoTemplate, repo, { recursive: true });
    homeDir = fs.mkdtempSync(path.join(testRuntimeRoot, "mandible-canonical-home-"));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
}

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
  useGitRepo();

  function submitAndCapture(args: string[], port: number, releaseRoot?: string): Promise<ProcResult> {
    const executable = releaseRoot ? "/bin/zsh" : CLI;
    const cliArgs = releaseRoot ? [path.join(process.cwd(), "cli", "main.zsh"), ...args] : args;
    return runAsync(executable, cliArgs, repo, {
      ...process.env,
      HOME: homeDir,
      MANDIBLE_PORT: String(port),
      MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      ZELLIJ: "",
      TMUX: "",
      ...(releaseRoot ? { MANDIBLE_RELEASE_ROOT: releaseRoot } : {}),
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
      if (req.method === "POST" && req.url === "/api/auth/v2/request") {
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
      const releaseRoot = path.join(homeDir, "release", "Resources");
      const nativeDir = path.join(homeDir, "release", "MacOS");
      fs.mkdirSync(releaseRoot, { recursive: true });
      fs.mkdirSync(nativeDir, { recursive: true });
      const runtime = spawnSync(path.join(process.cwd(), "scripts", "bun-runtime.sh"), ["--bun-only"], {
        encoding: "utf8",
      });
      expect(runtime.status, runtime.stderr).toBe(0);
      fs.symlinkSync(runtime.stdout.trim(), path.join(nativeDir, "mandible-bun"));
      // Supply the installed runtime lookup while exercising source CLI generation.
      fs.mkdirSync(path.join(releaseRoot, "scripts"));
      fs.writeFileSync(path.join(releaseRoot, "scripts", "installed-command.mjs"),
        `process.stdout.write(${JSON.stringify(runtime.stdout)});\n`);
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
        ],
        server.port,
        releaseRoot,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(server.bodies).toHaveLength(1);
      const body = server.bodies[0]!;
      expect(body.command).toBe("mandible auth merge feature/canonical --into main");
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
      const noMessage = await submitAndCapture([...base, "--verification", "ok"], server.port);
      expect(noMessage.status).toBe(2);
      expect(noMessage.stderr).toContain("(--message <text> | --message-file <file>): the canonical change message");
      expect(noMessage.stderr).not.toContain("--verification <text>:");

      const noVerification = await submitAndCapture(
        [...base, "--message", "outcome\n\nWhy:\nBecause."], server.port);
      expect(noVerification.status).toBe(2);
      expect(noVerification.stderr).toContain("--verification <text>: the checks you ran");
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("refuses malformed change messages, verification text and issue references before submission", async () => {
    const server = await submitServer();
    const message = "outcome\n\nWhy:\nBecause.";
    try {
      for (const args of [
        ["--message", "outcome\n\nVerification:\nI promise it works.", "--verification", "ok"],
        ["--message", "outcome\n\n# a comment line", "--verification", "ok"],
        ["--message", "a", "--message-file", "/dev/null", "--verification", "ok"],
        ["--message", message, "--verification", "one\n\ntwo"],
        ["--message", message, "--verification", "ok", "--issue", "7d64d8f\nMandible-Issue: deadbee"],
      ]) {
        const result = await submitAndCapture(
          ["auth", "request", "feature/canonical", "--title", "x", "--issue", "7d64d8f", ...args],
          server.port,
        );
        expect(result.status, args.join(" ")).toBe(2);
      }
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

  it("stores canonical bytes and their digest when the submitter declares one", async () => {
    const { db, queue } = newQueue();
    try {
      const raw = message("outcome").replace(/\n/g, "\r\n").concat("\r\n\r\n");
      const request = (await queue.submit({ ...canonicalSubmission("outcome"), commit_message: raw }));
      const canonical = canonicalizeChangeMessage(raw);
      expect(request.commit_message).toBe(canonical);
      // The digest binds the stored octets exactly, terminal newline included.
      expect(request.commit_message_digest).toBe(changeMessageDigest(canonical));
      expect(isCanonicalChangeMessage(request.commit_message ?? "")).toBe(true);
      expect((await queue.getRequest(request.id))?.commit_message_digest).toBe(
        request.commit_message_digest,
      );
    } finally {
      db.close();
    }
  });

  it("refuses a canonical submission whose envelope does not match the structured fields", async () => {
    const { db, queue } = newQueue();
    try {
      const opaque = (await queue.submit({
        ...canonicalSubmission("opaque issue-looking text"),
        commit_message: message("opaque issue-looking text").replace(
          "Mandible-Issue: 7d64d8f", "Closes-Mandible-Issue: deadbee"),
      }));
      expect(opaque.issue_references).toEqual(["7d64d8f"]);
      expect(opaque.issue_closures).toBeNull();
      expect(opaque.issue_ids).toBeNull();

      await expect((async () =>
        (await queue.submit({
          ...canonicalSubmission("outcome"),
          commit_message: message("outcome").replace("Because.", "Because.\n#stripped by git"),
        }))()),
      ).rejects.toThrow(expect.objectContaining({ status: 400 }));

      await expect((async () =>
        (await queue.submit({ ...canonicalSubmission("outcome"), verification: "Something else." }))()),
      ).rejects.toThrow(expect.objectContaining({ status: 400 }));

      await expect((async () =>
        (await queue.submit({ ...canonicalSubmission("outcome"), verification: undefined }))()),
      ).rejects.toThrow(expect.objectContaining({ status: 400 }));

      expect((await queue.submit({
        ...canonicalSubmission("new references"), issue_references: ["7d64d8f", "deadbee"],
      })).issue_references).toEqual(["7d64d8f", "deadbee"]);
    } finally {
      db.close();
    }
  });

  it("uses structured fields for reference-only ledger links", async () => {
    const { db, queue } = newQueue();
    try {
      // Reference-only structured fields never create closure links.
      const request = (await queue.submit(canonicalSubmission("outcome")));

      const links = db.prepare(
        "SELECT issue_id, link_type FROM ledger_auth_issue_links WHERE auth_request_id = ?",
      ).all(request.id) as Array<{ issue_id: string; link_type: string }>;
      expect(links.every((link) => link.link_type !== "resolves")).toBe(true);
      expect(links.every((link) => link.link_type !== "fixed_by")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("recomputes the digest for a pending edit", async () => {
    const { db, queue } = newQueue();
    try {
      const request = (await queue.submit(canonicalSubmission("first")));
      const updated = (await queue.update(request.id, {
        commit_message: message("second"),
        verification: VERIFICATION,
      }));
      expect(updated.commit_message).toBe(message("second"));
      expect(updated.commit_message_digest).toBe(changeMessageDigest(message("second")));
      expect(updated.commit_message_digest).not.toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("refuses demoting the exact Git document on a merge", async () => {
    const { db, queue } = newQueue();
    try {
      const request = (await queue.submit(canonicalSubmission("first")));
      await expect((async () => (await queue.update(request.id, { canonical_message: false }))())).rejects
        .toThrow(expect.objectContaining({ status: 400 }));
      expect((await queue.getRequest(request.id))?.commit_message_digest).toBe(request.commit_message_digest);
    } finally { db.close(); }
  });

  it("refuses to mutate a canonical message once the request leaves pending", async () => {
    const { db, queue } = newQueue();
    try {
      const request = (await queue.submit(canonicalSubmission("first")));
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);

      await expect((async () =>
        (await queue.update(request.id, { commit_message: message("tampered"), verification: VERIFICATION }))()),
      ).rejects.toThrow(expect.objectContaining({ status: 409 }));
      // Demotion is a mutation of the frozen binding too.
      await expect((async () => (await queue.update(request.id, { canonical_message: false }))())).rejects.toThrow(
        expect.objectContaining({ status: 409 }),
      );

      const stored = (await queue.getRequest(request.id));
      expect(stored?.commit_message).toBe(request.commit_message);
      expect(stored?.commit_message_digest).toBe(request.commit_message_digest);
    } finally {
      db.close();
    }
  });

  it("refuses editing undigested review text after approval", async () => {
    const { db, queue } = newQueue();
    try {
      const request = (await queue.submit({
        type: "config-change",
        command: "echo legacy",
        title: "Legacy",
        commit_message: "- one",
      }));
      db.prepare("UPDATE auth_requests SET status = 'approved' WHERE id = ?").run(request.id);
      await expect((async () => (await queue.update(request.id, { commit_message: "- two" }))())).rejects
        .toThrow(/Only pending requests can be revised/);
    } finally {
      db.close();
    }
  });
});
