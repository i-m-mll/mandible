import { seedHistoricalAuthCompletion } from "../helpers/auth-queue-fixtures.js";
import SqliteDatabase from "../../src/sqlite.ts";
import { describe, expect, it } from "vitest";

import { AuthQueue } from "../../src/auth-queue.js";
import { migrate } from "../../src/db.js";
import {
  AttributionReadResolver,
  authAttributionReadFields,
} from "../../src/identity/read-projection.js";
import {
  addAttributionEvidence,
  addCredential,
  createUser,
  setupOperator,
} from "../../src/users/store.js";

// Issue 98d25f3 — `listHistorySummaries` selects an explicit column list and
// feeds the partial row into the full-row `mapRow`, which turns an unselected
// column into `null`. A summary therefore cannot distinguish "column not
// projected" from "column genuinely NULL", and history rows silently reported
// every request's `merge_finalizer_state` as null.
//
// Issue 84d940f — the same gap covered `requested_by_user_id`,
// `approved_by_user_id`, and `execution_evidence_id`, so `GET /api/auth/history`
// resolved requester/approver/verified-signature from fabricated nulls.

function createQueue(): { db: InstanceType<typeof SqliteDatabase>; queue: AuthQueue } {
  const db = new SqliteDatabase(":memory:");
  migrate(db);
  setupOperator(db, { slug: "history-summary-operator", display_name: "History Summary" }, 1);
  return { db, queue: new AuthQueue({ db }) };
}

function submitCompleted(queue: AuthQueue): string {
  const request = queue.submit({
    type: "merge",
    command: "mandible auth merge feature/x --into main",
    title: "History row",
    repo: "mandible",
    base_branch: "main",
    head_branch: "feature/x",
    diff_summary: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n",
    spec_content: "# Spec\n\nlots of text",
    commit_message: "feat: land it",
    execution_mode: "remote",
  });
  seedHistoricalAuthCompletion(queue, request.id, "console output");
  return request.id;
}

/**
 * Give a request real approver + execution-evidence attribution. `submit`
 * already stores a real `requested_by_user_id`; approval attribution is
 * normally written by the authenticated approve/merge path, which this
 * in-memory harness does not run.
 */
function attributeRequest(
  db: InstanceType<typeof SqliteDatabase>,
  id: string,
): { approverId: string; evidenceId: string; credentialId: string } {
  const approver = createUser(db, {
    slug: "history-summary-approver",
    kind: "human",
    display_name: "History Summary Approver",
  });
  const credential = addCredential(db, approver.id, {
    type: "ssh_key",
    fingerprint: "SHA256:aGlzdG9yeVN1bW1hcnlBcHByb3ZlckNyZWRlbnRpYWw=",
    label: "yubikey",
  });
  const evidence = addAttributionEvidence(db, {
    evidence_method: "credential_signature",
    credential_id: credential.id,
    details: { verified: true },
  });
  db.prepare(
    "UPDATE auth_requests SET approved_by_user_id = ?, execution_evidence_id = ? WHERE id = ?",
  ).run(approver.id, evidence.id, id);
  return { approverId: approver.id, evidenceId: evidence.id, credentialId: credential.id };
}

