/**
 * @vitest-environment node
 *
 * A merge request that declares the teardown of a branch's preview ends, once
 * the merge is live, with the preview finalized as accepted and discarded and
 * its branch removed by the merge finalizer. A vetoed declaration, a branch the
 * merge did not land, a merge that is not live, and a preview instance's copy
 * of the ledger leave the preview running.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { BRANCH_REMOVAL_OUTPUT, REMOVE_MERGED_BRANCHES_STEP } from "../src/notices/contract.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { addCredential, getOperator } from "../src/users/store.js";
import { createOwnedRun, saveOwnedMetadata } from "../scripts/owned-run.mjs";
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
const ISSUE = "0a0a0a0";

let db: Db;
let repo: string;
let previewBase: string;

beforeEach(() => {
  db = createMigratedDb();
  repo = fs.realpathSync(createAuthCheckRepo());
  previewBase = fs.mkdtempSync(path.join(path.dirname(repo), "mandible-previews-"));
  vi.stubEnv("MANDIBLE_PREVIEW_BASE_DIR", previewBase);
  addProject(db, { project_key: "teardown-test", display_name: "Teardown Test" }, 1);
  addOrUpdateCheckout(db, "teardown-test", { root: repo, name: "repo", default_branch: "main" }, 2);
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

/** A `<head>__<name>` lane with its own worktree and a writable preview, merged into the head unless `merged` is false. */
function previewLane(name: string, options: { merged?: boolean } = {}): { branch: string; worktree: string; root: string } {
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
  const { root, metadata } = previewPaths(branch);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "ledger.db"), `interactive data of ${name}`);
  const ownership = createOwnedRun({ root, instanceId: `preview-${name}`, project: "teardown-test", workUnit: "unit",
    outputs: [{ path: "ledger.db", kind: "interactive" }] });
  Object.assign(ownership, { state: "active", lifecycle: { phase: "ready", teardown: false }, consumers: [] });
  saveOwnedMetadata(metadata, { previewRoot: root, branch, worktree, ownership });
  return { branch, worktree, root };
}

const declare = (branch: string) => ({ kind: "preview_teardown" as const, target_issue_ref: ISSUE, payload: { branch } });

async function submit(queue: AuthQueue, actions: ReturnType<typeof declare>[]): Promise<string> {
  const request = await queue.submit({
    ...AUTH_MERGE_REVIEW,
    type: "merge",
    command: `mandible auth merge ${HEAD} --into main`,
    title: "Declared teardown",
    repo: "teardown-test",
    cwd: repo,
    base_branch: "main",
    head_branch: HEAD,
    merge_head_sha: git(repo, ["rev-parse", HEAD]),
    execution_mode: "daemon",
    actions,
  });
  return request.id;
}

async function merge(queue: AuthQueue, id: string): Promise<void> {
  await approvePausedFixtureRequest(queue, id);
  await completeFixturePublication(queue, id);
}

function action(id: string, branch: string): { state: string; outcome_detail: string | null } {
  return db.prepare(
    `SELECT state, outcome_detail FROM auth_request_actions
     WHERE auth_request_id = ? AND kind = 'preview_teardown' AND json_extract(payload, '$.branch') = ?`,
  ).get(id, branch) as { state: string; outcome_detail: string | null };
}

function removal(id: string, branch: string): string | undefined {
  const row = db.prepare("SELECT merge_finalizer_state FROM auth_requests WHERE id = ?").get(id) as { merge_finalizer_state: string | null };
  const output = row.merge_finalizer_state ? JSON.parse(row.merge_finalizer_state)[REMOVE_MERGED_BRANCHES_STEP]?.output : undefined;
  const entry = output && BRANCH_REMOVAL_OUTPUT.parse(output).branches.find(candidate => candidate.branch === branch);
  return entry && (entry.reason ? `${entry.result} ${entry.reason}` : entry.result);
}

function receipts(): Array<Record<string, any>> {
  const directory = path.join(previewBase, ".receipts");
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    : [];
}

function teardownStep(id: string, branch: string) {
  return createOutcomeReporter(db)(id)?.steps.find(step => step.kind === "preview_teardown" && step.branch === branch);
}

/** A completed merge whose declarations convergence still withholds, left by a daemon that has stopped. */
async function mergeWithheld(actions: ReturnType<typeof declare>[]): Promise<string> {
  const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
  vi.spyOn(queue as unknown as { convergenceWithholdsClosures(): boolean }, "convergenceWithholdsClosures").mockReturnValue(true);
  try {
    const id = await submit(queue, actions);
    await merge(queue, id);
    await queue.drainFinalizers();
    return id;
  } finally {
    await queue.dispose();
  }
}

