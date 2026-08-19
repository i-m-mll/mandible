import { createHash } from "node:crypto";

import { getSetting, setSetting } from "../client-auth/settings-kv.js";
import type { Db } from "../db.js";
import { createUser, getUserBySlug } from "../users/store.js";
import type { User, UserKind } from "../users/types.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
  briefingRunRequestDigest,
  parseBriefingRunRequest,
  publishBriefingRun,
  readBriefing,
  submitBriefingRound,
} from "./briefings.js";

export const RICH_BRIEFING_DEMO = Object.freeze({
  briefingKey: "demo.release-candidate-readiness",
  title: "Release candidate readiness review",
  publisherSlug: "briefing-demo-publisher",
  reviewerSlug: "briefing-demo-reviewer",
  taskIdentity: "demo/release-candidate-readiness",
  source: "release-readiness-demo",
  evidenceSeriesRef: "artifact-series:release-readiness-evidence",
  roundOneTimestamp: Date.UTC(2026, 7, 18, 14, 0, 0),
  answersTimestamp: Date.UTC(2026, 7, 18, 14, 5, 0),
  annotationsTimestamp: Date.UTC(2026, 7, 18, 14, 6, 0),
  submissionTimestamp: Date.UTC(2026, 7, 18, 14, 7, 0),
  roundTwoTimestamp: Date.UTC(2026, 7, 18, 15, 0, 0),
});

export const RICH_BRIEFING_ROUND_ONE_MARKDOWN = `# Release candidate readiness review

The release candidate is feature-complete and ready for a guarded production window, subject to the named controls below.

> Staging rehearsal completed with the signed candidate artifact; rollback restored service in 12 minutes and the alert path reached the incident lead.

## Bounded scope

- Ship only artifact \`rc.2026.08.18+build.7\`.
- Keep rollback within the 15 minute recovery objective.
- Hold the window unless the release lead and incident lead are both present.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Forward replay passed on a production-shaped snapshot | Low |
| Alert calibration | Synthetic checks reached the incident lead | Medium |
| Rollback handoff | Restore completed in 12 minutes | Medium |

\`\`\`ini
release.freeze=true
rollback.window=15m
release.candidate=rc.2026.08.18+build.7
\`\`\`

See the [release evidence packet](https://example.com/releases/rc-readiness) for the immutable source record.

:::spec-item{key="release.verdict" type="verdict" required="true"}
Should this candidate remain approved for the guarded release window?
:::

:::spec-item{key="release.posture" type="single_choice" required="true"}
Choose the operating posture for the first production hour.
::option[Guarded release with incident lead present]{key="guarded"}
::option[Normal release monitoring]{key="normal"}
::option[Hold for another rehearsal]{key="hold"}
:::

:::spec-item{key="release.residual_risks" type="multi_choice" required="true"}
Select every residual risk that must stay visible in the release log.
::option[Alert threshold calibration]{key="alert-calibration"}
::option[Rollback handoff timing]{key="rollback-handoff"}
::option[Operator runbook drift]{key="runbook-drift"}
::option[Dependency rate limiting]{key="dependency-limits"}
:::

:::spec-item{key="release.owner" type="short_text" required="true"}
Name the release owner and the immediate next step in one line.
:::

:::spec-item{key="release.rationale" type="long_text" required="true"}
Explain why the selected posture is justified and what evidence would stop the release.
:::

:::spec-item{key="release.confidence" type="rating" required="true"}
Rate confidence in release readiness from 1 (not ready) to 5 (ready with strong evidence).
:::
`;

