import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import {
  addOrUpdateCheckout,
  addProject,
  auditRegistry,
  backfillProjectKeys,
  deriveProjectKeyBase,
  listProjects,
  ProjectRegistryError,
  repairRegistry,
  resolveCheckoutPath,
  resolveProjectRef,
  slugifyProjectKey,
  suggestProjectRefs,
  updateProject,
} from "../src/ledger/project-registry.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

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
// 3. resolveProjectRef — precedence chain
// ---------------------------------------------------------------------------

describe("resolveProjectRef", () => {
  it("resolves by id, project_key, work_repo_id, root, and remote_identity", () => {
    const dir = path.join(tempDir, "mandible");
    fs.mkdirSync(dir, { recursive: true });

    const { project } = resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/mandible.git",
      workRepoId: "20-mandible",
    });

    // By ledger ID
    const byId = resolveProjectRef(db, project.id);
    expect(byId.ok).toBe(true);
    expect(byId.matched_by).toBe("id");

    // By project_key (derived from "mandible")
    const byKey = resolveProjectRef(db, "mandible");
    expect(byKey.ok).toBe(true);
    expect(byKey.matched_by).toBe("project_key");

    // By work_repo_id
    const byWorkRepo = resolveProjectRef(db, "20-mandible");
    expect(byWorkRepo.ok).toBe(true);
    expect(byWorkRepo.matched_by).toBe("work_repo_id");

    // By checkout root (absolute path)
    const byRoot = resolveProjectRef(db, dir);
    expect(byRoot.ok).toBe(true);
    expect(byRoot.matched_by).toBe("root");

    // By remote url (scp form → github.com/mll/mandible)
    const byRemote = resolveProjectRef(db, "git@github.com:mll/mandible.git");
    expect(byRemote.ok).toBe(true);
    expect(byRemote.matched_by).toBe("remote_identity");

    // Unknown
    const unknown = resolveProjectRef(db, "totally-unknown-ref-xyz");
    expect(unknown.ok).toBe(false);
    expect(unknown.project).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Ambiguous display_name
  // ---------------------------------------------------------------------------

  it("returns ambiguous when display_name matches multiple projects", () => {
    addProject(db, {
      project_key: "proj-alpha",
      remote_identity: "git@github.com:mll/proj-alpha.git",
      display_name: "Shared Name",
    });
    addProject(db, {
      project_key: "proj-beta",
      remote_identity: "git@github.com:mll/proj-beta.git",
      display_name: "Shared Name",
    });

    const result = resolveProjectRef(db, "Shared Name");
    expect(result.ok).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toContain("proj-alpha");
    expect(result.candidates).toContain("proj-beta");
  });
});

// ---------------------------------------------------------------------------
// 5. resolveCheckoutPath — registered vs unregistered path
// ---------------------------------------------------------------------------

describe("resolveCheckoutPath", () => {
  it("returns project for a registered checkout root, null for unknown", () => {
    const dir = path.join(tempDir, "myrepo");
    fs.mkdirSync(dir, { recursive: true });

    resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/myrepo.git",
    });

    const found = resolveCheckoutPath(db, dir);
    expect(found).not.toBeNull();
    expect(found?.project_key).toBe("myrepo");

    const notFound = resolveCheckoutPath(db, "/random/unregistered/path/xyz");
    expect(notFound).toBeNull();
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
      workRepoId: "20-feedbax-feedbax",
    });

    const audit = auditRegistry(db);
    expect(audit.numbered_repo_ids.length).toBeGreaterThan(0);
    expect(audit.numbered_repo_ids[0].work_repo_id).toBe("20-feedbax-feedbax");
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
      workRepoId: "20-feedbax-feedbax",
    });

    // The project_key should be "feedbax" (tail of remote identity)
    const projects = listProjects(db);
    const reg = projects.find((p) => p.id === project.id)!;
    expect(reg.project_key).toBe("feedbax");

    const store = new LedgerStore(db);
    const issue = store.createIssue({
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
    expect(projection.project.work_repo_id).toBe("20-feedbax-feedbax");
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
      project_id: projA.id,
      title: "Issue in A",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    store.createIssue({
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
      project_id: projC.id,
      title: "Issue in C",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    store.createIssue({
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
      project_id: projE.id,
      title: "Issue E",
      body: "body",
      actor_type: "agent",
      author_display: "Test",
    });
    const issueF = store.createIssue({
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
