import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { Router } from "../src/server.js";
import { uniqueMissingPath } from "./helpers/auth-queue-fixtures.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { setDb } from "../src/db.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Issue f15617a — auth requests are immutable reviewed records. Requester
 * withdrawal and explicit replacement are the only requester-owned terminal
 * transitions, and every accepted transition leaves a hashed lifecycle receipt.
 */
import { describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { appendAuthLifecycleEvent } from "../src/auth-lifecycle.js";
import { authSnapshotDigest } from "../src/auth-request-snapshot.js";
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
  const submit = async (patch: Partial<AuthRequestInput> = {}) => {
    const head = patch.head_branch ?? "feature/original";
    if (!patch.supersedes_request_id) {
      db.prepare(`INSERT INTO work_units
        (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
         ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
        VALUES (?, 'f15617a', ?, ?, 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
        .run(crypto.randomUUID(), project.project.project_key, head, issue.id, operator.id, credential.id);
    }
    return (await queue.submit({ ...AUTH_MERGE_REVIEW,
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
  }, operator.id));
  };
  return { db, queue, operator, credential, otherCredential, actor, submit };
}

describe("auth request immutable lifecycle", () => {
  it("refuses the actual local browser identity without changing revision authority", async () => {
    const { db, queue, submit } = requesterFixture();
    setDb(db);
    const request = (await submit());
    const authenticator = new ClientAuthenticator(db, {
      secretsDir: uniqueMissingPath("description-browser-auth"), contextVerificationKeyPem: "",
    });
    const identity = authenticator.localBrowserIdentity();
    expect(identity).toMatchObject({ method: "local_os_user", source: "local_os_user", credential_id: null });
    const router = new Router({ clientAuth: {
      authenticate: () => identity, mode: () => "strict", recordUnattributedWrite: () => undefined,
    } });
    registerAuthRoutes(router,queue,new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    const before = queue.listLifecycleEvents(request.id);
    for (const operator_recovery of [false,true]) {
      const refused = await router.invoke({ method: "PUT", url: `/api/auth/request/${request.id}`,
        body: { commit_message: "Browser cannot claim durable custody.", expected_revision: 1,
          expected_custody_generation: 1, operator_recovery } });
      expect(refused.status).toBe(401);
      expect(refused.body).toMatchObject({ code: "durable_credential_required" });
    }
    expect((await queue.getRequest(request.id))?.commit_message).toBe(request.commit_message);
    expect(queue.listLifecycleEvents(request.id)).toEqual(before);
    (await queue.dispose());
  });

  it("preserves canonical Description revisions by the existing durable credential owner", async () => {
    const { db, queue, operator, credential, submit } = requesterFixture();
    setDb(db);
    const request = (await submit());
    const router = authenticatedTestRouter(operator, { credentialId: credential.id });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    const edited = "Merge feature/original: Explain the reviewed change\r\n\r\nWhy:\r\nMake the action understandable.\r\n\r\nVerification:\r\nThe edited document's checks pass.\r\n";
    const result = await router.invoke({ method: "PUT", url: `/api/auth/request/${request.id}`,
      body: { commit_message: edited, canonical_message: true, verification: "The edited document's checks pass.", expected_revision: 1, expected_custody_generation: 1 } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await queue.getRequest(request.id))?.commit_message).toContain("The edited document's checks pass.");
    expect((await queue.getRequest(request.id))?.commit_message).not.toContain("\r");
    expect((await queue.getRequest(request.id))?.commit_message_digest).not.toBe(request.commit_message_digest);
    (await queue.dispose());
  });

  // Issue 8ae6b5f — new requests carry no spec, but a spec stored by an older
  // request is part of its reviewed record: it stays readable, its lifecycle
  // receipts still verify, and guarded transitions neither need nor change it.
  it("keeps a stored spec readable and verifiable on an older request", async () => {
    const { db, queue, operator, credential } = requesterFixture();
    const spec = "# Intent\n\nReviewed before specs were removed.\n";
    // Recreate a request exactly as the former submission path stored it: the
    // spec column and the submitted receipt both carry the reviewed bytes.
    db.prepare(`INSERT INTO auth_requests
      (id, type, command, title, spec_content, status, created_at, updated_at, expires_at)
      VALUES ('spec-request', 'commit', 'echo old', 'Old request', ?, 'pending', 10, 20, ?)`)
      .run(spec, Date.now() + 86_400_000);
    appendAuthLifecycleEvent(db, {
      requestId: "spec-request", eventType: "submitted", priorStatus: null,
      nextStatus: "pending", occurredAt: 20,
    });

    expect((await queue.getRequest("spec-request"))?.spec_content).toBe(spec);
    const [submitted] = queue.listLifecycleEvents("spec-request");
    expect(JSON.parse(submitted!.snapshot_json).request.spec_content).toBe(spec);

    // The guarded transition re-derives the snapshot digest; it must still match.
    const withdrawn = (await queue.withdraw("spec-request", "Operator retired an old request", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator_recovery",
    }, 1, 0));
    expect(withdrawn).toMatchObject({ status: "withdrawn", spec_content: spec });
    const last = queue.listLifecycleEvents("spec-request").at(-1)!;
    expect(last.snapshot_sha256).toBe(authSnapshotDigest(last.snapshot_json));
    expect(JSON.parse(last.snapshot_json).request.spec_content).toBe(spec);
  });

  it("allows only the exact requester credential to withdraw a pending request", async () => {
    const { db, queue, operator, otherCredential, actor, submit } = requesterFixture();
    const request = (await submit());

    await expect((async () => (await queue.withdraw(request.id, "wrong credential", {
      ...actor,
      credential_id: otherCredential.id,
    }, 1, 1))())).rejects.toThrow(AuthQueueError);
    const outsider = createUser(db, {
      slug: `outsider-${crypto.randomUUID()}`,
      kind: "agent",
      display_name: "Outsider",
    });
    await expect((async () => (await queue.withdraw(request.id, "wrong user", {
      ...actor,
      user_id: outsider.id,
    }, 1, 1))())).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");

    const withdrawn = (await queue.withdraw(request.id, "Branch abandoned", actor, 1, 1));
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

  it("binds delivery custody for a request that only closes its issue", async () => {
    const { submit } = requesterFixture();
    const request = (await submit({ issue_references: null, issue_closures: ["f15617a"] }));
    expect(request.custody_work_unit_id).toBeTruthy();
  });

  it("treats sessions as provenance only and permits a same-credential successor", async () => {
    const { queue, operator, credential, submit } = requesterFixture();
    const request = (await submit({ session_id: "originating-session" }));

    await expect((async () => (await queue.withdraw(request.id, "session is not custody", {
      user_id: operator.id,
      evidence_method: "session_claim",
      session_id: "originating-session",
    }, 1, 1))())).rejects.toThrow(AuthQueueError);

    const successor = (await queue.withdraw(request.id, "successor completed the handoff", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      session_id: "successor-session",
      authority_path: "custodian",
    }, 1, 1));
    expect(successor.status).toBe("withdrawn");
  });

  it("records operator recovery as a distinct audited authority path", async () => {
    const { queue, operator, credential, submit } = requesterFixture();
    const request = (await submit({ head_branch: "feature/operator-recovery" }));
    (await queue.withdraw(request.id, "Operator recovered an abandoned lane", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator_recovery",
    }, 1, 1));
    expect(queue.listLifecycleEvents(request.id).at(-1)).toMatchObject({
      event_type: "withdrawn",
      authority_path: "operator_recovery",
      custody_generation: 1,
    });
  });

  it("lets the operator recover a legacy pending request without fabricating custody", async () => {
    const { queue, operator, credential } = requesterFixture();
    const legacy = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  command: "echo legacy", title: "Legacy", type: "commit" }));
    const recovered = (await queue.withdraw(legacy.id, "Operator retired an unowned legacy request", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator_recovery",
    }, 1, 0));
    expect(recovered.status).toBe("withdrawn");
    expect(queue.listLifecycleEvents(legacy.id).at(-1)).toMatchObject({
      authority_path: "operator_recovery",
      custody_work_unit_id: null,
      custody_generation: null,
    });
  });

  it("rejects stale lifecycle and custody preconditions", async () => {
    const { queue, actor, submit } = requesterFixture();
    const request = (await submit({ head_branch: "feature/stale-cas" }));
    await expect((async () => (await queue.withdraw(request.id, "stale revision", actor, 0, 1))())).rejects.toThrow(AuthQueueError);
    await expect((async () => (await queue.withdraw(request.id, "stale custody", actor, 1, 0))())).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
  });

  it("fails closed for legacy rows and terminal requests", async () => {
    const { queue, operator, actor, submit } = requesterFixture();
    const legacy = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  command: "echo legacy", title: "Legacy", type: "commit" }));
    await expect((async () => (await queue.withdraw(legacy.id, "unknown requester", actor, 1, 0))())).rejects.toThrow(AuthQueueError);

    const withdrawn = (await submit({ head_branch: "feature/withdrawn" }));
    (await queue.withdraw(withdrawn.id, "done", actor, 1, 1));
    await expect((async () => (await queue.withdraw(withdrawn.id, "again", actor, 2, 1))())).rejects.toThrow(AuthQueueError);
    await expect((async () => (await submit({
      head_branch: "feature/replacement",
      supersedes_request_id: withdrawn.id,
      expected_revision: 2,
      expected_custody_generation: 1,
    }))())).rejects.toThrow(AuthQueueError);
  });

  it("atomically supersedes a pending request and carries staged actions exactly", async () => {
    const { queue, actor, submit } = requesterFixture();
    const carried = { kind: "issue_close" as const, target_issue_ref: "f15617a", payload: {} };
    const original = (await submit({ actions: [carried] }));

    await expect((async () => (await submit({
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
    }))())).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(original.id))?.status).toBe("pending");

    const replacement = (await submit({
      command: "mandible auth merge feature/original --into main",
      title: "Replacement",
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
      actions: [carried],
    }));

    expect((await queue.getRequest(original.id))).toMatchObject({
      status: "superseded",
      superseded_by_request_id: replacement.id,
    });
    expect((await queue.getRequest(replacement.id))).toMatchObject({
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

  it("requires an explicit reason for every dropped staged action", async () => {
    const { queue, submit } = requesterFixture();
    const original = (await submit({
      head_branch: "feature/drop-original",
      actions: [{ kind: "issue_close", target_issue_ref: "f15617a", payload: {} }],
    }));
    const replacement = (await submit({
      head_branch: "feature/drop-original",
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
      superseded_action_dispositions: [{ ordinal: 1, reason: "Issue remains open for delivery" }],
    }));

    expect((await queue.getRequest(original.id))?.superseded_by_request_id).toBe(replacement.id);
    expect(queue.listActions(original.id)[0]).toMatchObject({
      state: "vetoed",
      outcome_detail: "Disposed by replacement: Issue remains open for delivery",
    });
  });

  it("rejects replacements aimed at a different protected target", async () => {
    const { queue, submit } = requesterFixture();
    const original = (await submit({ head_branch: "feature/target-original" }));
    await expect((async () => (await submit({
      base_branch: "develop",
      head_branch: "feature/wrong-target",
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
    }))())).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(original.id))?.status).toBe("pending");
  });
});
