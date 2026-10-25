import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_COMMAND_REVIEW } from "./helpers/auth-queue-fixtures.js";
import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { AuthHookManager } from "../src/auth-hooks.js";
import type { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import type { AuthClearanceManager } from "../src/auth-clearance.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { setDb, type Db } from "../src/db.js";
import { createAuthCheckRepo, createMigratedDb, git, trackTempPath } from "./helpers/auth-queue-fixtures.js";

describe("copied auth preview isolation", () => {
  it("allows copied queue edits while reads and execution leave source state alone", async () => {
    const sourceDb = createMigratedDb();
    const repo = createAuthCheckRepo();
    const sourceQueue = new AuthQueue({ db: sourceDb, backgroundMaintenance: false });
    const sourceRequest = (await sourceQueue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo source", title: "Source" }));
    const candidateRef = `refs/mandible/auth-candidates/${sourceRequest.id}`;
    const candidateSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", candidateRef, candidateSha]);
    sourceDb.prepare(
      "UPDATE auth_requests SET cwd = ?, merge_candidate_pin_sha = ?, expires_at = 1 WHERE id = ?",
    ).run(repo, candidateSha, sourceRequest.id);

    const copiedDb = SqliteDatabase.fromSnapshot(sourceDb.serialize()) as Db;
    setDb(copiedDb);
    const executor = vi.fn();
    const preview = new AuthQueue({
      db: copiedDb,
      now: () => 10_000,
      allowExternalEffects: false,
      executor: executor as ConstructorParameters<typeof AuthQueue>[0]["executor"],
      hookManager: { grantRetry: vi.fn(), runPending: vi.fn(), selfUpdatesRuntime: () => false, runtimeHandoffLock: () => null } as unknown as AuthHookManager,
    });
    const router = new Router();
    registerAuthRoutes(router, preview, {} as AuthAutoApproveManager, {} as AuthClearanceManager, inlineLedgerReader(() => preview.db));
    const fakeBin = trackTempPath(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-bin-")));
    const commandLog = path.join(fakeBin, "commands.log");
    fs.writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh\necho git >> '${commandLog}'\nexit 91\n`, { mode: 0o755 });
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${priorPath ?? ""}`;

    try {
      const queueRead = await router.invoke({ method: "GET", url: "/api/auth/queue" });
      expect(queueRead.status).toBe(200);
      expect((await preview.getRequest(sourceRequest.id))?.status).toBe("pending");
      expect(await router.invoke({
        method: "POST", url: "/api/auth/check",
        body: { cwd: repo, base_branch: "main", head_branch: "main" },
      })).toMatchObject({ status: 403 });

      (await preview.update(sourceRequest.id, { title: "Edited in copy" }));
      (await preview.reject(sourceRequest.id, "Preview decision"));
      expect((await preview.getRequest(sourceRequest.id))).toMatchObject({ title: "Edited in copy", status: "rejected" });
      await expect((async () => (await preview.approve(sourceRequest.id))())).rejects.toThrow(/copied auth preview/);
      await expect((async () => (await preview.checkMergeIndependence({ cwd: repo, base_branch: "main", head_branch: "main" }))())).rejects
        .toThrow(/copied auth preview/);

      expect(executor).not.toHaveBeenCalled();
      expect(fs.existsSync(commandLog)).toBe(false);
      process.env.PATH = priorPath;
      expect(git(repo, ["show-ref", "--verify", candidateRef])).toContain(candidateSha);
      expect(sourceDb.prepare("SELECT status, title FROM auth_requests WHERE id = ?").get(sourceRequest.id))
        .toMatchObject({ status: "pending", title: "Source" });
    } finally {
      process.env.PATH = priorPath;
      (await preview.dispose());
      copiedDb.close();
      (await sourceQueue.dispose());
      sourceDb.close();
    }
  });
});
