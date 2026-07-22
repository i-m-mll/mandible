import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
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

    // Exercise the real upgrade path from the schema immediately before the
    // user registry. The migration must seed only the system principal.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE IF EXISTS attribution_evidence;
      DROP TABLE IF EXISTS delegated_signing_leases;
      DROP TABLE IF EXISTS user_bindings;
      DROP TABLE IF EXISTS user_credentials;
      DROP TABLE IF EXISTS users;
      UPDATE meta SET value = '106' WHERE key = 'schema_version';
    `);
    db.pragma("foreign_keys = ON");
    migrate(db);
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

  it("returns setup guidance, then attributes the write after explicit setup", async () => {
    const blocked = await router.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueId}/comments`,
      body: { message: "Do not attribute this to system." },
    });

    expect(blocked).toEqual({
      status: 409,
      body: {
        error:
          "Local operator attribution is unavailable. " +
          "Run `mandible user setup` to create the local operator first.",
        code: "operator_not_configured",
        hint: "Run `mandible user setup` to create the local operator first.",
        retryable: false,
      },
    });
    expect(logger).not.toHaveBeenCalledWith(
      "error",
      "route_handler_error",
      expect.anything(),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE issue_id = ?")
      .get(issueId)).toEqual({ count: 0 });

    const setup = await router.invoke({
      method: "POST",
      url: "/api/users/setup",
      body: { slug: "operator", display_name: "Operator" },
    });
    expect(setup.status).toBe(200);
    const operatorId = (setup.body as { user: { id: string } }).user.id;

    const written = await router.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueId}/comments`,
      body: { message: "Attributed after explicit setup." },
    });
    expect(written.status).toBe(200);
    expect(db.prepare(
      `SELECT author_user_id, evidence_method, body
       FROM ledger_comments WHERE issue_id = ?`,
    ).get(issueId)).toEqual({
      author_user_id: operatorId,
      evidence_method: "local_default",
      body: "Attributed after explicit setup.",
    });
  });
});
