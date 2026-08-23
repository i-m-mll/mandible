import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, type Db } from "../src/db.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
  BriefingStoreError,
  exportBriefingSubmissionMarkdown,
  parseBriefingRunRequest,
  publishBriefingRun,
  publishBriefingFromArtifactVersion,
  readBriefing,
  submitBriefingRound,
  updateBriefingTitle,
} from "../src/feedback/briefings.js";
import {
  createBriefingBundle,
  replaceBriefingBundleMembers,
  updateBriefingBundleName,
} from "../src/feedback/briefing-bundles.js";
import { createUser } from "../src/users/store.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";

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
        .map((briefing_id, position) => ({ bundle_id: bundle.id, briefing_id, position, created_at: 1_500 })),
    });
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
    expect(() => submitBriefingRound(db, receipt.briefing_id, receipt.round_id!, humanId, {
      answers: [], annotation_event_ids: [], supersedes_submission_id: null,
    })).toThrowError(expect.objectContaining({ code: "submission_empty" }));
    expect(() => publishBriefingRun(db, request("# Plain run\n"), publisherId)).toThrow(/no spec-item directives/);
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
    expect(second.round_id).not.toBe(first.round_id);
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
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 3 });
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
    const later = publishBriefingRun(db, request(undefined, { run_id: "run-2", run_key: "run-key-2" }), publisherId, 1_600);
    expect(later.artifact_version_id).toBe(first.artifact_version_id);
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

});
