import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAskAnswers,
  applyAskAnnotations,
  createAsk,
  observeAsk,
  readAsk,
  submitAsk,
} from "../src/feedback/asks.js";
import {
  exportSubmissionMarkdown,
  markdownBlockquote,
  markdownHeading,
  resolveSubmissionRef,
} from "../src/feedback/submissions.js";
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
  it("keeps a profiled document's parser identity in frozen submission export", () => {
    const version = record(":::spec-item{key=\"ship\"}\nShip it\n:::\n", 100);
    const created = createAsk(db, packet(version.version.id, {
      document: { artifact_version: version.version.id, profile: "mandible-briefing.v1" },
    }), { requesterUserId: agentId, now: 1_000 });
    const opened = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_001 })!.ask;
    expect(opened.document).toMatchObject({ profile: "mandible-briefing.v1" });
    expect(opened.directive_binding).toEqual({ status: "valid" });
    expect(opened.items).toHaveLength(1);
    expect(opened.items[0]).toMatchObject({ client_item_key: "ship", revision: { response_type: "verdict", required: false, prompt: "Ship it" }, directive: { key: "ship" } });
    expect(db.prepare("SELECT directive_key, start_offset, end_offset FROM feedback_item_directives WHERE collection_id = ?")
      .all(created.ask_id)).toEqual([{ directive_key: "ship", start_offset: 0, end_offset: 36 }]);
    submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id, answers: [], annotations: [],
    }, 1_002);
    const resolved = resolveSubmissionRef(db, `submission:${created.ask_id}#1`, { userId: human1, isOperator: false });
    expect(resolved.ok).toBe(true);
    const packetOut = exportSubmissionMarkdown(db, resolved as Extract<typeof resolved, { ok: true }>);
    expect(packetOut).toContain("document_profile: mandible-briefing.v1");
  });

  it("rejects malformed profiled packets atomically and permits independent rounds on one version", () => {
    const good = record(":::spec-item{key=\"a\"}\nA\n:::\n", 100);
    const malformed = [
      ":::spec-item{key=\"a\"}\n\n:::\n",
      ":::spec-item{key=\"a\"}\nA\n:::\n\n:::spec-item{key=\"a\"}\nB\n:::\n",
      ":::other{key=\"a\"}\nA\n:::\n",
      ":::spec-item{key=\"a\"}\n:::spec-item{key=\"b\"}\nB\n:::\n:::\n",
    ];
    for (const [index, content] of malformed.entries()) {
      const version = record(content, 110 + index, `managed:test:bad-${index}`);
      const before = db.prepare("SELECT COUNT(*) AS n FROM feedback_collections").get() as { n: number };
      expect(() => createAsk(db, packet(version.version.id, {
        request_key: `bad-${index}`, document: { artifact_version: version.version.id, profile: "mandible-briefing.v1" },
      }), { requesterUserId: agentId, now: 1_000 })).toThrowError(expect.objectContaining({ code: "invalid_briefing_document" }));
      expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_collections").get()).toEqual(before);
    }
    expect(() => createAsk(db, packet(good.version.id, {
      request_key: "caller-items", items: [{ client_item_key: "x", item_kind: "item", title: "x", prompt: "x", response_type: "free_text" }],
      document: { artifact_version: good.version.id, profile: "mandible-briefing.v1" },
    }), { requesterUserId: agentId, now: 1_000 })).toThrow(/items/);
    const one = createAsk(db, packet(good.version.id, { request_key: "one", document: { artifact_version: good.version.id, profile: "mandible-briefing.v1" } }), { requesterUserId: agentId, now: 1_000 });
    const two = createAsk(db, packet(good.version.id, { request_key: "two", document: { artifact_version: good.version.id, profile: "mandible-briefing.v1" } }), { requesterUserId: agentId, now: 1_001 });
    expect(one.ask_id).not.toBe(two.ask_id);
  });

  it("projects corrupt directive bindings as invalid and gates mutations after audience authorization", () => {
    const version = record(":::spec-item{key=\"a\"}\nA\n:::\n", 100);
    const created = createAsk(db, packet(version.version.id, { request_key: "binding-gate", document: { artifact_version: version.version.id, profile: "mandible-briefing.v1" } }), { requesterUserId: agentId, now: 1_000 });
    const opened = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_001 })!.ask;
    db.prepare("UPDATE feedback_item_directives SET definition_digest = ? WHERE collection_id = ?").run("0".repeat(64), created.ask_id);
    expect(readAsk(db, created.ask_id, { answerActorUserId: human1 })!.ask.directive_binding?.status).toBe("invalid");
    expect(() => applyAskAnswers(db, created.ask_id, human1, [], 1_002)).toThrowError(expect.objectContaining({ code: "directive_binding_invalid" }));
    expect(() => applyAskAnnotations(db, created.ask_id, human1, [], 1_002)).toThrowError(expect.objectContaining({ code: "directive_binding_invalid" }));
    expect(() => submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id, answers: [], annotations: [],
    }, 1_002)).toThrowError(expect.objectContaining({ code: "directive_binding_invalid" }));
    expect(() => applyAskAnswers(db, created.ask_id, "outsider", [], 1_002)).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("replays a profiled request without reading or reparsing unavailable pinned bytes", () => {
    const version = record(":::spec-item{key=\"a\"}\nA\n:::\n", 100);
    const request = packet(version.version.id, {
      request_key: "unavailable-replay",
      document: { artifact_version: version.version.id, profile: "mandible-briefing.v1" },
    });
    const created = createAsk(db, request, { requesterUserId: agentId, now: 1_000 });
    fs.rmSync(tempDir, { recursive: true, force: true });
    const replayed = createAsk(db, request, { requesterUserId: agentId, now: 1_100 });
    expect(replayed).toMatchObject({ ask_id: created.ask_id, request_digest: created.request_digest, replay: true });
  });

  it("projects actor-scoped frozen membership and rejects an unchanged correction", () => {
    const version = record(":::spec-item{key=\"a\" required=\"true\"}\nA\n:::\n", 100);
    const created = createAsk(db, packet(version.version.id, {
      request_key: "membership",
      document: { artifact_version: version.version.id, profile: "mandible-briefing.v1" },
    }), { requesterUserId: agentId, now: 1_000 });
    const opened = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_001 })!.ask;
    const item = opened.items[0];
    const firstAnswer = applyAskAnswers(db, created.ask_id, human1, [{
      item_id: item.id,
      item_revision_id: item.revision.id,
      operation: "set",
      value: { verdict: "keep" },
      expected_response_event_id: null,
    }], 1_002).answer_event_ids[0];
    const first = submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id,
      answers: [{ item_id: item.id, item_revision_id: item.revision.id, response_event_id: firstAnswer }],
      annotations: [],
    }, 1_003);
    expect(readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_004 })!.ask.latest_frozen_membership)
      .toEqual({ answer_event_ids: [firstAnswer], annotation_event_ids: [] });
    expect(readAsk(db, created.ask_id, { answerActorUserId: human2, now: 1_004 })!.ask.latest_frozen_membership)
      .toBeNull();
    expect(() => submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: first.lifecycle_event_id,
      supersedes_submission_id: first.submission_id,
      answers: [{ item_id: item.id, item_revision_id: item.revision.id, response_event_id: firstAnswer }],
      annotations: [],
    }, 1_005)).toThrowError(expect.objectContaining({ code: "no_op_correction" }));
    const secondAnswer = applyAskAnswers(db, created.ask_id, human1, [{
      item_id: item.id,
      item_revision_id: item.revision.id,
      operation: "set",
      value: { verdict: "dismiss" },
      expected_response_event_id: firstAnswer,
    }], 1_006).answer_event_ids[0];
    expect(submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: first.lifecycle_event_id,
      supersedes_submission_id: first.submission_id,
      answers: [{ item_id: item.id, item_revision_id: item.revision.id, response_event_id: secondAnswer }],
      annotations: [],
    }, 1_007).ordinal).toBe(2);
  });

  it("pins submission-export Markdown escaping and blockquote line bytes", () => {
    expect(markdownBlockquote("first\r\nsecond\rthird\nfourth"))
      .toBe("> first\n> second\n> third\n> fourth");
    expect(markdownHeading("Title #1\nnext"))
      .toBe("Title \\#1 next");
  });

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
    const firstResolution = resolveSubmissionRef(
      db,
      `submission:${created.ask_id}#1`,
      { userId: human1, isOperator: false },
    );
    expect(firstResolution.ok).toBe(true);
    const frozenExport = exportSubmissionMarkdown(db, firstResolution as Extract<typeof firstResolution, { ok: true }>);
    const later = applyAskAnnotations(db, created.ask_id, human1, [{
      operation: "set", annotation_kind: "suggest_replacement", start_offset: 0, end_offset: 1,
      quote: "A", replacement_text: "", body: "Delete it.",
    }], 1_250);
    expect(exportSubmissionMarkdown(db, firstResolution as Extract<typeof firstResolution, { ok: true }>))
      .toBe(frozenExport);
    expect(frozenExport).toContain(`document_artifact_version: ${v1.version.id}`);
    expect(frozenExport).toContain("### 1. comment [2–4]\n> 😀\n\nKeep this emoji.");
    expect(frozenExport.endsWith("A 😀 plan\n")).toBe(true);
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

  it("fails deterministic export rather than emitting a partial document when pinned bytes disappear", () => {
    const version = record("Pinned plan without a trailing newline", 100);
    const created = createAsk(db, packet(version.version.id, { request_key: "missing-export" }), {
      requesterUserId: agentId, now: 1_000,
    });
    const opened = readAsk(db, created.ask_id, { answerActorUserId: human1, now: 1_100 })!.ask;
    submitAsk(db, created.ask_id, human1, {
      expected_lifecycle_event_id: opened.lifecycle_event_id, answers: [], annotations: [],
    }, 1_200);
    const resolved = resolveSubmissionRef(db, `submission:${created.ask_id}#1`, {
      userId: human1, isOperator: false,
    });
    expect(resolved.ok).toBe(true);
    fs.rmSync(tempDir, { recursive: true, force: true });
    expect(() => exportSubmissionMarkdown(db, resolved as Extract<typeof resolved, { ok: true }>))
      .toThrowError(expect.objectContaining({ code: "document_unavailable", status: 409 }));
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
      .toEqual({ artifact_version_id: version.version.id, previous_round_id: first.ask_id, profile: null });
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
