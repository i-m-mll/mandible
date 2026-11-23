import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { executeAuthCommand } from "../src/auth-executor.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { createBriefingBundle, replaceBriefingBundleLayout } from "../src/feedback/briefing-bundles.js";
import { createBriefingGroup, readBriefingGroup } from "../src/feedback/briefing-groups.js";
import { AuthQueue } from "../src/auth-queue.js";
import { verifyMergeCommitSignature } from "../src/auth-signature-verification.js";
import { changeEditRef } from "../src/feedback/change-edit-git.js";
import { narrativeHunks, requestNarrativeChanges, resolveNarrativeChange } from "../src/feedback/request-narrative.js";
import { readGitFilePair } from "../src/git-change-review.js";
import { readRequestReview } from "../src/feedback/request-review.js";
import { frozenOperatorBaseline } from "../src/feedback/request-drafts.js";
import { reviewSubmissionAnnotations, reviewSubmissionTargets, submittedChangeEdit } from "../src/feedback/review-store.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { buildProtectedBranchGuardProjection, writeProtectedBranchGuardProjection } from "../src/protected-branch-guard.js";
import {
  AUTH_MERGE_REVIEW, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb,
  git, registerWorkRepo, waitForStatus, writeFile,
} from "./helpers/auth-queue-fixtures.js";
import { fixtureOperatorSigning, operatorCaller, SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";

import { waitUntil } from "./helpers/wait-until.js";

const CLI = fileURLToPath(new URL("../cli", import.meta.url));
const HOOKS = fileURLToPath(new URL("../hooks/git", import.meta.url));

it("freezes and lands the reviewed merge with a single signature and exact review receipts", async () => {
  const repo = realpathSync(createAuthCheckRepo());
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
  const hookManager = new AuthHookManager(db);
  const installed = path.join(repo, ".git", "installed-notes.md");
  const hook = hookManager.create({ repo_pattern: "frozen-fixture", auth_type: "merge", position: 0,
    label: "Install tracked notes", command: `git show HEAD:docs/notes.md > '${installed}'`, required: true });
  const queue = new AuthQueue({ db, hookManager, backgroundMaintenance: false,
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
    commitOnBranch(repo, branch, { "docs/notes.md": requesterText, "docs/summary.md": "Requester summary.\n" });
    let requester = git(repo, ["rev-parse", branch]);
    writeFile(repo, "docs/notes.md", requesterText
      .replace("Requester change.", "Original proposal.").replace("Base wording.", "Independent protected update."));
    git(repo, ["add", "docs/notes.md"]); git(repo, ["commit", "-m", "Independent protected update"]);
    const base = git(repo, ["rev-parse", "main"]);
    registerWorkRepo(db, repo);
    addProject(db, { project_key: "frozen-fixture" });
    addOrUpdateCheckout(db, "frozen-fixture", { root: repo, default_branch: "main" });
    const credential = configureSigningCredential(db, repo);
    const viewer = { userId: credential.operatorId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Notes", briefingRefs: [], viewer });
    replaceBriefingBundleLayout(db, bundle.id, { layout: [
      { kind: "tracked", project_ref: "frozen-fixture", path: "docs/notes.md" },
    ] }, viewer);
    const group = createBriefingGroup(db, { key: "notes-policy", name: "Notes policy",
      currentBundleRef: bundle.id, bundleRefs: [], viewer });
    const projection = buildProtectedBranchGuardProjection(db);
    expect(projection.protectedRefs).toContainEqual([path.join(realpathSync(repo), ".git"), "refs/heads/main"]);
    writeProtectedBranchGuardProjection(path.join(privateHome, "git-guard"), projection);
    git(repo, ["config", "core.hooksPath", HOOKS]);
    const refused = spawnSync("git", ["update-ref", "refs/heads/main", requester, base], {
      cwd: repo, encoding: "utf8", env: { ...process.env, MANDIBLE_HOME: privateHome },
    });
    expect(refused.status, refused.stderr).not.toBe(0);

    const submitReview = async (predecessor?: string) => queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge",
      command: `mandible auth merge ${branch} --into main`, title: "Freeze edits",
      cwd: repo, target_repo_root: repo, repo: "frozen-fixture", base_branch: "main", head_branch: branch,
      merge_head_sha: requester, change_report: (await computeAuthMergeReviewMetadata(repo, "main", branch)).changeReport,
      ...(predecessor ? { supersedes_request_id: predecessor, expected_revision: queue.lifecycleRevision(predecessor)!,
        expected_custody_generation: queue.requestResponsibility(queue.getRequestExact(predecessor)!).custody_generation } : {}),
      narrative: ['Clarify the instruction.', ':::change{path="docs/notes.md"}\nRequester change.\n:::',
        ':::spec-item{key="context" type="verdict" required="false"}\nKeep this explanation?\n:::\n'].join("\n\n"),
    }, credential.operatorId);
    let request = await submitReview();
    const caller = operatorCaller(credential.operatorId);
    const actor = { user_id: credential.operatorId, evidence_method: "local_default", authority_path: "operator" as const };
    const first = await readRequestReview(db, request, actor.user_id);
    expect(first.tracked_groups[0]?.documents[0]).toMatchObject({ commit_sha: base,
      content: requesterText.replace("Requester change.", "Original proposal.")
        .replace("Base wording.", "Independent protected update.") });
    expect(readBriefingGroup(db, group.id, viewer).tracked_proposals[0]).toMatchObject({ request_id: request.id });
    const report = first.narrative_report!;
    const reference = requestNarrativeChanges(first.narrative!, report.files)[0]!;
    const compared = await readGitFilePair(repo, report.comparison, report.files[reference.index]);
    if (!compared.ok || compared.file.kind !== "text") throw new Error("Narrative file pair is unavailable");
    const { before, after } = compared.file;
    const proposed = resolveNarrativeChange(after.contents, reference.quote, narrativeHunks(before.contents, after.contents)!);
    expect(proposed && after.contents.slice(proposed.after.start, proposed.after.end)).toBe("Requester change.\n");
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
      ...input, round_id: first.round.id, path: reference.path, expected_generation, mutation: { operation: "save", text },
    });
    const old = await edit(0, editedText.replace("Operator", "Draft"));
    const current = await edit(old.generation, editedText);
    const summary = await queue.mutateRequestReviewDraft(request.id, actor, {
      ...input, round_id: first.round.id, path: "docs/summary.md", expected_generation: 0,
      mutation: { operation: "save", text: "Operator summary.\n" },
    });
    await expect(queue.approveAsOperator(request.id, caller, expected_revision, firstProof)).rejects.toMatchObject({ code: "lifecycle_conflict" });
    const freeze = (generation: number) => queue.freezeRequestReview(request.id, actor, {
      ...input, ...firstProof, draft_snapshot: [{ path: current.path, generation }, { path: summary.path, generation: summary.generation }],
    });
    await expect(freeze(old.generation)).rejects.toMatchObject({ code: "lifecycle_conflict" });
    let frozen = await freeze(current.generation);
    let revision = queue.lifecycleRevision(request.id)!;
    const freezeEvent = queue.listLifecycleEvents(request.id).find(event => event.revision === revision)!;
    expect(db.prepare("SELECT response_event_id FROM briefing_submission_answers WHERE submission_id = ?")
      .all(freezeEvent.review_submission_id!)).toEqual([{ response_event_id: firstAnswer }]);
    let reviewed = await readRequestReview(db, frozen, actor.user_id);
    expect(reviewed.drafts).toEqual([]);
    expect(reviewed.versions.map(version => version.head)).toEqual([requester, frozen.merge_candidate_pin_sha]);
    let effective = frozen.merge_effective_head_sha!;
    const ref = changeEditRef(request.id, effective);
    expect(git(repo, ["rev-list", "--parents", "-n", "1", ref])).toBe(`${effective} ${requester}`);
    expect(git(repo, ["show", "--format=%G?", "--no-patch", effective])).toBe("N");
    expect(frozen.change_report?.comparison.base_sha).toBe(base);
    const file = frozen.change_report!.files.find(file => file.new_path === "docs/notes.md")!;
    expect(file).toMatchObject({ operator_edited: true });
    expect(git(repo, ["cat-file", "blob", file.new_object!.oid])).toBe(mergedText.trimEnd());
    expect(git(repo, ["cat-file", "blob", file.old_object!.oid])).toContain("Independent protected update.");
    expect(await frozenOperatorBaseline(frozen, file, mergedText))
      .toBe(requesterText.replace("Base wording.", "Independent protected update."));
    await expect(queue.approveAsOperator(request.id, caller, revision, firstProof)).rejects.toMatchObject({ code: "lifecycle_conflict" });
    let proof = { proof_digest: queue.reviewApprovalProof(frozen), round_id: reviewed.round.id, annotation_event_ids: [] };
    git(repo, ["update-ref", ref, requester, effective]);
    try {
      expect(await queue.reviewCandidateBlocker(frozen)).toBeTruthy();
      await expect(queue.approveAsOperator(request.id, caller, revision, proof)).rejects.toMatchObject({ code: "merge_check_failed" });
    }
    finally { git(repo, ["update-ref", ref, effective, requester]); }
    expect(await queue.reviewCandidateBlocker(frozen)).toBeNull();
    expect(signer.touches).toHaveLength(0);
    expect(git(repo, ["rev-parse", "main"])).toBe(base);
    const reviewInput = async (requestId: string) => {
      const shown = await readRequestReview(db, queue.getRequestExact(requestId)!, actor.user_id);
      return { expected_revision: queue.lifecycleRevision(requestId)!,
        expected_custody_generation: queue.requestResponsibility(queue.getRequestExact(requestId)!).custody_generation,
        round_id: shown.round.id, annotation_event_ids: [],
        draft_snapshot: shown.drafts.map(({ path, generation }) => ({ path, generation })),
      };
    };
    const supersede = async (step: number, expectedText: string) => {
      git(repo, ["checkout", branch]);
      writeFile(repo, `requester-${step}.txt`, "A later independent requester change.\n");
      git(repo, ["add", `requester-${step}.txt`]);
      git(repo, ["commit", "-m", `Requester revision ${step}`]);
      requester = git(repo, ["rev-parse", branch]);
      git(repo, ["checkout", "main"]);
      request = await submitReview(request.id);
      const carried = await readRequestReview(db, request, actor.user_id);
      expect(carried.drafts).toMatchObject([
        { path: "docs/notes.md", text: expectedText, conflict: null },
        { path: "docs/summary.md", text: "Operator summary.\n", conflict: null },
      ]);
      return queue.freezeRequestReview(request.id, actor, await reviewInput(request.id));
    };
    frozen = await supersede(1, editedText);
    const returnText = mergedText.replace("Operator change.", "Operator returned change.");
    await queue.mutateRequestReviewDraft(request.id, actor, {
      ...await reviewInput(request.id), path: "docs/notes.md", expected_generation: 0,
      mutation: { operation: "save", text: returnText },
    });
    const returned = await queue.returnRequestReview(request.id, actor, {
      ...await reviewInput(request.id), reason: "Confirm the wording.",
    });
    const returnedEdit = submittedChangeEdit(db, returned.submission_id)!;
    expect(returnedEdit.commit_sha).not.toBe(frozen.merge_effective_head_sha);
    expect(git(repo, ["show", `${returnedEdit.ref}:docs/notes.md`])).toBe(editedText.replace("Operator change.", "Operator returned change.").trimEnd());
    frozen = await supersede(2, editedText.replace("Operator change.", "Operator returned change."));
    const priorHead = frozen.merge_effective_head_sha;
    const priorProof = { proof_digest: queue.reviewApprovalProof(frozen), round_id: (await reviewInput(request.id)).round_id,
      annotation_event_ids: [] };
    const finalText = returnText.replace("returned change.", "returned wording.");
    const amend = await queue.mutateRequestReviewDraft(request.id, actor, {
      ...await reviewInput(request.id), path: "docs/notes.md", expected_generation: 0, mutation: { operation: "save", text: finalText },
    });
    frozen = await queue.freezeRequestReview(request.id, actor, {
      ...await reviewInput(request.id), draft_snapshot: [{ path: amend.path, generation: amend.generation }],
    });
    revision = queue.lifecycleRevision(request.id)!;
    await expect(queue.approveAsOperator(request.id, caller, revision, priorProof)).rejects.toMatchObject({ code: "lifecycle_conflict" });
    reviewed = await readRequestReview(db, frozen, actor.user_id);
    effective = frozen.merge_effective_head_sha!;
    expect(effective).not.toBe(priorHead);
    expect(git(repo, ["show", `${effective}:docs/notes.md`])).toBe(editedText.replace("Operator change.", "Operator returned wording.").trimEnd());
    expect(git(repo, ["rev-list", "--parents", "-n", "1", effective])).toBe(`${effective} ${requester}`);
    proof = { proof_digest: queue.reviewApprovalProof(frozen), round_id: reviewed.round.id, annotation_event_ids: [] };
    const binding = reviewed.round.bindings.find(item => item.source.kind === "request_file"
      && item.source.side === "after" && item.source.path === "docs/notes.md")!;
    const quote = "Operator returned wording.";
    const annotation = await queue.annotateRequestReview(request.id, actor, {
      ...input, expected_revision: revision, document_binding_id: binding.id,
      mutation: { operation: "set", kind: "comment", start_offset: finalText.indexOf(quote),
        end_offset: finalText.indexOf(quote) + quote.length, quote, body: "Accept this wording." },
    });
    await expect(queue.approveAsOperator(request.id, caller, revision, proof)).rejects.toMatchObject({ code: "lifecycle_conflict" });
    const finalAnswer = answer(reviewed.round.id, revision, "dismiss");
    const proofWithComment = { ...proof, annotation_event_ids: [annotation] };
    await expect(queue.approveAsOperator(request.id, caller, revision, proofWithComment))
      .rejects.toMatchObject({ code: "stale_answer" });
    expect(signer.touches).toHaveLength(0);
    await queue.approveAsOperator(request.id, caller, revision, { ...proofWithComment, answer_event_ids: [finalAnswer] });
    await waitForStatus(queue, request.id, "completed");
    await waitUntil(() => queue.getRequestExact(request.id)?.merge_finalized_at, "merge convergence finalization");
    const landed = git(repo, ["rev-parse", "main"]);
    expect(signer.touches).toHaveLength(1);
    expect(git(repo, ["rev-list", "--parents", "-n", "1", landed])).toBe(`${landed} ${base} ${effective}`);
    expect(git(repo, ["show", `${landed}:docs/notes.md`])).toBe(finalText.trimEnd());
    expect(git(repo, ["show", `${landed}:docs/summary.md`])).toBe("Operator summary.");
    expect(await verifyMergeCommitSignature(db, repo, landed)).toMatchObject({ verified: true, credential_id: credential.credentialId });
    const approval = queue.listLifecycleEvents(request.id).find(event => event.event_type === "approved")!;
    expect(submittedChangeEdit(db, approval.review_submission_id!)).toMatchObject({ commit_sha: effective, parent_sha: requester });
    expect(reviewSubmissionAnnotations(db, approval.review_submission_id!).map(note => note.annotation_event_id)).toEqual([annotation]);
    expect(reviewSubmissionTargets(db, approval.review_submission_id!).map(target => target.document_binding_id).sort())
      .toEqual(reviewed.round.bindings.map(binding => binding.id).sort());
    const completed = await readRequestReview(db, queue.getRequestExact(request.id)!, actor.user_id);
    expect(hookManager.getRun(request.id, hook.id)).toMatchObject({ state: "complete" });
    expect(readFileSync(installed, "utf8")).toBe(finalText);
    const currentGroup = readBriefingGroup(db, group.id, viewer);
    expect(currentGroup.current!.layout[0]).toMatchObject({ kind: "tracked", tracked: { commit_sha: landed, content: finalText } });
    expect(completed.tracked_group_history[0]?.groups).toEqual(first.tracked_groups);
    expect(completed.tracked_groups[0]?.documents[0]?.commit_sha).toBe(base);
    expect(completed.narrative_questions[0]?.effective_response)
      .toMatchObject({ response_event_id: finalAnswer, value: { verdict: "dismiss" } });
  } finally {
    await queue.dispose();
    db.close();
  }
});
