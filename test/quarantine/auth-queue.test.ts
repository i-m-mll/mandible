// Quarantined: 4360464 — the delegated lease never reaches completed.
//
// Issue 9e40a31: this file used to carry its own 178-line copy of the
// auth-queue helpers. It now consumes the same shared fixture as the nine
// default-gate successors, so a quarantined case cannot silently drift away
// from the construction the gate actually exercises.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue } from "../../src/auth-queue.js";
import { addDelegatedSigningLease } from "../../src/users/store.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, executionEvidenceChain, git, registerWorkRepo, waitForStatus } from "../helpers/auth-queue-fixtures.js";

describe("auth queue", () => {

  // Integration reconciliation (issue 93d978e) — a transient git failure while
  // building the ancestry batch must not tombstone genuinely merged snapshots.

  it("composes delegated lease authorization with verified delegated-key evidence", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const now = Date.now();
    try {
      commitOnBranch(repo, "feature/signed-delegated", { "delegated.txt": "delegated\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "delegated_ssh_key");
      addDelegatedSigningLease(db, {
        id: "verified-delegated-lease",
        credential_id: signing.credentialId,
        owner_user_id: signing.operatorId,
        minted_at: now - 1000,
        expires_at: now + 60_000,
        mint_method: "reused_lease",
      });
      const queue = new AuthQueue({
        db,
        autoApprover: {
          getActiveApprovalContext: () => ({
            source: "auto_lease",
            leaseId: "verified-delegated-lease",
            approverUserId: signing.operatorId,
            env: { SSH_AUTH_SOCK: "/tmp/test-delegated.sock" },
          }),
        },
        executor: async (options) => {
          git(options.cwd!, ["merge", "--no-ff", "--no-edit", "-S", "feature/signed-delegated"]);
          const mergeSha = git(options.cwd!, ["rev-parse", "HEAD"]);
          const output = `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
          options.onOutput?.({
            request_id: options.request_id,
            stream: "stderr",
            text: output,
            timestamp: now,
          });
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: output,
            output,
            started_at: now,
            finished_at: now,
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/signed-delegated --into main",
        title: "Merge signed delegated",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/signed-delegated",
        cwd: repo,
      });
      const resolved = await waitForStatus(queue, request.id, "completed");
      const chain = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(JSON.parse(chain.signature.details_json)).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
        authorization_evidence_method: "delegated_lease",
      });
      expect(chain.authorization).toMatchObject({
        evidence_method: "delegated_lease",
        lease_id: "verified-delegated-lease",
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // Issue 08a5f04 — pure base drift no longer blocks approval when the base
  // transition is fully accounted for by an authorized queue merge: the stale
  // candidate is recomputed against the current base within the same approval
  // action, re-pinned, and atomic mode is re-evaluated with the fresh pin.

  // Issue 08a5f04 — after a sibling merge advances the base, clean pending
  // candidates are proactively re-preflighted, re-pinned, and broadcast so
  // approval hits the exact-candidate fast path.

  // Issue 08a5f04 (review F5/F6) — fail-closed guards around candidate
  // recompute: pin corruption, unaccounted or rewritten base transitions,
  // command mutation, pin-cache failure, remote requests, and races between
  // provenance verification and re-pinning.

  // Bug: 297677f — issues field tests

  // Bug: 93c57c4 — outcome field tests

  // Bug: 929c6d0 — error output in resolved payload and error field

  // Bug: 03d6cb0 — self-rebuild delay: auth:resolved must broadcast BEFORE
  // the daemon schedules a process.exit for self-merges.

  // Bug: 0de95bf — history list projection.

  // Bug: 681739e — a self-merge restart must not kill chained executions. While
  // the restart is pending, admission is closed (new executions park instead of
  // starting), and the shutdown instant is recorded so the respawned daemon
  // fast-recovers any orphaned execution instead of waiting out the multi-minute
  // stuck-request threshold.

});

// Issue ded17e6 — per-repo execution chains keyed on canonical Git identity,
// canonical work-unit / dedupe matching, and self-merge drain.

