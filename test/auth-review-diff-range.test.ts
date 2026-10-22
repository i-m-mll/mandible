import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
// @vitest-environment node
// Issue 1512471 — the diff an approver reads must be the change the merge will
// apply, which is the three-dot range from the merge base. Both operator-facing
// derivations used two dots, so once the base advanced they attributed other
// lanes' merged work to the branch under review, as deletions.
//
// The scenario below is the one that made the bug visible: cut a branch, then
// advance the base with an unrelated commit. Two-dot and three-dot disagree
// only after that second step, so a test that skips it passes either way.
//
// The daemon is the only count authority. The CLI deliberately submits no
// headline statistics, so a caller cannot drift from the captured inventory.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";


import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { MERGE_CHANGE_MESSAGE_FLAGS } from "./helpers/auth-delivery-fixtures.js";
import { createLedgerIssue, createLedgerProject } from "./helpers/auth-queue-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let repoDir = "";
let homeDir = "";

function git(args: string[], cwd = repoDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(name: string, lines: number, prefix: string): void {
  const body = Array.from({ length: lines }, (_, i) => `${prefix} ${i}\n`).join("");
  fs.writeFileSync(path.join(repoDir, name), body, "utf8");
}

interface Shortstat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

function shortstatFor(range: string): Shortstat {
  const out = git(["diff", "--shortstat", range]);
  return {
    filesChanged: Number(out.match(/(\d+) files? changed/)?.[1] ?? 0),
    additions: Number(out.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(out.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
  };
}

/**
 * `feature/small` makes a three-line edit, then ANOTHER lane lands 40 lines of
 * new work on `main` that this branch never saw. Two-dot diffs tip against tip,
 * so it renders that arriving work as this branch deleting it — the exact
 * inversion issue 1512471 was filed for, and the reason the error grows as the
 * base advances.
 */
function createRepoWithAdvancedBase(): void {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);

  write("shared.txt", 5, "shared");
  git(["add", "."]);
  git(["commit", "-m", "base"]);

  git(["checkout", "-b", "feature/small"]);
  write("shared.txt", 8, "shared");
  git(["add", "shared.txt"]);
  git(["commit", "-m", "small feature edit"]);

  git(["checkout", "main"]);
  write("other-lane.txt", 40, "other lane");
  git(["add", "-A"]);
  git(["commit", "-m", "another lane lands 40 lines on main"]);
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-review-range-repo-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-review-range-home-"));
  createRepoWithAdvancedBase();
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth review diff range", () => {
  it("the scenario actually distinguishes the two ranges", () => {
    // Guard the guard: if this ever stops holding, every assertion below would
    // pass against the buggy code and the file would be worthless.
    const twoDot = shortstatFor("main..feature/small");
    const threeDot = shortstatFor("main...feature/small");
    expect(threeDot).not.toEqual(twoDot);
    // The branch adds three lines to one file and nothing else.
    expect(threeDot).toEqual({ filesChanged: 1, additions: 3, deletions: 0 });
    // Two-dot attributes the other lane's 40-line removal to this branch.
    expect(twoDot.deletions).toBe(40);
  });

  it("the daemon records the three-dot counts", async () => {
    const metadata = await computeAuthMergeReviewMetadata(
      repoDir,
      "main",
      "feature/small",
      { counts: true, diffSummary: false },
    );

    expect({
      filesChanged: metadata.filesChanged,
      additions: metadata.additions,
      deletions: metadata.deletions,
    }).toEqual(shortstatFor("main...feature/small"));
  });

  it("the daemon's stored preview does not show the branch deleting another lane's file", async () => {
    const metadata = await computeAuthMergeReviewMetadata(
      repoDir,
      "main",
      "feature/small",
      { counts: false, diffSummary: true },
    );

    expect(metadata.diffSummary).toContain("shared.txt");
    expect(metadata.diffSummary).not.toContain("other-lane.txt");
  });

  it("the recorded counts do not change when the base advances again", async () => {
    const before = await computeAuthMergeReviewMetadata(
      repoDir, "main", "feature/small", { counts: true, diffSummary: false },
    );

    write("yet-another-lane.txt", 120, "yet another lane");
    git(["add", "-A"]);
    git(["commit", "-m", "a third lane lands on main"]);

    const after = await computeAuthMergeReviewMetadata(
      repoDir, "main", "feature/small", { counts: true, diffSummary: false },
    );

    // The branch did not change, so its recorded size must not change either.
    // Under two dots this grows by 120 additions for work the branch never did.
    expect(after.filesChanged).toEqual(before.filesChanged);
    expect(after.additions).toEqual(before.additions);
    expect(after.deletions).toEqual(before.deletions);
    expect(after.changeReport?.files).toEqual(before.changeReport?.files);
    expect(after.changeReport?.comparison.head_sha).toBe(before.changeReport?.comparison.head_sha);
    expect(after.changeReport?.comparison.merge_base_sha).toBe(before.changeReport?.comparison.merge_base_sha);
    expect(after.changeReport?.comparison.base_sha).not.toBe(before.changeReport?.comparison.base_sha);
  });

  it("the CLI leaves counts to the daemon", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/instance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/check") {
        // Drain the body before replying; answering a request whose body is
        // still being written stalls the client for the socket timeout.
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            check: {
              status: "clean",
              repo: path.basename(repoDir),
              base_branch: "main",
              head_branch: "feature/small",
              checked_requests: 0,
              conflicts: [],
            },
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/request") {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            request_id: "req_review_range",
            files_changed: 1,
            additions: 3,
            deletions: 0,
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("test server did not bind a TCP port");
        }
        resolve(address.port);
      });
    });

    try {
      // Async spawn, never spawnSync: the stub server lives in this process, so
      // a blocking child would deadlock against the requests it has to answer.
      const result = await new Promise<{ status: number | null; stderr: string }>(
        (resolve) => {
          const child = spawn(
            CLI,
            ["auth", "request", "feature/small", "--title", "Merge feature/small",
             "--issue", "1512471", ...MERGE_CHANGE_MESSAGE_FLAGS, "--no-watch"],
            {
              cwd: repoDir,
              env: {
                ...process.env,
                HOME: homeDir,
                MANDIBLE_PORT: String(port),
                MANDIBLE_BASE: `http://127.0.0.1:${port}`,
                ZELLIJ: "",
                TMUX: "",
              },
            },
          );
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("close", (status) => resolve({ status, stderr }));
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(bodies).toHaveLength(1);

      expect(bodies[0]).not.toHaveProperty("files_changed");
      expect(bodies[0]).not.toHaveProperty("additions");
      expect(bodies[0]).not.toHaveProperty("deletions");

      // The preview the approver reads must not contain another lane's file.
      expect(String(bodies[0].diff_summary)).toContain("shared.txt");
      expect(String(bodies[0].diff_summary)).not.toContain("other-lane.txt");
    } finally {
      await new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      });
    }
  });
});

