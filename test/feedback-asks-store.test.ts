import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAskAnswers,
  askRequestDigest,
  AskStoreError,
  createAsk,
  observeAsk,
  readAsk,
  submitAsk,
  validateResponseValue,
} from "../src/feedback/asks.js";
import { migrate, type Db } from "../src/db.js";
import { addGrant } from "../src/permissions/store.js";
import { createUser } from "../src/users/store.js";

let db: Db;
let agentId: string;
let humanId: string;

function packet(overrides: Record<string, unknown> = {}) {
  return {
    request_key: "request-1",
    session_id: "session-1",
    responder_user_ids: [humanId],
    expires_at: 2_000,
    items: [
      {
        client_item_key: "group",
        item_kind: "group",
        title: "Group",
        prompt: "Group",
      },
      {
        client_item_key: "choice",
        item_kind: "item",
        parent_client_item_key: "group",
        title: "Choose",
        prompt: "Choose one",
        response_type: "single_choice",
        required: true,
        options: [
          { option_key: "a", label: "A" },
          { option_key: "b", label: "B" },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  agentId = createUser(db, { slug: "asker", kind: "agent", display_name: "Asker" }).id;
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
  addGrant(db, {
    subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create",
  });
  db.prepare(
    "INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('session-1', 'codex', 'active', ?)",
  ).run(agentId);
});

afterEach(() => db.close());

describe("bounded ask store", () => {
  it("creates the complete ordered graph and replays the canonical digest", () => {
    const first = createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 });
    const replay = createAsk(db, {
      ...packet(),
      responder_user_ids: [humanId],
    }, { requesterUserId: agentId, now: 1_001 });
    expect(replay).toMatchObject({ ask_id: first.ask_id, request_digest: first.request_digest, replay: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_collections").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_items").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_item_revisions").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT option_key FROM feedback_item_options ORDER BY position").all())
      .toEqual([{ option_key: "a" }, { option_key: "b" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("conflicts on the same identity with another digest and permits another session", () => {
    createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 });
    expect(() => createAsk(db, packet({ expires_at: 3_000 }), {
      requesterUserId: agentId, now: 1_001,
    })).toThrowError(AskStoreError);
    db.prepare(
      "INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('session-2', 'codex', 'active', ?)",
    ).run(agentId);
    expect(createAsk(db, packet({ session_id: "session-2" }), {
      requesterUserId: agentId, now: 1_001,
    }).replay).toBe(false);
  });

  it("validates creator session, responders, parent graphs, groups, and options", () => {
    db.prepare("UPDATE sessions SET identity_mismatch_at = 1 WHERE id = 'session-1'").run();
    expect(() => createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 }))
      .toThrowError(/identity-consistent/);
    db.prepare("UPDATE sessions SET identity_mismatch_at = NULL WHERE id = 'session-1'").run();
    expect(() => createAsk(db, packet({ responder_user_ids: [] }), {
      requesterUserId: agentId, now: 1_000,
    })).toThrowError(/nonempty/);
    expect(() => createAsk(db, packet({
      items: [{ client_item_key: "x", item_kind: "item", parent_client_item_key: "x", title: "X", prompt: "X", response_type: "free_text" }],
    }), { requesterUserId: agentId, now: 1_000 })).toThrowError(/parent/);
    expect(() => createAsk(db, packet({
      items: [{ client_item_key: "x", item_kind: "group", title: "X", prompt: "X", response_type: "free_text" }],
    }), { requesterUserId: agentId, now: 1_000 })).toThrowError(/groups/);
  });

  it("applies answer CAS atomically and publishes only pinned submissions", () => {
    const created = createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 });
    const projection = readAsk(db, created.ask_id, { answerActorUserId: humanId, now: 1_100 })!.ask;
    const choice = projection.items.find((item) => item.client_item_key === "choice")!;
    const opened = projection.lifecycle_event_id;
    const answer = {
      item_id: choice.id,
      item_revision_id: choice.revision.id,
      operation: "set" as const,
      value: { option_key: "a" },
      expected_response_event_id: null,
    };
    const set = applyAskAnswers(db, created.ask_id, humanId, [answer], 1_200);
    expect(observeAsk(db, created.ask_id, 1_201)!.result.submission).toBeNull();
    expect(() => applyAskAnswers(db, created.ask_id, humanId, [answer], 1_201))
      .toThrowError(/stale/);
    const result = submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: opened,
      answers: [{
        item_id: choice.id,
        item_revision_id: choice.revision.id,
        response_event_id: set.answer_event_ids[0],
      }],
    }, 1_300).result;
    expect(result).toMatchObject({ schema: "mandible-ask-result@1", state: "submitted" });
    expect(result.submission?.answers[0]).toMatchObject({ value: { option_key: "a" } });
  });

  it("appends immutable corrected submissions and expires only open bounded asks", () => {
    const created = createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 });
    const projection = readAsk(db, created.ask_id, { now: 1_100 })!.ask;
    expect(projection.latest_submission).toBeNull();
    const choice = projection.items.find((item) => item.client_item_key === "choice")!;
    const firstSet = applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: choice.id, item_revision_id: choice.revision.id, operation: "set",
      value: { option_key: "a" }, expected_response_event_id: null,
    }], 1_200).answer_event_ids[0];
    const first = submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: projection.lifecycle_event_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: firstSet }],
    }, 1_300);
    const afterFirst = readAsk(db, created.ask_id, { answerActorUserId: humanId, now: 1_301 })!.ask;
    expect(afterFirst.latest_submission).toEqual({ id: first.submission_id, ordinal: 1 });
    expect(afterFirst.lifecycle_event_id).toBe(first.lifecycle_event_id);
    expect(afterFirst.lifecycle_event_id).not.toBe(first.submission_id);
    const secondSet = applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: choice.id, item_revision_id: choice.revision.id, operation: "set",
      value: { option_key: "b" }, expected_response_event_id: firstSet,
    }], 1_400).answer_event_ids[0];
    const second = submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: first.lifecycle_event_id,
      supersedes_submission_id: first.submission_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: secondSet }],
    }, 1_500);
    expect(second.result.submission).toMatchObject({ ordinal: 2, supersedes_submission_id: first.submission_id });
    const afterSecond = readAsk(db, created.ask_id, { answerActorUserId: humanId, now: 1_501 })!.ask;
    expect(afterSecond.latest_submission).toEqual({ id: second.submission_id, ordinal: 2 });
    expect(afterSecond.lifecycle_event_id).toBe(second.lifecycle_event_id);
    expect(afterSecond.lifecycle_event_id).not.toBe(second.submission_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_submissions").get()).toEqual({ n: 2 });
    expect(observeAsk(db, created.ask_id, 5_000)!.result.state).toBe("submitted");
  });

  it("canonicalizes object keys and responder sets while preserving item and option order", () => {
    const secondHuman = createUser(db, { slug: "human-2", kind: "human", display_name: "Human 2" }).id;
    const first = {
      ...packet(),
      responder_user_ids: [secondHuman, humanId],
      retention_expires_at: 3_000,
    };
    const reordered = {
      items: first.items.map((item) => ({ ...item })),
      expires_at: first.expires_at,
      responder_user_ids: [humanId, secondHuman],
      session_id: first.session_id,
      retention_expires_at: first.retention_expires_at,
      request_key: first.request_key,
    };
    expect(askRequestDigest(first)).toBe(askRequestDigest(reordered));
    expect(askRequestDigest({ ...first, items: [...first.items].reverse() }))
      .not.toBe(askRequestDigest(first));
    const choice = first.items[1] as typeof first.items[1] & { options: Array<{ option_key: string; label: string }> };
    const reversedOptions = [first.items[0], { ...choice, options: [...choice.options].reverse() }];
    expect(askRequestDigest({ ...first, items: reversedOptions })).not.toBe(askRequestDigest(first));
  });

  it("rejects every invalid creator session and creator authorization class", () => {
    db.prepare("DELETE FROM permission_grants WHERE permission = 'ask.create'").run();
    expect(() => createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 }))
      .toThrowError(/capability/);
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });

    db.prepare("UPDATE sessions SET status = 'ended' WHERE id = 'session-1'").run();
    expect(() => createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 })).toThrowError(/active/);
    db.prepare("UPDATE sessions SET status = 'active', owner_user_id = ? WHERE id = 'session-1'").run(humanId);
    expect(() => createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 })).toThrowError(/owned/);
    db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();
    expect(() => createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 })).toThrowError(/session_id/);

    const humanSession = "human-session";
    db.prepare("INSERT INTO sessions (id, app, status, owner_user_id) VALUES (?, 'codex', 'active', ?)")
      .run(humanSession, humanId);
    addGrant(db, { subject_type: "user", subject: humanId, resource_type: "global", permission: "ask.create" });
    expect(() => createAsk(db, packet({ session_id: humanSession }), {
      requesterUserId: humanId, now: 1_000,
    })).toThrowError(/active agent/);
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(agentId);
    expect(() => createAsk(db, packet({ session_id: humanSession }), {
      requesterUserId: agentId, now: 1_000,
    })).toThrowError(/active agent/);
  });

  it("rejects invalid responder identities and the complete item grammar", () => {
    const retired = createUser(db, { slug: "retired", kind: "human", display_name: "Retired" }).id;
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(retired);
    const agentResponder = createUser(db, { slug: "agent-responder", kind: "agent", display_name: "Agent responder" }).id;
    for (const responder_user_ids of [[humanId, humanId], [retired], [agentResponder], ["missing"]]) {
      expect(() => createAsk(db, packet({ responder_user_ids }), { requesterUserId: agentId, now: 1_000 }))
        .toThrowError(AskStoreError);
    }
    const invalidItems: unknown[] = [
      [{ client_item_key: "x", item_kind: "item", title: "X", prompt: "X", response_type: "resource_ref" }],
      [{ client_item_key: "x", item_kind: "item", parent_client_item_key: "missing", title: "X", prompt: "X", response_type: "free_text" }],
      [
        { client_item_key: "a", item_kind: "group", parent_client_item_key: "b", title: "A", prompt: "A" },
        { client_item_key: "b", item_kind: "group", parent_client_item_key: "a", title: "B", prompt: "B" },
      ],
      [
        { client_item_key: "a", item_kind: "item", title: "A", prompt: "A", response_type: "free_text" },
        { client_item_key: "a", item_kind: "item", title: "B", prompt: "B", response_type: "free_text" },
      ],
      [{ client_item_key: "x", item_kind: "item", title: "X", prompt: "X", response_type: "single_choice" }],
      [{ client_item_key: "x", item_kind: "item", title: "X", prompt: "X", response_type: "free_text", options: [{ option_key: "a", label: "A" }] }],
      [{ client_item_key: "x", item_kind: "item", title: "X", prompt: "X", response_type: "single_choice", options: [{ option_key: "a", label: "A" }, { option_key: "a", label: "Again" }] }],
      [{ client_item_key: "x", item_kind: "group", title: "X", prompt: "X", required: true }],
      [{ client_item_key: "x", item_kind: "item", title: "X", prompt: "X", response_type: "free_text", resource_ref: "deferred" }],
    ];
    invalidItems.forEach((items, index) => {
      expect(() => createAsk(db, packet({ request_key: `invalid-${index}`, items }), {
        requesterUserId: agentId, now: 1_000,
      })).toThrowError(AskStoreError);
    });
  });

  it("validates all four response shapes exactly and preserves stable choice identity", () => {
    expect(validateResponseValue("verdict", { verdict: "keep" }, [])).toEqual({ verdict: "keep" });
    expect(validateResponseValue("free_text", { text: "" }, [])).toEqual({ text: "" });
    expect(validateResponseValue("single_choice", { option_key: "a" }, ["a", "b"]))
      .toEqual({ option_key: "a" });
    expect(validateResponseValue("multi_choice", { option_keys: ["b", "a"] }, ["a", "b"]))
      .toEqual({ option_keys: ["b", "a"] });
    const invalid: Array<["verdict" | "free_text" | "single_choice" | "multi_choice", unknown, string[]]> = [
      ["verdict", { verdict: "keep", extra: true }, []],
      ["verdict", { verdict: "maybe" }, []],
      ["free_text", { text: 1 }, []],
      ["free_text", { text: "ok", extra: true }, []],
      ["single_choice", { option_key: "missing" }, ["a"]],
      ["single_choice", { option_key: "a", extra: true }, ["a"]],
      ["multi_choice", { option_keys: ["a", "a"] }, ["a"]],
      ["multi_choice", { option_keys: ["missing"] }, ["a"]],
      ["multi_choice", { option_keys: ["a"], extra: true }, ["a"]],
    ];
    invalid.forEach(([type, value, options]) => {
      expect(() => validateResponseValue(type, value, options)).toThrowError(AskStoreError);
    });
  });

  it("replaces, retracts, and rolls back a whole stale answer batch", () => {
    const created = createAsk(db, packet({
      items: [
        { client_item_key: "a", item_kind: "item", title: "A", prompt: "A", response_type: "free_text" },
        { client_item_key: "b", item_kind: "item", title: "B", prompt: "B", response_type: "free_text" },
      ],
    }), { requesterUserId: agentId, now: 1_000 });
    const form = readAsk(db, created.ask_id, { answerActorUserId: humanId, now: 1_100 })!.ask;
    const [a, b] = form.items;
    const first = applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: a.id, item_revision_id: a.revision.id, operation: "set",
      value: { text: "first" }, expected_response_event_id: null,
    }], 1_200).answer_event_ids[0];
    const replacement = applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: a.id, item_revision_id: a.revision.id, operation: "set",
      value: { text: "second" }, expected_response_event_id: first,
    }], 1_300).answer_event_ids[0];
    const before = (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n;
    expect(() => applyAskAnswers(db, created.ask_id, humanId, [
      { item_id: b.id, item_revision_id: b.revision.id, operation: "set", value: { text: "would roll back" }, expected_response_event_id: null },
      { item_id: a.id, item_revision_id: a.revision.id, operation: "set", value: { text: "stale" }, expected_response_event_id: first },
    ], 1_400)).toThrowError(/stale/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get()).toEqual({ n: before });
    applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: a.id, item_revision_id: a.revision.id, operation: "retract",
      expected_response_event_id: replacement,
    }], 1_500);
    expect(readAsk(db, created.ask_id, { answerActorUserId: humanId, now: 1_501 })!.ask.items[0].effective_response)
      .toBeNull();
  });

  it("rejects missing required, partial effective sets, stale responses, and stale lifecycle submissions", () => {
    const created = createAsk(db, packet(), { requesterUserId: agentId, now: 1_000 });
    const form = readAsk(db, created.ask_id, { now: 1_100 })!.ask;
    const choice = form.items.find((item) => item.client_item_key === "choice")!;
    expect(() => submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: form.lifecycle_event_id, answers: [],
    }, 1_200)).toThrowError(/required/);
    const eventId = applyAskAnswers(db, created.ask_id, humanId, [{
      item_id: choice.id, item_revision_id: choice.revision.id, operation: "set",
      value: { option_key: "a" }, expected_response_event_id: null,
    }], 1_300).answer_event_ids[0];
    expect(() => submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: form.lifecycle_event_id,
      answers: [],
    }, 1_400)).toThrowError(/exactly match/);
    expect(() => submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: form.lifecycle_event_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: "stale" }],
    }, 1_400)).toThrowError(/effective/);
    const submitted = submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: form.lifecycle_event_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: eventId }],
    }, 1_500);
    expect(() => submitAsk(db, created.ask_id, humanId, {
      expected_lifecycle_event_id: form.lifecycle_event_id,
      supersedes_submission_id: submitted.submission_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: eventId }],
    }, 1_600)).toThrowError(/lifecycle/);
  });

  it("serializes submit-versus-expiry and submit-versus-submit CAS outcomes", () => {
    const expiring = createAsk(db, packet({ request_key: "expiring", expires_at: 1_250 }), {
      requesterUserId: agentId, now: 1_000,
    });
    const expiringForm = readAsk(db, expiring.ask_id, { now: 1_100 })!.ask;
    const choice = expiringForm.items.find((item) => item.client_item_key === "choice")!;
    const response = applyAskAnswers(db, expiring.ask_id, humanId, [{
      item_id: choice.id, item_revision_id: choice.revision.id, operation: "set",
      value: { option_key: "a" }, expected_response_event_id: null,
    }], 1_200).answer_event_ids[0];
    expect(observeAsk(db, expiring.ask_id, 1_250)!.result.state).toBe("expired");
    expect(() => submitAsk(db, expiring.ask_id, humanId, {
      expected_lifecycle_event_id: expiringForm.lifecycle_event_id,
      answers: [{ item_id: choice.id, item_revision_id: choice.revision.id, response_event_id: response }],
    }, 1_250)).toThrowError(/lifecycle/);

    const competing = createAsk(db, packet({ request_key: "competing", expires_at: 3_000 }), {
      requesterUserId: agentId, now: 1_000,
    });
    const competingForm = readAsk(db, competing.ask_id, { now: 1_100 })!.ask;
    const competingChoice = competingForm.items.find((item) => item.client_item_key === "choice")!;
    const competingResponse = applyAskAnswers(db, competing.ask_id, humanId, [{
      item_id: competingChoice.id, item_revision_id: competingChoice.revision.id, operation: "set",
      value: { option_key: "a" }, expected_response_event_id: null,
    }], 1_200).answer_event_ids[0];
    const submission = {
      expected_lifecycle_event_id: competingForm.lifecycle_event_id,
      answers: [{ item_id: competingChoice.id, item_revision_id: competingChoice.revision.id, response_event_id: competingResponse }],
    };
    submitAsk(db, competing.ask_id, humanId, submission, 1_300);
    expect(() => submitAsk(db, competing.ask_id, humanId, submission, 1_300)).toThrowError(/lifecycle/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_submissions WHERE collection_id = ?").get(competing.ask_id))
      .toEqual({ n: 1 });
  });

  it("never expires recurring collections and retains foreign-key integrity", () => {
    db.prepare(
      `INSERT INTO feedback_collections
         (id, kind, interaction_mode, source, created_at, tombstoned_at)
       VALUES ('recurring', 'recurring_feed', 'immediate_per_item', 'source', 1, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO feedback_recurring_profiles
         (collection_id, source_namespace, item_expiry_ms, created_at, updated_at)
       VALUES ('recurring', 'source', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO feedback_collection_events
         (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
       VALUES ('recurring-open', 'recurring', 'opened', NULL, NULL, '{}', 1)`,
    ).run();
    expect(observeAsk(db, "recurring", 10_000)).toBeNull();
    expect(db.prepare("SELECT operation FROM feedback_collection_events WHERE collection_id = 'recurring'").all())
      .toEqual([{ operation: "opened" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare(
      `INSERT INTO feedback_submission_answers
         (submission_id, item_id, item_revision_id, response_event_id, position)
       VALUES ('missing', 'missing', 'missing', 'missing', 0)`,
    ).run()).toThrow();
  });
});