export const RICH_BRIEFING_ROUND_TWO_MARKDOWN = `# Release candidate readiness review

The candidate now includes a clean downgrade rehearsal and corrected alert thresholds. The release boundary is narrower: one regional canary precedes general availability.

> Final validation restored the canary snapshot in 8 minutes, exercised the corrected page threshold, and assigned both release and incident command.

## Bounded scope

- Ship only artifact \`rc.2026.08.18+build.9\` through a 10% regional canary.
- Require rollback inside the 10 minute recovery objective.
- Pause expansion on any integrity alarm, page-delivery failure, or elevated write latency.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Forward and downgrade replay passed | Low |
| Page delivery | Corrected threshold reached both named leads | Low |
| Write latency | Canary budget defined at p95 under 180 ms | Medium |

\`\`\`ini
release.freeze=true
rollback.window=10m
release.candidate=rc.2026.08.18+build.9
release.canary_percent=10
\`\`\`

See the [revised release evidence packet](https://example.com/releases/rc-readiness-v2) for the exact follow-up record.

:::spec-item{key="release.verdict" type="verdict" required="true"}
Should build 9 remain eligible for the regional canary after the final rehearsal?
:::

:::spec-item{key="release.posture" type="single_choice" required="true"}
Choose the authorization boundary for this revised candidate.
::option[Authorize the 10% regional canary]{key="authorize-canary"}
::option[Require one more downgrade rehearsal]{key="repeat-downgrade"}
::option[Pause pending dependency recovery]{key="pause-dependency"}
:::

:::spec-item{key="release.residual_risks" type="multi_choice" required="true"}
Select every condition that must block expansion beyond the canary.
::option[Integrity alarm during reconciliation]{key="integrity-alarm"}
::option[Page delivery misses either named lead]{key="page-delivery"}
::option[Write latency exceeds the canary budget]{key="write-latency"}
::option[Rollback restore exceeds 10 minutes]{key="rollback-budget"}
:::

:::spec-item{key="release.owner" type="short_text" required="true"}
Record the canary owner and the first expansion checkpoint.
:::

:::spec-item{key="release.rationale" type="long_text" required="true"}
Summarize how the new downgrade and paging evidence changes the release decision, including explicit stop conditions.
:::

:::spec-item{key="release.confidence" type="rating" required="true"}
Rate confidence in the canary decision from 1 (unsafe) to 5 (ready to execute).
:::
`;

function fixedDigest(label: string): string {
  return createHash("sha256").update(`mandible-rich-briefing-demo:${label}`).digest("hex");
}

const DIRECTIVE_TYPES = [
  "verdict", "single_choice", "multi_choice", "short_text", "long_text", "rating",
] as const;

const ROUND_ONE_ANSWERS = [
  { directive_key: "release.verdict", operation: "set", expected_response_event_id: null, value: { verdict: "keep" } },
  { directive_key: "release.posture", operation: "set", expected_response_event_id: null, value: { option_key: "guarded" } },
  { directive_key: "release.residual_risks", operation: "set", expected_response_event_id: null,
    value: { option_keys: ["rollback-handoff", "alert-calibration"] } },
  { directive_key: "release.owner", operation: "set", expected_response_event_id: null,
    value: { text: "Mina Chen — open the guarded window after the incident lead joins." } },
  { directive_key: "release.rationale", operation: "set", expected_response_event_id: null,
    value: { text: "Proceed with guarded monitoring because the signed candidate, migration replay, and rollback rehearsal passed. Stop if paging misses the incident lead or rollback exceeds 15 minutes." } },
  { directive_key: "release.confidence", operation: "set", expected_response_event_id: null, value: { rating: 4 } },
] as const;

const ROUND_ONE_EXPECTED_VALUES = [
  { verdict: "keep" },
  { option_key: "guarded" },
  { option_keys: ["alert-calibration", "rollback-handoff"] },
  { text: "Mina Chen — open the guarded window after the incident lead joins." },
  { text: "Proceed with guarded monitoring because the signed candidate, migration replay, and rollback rehearsal passed. Stop if paging misses the incident lead or rollback exceeds 15 minutes." },
  { rating: 4 },
] as const;

function exactDemoUser(user: User, kind: UserKind, displayName: string): boolean {
  return user.kind === kind && user.status === "active" && user.display_name === displayName && user.email === null &&
    user.created_at === RICH_BRIEFING_DEMO.roundOneTimestamp - 1_000 &&
    user.updated_at === RICH_BRIEFING_DEMO.roundOneTimestamp - 1_000 &&
    JSON.stringify(user.metadata) === JSON.stringify({ fixture: "rich-briefing-demo", deterministic: true });
}

