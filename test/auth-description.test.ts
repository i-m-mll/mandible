// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createQueue, createMigratedDb, createAuthCheckRepo, configureSigningCredential, AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import type { AuthRequestInput } from "../src/types.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { addCredential } from "../src/users/store.js";
import { setDb } from "../src/db.js";
import { AUTH_REQUEST_TYPES } from "../src/contracts.js";
import * as operatorProof from "../src/auth-operator-proof.js";
import { getOperator } from "../src/users/store.js";
import { authRequestSnapshot, authSnapshotDigest } from "../src/auth-lifecycle.js";

describe("approval Description", () => {
  it("refuses missing or blank descriptions for every type before observations or writes", () => {
    const queue = createQueue({ backgroundMaintenance: false });
    const check = vi.spyOn(queue, "checkMergeIndependence");
    for (const type of AUTH_REQUEST_TYPES) {
      for (const commit_message of [undefined, null, "", " \n\t"]) {
        expect(() => queue.submit({ type, command: "echo fixture", title: "Private action", commit_message } as AuthRequestInput))
          .toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("Description") }));
      }
    }
    expect(check).not.toHaveBeenCalled();
    expect(queue.listActive()).toEqual([]);
    queue.dispose();
  });

  it("stores ordinary multiline Markdown exactly, without Git constraints or a second explanation", () => {
    const queue = createQueue({ backgroundMaintenance: false });
    const description = "# Restart the fixture\n\nLoad the reviewed configuration.\n\nVerification is performed after launch.\n";
    const request = queue.submit({ type: "config-change", command: "echo fixture", title: "Restart", commit_message: description });
    expect(request.commit_message).toBe(description);
    expect(request.commit_message_digest).toBeNull();
    expect(request.diff_summary).toBeNull();
    expect(() => queue.update(request.id, { commit_message: "\n " })).toThrow(expect.objectContaining({ status: 400 }));
    const priorRevision = queue.listLifecycleEvents(request.id).at(-1)!.revision;
    const updated = queue.update(request.id, { commit_message: "# Restart\n\nLoad the newly reviewed configuration." });
    expect(updated.commit_message).not.toBe(description);
    expect(queue.listLifecycleEvents(request.id).at(-1)!.revision).toBeGreaterThan(priorRevision);
    queue.dispose();
  });

  it("applies the same Description requirement to raw API submissions", async () => {
    const db = createMigratedDb();
    setDb(db);
    const operator = getOperator(db)!;
    const credential = addCredential(db,operator.id,{ type: "api_token", fingerprint: "description-api" });
    const router = authenticatedTestRouter(operator,{ credentialId: credential.id });
    const queue = createQueue({ db, backgroundMaintenance: false });
    registerAuthRoutes(router,queue,new AuthAutoApproveManager({ db }));
    try {
      for (const type of AUTH_REQUEST_TYPES) {
        for (const commit_message of [undefined, " \n"]) {
          const result = await router.invoke({ method: "POST", url: "/api/auth/request",
            body: { type, command: "echo fixture", title: "Review", commit_message } });
          expect(result.status).toBe(400);
          expect(result.body).toMatchObject({ code: type === "merge" ? "change_message_required" : "description_required" });
        }
      }
      const description = "# Apply reviewed settings\n\nPreserve the private fixture database.";
      const accepted = await router.invoke({ method: "POST", url: "/api/auth/request", body: {
        type: "config-change", command: "echo fixture", title: "Review", commit_message: description,
      } });
      expect(accepted.status,JSON.stringify(accepted.body)).toBe(201);
      const stored = queue.getRequest((accepted.body as {request_id:string}).request_id);
      expect(stored?.commit_message).toBe(description);
      expect(stored?.commit_message_digest).toBeNull();
    } finally { queue.dispose(); }
  });

  it("requires the same canonical Git document and verification for direct merge submissions", () => {
    const queue = createQueue({ backgroundMaintenance: false });
    expect(() => queue.submit({ command: "echo fixture", title: "Merge", ...AUTH_COMMAND_REVIEW }))
      .toThrow(expect.objectContaining({ status: 400 }));
    const request = queue.submit({ command: "echo fixture", title: "Merge", ...AUTH_MERGE_REVIEW });
    expect(request.commit_message).toBe(AUTH_MERGE_REVIEW.commit_message);
    expect(request.commit_message_digest).toMatch(/^[a-f0-9]{64}$/);
    queue.dispose();
  });

  it("refuses an actual signed proof when Description changes while signing is held", async () => {
    const db = createMigratedDb();
    const repo = createAuthCheckRepo();
    configureSigningCredential(db, repo, "ssh_key");
    const queue = createQueue({ db, backgroundMaintenance: false });
    const request = queue.submit({ type: "config-change", command: "echo private", cwd: repo,
      title: "Private configuration", ...AUTH_COMMAND_REVIEW, execution_mode: "remote" });
    let hold!: () => void;
    let observed!: () => void;
    const released = new Promise<void>(resolve => { hold = resolve; });
    const signed = new Promise<void>(resolve => { observed = resolve; });
    const original = operatorProof.signOperatorChallenge;
    const signer = vi.spyOn(operatorProof, "signOperatorChallenge").mockImplementation(async (...args) => {
      const result = await original(...args);
      expect(result.ok).toBe(true);
      observed();
      await released;
      return result;
    });
    const approval = queue.approveWithOperatorProof(request.id, getOperator(db)!.id);
    try {
      await signed;
      queue.update(request.id, { commit_message: "Apply the separately reviewed fixture configuration." });
      hold();
      await expect(approval).rejects.toThrow(/changed|proof|signing/i);
      expect(queue.getRequest(request.id)?.status).toBe("pending");
    } finally { hold(); signer.mockRestore(); queue.dispose(); }
  });

  it("leaves historical pending, approved and terminal snapshots byte-identical on reads", () => {
    const db = createMigratedDb();
    const queue = createQueue({ db, backgroundMaintenance: false });
    for (const status of ["pending", "approved", "completed"] as const) {
      const id = `legacy-description-${status}`;
      db.prepare(`INSERT INTO auth_requests (id,type,command,title,status,created_at,updated_at,expires_at,commit_message)
        VALUES (?, 'config-change', 'echo old', 'Historical action', ?, 1, 2, ?, NULL)`).run(id,status,Date.now()+60000);
      const before = authRequestSnapshot(db,id);
      const digest = authSnapshotDigest(before);
      expect(queue.getRequest(id)?.commit_message).toBeNull();
      queue.listActive();
      expect(authRequestSnapshot(db,id)).toEqual(before);
      expect(authSnapshotDigest(authRequestSnapshot(db,id))).toBe(digest);
    }
    queue.dispose();
  });
});
