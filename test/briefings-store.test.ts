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
  parseBriefingRunRequest,
  publishBriefingRun,
  readBriefing,
  submitBriefingRound,
} from "../src/feedback/briefings.js";
import { createUser } from "../src/users/store.js";

let db: Db;
let root: string;
let publisherId: string;
let humanId: string;

const digest = (letter: string) => letter.repeat(64);

function request(markdown = '# Daily\n\n:::spec-item{key="paper" required="true"}\nKeep this paper?\n:::\n', overrides: Record<string, unknown> = {}) {
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
  it("replays immutable run identities, records quiet receipts, and reuses only unchanged artifact versions", () => {
    const first = publishBriefingRun(db, request(), publisherId, 1_000);
    expect(publishBriefingRun(db, request(), publisherId, 1_001)).toEqual(first);
    expect(() => publishBriefingRun(db, request(undefined, { run_id: "conflict" }), publisherId, 1_002))
      .toThrowError(BriefingStoreError);

    const second = publishBriefingRun(db, request(undefined, { run_id: "run-2", run_key: "run-key-2" }), publisherId, 2_000);
    expect(second.round_id).not.toBe(first.round_id);
    expect(second.artifact_version_id).toBe(first.artifact_version_id);

    const changed = publishBriefingRun(db, request('# Daily changed\n\n:::spec-item{key="paper" required="true"}\nKeep this revised paper?\n:::\n', {
      run_id: "run-3", run_key: "run-key-3",
    }), publisherId, 3_000);
    expect(changed.artifact_version_id).not.toBe(first.artifact_version_id);
    expect(readBriefing(db, first.briefing_id, { roundId: first.round_id!, actorUserId: humanId, operator: false })
      ?.selected_round.document.source).toContain("Keep this paper?");

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
    expect(() => readBriefing(db, first.briefing_id, { actorUserId: humanId, operator: false }))
      .toThrowError(/unavailable|integrity/);
  });
});