function demoUser(db: Db, slug: string, kind: UserKind, displayName: string): User {
  const existing = getUserBySlug(db, slug);
  if (existing) {
    if (!exactDemoUser(existing, kind, displayName)) {
      throw new Error(`Demo user '${slug}' exists with incompatible registry state.`);
    }
    return existing;
  }
  return createUser(db, {
    slug,
    kind,
    display_name: displayName,
    metadata: { fixture: "rich-briefing-demo", deterministic: true },
  }, RICH_BRIEFING_DEMO.roundOneTimestamp - 1_000);
}

function runRequest(markdown: string, reviewerId: string, ordinal: 1 | 2) {
  const timestamp = ordinal === 1
    ? RICH_BRIEFING_DEMO.roundOneTimestamp
    : RICH_BRIEFING_DEMO.roundTwoTimestamp;
  return parseBriefingRunRequest({
    schema: "mandible-briefing-run@1",
    briefing_key: RICH_BRIEFING_DEMO.briefingKey,
    title: RICH_BRIEFING_DEMO.title,
    task_identity: RICH_BRIEFING_DEMO.taskIdentity,
    run_id: `release-readiness-round-${ordinal}`,
    run_key: `release-readiness-round-${ordinal}`,
    responder_user_ids: [reviewerId],
    evidence: {
      series_ref: RICH_BRIEFING_DEMO.evidenceSeriesRef,
      version: ordinal,
      digest: fixedDigest(`round-${ordinal}-evidence`),
    },
    source_health: {
      source: RICH_BRIEFING_DEMO.source,
      status: "healthy",
      detail: ordinal === 1 ? "Candidate rehearsal complete." : "Revised candidate rehearsal complete.",
      observed_at: timestamp - 60_000,
    },
    document: { markdown },
    quiet_reason: null,
    occurrences: [
      "release.verdict", "release.posture", "release.residual_risks",
      "release.owner", "release.rationale", "release.confidence",
    ].map((directiveKey) => ({
      directive_key: directiveKey,
      evidence_digest: fixedDigest(`round-${ordinal}:${directiveKey}`),
      occurred_at: timestamp - 30_000,
      metadata: { fixture: "rich-briefing-demo", round: ordinal },
    })),
  });
}

export type RichBriefingDemoManifest = {
  schema: "mandible-rich-briefing-demo@2";
  result: "seeded" | "already-present";
  database_path: string;
  artifact_root: string | null;
  users: { publisher_user_id: string; reviewer_user_id: string };
  briefing: { id: string; key: string; title: string };
  rounds: Array<{
    id: string;
    ordinal: number;
    artifact_version_id: string;
    profile: "mandible-briefing.v2";
    document_digest: string;
    directive_types: typeof DIRECTIVE_TYPES;
    directive_count: 6;
    answer_count: number;
    annotation_count: number;
    submitted: boolean;
  }>;
  semantic_state: {
    round_one_answer_shapes: Record<string, (typeof DIRECTIVE_TYPES)[number]>;
    round_one_annotation_kinds: ["comment", "suggest_replacement"];
    round_one_frozen_answer_count: 6;
    round_one_frozen_annotation_count: 2;
    round_two_answers: 0;
    round_two_annotations: 0;
    round_two_submission: null;
    material_revision: true;
  };
};

function manifestFor(
  options: { databasePath: string; artifactRoot?: string },
  publisher: User,
  reviewer: User,
  briefingId: string,
  rounds: RichBriefingDemoManifest["rounds"],
  result: RichBriefingDemoManifest["result"],
): RichBriefingDemoManifest {
  return {
    schema: "mandible-rich-briefing-demo@2",
    result,
    database_path: options.databasePath,
    artifact_root: options.artifactRoot ?? null,
    users: { publisher_user_id: publisher.id, reviewer_user_id: reviewer.id },
    briefing: { id: briefingId, key: RICH_BRIEFING_DEMO.briefingKey, title: RICH_BRIEFING_DEMO.title },
    rounds,
    semantic_state: {
      round_one_answer_shapes: {
        "release.verdict": "verdict",
        "release.posture": "single_choice",
        "release.residual_risks": "multi_choice",
        "release.owner": "short_text",
        "release.rationale": "long_text",
        "release.confidence": "rating",
      },
      round_one_annotation_kinds: ["comment", "suggest_replacement"],
      round_one_frozen_answer_count: 6,
      round_one_frozen_annotation_count: 2,
      round_two_answers: 0,
      round_two_annotations: 0,
      round_two_submission: null,
      material_revision: true,
    },
  };
}

