import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestReview } from "../src/feedback/request-review.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { fileRpc, runCli } from "./helpers/cli-process.js";
import { createAuthCheckRepo, commitOnBranch, git, writeFile, registerWorkRepo } from "./helpers/auth-queue-fixtures.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { Router } from "../src/server.js";
import { uniqueMissingPath } from "./helpers/auth-queue-fixtures.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
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
import { describe, expect, it, vi } from "vitest";

import { fixtureOperatorSigning } from "./helpers/operator-signing-fixtures.js";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { appendAuthLifecycleEvent } from "../src/auth-lifecycle.js";
import { authSnapshotDigest } from "../src/auth-request-snapshot.js";
import type { AuthLifecycleActor, AuthRequestInput } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { createLedgerIssue, createLedgerProject, createMigratedDb } from "./helpers/auth-queue-fixtures.js";

function requesterFixture(root = process.cwd()) {
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
  const project = createLedgerProject(db, root);
  const issue = createLedgerIssue(db, project.project.id, "f15617a", "Auth lifecycle");
  const operatorSigning = fixtureOperatorSigning(db);
  const queue = new AuthQueue({ db, outcomeReporter: createOutcomeReporter(db), operatorSigning });
  const submitExisting = async (patch: Partial<AuthRequestInput> = {}) => {
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
  const submit = async (patch: Partial<AuthRequestInput> = {}) => {
    const head = patch.head_branch ?? "feature/original";
    if (!patch.supersedes_request_id) {
      db.prepare(`INSERT INTO work_units
        (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
         ledger_issue_id, owner_user_id, responsibility_session_id, custody_generation)
        VALUES (?, 'f15617a', ?, ?, 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
        .run(crypto.randomUUID(), project.project.project_key, head, issue.id, operator.id, null);
    }
    return submitExisting(patch);
  };
  return { db, queue, operator, credential, otherCredential, actor, submit, submitExisting, operatorSigning };
}

describe("auth request immutable lifecycle", () => {

  it("returns exact edits and comments, and carries the review across pinned revisions", async () => {
    const repo = createAuthCheckRepo();
    const { db, queue, operator, credential, submit, operatorSigning } = requesterFixture(repo);
    registerWorkRepo(db, repo);
    setDb(db);
    const router = authenticatedTestRouter(operator, { credentialId: credential.id });
    registerAuthRoutes(router, queue, inlineLedgerReader(() => queue.db));
    const branch = "feature/original";
    const session = "agent:claude:review-requester:review-requester";
    git(repo, ["checkout", "main"]);
    writeFile(repo, "notes.md", "# Notes\n\nReview the base note.\n");
    git(repo, ["add", "notes.md"]);
    git(repo, ["commit", "-m", "A reviewable original note"]);
    const notesHead = "# Notes\r\n\nReview the proposed note.\r\n";
    const scriptHead = "a\r\ncheck this line\nz\r\n";
    const notesEdit = "# Notes\r\n\nReview the operator note.\r\nLast line";
    const scriptEdit = "a\r\ncheck this line\noperator check\r\n";
    commitOnBranch(repo, branch, { "notes.md": notesHead, "script.txt": scriptHead });
    git(repo, ["checkout", branch]);
    chmodSync(join(repo, "script.txt"), 0o755);
    git(repo, ["add", "script.txt"]);
    git(repo, ["commit", "-m", "Make the script executable"]);
    git(repo, ["checkout", "main"]);
    const candidate = async () => {
      const metadata = await computeAuthMergeReviewMetadata(repo, "main", branch);
      return { cwd: repo, target_repo_root: repo, merge_head_sha: metadata.changeReport.comparison.head_sha, change_report: metadata.changeReport };
    };
    const invoke = (method: string, path: string, body?: unknown) => router.invoke({ method, url: path, body });
    const read = async (id: string) => {
      const response = await invoke("GET", `/api/auth/request/${id}/review`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as RequestReview & { precondition: { expected_revision: number; expected_custody_generation: number } };
    };
    const command = async (id: string) => {
      const response = await invoke("GET", `/api/auth/request/${id}/review/returned`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const rpc = fileRpc(request => ({ status: response.status, body: response.body }));
      try { return await runCli(["auth", "review", "show", id.slice(0, 8)], { env: rpc.env }); }
      finally { await rpc.responder.stop(); }
    };

    try {
      const request = await submit(await candidate());
      const base = `/api/auth/request/${request.id}`;
      const readBefore = await read(request.id);
      const before = readBefore.round.bindings.find(binding => binding.source.kind === "request_file"
        && binding.source.path === "notes.md" && binding.source.side === "before")!;
      const lines = readBefore.round.bindings.find(binding => binding.source.kind === "request_file"
        && binding.source.path === "script.txt" && binding.source.side === "after")!;
      const add = (binding: string, start: number, end: number, quote: string, body: string) =>
        invoke("POST", `${base}/review/annotations`, {
          ...readBefore.precondition, document_binding_id: binding,
          mutation: { operation: "set", kind: "comment", start_offset: start, end_offset: end, quote, body },
        });
      const markdown = await add(before.id, 9, 29, "Review the base note", "Explain the original wording.");
      const code = await add(lines.id, 1, 2, "check this line\n", "Keep this check visible.");
      expect(markdown.status, JSON.stringify(markdown.body)).toBe(201);
      expect(code.status, JSON.stringify(code.body)).toBe(201);
      const save = (path: string, expected_generation: number, mutation: { operation: "save"; text: string } | { operation: "revert" }) =>
        invoke("POST", `${base}/review/drafts`, {
          ...readBefore.precondition, round_id: readBefore.round.id, path, expected_generation, mutation,
        });
      const notesDraft = await save("notes.md", 0, { operation: "save", text: notesEdit });
      expect(notesDraft.status, JSON.stringify(notesDraft.body)).toBe(200);
      expect((await save("notes.md", 0, { operation: "save", text: "Stale writer" })).status).toBe(409);
      expect((await save("notes.md", 1, { operation: "revert" })).body).toMatchObject({ generation: 2, text: null });
      expect((await save("notes.md", 0, { operation: "save", text: "Stale writer after revert" })).status).toBe(409);
      expect((await save("notes.md", 2, { operation: "save", text: notesEdit })).status).toBe(200);
      expect((await save("script.txt", 0, { operation: "save", text: scriptEdit })).status).toBe(200);
      const reviewed = await read(request.id);
      const annotation_event_ids = reviewed.annotations.map(annotation => annotation.annotation_event_id);
      const draft_snapshot = reviewed.drafts.map(({ path, generation }) => ({ path, generation }));
      const returnBody = { ...readBefore.precondition, round_id: readBefore.round.id, annotation_event_ids, draft_snapshot, reason: "Clarify the note." };
      expect((await invoke("POST", `${base}/return`, { ...returnBody, draft_snapshot: [] })).status).toBe(409);
      const staleReturn = await invoke("POST", `${base}/return`, { ...returnBody, expected_custody_generation: readBefore.precondition.expected_custody_generation - 1 });
      expect(staleReturn.status).toBe(409);
      let entered!: () => void;
      let release!: () => void;
      const checkingKey = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(operatorSigning, "readyToSign").mockImplementationOnce(async () => {
        entered();
        await gate;
        return { ok: true, value: { credential, state: "usable", detail: null } };
      });
      const signer = vi.spyOn(operatorSigning, "commitSigner");
      const approving = invoke("POST", `${base}/approve`, { lifecycle_revision: readBefore.precondition.expected_revision });
      try {
        await Promise.race([checkingKey, approving.then(() => { throw new Error("Approval did not reach the key check."); })]);
        const returned = await invoke("POST", `${base}/return`, returnBody);
        expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      } finally { release(); }
      expect((await approving).status).toBe(409);
      expect(signer).not.toHaveBeenCalled();
      expect((await invoke("POST", `${base}/approve`, { lifecycle_revision: readBefore.precondition.expected_revision })).status).toBe(409);
      expect((await invoke("POST", `${base}/review/annotations`, {
        ...readBefore.precondition, document_binding_id: before.id,
        mutation: { operation: "retract", annotation_event_id: annotation_event_ids[0] },
      })).status).toBe(409);

      const first = await command(request.id);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("notes.md (before)");
      expect(first.stdout).toContain("Review the base note");
      expect(first.stdout).toContain("script.txt (after) lines 2–2");
      expect(first.stdout).toContain("Keep this check visible.");
      expect(first.stdout).toContain("+Review the operator note.");
      expect(first.stdout).toContain("+operator check");
      const ref = /^Git ref (refs\/mandible\/change-edits\/\S+)$/m.exec(first.stdout)?.[1];
      expect(ref).toBeDefined();
      const requester = createAuthCheckRepo();
      git(requester, ["fetch", repo, ref!]);
      expect(git(requester, ["rev-parse", "FETCH_HEAD^"])).toBe(request.merge_head_sha);
      expect(git(requester, ["diff", "--name-only", "FETCH_HEAD^", "FETCH_HEAD"])).toBe("notes.md\nscript.txt");
      expect(git(requester, ["ls-tree", "FETCH_HEAD", "script.txt"])).toMatch(/^100755 blob /);
      git(requester, ["checkout", "--detach", "FETCH_HEAD"]);
      expect(readFileSync(join(requester, "notes.md"))).toEqual(Buffer.from(notesEdit));
      expect(readFileSync(join(requester, "script.txt"))).toEqual(Buffer.from(scriptEdit));

      git(repo, ["checkout", branch]);
      writeFile(repo, "notes.md", notesHead.replace("proposed", "successor"));
      writeFile(repo, "script.txt", `first line\n${scriptHead}`);
      git(repo, ["add", "notes.md", "script.txt"]);
      git(repo, ["commit", "-m", "Address the review"]);
      git(repo, ["checkout", "main"]);
      const replacement = await submit({ ...await candidate(), supersedes_request_id: request.id,
        expected_revision: readBefore.precondition.expected_revision + 1, expected_custody_generation: readBefore.precondition.expected_custody_generation });
      const next = await read(replacement.id);
      expect(next.versions.map(version => [version.id, version.status])).toEqual([[request.id, "superseded"], [replacement.id, "pending"]]);
      expect(next.annotations.map(annotation => [annotation.body, annotation.anchor.status, annotation.anchor.start_offset]))
        .toEqual([["Explain the original wording.", "preserved", 9], ["Keep this check visible.", "preserved", 2]]);
      const conflict = next.drafts.find(draft => draft.path === "notes.md");
      expect(conflict).toMatchObject({ conflict: "overlap" });
      expect(conflict?.text).toMatch(/<<<<<<< Requester[\s\S]*Review the successor note\.[\s\S]*Review the operator note\./);
      expect(next.drafts.find(draft => draft.path === "script.txt")).toMatchObject({ conflict: null, text: `first line\n${scriptEdit}` });
      const compared = await invoke("GET", `/api/auth/request/${replacement.id}/review/changes?against=${request.id}`);
      expect(compared.status, JSON.stringify(compared.body)).toBe(200);
      expect(compared.body).toMatchObject({
        comparison: { merge_base_sha: request.merge_head_sha, head_sha: replacement.merge_head_sha },
        files: [{ old_path: "notes.md", new_path: "notes.md", additions: 1, deletions: 1 },
          { old_path: "script.txt", new_path: "script.txt", additions: 1, deletions: 0 }],
      });
      const second = await command(request.id);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("superseded");
      expect(second.stdout).toContain("Explain the original wording.");
      expect(second.stdout).toContain(ref);

      const unbound = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "config-change", command: "echo revise", title: "Empty review", session_id: session }, operator.id);
      const unboundUrl = `/api/auth/request/${unbound.id}`;
      const empty = await read(unbound.id);
      const emptyReturn = await invoke("POST", `${unboundUrl}/return`, {
        ...empty.precondition, round_id: empty.round.id, annotation_event_ids: [],
      });
      expect(emptyReturn.status, JSON.stringify(emptyReturn.body)).toBe(200);
      const emptyCli = await command(unbound.id);
      expect(emptyCli.status, emptyCli.stderr).toBe(0);
      expect(emptyCli.stdout).toContain("No comments");
      expect(emptyCli.stdout).toContain("Review notice undelivered");
      const notices = queue.notices!.collect("claude", "review-requester");
      expect(notices.map(notice => notice.text).join("\n")).toContain(`mandible auth review show ${unbound.id.slice(0, 8)}`);
      queue.notices!.delivered(notices.map(notice => notice.id));
      queue.assumeRequestResponsibility(unbound.id, { kind: "user", user_id: operator.id }, "Take responsibility", 2, 0);
      const durable = await invoke("GET", `${unboundUrl}/review/returned`);
      expect(durable.body).toMatchObject({ submission_id: (emptyReturn.body as { submission_id: string }).submission_id,
        delivered: true, responsibility: { custody_generation: 1 } });
    } finally {
      await queue.dispose();
      db.close();
    }
  });


  it("preserves canonical Description revisions by the existing durable credential owner", async () => {
    const { db, queue, operator, credential, submit } = requesterFixture();
    setDb(db);
    const request = (await submit());
    const router = authenticatedTestRouter(operator, { credentialId: credential.id });
    registerAuthRoutes(router, queue, inlineLedgerReader(() => queue.db));
    const edited = "Merge feature/original: Explain the reviewed change\r\n\r\nWhy:\r\nMake the action understandable.\r\n\r\nVerification:\r\nThe edited document's checks pass.\r\n";
    const result = await router.invoke({ method: "PUT", url: `/api/auth/v2/request/${request.id}`,
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
    queue.assumeRequestResponsibility("spec-request", { kind: "user", user_id: operator.id }, "Retire old request", 1, 0);
    const withdrawn = (await queue.withdraw("spec-request", "Operator retired an old request", {
      user_id: operator.id,
      evidence_method: "api_token",
      credential_id: credential.id,
      authority_path: "operator",
    }, 1, 1));
    expect(withdrawn).toMatchObject({ status: "withdrawn", spec_content: spec });
    const last = queue.listLifecycleEvents("spec-request").at(-1)!;
    expect(last.snapshot_sha256).toBe(authSnapshotDigest(last.snapshot_json));
    expect(JSON.parse(last.snapshot_json).request.spec_content).toBe(spec);
  });


  it("resubmits the same branch and delivery work unit after withdrawal", async () => {
    const { db, queue, actor, submit, submitExisting } = requesterFixture();
    const original = await submit();
    const custodyBefore = db.prepare("SELECT * FROM work_units WHERE id = ?")
      .get(original.custody_work_unit_id!);
    await queue.withdraw(original.id, "Revise the submission", actor, 1, 1);
    expect(db.prepare("SELECT * FROM work_units WHERE id = ?")
      .get(original.custody_work_unit_id!)).toEqual({ ...custodyBefore!, auth_request_id: null });
    expect((await queue.getRequest(original.id))?.custody_work_unit_id).toBe(original.custody_work_unit_id);

    const resubmitted = await submitExisting();
    expect(resubmitted.id).not.toBe(original.id);
    expect(resubmitted.status).toBe("pending");
    expect(resubmitted.custody_work_unit_id).toBe(original.custody_work_unit_id);
    expect(db.prepare("SELECT auth_request_id FROM work_units WHERE id = ?")
      .get(original.custody_work_unit_id!)).toEqual({ auth_request_id: resubmitted.id });
    expect((await queue.getRequest(original.id))?.status).toBe("withdrawn");
  });

  it("keeps rejected delivery work units bound and blocks resubmission", async () => {
    const { db, queue, submit, submitExisting } = requesterFixture();
    const original = await submit();
    await queue.reject(original.id, "Requires operator review");

    await expect(submitExisting()).rejects.toMatchObject({ code: "custody_required" });
    expect(db.prepare("SELECT auth_request_id FROM work_units WHERE id = ?")
      .get(original.custody_work_unit_id!)).toEqual({ auth_request_id: original.id });
    expect((await queue.getRequest(original.id))?.status).toBe("rejected");
  });

  it("binds delivery custody for a request that only closes its issue", async () => {
    const { submit } = requesterFixture();
    const request = (await submit({ issue_references: null, issue_closures: ["f15617a"] }));
    expect(request.custody_work_unit_id).toBeTruthy();
  });




  it("rejects stale lifecycle and custody preconditions", async () => {
    const { queue, actor, submit } = requesterFixture();
    const request = (await submit({ head_branch: "feature/stale-cas" }));
    await expect((async () => (await queue.withdraw(request.id, "stale revision", actor, 0, 1))())).rejects.toThrow(AuthQueueError);
    await expect((async () => (await queue.withdraw(request.id, "stale custody", actor, 1, 0))())).rejects.toThrow(AuthQueueError);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
  });


  it("inherits prerequisites on supersession and leaves dependent identities unchanged", async () => {
    const { db, queue, actor, submit } = requesterFixture();
    try {
      const source = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "config-change", command: "echo source", title: "Source" });
      const validation = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "config-change", command: "echo validation", title: "Validation" });
      const original = await submit({ depends_on_ids: [source.id, validation.id] });
      const dependent = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "config-change", command: "echo consumer", title: "Consumer", depends_on_ids: [original.id] });
      const replacement = await submit({ supersedes_request_id: original.id, expected_revision: 1, expected_custody_generation: 1 });
      expect(replacement.depends_on_ids).toEqual(original.depends_on_ids);
      expect((await queue.getRequest(dependent.id))?.depends_on_ids).toEqual([original.id]);
      expect(queue.dependenciesForRequest((await queue.getRequest(dependent.id))!)[0]?.state).toBe("failed");
      const cleared = await submit({ supersedes_request_id: replacement.id, expected_revision: 1,
        expected_custody_generation: 1, depends_on_ids: [] });
      expect(cleared.depends_on_ids).toEqual([]);
      await expect(queue.update(cleared.id, { depends_on_ids: [source.id] }, actor, 99, 1))
        .rejects.toMatchObject({ code: "lifecycle_conflict" });
      expect((await queue.getRequest(cleared.id))?.depends_on_ids).toEqual([]);
    } finally { await queue.dispose(); db.close(); }
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
