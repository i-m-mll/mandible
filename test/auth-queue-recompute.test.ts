import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import { approveFixtureRequest } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Candidate recompute fail-closed guards: pins, CAS rollback, and refusal messages.
 *
 * Each refusal (base drift, head drift, missing or corrupted pin, mutated
 * command) has its one queue-level home here; auth-merge-atomic holds the
 * matching CLI-level refusals.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { Db } from "../src/db.js";
import { getOperator } from "../src/users/store.js";
import { advanceMainViaAuthorizedMerge, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, createNoopHookManager, git, registerWorkRepo, signedMergeIntoMain, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

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

    async function submitPinnedRequest(
      queue: AuthQueue,
      repo: string,
      headBranch: string,
      command = `mandible auth merge ${headBranch} --into main`,
    ) {
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command,
        title: `Merge ${headBranch}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: headBranch,
        merge_head_sha: git(repo, ["rev-parse", headBranch]),
        cwd: repo,
      }));
      expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      return request;
    }

    // Review F5 — a corrupted or deleted retained candidate at an UNMOVED base
    // is tamper evidence: approval refuses with the original strict message.
    it("refuses approval when the retained candidate is missing or corrupted at a stable base", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/ref-corrupt", { "rc.txt": "rc\n" });
        commitOnBranch(repo, "feature/pin-corrupt", { "pc.txt": "pc\n" });
        commitOnBranch(repo, "feature/pin-missing", { "pm.txt": "pm\n" });
        registerWorkRepo(db, repo);

        // Deleted candidate ref: named as tamper evidence, not blamed on the inputs.
        const refCorrupt = (await submitPinnedRequest(queue, repo, "feature/ref-corrupt"));
        git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${refCorrupt.id}`]);
        const refusal = approveFixtureRequest(queue, refCorrupt.id);
        await expect(refusal).rejects.toThrow(STRICT_MESSAGE);
        await expect(refusal).rejects.toThrow(/Refusal: retained_candidate_invalid/);
        await expect(refusal).rejects.toThrow(/tamper evidence/);
        expect((await queue.getRequest(refCorrupt.id))?.status).toBe("pending");

        // A row whose retained pin is missing altogether.
        const missing = (await submitPinnedRequest(queue, repo, "feature/pin-missing"));
        db.prepare("UPDATE auth_requests SET merge_candidate_pin_sha = NULL WHERE id = ?").run(missing.id);
        await expect(approveFixtureRequest(queue, missing.id)).rejects
          .toThrow(/retained candidate|not_recomputable_request|lifecycle snapshot changed/);
        expect((await queue.getRequest(missing.id))?.status).toBe("pending");

        // Re-pointed pin (recorded pin no longer the reviewed candidate).
        const pinCorrupt = (await submitPinnedRequest(queue, repo, "feature/pin-corrupt"));
        db.prepare("UPDATE auth_requests SET merge_candidate_pin_sha = ? WHERE id = ?")
          .run(git(repo, ["rev-parse", "main"]), pinCorrupt.id);
        await expect(approveFixtureRequest(queue, pinCorrupt.id)).rejects.toThrow(/lifecycle snapshot changed/);
        expect((await queue.getRequest(pinCorrupt.id))?.status).toBe("pending");

        expect(calls).toHaveLength(0);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — a base rewritten to a non-descendant is never treated as
    // sibling drift.

    // Review F6 — a descendant base advance that is not accounted for by a
    // recorded, signature-verified queue merge is refused: raw commits and
    // even signed merges without a completed queue record.
    it("refuses recompute when the base advanced without a recorded authorized merge or was rewritten", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/unaccounted-a", { "ua.txt": "ua\n" });
        commitOnBranch(repo, "feature/unaccounted-b", { "ub.txt": "ub\n" });
        commitOnBranch(repo, "feature/unaccounted-c", { "uc.txt": "uc\n" });
        commitOnBranch(repo, "feature/rogue", { "rogue.txt": "rogue\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        // Plain descendant commit on the protected base.
        const first = (await submitPinnedRequest(queue, repo, "feature/unaccounted-a"));
        writeFile(repo, "raw.txt", "raw\n");
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "raw direct commit"]);
        await expect(approveFixtureRequest(queue, first.id)).rejects.toThrow(STRICT_MESSAGE);
        expect((await queue.getRequest(first.id))?.status).toBe("pending");

        // Signed merge with no completed queue record backing it.
        const second = (await submitPinnedRequest(queue, repo, "feature/unaccounted-b"));
        signedMergeIntoMain(repo, "feature/rogue");
        await expect(approveFixtureRequest(queue, second.id)).rejects.toThrow(STRICT_MESSAGE);
        expect((await queue.getRequest(second.id))?.status).toBe("pending");

        // A base rewritten to a non-descendant is never treated as sibling drift.
        const third = (await submitPinnedRequest(queue, repo, "feature/unaccounted-c"));
        git(repo, ["commit", "--amend", "-m", "rewritten history"]);
        expect(git(repo, ["rev-parse", "main"])).not.toBe(third.merge_preflight_base_sha);
        await expect(approveFixtureRequest(queue, third.id)).rejects.toThrow(STRICT_MESSAGE);
        expect((await queue.getRequest(third.id))?.status).toBe("pending");

        expect(calls).toHaveLength(0);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F2 and issue 08a5f04 — any edit to the reviewed inputs drops the
    // retained candidate, and approval accepts only the canonical command for
    // the reviewed head: never a mutated, shell-expanded or hierarchical one
    // (issue 060c9c8 removed hierarchical merges), even unpinned.
    it("refuses approval of mutated reviewed inputs, pinned or not", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        for (const branch of ["mutant", "expansion", "edited-head", "hier", "sibling"]) {
          commitOnBranch(repo, `feature/${branch}`, { [`${branch}.txt`]: `${branch}\n` });
        }
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");
        const expectInvalidated = async (id: string) => {
          expect((await queue.getRequest(id))).toMatchObject({
            merge_candidate_pin_sha: null,
            merge_candidate_tree_sha: null,
            merge_preflight_base_sha: null,
          });
          expect(() => git(repo, ["rev-parse", `refs/mandible/auth-candidates/${id}`])).toThrow();
        };

        const mutant = (await submitPinnedRequest(queue, repo, "feature/mutant"));
        (await queue.update(mutant.id, { command: "echo pwned && git push --force origin main" }));
        (await expectInvalidated(mutant.id));
        await expect(approveFixtureRequest(queue, mutant.id)).rejects.toThrow(/does not match the canonical form/);
        // Merge identity cannot be stripped to dodge enforcement either.
        await expect((async () => (await queue.update(mutant.id, { head_branch: null as unknown as string }))())).rejects.toThrow();
        expect((await queue.getRequest(mutant.id))?.head_branch).toBe("feature/mutant");

        const expansion = (await submitPinnedRequest(queue, repo, "feature/expansion"));
        (await queue.update(expansion.id, {
          command: "X=--hierarchical; mandible auth merge feature/expansion feature/evil --into main $X",
        }));
        await expect(approveFixtureRequest(queue, expansion.id)).rejects.toThrow(/does not match the canonical form/);

        const edited = (await submitPinnedRequest(queue, repo, "feature/edited-head"));
        git(repo, ["checkout", "feature/edited-head"]);
        writeFile(repo, "edited-head.txt", "revised\n");
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "refresh reviewed head"]);
        const revisedHead = git(repo, ["rev-parse", "HEAD"]);
        git(repo, ["checkout", "main"]);
        (await queue.update(edited.id, { merge_head_sha: revisedHead }));
        (await expectInvalidated(edited.id));
        await expect(approveFixtureRequest(queue, edited.id)).rejects.toThrow(/retained candidate|not_recomputable_request/);

        const hier = (await submitPinnedRequest(
          queue,
          repo,
          "feature/hier",
          "mandible auth merge --hierarchical feature/hier feature/evil --into main",
        ));
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-hier-sibling");
        await expect(approveFixtureRequest(queue, hier.id)).rejects.toThrow(/Hierarchical merge commands cannot be verified/);

        for (const request of [mutant, expansion, edited, hier]) {
          expect((await queue.getRequest(request.id))?.status).toBe("pending");
        }
        expect(calls).toHaveLength(0);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F4 — when the fresh pin cannot be obtained during recompute, the
    // approval fails closed with the strict error and the previous pin state
    // is left fully intact (never proceeds unpinned with skip-preflight).
    it("fails closed when a previously-pinned request cannot obtain a fresh pin", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/pin-fail", { "pf.txt": "pf\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/pin-fail"));
        const originalPin = request.merge_candidate_pin_sha!;
        const originalBase = request.merge_preflight_base_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-pin-fail-sibling");

        vi.spyOn(
          queue as unknown as { createMergeCandidatePin: (request: unknown) => string },
          "createMergeCandidatePin",
        ).mockImplementation(() => {
          throw new Error("injected pin cache failure");
        });

        const refusal = approveFixtureRequest(queue, request.id);
        await expect(refusal).rejects.toThrow(STRICT_MESSAGE);
        await expect(refusal).rejects.toThrow(/Refusal: repin_failed/);
        await expect(refusal).rejects.toThrow(/injected pin cache failure/);
        const after = (await queue.getRequest(request.id));
        expect(after?.status).toBe("pending");
        // Prior strictly-blocking state fully intact.
        expect(after?.merge_candidate_pin_sha).toBe(originalPin);
        expect(after?.merge_preflight_base_sha).toBe(originalBase);
        expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${request.id}`])).toBe(originalPin);
        expect(calls).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — remote requests never auto-recompute: a stale pin stays
    // strictly blocked even when the base advance is fully authorized.
    it("keeps remote requests strictly blocked on base drift", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/remote", { "rm.txt": "rm\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/remote"));
        db.prepare("UPDATE auth_requests SET execution_mode = 'remote' WHERE id = ?").run(request.id);
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-remote-sibling");

        const refusal = approveFixtureRequest(queue, request.id);
        await expect(refusal).rejects.toThrow(STRICT_MESSAGE);
        await expect(refusal).rejects.toThrow(/Refusal: not_recomputable_request/);
        await expect(refusal).rejects.toThrow(/execution_mode=remote/);
        expect((await queue.getRequest(request.id))?.status).toBe("pending");
        expect(calls).toHaveLength(0);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6 — the preflight must run against exactly the base whose
    // transition provenance was verified; a base that moves again in between
    // falls back to the strict error.
    it("refuses recompute when the base moves again between provenance verification and preflight", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/base-race", { "br.txt": "br\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/base-race"));
        const originalPin = request.merge_candidate_pin_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-race-sibling");

        const realCheck = queue.checkMergeIndependence.bind(queue);
        vi.spyOn(queue, "checkMergeIndependence").mockImplementation(async (input) => {
          // The base moves again after provenance verification but before the
          // recompute preflight resolves it.
          writeFile(repo, "race.txt", "race\n");
          git(repo, ["add", "."]);
          git(repo, ["commit", "-m", "raced base move"]);
          return (await realCheck(input));
        });

        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        const after = (await queue.getRequest(request.id));
        expect(after?.status).toBe("pending");
        expect(after?.merge_candidate_pin_sha).toBe(originalPin);
        expect(calls).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Review F6/F3 — when the head ref moves during recompute (after the head
    // check, before re-pinning), the fresh pin still binds the *reviewed* head
    // commit and the execution env still carries the reviewed head SHA, so the
    // shell layer merges (or refuses) against the reviewed object — never the
    // moved live ref.
    it("refuses a head ref that moves during recompute without executing revised bytes", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/head-race", { "hr.txt": "hr\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        git(repo, ["config", "core.hooksPath", ".git/hooks"]);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/head-race"));
        const reviewedHead = request.merge_head_sha!;
        advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-head-race-sibling");

        const realCheck = queue.checkMergeIndependence.bind(queue);
        vi.spyOn(queue, "checkMergeIndependence").mockImplementation(async (input) => {
          const report = (await realCheck(input));
          // The head ref moves after recompute verification.
          git(repo, ["checkout", "feature/head-race"]);
          writeFile(repo, "late.txt", "late\n");
          git(repo, ["add", "."]);
          git(repo, ["commit", "-m", "late head move"]);
          git(repo, ["checkout", "main"]);
          return report;
        });

        const baseBefore = git(repo, ['rev-parse', 'main']);
        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(/Head branch feature\/head-race moved/);
        expect(calls).toHaveLength(0);
        const liveHead = git(repo, ['rev-parse', 'feature/head-race']);
        expect(liveHead).not.toBe(reviewedHead);
        expect(git(repo, ['rev-parse', 'main'])).toBe(baseBefore);
        const pending = (await queue.getRequest(request.id))!;
        expect(pending.status).toBe('pending');
        expect(pending.merge_head_sha).toBe(reviewedHead);
        expect(git(repo, ['rev-parse', `${pending.merge_candidate_pin_sha}^2`])).toBe(reviewedHead);
      } finally {
        vi.restoreAllMocks();
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F2 pass 2) — a mutated command is refused at
    // approval even though the mutation already cleared the pin (previously
    // the unpinned request would proceed without fresh review).

    // Issue 08a5f04 (review F2 pass 2) — shell-expansion evasion dies with
    // canonicalization: only the canonical byte form is executable, so
    // `$X`-style smuggling never reaches bash.

    // Issue 08a5f04 (review F6) — the repin compare-and-swap fails closed when
    // the retained candidate ref disappeared between validation and swap.
    it("fails closed when the candidate ref is deleted before the repin CAS", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/cas-gone", { "cg.txt": "cg\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/cas-gone"));
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-cas-sib");
        // Simulate mid-flight deletion: the ref vanishes after validation
        // would have passed, immediately before the CAS.
        git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${request.id}`]);
        const repin = (queue as unknown as {
          repinMergeCandidate: (
            r: unknown, sha: string, fp: string | null,
          ) => unknown;
        }).repinMergeCandidate.bind(queue);
        await expect((async () => repin((await queue.getRequest(request.id)), newBase, null))()).rejects
          .toThrow(STRICT_MESSAGE);
        // Recorded pin state is untouched (still the original, now-strict pin).
        const after = (await queue.getRequest(request.id))!;
        expect(after.merge_candidate_pin_sha).toBe(request.merge_candidate_pin_sha);
        expect(after.merge_preflight_base_sha).toBe(request.merge_preflight_base_sha);
        // And approval keeps failing strict rather than proceeding unpinned.
        await expect(approveFixtureRequest(queue, request.id)).rejects.toThrow(STRICT_MESSAGE);
        expect(calls).toHaveLength(0);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 08a5f04 (review F6) — a DB failure after the ref CAS succeeded
    // leaves ref and row divergent; every later approval refuses strictly
    // (fail closed) instead of proceeding on either state.
    it("rolls back the candidate ref when the DB update fails after a successful repin CAS", async () => {
      const repo = createAuthCheckRepo();
      const db = createMigratedDb();
      const calls: Array<NodeJS.ProcessEnv | undefined> = [];
      const queue = createGuardQueue(db, calls);
      try {
        commitOnBranch(repo, "feature/cas-db", { "cd.txt": "cd\n" });
        commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
        registerWorkRepo(db, repo);
        configureSigningCredential(db, repo, "ssh_key");

        const request = (await submitPinnedRequest(queue, repo, "feature/cas-db"));
        const newBase = advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-cas-db");

        const rawDb = db as unknown as { prepare: (sql: string) => unknown };
        const realPrepare = rawDb.prepare.bind(db);
        rawDb.prepare = (sql: string) => {
          if (typeof sql === "string" && sql.includes("SET merge_preflight_base_sha")) {
            throw new Error("injected DB failure after CAS");
          }
          return realPrepare(sql);
        };
        try {
          const repin = (queue as unknown as {
            repinMergeCandidate: (
              r: unknown, sha: string, fp: string | null,
            ) => unknown;
          }).repinMergeCandidate.bind(queue);
          await expect((async () => repin((await queue.getRequest(request.id)), newBase, null))()).rejects
            .toThrow(/injected DB failure after CAS/);
        } finally {
          rawDb.prepare = realPrepare;
        }
        // The row and ref both retain the original pin. A later approval can
        // rederive the candidate normally; the failed write legitimized nothing.
        const after = (await queue.getRequest(request.id))!;
        expect(after.merge_candidate_pin_sha).toBe(request.merge_candidate_pin_sha);
        expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${request.id}`]))
          .toBe(request.merge_candidate_pin_sha);
        await approveFixtureRequest(queue, request.id);
        await waitForStatus(queue, request.id, "completed");
        expect(calls).toHaveLength(1);
      } finally {
        (await queue.dispose());
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    // Issue 2205073 — the guards above all keep failing closed, but the
    // approver must now be told WHICH guard refused and what fixes it. Before
    // this, every one of them produced the same generic sentence and the real
    // reason reached daemon_log only.
    describe("refusal reasons reach the approver", () => {
      it("names the missing signing credential and its fingerprint", async () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/unregistered-target", { "ut.txt": "ut\n" });
          commitOnBranch(repo, "feature/unregistered-sib", { "us.txt": "us\n" });
          registerWorkRepo(db, repo);

          // The operator has *some* registered credential (so the allowed
          // signers file is non-empty) but the key that actually signs the
          // protected merge was never registered — the exact 2026-08-12
          // production shape.
          configureSigningCredential(db, repo, "ssh_key");
          const unregisteredKeyPath = path.join(repo, ".unregistered-signing-key");
          execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", unregisteredKeyPath]);
          const unregisteredFingerprint = execFileSync(
            "ssh-keygen", ["-lf", `${unregisteredKeyPath}.pub`, "-E", "sha256"], { encoding: "utf8" },
          ).trim().split(/\s+/)[1]!;

          const request = (await submitPinnedRequest(queue, repo, "feature/unregistered-target"));
          git(repo, ["config", "user.signingkey", unregisteredKeyPath]);
          advanceMainViaAuthorizedMerge(db, repo, "feature/unregistered-sib", "merge-unregistered");

          let message = "";
          try {
            await approveFixtureRequest(queue, request.id);
            throw new Error("expected approval to be refused");
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Refusal: base_transition_unaccounted");
          expect(message).toContain("signature");
          expect(message).toContain(unregisteredFingerprint);
          expect(message).toContain(
            `mandible user credential add ${getOperator(db)!.slug} --from-git-signingkey`,
          );
          expect((await queue.getRequest(request.id))?.status).toBe("pending");
          expect(calls).toHaveLength(0);
        } finally {
          (await queue.dispose());
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      // Head drift never reaches the recompute guard: the earlier execution
      // context resolution already reports it specifically. Pinned here so the
      // one already-honest approval error on this path stays honest.
      it("keeps head drift reported with both commits, before recompute runs", async () => {
        const repo = createAuthCheckRepo();
        const db = createMigratedDb();
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const queue = createGuardQueue(db, calls);
        try {
          commitOnBranch(repo, "feature/drifted", { "df.txt": "df\n" });
          commitOnBranch(repo, "feature/sibling", { "sib.txt": "sib\n" });
          registerWorkRepo(db, repo);
          configureSigningCredential(db, repo, "ssh_key");

          const request = (await submitPinnedRequest(queue, repo, "feature/drifted"));
          const reviewedHead = request.merge_head_sha!;
          advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-drift-sib");
          git(repo, ["checkout", "feature/drifted"]);
          writeFile(repo, "df2.txt", "df2\n");
          git(repo, ["add", "df2.txt"]);
          git(repo, ["commit", "-m", "revise"]);
          const newHead = git(repo, ["rev-parse", "feature/drifted"]);
          git(repo, ["checkout", "main"]);

          let message = "";
          try {
            await approveFixtureRequest(queue, request.id);
            throw new Error("expected approval to be refused");
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain("Head branch feature/drifted moved");
          expect(message).toContain(reviewedHead);
          expect(message).toContain(newHead);
          expect(calls).toHaveLength(0);
        } finally {
          (await queue.dispose());
          db.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

    });
  });
});