function exactExistingDemo(
  db: Db,
  options: { databasePath: string; artifactRoot?: string },
): RichBriefingDemoManifest | null {
  const markerCount = (
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE slug IN (?, ?)) +
         (SELECT COUNT(*) FROM briefings WHERE briefing_key = ?) +
         (SELECT COUNT(*) FROM briefing_runs WHERE task_identity = ?) AS n`,
    ).get(
      RICH_BRIEFING_DEMO.publisherSlug,
      RICH_BRIEFING_DEMO.reviewerSlug,
      RICH_BRIEFING_DEMO.briefingKey,
      RICH_BRIEFING_DEMO.taskIdentity,
    ) as { n: number }
  ).n;
  if (markerCount === 0) return null;

  const conflict = (detail: string): never => {
    throw new Error(`Rich Briefing demo state is partial or conflicting: ${detail}.`);
  };
  const publisher = getUserBySlug(db, RICH_BRIEFING_DEMO.publisherSlug);
  const reviewer = getUserBySlug(db, RICH_BRIEFING_DEMO.reviewerSlug);
  if (!publisher) return conflict("publisher registry state");
  if (!exactDemoUser(publisher, "agent", "Briefing Demo Publisher")) conflict("publisher registry state");
  if (!reviewer) return conflict("reviewer registry state");
  if (!exactDemoUser(reviewer, "human", "Briefing Demo Reviewer")) conflict("reviewer registry state");
  if (options.artifactRoot && getSetting(db, "artifact_root") !== options.artifactRoot) {
    conflict("artifact custody does not match the requested root");
  }

  const briefing = db.prepare(
    "SELECT id, title, latest_round_id, round_count FROM briefings WHERE briefing_key = ?",
  ).get(RICH_BRIEFING_DEMO.briefingKey) as {
    id: string; title: string; latest_round_id: string | null; round_count: number;
  } | undefined;
  if (!briefing) return conflict("logical Briefing identity or round count");
  if (briefing.title !== RICH_BRIEFING_DEMO.title || briefing.round_count !== 2) {
    conflict("logical Briefing identity or round count");
  }

  const expectedRequests = [
    runRequest(RICH_BRIEFING_ROUND_ONE_MARKDOWN, reviewer.id, 1),
    runRequest(RICH_BRIEFING_ROUND_TWO_MARKDOWN, reviewer.id, 2),
  ];
  const runs = db.prepare(
    `SELECT run_key, request_digest, briefing_id, round_id, artifact_version_id
       FROM briefing_runs WHERE publisher_user_id = ? AND task_identity = ? ORDER BY run_key`,
  ).all(publisher.id, RICH_BRIEFING_DEMO.taskIdentity) as Array<{
    run_key: string; request_digest: string; briefing_id: string;
    round_id: string | null; artifact_version_id: string | null;
  }>;
  if (runs.length !== 2) conflict("run count");
  for (const request of expectedRequests) {
    const stored = runs.find((run) => run.run_key === request.run_key);
    if (!stored || stored.request_digest !== briefingRunRequestDigest(request) ||
        stored.briefing_id !== briefing.id || !stored.round_id || !stored.artifact_version_id) {
      conflict(`run '${request.run_key}'`);
    }
  }

  const rounds = runs.map((run, index) => ({
    id: run.round_id!, ordinal: index + 1, artifact_version_id: run.artifact_version_id!,
  }));
  if (rounds[0].artifact_version_id === rounds[1].artifact_version_id) conflict("artifact versions are not distinct");
  const storedRounds = db.prepare(
    `SELECT id, ordinal, artifact_version_id, previous_round_id FROM briefing_rounds
      WHERE briefing_id = ? ORDER BY ordinal`,
  ).all(briefing.id) as Array<{
    id: string; ordinal: number; artifact_version_id: string; previous_round_id: string | null;
  }>;
  if (storedRounds.length !== 2 || briefing.latest_round_id !== rounds[1].id ||
      storedRounds[0]?.id !== rounds[0].id || storedRounds[0]?.ordinal !== 1 ||
      storedRounds[0]?.artifact_version_id !== rounds[0].artifact_version_id || storedRounds[0]?.previous_round_id !== null ||
      storedRounds[1]?.id !== rounds[1].id || storedRounds[1]?.ordinal !== 2 ||
      storedRounds[1]?.artifact_version_id !== rounds[1].artifact_version_id ||
      storedRounds[1]?.previous_round_id !== rounds[0].id) {
    conflict("round lineage");
  }
  const oldRound = readBriefing(db, briefing.id, {
    roundId: rounds[0].id, actorUserId: reviewer.id, operator: false,
  })?.selected_round;
  const newRound = readBriefing(db, briefing.id, {
    roundId: rounds[1].id, actorUserId: reviewer.id, operator: false,
  })?.selected_round;
  if (!oldRound) return conflict("round identity or immutable document bytes");
  if (!newRound) return conflict("round identity or immutable document bytes");
  if (oldRound.ordinal !== 1 || newRound.ordinal !== 2) conflict("round ordinals");
  const expectedRoundOneHash = createHash("sha256").update(expectedRequests[0].document!.markdown).digest("hex");
  const expectedRoundTwoHash = createHash("sha256").update(expectedRequests[1].document!.markdown).digest("hex");
  if (oldRound.document.content_hash !== expectedRoundOneHash) {
    conflict(`round 1 immutable document bytes (${oldRound.document.content_hash} != ${expectedRoundOneHash})`);
  }
  if (newRound.document.content_hash !== expectedRoundTwoHash) {
    conflict(`round 2 immutable document bytes (${newRound.document.content_hash} != ${expectedRoundTwoHash})`);
  }
  const answers = oldRound.answers.map((answer) => ({
    key: answer.directive_key,
    response_type: answer.response_type,
    value: answer.value,
    created_at: answer.created_at,
  }));
  if (JSON.stringify(answers) !== JSON.stringify([
    { key: "release.verdict", response_type: "verdict", value: ROUND_ONE_EXPECTED_VALUES[0], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
    { key: "release.posture", response_type: "single_choice", value: ROUND_ONE_EXPECTED_VALUES[1], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
    { key: "release.residual_risks", response_type: "multi_choice", value: ROUND_ONE_EXPECTED_VALUES[2], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
    { key: "release.owner", response_type: "short_text", value: ROUND_ONE_EXPECTED_VALUES[3], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
    { key: "release.rationale", response_type: "long_text", value: ROUND_ONE_EXPECTED_VALUES[4], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
    { key: "release.confidence", response_type: "rating", value: ROUND_ONE_EXPECTED_VALUES[5], created_at: RICH_BRIEFING_DEMO.answersTimestamp },
  ])) conflict("round 1 answers");
  const annotations = oldRound.annotations as Array<{
    annotation_event_id: string; annotation_kind: string; quote: string; body: string | null;
    replacement_text: string | null; created_at: number;
  }>;
  const submission = oldRound.latest_submission as {
    id: string; ordinal: number; actor_user_id: string; created_at: number;
  } | null;
  if (annotations.length !== 2 ||
      annotations[0]?.annotation_kind !== "comment" || annotations[0]?.quote !== "Staging rehearsal completed" ||
      annotations[0]?.body !== "Confirm the rehearsal log is attached to the final release record." ||
      annotations[0]?.replacement_text !== null || annotations[0]?.created_at !== RICH_BRIEFING_DEMO.annotationsTimestamp ||
      annotations[1]?.annotation_kind !== "suggest_replacement" || annotations[1]?.quote !== "15 minute recovery objective" ||
      annotations[1]?.body !== "Use the tighter objective demonstrated by the final rehearsal." ||
      annotations[1]?.replacement_text !== "10 minute recovery objective" ||
      annotations[1]?.created_at !== RICH_BRIEFING_DEMO.annotationsTimestamp ||
      !submission || submission.ordinal !== 1 || submission.actor_user_id !== reviewer.id ||
      submission.created_at !== RICH_BRIEFING_DEMO.submissionTimestamp ||
      JSON.stringify([...(oldRound.latest_frozen_membership?.answer_event_ids ?? [])].sort()) !==
        JSON.stringify(oldRound.answers.map((answer) => answer.response_event_id).sort()) ||
      JSON.stringify([...(oldRound.latest_frozen_membership?.annotation_event_ids ?? [])].sort()) !==
        JSON.stringify(annotations.map((annotation) => annotation.annotation_event_id).sort())) {
    conflict("round 1 annotations or frozen submission");
  }
  if (newRound.answers.length !== 0 || newRound.annotations.length !== 0 || newRound.latest_submission) {
    conflict("round 2 actor state");
  }
  const exactCounts = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM briefing_response_events WHERE round_id = ? AND actor_user_id = ?) AS answers,
       (SELECT COUNT(*) FROM briefing_annotation_events WHERE round_id = ? AND actor_user_id = ?) AS annotations,
       (SELECT COUNT(*) FROM briefing_submissions WHERE round_id = ? AND actor_user_id = ?) AS submissions`,
  ).get(rounds[0].id, reviewer.id, rounds[0].id, reviewer.id, rounds[0].id, reviewer.id) as {
    answers: number; annotations: number; submissions: number;
  };
  if (exactCounts.answers !== 6 || exactCounts.annotations !== 2 || exactCounts.submissions !== 1) {
    conflict("event or submission counts");
  }

  const oldItems = oldRound.items as Array<{ response_type: string; prompt: string; options: unknown }>;
  const newItems = newRound.items as Array<{ response_type: string; prompt: string; options: unknown }>;
  const roundOneTypes = oldItems.map((item) => item.response_type);
  const roundTwoTypes = newItems.map((item) => item.response_type);
  if (JSON.stringify(roundOneTypes) !== JSON.stringify(DIRECTIVE_TYPES) ||
      JSON.stringify(roundTwoTypes) !== JSON.stringify(DIRECTIVE_TYPES) ||
      oldItems.some((item, index) => item.prompt === newItems[index]?.prompt ||
        ((item.response_type === "single_choice" || item.response_type === "multi_choice") &&
          JSON.stringify(item.options) === JSON.stringify(newItems[index]?.options)))) {
    conflict("typed directive set or material round revision");
  }

  return manifestFor(options, publisher, reviewer, briefing.id, [
    {
      ...rounds[0], profile: "mandible-briefing.v2", document_digest: expectedRoundOneHash, directive_types: DIRECTIVE_TYPES,
      directive_count: 6, answer_count: 6, annotation_count: 2, submitted: true,
    },
    {
      ...rounds[1], profile: "mandible-briefing.v2", document_digest: expectedRoundTwoHash, directive_types: DIRECTIVE_TYPES,
      directive_count: 6, answer_count: 0, annotation_count: 0, submitted: false,
    },
  ], "already-present");
}