describe("auth history summaries", () => {
  it("reports merge_finalizer_state instead of fabricating null", () => {
    const { db, queue } = createQueue();
    const id = submitCompleted(queue);

    const finalizerState = JSON.stringify({
      close_issues: { state: "done", attempts: 1, at: 1_700_000_000_000 },
      resolve_work_units: {
        state: "failed",
        attempts: 3,
        at: 1_700_000_001_000,
        error: "boom",
      },
    });
    db.prepare("UPDATE auth_requests SET merge_finalizer_state = ? WHERE id = ?").run(
      finalizerState,
      id,
    );

    const [summary] = queue.listHistorySummaries(50);
    expect(summary).toBeDefined();
    expect(summary.id).toBe(id);
    expect(summary.merge_finalizer_state).toBe(finalizerState);
    // The summary must agree with the detail route for the same request.
    expect(summary.merge_finalizer_state).toBe(queue.getRequest(id)!.merge_finalizer_state);
  });

  it("keeps a genuinely unset merge_finalizer_state null", () => {
    const { queue } = createQueue();
    submitCompleted(queue);

    const [summary] = queue.listHistorySummaries(50);
    expect(summary.merge_finalizer_state).toBeNull();
  });

  it("still omits the unbounded body blobs", () => {
    const { queue } = createQueue();
    submitCompleted(queue);

    const [summary] = queue.listHistorySummaries(50);
    expect("diff_summary" in summary).toBe(false);
    expect("spec_content" in summary).toBe(false);
    expect("output" in summary).toBe(false);
    expect(summary.commit_message).toBe("feat: land it");
  });

  it("reports the stored attribution ids instead of fabricating null", () => {
    const { db, queue } = createQueue();
    const id = submitCompleted(queue);
    const { approverId, evidenceId } = attributeRequest(db, id);

    const detail = queue.getRequest(id)!;
    expect(detail.requested_by_user_id).toBeTruthy();

    const [summary] = queue.listHistorySummaries(50);
    expect(summary.requested_by_user_id).toBe(detail.requested_by_user_id);
    expect(summary.approved_by_user_id).toBe(approverId);
    expect(summary.execution_evidence_id).toBe(evidenceId);
  });

  it("resolves the same attribution read fields as the detail row", () => {
    const { db, queue } = createQueue();
    const id = submitCompleted(queue);
    const { approverId, credentialId } = attributeRequest(db, id);

    // Mirrors GET /api/auth/history: the summary row is fed straight into
    // authAttributionReadFields (src/routes/auth.ts).
    const [summary] = queue.listHistorySummaries(50);
    const summaryFields = authAttributionReadFields(new AttributionReadResolver(db), summary);
    const detailFields = authAttributionReadFields(
      new AttributionReadResolver(db),
      queue.getRequest(id)!,
    );

    expect(summaryFields).toEqual(detailFields);
    expect(summaryFields.requester?.display_name).toBe("History Summary");
    expect(summaryFields.approver?.id).toBe(approverId);
    expect(summaryFields.execution_evidence?.evidence_method).toBe("credential_signature");
    expect(summaryFields.execution_evidence?.credential?.id).toBe(credentialId);
    expect(summaryFields.merge_signature).toEqual({ state: "verified", fingerprint: null });
  });

  it("keeps genuinely unset approval attribution null", () => {
    // A rejected request never gains approval attribution, so its nulls are
    // real. It still carries a requester, which must survive the projection.
    const { queue } = createQueue();
    const request = queue.submit({
      type: "merge",
      command: "mandible auth merge feature/y --into main",
      title: "Rejected row",
      repo: "mandible",
      base_branch: "main",
      head_branch: "feature/y",
    });
    queue.reject(request.id);

    const [summary] = queue.listHistorySummaries(50);
    expect(summary.id).toBe(request.id);
    expect(summary.requested_by_user_id).toBe(request.requested_by_user_id);
    expect(summary.requested_by_user_id).toBeTruthy();
    expect(summary.approved_by_user_id).toBeNull();
    expect(summary.execution_evidence_id).toBeNull();
  });

  it("agrees with the detail row on every field it claims to carry", () => {
    const { db, queue } = createQueue();
    const id = submitCompleted(queue);
    db.prepare("UPDATE auth_requests SET merge_finalizer_state = ? WHERE id = ?").run(
      JSON.stringify({ close_issues: { state: "done", attempts: 1, at: 1 } }),
      id,
    );
    // Populate the attribution columns too, so a fabricated null shows up as a
    // mismatch here rather than as two nulls that happen to agree.
    attributeRequest(db, id);

    // The only fields the list projection deliberately drops: the unbounded
    // body blobs the summary exists to avoid serializing. Everything else in
    // AuthRequestSummary (= Omit<AuthRequest, those four>) must be projected,
    // so a future column added to the row but not to
    // AUTH_HISTORY_SUMMARY_COLUMNS trips this test (issues 98d25f3, 84d940f).
    const bodyBlobs = new Set(["diff_summary", "spec_content", "output", "change_report"]);

    const [summary] = queue.listHistorySummaries(50);
    const detail = queue.getRequest(id)! as unknown as Record<string, unknown>;
    const summaryRecord = summary as unknown as Record<string, unknown>;

    const mismatched = Object.keys(detail)
      .filter((field) => !bodyBlobs.has(field))
      // JSON-compare so array-valued fields (issue_ids, issues, ...) are not
      // flagged purely for being distinct object references.
      .filter((field) => JSON.stringify(summaryRecord[field]) !== JSON.stringify(detail[field]));
    expect(mismatched).toEqual([]);
  });
});
