import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  addOrUpdateCheckout,
  addProject,
  auditRegistry,
  backfillProjectKeys,
  deriveProjectKeyBase,
  ProjectRegistryError,
  repairRegistry as repairRegistryResult,
  slugifyProjectKey,
  suggestProjectRefs,
} from "../src/ledger/project-registry.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

function repairRegistry(...args: Parameters<typeof repairRegistryResult>) {
  const result = repairRegistryResult(...args);
  if (!result.ok) throw new ProjectRegistryError(result.error.message, result.error.code, { conflicts: result.error.conflicts });
  return result.value;
}

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-prreg-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Key derivation — pure functions, no DB
// ---------------------------------------------------------------------------

describe("project key derivation", () => {
  it.each([
    ["20 Feedbax", "20-feedbax"],
    ["Hello World", "hello-world"],
    ["  spaces  ", "spaces"],
    ["!feedbax!", "feedbax"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("slugifies %j to %j", (input, expected) => {
    expect(slugifyProjectKey(input)).toBe(expected);
  });

  it.each([
    [{ remote_identity: "github.com/mll/feedbax" }, "feedbax"],
    [{ remote_identity: "local:/some/path", display_name: "Feedbax" }, "feedbax"],
    [{ remote_identity: "file:/repo/path", display_name: "myproj" }, "myproj"],
    [{ display_name: "Feedbax" }, "feedbax"],
    [{ root: "/x/20 Feedbax" }, "20-feedbax"],
    [{ root: "/x/myproj/repo" }, "myproj-repo"],
    [{ root: "/home/work/code" }, "work-code"],
    [{ root: "/x/feedbax" }, "feedbax"],
    [{ root: "/repo" }, "project"],
  ])("derives the key base of %j as %j", (input, expected) => {
    expect(deriveProjectKeyBase(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. backfillProjectKeys — idempotent, deduplicates collisions
// ---------------------------------------------------------------------------

describe("backfillProjectKeys", () => {
  it("assigns distinct keys and is idempotent; second run returns 0", () => {
    const dir1 = path.join(tempDir, "proj1");
    const dir2 = path.join(tempDir, "proj2");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    // Both remotes tail to "feedbax" — after blanking they would collide
    const { project: p1 } = resolveProjectForCheckout(db, {
      root: dir1,
      remoteUrl: "git@github.com:user1/feedbax.git",
    });
    const { project: p2 } = resolveProjectForCheckout(db, {
      root: dir2,
      remoteUrl: "git@github.com:user2/feedbax.git",
    });

    // Blank both keys to simulate pre-migration state
    db.prepare("UPDATE ledger_projects SET project_key = '' WHERE id = ?").run(p1.id);
    db.prepare("UPDATE ledger_projects SET project_key = '' WHERE id = ?").run(p2.id);

    const count = backfillProjectKeys(db);
    expect(count).toBe(2);

    const rows = db
      .prepare(
        "SELECT project_key FROM ledger_projects WHERE id IN (?, ?) ORDER BY created_at, id",
      )
      .all(p1.id, p2.id) as Array<{ project_key: string }>;

    expect(rows[0].project_key).not.toBe("");
    expect(rows[1].project_key).not.toBe("");
    expect(rows[0].project_key).not.toBe(rows[1].project_key);

    // Idempotency
    const count2 = backfillProjectKeys(db);
    expect(count2).toBe(0);

    // Referential integrity intact
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. addProject / updateProject / addOrUpdateCheckout
// ---------------------------------------------------------------------------

describe("addProject", () => {
  it("throws missing_key when project_key is absent or empty", () => {
    let caught: unknown;
    try {
      addProject(db, { display_name: "No Key" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectRegistryError);
    expect((caught as ProjectRegistryError).code).toBe("missing_key");
  });

  it("throws key_conflict on duplicate project_key", () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    let caught: unknown;
    try {
      addProject(db, {
        project_key: "feedbax",
        remote_identity: "git@github.com:mll/feedbax-fork.git",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectRegistryError);
    expect((caught as ProjectRegistryError).code).toBe("key_conflict");
  });
});

describe("addOrUpdateCheckout", () => {
  it("inserts once, updates on second call, no duplicate rows", () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    const root = path.join(tempDir, "checkout1");
    fs.mkdirSync(root, { recursive: true });

    const { checkout: c1 } = addOrUpdateCheckout(db, "feedbax", {
      root,
      work_repo_id: "20-feedbax",
    });
    expect(c1.root).toBe(path.resolve(root));

    const { checkout: c2 } = addOrUpdateCheckout(db, "feedbax", {
      root,
      work_repo_id: "20-feedbax-updated",
      name: "Updated",
    });
    expect(c2.id).toBe(c1.id); // same row updated
    expect(c2.work_repo_id).toBe("20-feedbax-updated");

    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM ledger_project_checkouts")
      .get() as { n: number };
    expect(n).toBe(1);
  });

  it("does not persist a parent-prefixed scanner id for a canonical checkout", () => {
    addProject(db, {
      project_key: "widgets",
      remote_identity: "git@github.com:mll/widgets.git",
    });
    const root = path.join(tempDir, "20 Widgets", "widgets");
    fs.mkdirSync(root, { recursive: true });

    const { checkout } = addOrUpdateCheckout(db, "widgets", {
      root,
      work_repo_id: "20-widgets-widgets",
    });
    expect(checkout.work_repo_id).toBe("widgets");

    const updated = addOrUpdateCheckout(db, "widgets", {
      root,
      work_repo_id: "20-widgets-widgets",
    });
    expect(updated.checkout.work_repo_id).toBe("widgets");
  });

});

// ---------------------------------------------------------------------------
// 7. suggestProjectRefs — near-match keys for a typo
// ---------------------------------------------------------------------------

describe("suggestProjectRefs", () => {
  it("returns near-match keys for a prefix typo", () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
    });

    // "feedba" is a strict prefix — the key includes it
    const suggestions = suggestProjectRefs(db, "feedba");
    expect(suggestions).toContain("feedbax");
  });

});

// ---------------------------------------------------------------------------
// 8. auditRegistry — each detection category
// ---------------------------------------------------------------------------

describe("auditRegistry", () => {
  it("detects numbered_repo_ids (work_repo_id starts with digit-hyphen)", () => {
    const dir = path.join(tempDir, "fbx");
    fs.mkdirSync(dir, { recursive: true });

    resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/feedbax.git",
      workRepoId: "20-widgets-widgets",
    });

    const audit = auditRegistry(db);
    expect(audit.numbered_repo_ids.length).toBeGreaterThan(0);
    expect(audit.numbered_repo_ids[0].work_repo_id).toBe("20-widgets-widgets");
  });

  it("groups duplicate_display_names case-insensitively (issue 70cf59d)", () => {
    addProject(db, {
      project_key: "humbleb-remote",
      remote_identity: "git@github.com:mll/humbleb.git",
      display_name: "HumbleB",
    });
    addProject(db, {
      project_key: "humbleb-local",
      display_name: "humbleb",
    });

    const audit = auditRegistry(db);
    const dup = audit.duplicate_display_names.find(
      (d) => d.display_name.toLowerCase() === "humbleb",
    );
    expect(dup).toBeDefined();
    expect(dup!.project_keys).toContain("humbleb-remote");
    expect(dup!.project_keys).toContain("humbleb-local");
  });

  it("flags case-/leading-dot-divergent local duplicates as mergeable (issue 70cf59d)", () => {
    // Remote-backed canonical project ".dotfiles"; a local copy stored as
    // "dotfiles" (leading-dot dropped) must consolidate into the remote one.
    addProject(db, {
      project_key: "dotfiles-remote",
      remote_identity: "git@github.com:mll/dotfiles.git",
      display_name: ".dotfiles",
    });
    addProject(db, {
      project_key: "dotfiles-local",
      display_name: "dotfiles",
    });

    const audit = auditRegistry(db);
    const mergeable = audit.mergeable_local_projects.find(
      (m) => m.project_key === "dotfiles-local",
    );
    expect(mergeable).toBeDefined();
    expect(mergeable!.merge_into).toBe("dotfiles-remote");
  });

});

// ---------------------------------------------------------------------------
// 9. buildLedgerIssueDetailProjection — project_key wins over work_repo_id
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. repairRegistry merge — dry run, apply, FK check, conflict
// ---------------------------------------------------------------------------

describe("repairRegistry merge", () => {
  it("dry run returns plan without modifying the db", () => {
    const dirA = path.join(tempDir, "proj-a");
    const dirB = path.join(tempDir, "proj-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const { project: projA } = resolveProjectForCheckout(db, {
      root: dirA,
      remoteUrl: "git@github.com:mll/dry-source.git",
    });
    const { project: projB } = resolveProjectForCheckout(db, {
      root: dirB,
      remoteUrl: "git@github.com:mll/dry-target.git",
    });

    const store = new LedgerStore(db);
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projA.id,
      title: "Issue in A",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projB.id,
      title: "Issue in B",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });

    const issueCountA = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_issues WHERE project_id = ?").get(
        projA.id,
      ) as { n: number }
    ).n;

    // Dry run — no apply
    const report = repairRegistry(db, { merge: { source: projA.id, target: projB.id } });

    expect(report.merge).toBeDefined();
    expect(report.merge!.applied).toBe(false);
    expect(report.merge!.moves.length).toBeGreaterThan(0);
    expect(report.applied).toBe(false);

    // DB unchanged
    const issueCountAAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_issues WHERE project_id = ?").get(
        projA.id,
      ) as { n: number }
    ).n;
    expect(issueCountAAfter).toBe(issueCountA);

    const projARow = db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(projA.id);
    expect(projARow).not.toBeNull();
    expect(projARow).not.toBeUndefined();
  });

  it("apply merges source issues into target and deletes source project", () => {
    const dirC = path.join(tempDir, "proj-c");
    const dirD = path.join(tempDir, "proj-d");
    fs.mkdirSync(dirC, { recursive: true });
    fs.mkdirSync(dirD, { recursive: true });

    const { project: projC } = resolveProjectForCheckout(db, {
      root: dirC,
      remoteUrl: "git@github.com:mll/apply-source.git",
    });
    const { project: projD } = resolveProjectForCheckout(db, {
      root: dirD,
      remoteUrl: "git@github.com:mll/apply-target.git",
    });

    const store = new LedgerStore(db);
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projC.id,
      title: "Issue in C",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projD.id,
      title: "Issue in D",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });

    const report = repairRegistry(db, {
      apply: true,
      merge: { source: projC.id, target: projD.id },
    });

    expect(report.merge!.applied).toBe(true);
    expect(report.foreign_keys).toBe("enforced");

    // Source project deleted
    const projCRow = db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(projC.id);
    expect(projCRow).toBeUndefined();

    // C's issue moved to D
    const issuesInC = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_issues WHERE project_id = ?").get(
        projC.id,
      ) as { n: number }
    ).n;
    expect(issuesInC).toBe(0);

    const issuesInD = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_issues WHERE project_id = ?").get(
        projD.id,
      ) as { n: number }
    ).n;
    expect(issuesInD).toBe(2);

    // External FK check
    db.pragma("foreign_keys = ON");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(0);
  });

  it("throws merge_conflict (code) when short_ids clash, db unchanged", () => {
    const dirE = path.join(tempDir, "proj-e");
    const dirF = path.join(tempDir, "proj-f");
    fs.mkdirSync(dirE, { recursive: true });
    fs.mkdirSync(dirF, { recursive: true });

    const { project: projE } = resolveProjectForCheckout(db, {
      root: dirE,
      remoteUrl: "git@github.com:mll/conflict-source.git",
    });
    const { project: projF } = resolveProjectForCheckout(db, {
      root: dirF,
      remoteUrl: "git@github.com:mll/conflict-target.git",
    });

    const store = new LedgerStore(db);
    const issueE = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projE.id,
      title: "Issue E",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    const issueF = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projF.id,
      title: "Issue F",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });

    // Force the same short_id across the two projects
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE ledger_issues SET short_id = 'clash001' WHERE id = ?").run(issueE.id);
    db.prepare("UPDATE ledger_issues SET short_id = 'clash001' WHERE id = ?").run(issueF.id);
    db.pragma("foreign_keys = ON");

    const projectCountBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_projects").get() as { n: number }
    ).n;

    let caught: unknown;
    try {
      repairRegistry(db, {
        apply: true,
        merge: { source: projE.id, target: projF.id },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ProjectRegistryError);
    expect((caught as ProjectRegistryError).code).toBe("merge_conflict");

    // DB must be unchanged — no projects deleted, no issues moved
    const projectCountAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM ledger_projects").get() as { n: number }
    ).n;
    expect(projectCountAfter).toBe(projectCountBefore);

    const projEStillExists = db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(projE.id);
    expect(projEStillExists).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Codex review fixes (3d85f43)
// ---------------------------------------------------------------------------

describe("merge move-list schema coverage (codex review #1)", () => {

  it("merges a source project WITH commit links cleanly (FK ON DELETE RESTRICT)", () => {
    const dirA = path.join(tempDir, "cl-a");
    const dirB = path.join(tempDir, "cl-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const { project: projA } = resolveProjectForCheckout(db, {
      root: dirA,
      remoteUrl: "git@github.com:mll/cl-source.git",
    });
    const { project: projB } = resolveProjectForCheckout(db, {
      root: dirB,
      remoteUrl: "git@github.com:mll/cl-target.git",
    });
    const store = new LedgerStore(db);
    const issueA = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: projA.id,
      title: "Linked issue",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    db.prepare(
      `INSERT INTO ledger_commit_issue_links (commit_sha, project_id, issue_id, link_type, source, created_at)
       VALUES (?, ?, ?, 'fixed_by', 'auth_queue', ?)`,
    ).run("deadbeef", projA.id, issueA.id, Date.now());

    const report = repairRegistry(db, { apply: true, merge: { source: projA.id, target: projB.id } });

    expect(report.merge!.applied).toBe(true);
    expect(report.foreign_keys).toBe("enforced");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // source project gone, commit link repointed to target
    expect(db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(projA.id)).toBeUndefined();
    const link = db
      .prepare("SELECT project_id FROM ledger_commit_issue_links WHERE commit_sha = ?")
      .get("deadbeef") as { project_id: string };
    expect(link.project_id).toBe(projB.id);
  });

  it("repoints trash custody records while preserving their source checkout", () => {
    const dirA = path.join(tempDir, "trash-a");
    const dirB = path.join(tempDir, "trash-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const { project: projA, checkout: checkoutA } = resolveProjectForCheckout(db, {
      root: dirA,
      remoteUrl: "git@github.com:mll/trash-source.git",
    });
    const { project: projB } = resolveProjectForCheckout(db, {
      root: dirB,
      remoteUrl: "git@github.com:mll/trash-target.git",
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO trash_entries (
         id, project_id, checkout_id, repo_root, branch, reason, actor,
         snapshot_ref, snapshot_oid, original_oid, retention_days,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'manual', 'test', ?, ?, ?, 30, ?, ?)`,
    ).run(
      "trash-project-merge",
      projA.id,
      checkoutA.id,
      dirA,
      "feature/trash",
      "refs/mandible/trash/trash-project-merge",
      "a".repeat(40),
      "b".repeat(40),
      now,
      now + 30 * 24 * 60 * 60 * 1000,
    );

    const report = repairRegistry(db, { apply: true, merge: { source: projA.id, target: projB.id } });

    expect(report.merge!.applied).toBe(true);
    expect(report.foreign_keys).toBe("enforced");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const trash = db
      .prepare("SELECT project_id, checkout_id FROM trash_entries WHERE id = ?")
      .get("trash-project-merge") as { project_id: string; checkout_id: string };
    expect(trash).toEqual({ project_id: projB.id, checkout_id: checkoutA.id });
  });
});
