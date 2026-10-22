import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
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
} from "../src/ledger/project-registry.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { resolveOperationalIssueRef } from "../src/ledger/operational-links.js";
import { LedgerStore } from "../src/ledger/store.js";

let tempDir = "";
let dbPath = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

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

describe("slugifyProjectKey", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugifyProjectKey("20 Feedbax")).toBe("20-feedbax");
    expect(slugifyProjectKey("Hello World")).toBe("hello-world");
    expect(slugifyProjectKey("feedbax")).toBe("feedbax");
  });

  it("strips leading and trailing hyphens/non-alphanum", () => {
    expect(slugifyProjectKey("  spaces  ")).toBe("spaces");
    expect(slugifyProjectKey("!feedbax!")).toBe("feedbax");
  });

  it("handles empty / null / undefined gracefully", () => {
    expect(slugifyProjectKey("")).toBe("");
    expect(slugifyProjectKey(null)).toBe("");
    expect(slugifyProjectKey(undefined)).toBe("");
  });
});

describe("deriveProjectKeyBase", () => {
  it("uses the remote_identity tail when not local", () => {
    expect(deriveProjectKeyBase({ remote_identity: "github.com/mll/feedbax" })).toBe("feedbax");
  });

  it("ignores local: remote_identity, falls through to display_name", () => {
    expect(
      deriveProjectKeyBase({ remote_identity: "local:/some/path", display_name: "Feedbax" }),
    ).toBe("feedbax");
  });

  it("uses display_name when no usable remote", () => {
    expect(deriveProjectKeyBase({ display_name: "Feedbax" })).toBe("feedbax");
  });

  it("falls to root basename when neither remote nor display is available", () => {
    expect(deriveProjectKeyBase({ root: "/x/20 Feedbax" })).toBe("20-feedbax");
  });

  it("ignores file: identity the same as local:", () => {
    const result = deriveProjectKeyBase({
      remote_identity: "file:/repo/path",
      display_name: "myproj",
    });
    expect(result).toBe("myproj");
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

describe("updateProject", () => {
  it("changes display_name and project_key", () => {
    addProject(db, {
      project_key: "feedbax",
      remote_identity: "git@github.com:mll/feedbax.git",
      display_name: "Feedbax",
    });

    const updated = updateProject(db, "feedbax", {
      display_name: "Feedbax Updated",
      project_key: "feedbax-v2",
    });
    expect(updated.display_name).toBe("Feedbax Updated");
    expect(updated.project_key).toBe("feedbax-v2");
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

  it("canonicalizes the same scanner id through discovery registration", () => {
    const root = path.join(tempDir, "20 Widgets", "widgets");
    fs.mkdirSync(root, { recursive: true });

    const { checkout } = resolveProjectForCheckout(db, {
      root,
      remoteUrl: "git@github.com:mll/widgets.git",
      workRepoId: "20-widgets-widgets",
    });
    expect(checkout.work_repo_id).toBe("widgets");
  });

  it("preserves a deliberate non-numbered checkout disambiguator", () => {
    addProject(db, {
      project_key: "widgets",
      remote_identity: "git@github.com:mll/widgets.git",
    });
    const root = path.join(tempDir, "dev", "widgets");
    fs.mkdirSync(root, { recursive: true });

    const { checkout } = addOrUpdateCheckout(db, "widgets", {
      root,
      work_repo_id: "dev-widgets",
    });
    expect(checkout.work_repo_id).toBe("dev-widgets");
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

  it("falls back to all keys when no fuzzy match", () => {
    addProject(db, {
      project_key: "mandible",
      remote_identity: "git@github.com:mll/mandible.git",
    });

    // No fuzzy match — directory fallback lists all keys
    const suggestions = suggestProjectRefs(db, "xyzzy");
    expect(suggestions).toContain("mandible");
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

  it("detects duplicate_display_names", () => {
    addProject(db, {
      project_key: "aa",
      remote_identity: "git@github.com:mll/aa.git",
      display_name: "Shared",
    });
    addProject(db, {
      project_key: "bb",
      remote_identity: "git@github.com:mll/bb.git",
      display_name: "Shared",
    });

    const audit = auditRegistry(db);
    const dup = audit.duplicate_display_names.find((d) => d.display_name === "Shared");
    expect(dup).toBeDefined();
    expect(dup!.project_keys).toContain("aa");
    expect(dup!.project_keys).toContain("bb");
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

  it("detects local_projects (no remote → namespace_policy=local)", () => {
    const dir = path.join(tempDir, "localrepo");
    fs.mkdirSync(dir, { recursive: true });

    // No remoteUrl → readOriginRemote returns "" → identity = local:<root>
    resolveProjectForCheckout(db, { root: dir, remoteUrl: "" });

    const audit = auditRegistry(db);
    expect(audit.local_projects.length).toBeGreaterThan(0);
  });

  it("detects missing_keys (project_key blanked via SQL)", () => {
    const dir = path.join(tempDir, "mkrepo");
    fs.mkdirSync(dir, { recursive: true });

    const { project } = resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/mkrepo.git",
    });
    db.prepare("UPDATE ledger_projects SET project_key = '' WHERE id = ?").run(project.id);

    const audit = auditRegistry(db);
    expect(audit.missing_keys.length).toBeGreaterThan(0);
    expect(audit.missing_keys.some((r) => r.id === project.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. buildLedgerIssueDetailProjection — project_key wins over work_repo_id
// ---------------------------------------------------------------------------

describe("buildLedgerIssueDetailProjection project fields", () => {
  it("uses project_key for repo_id and preserves work_repo_id separately", () => {
    const dir = path.join(tempDir, "fbx-repo");
    fs.mkdirSync(dir, { recursive: true });

    const { project } = resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/feedbax.git",
      workRepoId: "20-widgets-widgets",
    });

    // The project_key should be "feedbax" (tail of remote identity)
    const projects = listProjects(db);
    const reg = projects.find((p) => p.id === project.id)!;
    expect(reg.project_key).toBe("feedbax");

    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Test issue",
      body: "Test body",
      actor_type: "agent",
      author_display: "Test",
    });

    const projection = buildLedgerIssueDetailProjection(db, issue.id);
    expect(projection.project.project_key).toBe("feedbax");
    // repo_id uses project_key, not the path-derived WorkScanner id
    expect(projection.project.repo_id).toBe("feedbax");
    // work_repo_id preserves the raw WorkScanner id
    expect(projection.project.work_repo_id).toBe("20-widgets-widgets");
  });
});

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
    expect(report.merge!.foreign_key_violations).toBe(0);

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

  it("explicitly covers the FK and non-FK tables the review flagged", () => {
    const moveSet = new Set<string>();
    for (const { table, columns } of PROJECT_ID_COLUMNS) {
      for (const column of columns) moveSet.add(`${table}.${column}`);
    }
    expect(moveSet.has("ledger_commit_issue_links.project_id")).toBe(true);
    expect(moveSet.has("ledger_reconciliation_mismatches.project_id")).toBe(true);
    expect(moveSet.has("trash_entries.project_id")).toBe(true);
    expect(moveSet.has("auth_request_merge_succeeded_facts.project_id")).toBe(true);
    expect(moveSet.has("managed_tasks.project_id")).toBe(true);
    expect(moveSet.has("managed_task_events.project_id")).toBe(true);
  });

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
    expect(report.merge!.foreign_key_violations).toBe(0);
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
    expect(report.merge!.foreign_key_violations).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const trash = db
      .prepare("SELECT project_id, checkout_id FROM trash_entries WHERE id = ?")
      .get("trash-project-merge") as { project_id: string; checkout_id: string };
    expect(trash).toEqual({ project_id: projB.id, checkout_id: checkoutA.id });
  });
});

describe("deriveProjectKeyBase generic fallback (codex review #5)", () => {
  it("qualifies a generic basename with the parent directory", () => {
    expect(deriveProjectKeyBase({ root: "/x/myproj/repo" })).toBe("myproj-repo");
    expect(deriveProjectKeyBase({ root: "/home/work/code" })).toBe("work-code");
  });

  it("does not return a bare generic key when a distinctive basename exists", () => {
    expect(deriveProjectKeyBase({ root: "/x/feedbax" })).toBe("feedbax");
  });

  it("falls back to a generic sentinel only when nothing is distinctive", () => {
    expect(deriveProjectKeyBase({ root: "/repo" })).toBe("project");
  });
});

describe("addOrUpdateCheckout blank-root rejection (codex review #6)", () => {
  it("rejects an empty or whitespace-only root before path.resolve", () => {
    const { project } = resolveProjectForCheckout(db, {
      root: path.join(tempDir, "blank-root-proj"),
      remoteUrl: "git@github.com:mll/blankroot.git",
    });
    for (const bad of ["", "   ", "\t"]) {
      let caught: unknown;
      try {
        addOrUpdateCheckout(db, project.id, { root: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProjectRegistryError);
      expect((caught as ProjectRegistryError).code).toBe("missing_root");
    }
    // No checkout was registered at the daemon cwd as a side effect.
    const cwdCheckout = db
      .prepare("SELECT 1 FROM ledger_project_checkouts WHERE root = ?")
      .get(path.resolve(""));
    expect(cwdCheckout).toBeUndefined();
  });
});

describe("operational + relationship resolution by project_key (codex review #2)", () => {
  it("resolveOperationalIssueRef scopes by project_key, case-insensitively", () => {
    const dirF = path.join(tempDir, "op-feedbax");
    const dirO = path.join(tempDir, "op-other");
    fs.mkdirSync(dirF, { recursive: true });
    fs.mkdirSync(dirO, { recursive: true });
    const { project: feedbax } = resolveProjectForCheckout(db, {
      root: dirF,
      remoteUrl: "git@github.com:mll/feedbax.git",
    });
    const { project: other } = resolveProjectForCheckout(db, {
      root: dirO,
      remoteUrl: "git@github.com:mll/other.git",
    });
    expect(resolveProjectRef(db, "feedbax")).toMatchObject({ ok: true, project: { id: feedbax.id } });

    const store = new LedgerStore(db);
    const inF = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: feedbax.id,
      title: "F issue",
      body: "b",
      actor_type: "agent",
      author_display: "T",
    });
    const inO = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: other.id,
      title: "O issue",
      body: "b",
      actor_type: "agent",
      author_display: "T",
    });
    // Force a short-id collision across the two projects so only the project_key
    // scope disambiguates.
    db.prepare("UPDATE ledger_issues SET short_id = 'shared99' WHERE id IN (?, ?)").run(inF.id, inO.id);

    // Unscoped: ambiguous across both projects.
    const unscoped = resolveOperationalIssueRef(db, "shared99");
    expect(unscoped.ok).toBe(false);

    // Scoped by canonical key (and a cased variant) resolves to the feedbax issue.
    const byKey = resolveOperationalIssueRef(db, "shared99", "feedbax");
    expect(byKey.ok).toBe(true);
    expect(byKey.ok && byKey.issue_id).toBe(inF.id);
    const byCasedKey = resolveOperationalIssueRef(db, "shared99", "Feedbax");
    expect(byCasedKey.ok).toBe(true);
    expect(byCasedKey.ok && byCasedKey.issue_id).toBe(inF.id);
  });

  it("store.resolveProjectId resolves a cross-project text ref by project_key (case-insensitive)", () => {
    const dirT = path.join(tempDir, "rel-target");
    const dirS = path.join(tempDir, "rel-source");
    fs.mkdirSync(dirT, { recursive: true });
    fs.mkdirSync(dirS, { recursive: true });
    const { project: target } = resolveProjectForCheckout(db, {
      root: dirT,
      remoteUrl: "git@github.com:mll/feedbax.git",
    });
    const { project: sourceProject } = resolveProjectForCheckout(db, {
      root: dirS,
      remoteUrl: "git@github.com:mll/consumer.git",
    });
    const store = new LedgerStore(db);
    const targetIssue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: target.id,
      title: "Target",
      body: "b",
      actor_type: "agent",
      author_display: "T",
    });
    const sourceIssue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: sourceProject.id,
      title: "Source",
      body: "b",
      actor_type: "agent",
      author_display: "T",
    });
    // Cross-project ref by the canonical project_key (cased) -> resolveProjectId.
    store.reconcileTextIssueReferences({
      actor: SYSTEM_ACTOR,
      source_issue_id: sourceIssue.id,
      source_entity_type: "issue_body",
      source_entity_id: sourceIssue.id,
      body: `See [issue:Feedbax/${targetIssue.short_id}]`,
    });
    const detail = store.getIssueDetail(sourceIssue.id);
    const targets = detail.outgoing_relationships.map((rel) => rel.target_issue_id);
    expect(targets).toContain(targetIssue.id);
  });
});

describe("merge move-list schema coverage", () => {
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
