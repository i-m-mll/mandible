import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
/**
 * @vitest-environment node
 *
 * Issue 117ba80 — protected-base history audit. Every first-parent commit on
 * a merge request's protected base since the newest recorded Mandible merge
 * must be signed with an operator `ssh_key` credential; anything else is
 * listed on the request. A human approval refuses only findings it had not
 * shown; an approval with no human reviewer refuses any finding.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { Db } from "../src/db.js";
import {
  advanceMainViaAuthorizedMerge,
  approveFixtureRequest,
  commitOnBranch,
  configureSigningCredential,
  createAuthCheckRepo,
  createMigratedDb,
  createNoopHookManager,
  git,
  registerWorkRepo,
  writeFile,
} from "./helpers/auth-queue-fixtures.js";

function directCommit(repo: string, file: string, message: string, sign: "operator" | "none" | string): string {
  writeFile(repo, file, `${message}\n`);
  git(repo, ["add", file]);
  if (sign === "none") git(repo, ["commit", "-m", message]);
  else if (sign === "operator") git(repo, ["commit", "-S", "-m", message]);
  else git(repo, ["-c", `user.signingkey=${sign}`, "commit", "-S", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function fixture() {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  const calls: unknown[] = [];
  const queue = new AuthQueue({
    db,
    executor: async (options) => {
      calls.push(options.env);
      return { exit_code: 1, signal: null, stdout: "", stderr: "fixture stop\n", output: "fixture stop\n", started_at: Date.now(), finished_at: Date.now() };
    },
    hookManager: createNoopHookManager(),
  });
  registerWorkRepo(db, repo);
  configureSigningCredential(db, repo);
  const strangerKey = path.join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "stranger-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", strangerKey]);
  const strangerFingerprint = execFileSync("ssh-keygen", ["-lf", `${strangerKey}.pub`, "-E", "sha256"], { encoding: "utf8" })
    .trim().split(/\s+/)[1]!;
  return {
    repo, db, queue, calls, strangerKey, strangerFingerprint,
    submit(branch: string) {
      return queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: `mandible auth merge ${branch} --into main`,
        title: `Merge ${branch}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: branch,
        merge_head_sha: git(repo, ["rev-parse", branch]),
        cwd: repo,
      });
    },
    async cleanup() {
      await queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function storedAudit(db: Db, requestId: string) {
  const row = db.prepare("SELECT result_json FROM auth_base_audits WHERE auth_request_id = ?").get(requestId) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : null;
}

describe("protected-base history audit", () => {
  it("lists base commits since the last Mandible merge that are neither Mandible merges nor operator-signed", async () => {
    const f = fixture();
    try {
      commitOnBranch(f.repo, "feature/landed", { "landed.txt": "landed\n" });
      commitOnBranch(f.repo, "feature/topic", { "topic.txt": "topic\n" });
      const baseline = advanceMainViaAuthorizedMerge(f.db, f.repo, "feature/landed", "merge-landed");
      directCommit(f.repo, "operator.txt", "Operator hotfix", "operator");
      const unsigned = directCommit(f.repo, "unsigned.txt", "Unsigned direct commit", "none");
      const stranger = directCommit(f.repo, "stranger.txt", "Commit signed by another key", f.strangerKey);

      const request = await f.submit("feature/topic");
      const audit = f.queue.baseAuditForRequest(request.id)!;
      expect(audit).toMatchObject({
        status: "unexpected",
        base_sha: git(f.repo, ["rev-parse", "main"]),
        baseline_sha: baseline,
        checked_commits: 3,
        truncated: false,
        missing_merges: [],
      });
      expect(audit.unexpected).toEqual([
        { sha: stranger, subject: "Commit signed by another key", signer: f.strangerFingerprint, reason: "other_signer" },
        { sha: unsigned, subject: "Unsigned direct commit", signer: null, reason: "unsigned" },
      ]);

      // The approved candidate binds the base the request showed, so the
      // warning is enough: approval proceeds to execution.
      await approveFixtureRequest(f.queue, request.id);
      await waitUntil(() => f.calls.length === 1, "the merge executor to run");
    } finally {
      await f.cleanup();
    }
  });

  it("refuses an approval whose base audit had not been shown, then proceeds once it is on the request", async () => {
    const f = fixture();
    try {
      commitOnBranch(f.repo, "feature/landed", { "landed.txt": "landed\n" });
      commitOnBranch(f.repo, "feature/topic", { "topic.txt": "topic\n" });
      advanceMainViaAuthorizedMerge(f.db, f.repo, "feature/landed", "merge-landed");
      const unsigned = directCommit(f.repo, "unsigned.txt", "Unsigned direct commit", "none");
      const request = await f.submit("feature/topic");
      // A request whose stored audit predates this base (or never existed).
      f.db.prepare("DELETE FROM auth_base_audits WHERE auth_request_id = ?").run(request.id);

      const refusal = approveFixtureRequest(f.queue, request.id);
      await expect(refusal).rejects.toThrow(new RegExp(`${unsigned.slice(0, 10)} Unsigned direct commit \\(unsigned\\)`));
      expect((await f.queue.getRequest(request.id))?.status).toBe("pending");
      expect(f.calls).toHaveLength(0);
      expect(storedAudit(f.db, request.id)?.unexpected.map((commit: { sha: string }) => commit.sha)).toEqual([unsigned]);

      await approveFixtureRequest(f.queue, request.id);
      await waitUntil(() => f.calls.length === 1, "the merge executor to run");
    } finally {
      await f.cleanup();
    }
  });

  it("reports a recorded Mandible merge that the protected branch no longer contains", async () => {
    const f = fixture();
    try {
      commitOnBranch(f.repo, "feature/first", { "first.txt": "first\n" });
      commitOnBranch(f.repo, "feature/second", { "second.txt": "second\n" });
      commitOnBranch(f.repo, "feature/topic", { "topic.txt": "topic\n" });
      const first = advanceMainViaAuthorizedMerge(f.db, f.repo, "feature/first", "merge-first");
      const second = advanceMainViaAuthorizedMerge(f.db, f.repo, "feature/second", "merge-second");
      f.db.prepare("UPDATE auth_requests SET resolved_at = 200 WHERE id = 'merge-second'").run();
      git(f.repo, ["reset", "--hard", first]);

      const request = await f.submit("feature/topic");
      expect(f.queue.baseAuditForRequest(request.id)).toMatchObject({
        status: "unexpected", baseline_sha: first, unexpected: [], missing_merges: [second],
      });
    } finally {
      await f.cleanup();
    }
  });
});
