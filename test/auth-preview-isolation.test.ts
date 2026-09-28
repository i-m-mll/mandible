import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { AuthHookManager } from "../src/auth-hooks.js";
import type { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import type { AuthClearanceManager } from "../src/auth-clearance.js";
import type { AuthLifecycleActor } from "../src/types.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import type { Db } from "../src/db.js";
import { createAuthCheckRepo, createMigratedDb, git, trackTempPath } from "./helpers/auth-queue-fixtures.js";

describe("copied auth preview isolation", () => {
  it("keeps reads and queue edits local without touching source Git or invoking runtime work", async () => {
    const sourceDb = createMigratedDb();
    const repo = createAuthCheckRepo();
    const sourceQueue = new AuthQueue({ db: sourceDb, backgroundMaintenance: false });
    const sourceRequest = sourceQueue.submit({
      type: "commit",
      command: "echo source request",
      title: "Source request",
    });
    const candidateRef = `refs/mandible/auth-candidates/${sourceRequest.id}`;
    const candidateSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", candidateRef, candidateSha]);
    sourceDb.prepare(
      `UPDATE auth_requests
       SET cwd = ?, merge_candidate_pin_sha = ?, merge_candidate_tree_sha = ?, expires_at = 1
       WHERE id = ?`,
    ).run(repo, candidateSha, candidateSha, sourceRequest.id);

    const copiedDb = new Database(sourceDb.serialize()) as Db;
    const executor = vi.fn();
    const grantHookRetry = vi.fn();
    const runPendingHooks = vi.fn();
    const archiveThread = vi.fn(async () => {});
    const hookManager = {
      grantRetry: grantHookRetry,
      runPending: runPendingHooks,
    } as unknown as AuthHookManager;
    const preview = new AuthQueue({
      db: copiedDb,
      now: () => 10_000,
      backgroundMaintenance: false,
      allowExternalEffects: false,
      executor: executor as ConstructorParameters<typeof AuthQueue>[0]["executor"],
      hookManager,
      codexThreadArchiver: { archive: archiveThread, unarchive: vi.fn(async () => {}) },
    });
    const router = new Router();
    registerAuthRoutes(
      router,
      preview,
      {} as AuthAutoApproveManager,
      {} as AuthClearanceManager,
    );

    const fakeBin = trackTempPath(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-bin-")));
    const commandLog = path.join(fakeBin, "external-command.log");
    const fakeGit = path.join(fakeBin, "git");
    fs.writeFileSync(fakeGit, `#!/bin/sh\nprintf 'git\\n' >> '${commandLog}'\nexit 91\n`, { mode: 0o755 });
    fs.chmodSync(fakeGit, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${priorPath ?? ""}`;

    try {
      const checkResponse = await router.invoke({
        method: "POST",
        url: "/api/auth/check",
        body: { cwd: repo, base_branch: "main", head_branch: "main" },
      });
      expect(checkResponse.status).toBe(403);
      const mergeSubmitResponse = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          command: "mandible auth merge feature/blocked --into main",
          title: "Must not prepare a merge",
          cwd: repo,
        },
      });
      expect(mergeSubmitResponse.status).toBe(403);

      expect(preview.getRequest(sourceRequest.id)?.status).toBe("pending");
      expect(preview.listActive().find((request) => request.id === sourceRequest.id)?.status).toBe("pending");
      expect(() => preview.submit({
        command: "mandible auth merge feature/blocked --into main",
        title: "Must not prepare a merge",
      })).toThrow(/copied auth preview/);

      const localRequest = preview.submit({
        type: "commit",
        command: "echo copied preview request",
        title: "Copied request",
        actions: [{ kind: "label_add", target_issue_ref: "issue-preview", payload: { label: "draft" } }],
      });
      preview.update(localRequest.id, { title: "Edited in copy", spec_content: "Copied queue note." });
      const action = preview.addAction(localRequest.id, {
        kind: "label_add",
        target_issue_ref: "issue-preview",
        payload: { label: "review" },
      });
      preview.updateAction(localRequest.id, action.id, {
        kind: "label_add",
        target_issue_ref: "issue-preview",
        payload: { label: "ready" },
      });
      preview.setActionVeto(localRequest.id, action.id, true);
      preview.reject(sourceRequest.id, "Local preview decision.");

      expect(preview.getRequest(localRequest.id)).toMatchObject({
        title: "Edited in copy",
        spec_content: "Copied queue note.",
        status: "pending",
      });
      expect(preview.listActions(localRequest.id).at(-1)).toMatchObject({
        payload: { label: "ready" },
        state: "vetoed",
      });
      expect(preview.getRequest(sourceRequest.id)?.status).toBe("rejected");

      expect(() => preview.approve(localRequest.id)).toThrow(/copied auth preview/);
      expect(() => preview.appendOutput(localRequest.id, "fake output")).toThrow(/copied auth preview/);
      expect(() => preview.setResult(localRequest.id, 0, "fake success")).toThrow(/copied auth preview/);
      expect(() => preview.checkMergeIndependence({ cwd: repo, base_branch: "main", head_branch: "main" }))
        .toThrow(/copied auth preview/);
      const actor = { user_id: "preview", evidence_method: "test", credential_id: null } as AuthLifecycleActor;
      expect(() => preview.inspectPendingCandidateSnapshotRepair(sourceRequest.id, actor))
        .toThrow(/copied auth preview/);
      expect(() => preview.repairPendingCandidateSnapshot(sourceRequest.id, actor, 0, 0, "0".repeat(64)))
        .toThrow(/copied auth preview/);
      await expect(preview.retryHookConvergence(localRequest.id)).rejects.toThrow(/copied auth preview/);
      await expect(preview.replayCodexThreadArchives(localRequest.id)).rejects.toThrow(/copied auth preview/);

      expect(executor).not.toHaveBeenCalled();
      expect(grantHookRetry).not.toHaveBeenCalled();
      expect(runPendingHooks).not.toHaveBeenCalled();
      expect(archiveThread).not.toHaveBeenCalled();
      expect(fs.existsSync(commandLog)).toBe(false);
      process.env.PATH = priorPath;
      expect(git(repo, ["show-ref", "--verify", candidateRef])).toContain(candidateSha);

      expect(sourceDb.prepare("SELECT status, title FROM auth_requests WHERE id = ?")
        .get(sourceRequest.id)).toMatchObject({ status: "pending", title: "Source request" });
      expect(copiedDb.prepare("SELECT status FROM auth_requests WHERE id = ?")
        .get(sourceRequest.id)).toMatchObject({ status: "rejected" });
    } finally {
      process.env.PATH = priorPath;
      preview.dispose();
      copiedDb.close();
      sourceQueue.dispose();
      sourceDb.close();
    }
  });
});
