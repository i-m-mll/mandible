import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAskAnnotations,
  createAsk,
  observeAsk,
  readAsk,
  submitAsk,
} from "../src/feedback/asks.js";
import { migrate, type Db } from "../src/db.js";
import { addGrant } from "../src/permissions/store.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";
import { createUser } from "../src/users/store.js";

let db: Db;
let tempDir: string;
let agentId: string;
let human1: string;
let human2: string;
const projectId = "project-docs";

function record(content: string, now: number, seriesKey = "managed:test:plan") {
  const result = recordArtifactVersion(db, {
    source_kind: "managed", provider_id: "test", content, media_type: "text/markdown",
    logical_name: "plan", series_key: seriesKey,
  }, now, tempDir);
  db.prepare("UPDATE artifact SET source_project_id = ? WHERE id = ?").run(projectId, result.version.artifact_id);
  db.prepare("UPDATE artifact_version SET source_project_id = ? WHERE id = ?").run(projectId, result.version.id);
  return result;
}

function packet(version: string, overrides: Record<string, unknown> = {}) {
  return {
    request_key: `request-${version}-${String(overrides.request_key ?? "base")}`,
    session_id: "session-1",
    responder_user_ids: [human1, human2],
    expires_at: 5_000,
    items: [],
    document: { artifact_version: version },
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-annotations-"));
  agentId = createUser(db, { slug: "asker", kind: "agent", display_name: "Asker" }).id;
  human1 = createUser(db, { slug: "human-1", kind: "human", display_name: "Human 1" }).id;
  human2 = createUser(db, { slug: "human-2", kind: "human", display_name: "Human 2" }).id;
  db.prepare(
    `INSERT INTO ledger_projects
       (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at, project_key, restricted)
     VALUES (?, 'Docs', '', '', 'local', 1, 1, 'docs', 1)`,
  ).run(projectId);
  addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
  for (const user of [agentId, human1, human2]) {
    addGrant(db, { subject_type: "user", subject: user, resource_type: "project", resource: projectId, permission: "read" });
  }
  db.prepare("INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('session-1','codex','active',?)")
    .run(agentId);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("annotatable ask store", () => {
  it("pins exact version bytes, validates UTF-16 ranges, freezes membership, and scopes chains per responder", () => {
    const v1 = record("A 😀 plan\n", 100);
    record("A changed plan\n", 101);
    const created = createAsk(db, packet(v1.version.id), { requesterUserId: agentId, now: 1_000 });
    const first = applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "set", annotation_kind: "comment", start_offset: 2, end_offset: 4,
      quote: "😀", body: "Keep this emoji.",
    }], 1_100);
    applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "retract", annotation_event_id: first.annotation_event_ids[0],
    }], 1_101);
    expect(() => applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "retract", annotation_event_id: first.annotation_event_ids[0],
    }], 1_102)).toThrowError(expect.objectContaining({ code: "stale_annotation_event" }));
    const replacement = applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "set", annotation_kind: "comment", start_offset: 2, end_offset: 4,
      quote: "😀", body: "Keep this emoji.",
    }], 1_103);
    expect(() => applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "set", annotation_kind: "comment", start_offset: 2, end_offset: 3,
      quote: "😀", body: "bad boundary",
    }], 1_101)).toThrowError(expect.objectContaining({ code: "quote_mismatch" }));
    const opened = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_150 })!.ask;
    expect(() => submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id, answers: [], annotations: [],
    }, 1_199)).toThrowError(expect.objectContaining({ code: "stale_submission_annotations" }));
    const submitted1 = submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id,
      answers: [], annotations: [{ annotation_event_id: replacement.annotation_event_ids[0] }],
    }, 1_200);
    const later = applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "set", annotation_kind: "suggest_replacement", start_offset: 0, end_offset: 1,
      quote: "A", replacement_text: "", body: "Delete it.",
    }], 1_250);
    expect(submitted1.result.submissions[0].annotations.map((entry) => entry.annotation_event_id))
      .toEqual(replacement.annotation_event_ids);

    const forHuman2 = readAsk(db, created.ask_id, { answerActorUserId: human2, now: 1_300 })!.ask;
    const submitted2 = submitAsk(db, created.ask_id, human2, {
      expected_lifecycle_event_id: forHuman2.lifecycle_event_id,
      answers: [], annotations: [], supersedes_submission_id: null,
    }, 1_300);
    expect(submitted2.ordinal).toBe(2);
    expect(submitted2.result.submissions).toHaveLength(2);
    expect(forHuman2.latest_submission_for_actor).toBeNull();
    const correctionHead = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_350 })!.ask;
    const correction = submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: correctionHead.lifecycle_event_id,
      supersedes_submission_id: submitted1.submission_id,
      answers: [],
      annotations: [replacement.annotation_event_ids[0], later.annotation_event_ids[0]]
        .map((annotation_event_id) => ({ annotation_event_id })),
    }, 1_350);
    expect(correction.ordinal).toBe(3);
    expect(correction.result.submissions.find((entry) => entry.actor_user_id === human1)?.annotations
      .map((entry) => [entry.quote, entry.position])).toEqual([["A", 0], ["😀", 1]]);
  });

  it("expires after a responder submits and binds explicit same-artifact round lineage", () => {
    const version = record("Plan\n", 100);
    const first = createAsk(db, packet(version.version.id, { expires_at: 1_500 }), {
      requesterUserId: agentId, now: 1_000,
    });
    const annotation = applyAskAnnotations(db, first.ask_id, human1, [{
      operation: "set", annotation_kind: "comment", start_offset: 0, end_offset: 4,
      quote: "Plan", body: "History note",
    }], 1_050);
    const opened = readAsk(db, first.ask_id, { answerActorUserId: human1, now: 1_100 })!.ask;
    submitAsk(db, first.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id, answers: [],
      annotations: [{ annotation_event_id: annotation.annotation_event_ids[0] }],
    }, 1_200);
    expect(observeAsk(db, first.ask_id, 1_600)!.result.state).toBe("expired");
    const successor = createAsk(db, packet(version.version.id, {
      request_key: "successor", document: {
        artifact_version: version.version.id, previous_round_id: first.ask_id,
      },
    }), { requesterUserId: agentId, now: 1_700 });
    expect(readAsk(db, successor.ask_id, { viewerUserId: human1, answerActorUserId: human1, now: 1_701 })!.ask.document)
      .toEqual({ artifact_version_id: version.version.id, previous_round_id: first.ask_id });
    expect(readAsk(db, successor.ask_id, { viewerUserId: human1, answerActorUserId: human1, now: 1_701 })!
      .ask.previous_round?.annotations[0]).toMatchObject({ quote: "Plan", submission_ordinal: 1 });
    const newcomer = createUser(db, { slug: "newcomer", kind: "human", display_name: "Newcomer" }).id;
    addGrant(db, { subject_type: "user", subject: newcomer, resource_type: "project", resource: projectId, permission: "read" });
    const widened = createAsk(db, packet(version.version.id, {
      request_key: "widened", responder_user_ids: [newcomer], document: {
        artifact_version: version.version.id, previous_round_id: first.ask_id,
      },
    }), { requesterUserId: agentId, now: 1_800 });
    expect(readAsk(db, widened.ask_id, { viewerUserId: newcomer, answerActorUserId: newcomer, now: 1_801 })!
      .ask.previous_round).toBeNull();
  });

  it("rejects invalid, unauthorized, conflicting, and cross-document round associations", () => {
    const firstVersion = record("Plan one\n", 100);
    const otherVersion = record("Other plan\n", 101, "managed:test:other-plan");
    expect(() => createAsk(db, packet("artifact-version:missing"), {
      requesterUserId: agentId, now: 1_000,
    })).toThrowError(expect.objectContaining({ code: "invalid_document_version" }));
    const unauthorized = createUser(db, { slug: "no-doc-access", kind: "human", display_name: "No Access" }).id;
    expect(() => createAsk(db, packet(firstVersion.version.id, {
      request_key: "forbidden", responder_user_ids: [unauthorized],
    }), { requesterUserId: agentId, now: 1_000 }))
      .toThrowError(expect.objectContaining({ code: "document_forbidden" }));
    const first = createAsk(db, packet(firstVersion.version.id, { request_key: "lineage-root" }), {
      requesterUserId: agentId, now: 1_000,
    });
    expect(() => createAsk(db, packet(otherVersion.version.id, {
      request_key: "wrong-series", document: {
        artifact_version: otherVersion.version.id, previous_round_id: first.ask_id,
      },
    }), { requesterUserId: agentId, now: 1_001 }))
      .toThrowError(expect.objectContaining({ code: "round_series_mismatch" }));
    expect(() => createAsk(db, packet(otherVersion.version.id, { request_key: "lineage-root" }), {
      requesterUserId: agentId, now: 1_002,
    })).toThrowError(expect.objectContaining({ code: "ask_request_conflict" }));
  });
});
