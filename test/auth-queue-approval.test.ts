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
import { describe, expect, it, vi } from "vitest";
import { waitUntil } from "./helpers/wait-until.js";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { reviewSubmissionAnnotations } from "../src/feedback/review-store.js";
import type { SseEvent } from "../src/types.js";
import { setDb } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { addCredential } from "../src/users/store.js";
import { MERGE_CHANGE_MESSAGE } from "./helpers/auth-delivery-fixtures.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { createLedgerIssue as createSharedLedgerIssue, createMigratedDb as createSharedMigratedDb } from "./helpers/ledger-fixtures.js";
import { advanceMainViaAuthorizedMerge, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, createQueue, executionEvidenceChain, git, registerWorkRepo, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";
import { approveAsFixtureOperator, fixtureOperatorSigning, operatorCaller, SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";

function createMigratedDbWithAgent() {
  return createSharedMigratedDb({
    operator: { slug: "cmd-norm-operator", display_name: "Cmd Norm Operator" },
    agent: { slug: "cmd-norm-agent", display_name: "Cmd Norm Agent", sessionEnv: "cmd-norm-session" },
  });
}

describe("auth queue", () => {

  it("blocks post-submission checkout edits before operator proof and exposes the preserved paths while reviewing", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    let queue: AuthQueue | undefined;
    const signer = new SoftwareOperatorSigner();
    try {
      writeFile(repo, "notes.txt", "original notes\n");
      git(repo, ["add", "notes.txt"]); git(repo, ["commit", "-m", "Tracked review notes"]);
      commitOnBranch(repo, "feature/readiness", { "feature.txt": "reviewed feature\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo);
      queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false, operatorSigning: fixtureOperatorSigning(db, signer) });
      const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", command: "mandible auth merge feature/readiness --into main",
        title: "Review retained candidate", cwd: repo, repo: path.basename(repo), base_branch: "main", head_branch: "feature/readiness",
        merge_head_sha: git(repo, ["rev-parse", "feature/readiness"]) });
      const base = git(repo, ["rev-parse", "main"]);
      const pin = request.merge_candidate_pin_sha;
      writeFile(repo, "shared.txt", "Unstaged edit added during review\n");
      writeFile(repo, "notes.txt", "Staged edit added during review\n"); git(repo, ["add", "notes.txt"]);
      const index = fs.readFileSync(path.join(repo, ".git", "index"));
      const blocker = await queue.publicationBlockerForRequest(request);
      expect(blocker).toMatchObject({ code: "checkout_not_ready" });
      expect(blocker!.message).toContain(fs.realpathSync(repo));
      expect(blocker!.message).toContain("unstaged [ M]: shared.txt");
      expect(blocker!.message).toContain("staged [M ]: notes.txt");
      await expect(approveAsFixtureOperator(queue, request.id, signing.operatorId)).rejects.toMatchObject({
        code: "merge_check_failed", message: expect.stringContaining("shared.txt"),
      });
      expect(signer.touches).toEqual([]);
      expect(await queue.getRequest(request.id)).toMatchObject({ status: "pending", approved_by_user_id: null,
        execution_evidence_id: null, merge_candidate_pin_sha: pin, merge_preflight_base_sha: base });
      expect(git(repo, ["rev-parse", "main"])).toBe(base);
      expect(fs.readFileSync(path.join(repo, ".git", "index"))).toEqual(index);
      expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("Unstaged edit added during review\n");
      expect(fs.readFileSync(path.join(repo, "notes.txt"), "utf8")).toBe("Staged edit added during review\n");
    } finally { await queue?.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it("signs the exact merge commit with one touch, and a cancelled sheet leaves nothing behind", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    let queue: AuthQueue | undefined;
    const signer = new SoftwareOperatorSigner();
    try {
      commitOnBranch(repo, "feature/one-touch", { "feature.txt": "one touch\n" });
      registerWorkRepo(db, repo);
      const signing = configureSigningCredential(db, repo);
      git(repo, ["config", "--unset", "user.signingkey"]);
      queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
        operatorSigning: fixtureOperatorSigning(db, signer), executor: async (options) => publishFixtureExecution(queue!, options) });
      const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", command: "mandible auth merge feature/one-touch --into main",
        title: "One touch", cwd: repo, repo: path.basename(repo), base_branch: "main", head_branch: "feature/one-touch",
        merge_head_sha: git(repo, ["rev-parse", "feature/one-touch"]) });
      const base = git(repo, ["rev-parse", "main"]);
      const objects = () => git(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
      const evidence = () => db.prepare("SELECT count(*) AS n FROM attribution_evidence").get();
      const [objectsBefore, evidenceBefore] = [objects(), evidence()];

      for (const result of ["cancelled", "biometry_unavailable", "key_invalidated"] as const) {
        signer.next.push({ result });
        await expect(queue.approveAsOperator(request.id, operatorCaller(signing.operatorId), queue.lifecycleRevision(request.id)!)).rejects.toMatchObject({ refusal: { code: result } });
        expect(await queue.getRequest(request.id)).toMatchObject({ status: "pending", approved_by_user_id: null, execution_evidence_id: null });
        expect([objects(), evidence(), git(repo, ["rev-parse", "main"])]).toEqual([objectsBefore, evidenceBefore, base]);
      }

      await queue.approveAsOperator(request.id, operatorCaller(signing.operatorId), queue.lifecycleRevision(request.id)!);
      await waitForStatus(queue, request.id, "completed");
      expect(signer.touches).toHaveLength(4);
      const approval = queue.listLifecycleEvents(request.id).find(event => event.event_type === "approved");
      expect(approval?.review_submission_id).toBeTruthy();
      expect(reviewSubmissionAnnotations(db, approval!.review_submission_id!)).toEqual([]);
      const touch = signer.touches.at(-1)!;
      expect(touch).toMatchObject({ namespace: "git" });
      const tip = git(repo, ["rev-parse", "main"]);
      const published = git(repo, ["cat-file", "commit", tip]);
      expect(published.replace(/^gpgsig [^]*?-----END SSH SIGNATURE-----\n/m, "")).toBe(touch.message.toString("utf8").trimEnd());
      expect(touch.message.toString("utf8")).toMatch(new RegExp(`^tree ${request.merge_candidate_tree_sha}\nparent ${base}\nparent ${request.merge_head_sha}\n`));
      expect(touch.message.toString("utf8").endsWith(`\n\n${request.commit_message}`)).toBe(true);
      const signers = path.join(repo, ".git", "approval-signers");
      fs.writeFileSync(signers, `${signing.credentialId} ${fs.readFileSync(`${signing.keyPath}.pub`, "utf8").trim()}\n`);
      expect(git(repo, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", tip])).toBe("");
    } finally { await queue?.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

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
      const signing = configureSigningCredential(db, repo);
      // Ambient git signing names a key Mandible does not know; approval never reads it.
      git(repo, ["config", "user.signingkey", "/nonexistent/ambient-signing-key"]);
      git(repo, ["config", "commit.gpgsign", "true"]);
      const queue = new AuthQueue({
        db,
        broadcast: (event) => events.push(event),
        executor: async (options) => {
          cwds.push(options.cwd);
          expect(options.mandibleArgs).toEqual(["auth", "merge", "feature/signed-interactive", "--into", "main"]);
          expect(options.env?.MANDIBLE_AUTH_SIGNED_MERGE_SHA).toMatch(/^[0-9a-f]{40}$/);
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
      expect(JSON.parse(chain.authorization.details_json).signed_commit_sha).toBe(signatureDetails.commit_sha);
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
      configureSigningCredential(db, repo);

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
      configureSigningCredential(db, repo);

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
      configureSigningCredential(db, repo);
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
    configureSigningCredential((queue as unknown as { db: Parameters<typeof configureSigningCredential>[0] }).db, createAuthCheckRepo());

    await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  // Issue 08a5f04 — legacy submissions through the route: the legacy
  // single-source shape (no base_branch) is rewritten to the canonical command
  // at POST, never at approval, and both it and the canonical form approve.
  it("normalizes legacy merge submissions at POST so approval accepts them", async () => {
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
           ledger_issue_id, owner_user_id, responsibility_session_id, custody_generation)
         VALUES (?, 'abc1234', ?, ?, 'solo', 'committed', 1, 1, 1, ?, ?, ?, 1)`,
      ).run(`wu-${branch}`, project.project.id, branch, issue.id, agent.id, "agent:codex:cmd-norm-session");
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
    registerAuthRoutes(router, queue, inlineLedgerReader(() => queue.db));
    try {
      const submissions = [
        { command: "mandible auth merge feature/channel-legacy", head_branch: "feature/channel-legacy" },
        { command: "mandible auth merge feature/channel-canonical --into main", head_branch: "feature/channel-canonical", base_branch: "main" },
      ];
      for (const submission of submissions) {
        const result = await router.invoke({
          method: "POST",
          url: "/api/auth/v2/request",
          body: {
            ...MERGE_CHANGE_MESSAGE,
            ...submission,
            title: `Merge ${submission.head_branch}`,
            cwd: repo,
            session_id: "agent:codex:cmd-norm-session",
            issue_references: ["abc1234"],
          },
          ambient_identity: { provider: "codex", agent_id: "cmd-norm-session", session_id: null },
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
