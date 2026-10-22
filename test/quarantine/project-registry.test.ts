// Quarantined: 34f2d82 — auth_clearances.project_id is not on the project move list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db.js";

import {
  addOrUpdateCheckout,
  addProject,
  auditRegistry,
  backfillProjectKeys,
  deriveProjectKeyBase,
  discoverProjectIdColumns,
  HISTORICAL_PROJECT_ID_COLUMNS,
  listProjects,
  ProjectRegistryError,
  PROJECT_ID_COLUMNS,
  repairRegistry,
  resolveProjectRef,
  slugifyProjectKey,
  suggestProjectRefs,
  updateProject,
} from "../../src/ledger/project-registry.js";

let tempDir = "";
let dbPath = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-prreg-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Key derivation — pure functions, no DB
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. backfillProjectKeys — idempotent, deduplicates collisions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. resolveProjectRef — precedence chain
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. addProject / updateProject / addOrUpdateCheckout
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. suggestProjectRefs — near-match keys for a typo
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. auditRegistry — each detection category
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. buildLedgerIssueDetailProjection — project_key wins over work_repo_id
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. repairRegistry merge — dry run, apply, FK check, conflict
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex review fixes (3d85f43)
// ---------------------------------------------------------------------------

describe("merge move-list schema coverage (codex review #1)", () => {
  it("every project-id column in the live schema is covered by the move list or historical allowlist", () => {
    const moveSet = new Set<string>();
    for (const { table, columns } of PROJECT_ID_COLUMNS) {
      for (const column of columns) moveSet.add(`${table}.${column}`);
    }
    const historicalSet = new Set(
      HISTORICAL_PROJECT_ID_COLUMNS.map((entry) => `${entry.table}.${entry.column}`),
    );
    const discovered = discoverProjectIdColumns(db);
    expect(discovered.length).toBeGreaterThan(0);
    const uncovered = discovered
      .map((entry) => `${entry.table}.${entry.column}`)
      .filter((key) => !moveSet.has(key) && !historicalSet.has(key));
    expect(uncovered).toEqual([]);
  });

});

