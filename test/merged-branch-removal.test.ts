/**
 * @vitest-environment node
 *
 * The merge finalizer removes every branch a merge landed, records each
 * result in `BRANCH_REMOVAL_OUTPUT`, and retries a branch kept for a running
 * preview once the preview is finalized.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { BRANCH_REMOVAL_OUTPUT, REMOVE_MERGED_BRANCHES_STEP, type BranchRemovalOutput } from "../src/notices/contract.js";
import { createOwnedRun, finalizeOwnedRun, saveOwnedMetadata } from "../scripts/owned-run.mjs";
import { previewPaths } from "../scripts/preview-custody.mjs";
import {
  AUTH_MERGE_REVIEW,
  approvePausedFixtureRequest,
  completeFixturePublication,
  createAuthCheckRepo,
  createMigratedDb,
  createNoopHookManager,
  git,
  registerWorkRepo,
  writeFile,
} from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";

const HEAD = "feature/x";

let db: Db;
let repo: string;
let previewBase: string;

beforeEach(() => {
  db = createMigratedDb();
  repo = fs.realpathSync(createAuthCheckRepo());
  previewBase = fs.mkdtempSync(path.join(path.dirname(repo), "mandible-previews-"));
  vi.stubEnv("MANDIBLE_PREVIEW_BASE_DIR", previewBase);
  addProject(db, { project_key: "removal-test", display_name: "Removal Test" }, 1);
  addOrUpdateCheckout(db, "removal-test", { root: repo, name: "repo", default_branch: "main" }, 2);
  registerWorkRepo(db, repo);
  git(repo, ["checkout", "-b", HEAD, "main"]);
  writeFile(repo, "head.txt", "head\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", HEAD]);
  git(repo, ["checkout", "main"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(previewBase, { recursive: true, force: true });
  db.close();
});

/** A `<head>__<name>` lane with its own worktree and one commit, merged into the head unless `merged` is false. */
function lane(name: string, options: { merged?: boolean } = {}): { branch: string; worktree: string } {
  const branch = `${HEAD}__${name}`;
  const worktree = path.join(repo, "worktrees", name);
  git(repo, ["worktree", "add", "-b", branch, worktree, HEAD]);
  writeFile(worktree, `${name}.txt`, `${name}\n`);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", branch]);
  if (options.merged !== false) {
    git(repo, ["checkout", HEAD]);
    git(repo, ["merge", "--no-ff", "--no-edit", branch]);
    git(repo, ["checkout", "main"]);
  }
  return { branch, worktree };
}

function runningPreview(branch: string, worktree: string) {
  const { root, metadata } = previewPaths(branch);
  fs.mkdirSync(root, { recursive: true });
  const ownership = createOwnedRun({ root, instanceId: "preview-fixture", project: "removal-test", workUnit: "unit", outputs: [], disposable: true });
  ownership.state = "active";
  saveOwnedMetadata(metadata, { branch, worktree, ownership });
  return () => finalizeOwnedRun(metadata, { expectedRevision: ownership.revision, outcome: "assessed", summary: "done", inspect: () => ({ idle: true }) });
}

async function merge(queue: AuthQueue): Promise<string> {
  const request = await queue.submit({
    ...AUTH_MERGE_REVIEW,
    type: "merge",
    command: `mandible auth merge ${HEAD} --into main`,
    title: "Branch removal",
    repo: "removal-test",
    cwd: repo,
    base_branch: "main",
    head_branch: HEAD,
    merge_head_sha: git(repo, ["rev-parse", HEAD]),
    execution_mode: "daemon",
  });
  await approvePausedFixtureRequest(queue, request.id);
  await completeFixturePublication(queue, request.id);
  return request.id;
}

function finalizerState(id: string): Record<string, { state: string; output?: unknown }> {
  const row = db.prepare("SELECT merge_finalizer_state FROM auth_requests WHERE id = ?").get(id) as { merge_finalizer_state: string };
  return JSON.parse(row.merge_finalizer_state);
}

function results(id: string): Record<string, string> {
  const output = BRANCH_REMOVAL_OUTPUT.parse(finalizerState(id)[REMOVE_MERGED_BRANCHES_STEP].output);
  return Object.fromEntries(output.branches.map(entry => [entry.branch, entry.reason ? `${entry.result} ${entry.reason}` : entry.result]));
}