export function seedRichBriefingDemo(
  db: Db,
  options: { databasePath: string; artifactRoot?: string },
): RichBriefingDemoManifest {
  const existing = exactExistingDemo(db, options);
  if (existing) return existing;
  return db.transaction(() => seedNewRichBriefingDemo(db, options))();
}

function seedNewRichBriefingDemo(
  db: Db,
  options: { databasePath: string; artifactRoot?: string },
): RichBriefingDemoManifest {
  if (options.artifactRoot) setSetting(db, "artifact_root", options.artifactRoot);
  const publisher = demoUser(db, RICH_BRIEFING_DEMO.publisherSlug, "agent", "Briefing Demo Publisher");
  const reviewer = demoUser(db, RICH_BRIEFING_DEMO.reviewerSlug, "human", "Briefing Demo Reviewer");

  const first = publishBriefingRun(
    db,
    runRequest(RICH_BRIEFING_ROUND_ONE_MARKDOWN, reviewer.id, 1),
    publisher.id,
    RICH_BRIEFING_DEMO.roundOneTimestamp,
  );
  if (!first.round_id || !first.artifact_version_id) throw new Error("Round 1 did not create an immutable document round.");

  const answerResult = applyBriefingAnswers(
    db, first.briefing_id, first.round_id, reviewer.id, ROUND_ONE_ANSWERS, RICH_BRIEFING_DEMO.answersTimestamp,
  );

  const commentQuote = "Staging rehearsal completed";
  const suggestionQuote = "15 minute recovery objective";
  const annotations = applyBriefingAnnotations(db, first.briefing_id, first.round_id, reviewer.id, [
    {
      operation: "set",
      kind: "comment",
      start_offset: RICH_BRIEFING_ROUND_ONE_MARKDOWN.indexOf(commentQuote),
      end_offset: RICH_BRIEFING_ROUND_ONE_MARKDOWN.indexOf(commentQuote) + commentQuote.length,
      quote: commentQuote,
      body: "Confirm the rehearsal log is attached to the final release record.",
      replacement_text: null,
    },
    {
      operation: "set",
      kind: "suggest_replacement",
      start_offset: RICH_BRIEFING_ROUND_ONE_MARKDOWN.indexOf(suggestionQuote),
      end_offset: RICH_BRIEFING_ROUND_ONE_MARKDOWN.indexOf(suggestionQuote) + suggestionQuote.length,
      quote: suggestionQuote,
      body: "Use the tighter objective demonstrated by the final rehearsal.",
      replacement_text: "10 minute recovery objective",
    },
  ], RICH_BRIEFING_DEMO.annotationsTimestamp);

  submitBriefingRound(db, first.briefing_id, first.round_id, reviewer.id, {
    answers: (answerResult.answers as Array<{ directive_key: string; response_event_id: string }>).map((answer) => ({
      directive_key: answer.directive_key,
      response_event_id: answer.response_event_id,
    })),
    annotation_event_ids: annotations.annotation_event_ids,
    supersedes_submission_id: null,
  }, RICH_BRIEFING_DEMO.submissionTimestamp);

  const second = publishBriefingRun(
    db,
    runRequest(RICH_BRIEFING_ROUND_TWO_MARKDOWN, reviewer.id, 2),
    publisher.id,
    RICH_BRIEFING_DEMO.roundTwoTimestamp,
  );
  if (!second.round_id || !second.artifact_version_id) throw new Error("Round 2 did not create an immutable document round.");
  if (second.artifact_version_id === first.artifact_version_id) throw new Error("The revised round reused the prior artifact version.");

  const oldRound = readBriefing(db, first.briefing_id, {
    roundId: first.round_id,
    actorUserId: reviewer.id,
    operator: false,
  })?.selected_round;
  const newRound = readBriefing(db, first.briefing_id, {
    roundId: second.round_id,
    actorUserId: reviewer.id,
    operator: false,
  })?.selected_round;
  if (!oldRound || !newRound) throw new Error("The seeded Briefing could not be projected.");
  if (oldRound.answers.length !== 6 || oldRound.annotations.length !== 2 || !oldRound.latest_submission) {
    throw new Error("Round 1 does not match the frozen response membership.");
  }
  if (newRound.answers.length !== 0 || newRound.annotations.length !== 0 || newRound.latest_submission) {
    throw new Error("Round 2 carried actor state forward.");
  }

  return manifestFor(options, publisher, reviewer, first.briefing_id, [
      {
        id: first.round_id, ordinal: 1, artifact_version_id: first.artifact_version_id,
        profile: "mandible-briefing.v2",
        document_digest: createHash("sha256").update(RICH_BRIEFING_ROUND_ONE_MARKDOWN).digest("hex"),
        directive_types: DIRECTIVE_TYPES,
        directive_count: 6, answer_count: 6, annotation_count: 2, submitted: true,
      },
      {
        id: second.round_id, ordinal: 2, artifact_version_id: second.artifact_version_id,
        profile: "mandible-briefing.v2",
        document_digest: createHash("sha256").update(RICH_BRIEFING_ROUND_TWO_MARKDOWN).digest("hex"),
        directive_types: DIRECTIVE_TYPES,
        directive_count: 6, answer_count: 0, annotation_count: 0, submitted: false,
      },
    ], "seeded");
}
