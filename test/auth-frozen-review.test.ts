import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { executeAuthCommand } from "../src/auth-executor.js";
import { AuthQueue } from "../src/auth-queue.js";
import { verifyMergeCommitSignature } from "../src/auth-signature-verification.js";
import { changeEditRef } from "../src/feedback/change-edit-git.js";
import { readRequestReview } from "../src/feedback/request-review.js";
import { reviewSubmissionAnnotations, reviewSubmissionTargets, submittedChangeEdit } from "../src/feedback/review-store.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { buildProtectedBranchGuardProjection, writeProtectedBranchGuardProjection } from "../src/protected-branch-guard.js";
import {
  AUTH_MERGE_REVIEW, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb,
  createNoopHookManager, git, registerWorkRepo, waitForStatus, writeFile,
} from "./helpers/auth-queue-fixtures.js";
import { fixtureOperatorSigning, operatorCaller, SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";

const CLI = fileURLToPath(new URL("../cli", import.meta.url));
const HOOKS = fileURLToPath(new URL("../hooks/git", import.meta.url));

it("freezes and lands the reviewed merge with a single signature and exact review receipts", async () => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  const signer = new SoftwareOperatorSigner();
  const branch = "feature/frozen";
  const requesterText = "# Notes\n\nRequester change.\n\nContext 1\nContext 2\nContext 3\n\nBase wording.\n";
  const editedText = requesterText.replace("Requester change.", "Operator change.");
  const mergedText = editedText.replace("Base wording.", "Independent protected update.");
  const privateHome = path.join(repo, ".git", "mandible-home");
  const script = [
    "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
    `source "${CLI}/auth-merge.sh"`,
    "persist_atomic_marker() { :; }",
    "collect_declared_issues() { :; }",
    "current_repo_id() { printf 'frozen-fixture'; }",
    `main ${branch} --into main`,
  ].join("\n");
  const racedBin = path.join(repo, ".git", "raced-bin");
  const gitPath = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(racedBin);
  writeFileSync(path.join(racedBin, "git"), [
    "#!/usr/bin/env bash",
    'if [[ "$1" == update-ref && "$*" == *--stdin* ]]; then',
    '  "$FIXTURE_GIT" update-ref "$FIXTURE_SOURCE" "$FIXTURE_BASE" "$FIXTURE_REQUESTER" || exit 1',
    'fi',
    'exec "$FIXTURE_GIT" "$@"',
  ].join("\n"), { mode: 0o755 });
  const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
    operatorSigning: fixtureOperatorSigning(db, signer),
    executor: async options => {
      const env: NodeJS.ProcessEnv = { ...options.env, MANDIBLE_HOME: privateHome, MANDIBLE_CLI_DIR: CLI };
      const execution = { ...options, command: script, mandibleArgs: undefined, env };
      const base = env.MANDIBLE_AUTH_CANDIDATE_BASE_SHA!;
      const requester = env.MANDIBLE_AUTH_EXPECTED_HEAD_SHA!;
      const source = `refs/heads/${branch}`;
      const raced = await executeAuthCommand({
        ...execution, onOutput: undefined, env: { ...env, FIXTURE_GIT: gitPath,
          FIXTURE_SOURCE: source, FIXTURE_BASE: base, FIXTURE_REQUESTER: requester,
          PATH: `${racedBin}:${process.env.PATH}` },
      });
      expect(raced.exit_code).not.toBe(0);
      expect(raced.stderr).toContain("compare-and-swap refused");
      expect(git(repo, ["rev-parse", "main", source])).toBe(`${base}\n${base}`);
      git(repo, ["update-ref", source, requester, base]);
      return executeAuthCommand(execution);
    },
  });
  try {
    writeFile(repo, "docs/notes.md", requesterText.replace("Requester change.", "Original proposal."));
    git(repo, ["add", "docs/notes.md"]); git(repo, ["commit", "-m", "Original notes"]);
    commitOnBranch(repo, branch, { "docs/notes.md": requesterText });
    const requester = git(repo, ["rev-parse", branch]);
    writeFile(repo, "docs/notes.md", requesterText
      .replace("Requester change.", "Original proposal.").replace("Base wording.", "Independent protected update."));
    git(repo, ["add", "docs/notes.md"]); git(repo, ["commit", "-m", "Independent protected update"]);
    const base = git(repo, ["rev-parse", "main"]);
    registerWorkRepo(db, repo);
    addProject(db, { project_key: "frozen-fixture" });
    addOrUpdateCheckout(db, "frozen-fixture", { root: repo, default_branch: "main" });
    const credential = configureSigningCredential(db, repo);
    const projection = buildProtectedBranchGuardProjection(db);
    expect(projection.protectedRefs).toContainEqual([path.join(realpathSync(repo), ".git"), "refs/heads/main"]);
    writeProtectedBranchGuardProjection(path.join(privateHome, "git-guard"), projection);
    git(repo, ["config", "core.hooksPath", HOOKS]);
    const refused = spawnSync("git", ["update-ref", "refs/heads/main", requester, base], {
      cwd: repo, encoding: "utf8", env: { ...process.env, MANDIBLE_HOME: privateHome },
    });
    expect(refused.status, refused.stderr).not.toBe(0);

    const { changeReport } = await computeAuthMergeReviewMetadata(repo, "main", branch);
    const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge",
      command: `mandible auth merge ${branch} --into main`, title: "Freeze edits",
      cwd: repo, target_repo_root: repo, repo: "frozen-fixture", base_branch: "main", head_branch: branch,
      merge_head_sha: requester, change_report: changeReport,
      narrative: ':::spec-item{key="context" type="verdict" required="false"}\nKeep this explanation?\n:::\n',
    }, credential.operatorId);
    const caller = operatorCaller(credential.operatorId);
    const actor = { user_id: credential.operatorId, evidence_method: "local_default", authority_path: "operator" as const };
    const first = await readRequestReview(db, request, actor.user_id);
    const expected_revision = queue.lifecycleRevision(request.id)!;
    const input = { expected_revision, expected_custody_generation: queue.requestResponsibility(request).custody_generation };
    const answer = (round_id: string, expected_revision: number, verdict: "keep" | "dismiss") =>
      queue.answerRequestNarrative(request.id, actor, { ...input, expected_revision,
        round_id, directive_key: "context",
        mutation: { operation: "set", expected_response_event_id: null, value: { verdict } },
      });
    const firstAnswer = answer(first.round.id, expected_revision, "keep");
    const firstProof = { proof_digest: queue.reviewApprovalProof(request), round_id: first.round.id,
      annotation_event_ids: [], answer_event_ids: [firstAnswer] };
    const edit = (expected_generation: number, text: string) => queue.mutateRequestReviewDraft(request.id, actor, {
      ...input, round_id: first.round.id, path: "docs/notes.md", expected_generation, mutation: { operation: "save", text },
    });
    const old = await edit(0, editedText.replace("Operator", "Draft"));
    const current = await edit(old.generation, editedText);
    await expect(queue.approveAsOperator(request.id, caller, expected_revision, firstProof)).rejects.toThrow(/freeze the review drafts/i);
    const freeze = (generation: number) => queue.freezeRequestReview(request.id, actor, {
      ...input, ...firstProof, draft_snapshot: [{ path: current.path, generation }],
    });
    await expect(freeze(old.generation)).rejects.toThrow(/drafts changed/i);
    const frozen = await freeze(current.generation);
    const revision = queue.lifecycleRevision(request.id)!;
    const freezeEvent = queue.listLifecycleEvents(request.id).find(event => event.revision === revision)!;
    expect(db.prepare("SELECT response_event_id FROM briefing_submission_answers WHERE submission_id = ?")
      .all(freezeEvent.review_submission_id!)).toEqual([{ response_event_id: firstAnswer }]);
    const reviewed = await readRequestReview(db, frozen, actor.user_id);
    expect(reviewed.drafts).toEqual([]);
    expect(reviewed.versions.map(version => version.head)).toEqual([requester, frozen.merge_candidate_pin_sha]);
    const effective = frozen.merge_effective_head_sha!;
    const ref = changeEditRef(request.id, effective);
    expect(git(repo, ["rev-list", "--parents", "-n", "1", ref])).toBe(`${effective} ${requester}`);
    expect(git(repo, ["show", "--format=%G?", "--no-patch", effective])).toBe("N");
    expect(frozen.change_report?.comparison.base_sha).toBe(base);
    const file = frozen.change_report!.files.find(file => file.new_path === "docs/notes.md")!;
    expect(file).toMatchObject({ operator_edited: true });
    expect(git(repo, ["cat-file", "blob", file.new_object!.oid])).toBe(mergedText.trimEnd());
    expect(git(repo, ["cat-file", "blob", file.old_object!.oid])).toContain("Independent protected update.");
    await expect(queue.approveAsOperator(request.id, caller, revision, firstProof)).rejects.toThrow(/proof changed/i);
    const proof = { proof_digest: queue.reviewApprovalProof(frozen), round_id: reviewed.round.id, annotation_event_ids: [] };
    git(repo, ["update-ref", ref, requester, effective]);
    try { await expect(queue.approveAsOperator(request.id, caller, revision, proof)).rejects.toThrow(/change edit ref changed/i); }
    finally { git(repo, ["update-ref", ref, effective, requester]); }
    expect(signer.touches).toHaveLength(0);
    expect(git(repo, ["rev-parse", "main"])).toBe(base);
    const binding = reviewed.round.bindings.find(item => item.source.kind === "request_file"
      && item.source.side === "after" && item.source.path === "docs/notes.md")!;
    const quote = "Operator change.";
    const annotation = await queue.annotateRequestReview(request.id, actor, {
      ...input, expected_revision: revision, document_binding_id: binding.id,
      mutation: { operation: "set", kind: "comment", start_offset: mergedText.indexOf(quote),
        end_offset: mergedText.indexOf(quote) + quote.length, quote, body: "Accept this wording." },
    });
    await expect(queue.approveAsOperator(request.id, caller, revision, proof)).rejects.toThrow(/review changed/i);
    const finalAnswer = answer(reviewed.round.id, revision, "dismiss");
    const proofWithComment = { ...proof, annotation_event_ids: [annotation] };
    await expect(queue.approveAsOperator(request.id, caller, revision, proofWithComment))
      .rejects.toThrow(/narrative answers changed/i);
    expect(signer.touches).toHaveLength(0);
    await queue.approveAsOperator(request.id, caller, revision, { ...proofWithComment, answer_event_ids: [finalAnswer] });
    await waitForStatus(queue, request.id, "completed");
    await queue.drainFinalizers();
    const landed = git(repo, ["rev-parse", "main"]);
    expect(signer.touches).toHaveLength(1);
    expect(git(repo, ["rev-list", "--parents", "-n", "1", landed])).toBe(`${landed} ${base} ${effective}`);
    expect(git(repo, ["show", `${landed}:docs/notes.md`])).toBe(mergedText.trimEnd());
    expect(await verifyMergeCommitSignature(db, repo, landed)).toMatchObject({ verified: true, credential_id: credential.credentialId });
    const approval = queue.listLifecycleEvents(request.id).find(event => event.event_type === "approved")!;
    expect(submittedChangeEdit(db, approval.review_submission_id!)).toMatchObject({ commit_sha: effective, parent_sha: requester });
    expect(reviewSubmissionAnnotations(db, approval.review_submission_id!).map(note => note.annotation_event_id)).toEqual([annotation]);
    expect(reviewSubmissionTargets(db, approval.review_submission_id!).map(target => target.document_binding_id).sort())
      .toEqual(reviewed.round.bindings.map(binding => binding.id).sort());
    const completed = await readRequestReview(db, queue.getRequestExact(request.id)!, actor.user_id);
    expect(completed.narrative_questions[0]?.effective_response)
      .toMatchObject({ response_event_id: finalAnswer, value: { verdict: "dismiss" } });
  } finally {
    await queue.dispose();
    db.close();
  }
});
