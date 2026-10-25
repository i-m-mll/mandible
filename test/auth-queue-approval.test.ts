import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { publishFixtureExecution, approveFixtureRequest } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Approval: execution mode, preflight reuse, native hooks, delegated leases.
 *
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { waitUntil } from "./helpers/wait-until.js";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { setDb } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { addCredential, addDelegatedSigningLease, createUser } from "../src/users/store.js";
import { MERGE_CHANGE_MESSAGE } from "./helpers/auth-delivery-fixtures.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { createLedgerIssue as createSharedLedgerIssue, createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";
import { advanceMainViaAuthorizedMerge, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, createQueue, executionEvidenceChain, git, registerTestDelegatedLease, registerWorkRepo, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

function createMigratedDbWithAgent() {
  return createSharedMigratedDb({
    operator: { slug: "cmd-norm-operator", display_name: "Cmd Norm Operator" },
    agent: { slug: "cmd-norm-agent", display_name: "Cmd Norm Agent", sessionEnv: "cmd-norm-session" },
  });
}

describe("auth queue", () => {

  it("executes from the re-resolved target root with verified credential-signature evidence", async () => {
    const repo = createAuthCheckRepo();
    const featureWorktree = uniqueMissingPath("mandible-auth-approval");
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const cwds: Array<string | null | undefined> = [];
    try {
      git(repo, ["worktree", "add", "-b", "feature/signed-interactive", featureWorktree]);
      git(featureWorktree, ["commit", "--allow-empty", "-m", "typed trailer\n\nMandible-Issue: abc1234"]);
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "ssh_key");
      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        executor: async (options) => {
          cwds.push(options.cwd);
          expect(options.mandibleArgs).toEqual(["auth", "merge", "feature/signed-interactive", "--into", "main"]);
          return publishFixtureExecution(queue, options);
        },
        hookManager: createNoopHookManager(),
      });

      // Submitted from the feature worktree; executed from the protected root.
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(featureWorktree, ["rev-parse", "feature/signed-interactive"]),
        type: "merge",
        command: "mandible auth merge feature/signed-interactive --into main",
        title: "Merge signed interactive",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/signed-interactive",
        cwd: featureWorktree,
      }));
      const approved = await approveFixtureRequest(queue, request.id);
      expect(approved.cwd).toBe(fs.realpathSync(repo));
      const resolved = await waitForStatus(queue, request.id, "completed");
      expect(cwds).toEqual([fs.realpathSync(repo)]);
      expect(resolved).toMatchObject({ requested_by_user_id: signing.operatorId, approved_by_user_id: signing.operatorId });
      const chain = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(chain.signature).toMatchObject({
        evidence_method: "credential_signature",
        credential_id: signing.credentialId,
      });
      const signatureDetails = JSON.parse(chain.signature.details_json);
      expect(signatureDetails).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
        authorization_evidence_method: "credential_signature",
      });
      expect(signatureDetails.commit_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(signatureDetails.target_head_sha).toBe(signatureDetails.commit_sha);
      expect(chain.authorization.evidence_method).toBe("credential_signature");
      expect(queue.getSignatureVerification(request.id)).toMatchObject({
        verified: true,
        credential_id: signing.credentialId,
        user_id: signing.operatorId,
      });
      await waitUntil(() => events.some(event => event.event === "auth:resolved" && (event.data as { request_id?: string }).request_id === request.id), "the resolved lifecycle event");
      const resolvedEvent = events.findLast((event) => event.event === "auth:resolved");
      expect(resolvedEvent?.data).toMatchObject({
        execution_evidence_id: resolved!.execution_evidence_id,
        signature_verification: {
          verified: true,
          credential_id: signing.credentialId,
          user_id: signing.operatorId,
        },
      });
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("binds the reviewed base while rerunning preflight after queue fingerprint drift", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/fingerprint-first", { "first.txt": "first\n" });
      commitOnBranch(repo, "feature/fingerprint-second", { "second.txt": "second\n" });
      registerWorkRepo(db, repo);
      const nativeHook = path.join(repo, ".git", "hooks", "post-merge");
      writeFile(repo, path.relative(repo, nativeHook), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(nativeHook, 0o755);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
          return { exit_code: 1, output: "fixture stop\n" };
        },
        hookManager: createNoopHookManager(),
      });
      const first = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", "feature/fingerprint-first"]),
        type: "merge",
        command: "mandible auth merge feature/fingerprint-first --into main",
        title: "Merge feature/fingerprint-first",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/fingerprint-first",
        cwd: repo,
      }));
      const reviewedBase = first.merge_preflight_base_sha!;
      (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", "feature/fingerprint-second"]),
        type: "merge",
        command: "mandible auth merge feature/fingerprint-second --into main",
        title: "Merge feature/fingerprint-second",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/fingerprint-second",
        cwd: repo,
      }));

      await approveFixtureRequest(queue, first.id);
      await waitForStatus(queue, first.id, "failed");

      expect(calls).toHaveLength(1);
      expect(calls[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(reviewedBase);
      expect(calls[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBeUndefined();
      expect(git(repo, ["rev-parse", "main"])).toBe(reviewedBase);
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recomputes a stale pinned candidate on approve after an authorized sibling merge", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/base-drift", { "feature.txt": "feature\n" });
      commitOnBranch(repo, "feature/sibling", { "sibling.txt": "sibling\n" });
      registerWorkRepo(db, repo);
      git(repo, ["config", "core.hooksPath", ".git/hooks"]);
      configureSigningCredential(db, repo, "ssh_key");

      const queue = new AuthQueue({
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

      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/base-drift --into main",
        title: "Merge feature/base-drift",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-drift",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-drift"]),
        cwd: repo,
      }));
      const originalPin = request.merge_candidate_pin_sha;
      const originalBase = request.merge_preflight_base_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);
      // Genuine authorized queue merge: signed merge commit + completed
      // request recording it (review F1 — raw SHA movement is refused now).
      const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-sibling");
      expect(newBase).not.toBe(originalBase);

      const approved = await approveFixtureRequest(queue, request.id);
      expect(approved.status).toBe("executing");
      await waitForStatus(queue, request.id, "failed");

      expect(calls).toHaveLength(1);
      const env = calls[0]!;
      // Fresh preflight reuse against the recomputed base.
      expect(env.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(env.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(newBase);
      // Fresh candidate pin: base parent moved, pin sha replaced.
      expect(env.MANDIBLE_AUTH_CANDIDATE_BASE_SHA).toBe(newBase);
      expect(env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).toMatch(/^[0-9a-f]{40,64}$/);
      expect(env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).not.toBe(originalPin);
      expect(git(repo, ["rev-parse", `${env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA}^1`])).toBe(newBase);
      expect(git(repo, ["rev-parse", `${env.MANDIBLE_AUTH_CANDIDATE_PIN_SHA}^2`]))
        .toBe(request.merge_head_sha);
      // Review F3 — the reviewed head accompanies every daemon-started merge.
      expect(env.MANDIBLE_AUTH_EXPECTED_HEAD_SHA).toBe(request.merge_head_sha);
      // Atomic mode re-evaluated with the fresh pin.
      expect(env.MANDIBLE_AUTH_ATOMIC).toBe("1");
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails approval with conflict context when the recomputed candidate conflicts", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: string[] = [];
    try {
      commitOnBranch(repo, "feature/base-conflict", { "shared.txt": "feature\n" });
      commitOnBranch(repo, "feature/conflicting-sibling", { "shared.txt": "conflicting main change\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");

      const queue = new AuthQueue({
        db,
        executor: async () => {
          calls.push("called");
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: "",
            output: "",
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/base-conflict --into main",
        title: "Merge feature/base-conflict",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-conflict",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-conflict"]),
        cwd: repo,
      }));
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      // Authorized queue merge whose content conflicts with the reviewed head:
      // provenance passes, the recomputed candidate does not merge cleanly.
      advanceMainViaAuthorizedMerge(db, repo, "feature/conflicting-sibling", "merge-conflicting");

      let thrown: unknown;
      try {
        await approveFixtureRequest(queue, request.id);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AuthQueueError);
      const authError = thrown as AuthQueueError;
      expect(authError.code).toBe("merge_check_failed");
      expect(authError.message).toContain("conflicts with the target branch");
      expect(authError.message).toContain("shared.txt");
      expect(authError.details).toBeDefined();
      expect((await queue.getRequest(request.id))?.status).toBe("pending");
      expect(calls).toHaveLength(0);
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("enables atomic execution only for fresh single-source requests without native hooks", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/atomic-eligibility", { "atomic.txt": "atomic\n" });
      registerWorkRepo(db, repo);
      git(repo, ["config", "core.hooksPath", ".git/hooks"]);
      configureSigningCredential(db, repo, "ssh_key");
      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          envs.push(options.env);
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
      const submit = async (suffix: string) => (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/atomic-eligibility --into main",
        title: `Atomic eligibility ${suffix}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/atomic-eligibility",
        merge_head_sha: git(repo, ["rev-parse", "feature/atomic-eligibility"]),
        cwd: repo,
      }));

      const ordinary = (await submit("ordinary"));
      await approveFixtureRequest(queue, ordinary.id);
      await waitForStatus(queue, ordinary.id, "failed");
      expect(envs.at(-1)?.MANDIBLE_AUTH_ATOMIC).toBe("1");
      expect((await queue.getRequest(ordinary.id))?.merge_candidate_pin_sha).toBeTruthy();

      const hook = path.join(repo, ".git", "hooks", "pre-merge-commit");
      fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const hooked = (await submit("hooked"));
      await expect(approveFixtureRequest(queue, hooked.id)).rejects.toThrow(/unsupported native hooks/);
      expect((await queue.getRequest(hooked.id))?.status).toBe('pending');
      expect(envs).toHaveLength(1);
      fs.rmSync(hook);

      const rejected = (await submit("rejected"));
      const rejectedPin = rejected.merge_candidate_pin_sha!;
      (await queue.reject(rejected.id));
      expect((await queue.getRequest(rejected.id))?.merge_candidate_pin_sha).toBeNull();
      expect(() => git(repo, ["cat-file", "-e", `${rejectedPin}^{commit}`])).not.toThrow();
      expect(() => git(repo, ["rev-parse", `refs/mandible/auth-candidates/${rejected.id}`])).toThrow();
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects daemon auth merge approval before spawning when context is incomplete", async () => {
    const calls: string[] = [];
    const queue = createQueue({
      executor: async () => {
        calls.push("called");
        return {
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          output: "",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
    });

    const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
      command: "mandible auth merge feature/no-context --into main",
      title: "No context",
    }));

    await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("does not globally auto-approve new requests while a delegated lease is active", async () => {
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-1");
    const queue = new AuthQueue({
      db,
      autoApprover: {
        getActiveApprovalContext: () => ({
          source: "auto_lease",
          leaseId: "lease-1",
          approverUserId,
          env: {
            SSH_AUTH_SOCK: "/tmp/mandible-agent.sock",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
          },
        }),
      },
      executor: async (options) => {
        calls.push(options.env);
        return {
          exit_code: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          output: "ok\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
    });

    const request = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon",
    }));

    expect(request.status).toBe("pending");
    expect(request.approval_source).toBe("manual");
    expect(request.approval_lease_id).toBeNull();
    expect(calls).toHaveLength(0);
    (await queue.dispose());
    db.close();
  });

  it("records delegated_lease execution evidence for an explicit delegated approval", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-reuse");
    try {
      commitOnBranch(repo, "feature/lease-reuse", { "reuse.txt": "reuse\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "delegated_ssh_key");
      db.prepare("UPDATE delegated_signing_leases SET credential_id = ? WHERE id = 'lease-reuse'").run(signing.credentialId);
      const delegatedApproval = {
        source: "auto_lease" as const,
        leaseId: "lease-reuse",
        approverUserId,
        env: {
          SSH_AUTH_SOCK: "/tmp/reused.sock",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.signingkey",
          GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
        },
      };
      const queue = new AuthQueue({
        db,
        autoApprover: {
          getActiveApprovalContext: () => delegatedApproval,
        },
        executor: async (options) => {
          expect((await queue.getRequest(options.request_id))?.execution_evidence_id).toBeNull();
          return publishFixtureExecution(queue, options);
        },
        hookManager: createNoopHookManager(),
      });

      const submitted = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", "feature/lease-reuse"]),
        type: "merge",
        command: "mandible auth merge feature/lease-reuse --into main",
        title: "Merge feature/lease-reuse",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/lease-reuse",
        cwd: repo,
      }));
      expect(submitted.status).toBe("pending");
      (await queue.approve(submitted.id, delegatedApproval));
      const resolved = await waitForStatus(queue, submitted.id, "completed");
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: true,
        authorization_evidence_method: "delegated_lease",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "delegated_lease",
        lease_id: "lease-reuse",
      });
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: approverUserId,
      });
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps manual approval on the direct path when delegated signing is configured", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "presence-1");
    const order: string[] = [];
    const events: SseEvent[] = [];
    try {
      commitOnBranch(repo, "feature/presence", { "presence.txt": "presence\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        autoApprover: {
          getActiveApprovalContext: () => null,
          getDelegatedSigningStatus: () => ({
            provider: "yubikey-age",
            configured: true,
            public_key: "ssh-ed25519 delegated",
            public_key_path: "/tmp/delegated.pub",
            encrypted_passphrase_path: "/tmp/delegated.age",
            recipient_path: "/tmp/recipient.txt",
            missing_tools: [],
          }),
          presenceChallenge: async () => {
            order.push("challenge");
            throw new Error("manual approval must not request delegated presence");
          },
        },
        executor: async (options) => {
          order.push("executor");
          expect((await queue.getRequest(options.request_id))?.execution_evidence_id).toBeTruthy();
          expect(options.env?.SSH_AUTH_SOCK).toBeUndefined();
          expect(options.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
          return publishFixtureExecution(queue, options);
        },
        hookManager: createNoopHookManager(),
      });

      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", "feature/presence"]),
        type: "merge",
        command: "mandible auth merge feature/presence --into main",
        title: "Merge feature/presence",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/presence",
        cwd: repo,
      }));
      await approveFixtureRequest(queue, request.id);
      const resolved = await waitForStatus(queue, request.id, "completed");

      expect(order).toEqual(["executor"]);
      expect(resolved?.approval_source).toBe("manual");
      expect(resolved?.approval_lease_id).toBeNull();
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: true,
        authorization_evidence_method: "credential_signature",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "credential_signature",
        lease_id: null,
      });
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: approverUserId,
      });
      const output = events
        .filter((event) => event.event === "auth:output")
        .map((event) => ((event.data as { text?: string }).text ?? ""))
        .join("");
      expect(output).not.toContain("waiting for YubiKey touch");
      expect(output).not.toContain("delegated signing key ready");
      (await queue.dispose());
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "presence-missing", /lease is missing/],
    ["expired", "presence-expired", /not currently valid/],
  ] as const)(
    "rejects a %s explicit delegated lease with SSH_AUTH_SOCK before execution",
    async (kind, leaseId, expectedError) => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const now = Date.now();
      const operatorId = registerTestDelegatedLease(db, "presence-valid", now);
      if (kind === "expired") {
        db.prepare(
          "UPDATE delegated_signing_leases SET id = ?, expires_at = ? WHERE id = 'presence-valid'",
        ).run(leaseId, now - 1);
      }
      let executed = false;
      try {
        commitOnBranch(repo, `feature/${kind}-lease`, { [`${kind}.txt`]: `${kind}\n` });
        registerWorkRepo(db, repo);
        const queue = new AuthQueue({
          db,
          now: () => now,
          executor: async () => {
            executed = true;
            throw new Error("executor must not run");
          },
          hookManager: createNoopHookManager(),
        });
        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", `feature/${kind}-lease`]),
          type: "merge",
          command: `mandible auth merge feature/${kind}-lease --into main`,
          title: `${kind} delegated lease`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/${kind}-lease`,
          cwd: repo,
        }));

        await expect((async () => (await queue.approve(request.id, {
          source: "auto_lease",
          leaseId,
          approverUserId: operatorId,
          env: { SSH_AUTH_SOCK: `/tmp/${kind}.sock` },
        }))())).rejects.toThrow(expectedError);
        expect((await queue.getRequest(request.id))?.status).toBe("pending");
        expect(executed).toBe(false);
        (await queue.dispose());
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each(["approver", "lease"] as const)(
    "rejects a refreshed delegated signing %s that differs from the approved request",
    async (mismatch) => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const operatorId = registerTestDelegatedLease(db, "presence-valid");
      const other = createUser(db, {
        slug: `presence-other-${mismatch}`,
        kind: "human",
        display_name: "Other Presence User",
      });
      const otherCredential = addCredential(db, other.id, {
        type: "delegated_ssh_key",
        fingerprint: `SHA256:${"B".repeat(43)}`,
        public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"B".repeat(20)} other`,
      });
      addDelegatedSigningLease(db, {
        id: "presence-other-lease",
        credential_id: otherCredential.id,
        owner_user_id: other.id,
        minted_at: Date.now() - 1000,
        expires_at: Date.now() + 60_000,
        mint_method: "fresh_presence",
      });
      let executed = false;
      try {
        commitOnBranch(repo, `feature/presence-${mismatch}`, { [`${mismatch}.txt`]: `${mismatch}\n` });
        registerWorkRepo(db, repo);
        const queue = new AuthQueue({
          db,
          autoApprover: {
            getActiveApprovalContext: () => null,
            getDelegatedSigningStatus: () => ({
              provider: "yubikey-age",
              configured: true,
              public_key: "ssh-ed25519 delegated",
              public_key_path: "/tmp/delegated.pub",
              encrypted_passphrase_path: "/tmp/delegated.age",
              recipient_path: "/tmp/recipient.txt",
              missing_tools: [],
            }),
            presenceChallenge: async () => ({
              source: "presence_challenge",
              leaseId: mismatch === "lease" ? "presence-other-lease" : "presence-valid",
              approverUserId: mismatch === "approver" ? other.id : operatorId,
              env: { SSH_AUTH_SOCK: "/tmp/wrong-presence.sock" },
            }),
          },
          executor: async () => {
            executed = true;
            throw new Error("executor must not run");
          },
          hookManager: createNoopHookManager(),
        });
        const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  merge_head_sha: git(repo, ["rev-parse", `feature/presence-${mismatch}`]),
          type: "merge",
          command: `mandible auth merge feature/presence-${mismatch} --into main`,
          title: `Presence ${mismatch} mismatch`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/presence-${mismatch}`,
          cwd: repo,
        }));
        (await queue.approve(request.id, {
          source: "presence_challenge",
          leaseId: "presence-valid",
          approverUserId: operatorId,
          env: {},
        }));
        const failed = await waitForStatus(queue, request.id, "failed");
        expect(executed).toBe(false);
        expect(failed.error).toMatch(mismatch === "approver" ? /approver does not match/ : /lease is not valid/);
        (await queue.dispose());
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  // Issue 08a5f04 — channel-tool submissions through the route: the legacy
  // single-source shape (no base_branch) is rewritten to the canonical command
  // at POST, never at approval, and both it and the canonical form approve.
  it("normalizes channel-tool merge submissions at POST so approval accepts them", async () => {
    const repo = fs.realpathSync(createAuthCheckRepo());
    const db = createMigratedDbWithAgent();
    setDb(db);
    const branches = ["feature/channel-legacy", "feature/channel-canonical"];
    for (const branch of branches) {
      git(repo, ["checkout", "-b", branch, "main"]);
      writeFile(repo, `${branch.replace(/\//g, "_")}.txt`, `${branch}\n`);
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", `work on ${branch}\n\nMandible-Issue: abc1234`]);
      git(repo, ["checkout", "main"]);
    }
    const agent = db.prepare("SELECT id, slug FROM users WHERE slug = 'cmd-norm-agent'").get() as { id: string; slug: string };
    const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "cmd-norm-channel" });
    const project = resolveProjectForCheckout(db, {
      root: repo, name: path.basename(repo), workRepoId: path.basename(repo), defaultBranch: "main",
    });
    registerWorkRepo(db, repo);
    const issue = createSharedLedgerIssue(db, {
      project_id: project.project.id,
      title: "Command normalization delivery",
      aliases: [{ alias_kind: "git_bug_short", alias: "abc1234" }],
    });
    for (const branch of branches) {
      db.prepare(
        `INSERT INTO work_units
          (id, issue_id, repo_id, branch, kind, state, created_at, activated_at, last_commit_at,
           ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
         VALUES (?, 'abc1234', ?, ?, 'solo', 'committed', 1, 1, 1, ?, ?, ?, 1)`,
      ).run(`wu-${branch}`, project.project.id, branch, issue.id, agent.id, credential.id);
    }
    const router = authenticatedTestRouter(agent, { credentialId: credential.id });
    const queue = new AuthQueue({
      db,
      executor: async () => ({
        exit_code: 1, signal: null, stdout: "", stderr: "fixture stop\n", output: "fixture stop\n",
        started_at: Date.now(), finished_at: Date.now(),
      }),
      hookManager: createNoopHookManager(),
    });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    try {
      const submissions = [
        { command: "mandible auth merge feature/channel-legacy", head_branch: "feature/channel-legacy" },
        { command: "mandible auth merge feature/channel-canonical --into main", head_branch: "feature/channel-canonical", base_branch: "main" },
      ];
      for (const submission of submissions) {
        const result = await router.invoke({
          method: "POST",
          url: "/api/auth/request",
          body: {
            ...MERGE_CHANGE_MESSAGE,
            ...submission,
            title: `Merge ${submission.head_branch}`,
            cwd: repo,
            session_id: "cmd-norm-session",
            issue_references: ["abc1234"],
          },
        });
        expect(result.status, JSON.stringify(result.body)).toBe(201);
        const requestId = (result.body as { request_id: string }).request_id;
        expect((await queue.getRequest(requestId))).toMatchObject({
          base_branch: "main",
          command: `mandible auth merge ${submission.head_branch} --into main`,
        });
        expect((await approveFixtureRequest(queue, requestId)).status).toBe("executing");
        await waitForStatus(queue, requestId, "failed");
      }
    } finally {
      (await queue.dispose());
      db.close();
    }
  });
});