// Issue 1512471, comment 1 claimed the update route does not accept
// files_changed/additions/deletions, so a request born with misleading numbers
// could never be corrected in place and had to be deleted and resubmitted. That
// is not what the code does: both the route payload parser and the queue's
// update allowlist have carried the three fields since the initial commit.
//
// The claim was wrong, but the contract it assumed is the one that matters and
// nothing pinned it. This does. Note what is NOT asserted: the counts are not
// recomputed on update, so a caller that sends only prose still leaves the old
// numbers in front of the approver. That is a live design gap, recorded rather
// than silently fixed here.
describe("auth request review counts are correctable in place", () => {
  let queueDb: Db | null = null;
  afterEach(() => {
    queueDb?.close();
    queueDb = null;
  });

  it("accepts corrected diff stats through PUT", async () => {
    queueDb = migratedMemoryDb();
    setDb(queueDb);
    const operator = setupOperator(queueDb, { slug: "review-counts", display_name: "Review Counts" });
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-review-count-auth-"));
    const authenticator = new ClientAuthenticator(queueDb, { secretsDir: authDir });
    const { token, credential } = authenticator.mintApiToken(operator.id);
    const router = new Router({ clientAuth: authenticator });
    const queue = new AuthQueue({ db: queueDb, broadcast: () => {} });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db: queueDb }));

    const project = createLedgerProject(queueDb, process.cwd());
    const issue = createLedgerIssue(queueDb, project.project.id, "1512471", "Review counts");
    queueDb.prepare(`INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
       ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
      VALUES (?, '1512471', ?, 'feature/stale-counts', 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
      .run(crypto.randomUUID(), project.project.project_key, issue.id, operator.id, credential.id);

    // The numbers the filing request was actually born with, two-dot.
    const request = queue.submit({
      command: "mandible auth merge feature/stale-counts --into main",
      title: "Stale counts",
      files_changed: 56,
      additions: 1069,
      deletions: 1730,
      repo: project.project.project_key,
      head_branch: "feature/stale-counts",
      base_branch: "main",
      issue_references: ["1512471"],
      requester_evidence_method: "api_token",
      requester_credential_id: credential.id,
      require_delivery_custody: true,
    }, operator.id);

    const response = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id}`,
      body: {
        files_changed: 17,
        additions: 729,
        deletions: 419,
        expected_revision: 1,
        expected_custody_generation: 1,
      },
      credential: token,
      transport: "http",
    });

    fs.rmSync(authDir, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(
      queueDb
        .prepare("SELECT files_changed, additions, deletions FROM auth_requests WHERE id = ?")
        .get(request.id),
    ).toEqual({ files_changed: 17, additions: 729, deletions: 419 });
  });
});
