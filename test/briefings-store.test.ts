import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, type Db } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
  BriefingStoreError,
  exportBriefingSubmissionMarkdown,
  listBriefings,
  parseBriefingRunRequest,
  publishBriefingRun,
  publishBriefingFromArtifactVersion,
  readBriefing,
  setBriefingArchived,
  submitBriefingRound,
  updateBriefingDescription,
  updateBriefingTitle,
} from "../src/feedback/briefings.js";
import {
  createBriefingBundle,
  readBriefingBundle,
  replaceBriefingBundleMembers,
  updateBriefingBundleName,
} from "../src/feedback/briefing-bundles.js";
import {
  addBriefingGroupUpdate,
  bindBriefingDestinationOwner,
  configureBriefingGroup,
  createBriefingGroup,
  dispositionBriefingGroupProposalByHumanReview,
  previewBriefingGroupReviewCandidate,
  promoteBriefingGroupProposal,
  readBriefingGroup,
  resolveGroupId,
  setBriefingGroupArchived,
} from "../src/feedback/briefing-groups.js";
import { METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";
import { createUser } from "../src/users/store.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import {
  inspectBriefingDestinationRoutes,
  registerBriefingDestinationRoute,
} from "../src/feedback/briefing-composer.js";

let db: Db;
let root: string;
let publisherId: string;
let humanId: string;

const digest = (letter: string) => letter.repeat(64);

function request(markdown = '# Daily\n\n:::spec-item{key="paper" type="verdict" required="true"}\nKeep this paper?\n:::\n', overrides: Record<string, unknown> = {}) {
  return parseBriefingRunRequest({
    schema: "mandible-briefing-run@1",
    briefing_key: "daily-research",
    title: "Daily research",
    task_identity: "agent-schedule/daily-digest",
    run_id: "run-1",
    run_key: "run-key-1",
    responder_user_ids: [humanId],
    evidence: { series_ref: "artifact-series:digest", version: 1, digest: digest("a") },
    source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 100 },
    document: { markdown },
    quiet_reason: null,
    occurrences: [{ directive_key: "paper", evidence_digest: digest("b"), occurred_at: 99, metadata: { ref: "paper-1" } }],
    ...overrides,
  });
}

function seedPromotionFixture() {
  const first = publishBriefingRun(db, request(), publisherId, 1_000);
  const second = publishBriefingRun(db, request(request().document!.markdown, {
    briefing_key: "second", run_id: "run-2", run_key: "run-key-2",
  }), publisherId, 1_010);
  const viewer = { userId: humanId, operator: true, humanReviewOperator: true };
  const base = createBriefingBundle(db, { name: "Original", briefingRefs: [first.briefing_id], viewer }, 1_100);
  const proposal = createBriefingBundle(db, { name: "Proposed", briefingRefs: [second.briefing_id], viewer }, 1_110);
  const group = createBriefingGroup(db, {
    key: "policy", name: "Policy", currentBundleRef: base.id, bundleRefs: [proposal.id], viewer,
  }, 1_200);
  return { base, proposal, group, viewer };
}

function insertSuccessfulMergeAuth(authId: string, mergeHead: string): void {
  db.prepare(`INSERT INTO auth_requests (
    id, command, title, status, created_at, updated_at, resolved_at, expires_at,
    exit_code, output, repo, base_branch, head_branch, type, merge_head_sha
  ) VALUES (?, 'git merge', 'Merge policy', 'completed', 1, 2, 2, 999999,
    0, '', 'dotfiles', 'main', 'feature/policy', 'merge', ?)`)
    .run(authId, mergeHead);
}

function insertPromotionAction(
  authId: string,
  payload: { group_ref: string; expected_base_bundle_ref: string; proposal_bundle_ref: string },
): void {
  db.prepare(`INSERT INTO auth_request_actions (
    id, auth_request_id, ordinal, kind, target_issue_ref, payload, state,
    target_digest, staged_at, updated_at, applied_at, outcome_detail
  ) VALUES (?, ?, 1, 'briefing_group_promote', 'policy-issue', ?, 'staged',
    NULL, 1, 1, NULL, NULL)`)
    .run(`${authId}-action`, authId, JSON.stringify(payload));
}

function insertCompositionProvenance(
  groupId: string,
  baseBundleId: string,
  proposalBundleId: string,
  runId = "composition-review-run",
): string {
  db.prepare(`INSERT INTO briefing_composition_runs (
    id, publisher_user_id, task_identity, run_id, run_key, request_digest, source_key,
    source_cursor, source_health_json, quiet, quiet_reason, received_at
  ) VALUES (?, ?, 'agent-schedule/review', ?, ?, ?, 'changes', 'cursor-1', '{}', 0, NULL, 1)`)
    .run(runId, publisherId, runId, runId, digest("e"));
  db.prepare(`INSERT INTO briefing_composition_targets
    (run_id, group_id, outcome, base_bundle_id, proposal_bundle_id)
    VALUES (?, ?, 'proposed', ?, ?)`).run(runId, groupId, baseBundleId, proposalBundleId);
  return runId;
}

