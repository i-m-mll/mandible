import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { approveFixtureRequest } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Base-transition merge provenance: signature evidence, octopus merges, commit-DAG depth.
 *
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { Db } from "../src/db.js";
import { addAttributionEvidence, addCredential, createUser } from "../src/users/store.js";
import { advanceMainViaAuthorizedMerge, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, git, insertSiblingMergeRequest, mergeResultOutput, registerWorkRepo, signedMergeIntoMain, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

describe("auth queue", () => {
  describe("candidate recompute fail-closed guards", () => {
    const STRICT_MESSAGE = /Reviewed merge inputs or retained candidate changed; requeue and reapprove/;

    function createGuardQueue(db: Db, calls: Array<NodeJS.ProcessEnv | undefined>): AuthQueue {
      return new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
          return {
            exit_code: 1,
            signal: null,
            stdout: "",
            stderr: "fixture stop\n",
            output: "fixture stop\n",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });
    }

    function submitPinnedRequest(
      queue: AuthQueue,
      repo: string,
      headBranch: string,
      command = `mandible auth merge ${headBranch} --into main`,
    ) {
      const request = queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command,
        title: `Merge ${headBranch}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: headBranch,
        merge_head_sha: git(repo, ["rev-parse", headBranch]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      return request;
    }

    // Issue 08a5f04 (review F1 pass 2) — output-append forgery: an unrecorded
    // base advance cannot be laundered into provenance by appending a forged
    // MANDIBLE_MERGE_RESULT marker to a resolved request.
    it("refuses post-completion output-append forgery as merge provenance", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/forge-target", { "ft.txt": "ft\n" });
        commitOnBranch(repo, "feature/rogue", { "rg.txt": "rg\n" });
        commitOnBranch(repo, "feature/decoy", { "dc.txt": "dc\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/forge-target");
        // Signed but UNRECORDED base advance (no completed queue request).
        const newBase = signedMergeIntoMain(repo, "feature/rogue");
        // A completed request exists for the attacker to target, but its
        // output carries no marker for this merge.
        insertSiblingMergeRequest(db, repo, "forge-decoy", "feature/decoy", "completed");
        db.prepare("UPDATE auth_requests SET exit_code = 0, resolved_at = 100 WHERE id = ?")
          .run("forge-decoy");

        // The append is refused by the lifecycle lock…
        expect(() => queue.appendOutput("forge-decoy", mergeResultOutput(newBase)))
          .toThrow(/only be appended while a request is executing/);
        // …and the transition stays unaccounted, so approval fails strict.
        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — structured signature evidence is the
    // authoritative merge-SHA record: a forged output marker on a row that
    // carries evidence is ignored, and evidence without a valid SHA never
    // falls back to the marker.
    it("matches provenance against structured signature evidence, not the output marker", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/ev-a", { "eva.txt": "a\n" });
        commitOnBranch(repo, "feature/ev-b", { "evb.txt": "b\n" });
        commitOnBranch(repo, "feature/ev-sib-1", { "evs1.txt": "s1\n" });
        commitOnBranch(repo, "feature/ev-sib-2", { "evs2.txt": "s2\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");

        const first = submitPinnedRequest(queue, repo, "feature/ev-a");
        const second = submitPinnedRequest(queue, repo, "feature/ev-b");

        // Authorized advance whose structured evidence records the genuine
        // merge SHA while the output marker is forged to a different SHA.
        const base1 = advanceMainViaAuthorizedMerge(db, repo, "feature/ev-sib-1", "merge-ev-1");
        const genuineEvidence = addAttributionEvidence(db, {
          evidence_method: "credential_signature",
          details: { auth_request_id: "merge-ev-1", commit_sha: base1, verified: true },
        });
        db.prepare("UPDATE auth_requests SET execution_evidence_id = ?, output = ? WHERE id = ?")
          .run(genuineEvidence.id, mergeResultOutput("f".repeat(40)), "merge-ev-1");

        await approveFixtureRequest(queue, first.id);
        await waitForStatus(queue, first.id, "completed");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(base1);

        // Authorized advance whose structured evidence lacks a valid SHA: the
        // structured record is authoritative, so the genuine output marker on
        // the same row must NOT rescue it.
        advanceMainViaAuthorizedMerge(db, repo, "feature/ev-sib-2", "merge-ev-2");
        const shaLessEvidence = addAttributionEvidence(db, {
          evidence_method: "credential_signature",
          details: { auth_request_id: "merge-ev-2", verified: true },
        });
        db.prepare("UPDATE auth_requests SET execution_evidence_id = ? WHERE id = ?")
          .run(shaLessEvidence.id, "merge-ev-2");

        await expect(approveFixtureRequest(queue, second.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(second.id)?.status).toBe("pending");
        expect(calls).toHaveLength(1);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — a merge SHA claimed by two completed
    // requests is reuse/forgery evidence and disqualifies the transition.
    it("refuses provenance when two completed requests claim the same merge commit", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/reuse-target", { "rt.txt": "rt\n" });
        commitOnBranch(repo, "feature/reuse-sib", { "rs.txt": "rs\n" });
        commitOnBranch(repo, "feature/reuse-decoy", { "rd.txt": "rd\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/reuse-target");
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/reuse-sib", "merge-reuse-1");
        // Second completed request claiming the SAME merge SHA in its output.
        insertSiblingMergeRequest(db, repo, "merge-reuse-2", "feature/reuse-decoy", "completed");
        db.prepare(
          "UPDATE auth_requests SET exit_code = 0, resolved_at = 100, merge_finalized_at = 100, output = ? WHERE id = ?",
        ).run(mergeResultOutput(newBase), "merge-reuse-2");

        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — octopus merges (3+ parents) are never
    // queue merges; the ^1/^2 probes alone would have accepted them.
    it("refuses provenance for an octopus merge commit on the base transition", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/octo-target", { "ot.txt": "ot\n" });
        commitOnBranch(repo, "feature/octo-1", { "o1.txt": "o1\n" });
        commitOnBranch(repo, "feature/octo-2", { "o2.txt": "o2\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = submitPinnedRequest(queue, repo, "feature/octo-target");
        // Signed octopus merge: first parent main, then octo-1 AND octo-2.
        insertSiblingMergeRequest(db, repo, "merge-octo", "feature/octo-1", "completed");
        git(repo, ["checkout", "main"]);
        git(repo, ["merge", "--no-ff", "--no-edit", "-S", "feature/octo-1", "feature/octo-2"]);
        const octoSha = git(repo, ["rev-parse", "main"]);
        expect(git(repo, ["show", "-s", "--format=%P", octoSha]).split(/\s+/)).toHaveLength(3);
        db.prepare(
          "UPDATE auth_requests SET exit_code = 0, resolved_at = 100, merge_finalized_at = 100, output = ? WHERE id = ?",
        ).run(mergeResultOutput(octoSha), "merge-octo");

        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F1 pass 2) — the chain-commit signature must
    // verify against the approving user's credentials specifically; another
    // registered user's trusted signature does not qualify.
    it("refuses provenance signed by a registered credential that is not the approver's", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/signer-target", { "st.txt": "st\n" });
        commitOnBranch(repo, "feature/signer-sib", { "ss.txt": "ss\n" });
        registerWorkRepo(db, repo);
        const operatorSigning = configureSigningCredential(db, repo, "ssh_key");

        // Second ACTIVE registered user with their own real signing key.
        const outsider = createUser(db, {
          slug: "provenance-outsider",
          kind: "human",
          display_name: "Provenance Outsider",
        });
        const outsiderKeyPath = path.join(repo, ".outsider-signing-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", outsiderKeyPath]);
        const outsiderFingerprint = execFileSync(
          "ssh-keygen", ["-lf", `${outsiderKeyPath}.pub`, "-E", "sha256"], { encoding: "utf8" },
        ).trim().split(/\s+/)[1]!;
        addCredential(db, outsider.id, {
          type: "ssh_key",
          fingerprint: outsiderFingerprint,
          public_material: fs.readFileSync(`${outsiderKeyPath}.pub`, "utf8").trim(),
        });

        const request = submitPinnedRequest(queue, repo, "feature/signer-target");
        // Sibling merge recorded with the operator as approver but signed by
        // the outsider's (registered, trusted) key.
        git(repo, ["config", "user.signingkey", outsiderKeyPath]);
        advanceMainViaAuthorizedMerge(db, repo, "feature/signer-sib", "merge-outsider-signed");
        git(repo, ["config", "user.signingkey", operatorSigning.keyPath]);

        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F6) — a transition of several authorized merges
    // recomputes; a transition longer than the walk bound is refused by its
    // length before any per-commit verification.
    it("accepts a multi-merge authorized transition and refuses an over-long one", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/multi", { "multi.txt": "multi\n" });
        commitOnBranch(repo, "feature/long", { "long.txt": "long\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");

        const multi = submitPinnedRequest(queue, repo, "feature/multi");
        const long = submitPinnedRequest(queue, repo, "feature/long");

        let base = "";
        for (let index = 1; index <= 3; index += 1) {
          commitOnBranch(repo, `feature/chain-${index}`, { [`chain-${index}.txt`]: `${index}\n` });
          base = advanceMainViaAuthorizedMerge(db, repo, `feature/chain-${index}`, `merge-chain-${index}`);
        }

        await approveFixtureRequest(queue, multi.id);
        await waitForStatus(queue, multi.id, "completed");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(base);

        for (let index = 0; index < 33; index += 1) {
          git(repo, ["commit", "--allow-empty", "-m", `direct ${index}`]);
        }
        const refusal = approveFixtureRequest(queue, long.id);
        await expect(refusal).rejects.toThrow(STRICT_MESSAGE);
        await expect(refusal).rejects.toThrow(/beyond the cap for automatic attestation/);
        expect(queue.getRequest(long.id)?.status).toBe("pending");
        expect(calls).toHaveLength(1);
      } finally {
        queue.dispose();
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
