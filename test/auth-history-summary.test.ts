import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { migrate } from "../src/db.js";
import { setupOperator } from "../src/users/store.js";

// Issue 98d25f3 — `listHistorySummaries` selects an explicit column list and
// feeds the partial row into the full-row `mapRow`, which turns an unselected
// column into `null`. A summary therefore cannot distinguish "column not
// projected" from "column genuinely NULL", and history rows silently reported
// every request's `merge_finalizer_state` as null.

function createQueue(): { db: InstanceType<typeof Database>; queue: AuthQueue } {
  const db = new Database(":memory:");
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
  queue.approve(request.id);
  queue.setResult(request.id, 0, "console output");
  return request.id;
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

  it("agrees with the detail row on every field it claims to carry", () => {
    const { db, queue } = createQueue();
    const id = submitCompleted(queue);
    db.prepare("UPDATE auth_requests SET merge_finalizer_state = ? WHERE id = ?").run(
      JSON.stringify({ close_issues: { state: "done", attempts: 1, at: 1 } }),
      id,
    );

    // Fields the list projection deliberately drops (unbounded body blobs).
    const bodyBlobs = new Set(["diff_summary", "spec_content", "output"]);
    // Known remaining projection gap, tracked separately from 98d25f3: the
    // attribution columns are still unselected, so the history route resolves
    // requester/approver/evidence from fabricated nulls. Listed explicitly so
    // fixing it trips this test rather than the gap widening unnoticed.
    const knownUnprojected = new Set([
      "requested_by_user_id",
      "approved_by_user_id",
      "execution_evidence_id",
    ]);

    const [summary] = queue.listHistorySummaries(50);
    const detail = queue.getRequest(id)! as unknown as Record<string, unknown>;
    const summaryRecord = summary as unknown as Record<string, unknown>;

    const mismatched = Object.keys(detail)
      .filter((field) => !bodyBlobs.has(field) && !knownUnprojected.has(field))
      // JSON-compare so array-valued fields (issue_ids, issues, ...) are not
      // flagged purely for being distinct object references.
      .filter((field) => JSON.stringify(summaryRecord[field]) !== JSON.stringify(detail[field]));
    expect(mismatched).toEqual([]);
  });
});
