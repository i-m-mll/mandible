/**
 * @vitest-environment node
 *
 * Issue f15617a — auth requests are immutable reviewed records. Requester
 * withdrawal and explicit replacement are the only requester-owned terminal
 * transitions, and every accepted transition leaves a hashed lifecycle receipt.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { authSnapshotDigest } from "../src/auth-lifecycle.js";
import { migrate } from "../src/db.js";
import type { AuthLifecycleActor, AuthRequestInput } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { createMigratedDb } from "./helpers/auth-queue-fixtures.js";

function requesterFixture() {
  const db = createMigratedDb();
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, {
    type: "api_token",
    fingerprint: `requester-${crypto.randomUUID()}`,
  });
  const otherCredential = addCredential(db, operator.id, {
    type: "api_token",
    fingerprint: `other-${crypto.randomUUID()}`,
  });
  const actor: AuthLifecycleActor = {
    user_id: operator.id,
    evidence_method: "api_token",
    credential_id: credential.id,
  };
  const queue = new AuthQueue({ db });
  const submit = (patch: Partial<AuthRequestInput> = {}) => queue.submit({
    command: "mandible auth merge feature/original --into main",
    title: "Original",
    repo: "mandible",
    base_branch: "main",
    head_branch: "feature/original",
    requester_evidence_method: "api_token",
    requester_credential_id: credential.id,
    ...patch,
  }, operator.id);
  return { db, queue, operator, credential, otherCredential, actor, submit };
}

describe("auth request immutable lifecycle", () => {
  it("migrates historical rows to honest baseline receipts", () => {
    const db = new Database(":memory:");
    db.exec(fs.readFileSync(path.join(process.cwd(), "test/fixtures/schema-v158.sql"), "utf8"));
    db.prepare(`INSERT INTO auth_requests
      (id, command, title, status, created_at, updated_at, expires_at)
      VALUES ('legacy-request', 'echo old', 'Old request', 'rejected', 10, 20, 30)`).run();
    migrate(db);

    const event = db.prepare(
      "SELECT * FROM auth_request_lifecycle_events WHERE auth_request_id = 'legacy-request'",
    ).get() as Record<string, unknown>;
    expect(event).toMatchObject({
      revision: 1,
      event_type: "legacy_snapshot",
      prior_status: null,
      next_status: "rejected",
      actor_user_id: null,
      evidence_method: null,
      credential_id: null,
      reason: "Baseline captured during migration; earlier transition provenance is unknown.",
    });
    expect(event.snapshot_sha256).toBe(authSnapshotDigest(String(event.snapshot_json)));
    db.close();
  });

  it("allows only the exact requester credential to withdraw a pending request", () => {
    const { db, queue, operator, otherCredential, actor, submit } = requesterFixture();
    const request = submit();

    expect(() => queue.withdraw(request.id, "wrong credential", {
      ...actor,
      credential_id: otherCredential.id,
    })).toThrow(AuthQueueError);
    const outsider = createUser(db, {
      slug: `outsider-${crypto.randomUUID()}`,
      kind: "agent",
      display_name: "Outsider",
    });
    expect(() => queue.withdraw(request.id, "wrong user", {
      ...actor,
      user_id: outsider.id,
    })).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.status).toBe("pending");

    const withdrawn = queue.withdraw(request.id, "Branch abandoned", actor);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.error).toBe("Branch abandoned");

    const events = queue.listLifecycleEvents(request.id);
    expect(events.map((event) => event.event_type)).toEqual(["submitted", "withdrawn"]);
    expect(events[1]).toMatchObject({
      revision: 2,
      prior_status: "pending",
      next_status: "withdrawn",
      actor_user_id: operator.id,
      credential_id: actor.credential_id,
      reason: "Branch abandoned",
    });
    expect(events[1]!.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => db.prepare(
      "UPDATE auth_request_lifecycle_events SET reason = 'rewritten' WHERE id = ?",
    ).run(events[1]!.id)).toThrow();
    expect(() => db.prepare(
      "DELETE FROM auth_request_lifecycle_events WHERE id = ?",
    ).run(events[1]!.id)).toThrow();
  });

  it("fails closed for legacy rows and terminal requests", () => {
    const { queue, operator, actor, submit } = requesterFixture();
    const legacy = queue.submit({ command: "echo legacy", title: "Legacy" });
    expect(() => queue.withdraw(legacy.id, "unknown requester", actor)).toThrow(AuthQueueError);

    const withdrawn = submit({ head_branch: "feature/withdrawn" });
    queue.withdraw(withdrawn.id, "done", actor);
    expect(() => queue.withdraw(withdrawn.id, "again", actor)).toThrow(AuthQueueError);
    expect(() => submit({
      head_branch: "feature/replacement",
      supersedes_request_id: withdrawn.id,
    })).toThrow(AuthQueueError);

    const sessionRequest = queue.submit({
      command: "echo session",
      title: "Session request",
      requester_evidence_method: "session_claim",
      session_id: "exact-session",
    }, operator.id);
    expect(() => queue.withdraw(sessionRequest.id, "wrong session", {
      user_id: operator.id,
      evidence_method: "session_claim",
      session_id: "different-session",
    })).toThrow(AuthQueueError);
    expect(queue.withdraw(sessionRequest.id, "right session", {
      user_id: operator.id,
      evidence_method: "session_claim",
      session_id: "exact-session",
    }).status).toBe("withdrawn");
  });

  it("atomically supersedes a pending request and carries staged actions exactly", () => {
    const { queue, actor, submit } = requesterFixture();
    const carried = { kind: "issue_close" as const, target_issue_ref: "f15617a", payload: {} };
    const original = submit({ actions: [carried] });

    expect(() => submit({
      head_branch: "feature/incomplete-replacement",
      supersedes_request_id: original.id,
    })).toThrow(AuthQueueError);
    expect(queue.getRequest(original.id)?.status).toBe("pending");

    const replacement = submit({
      command: "mandible auth merge feature/replacement --into main",
      title: "Replacement",
      head_branch: "feature/replacement",
      supersedes_request_id: original.id,
      actions: [carried],
    });

    expect(queue.getRequest(original.id)).toMatchObject({
      status: "superseded",
      superseded_by_request_id: replacement.id,
    });
    expect(queue.getRequest(replacement.id)).toMatchObject({
      status: "pending",
      supersedes_request_id: original.id,
    });
    expect(queue.listActions(replacement.id)).toMatchObject([
      { ordinal: 1, kind: "issue_close", target_issue_ref: "f15617a", state: "staged" },
    ]);
    expect(queue.listLifecycleEvents(original.id).at(-1)).toMatchObject({
      event_type: "superseded",
      related_request_id: replacement.id,
      credential_id: actor.credential_id,
    });
  });

  it("requires an explicit reason for every dropped staged action", () => {
    const { queue, submit } = requesterFixture();
    const original = submit({
      head_branch: "feature/drop-original",
      actions: [{ kind: "issue_close", target_issue_ref: "f15617a", payload: {} }],
    });
    const replacement = submit({
      head_branch: "feature/drop-replacement",
      supersedes_request_id: original.id,
      superseded_action_dispositions: [{ ordinal: 1, reason: "Issue remains open for delivery" }],
    });

    expect(queue.getRequest(original.id)?.superseded_by_request_id).toBe(replacement.id);
    expect(queue.listActions(original.id)[0]).toMatchObject({
      state: "vetoed",
      outcome_detail: "Disposed by replacement: Issue remains open for delivery",
    });
  });

  it("rejects replacements aimed at a different protected target", () => {
    const { queue, submit } = requesterFixture();
    const original = submit({ head_branch: "feature/target-original" });
    expect(() => submit({
      base_branch: "develop",
      head_branch: "feature/wrong-target",
      supersedes_request_id: original.id,
    })).toThrow(AuthQueueError);
    expect(queue.getRequest(original.id)?.status).toBe("pending");
  });
});