function insertOperatorSubmission(bundleId: string, suffix = "one"): string {
  const round = db.prepare(`SELECT b.id AS briefing_id, b.latest_round_id AS round_id
    FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
    WHERE bm.bundle_id = ? ORDER BY bm.layout_position, bm.subgroup_position LIMIT 1`)
    .get(bundleId) as { briefing_id: string; round_id: string };
  const ordinal = (db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM briefing_submissions WHERE round_id = ?")
    .get(round.round_id) as { value: number }).value;
  const id = `operator-submission-${suffix}`;
  const prior = db.prepare(`SELECT id FROM briefing_submissions WHERE round_id = ? AND actor_user_id = ?
    ORDER BY ordinal DESC LIMIT 1`).get(round.round_id, humanId) as { id: string } | undefined;
  db.prepare(`INSERT INTO briefing_submissions
    (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, round.round_id, round.briefing_id, ordinal, prior?.id ?? null,
      humanId, 1_250 + ordinal);
  return id;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefings-"));
  db = new Database(":memory:");
  migrate(db);
  setSetting(db, "artifact_root", root);
  publisherId = createUser(db, { slug: "publisher", kind: "agent", display_name: "Publisher" }).id;
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact-backed Briefing rounds", () => {
  it("resolves active immutable keys without falling back to archived key owners", () => {
    const viewer = { userId: humanId, operator: true };
    const first = createBriefingGroup(db, { key: "policy-health", name: "Policy health",
      bundleRefs: [], viewer }, 100);
    expect(resolveGroupId(db, "policy-health")).toBe(first.id);
    expect(resolveGroupId(db, first.id.slice(0, 8))).toBe(first.id);
    expect(() => db.prepare("UPDATE briefing_groups SET key = 'changed' WHERE id = ?").run(first.id))
      .toThrow(/immutable/);
    setBriefingGroupArchived(db, first.id, true, viewer, 110);
    expect(() => resolveGroupId(db, "policy-health")).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(resolveGroupId(db, first.id)).toBe(first.id);
    const replacement = createBriefingGroup(db, { key: "policy-health", name: "Policy health replacement",
      bundleRefs: [], viewer }, 120);
    expect(resolveGroupId(db, "policy-health")).toBe(replacement.id);
    expect(() => setBriefingGroupArchived(db, first.id, false, viewer, 130))
      .toThrowError(expect.objectContaining({ code: "briefing_group_key_conflict" }));
  });

  it("keeps group current separate from proposals and archives Briefings without deleting review state", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    const second = publishBriefingRun(db, request(request().document!.markdown, {
      briefing_key: "second", run_id: "run-2", run_key: "run-key-2",
    }), publisherId, 1_010);
    const viewer = { userId: humanId, operator: true };
    const bundles = [first.briefing_id, second.briefing_id, first.briefing_id].map((briefingId, index) =>
      createBriefingBundle(db, { name: `Bundle ${index}`, briefingRefs: [briefingId], viewer,
        placementOverride: index === 2 ? { reason: "Compare the same Briefing in two layouts", actorUserId: publisherId,
          evidenceMethod: "api_token", credentialId: null } : undefined,
      }, 1_100 + index));
    const group = createBriefingGroup(db, {
      key: "policy", name: "Policy", bundleRefs: [bundles[1].id], viewer,
    }, 1_200);
    expect(group).toMatchObject({ current: null, updates: [{ id: bundles[1].id }] });
    expect(() => configureBriefingGroup(db, group.id, {
      currentBundleRef: bundles[0].id, bundleRefs: [bundles[0].id],
    }, viewer)).toThrowError(/must not also appear/);
    expect(() => configureBriefingGroup(db, group.id, {
      currentBundleRef: bundles[0].id, bundleRefs: [bundles[1].id, bundles[1].id],
    }, viewer)).toThrowError(/duplicates/);
    expect(configureBriefingGroup(db, group.id, {
      currentBundleRef: bundles[0].id, bundleRefs: [bundles[1].id, bundles[2].id],
    }, viewer, 1_300)).toMatchObject({ changed: true, group: {
      current: { id: bundles[0].id }, updates: [{ id: bundles[1].id }, { id: bundles[2].id }],
    } });
    expect(configureBriefingGroup(db, group.id, {
      currentBundleRef: bundles[0].id, bundleRefs: [bundles[1].id],
    }, viewer, 1_325)).toMatchObject({ changed: true, group: { history: [{
      kind: "dismissed",
      prior_base: { id: bundles[0].id },
      proposal: { id: bundles[2].id },
      resulting_base: null,
      auth_request_id: null,
      merge_head_sha: null,
    }] } });
    expect(createBriefingGroup(db, { key: "empty", name: "Empty", bundleRefs: [], viewer }, 1_350).current).toBeNull();
    expect(() => createBriefingGroup(db, {
      key: "conflict", name: "Conflict", currentBundleRef: bundles[1].id, bundleRefs: [], viewer,
    }, 1_400)).toThrowError(/placement conflicts/);

    const preserved = {
      rounds: db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ? ORDER BY id").all(first.briefing_id),
      members: db.prepare("SELECT * FROM briefing_members WHERE briefing_id = ? ORDER BY user_id").all(first.briefing_id),
      bundleMembers: db.prepare("SELECT * FROM briefing_bundle_members WHERE briefing_id = ? ORDER BY bundle_id")
        .all(first.briefing_id),
    };
    expect(setBriefingArchived(db, first.briefing_id, true, viewer, 1_500)).toEqual({
      briefing_id: first.briefing_id, archived_at: 1_500, changed: true,
    });
    expect(listBriefings(db, viewer).map((entry) => entry.id)).not.toContain(first.briefing_id);
    expect(readBriefingBundle(db, bundles[0].id, viewer).members).toEqual([]);
    expect(readBriefing(db, first.briefing_id, { actorUserId: humanId, operator: true }))
      .toMatchObject({ briefing: { id: first.briefing_id, archived_at: 1_500 } });
    expect(db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ? ORDER BY id").all(first.briefing_id))
      .toEqual(preserved.rounds);
    expect(db.prepare("SELECT * FROM briefing_members WHERE briefing_id = ? ORDER BY user_id").all(first.briefing_id))
      .toEqual(preserved.members);
    expect(db.prepare("SELECT * FROM briefing_bundle_members WHERE briefing_id = ? ORDER BY bundle_id")
      .all(first.briefing_id)).toEqual(preserved.bundleMembers);
    expect(setBriefingArchived(db, first.briefing_id, false, viewer)).toEqual({
      briefing_id: first.briefing_id, archived_at: null, changed: true,
    });
    expect(listBriefings(db, viewer).map((entry) => entry.id)).toContain(first.briefing_id);
    expect(readBriefingBundle(db, bundles[0].id, viewer).members).toMatchObject([
      { briefing: { id: first.briefing_id, archived_at: null } },
    ]);
  });

  it("promotes one exact proposal atomically, preserves history, and makes retries no-ops", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    const second = publishBriefingRun(db, request(request().document!.markdown, {
      briefing_key: "second", run_id: "run-2", run_key: "run-key-2",
    }), publisherId, 1_010);
    const viewer = { userId: humanId, operator: true };
    const base = createBriefingBundle(db, { name: "Original", briefingRefs: [first.briefing_id], viewer }, 1_100);
    const promoted = createBriefingBundle(db, { name: "Accepted", briefingRefs: [second.briefing_id], viewer }, 1_110);
    const survivor = createBriefingBundle(db, { name: "Survivor", briefingRefs: [first.briefing_id], viewer,
      placementOverride: { reason: "Retain an alternate proposal", actorUserId: publisherId,
        evidenceMethod: "api_token", credentialId: null } }, 1_120);
    const group = createBriefingGroup(db, {
      key: "policy", name: "Policy", currentBundleRef: base.id, bundleRefs: [promoted.id, survivor.id], viewer,
    }, 1_200);
    const authId = "auth-request-000000000000000000000000";
    const mergeHead = "a".repeat(40);
    db.prepare(`INSERT INTO auth_requests (
      id, command, title, status, created_at, updated_at, resolved_at, expires_at,
      exit_code, output, repo, base_branch, head_branch, type, merge_head_sha
    ) VALUES (?, 'git merge', 'Merge accepted policy', 'completed', 1, 2, 2, 999999,
      0, '', 'dotfiles', 'main', 'feature/policy', 'merge', ?)`)
      .run(authId, mergeHead);
    db.prepare(`INSERT INTO auth_request_actions (
      id, auth_request_id, ordinal, kind, target_issue_ref, payload, state,
      target_digest, staged_at, updated_at, applied_at, outcome_detail
    ) VALUES ('promotion-action', ?, 1, 'briefing_group_promote', 'policy-issue', ?, 'staged',
      NULL, 1, 1, NULL, NULL)`)
      .run(authId, JSON.stringify({
        group_ref: group.id,
        expected_base_bundle_ref: base.id,
        proposal_bundle_ref: promoted.id,
      }));
    db.prepare(`INSERT INTO auth_hook_executions (
      id, auth_request_id, hook_id, hook_label, command, command_digest, position, required,
      state, attempts, max_attempts, exit_code, output, attempt_history, started_at, finished_at,
      created_at, updated_at
    ) VALUES ('hook-run', ?, 'hook', 'Compile', 'true', ?, 0, 1,
      'complete', 1, 3, 0, '', '[]', 1, 2, 1, 2)`)
      .run(authId, digest("c"));
    const roundsBefore = db.prepare("SELECT * FROM briefing_rounds ORDER BY id").all();
    // A successful Git merge alone must not advance reviewed policy. Exercise
    // the failed-installation state, then the same action after convergence.
    db.prepare("UPDATE auth_hook_executions SET state = 'failed', exit_code = 1 WHERE id = 'hook-run'").run();
    expect(() => promoteBriefingGroupProposal(db, {
      groupRef: group.id, expectedBaseBundleRef: base.id, proposalBundleRef: promoted.id,
      authRequestRef: authId, mergeHeadSha: mergeHead,
    }, viewer, 1_250)).toThrow();
    expect(readBriefingGroup(db, group.id, viewer).current?.id).toBe(base.id);
    db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0 WHERE id = 'hook-run'").run();


    const applied = promoteBriefingGroupProposal(db, {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: promoted.id,
      authRequestRef: authId,
      mergeHeadSha: mergeHead,
    }, viewer, 1_300);
    expect(applied).toMatchObject({
      changed: true,
      group: { current: { id: promoted.id }, updates: [{ id: survivor.id }] },
      disposition: {
        kind: "promoted",
        prior_base: { id: base.id },
        proposal: { id: promoted.id },
        auth_request_id: authId,
        merge_head_sha: mergeHead,
      },
    });
    expect(db.prepare("SELECT * FROM briefing_rounds ORDER BY id").all()).toEqual(roundsBefore);
    expect(promoteBriefingGroupProposal(db, {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: promoted.id,
      authRequestRef: authId,
      mergeHeadSha: mergeHead,
    }, viewer, 1_400)).toMatchObject({ changed: false, group: { current: { id: promoted.id } } });
    expect(() => promoteBriefingGroupProposal(db, {
      groupRef: group.id,
      expectedBaseBundleRef: survivor.id,
      proposalBundleRef: promoted.id,
      authRequestRef: authId,
      mergeHeadSha: mergeHead,
    }, viewer, 1_500)).toThrowError(expect.objectContaining({ code: "promotion_authorization_mismatch" }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM briefing_group_dispositions").get()).toEqual({ count: 1 });
  });

  it("rejects unrelated successful requests and exact-action drift", () => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    const mergeHead = "b".repeat(40);
    insertSuccessfulMergeAuth("unrelated-auth-request", mergeHead);
    insertSuccessfulMergeAuth("drifted-auth-request", mergeHead);
    insertPromotionAction("drifted-auth-request", {
      group_ref: group.id,
      expected_base_bundle_ref: proposal.id,
      proposal_bundle_ref: proposal.id,
    });

    const promote = (authRequestRef: string) => promoteBriefingGroupProposal(db, {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: proposal.id,
      authRequestRef,
      mergeHeadSha: mergeHead,
    }, viewer, 1_300);
    expect(() => promote("unrelated-auth-request"))
      .toThrowError(expect.objectContaining({ code: "promotion_authorization_mismatch" }));
    expect(() => promote("drifted-auth-request"))
      .toThrowError(expect.objectContaining({ code: "promotion_authorization_mismatch" }));
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?").get(group.id))
      .toEqual({ current_bundle_id: base.id });
  });

  it("fails closed when promotion authorization or convergence schema is missing", () => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    const authId = "missing-schema-auth-request";
    const mergeHead = "c".repeat(40);
    insertSuccessfulMergeAuth(authId, mergeHead);
    const input = {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: proposal.id,
      authRequestRef: authId,
      mergeHeadSha: mergeHead,
    };

    db.prepare("DROP TABLE auth_request_actions").run();
    expect(() => promoteBriefingGroupProposal(db, input, viewer, 1_300))
      .toThrowError(expect.objectContaining({ code: "promotion_authorization_unavailable" }));
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?").get(group.id))
      .toEqual({ current_bundle_id: base.id });
  });

  it("fails closed when auth hook convergence records are unavailable", () => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    const authId = "missing-hooks-auth-request";
    const mergeHead = "d".repeat(40);
    insertSuccessfulMergeAuth(authId, mergeHead);
    insertPromotionAction(authId, {
      group_ref: group.id,
      expected_base_bundle_ref: base.id,
      proposal_bundle_ref: proposal.id,
    });
    db.prepare("DROP TABLE auth_hook_executions").run();

    expect(() => promoteBriefingGroupProposal(db, {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: proposal.id,
      authRequestRef: authId,
      mergeHeadSha: mergeHead,
    }, viewer, 1_300)).toThrowError(expect.objectContaining({ code: "promotion_convergence_unavailable" }));
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?").get(group.id))
      .toEqual({ current_bundle_id: base.id });
  });

  it.each(["manual", "recurring"])("accepts one exact Mandible-custodied %s proposal and makes exact replay a no-op", (kind) => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    expect(() => configureBriefingGroup(db, group.id, {
      currentBundleRef: proposal.id, bundleRefs: [],
    }, viewer, 1_205)).toThrowError(expect.objectContaining({
      code: "briefing_group_base_transition_requires_promotion",
    }));
    const compositionRunId = kind === "recurring" ? insertCompositionProvenance(group.id, base.id, proposal.id) : null;
    const submissionId = insertOperatorSubmission(proposal.id);
    const candidate = readBriefingGroup(db, group.id, viewer).review_candidates[0];
    expect(candidate).toMatchObject({
      ready: true,
      expected_base_bundle_id: base.id,
      proposal_bundle_id: proposal.id,
      composition_run_id: compositionRunId,
      binding_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      items: [{ changed: true, submission_id: submissionId }],
    });
    const input = {
      groupRef: group.id,
      expectedBaseBundleRef: base.id,
      proposalBundleRef: proposal.id,
      decision: "accepted" as const,
      bindingDigest: candidate.binding_digest!,
    };
    const actor = { userId: humanId, evidenceMethod: "api_token" as const, credentialId: null };
    const accepted = dispositionBriefingGroupProposalByHumanReview(db, input, actor, viewer, 1_300);
    expect(accepted).toMatchObject({
      changed: true,
      group: { current: { id: proposal.id }, updates: [] },
      disposition: {
        kind: "accepted",
        prior_base: { id: base.id },
        proposal: { id: proposal.id },
        resulting_base: { id: proposal.id },
        review_binding_digest: candidate.binding_digest,
        composition_run_id: compositionRunId,
        review_items: [{ submission_id: submissionId, changed: true }],
        actor_user_id: humanId,
        evidence_method: "api_token",
      },
    });
    expect(dispositionBriefingGroupProposalByHumanReview(db, input, actor, viewer, 1_400))
      .toMatchObject({ changed: false, group: { current: { id: proposal.id } } });
    expect(() => dispositionBriefingGroupProposalByHumanReview(db, {
      ...input, decision: "rejected",
    }, actor, viewer, 1_500)).toThrowError(expect.objectContaining({ code: "briefing_review_replay_drift" }));
    const receipt = db.prepare("SELECT id FROM briefing_group_review_dispositions").get() as { id: string };
    expect(() => db.prepare("UPDATE briefing_group_review_dispositions SET decision = 'rejected' WHERE id = ?")
      .run(receipt.id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM briefing_group_review_disposition_items WHERE disposition_id = ?")
      .run(receipt.id)).toThrow(/immutable/);
  });

  it.each(["manual", "recurring"])("binds destination moves to the same structural review digest and applies them only on accept (%s)", (kind) => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    if (kind === "recurring") insertCompositionProvenance(group.id, base.id, proposal.id);
    insertOperatorSubmission(proposal.id, "destination");
    const artifact = db.prepare(`SELECT b.logical_artifact_id
      FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
      WHERE bm.bundle_id = ?`).get(proposal.id) as { logical_artifact_id: string };
    const source = createBriefingGroup(db, {
      key: "source-owner", name: "Source owner", currentBundleRef: proposal.id, bundleRefs: [], viewer,
      placementOverride: { reason: "Exercise guarded destination reassignment", actorUserId: humanId,
        evidenceMethod: "api_token", credentialId: null },
    }, 1_220);
    bindBriefingDestinationOwner(db, { logicalArtifactRef: artifact.logical_artifact_id, groupRef: source.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer, 1_230);
    registerBriefingDestinationRoute(db, {
      route_key: "policy.destination", logical_artifact_id: artifact.logical_artifact_id,
      publication_mode: "reviewed-document",
      heading: "Policy", composer_kind: "deterministic", template_version: 1,
      contribution_template: "- {{evidence_ref}}", slots: {},
      limits: { max_contributions: 5, max_document_bytes: 10_000, max_directives: 10 },
    }, 1_232);
    expect(inspectBriefingDestinationRoutes(db, "policy.destination").routes[0].group_id).toBe(source.id);
    expect(() => setBriefingGroupArchived(db, source.id, true, viewer, 1_235))
      .toThrowError(expect.objectContaining({ code: "briefing_destination_group_owned" }));
    const destinationChanges = [{ logicalArtifactRef: artifact.logical_artifact_id, expectedGroupRef: source.id }];
    const candidate = previewBriefingGroupReviewCandidate(db, {
      groupRef: group.id, expectedBaseBundleRef: base.id, proposalBundleRef: proposal.id, destinationChanges,
    }, humanId);
    expect(candidate).toMatchObject({ ready: true, destination_changes: [{
      logical_artifact_id: artifact.logical_artifact_id,
      expected_group_id: source.id,
      resulting_group_id: group.id,
    }] });
    const input = {
      groupRef: group.id, expectedBaseBundleRef: base.id, proposalBundleRef: proposal.id,
      decision: "accepted" as const, bindingDigest: candidate.binding_digest!, destinationChanges,
    };
    const actor = { userId: humanId, evidenceMethod: "api_token" as const, credentialId: null };
    expect(() => dispositionBriefingGroupProposalByHumanReview(db, {
      ...input, destinationChanges: [],
    }, actor, viewer)).toThrowError(expect.objectContaining({ code: "briefing_review_binding_drift" }));
    const accepted = dispositionBriefingGroupProposalByHumanReview(db, input, actor, viewer, 1_300);
    expect(dispositionBriefingGroupProposalByHumanReview(db, input, actor, viewer).changed).toBe(false);
    expect(() => dispositionBriefingGroupProposalByHumanReview(db, {
      ...input, destinationChanges: [],
    }, actor, viewer)).toThrowError(expect.objectContaining({ code: "briefing_review_replay_drift" }));
    const before = readBriefingGroup(db, group.id, viewer).history;
    // Rebuild the receipt tables with populated item and destination anchors.
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      for (const sql of MIGRATIONS.find((migration) => migration.version === 181)!.statements) db.exec(sql);
    })();
    expect(readBriefingGroup(db, group.id, viewer).history).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(accepted.disposition).toMatchObject({
      base_layout_digest: candidate.base_layout_digest,
      proposal_layout_digest: candidate.proposal_layout_digest,
      destination_changes: candidate.destination_changes,
    });
    expect(db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(artifact.logical_artifact_id)).toEqual({ group_id: group.id });
    expect(inspectBriefingDestinationRoutes(db, "policy.destination").routes[0].group_id).toBe(group.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM briefing_group_review_destination_items").get())
      .toEqual({ count: 1 });
  });

  it.each(["manual", "recurring"])("rejects without changing Base and fails closed on review, custody, and Base drift (%s)", (kind) => {
    const fixture = seedPromotionFixture();
    if (kind === "recurring") insertCompositionProvenance(fixture.group.id, fixture.base.id, fixture.proposal.id);
    insertOperatorSubmission(fixture.proposal.id, "first");
    const initial = readBriefingGroup(db, fixture.group.id, fixture.viewer).review_candidates[0];
    insertOperatorSubmission(fixture.proposal.id, "second");
    const actor = { userId: humanId, evidenceMethod: "api_token" as const, credentialId: null };
    expect(() => dispositionBriefingGroupProposalByHumanReview(db, {
      groupRef: fixture.group.id, expectedBaseBundleRef: fixture.base.id,
      proposalBundleRef: fixture.proposal.id, decision: "rejected", bindingDigest: initial.binding_digest!,
    }, actor, fixture.viewer, 1_300)).toThrowError(expect.objectContaining({ code: "briefing_review_binding_drift" }));
    const current = readBriefingGroup(db, fixture.group.id, fixture.viewer).review_candidates[0];
    const rejected = dispositionBriefingGroupProposalByHumanReview(db, {
      groupRef: fixture.group.id, expectedBaseBundleRef: fixture.base.id,
      proposalBundleRef: fixture.proposal.id, decision: "rejected", bindingDigest: current.binding_digest!,
    }, actor, fixture.viewer, 1_400);
    expect(rejected).toMatchObject({ changed: true, group: {
      current: { id: fixture.base.id }, updates: [], history: [{
        kind: "rejected", prior_base: { id: fixture.base.id }, proposal: { id: fixture.proposal.id },
        resulting_base: { id: fixture.base.id },
      }],
    } });

  });

  it.each(["manual", "recurring"])("fails closed when Base changes after an operator freezes the review (%s)", (kind) => {
    const fixture = seedPromotionFixture();
    if (kind === "recurring") insertCompositionProvenance(fixture.group.id, fixture.base.id, fixture.proposal.id);
    insertOperatorSubmission(fixture.proposal.id, "drift");
    const candidate = readBriefingGroup(db, fixture.group.id, fixture.viewer).review_candidates[0];
    db.prepare("UPDATE briefing_groups SET current_bundle_id = NULL WHERE id = ?").run(fixture.group.id);
    expect(() => dispositionBriefingGroupProposalByHumanReview(db, {
      groupRef: fixture.group.id, expectedBaseBundleRef: fixture.base.id,
      proposalBundleRef: fixture.proposal.id, decision: "accepted", bindingDigest: candidate.binding_digest!,
    }, { userId: humanId, evidenceMethod: "api_token", credentialId: null }, fixture.viewer, 1_500))
      .toThrowError(expect.objectContaining({ code: "briefing_review_base_drift" }));
  });

  it("does not reinterpret a composer proposal with Base drift as a manual proposal", () => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    insertCompositionProvenance(group.id, base.id, proposal.id);
    insertOperatorSubmission(proposal.id);
    const replacement = createBriefingBundle(db, { name: "Replacement Base", briefingRefs: [], viewer });
    db.prepare("UPDATE briefing_groups SET current_bundle_id = ? WHERE id = ?").run(replacement.id, group.id);
    expect(readBriefingGroup(db, group.id, viewer).review_candidates[0]).toMatchObject({
      ready: false, blocker_code: "briefing_review_provenance_drift",
    });
  });

  it.each(["manual", "recurring"])("keeps repository or mixed-lineage proposals on protected merge authorization (%s)", (kind) => {
    const { base, proposal, group, viewer } = seedPromotionFixture();
    if (kind === "recurring") insertCompositionProvenance(group.id, base.id, proposal.id);
    insertOperatorSubmission(proposal.id);
    const version = db.prepare(`SELECT r.artifact_version_id, av.artifact_id
      FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
      JOIN briefing_rounds r ON r.id = b.latest_round_id JOIN artifact_version av ON av.id = r.artifact_version_id
      WHERE bm.bundle_id = ?`).get(proposal.id) as { artifact_version_id: string; artifact_id: string };
    db.prepare("UPDATE artifact SET source_kind = 'mixed' WHERE id = ?").run(version.artifact_id);
    expect(readBriefingGroup(db, group.id, viewer).review_candidates[0]).toMatchObject({
      ready: false,
      binding_digest: null,
      blocker_code: "briefing_review_repository_authority_required",
    });
    expect(METADATA_BACKUP_TABLES).toEqual(expect.arrayContaining([
      "briefing_group_dispositions",
      "briefing_group_review_dispositions",
      "briefing_group_review_disposition_items",
      "briefing_group_review_destination_items",
      "briefing_destination_owners",
      "briefing_destination_routes",
      "briefing_composition_runs",
    ]));
  });

  it("archives group containment, restores atomically, and records only explicit active sharing", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    const second = publishBriefingRun(db, request(request().document!.markdown, {
      briefing_key: "second", run_id: "run-2", run_key: "run-key-2",
    }), publisherId, 1_010);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Primary", briefingRefs: [first.briefing_id], viewer }, 1_100);
    expect(() => createBriefingBundle(db, { name: "Conflict", briefingRefs: [first.briefing_id], viewer }, 1_110))
      .toThrowError(expect.objectContaining({ code: "briefing_collection_placement_conflict",
        details: { placement_candidates: [expect.objectContaining({
          subject_kind: "briefing", subject_id: first.briefing_id, owner_kind: "bundle", owner_id: bundle.id,
        })] } }));
    const shared = createBriefingBundle(db, { name: "Deliberate comparison", briefingRefs: [first.briefing_id], viewer,
      placementOverride: { reason: "Compare two editorial layouts", actorUserId: publisherId,
        evidenceMethod: "api_token", credentialId: null } }, 1_120);
    expect(db.prepare(`SELECT operation, target_kind, target_id, subject_kind, subject_id, owner_kind,
      owner_id, reason, actor_user_id, evidence_method, credential_id
      FROM briefing_collection_sharing_receipts`).all()).toEqual([
      { operation: "bundle_create", target_kind: "bundle", target_id: shared.id,
        subject_kind: "briefing", subject_id: first.briefing_id, owner_kind: "bundle", owner_id: bundle.id,
        reason: "Compare two editorial layouts", actor_user_id: publisherId,
        evidence_method: "api_token", credential_id: null },
    ]);
    const sharingReceipt = db.prepare("SELECT id FROM briefing_collection_sharing_receipts").get() as { id: string };
    expect(() => db.prepare("UPDATE briefing_collection_sharing_receipts SET reason = 'rewritten' WHERE id = ?")
      .run(sharingReceipt.id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM briefing_collection_sharing_receipts WHERE id = ?")
      .run(sharingReceipt.id)).toThrow(/immutable/);

    const lifecycleBundle = createBriefingBundle(db, { name: "Lifecycle", briefingRefs: [second.briefing_id], viewer }, 1_130);
    const original = createBriefingGroup(db, {
      key: "original-collection", name: "Original collection", currentBundleRef: lifecycleBundle.id, bundleRefs: [], viewer,
    }, 1_140);
    const preserved = {
      bundle: db.prepare("SELECT * FROM briefing_bundles WHERE id = ?").get(lifecycleBundle.id),
      member: db.prepare("SELECT * FROM briefing_bundle_members WHERE bundle_id = ?").all(lifecycleBundle.id),
      briefing: db.prepare("SELECT * FROM briefings WHERE id = ?").get(second.briefing_id),
      rounds: db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(second.briefing_id),
    };
    expect(setBriefingGroupArchived(db, original.id, true, viewer, 1_200)).toMatchObject({
      changed: true, group: { id: original.id, archived_at: 1_200 },
    });
    expect(db.prepare("SELECT archived_at FROM briefings WHERE id = ?").get(second.briefing_id))
      .toEqual({ archived_at: null });
    expect(db.prepare("SELECT * FROM briefing_bundles WHERE id = ?").get(lifecycleBundle.id)).toEqual(preserved.bundle);
    expect(db.prepare("SELECT * FROM briefing_bundle_members WHERE bundle_id = ?").all(lifecycleBundle.id)).toEqual(preserved.member);
    expect(db.prepare("SELECT * FROM briefings WHERE id = ?").get(second.briefing_id)).toEqual(preserved.briefing);
    expect(db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(second.briefing_id)).toEqual(preserved.rounds);

    const replacement = createBriefingGroup(db, {
      key: "replacement-collection", name: "Replacement collection", currentBundleRef: lifecycleBundle.id, bundleRefs: [], viewer,
    }, 1_210);
    expect(() => setBriefingGroupArchived(db, original.id, false, viewer, 1_220))
      .toThrowError(expect.objectContaining({ code: "briefing_collection_placement_conflict",
        details: { placement_candidates: expect.arrayContaining([expect.objectContaining({
          subject_kind: "bundle", subject_id: lifecycleBundle.id, owner_kind: "group", owner_id: replacement.id,
        })]) } }));
    expect(db.prepare("SELECT archived_at FROM briefing_groups WHERE id = ?").get(original.id))
      .toEqual({ archived_at: 1_200 });

    const proposal = createBriefingBundle(db, { name: "Proposal", briefingRefs: [], viewer }, 1_230);
    expect(addBriefingGroupUpdate(db, replacement.id, proposal.id, viewer, 1_240)).toMatchObject({ added: true });
    expect(() => createBriefingBundle(db, { name: "Second conflict", briefingRefs: [second.briefing_id], viewer }, 1_250))
      .toThrowError(expect.objectContaining({ code: "briefing_collection_placement_conflict" }));
  });

  it("renames populated Briefings and bundles without changing any other stored byte", () => {
    const receipt = publishBriefingRun(db, request(), publisherId, 1_000);
    const markdown = request().document!.markdown;
    const quote = "Daily";
    const annotation = applyBriefingAnnotations(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      operation: "set", kind: "comment", start_offset: markdown.indexOf(quote),
      end_offset: markdown.indexOf(quote) + quote.length, quote, body: "Keep the heading",
      replacement_text: null,
    }], 1_100);
    const answer = applyBriefingAnswers(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: null, value: { verdict: "keep" },
    }], 1_200);
    submitBriefingRound(db, receipt.briefing_id, receipt.round_id!, humanId, {
      answers: [{ directive_key: "paper", response_event_id: answer.answer_event_ids[0] }],
      annotation_event_ids: annotation.annotation_event_ids, supersedes_submission_id: null,
    }, 1_300);
    const second = publishBriefingRun(db, request(request().document!.markdown, {
      briefing_key: "second-review", run_id: "run-2", run_key: "run-key-2",
    }), publisherId, 1_350);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, {
      name: "Original software-engineering source — partitioned review",
      briefingRefs: [receipt.briefing_id, second.briefing_id], viewer,
    }, 1_400);
    const tables = [
      "briefings", "briefing_members", "briefing_rounds", "briefing_response_events",
      "briefing_annotation_events", "briefing_submissions", "briefing_submission_answers",
      "briefing_submission_annotations", "briefing_bundles", "briefing_bundle_members",
    ] as const;
    const rows = () => Object.fromEntries(tables.map((table) => [table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = rows();

    expect(updateBriefingTitle(db, `briefing:${receipt.briefing_id.slice(0, 8)}`,
      "Skill", viewer)).toEqual({ briefing_id: receipt.briefing_id, title: "Skill", changed: true });
    const afterBriefingRename = rows();
    expect(afterBriefingRename).toEqual({
      ...before,
      briefings: before.briefings.map((row: Record<string, unknown>) => row.id === receipt.briefing_id
        ? { ...row, title: "Skill" }
        : row),
    });

    expect(updateBriefingBundleName(db, `briefing-bundle:${bundle.id.slice(0, 8)}`,
      "Sara’s skill, breakdown", viewer)).toMatchObject({
      changed: true, bundle: { id: bundle.id, name: "Sara’s skill, breakdown" },
    });
    expect(rows()).toEqual({
      ...afterBriefingRename,
      briefing_bundles: afterBriefingRename.briefing_bundles
        .map((row: Record<string, unknown>) => ({ ...row, name: "Sara’s skill, breakdown" })),
    });

    const afterBundleRename = rows();
    expect(() => replaceBriefingBundleMembers(db, bundle.id, [receipt.briefing_id, "  "], viewer, 1_500))
      .toThrowError(/nonblank/);
    expect(() => replaceBriefingBundleMembers(db, bundle.id,
      [receipt.briefing_id, `briefing:${receipt.briefing_id}`], viewer, 1_500))
      .toThrowError(/duplicates/);
    const outsiderId = createUser(db, { slug: "outsider", kind: "human", display_name: "Outsider" }).id;
    expect(() => replaceBriefingBundleMembers(db, bundle.id, [receipt.briefing_id], {
      userId: outsiderId, operator: false,
    }, 1_500)).toThrowError(/not found/);
    expect(rows()).toEqual(afterBundleRename);

    expect(replaceBriefingBundleMembers(db, `briefing-bundle:${bundle.id.slice(0, 8)}`,
      [second.briefing_id, receipt.briefing_id], viewer, 1_500)).toMatchObject({
      changed: true,
      bundle: {
        id: bundle.id,
        name: "Sara’s skill, breakdown",
        members: [
          { position: 0, briefing: { id: second.briefing_id } },
          { position: 1, briefing: { id: receipt.briefing_id } },
        ],
      },
    });
    expect(rows()).toEqual({
      ...afterBundleRename,
      briefing_bundles: afterBundleRename.briefing_bundles
        .map((row: Record<string, unknown>) => ({ ...row, updated_at: 1_500 })),
      briefing_bundle_members: [second.briefing_id, receipt.briefing_id]
        .map((briefing_id, layout_position) => ({ bundle_id: bundle.id, briefing_id, layout_position,
          entry_kind: "briefing", subgroup_name: null, subgroup_position: 0, created_at: 1_500 })),
    });
  });

  it("persists, trims, updates, and clears a Briefing description without changing round bindings", () => {
    const receipt = publishBriefingFromArtifactVersion(db, {
      briefing_key: "described-review", title: "Described review",
      description: "  Explains why this review exists. It represents an approval-ready policy fixture.  ",
      artifact_version_ref: recordArtifactVersion(db, {
        source_kind: "managed", content: "# Policy\n", series_key: "described-review",
        logical_name: "policy.md", role: "review-document", media_type: "text/markdown",
      }).version.id,
      profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    }, 1_000);
    const viewer = { userId: humanId, operator: true };
    const roundBefore = db.prepare("SELECT * FROM briefing_rounds WHERE id = ?").get(receipt.round_id);

    expect(listBriefings(db, viewer)).toMatchObject([{ description:
      "Explains why this review exists. It represents an approval-ready policy fixture." }]);
    expect(readBriefing(db, receipt.briefing_id, { actorUserId: humanId, operator: true }))
      .toMatchObject({ briefing: { description:
        "Explains why this review exists. It represents an approval-ready policy fixture." } });
    expect(updateBriefingDescription(db, receipt.briefing_id,
      "  Durable source snapshot for later comparison.  ", viewer, 1_100)).toEqual({
      briefing_id: receipt.briefing_id,
      description: "Durable source snapshot for later comparison.",
      changed: true,
    });
    expect(() => updateBriefingDescription(db, receipt.briefing_id, "  ", viewer)).toThrow(/nonblank/);
    expect(() => updateBriefingDescription(db, receipt.briefing_id, "x".repeat(1_001), viewer)).toThrow(/1000/);
    expect(updateBriefingDescription(db, receipt.briefing_id, null, viewer, 1_200))
      .toMatchObject({ description: null, changed: true });
    expect(db.prepare("SELECT * FROM briefing_rounds WHERE id = ?").get(receipt.round_id)).toEqual(roundBefore);
  });

  it("binds directive-free exact Markdown as an annotation-only Briefing without weakening run ingestion", () => {
    const sourcePath = path.join(root, "AGENTS.review.md");
    const baseSource = "# Agent instructions\n\nOriginal policy text.\n";
    fs.writeFileSync(sourcePath, baseSource);
    const base = recordArtifactVersion(db, {
      source_kind: "local_only", path: sourcePath, logical_name: "AGENTS.review.md",
      role: "review-document", media_type: "text/markdown",
    });
    fs.writeFileSync(sourcePath, "# Agent instructions\n\nPlain policy text.\n");
    const artifact = recordArtifactVersion(db, {
      source_kind: "local_only", path: sourcePath, logical_name: "AGENTS.review.md",
      role: "review-document", media_type: "text/markdown",
    });
    const receipt = publishBriefingFromArtifactVersion(db, {
      briefing_key: "plain-agents-review", title: "Agent instructions",
      artifact_version_ref: artifact.version.id, comparison_base_artifact_version_ref: base.version.id,
      profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    });
    expect(receipt.artifact_version_id).toBe(artifact.version.id);
    expect(db.prepare("SELECT comparison_base_artifact_version_id FROM briefing_rounds WHERE id = ?")
      .get(receipt.round_id)).toEqual({ comparison_base_artifact_version_id: base.version.id });
    expect(readBriefing(db, receipt.briefing_id, { roundId: receipt.round_id!, actorUserId: humanId,
      operator: false })).toMatchObject({ selected_round: { items: [], binding: { status: "valid" }, document: {
        comparison_base: { artifact_version_id: base.version.id, source: baseSource },
      } } });
    expect(listBriefings(db, { userId: humanId, operator: false })).toMatchObject([
      { id: receipt.briefing_id, unanswered_directive_count: 0 },
    ]);
    expect(() => submitBriefingRound(db, receipt.briefing_id, receipt.round_id!, humanId, {
      answers: [], annotation_event_ids: [], supersedes_submission_id: null,
    })).toThrowError(expect.objectContaining({ code: "submission_empty" }));
    expect(() => publishBriefingRun(db, request("# Plain run\n"), publisherId)).toThrow(/no spec-item directives/);
  });

  it("publishes the rlrmp2 typed-reference reproduction from an exact artifact version", () => {
    const source = [
      "# Experiment report",
      "",
      "The current authority is [issue:a55b4b3].",
      "See [comment:rlrmp2/db381cc#18] and [artifact-series:rlrmp2/perturbation-bank@2].",
    ].join("\n");
    const artifact = recordArtifactVersion(db, {
      source_kind: "managed", content: source, series_key: "typed-reference-report",
      logical_name: "report.md", role: "review-document", media_type: "text/markdown",
    });
    const receipt = publishBriefingFromArtifactVersion(db, {
      briefing_key: "typed-reference-report", title: "Experiment report",
      artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
    });
    expect(receipt.artifact_version_id).toBe(artifact.version.id);
    expect(readBriefing(db, receipt.briefing_id, {
      roundId: receipt.round_id!, actorUserId: humanId, operator: false,
    })).toMatchObject({ selected_round: { items: [], document: { source } } });
  });

  it("renders Base without highlights and surviving proposals against the present Base", () => {
    const sourcePath = path.join(root, "policy.md");
    const record = (source: string) => {
      fs.writeFileSync(sourcePath, source);
      return recordArtifactVersion(db, {
        source_kind: "local_only", path: sourcePath, logical_name: "policy.md",
        role: "review-document", media_type: "text/markdown",
      }).version;
    };
    const original = record("# Policy\n\nOriginal.\n");
    const accepted = record("# Policy\n\nAccepted.\n");
    const surviving = record("# Policy\n\nSurviving proposal.\n");
    const publish = (key: string, version: string, comparison: string, distinct = false) => publishBriefingFromArtifactVersion(db, {
      briefing_key: key,
      title: "Policy",
      artifact_version_ref: version,
      comparison_base_artifact_version_ref: comparison,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
      ...(distinct ? {
        distinct_reason: "Keep the surviving proposal as a separate review identity.",
        creation_provenance: { actor_user_id: humanId, evidence_method: "local_default" as const, credential_id: null },
      } : {}),
    });
    const baseBriefing = publish("accepted-policy", accepted.id, original.id);
    const survivorBriefing = publish("surviving-policy", surviving.id, original.id, true);
    if (baseBriefing.outcome === "active_candidates" || survivorBriefing.outcome === "active_candidates") {
      throw new Error("expected explicit Briefing publications to succeed");
    }
    const viewer = { userId: humanId, operator: true };
    const baseBundle = createBriefingBundle(db, {
      name: "Accepted", briefingRefs: [baseBriefing.briefing_id], viewer,
    });
    const survivorBundle = createBriefingBundle(db, {
      name: "Next proposal", briefingRefs: [survivorBriefing.briefing_id], viewer,
    });
    const group = createBriefingGroup(db, {
      key: "policy", name: "Policy", currentBundleRef: baseBundle.id, bundleRefs: [survivorBundle.id], viewer,
    });

    expect(readBriefing(db, baseBriefing.briefing_id, {
      actorUserId: humanId, operator: true,
      displayGroup: { groupRef: group.id, proposalBundleRef: null },
    })).toMatchObject({ selected_round: { document: {
      comparison_base: null,
      original_comparison_base: { artifact_version_id: original.id },
    } } });
    expect(readBriefing(db, survivorBriefing.briefing_id, {
      actorUserId: humanId, operator: true,
      displayGroup: { groupRef: group.id, proposalBundleRef: survivorBundle.id },
    })).toMatchObject({ selected_round: { document: {
      comparison_base: { artifact_version_id: accepted.id, source: "# Policy\n\nAccepted.\n" },
      original_comparison_base: { artifact_version_id: original.id },
    } } });
  });

  it("lists only latest-round directives without an active response from the current actor", () => {
    const receipt = publishBriefingRun(db, request(), publisherId, 1_000);
    const viewer = { userId: humanId, operator: false };
    expect(listBriefings(db, viewer)).toMatchObject([
      { id: receipt.briefing_id, unanswered_directive_count: 1 },
    ]);
    expect(listBriefings(db, { userId: publisherId, operator: true })).toMatchObject([
      { id: receipt.briefing_id, unanswered_directive_count: 0 },
    ]);

    const source = request().document!.markdown;
    const quote = "Daily";
    applyBriefingAnnotations(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      operation: "set", kind: "comment", start_offset: source.indexOf(quote),
      end_offset: source.indexOf(quote) + quote.length, quote, body: "Annotation is not a response",
      replacement_text: null,
    }], 1_100);
    expect(listBriefings(db, viewer)).toMatchObject([
      { id: receipt.briefing_id, unanswered_directive_count: 1 },
    ]);

    applyBriefingAnswers(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: null, value: { verdict: "keep" },
    }], 1_200);
    expect(listBriefings(db, viewer)).toMatchObject([
      { id: receipt.briefing_id, unanswered_directive_count: 0 },
    ]);
  });

  it("reuses one exact v3 artifact version and exports only current frozen text choices", () => {
    const markdown = `# Agent policy

Ordinary prose stays exact.

:::spec-item{key="push" type="text_variant" required="true"}
::alternative[Current]{key="current"}
Never push.
::alternative[Scoped]{key="scoped"}
Push only with current authorization.
:::

:::spec-item{key="note" type="long_text" required="false"}
Review note prompt.
:::`;
    const sourcePath = path.join(root, "AGENTS.review.md");
    fs.writeFileSync(sourcePath, markdown);
    const artifact = recordArtifactVersion(db, {
      source_kind: "local_only", path: sourcePath, logical_name: "AGENTS.review.md",
      title: "Agent instructions review", role: "review-document", media_type: "text/markdown",
    }, 900);
    const receipt = publishBriefingFromArtifactVersion(db, {
      briefing_key: "agents-review-prototype", title: "Agent instructions review",
      artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    }, 1_000);
    expect(receipt.artifact_version_id).toBe(artifact.version.id);
    expect(publishBriefingFromArtifactVersion(db, {
      briefing_key: "agents-review-prototype", title: "Agent instructions review",
      artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    }, 1_001).round_id).toBe(receipt.round_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_version").get()).toEqual({ n: 1 });
    expect(() => exportBriefingSubmissionMarkdown(db, receipt.briefing_id, receipt.round_id!, "missing", humanId))
      .toThrow(/submission not found/);
    const answer = applyBriefingAnswers(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      directive_key: "push", operation: "set", expected_response_event_id: null, value: { option_key: "scoped" },
    }], 1_100).answers[0];
    const submission = submitBriefingRound(db, receipt.briefing_id, receipt.round_id!, humanId, {
      answers: [{ directive_key: "push", response_event_id: answer.response_event_id }],
      annotation_event_ids: [], supersedes_submission_id: null,
    }, 1_200);
    const exported = exportBriefingSubmissionMarkdown(db, receipt.briefing_id, receipt.round_id!, submission.submission_id, humanId);
    expect(exported.content).toBe("# Agent policy\n\nOrdinary prose stays exact.\n\nPush only with current authorization.\n\nReview note prompt.");
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    applyBriefingAnswers(db, receipt.briefing_id, receipt.round_id!, humanId, [{
      directive_key: "push", operation: "set", expected_response_event_id: answer.response_event_id, value: { option_key: "current" },
    }], 1_300);
    expect(() => exportBriefingSubmissionMarkdown(db, receipt.briefing_id, receipt.round_id!, submission.submission_id, humanId))
      .toThrow(/non-current/);
  });
  it("replays immutable run identities, records quiet receipts, and reuses only unchanged artifact versions", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    expect(publishBriefingRun(db, request(), publisherId, 1_001)).toEqual(first);
    expect(() => publishBriefingRun(db, request(undefined, { run_id: "conflict" }), publisherId, 1_002))
      .toThrowError(BriefingStoreError);

    const second = publishBriefingRun(db, request(undefined, { run_id: "run-2", run_key: "run-key-2" }), publisherId, 2_000);
    expect(second.round_id).toBe(first.round_id);
    expect(second.artifact_version_id).toBe(first.artifact_version_id);

    const changed = publishBriefingRun(db, request('# Daily changed\n\n:::spec-item{key="paper" type="verdict" required="true"}\nKeep this revised paper?\n:::\n', {
      run_id: "run-3", run_key: "run-key-3",
    }), publisherId, 3_000);
    expect(changed.artifact_version_id).not.toBe(first.artifact_version_id);
    expect(readBriefing(db, first.briefing_id, { roundId: first.round_id!, actorUserId: humanId, operator: false })
      ?.selected_round.document.source).toContain("Keep this paper?");
    expect(readBriefing(db, first.briefing_id, {
      roundId: first.round_id!.slice(0, 8), actorUserId: humanId, operator: false,
    })?.selected_round.id).toBe(first.round_id);

    const quiet = publishBriefingRun(db, request(undefined, {
      run_id: "run-4", run_key: "run-key-4", document: null, quiet_reason: "no new evidence", occurrences: [],
    }), publisherId, 4_000);
    expect(quiet).toMatchObject({ quiet: true, round_id: null, artifact_version_id: null });
    expect(db.prepare("SELECT run_id, quiet_reason FROM briefing_runs WHERE id = ?").get(quiet.receipt_id))
      .toEqual({ run_id: "run-4", quiet_reason: "no new evidence" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
  });

  it("scopes directive instances and frozen corrections to one actor and one round", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    const detail = readBriefing(db, first.briefing_id, { actorUserId: humanId, operator: false })!;
    const selected = detail.selected_round!;
    const item = selected.items[0] as { id: string; directive_key: string };
    const source = selected.document.source as string;
    const quote = "Daily";
    const annotations = applyBriefingAnnotations(db, first.briefing_id, first.round_id!, humanId, [{
      operation: "set", kind: "comment", start_offset: source.indexOf(quote), end_offset: source.indexOf(quote) + quote.length,
      quote, body: "Good framing", replacement_text: null,
    }], 1_100);
    expect(annotations.annotation_event_ids).toHaveLength(1);

    const set = applyBriefingAnswers(db, first.briefing_id, first.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: null, value: { verdict: "keep" },
    }], 1_200);
    expect(set.answer_event_ids).toHaveLength(1);
    expect(() => applyBriefingAnswers(db, first.briefing_id, first.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: set.answer_event_ids[0],
      value: { verdict: "keep" },
    }], 1_201)).toThrowError(/unchanged/);
    const answer = set.answers[0] as { response_event_id: string };
    const submission = submitBriefingRound(db, first.briefing_id, first.round_id!, humanId, {
      answers: [{ directive_key: "paper", response_event_id: answer.response_event_id }],
      annotation_event_ids: annotations.annotation_event_ids,
      supersedes_submission_id: null,
    }, 1_300);
    expect(() => submitBriefingRound(db, first.briefing_id, first.round_id!, humanId, {
      answers: [{ directive_key: "paper", response_event_id: answer.response_event_id }],
      annotation_event_ids: annotations.annotation_event_ids,
      supersedes_submission_id: submission.submission_id,
    }, 1_301)).toThrowError(/unchanged/);

    const correctionSet = applyBriefingAnswers(db, first.briefing_id, first.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: answer.response_event_id,
      value: { verdict: "dismiss" },
    }], 1_400);
    const corrected = submitBriefingRound(db, first.briefing_id, first.round_id!, humanId, {
      answers: [{ directive_key: "paper", response_event_id: (correctionSet.answers[0] as { response_event_id: string }).response_event_id }],
      annotation_event_ids: annotations.annotation_event_ids,
      supersedes_submission_id: submission.submission_id,
    }, 1_500);
    expect(corrected).toMatchObject({ ordinal: 2, supersedes_submission_id: submission.submission_id });
    const history = readBriefing(db, first.briefing_id, {
      roundId: first.round_id!, actorUserId: humanId, operator: false,
    })!;
    expect(history.selected_round.submission_overlays).toMatchObject([
      { id: corrected.submission_id, ordinal: 2, actor: { display_name: "Human" }, answer_count: 1, annotation_count: 1 },
      { id: submission.submission_id, ordinal: 1, actor: { display_name: "Human" }, answer_count: 1, annotation_count: 1 },
    ]);
    const frozen = readBriefing(db, first.briefing_id, {
      roundId: first.round_id!, submissionId: submission.submission_id, actorUserId: humanId, operator: false,
    })!;
    expect(frozen.selected_round.selected_submission_overlay).toMatchObject({
      id: submission.submission_id,
      actor_user_id: humanId,
      answers: [{ response_event_id: answer.response_event_id, value: { verdict: "keep" } }],
      annotations: [{ annotation_event_id: annotations.annotation_event_ids[0], body: "Good framing" }],
    });
    const later = publishBriefingRun(db, request(
      '# Daily revised\n\n:::spec-item{key="paper" type="verdict" required="true"}\nKeep this paper?\n:::\n',
      { run_id: "run-2", run_key: "run-key-2" },
    ), publisherId, 1_600);
    expect(later.artifact_version_id).not.toBe(first.artifact_version_id);
    expect(() => readBriefing(db, first.briefing_id, {
      roundId: later.round_id!, submissionId: submission.submission_id, actorUserId: humanId, operator: false,
    })).toThrowError(expect.objectContaining({ code: "submission_overlay_not_found" }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_response_events WHERE operation = 'set'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get()).toEqual({ n: 2 });
    expect(item.id).toBeTruthy();
  });

  it("fails closed on membership, quote, stale membership, required, and artifact integrity gates", () => {
    const outsider = createUser(db, { slug: "outsider", kind: "human", display_name: "Outsider" }).id;
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    expect(readBriefing(db, first.briefing_id, { actorUserId: outsider, operator: false })).toBeNull();
    expect(() => applyBriefingAnswers(db, first.briefing_id, first.round_id!, outsider, [])).toThrowError(/not found/);
    expect(() => applyBriefingAnnotations(db, first.briefing_id, first.round_id!, humanId, [{
      operation: "set", kind: "comment", start_offset: 0, end_offset: 4, quote: "nope", body: "x", replacement_text: null,
    }])).toThrowError(/quote/);
    expect(() => submitBriefingRound(db, first.briefing_id, first.round_id!, humanId, {
      answers: [], annotation_event_ids: [], supersedes_submission_id: null,
    })).toThrowError(/required/);
    const version = db.prepare("SELECT blob_id FROM artifact_version WHERE id = ?").get(first.artifact_version_id) as { blob_id: string };
    const blob = db.prepare("SELECT storage_uri FROM artifact_blob WHERE id = ?").get(version.blob_id) as { storage_uri: string };
    fs.writeFileSync(blob.storage_uri.replace(/^file:\/\//, ""), "tampered");
    const invalid = readBriefing(db, first.briefing_id, { actorUserId: humanId, operator: false })!;
    expect(invalid.selected_round).toMatchObject({ binding: { status: "invalid" }, items: [], answers: [] });
    expect(() => applyBriefingAnswers(db, first.briefing_id, first.round_id!, humanId, []))
      .toThrowError(/binding is invalid/);
  });

  it("validates all six exact value variants and canonicalizes multi-choice by definition order", () => {
    const markdown = [
      '# Typed',
      ':::spec-item{key="v" type="verdict" required="true"}\nVerdict\n:::',
      ':::spec-item{key="s" type="single_choice" required="true"}\nSingle\n::option[Alpha]{key="a"}\n::option[Beta]{key="b"}\n:::',
      ':::spec-item{key="m" type="multi_choice" required="true"}\nMulti\n::option[Alpha]{key="a"}\n::option[Beta]{key="b"}\n::option[Gamma]{key="c"}\n:::',
      ':::spec-item{key="short" type="short_text" required="true"}\nShort\n:::',
      ':::spec-item{key="long" type="long_text" required="true"}\nLong\n:::',
      ':::spec-item{key="rating" type="rating" required="true"}\nRating\n:::',
    ].join("\n\n");
    const published = publishBriefingRun(db, request(markdown, { occurrences: [] }), publisherId, 1_000);
    const result = applyBriefingAnswers(db, published.briefing_id, published.round_id!, humanId, [
      { directive_key: "v", operation: "set", expected_response_event_id: null, value: { verdict: "keep" } },
      { directive_key: "s", operation: "set", expected_response_event_id: null, value: { option_key: "b" } },
      { directive_key: "m", operation: "set", expected_response_event_id: null, value: { option_keys: ["c", "a"] } },
      { directive_key: "short", operation: "set", expected_response_event_id: null, value: { text: "  exact  " } },
      { directive_key: "long", operation: "set", expected_response_event_id: null, value: { text: "long" } },
      { directive_key: "rating", operation: "set", expected_response_event_id: null, value: { rating: 5 } },
    ]);
    expect(result.answers.map((answer) => answer.value)).toEqual([
      { verdict: "keep" }, { option_key: "b" }, { option_keys: ["a", "c"] },
      { text: "  exact  " }, { text: "long" }, { rating: 5 },
    ]);
    expect(() => applyBriefingAnswers(db, published.briefing_id, published.round_id!, humanId, [{
      directive_key: "rating", operation: "set", expected_response_event_id: result.answers[5].response_event_id,
      value: { rating: 1.5 },
    }])).toThrow(/safe integer/);
  });

  it("fails closed on stored binding corruption and database cross-actor frozen membership", () => {
    const published = publishBriefingRun(db, request(), publisherId, 1_000);
    db.prepare("UPDATE briefing_directive_definitions SET required = 0 WHERE directive_key = 'paper'").run();
    expect(readBriefing(db, published.briefing_id, { actorUserId: humanId, operator: false })?.selected_round.binding)
      .toMatchObject({ status: "invalid" });
    expect(() => applyBriefingAnnotations(db, published.briefing_id, published.round_id!, humanId, []))
      .toThrow(/binding is invalid/);

    db.prepare("UPDATE briefing_directive_definitions SET required = 1 WHERE directive_key = 'paper'").run();
    const answer = applyBriefingAnswers(db, published.briefing_id, published.round_id!, humanId, [{
      directive_key: "paper", operation: "set", expected_response_event_id: null, value: { verdict: "keep" },
    }]).answers[0];
    db.prepare("UPDATE briefing_response_events SET value_json = ? WHERE id = ?")
      .run('{"rating":5}', answer.response_event_id);
    expect(readBriefing(db, published.briefing_id, { actorUserId: humanId, operator: false })?.selected_round.binding)
      .toMatchObject({ status: "invalid" });
    expect(() => applyBriefingAnswers(db, published.briefing_id, published.round_id!, humanId, [{
      directive_key: "paper", operation: "retract", expected_response_event_id: answer.response_event_id,
    }])).toThrow(/canonical|verdict|unsupported field/);
    db.prepare("UPDATE briefing_response_events SET value_json = ? WHERE id = ?")
      .run('{"verdict":"keep"}', answer.response_event_id);
    const other = createUser(db, { slug: "other", kind: "human", display_name: "Other" }).id;
    db.prepare("INSERT INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, 0)").run(published.briefing_id, other);
    expect(() => db.prepare(
      `INSERT INTO briefing_submissions
        (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
       VALUES ('other-sub', ?, ?, 1, NULL, ?, 0)`,
    ).run(published.round_id, published.briefing_id, other)).not.toThrow();
    expect(() => db.prepare(
      `INSERT INTO briefing_submission_answers
        (submission_id, round_id, actor_user_id, directive_instance_id, response_event_id, position)
       VALUES ('other-sub', ?, ?, ?, ?, 0)`,
    ).run(published.round_id, other, answer.directive_instance_id, answer.response_event_id))
      .toThrow(/matching set event|FOREIGN KEY/);
  });

  it("makes logical Artifact identity authoritative with typed guidance and durable overrides", () => {
    const version = (series: string, content: string) => recordArtifactVersion(db, {
      source_kind: "managed",
      content,
      series_key: series,
      logical_name: `${series}.md`,
      role: "review-document",
      media_type: "text/markdown",
    }).version;
    const firstVersion = version("lineage-a", "# First\n");
    const secondVersion = version("lineage-a", "# Second\n");
    const sameBytesDifferentArtifact = version("lineage-b", "# First\n");
    const publish = (overrides: Record<string, unknown>) => publishBriefingFromArtifactVersion(db, {
      title: "Lineage review",
      artifact_version_ref: firstVersion.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
      ...overrides,
    });

    const first = publish({ briefing_key: "lineage-first" });
    if (first.outcome === "active_candidates") throw new Error("first publication unexpectedly conflicted");
    expect(first).toMatchObject({ outcome: "created", archived_candidates: [] });
    expect(publish({ briefing_key: "lineage-same-version" })).toMatchObject({
      outcome: "active_candidates",
      active_candidates: [{ briefing_id: first.briefing_id, matching_round_id: first.round_id, guidance: "reuse_round" }],
    });
    expect(publish({ briefing_key: "lineage-new-version", artifact_version_ref: secondVersion.id })).toMatchObject({
      outcome: "active_candidates",
      active_candidates: [{ briefing_id: first.briefing_id, matching_round_id: null, guidance: "add_round" }],
    });

    const distinct = publish({
      briefing_key: "lineage-distinct",
      artifact_version_ref: secondVersion.id,
      distinct_reason: "Review the release candidate independently.",
      creation_provenance: {
        actor_user_id: humanId,
        evidence_method: "local_default",
        credential_id: null,
      },
    });
    if (distinct.outcome === "active_candidates") throw new Error("explicit distinct publication conflicted");
    expect(distinct).toMatchObject({ outcome: "created_distinct", override_receipt_id: expect.any(String) });
    expect(db.prepare(`SELECT briefing_id, logical_artifact_id, reason, actor_user_id, evidence_method, credential_id
      FROM briefing_creation_overrides WHERE id = ?`).get(distinct.override_receipt_id)).toEqual({
      briefing_id: distinct.briefing_id,
      logical_artifact_id: distinct.logical_artifact_id,
      reason: "Review the release candidate independently.",
      actor_user_id: humanId,
      evidence_method: "local_default",
      credential_id: null,
    });
    expect(() => db.prepare("UPDATE briefing_creation_overrides SET reason = 'changed' WHERE id = ?")
      .run(distinct.override_receipt_id)).toThrow(/immutable/);

    const added = publish({
      target_briefing_ref: first.briefing_id,
      viewer: { userId: humanId, operator: true },
      artifact_version_ref: secondVersion.id,
    });
    if (added.outcome === "active_candidates") throw new Error("targeted publication conflicted");
    expect(added.outcome).toBe("round_added");
    const replay = publish({
      target_briefing_ref: first.briefing_id,
      viewer: { userId: humanId, operator: true },
      artifact_version_ref: secondVersion.id,
    });
    expect(replay).toMatchObject({ outcome: "round_reused", round_id: added.round_id });

    const other = publish({ briefing_key: "different-logical-artifact", artifact_version_ref: sameBytesDifferentArtifact.id });
    expect(other).toMatchObject({ outcome: "created" });
    if (other.outcome === "active_candidates") throw new Error("different logical Artifact conflicted");
    expect(other.logical_artifact_id).not.toBe(first.logical_artifact_id);

    const viewer = { userId: humanId, operator: true };
    setBriefingArchived(db, first.briefing_id, true, viewer, 2_000);
    setBriefingArchived(db, distinct.briefing_id, true, viewer, 2_001);
    const afterArchive = publish({ briefing_key: "lineage-after-archive", artifact_version_ref: secondVersion.id });
    expect(afterArchive).toMatchObject({ outcome: "created", active_candidates: [] });
    expect(afterArchive.archived_candidates.map((candidate) => candidate.briefing_id))
      .toEqual(expect.arrayContaining([first.briefing_id, distinct.briefing_id]));
  });

  it("serializes competing default creators across independent database connections", async () => {
    const dbPath = path.join(root, "concurrent.db");
    const firstConnection = new Database(dbPath);
    migrate(firstConnection);
    setSetting(firstConnection, "artifact_root", root);
    const responder = createUser(firstConnection, {
      slug: "concurrent-human", kind: "human", display_name: "Concurrent human",
    }).id;
    const version = recordArtifactVersion(firstConnection, {
      source_kind: "managed", content: "# Concurrent\n", series_key: "concurrent-lineage",
      logical_name: "concurrent.md", role: "review-document", media_type: "text/markdown",
    }).version;
    const secondConnection = new Database(dbPath);
    secondConnection.pragma("foreign_keys = ON");
    secondConnection.pragma("busy_timeout = 5000");
    const create = (connection: Db, key: string) => publishBriefingFromArtifactVersion(connection, {
      briefing_key: key,
      title: "Concurrent review",
      artifact_version_ref: version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [responder],
    });
    try {
      const results = await Promise.all([
        Promise.resolve().then(() => create(firstConnection, "concurrent-one")),
        Promise.resolve().then(() => create(secondConnection, "concurrent-two")),
      ]);
      expect(results.map((result) => result.outcome).sort())
        .toEqual(["active_candidates", "created"]);
      expect(firstConnection.prepare("SELECT COUNT(*) AS n FROM briefings").get()).toEqual({ n: 1 });
      expect(firstConnection.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 1 });
    } finally {
      secondConnection.close();
      firstConnection.close();
    }
  });

});