function branchExists(branch: string): boolean {
  return git(repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`]) === branch;
}

/** A completed merge whose daemon stopped before the branch-removal step ran. */
async function mergeStoppedBeforeRemoval(): Promise<string> {
  const stopped = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
  vi.spyOn(stopped as unknown as { removeLandedBranches(): Promise<unknown> }, "removeLandedBranches")
    .mockRejectedValue(new Error("daemon stopped"));
  const id = await merge(stopped);
  await stopped.drainFinalizers();
  await stopped.dispose();
  expect(finalizerState(id)[REMOVE_MERGED_BRANCHES_STEP].state).toBe("pending");
  return id;
}

describe("merged-branch removal", () => {
  it("records each landed branch, then removes the preview's branch once the preview is finalized", async () => {
    const clean = lane("clean");
    const ignored = lane("ignored");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "notes.local\n");
    writeFile(ignored.worktree, "notes.local", "kept notes\n");
    const unmerged = lane("unmerged", { merged: false });
    const preview = lane("preview");
    const finalizePreview = runningPreview(preview.branch, preview.worktree);

    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      const id = await merge(queue);
      await queue.drainFinalizers();
      expect(finalizerState(id)[REMOVE_MERGED_BRANCHES_STEP].state).toBe("done");
      expect(results(id)).toEqual({
        [HEAD]: "removed",
        [clean.branch]: "removed",
        [ignored.branch]: "trashed",
        [unmerged.branch]: "kept not_merged",
        [preview.branch]: "kept preview_running",
      });
      expect([clean.worktree, ignored.worktree].some(fs.existsSync)).toBe(false);
      expect(fs.existsSync(unmerged.worktree) && fs.existsSync(preview.worktree)).toBe(true);

      const retry = () => (queue as unknown as { retryKeptBranches(): Promise<void> }).retryKeptBranches();
      await retry();
      expect(results(id)[preview.branch]).toBe("kept preview_running");

      finalizePreview();
      await retry();
      expect(results(id)[preview.branch]).toBe("removed");
      expect(results(id)[unmerged.branch]).toBe("kept not_merged");
      expect(fs.existsSync(preview.worktree)).toBe(false);
      expect(branchExists(preview.branch)).toBe(false);
      expect(branchExists(unmerged.branch)).toBe(true);
    } finally {
      await queue.dispose();
    }
  });

  it("resumes pending removals after a restart without losing branches removed before it", async () => {
    const first = lane("first");
    const second = lane("second");
    const id = await mergeStoppedBeforeRemoval();

    // The step had listed its candidates and removed the first lane when the daemon stopped.
    const listed: BranchRemovalOutput = { branches: [HEAD, first.branch, second.branch].map(branch => ({
      branch, result: "pending" as const, reason: null, worktree_path: null,
    })) };
    const state = finalizerState(id);
    state[REMOVE_MERGED_BRANCHES_STEP] = { ...state[REMOVE_MERGED_BRANCHES_STEP], output: listed };
    db.prepare("UPDATE auth_requests SET merge_finalizer_state = ? WHERE id = ?").run(JSON.stringify(state), id);
    git(repo, ["worktree", "remove", "--force", first.worktree]);
    git(repo, ["branch", "-D", first.branch]);

    const restarted = new AuthQueue({ db, hookManager: createNoopHookManager() });
    try {
      await waitUntil(() => restarted.getRequestExact(id)?.merge_finalized_at, "the startup sweep to finalize the merge");
      expect(results(id)).toEqual({ [HEAD]: "removed", [first.branch]: "removed", [second.branch]: "removed" });
      expect(fs.existsSync(second.worktree)).toBe(false);
    } finally {
      await restarted.dispose();
    }
  });

  it("removes and retries nothing from a preview instance's copy of the ledger", async () => {
    const child = lane("child");
    const id = await mergeStoppedBeforeRemoval();
    const preview = new AuthQueue({ db, hookManager: createNoopHookManager(), allowExternalEffects: false });
    try {
      await (preview as unknown as { runBackgroundFinalizers(id: string): Promise<void> }).runBackgroundFinalizers(id);
      expect(finalizerState(id)[REMOVE_MERGED_BRANCHES_STEP]).toMatchObject({ state: "pending", error: expect.stringContaining("copied auth preview") });

      const kept: BranchRemovalOutput = { branches: [HEAD, child.branch].map(branch => ({
        branch, result: "kept" as const, reason: "preview_running" as const, worktree_path: null,
      })) };
      const state = finalizerState(id);
      state[REMOVE_MERGED_BRANCHES_STEP] = { state: "done", attempts: 1, at: 0, output: kept } as never;
      db.prepare("UPDATE auth_requests SET merge_finalizer_state = ?, merge_finalized_at = 1 WHERE id = ?").run(JSON.stringify(state), id);
      await (preview as unknown as { retryKeptBranches(): Promise<void> }).retryKeptBranches();
      expect(results(id)).toEqual({ [HEAD]: "kept preview_running", [child.branch]: "kept preview_running" });
      expect(branchExists(HEAD) && branchExists(child.branch) && fs.existsSync(child.worktree)).toBe(true);
    } finally {
      await preview.dispose();
    }
  });
});
