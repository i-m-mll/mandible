import { approvePausedFixtureRequest, completeFixturePublication, createAuthCheckRepo, commitOnBranch, git, registerWorkRepo, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { MANDIBLE_REBUILD_HOOK_ID } from "../src/runtime-build-scope.js";
import type { Db } from "../src/db.js";
import { getOperator } from "../src/users/store.js";
import { LedgerStore } from "../src/ledger/store.js";
import { SYSTEM_ACTOR, createLedgerIssue, createLedgerProject, createMigratedDb } from "./helpers/ledger-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const recovery = (db: Db) => ({ mode: "verify-current" as const,
  actor: { user_id: getOperator(db)!.id, evidence_method: "local_socket" as const, authority_path: "operator" as const } });

function fixture() {
  const db = createMigratedDb({ setGlobal: true, operator: { slug: "go-live-test", display_name: "Go-live test" }, now: 1 });
  const repoRoot = createAuthCheckRepo();
  tempDirs.push(repoRoot);
  registerWorkRepo(db, repoRoot);
  const project = createLedgerProject(db, repoRoot, { defaultBranch: "main", remoteUrl: "" });
  const issue = (alias: string) => createLedgerIssue(db, { project_id: project.project.id, title: `Delivered ${alias}`, kind: "feature", alias });
  return { db, repoRoot, issue };
}

/** A rebuild hook row in the given state, as a self-update records it. */
function rebuild(db: Db, requestId: string, state: "complete" | "failed" | "retired" | "pending", finishedAt = Date.now()) {
  db.prepare(`INSERT OR REPLACE INTO auth_hook_executions (id, auth_request_id, hook_id, hook_label, command, command_digest, position, required,
      state, attempts, max_attempts, exit_code, output, attempt_history, started_at, finished_at, created_at, updated_at)
    VALUES (?, ?, ?, 'Rebuild', 'rebuild', ?, 0, 1, ?, 1, 1, ?, 'Terminal installed root changed.', '[]', 1, ?, 1, ?)`)
    .run(randomUUID(), requestId, MANDIBLE_REBUILD_HOOK_ID, "0".repeat(64), state, state === "complete" ? 0 : 1, finishedAt, finishedAt);
}

async function merge(queue: AuthQueue, repoRoot: string, branch: string, actions: Array<{ target: string }>, before?: (id: string) => void) {
  commitOnBranch(repoRoot, `feature/${branch}`, { [`${branch}.txt`]: `${branch}\n` });
  const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", command: `mandible auth merge feature/${branch} --into main`,
    title: branch, cwd: repoRoot, repo: path.basename(repoRoot), execution_mode: "daemon", base_branch: "main",
    head_branch: `feature/${branch}`, merge_head_sha: git(repoRoot, ["rev-parse", `feature/${branch}`]),
    actions: actions.map(({ target }) => ({ kind: "issue_close" as const, target_issue_ref: target, payload: {} })) });
  before?.(request.id);
  await approvePausedFixtureRequest(queue, request.id);
  await completeFixturePublication(queue, request.id);
  await queue.drainFinalizers();
  return request.id;
}

describe("superseded go-live", () => {
  it("settles a predecessor's withheld closures at startup from an already verified successor, and recover reports it", async () => {
    const { db, repoRoot, issue } = fixture();
    let queue: AuthQueue | undefined;
    try {
      const open = issue("open1");
      const closedByHand = issue("hand1");
      const store = new LedgerStore(db);
      queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false });
      const predecessor = await merge(queue, repoRoot, "pred", [{ target: open.short_id }, { target: closedByHand.short_id }],
        id => rebuild(db, id, "failed"));
      expect(queue.listActions(predecessor).map(action => action.state)).toEqual(["staged", "staged"]);
      store.setIssueStatus(closedByHand.id, "closed", "delivered", { actor_type: "system", actor_id: null, ...SYSTEM_ACTOR }, "mandible");
      const successor = await merge(queue, repoRoot, "succ", []);
      rebuild(db, successor, "complete");
      await queue.dispose();

      queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: true });
      await (queue as unknown as { startupRecovery: Promise<void> }).startupRecovery;

      expect(store.getIssue(open.id)).toMatchObject({ status: "closed", resolution: "delivered" });
      const actions = queue.listActions(predecessor);
      expect(actions.map(action => action.state)).toEqual(["applied", "applied"]);
      expect(actions[1].outcome_detail).toContain("already closed");
      expect(queue.convergenceForRequest(predecessor)).toMatchObject({ state: "complete", superseded_by: { successor_request_id: successor } });

      const recovered = await queue.retryHookConvergence(predecessor, undefined, recovery(db));
      expect(recovered.supersession).toMatchObject({ successor_request_id: successor,
        settled: [{ target_issue_ref: open.short_id, state: "applied" }, { target_issue_ref: closedByHand.short_id, state: "applied" }] });
    } finally { await queue?.dispose(); db.close(); }
  });

  it("settles a retired predecessor as soon as a containing successor converges", async () => {
    const { db, repoRoot, issue } = fixture();
    let queue: AuthQueue | undefined;
    try {
      const target = issue("retired1");
      queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false });
      const predecessor = await merge(queue, repoRoot, "retired", [{ target: target.short_id }], id => rebuild(db, id, "retired"));
      expect(new LedgerStore(db).getIssue(target.id).status).toBe("open");
      await merge(queue, repoRoot, "live", [], id => rebuild(db, id, "complete"));
      expect(new LedgerStore(db).getIssue(target.id)).toMatchObject({ status: "closed", resolution: "delivered" });
      expect(queue.listActions(predecessor)[0].outcome_detail).toContain("Settled by the verified go-live");
    } finally { await queue?.dispose(); db.close(); }
  });

  it("keeps refusing recovery, saying why, when the live version does not contain the merge", async () => {
    const { db, repoRoot, issue } = fixture();
    let queue: AuthQueue | undefined;
    try {
      const target = issue("later1");
      queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false });
      const earlier = await merge(queue, repoRoot, "earlier", []);
      const later = await merge(queue, repoRoot, "later", [{ target: target.short_id }], id => rebuild(db, id, "failed"));
      // The earlier merge went live only after the later one had merged.
      rebuild(db, earlier, "complete", Date.now() + 60_000);
      await expect(queue.retryHookConvergence(later, undefined, recovery(db)))
        .rejects.toMatchObject({ code: "recovery_refused", message: expect.stringContaining(`went live through auth request ${earlier.slice(0, 8)}`) });
      expect(queue.listActions(later)[0].state).toBe("staged");
      expect(new LedgerStore(db).getIssue(target.id).status).toBe("open");
    } finally { await queue?.dispose(); db.close(); }
  });
});