describe("declared preview teardown", () => {
  it("tears down a declared preview on a landed branch, and keeps a vetoed one and one the merge did not land", async () => {
    const declared = previewLane("declared");
    const vetoed = previewLane("vetoed");
    const unlanded = previewLane("unlanded", { merged: false });
    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      const id = await submit(queue, [declare(declared.branch), declare(vetoed.branch), declare(unlanded.branch)]);
      const veto = queue.listActions(id).find(entry => entry.payload.branch === vetoed.branch)!;
      const operator = getOperator(db)!;
      const credential = addCredential(db, operator.id, { type: "api_token", fingerprint: `teardown-veto-${crypto.randomUUID()}` });
      queue.setActionVeto(id, veto.id, true, {
        user_id: operator.id, evidence_method: "api_token", credential_id: credential.id, authority_path: "operator_recovery",
      }, 1, 0);
      await merge(queue, id);
      await queue.drainFinalizers();
      await waitUntil(() => action(id, declared.branch).state === "applied" && removal(id, declared.branch) === "removed",
        "the declared teardown and the removal of its branch");

      expect(action(id, declared.branch).outcome_detail).toMatch(/^Torn down run /);
      expect(fs.existsSync(declared.root)).toBe(false);
      expect(fs.existsSync(declared.worktree)).toBe(false);
      expect(receipts()).toEqual([expect.objectContaining({
        branch: declared.branch, outcome: "accepted", converged: true, disposition: "discard",
        summary: expect.stringMatching(/^Merged by auth \w+ as [0-9a-f]{8}$/),
        worktreeDisposition: expect.objectContaining({ retained: true }),
      })]);
      expect(teardownStep(id, declared.branch)).toMatchObject({ state: "done", reason: null });

      expect(action(id, vetoed.branch).state).toBe("vetoed");
      expect(removal(id, vetoed.branch)).toBe("kept preview_running");
      expect(fs.existsSync(path.join(vetoed.root, "ledger.db"))).toBe(true);

      expect(action(id, unlanded.branch)).toEqual({ state: "failed", outcome_detail: "not_merged" });
      expect(fs.existsSync(path.join(unlanded.root, "ledger.db"))).toBe(true);
      expect(teardownStep(id, unlanded.branch)).toMatchObject({ state: "kept", reason: "not_merged" });
    } finally {
      await queue.dispose();
    }
  });

  it("refuses a declaration that names no recorded preview or repeats a branch", async () => {
    const lane = previewLane("only");
    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      await expect(submit(queue, [declare(`${HEAD}__absent`)])).rejects.toThrow(/no preview is recorded/);
      const id = await submit(queue, [declare(lane.branch)]);
      expect(() => queue.addAction(id, declare(lane.branch))).toThrow(/already declared/);
    } finally {
      await queue.dispose();
    }
  });

  it("withholds the teardown until convergence completes", async () => {
    const lane = previewLane("live");
    const id = await mergeWithheld([declare(lane.branch)]);
    expect(action(id, lane.branch).state).toBe("staged");
    expect(fs.existsSync(path.join(lane.root, "ledger.db"))).toBe(true);

    const converged = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      await (converged as unknown as { releaseWithheldClosures(request: unknown): Promise<void> })
        .releaseWithheldClosures(converged.getRequestExact(id));
      await waitUntil(() => action(id, lane.branch).state === "applied", "the released teardown");
      expect(fs.existsSync(lane.root)).toBe(false);
    } finally {
      await converged.dispose();
    }
  });

  it("executes nothing from a preview instance's copy, and a restart finishes an interrupted teardown", async () => {
    const lane = previewLane("interrupted");
    const id = await mergeWithheld([declare(lane.branch)]);

    const copy = new AuthQueue({ db, hookManager: createNoopHookManager(), allowExternalEffects: false });
    try {
      await (copy as unknown as { releaseWithheldClosures(request: unknown): Promise<void> })
        .releaseWithheldClosures(copy.getRequestExact(id));
      expect(action(id, lane.branch).state).toBe("staged");
      expect(fs.existsSync(path.join(lane.root, "ledger.db"))).toBe(true);
    } finally {
      await copy.dispose();
    }

    // A teardown subprocess that died after retiring the runtime, holding the lifecycle lock.
    const { metadata } = previewPaths(lane.branch);
    const recorded = JSON.parse(fs.readFileSync(metadata, "utf8"));
    recorded.ownership.lifecycle = { phase: "retired", teardown: true };
    recorded.ownership.state = "stopped";
    recorded.ownership.revision += 1;
    saveOwnedMetadata(metadata, recorded);
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const lock = path.join(previewBase, `.${path.basename(lane.root)}.lock`);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: Number(dead.stdout.trim()), identity: "a process that has exited" }));

    const restarted = new AuthQueue({ db, hookManager: createNoopHookManager() });
    try {
      await waitUntil(() => action(id, lane.branch).state === "applied", "the start-up pass to finish the teardown");
      expect(fs.existsSync(lane.root)).toBe(false);
      expect(receipts()).toEqual([expect.objectContaining({ outcome: "accepted", converged: true, disposition: "discard" })]);
    } finally {
      await restarted.dispose();
    }
  });
});
