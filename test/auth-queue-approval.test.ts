/**
 * @vitest-environment node
 *
 * Approval: execution mode, preflight reuse, native hooks, delegated leases.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import type { SseEvent } from "../src/types.js";
import { addCredential, addDelegatedSigningLease, createUser, getOperator } from "../src/users/store.js";
import { advanceMainViaAuthorizedMerge, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, createQueue, executionEvidenceChain, git, registerTestDelegatedLease, registerWorkRepo, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

describe("auth queue", () => {
  it("executes in daemon mode", async () => {
    const calls: string[] = [];
    const executor = async () => {
      calls.push("called");
      return {
        exit_code: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        output: "ok\n",
        started_at: Date.now(),
        finished_at: Date.now()
      };
    };
    const queue = createQueue({ executor });

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon"
    });

    queue.approve(request.id);
    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("re-resolves daemon auth merge execution cwd before approval", async () => {
    const repo = createAuthCheckRepo();
    const featureWorktree = uniqueMissingPath("mandible-auth-approval");
    const db = createMigratedDb();
    const calls: Array<string | null | undefined> = [];
    try {
      git(repo, ["worktree", "add", "-b", "feature/approval-cwd", featureWorktree]);
      git(featureWorktree, ["commit", "--allow-empty", "-m", "typed trailer\n\nMandible-Issue: abc1234"]);
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.cwd);
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
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/approval-cwd --into main",
        title: "Merge feature/approval-cwd",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/approval-cwd",
        cwd: featureWorktree,
      });

      const approved = queue.approve(request.id);
      expect(approved.cwd).toBe(fs.realpathSync(repo));
      const resolved = await waitForStatus(queue, request.id, "completed");
      expect(calls).toEqual([fs.realpathSync(repo)]);
      const operator = getOperator(db)!;
      expect(resolved).toMatchObject({
        requested_by_user_id: operator.id,
        approved_by_user_id: operator.id,
      });
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "hardware_presence",
      });
      expect(evidence.authorization.evidence_method).toBe("hardware_presence");
      expect(evidence.authorization.lease_id).toBeNull();
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: operator.id,
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(featureWorktree, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("composes interactive approval with verified credential-signature evidence", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    try {
      commitOnBranch(repo, "feature/signed-interactive", { "signed.txt": "signed\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo, "ssh_key");
      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        executor: async (options) => {
          git(options.cwd!, ["merge", "--no-ff", "--no-edit", "-S", "feature/signed-interactive"]);
          const mergeSha = git(options.cwd!, ["rev-parse", "HEAD"]);
          const output = `MANDIBLE_MERGE_RESULT {"merge_sha":"${mergeSha}"}\n`;
          options.onOutput?.({
            request_id: options.request_id,
            stream: "stderr",
            text: output,
            timestamp: Date.now(),
          });
          return {
            exit_code: 0,
            signal: null,
            stdout: "",
            stderr: output,
            output,
            started_at: Date.now(),
            finished_at: Date.now(),
          };
        },
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/signed-interactive --into main",
        title: "Merge signed interactive",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/signed-interactive",
        cwd: repo,
      });
      queue.approve(request.id);
      const resolved = await waitForStatus(queue, request.id, "completed");
      const chain = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(chain.signature).toMatchObject({
        evidence_method: "credential_signature",
        credential_id: signing.credentialId,
      });
      const signatureDetails = JSON.parse(chain.signature.details_json);
      expect(signatureDetails).toMatchObject({
        verified: true,
        signer_user_id: signing.operatorId,
        authorization_evidence_method: "hardware_presence",
      });
      expect(signatureDetails.commit_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(signatureDetails.target_head_sha).toBe(signatureDetails.commit_sha);
      expect(chain.authorization.evidence_method).toBe("hardware_presence");
      expect(queue.getSignatureVerification(request.id)).toMatchObject({
        verified: true,
        credential_id: signing.credentialId,
        user_id: signing.operatorId,
      });
      const resolvedEvent = events.findLast((event) => event.event === "auth:resolved");
      expect(resolvedEvent?.data).toMatchObject({
        execution_evidence_id: resolved!.execution_evidence_id,
        signature_verification: {
          verified: true,
          credential_id: signing.credentialId,
          user_id: signing.operatorId,
        },
      });
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps legacy nullable-cache requests on preflight reuse", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/reuse-preflight", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);

      const queue = new AuthQueue({
        db,
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
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/reuse-preflight --into main",
        title: "Merge feature/reuse-preflight",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/reuse-preflight",
        cwd: repo,
      });
      expect(request.merge_preflight_base_sha).toBe(git(repo, ["rev-parse", "main"]));
      expect(request.merge_preflight_queue_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(request.merge_candidate_pin_sha).toBeNull();

      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(calls[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(request.merge_preflight_base_sha);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("re-establishes the exact original range after a reviewed-head update for a native-hook merge", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const rangeSnapshot = path.join(repo, "hook-range.txt");
    try {
      commitOnBranch(repo, "feature/reviewed-update", { "feature.txt": "first\n" });
      registerWorkRepo(db, repo);

      // An executable native hook keeps this request on the ordinary
      // non-atomic merge path, matching the production lifecycle that exposed
      // the missing original-range base.
      const gitDir = git(repo, ["rev-parse", "--git-dir"]);
      const nativeHook = path.join(repo, gitDir, "hooks", "post-merge");
      writeFile(repo, path.relative(repo, nativeHook), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(nativeHook, 0o755);

      const hookManager = new AuthHookManager(db);
      hookManager.create({
        repo_pattern: path.basename(repo),
        auth_type: "merge",
        command:
          `test -n "$MANDIBLE_AUTH_MERGE_BASE_SHA" && ` +
          `test -n "$MANDIBLE_AUTH_MERGE_HEAD_SHA" && ` +
          `printf '%s\\n%s\\n' "$MANDIBLE_AUTH_MERGE_BASE_SHA" ` +
          `"$MANDIBLE_AUTH_MERGE_HEAD_SHA" > "${rangeSnapshot}"`,
        label: "Required original range",
        required: true,
      });
      const queue = new AuthQueue({
        db,
        executor: async () => ({
          exit_code: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          output: "ok\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        }),
        hookManager,
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/reviewed-update --into main",
        title: "Merge feature/reviewed-update",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/reviewed-update",
        merge_head_sha: git(repo, ["rev-parse", "feature/reviewed-update"]),
        cwd: repo,
      });
      const exactBase = git(repo, ["rev-parse", "main"]);

      git(repo, ["checkout", "feature/reviewed-update"]);
      writeFile(repo, "feature.txt", "reviewed final\n");
      git(repo, ["add", "feature.txt"]);
      git(repo, ["commit", "-m", "refresh reviewed head"]);
      const reviewedHead = git(repo, ["rev-parse", "HEAD"]);
      git(repo, ["checkout", "main"]);

      // This is the production update path. It must keep invalidating every
      // stale candidate field; approval is responsible for establishing a
      // fresh, clean exact range for the updated identity.
      const updated = queue.update(request.id, { merge_head_sha: reviewedHead });
      expect(updated.merge_preflight_base_sha).toBeNull();
      expect(updated.merge_candidate_pin_sha).toBeNull();

      const approved = queue.approve(request.id);
      expect(approved.merge_atomic_enabled).toBe(false);
      await waitForStatus(queue, request.id, "completed");

      expect(fs.readFileSync(rangeSnapshot, "utf8")).toBe(`${exactBase}\n${reviewedHead}\n`);
      expect(queue.getRequest(request.id)).toMatchObject({
        merge_preflight_base_sha: exactBase,
        merge_head_sha: reviewedHead,
      });
      expect(hookManager.convergence(request.id).state).toBe("complete");
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a native-hook merge when its persisted reviewed base moved before approval", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      commitOnBranch(repo, "feature/stale-reviewed-base", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);
      const nativeHook = path.join(repo, ".git", "hooks", "post-merge");
      writeFile(repo, path.relative(repo, nativeHook), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(nativeHook, 0o755);

      const queue = new AuthQueue({
        db,
        executor: async (options) => {
          calls.push(options.env);
          return { exit_code: 0, output: "must not execute\n" };
        },
        hookManager: createNoopHookManager(),
      });
      // Omitting merge_head_sha reproduces a legitimate unpinned request: the
      // submit-time base is persisted, while approval later resolves the
      // strictly reviewed head from the live branch.
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/stale-reviewed-base --into main",
        title: "Merge feature/stale-reviewed-base",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/stale-reviewed-base",
        cwd: repo,
      });
      const reviewedBase = request.merge_preflight_base_sha!;
      expect(request.merge_candidate_pin_sha).toBeNull();

      writeFile(repo, "main-advance.txt", "advanced\n");
      git(repo, ["add", "main-advance.txt"]);
      git(repo, ["commit", "-m", "advance main before approval"]);
      const advancedBase = git(repo, ["rev-parse", "main"]);
      expect(advancedBase).not.toBe(reviewedBase);

      expect(() => queue.approve(request.id)).toThrow(/moved from reviewed base/);
      expect(calls).toHaveLength(0);
      expect(git(repo, ["rev-parse", "main"])).toBe(advancedBase);
      expect(queue.getRequest(request.id)).toMatchObject({
        status: "pending",
        merge_preflight_base_sha: reviewedBase,
      });
      queue.dispose();
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
      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/fingerprint-first --into main",
        title: "Merge feature/fingerprint-first",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/fingerprint-first",
        cwd: repo,
      });
      const reviewedBase = first.merge_preflight_base_sha!;
      queue.submit({
        type: "merge",
        command: "mandible auth merge feature/fingerprint-second --into main",
        title: "Merge feature/fingerprint-second",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/fingerprint-second",
        cwd: repo,
      });

      queue.approve(first.id);
      await waitForStatus(queue, first.id, "completed");

      expect(calls).toHaveLength(1);
      expect(calls[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(reviewedBase);
      expect(calls[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBeUndefined();
      expect(git(repo, ["rev-parse", "main"])).toBe(reviewedBase);
      queue.dispose();
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

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/base-drift --into main",
        title: "Merge feature/base-drift",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-drift",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-drift"]),
        cwd: repo,
      });
      const originalPin = request.merge_candidate_pin_sha;
      const originalBase = request.merge_preflight_base_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);
      // Genuine authorized queue merge: signed merge commit + completed
      // request recording it (review F1 — raw SHA movement is refused now).
      const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-sibling");
      expect(newBase).not.toBe(originalBase);

      const approved = queue.approve(request.id);
      expect(approved.status).toBe("executing");
      await waitForStatus(queue, request.id, "completed");

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
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails approval with conflict context when the recomputed candidate conflicts", () => {
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

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/base-conflict --into main",
        title: "Merge feature/base-conflict",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/base-conflict",
        merge_head_sha: git(repo, ["rev-parse", "feature/base-conflict"]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      // Authorized queue merge whose content conflicts with the reviewed head:
      // provenance passes, the recomputed candidate does not merge cleanly.
      advanceMainViaAuthorizedMerge(db, repo, "feature/conflicting-sibling", "merge-conflicting");

      let thrown: unknown;
      try {
        queue.approve(request.id);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AuthQueueError);
      const authError = thrown as AuthQueueError;
      expect(authError.code).toBe("merge_check_failed");
      expect(authError.message).toContain("conflicts with the target branch");
      expect(authError.message).toContain("shared.txt");
      expect(authError.details).toBeDefined();
      expect(queue.getRequest(request.id)?.status).toBe("pending");
      expect(calls).toHaveLength(0);
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still blocks approval when the head branch moved from the reviewed commit", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const calls: string[] = [];
    try {
      commitOnBranch(repo, "feature/head-drift", { "feature.txt": "feature\n" });
      registerWorkRepo(db, repo);

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

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/head-drift --into main",
        title: "Merge feature/head-drift",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/head-drift",
        merge_head_sha: git(repo, ["rev-parse", "feature/head-drift"]),
        cwd: repo,
      });
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      // Head drift: the reviewed content itself changed.
      git(repo, ["checkout", "feature/head-drift"]);
      writeFile(repo, "feature.txt", "revised feature\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "revise head"]);
      git(repo, ["checkout", "main"]);
      // Base drift on top of head drift must not unlock recompute either.
      writeFile(repo, "main-only.txt", "main\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "move main"]);

      expect(() => queue.approve(request.id)).toThrow(/moved from reviewed commit/);
      expect(queue.getRequest(request.id)?.status).toBe("pending");
      expect(calls).toHaveLength(0);
      queue.dispose();
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
      const submit = (suffix: string, extra = "") => queue.submit({
        type: "merge",
        command: `mandible auth merge feature/atomic-eligibility --into main${extra}`,
        title: `Atomic eligibility ${suffix}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/atomic-eligibility",
        merge_head_sha: git(repo, ["rev-parse", "feature/atomic-eligibility"]),
        cwd: repo,
      });

      const ordinary = submit("ordinary");
      queue.approve(ordinary.id);
      await waitForStatus(queue, ordinary.id, "completed");
      expect(envs.at(-1)?.MANDIBLE_AUTH_ATOMIC).toBe("1");
      expect(queue.getRequest(ordinary.id)?.merge_candidate_pin_sha).toBeNull();

      const hook = path.join(repo, ".git", "hooks", "pre-merge-commit");
      fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const hooked = submit("hooked");
      queue.approve(hooked.id);
      await waitForStatus(queue, hooked.id, "completed");
      expect(envs.at(-1)?.MANDIBLE_AUTH_ATOMIC).toBeUndefined();
      fs.rmSync(hook);

      // Issue 060c9c8 — hierarchical merge support is removed; a
      // hierarchical-shaped command is refused by canonical-command
      // verification at approval and the request stays pending.
      const hierarchical = submit("hierarchical", " --hierarchical");
      expect(() => queue.approve(hierarchical.id))
        .toThrow(/Hierarchical merge commands cannot be verified/);
      expect(queue.getRequest(hierarchical.id)?.status).toBe("pending");

      const rejected = submit("rejected");
      const rejectedPin = rejected.merge_candidate_pin_sha!;
      queue.reject(rejected.id);
      expect(queue.getRequest(rejected.id)?.merge_candidate_pin_sha).toBeNull();
      expect(() => git(repo, ["cat-file", "-e", `${rejectedPin}^{commit}`])).not.toThrow();
      expect(() => git(repo, ["rev-parse", `refs/mandible/auth-candidates/${rejected.id}`])).toThrow();
      queue.dispose();
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects daemon auth merge approval before spawning when context is incomplete", () => {
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

    const request = queue.submit({
      command: "mandible auth merge feature/no-context --into main",
      title: "No context",
    });

    expect(() => queue.approve(request.id)).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("does not globally auto-approve new requests while a delegated lease is active", () => {
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

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon",
    });

    expect(request.status).toBe("pending");
    expect(request.approval_source).toBe("manual");
    expect(request.approval_lease_id).toBeNull();
    expect(calls).toHaveLength(0);
    queue.dispose();
    db.close();
  });

  it("records delegated_lease execution evidence for an explicit delegated approval", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const approverUserId = registerTestDelegatedLease(db, "lease-reuse");
    try {
      commitOnBranch(repo, "feature/lease-reuse", { "reuse.txt": "reuse\n" });
      registerWorkRepo(db, repo);
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
          expect(queue.getRequest(options.request_id)?.execution_evidence_id).toBeNull();
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
        hookManager: createNoopHookManager(),
      });

      const submitted = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/lease-reuse --into main",
        title: "Merge feature/lease-reuse",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/lease-reuse",
        cwd: repo,
      });
      expect(submitted.status).toBe("pending");
      queue.approve(submitted.id, delegatedApproval);
      const resolved = await waitForStatus(queue, submitted.id, "completed");
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "delegated_lease",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "delegated_lease",
        lease_id: "lease-reuse",
      });
      expect(JSON.parse(evidence.authorization.details_json)).toMatchObject({
        authorizer_user_id: approverUserId,
      });
      queue.dispose();
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
          expect(queue.getRequest(options.request_id)?.execution_evidence_id).toBeNull();
          expect(options.env?.SSH_AUTH_SOCK).toBeUndefined();
          expect(options.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
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
        hookManager: createNoopHookManager(),
      });

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/presence --into main",
        title: "Merge feature/presence",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/presence",
        cwd: repo,
      });
      queue.approve(request.id);
      const resolved = await waitForStatus(queue, request.id, "completed");

      expect(order).toEqual(["executor"]);
      expect(resolved?.approval_source).toBe("manual");
      expect(resolved?.approval_lease_id).toBeNull();
      const evidence = executionEvidenceChain(db, resolved!.execution_evidence_id!);
      expect(evidence.signature.evidence_method).toBe("credential_signature");
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({
        verified: false,
        authorization_evidence_method: "hardware_presence",
      });
      expect(evidence.authorization).toMatchObject({
        evidence_method: "hardware_presence",
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
      queue.dispose();
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
    (kind, leaseId, expectedError) => {
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
        const request = queue.submit({
          type: "merge",
          command: `mandible auth merge feature/${kind}-lease --into main`,
          title: `${kind} delegated lease`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/${kind}-lease`,
          cwd: repo,
        });

        expect(() => queue.approve(request.id, {
          source: "auto_lease",
          leaseId,
          approverUserId: operatorId,
          env: { SSH_AUTH_SOCK: `/tmp/${kind}.sock` },
        })).toThrow(expectedError);
        expect(queue.getRequest(request.id)?.status).toBe("pending");
        expect(executed).toBe(false);
        queue.dispose();
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
        const request = queue.submit({
          type: "merge",
          command: `mandible auth merge feature/presence-${mismatch} --into main`,
          title: `Presence ${mismatch} mismatch`,
          repo: path.basename(repo),
          base_branch: "main",
          head_branch: `feature/presence-${mismatch}`,
          cwd: repo,
        });
        queue.approve(request.id, {
          source: "presence_challenge",
          leaseId: "presence-valid",
          approverUserId: operatorId,
          env: {},
        });
        const failed = await waitForStatus(queue, request.id, "completed");
        expect(executed).toBe(false);
        expect(failed.error).toMatch(mismatch === "approver" ? /approver does not match/ : /lease is not valid/);
        queue.dispose();
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
