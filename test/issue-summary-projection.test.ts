import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { listLedgerIssueSummaries } from "../src/ledger/issue-projection.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

// Ledger writes require an explicit attribution context (main/user-system).
const SYSTEM_ACTOR = { attribution: systemAction() };

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-summary-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// listLedgerIssueSummaries only needs getRepos; checkouts come from the ledger.
describe("set-based issue summary projection", () => {
  it("uses the canonical project key instead of a path-derived scanner id", () => {
    const root = path.join(tempDir, "20 Widgets", "widgets");
    fs.mkdirSync(root, { recursive: true });
    const checkout = resolveProjectForCheckout(db, {
      root,
      name: "widgets",
      workRepoId: "20-widgets-widgets",
      defaultBranch: "main",
      remoteUrl: "https://github.com/example/widgets.git",
    });
    const store = new LedgerStore(db);
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Canonical route",
      body: "Hydrated detail",
      aliases: [{ alias_kind: "git_bug_human", alias: "abc1234", is_primary: true }],
    });

    const summaries = listLedgerIssueSummaries(db, {
      getRepos: () => [{
        id: "20-widgets-widgets",
        name: "widgets",
        root,
        exists: true,
        default_branch: "main",
        excluded: false,
        user_modified: false,
        last_scanned_at: null,
      }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      repo_id: "widgets",
      project_key: "widgets",
    });
    expect(summaries[0].issues[0].repo_id).toBe("widgets");
  });

});
