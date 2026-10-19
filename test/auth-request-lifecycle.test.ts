/**
 * @vitest-environment node
 *
 * Issue f15617a — auth requests are immutable reviewed records. Requester
 * withdrawal and explicit replacement are the only requester-owned terminal
 * transitions, and every accepted transition leaves a hashed lifecycle receipt.
 */
import fs from "node:fs";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { authSnapshotDigest } from "../src/auth-lifecycle.js";
import { migrate } from "../src/db.js";
import type { AuthLifecycleActor, AuthRequestInput } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { createLedgerIssue, createLedgerProject, createMigratedDb } from "./helpers/auth-queue-fixtures.js";

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
  const project = createLedgerProject(db, process.cwd());
  const issue = createLedgerIssue(db, project.project.id, "f15617a", "Auth lifecycle");
  const queue = new AuthQueue({ db });
  const submit = (patch: Partial<AuthRequestInput> = {}) => {
    const head = patch.head_branch ?? "feature/original";
    if (!patch.supersedes_request_id) {
      db.prepare(`INSERT INTO work_units
        (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
         ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
        VALUES (?, 'f15617a', ?, ?, 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
        .run(crypto.randomUUID(), project.project.project_key, head, issue.id, operator.id, credential.id);
    }
    return queue.submit({
    command: "mandible auth merge feature/original --into main",
    title: "Original",
    repo: project.project.project_key,
    base_branch: "main",
    head_branch: "feature/original",
    requester_evidence_method: "api_token",
    requester_credential_id: credential.id,
    require_delivery_custody: true,
    issue_references: ["f15617a"],
    ...patch,
  }, operator.id);
  };
  return { db, queue, operator, credential, otherCredential, actor, submit };
}

describe("auth request immutable lifecycle", () => {
  it("migrates historical rows to honest baseline receipts", () => {
    const db = new SqliteDatabase(":memory:");
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
    }, 1, 1)).toThrow(AuthQueueError);
    const outsider = createUser(db, {
      slug: `outsider-${crypto.randomUUID()}`,
      kind: "agent",
      display_name: "Outsider",
    });
    expect(() => queue.withdraw(request.id, "wrong user", {
      ...actor,
      user_id: outsider.id,
    }, 1, 1)).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.status).toBe("pending");

    const withdrawn = queue.withdraw(request.id, "Branch abandoned", actor, 1, 1);
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

  it("binds delivery custody for a request that only closes its issue", () => {
    const { submit } = requesterFixture();
    const request = submit({ issue_references: null, issue_closures: ["f15617a"] });
    expect(request.custody_work_unit_id).toBeTruthy();
  });

  it("treats sessions as provenance only and permits a same-credential successor", () => {
    const { queue, operator, credential, submit } = requesterFixture();
    const request = submit({ session_id: "originating-session" });

    expect(() => queue.withdraw(request.id, "session is not custody", {
      user_id: operator.id,
      evidence_method: "session_claim",
      session_id: "originating-session",
    }, 1, 1)).toThrow(AuthQueueError);

    const successor = queue.withdraw(request.id, "successor completed the handoff", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      session_id: "successor-session",
      authority_path: "custodian",
    }, 1, 1);
    expect(successor.status).toBe("withdrawn");
  });

  it("records operator recovery as a distinct audited authority path", () => {
    const { queue, operator, credential, submit } = requesterFixture();
    const request = submit({ head_branch: "feature/operator-recovery" });
    queue.withdraw(request.id, "Operator recovered an abandoned lane", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator_recovery",
    }, 1, 1);
    expect(queue.listLifecycleEvents(request.id).at(-1)).toMatchObject({
      event_type: "withdrawn",
      authority_path: "operator_recovery",
      custody_generation: 1,
    });
  });

  it("lets the operator recover a legacy pending request without fabricating custody", () => {
    const { queue, operator, credential } = requesterFixture();
    const legacy = queue.submit({ command: "echo legacy", title: "Legacy", type: "commit" });
    const recovered = queue.withdraw(legacy.id, "Operator retired an unowned legacy request", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator_recovery",
    }, 1, 0);
    expect(recovered.status).toBe("withdrawn");
    expect(queue.listLifecycleEvents(legacy.id).at(-1)).toMatchObject({
      authority_path: "operator_recovery",
      custody_work_unit_id: null,
      custody_generation: null,
    });
  });

  it("rejects stale lifecycle and custody preconditions", () => {
    const { queue, actor, submit } = requesterFixture();
    const request = submit({ head_branch: "feature/stale-cas" });
    expect(() => queue.withdraw(request.id, "stale revision", actor, 0, 1)).toThrow(AuthQueueError);
    expect(() => queue.withdraw(request.id, "stale custody", actor, 1, 0)).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.status).toBe("pending");
  });

  it("fails closed for legacy rows and terminal requests", () => {
    const { queue, operator, actor, submit } = requesterFixture();
    const legacy = queue.submit({ command: "echo legacy", title: "Legacy", type: "commit" });
    expect(() => queue.withdraw(legacy.id, "unknown requester", actor, 1, 0)).toThrow(AuthQueueError);

    const withdrawn = submit({ head_branch: "feature/withdrawn" });
    queue.withdraw(withdrawn.id, "done", actor, 1, 1);
    expect(() => queue.withdraw(withdrawn.id, "again", actor, 2, 1)).toThrow(AuthQueueError);
    expect(() => submit({
      head_branch: "feature/replacement",
      supersedes_request_id: withdrawn.id,
      expected_revision: 2,
      expected_custody_generation: 1,
    })).toThrow(AuthQueueError);
  });

  it("atomically supersedes a pending request and carries staged actions exactly", () => {
    const { queue, actor, submit } = requesterFixture();
    const carried = { kind: "issue_close" as const, target_issue_ref: "f15617a", payload: {} };
    const original = submit({ actions: [carried] });

    expect(() => submit({
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
    })).toThrow(AuthQueueError);
    expect(queue.getRequest(original.id)?.status).toBe("pending");

    const replacement = submit({
      command: "mandible auth merge feature/original --into main",
      title: "Replacement",
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
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
      head_branch: "feature/drop-original",
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
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
      expected_revision: 1,
      expected_custody_generation: 1,
    })).toThrow(AuthQueueError);
    expect(queue.getRequest(original.id)?.status).toBe("pending");
  });
});
