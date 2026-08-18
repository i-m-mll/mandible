import { createHash } from "node:crypto";

import { setSetting } from "../client-auth/settings-kv.js";
import type { Db } from "../db.js";
import { createUser, getUserBySlug } from "../users/store.js";
import type { User, UserKind } from "../users/types.js";
import {
  applyBriefingAnnotations,
  applyBriefingAnswers,
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

The candidate is feature-complete; this review confirms bounded release readiness with \`release.freeze=true\`.

> Staging rehearsal completed with the candidate artifact and the documented rollback path.

## Bounded scope

- Approve only the signed candidate artifact.
- Keep rollback within the 15 minute recovery objective.
- Confirm dashboards before opening the release window.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Migration replay passed | Low |
| Alert gaps | Synthetic checks passed | Medium |

\`\`\`ini
release.freeze=true
rollback.window=15m
\`\`\`

See the [release evidence packet](https://example.com/releases/rc-readiness) for the immutable source record.

:::spec-item{key="scope.approval" required="true"}
Keep the candidate within the reviewed release scope?
:::

:::spec-item{key="rollback.plan" required="true"}
Keep the rehearsed rollback plan as the release fallback?
:::

:::spec-item{key="observability" required="false"}
Keep the current observability coverage for the release window?
:::

:::spec-item{key="operator.runbook"}
Keep the operator runbook as the execution guide?
:::
`;

export const RICH_BRIEFING_ROUND_TWO_MARKDOWN = `# Release candidate readiness review

The candidate now includes the final migration rehearsal; this review confirms the revised boundary with \`release.freeze=true\`.

> Production-shaped validation completed after the alert thresholds and rollback owner were clarified.

## Bounded scope

- Approve only the newly signed candidate artifact.
- Require rollback inside the 10 minute recovery objective.
- Confirm dashboards and the named incident lead before opening the release window.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Clean replay plus downgrade rehearsal | Low |
| Alert gaps | Thresholds exercised end to end | Low |

\`\`\`ini
release.freeze=true
rollback.window=10m
\`\`\`

See the [revised release evidence packet](https://example.com/releases/rc-readiness-v2) for the exact follow-up record.

:::spec-item{key="scope.approval" required="true"}
Keep the revised candidate inside the final reviewed release scope?
:::

:::spec-item{key="rollback.plan" required="true"}
Keep the tightened rollback plan as the release fallback?
:::

:::spec-item{key="observability" required="false"}
Keep the exercised alert thresholds for the release window?
:::

:::spec-item{key="operator.runbook"}
Keep the clarified operator runbook as the execution guide?
:::
`;

function fixedDigest(label: string): string {
  return createHash("sha256").update(`mandible-rich-briefing-demo:${label}`).digest("hex");
}

function demoUser(db: Db, slug: string, kind: UserKind, displayName: string): User {
  const existing = getUserBySlug(db, slug);
  if (existing) {
    if (existing.kind !== kind || existing.status !== "active") {
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
    occurrences: ["scope.approval", "rollback.plan", "observability", "operator.runbook"].map((directiveKey) => ({
      directive_key: directiveKey,
      evidence_digest: fixedDigest(`round-${ordinal}:${directiveKey}`),
      occurred_at: timestamp - 30_000,
      metadata: { fixture: "rich-briefing-demo", round: ordinal },
    })),
  });
}

export type RichBriefingDemoManifest = {
  schema: "mandible-rich-briefing-demo@1";
  database_path: string;
  artifact_root: string | null;
  users: { publisher_user_id: string; reviewer_user_id: string };
  briefing: { id: string; key: string; title: string };
  rounds: Array<{ id: string; ordinal: number; artifact_version_id: string; submitted: boolean }>;
  semantic_state: {
    round_one_answers: Record<string, "keep" | "dismiss">;
    round_one_annotation_kinds: ["comment", "suggest_replacement"];
    round_one_frozen_answer_count: 3;
    round_one_frozen_annotation_count: 2;
    round_two_answers: 0;
    round_two_annotations: 0;
    round_two_submission: null;
  };
};

export function seedRichBriefingDemo(
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

  const answerResult = applyBriefingAnswers(db, first.briefing_id, first.round_id, reviewer.id, [
    { directive_key: "scope.approval", operation: "set", expected_response_event_id: null, value: { verdict: "keep" } },
    { directive_key: "rollback.plan", operation: "set", expected_response_event_id: null, value: { verdict: "dismiss" } },
    { directive_key: "operator.runbook", operation: "set", expected_response_event_id: null, value: { verdict: "keep" } },
  ], RICH_BRIEFING_DEMO.answersTimestamp);

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
  if (oldRound.answers.length !== 3 || oldRound.annotations.length !== 2 || !oldRound.latest_submission) {
    throw new Error("Round 1 does not match the frozen response membership.");
  }
  if (newRound.answers.length !== 0 || newRound.annotations.length !== 0 || newRound.latest_submission) {
    throw new Error("Round 2 carried actor state forward.");
  }

  return {
    schema: "mandible-rich-briefing-demo@1",
    database_path: options.databasePath,
    artifact_root: options.artifactRoot ?? null,
    users: { publisher_user_id: publisher.id, reviewer_user_id: reviewer.id },
    briefing: { id: first.briefing_id, key: RICH_BRIEFING_DEMO.briefingKey, title: RICH_BRIEFING_DEMO.title },
    rounds: [
      { id: first.round_id, ordinal: 1, artifact_version_id: first.artifact_version_id, submitted: true },
      { id: second.round_id, ordinal: 2, artifact_version_id: second.artifact_version_id, submitted: false },
    ],
    semantic_state: {
      round_one_answers: { "scope.approval": "keep", "rollback.plan": "dismiss", "operator.runbook": "keep" },
      round_one_annotation_kinds: ["comment", "suggest_replacement"],
      round_one_frozen_answer_count: 3,
      round_one_frozen_annotation_count: 2,
      round_two_answers: 0,
      round_two_annotations: 0,
      round_two_submission: null,
    },
  };
}
