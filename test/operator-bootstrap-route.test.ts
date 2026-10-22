import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { Router } from "../src/server.js";
import { SYSTEM_USER_ID } from "../src/users/store.js";

describe("operator bootstrap ledger boundary", () => {
  let tempDir: string;
  let db: Db;
  let router: Router;
  let issueId: string;
  let logger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-operator-bootstrap-"));
    db = openDb(path.join(tempDir, "mandible.db"));

    setDb(db);

    expect(db.prepare("SELECT id, kind FROM users").all()).toEqual([
      { id: SYSTEM_USER_ID, kind: "system" },
    ]);

    const project = resolveProjectForCheckout(db, {
      root: tempDir,
      name: "mandible",
      workRepoId: "mandible",
    }).project;
    issueId = new LedgerStore(db).createIssue({
      project_id: project.id,
      title: "Bootstrap boundary",
      body: "System-created fixture awaiting an operator comment.",
      actor_type: "system",
      author_display: "Mandible system",
      attribution: systemAction(),
      source: "mandible",
    }).id;

    logger = vi.fn();
    router = new Router({ logger });
    registerUserRoutes(router);
    registerIssueRoutes(router, {
      getRepos: () => [],
      getRepoById: () => undefined,
      getBranches: () => [],
    } as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects a tokenless HTTP write without an operator (issue a64d2de)", async () => {
    const written = await router.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueId}/comments`,
      body: { message: "Tokenless HTTP comment." },
      transport: "http",
    });

    expect(written.status).toBe(401);
    expect(logger).not.toHaveBeenCalledWith(
      "error",
      "route_handler_error",
      expect.anything(),
    );
    expect(db.prepare(
      `SELECT author_user_id, evidence_method, body
       FROM ledger_comments WHERE issue_id = ?`,
    ).get(issueId)).toBeUndefined();
  });
});
