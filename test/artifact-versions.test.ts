import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../src/db.js";
import {
  appendArtifactVersion,
  getArtifact,
  getArtifactSeries,
  getArtifactVersion,
  associateProjectArtifact,
  listProjectArtifactAssociations,
  listArtifactVersions,
  recordArtifactVersion,
  registerLocalArtifactPath,
  projectArtifactPublicValue,
  resolveAndLinkArtifact,
  resolveArtifactRef,
  resolveArtifactVersionHistory,
} from "../src/provider-artifacts.js";
import { diffArtifacts, getArtifactContent, readArtifactBytesFull } from "../src/artifact-content.js";
import { METADATA_BACKUP_TABLES, buildMetadataBackupSql } from "../src/ledger/backup.js";

let tempDir = "";
let db: Db;
let savedEnv: Record<string, string | undefined>;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createLedgerCheckout(repoId: string, root: string): void {
  const projectId = `prj_${repoId}`;
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (
      id, display_name, created_at, updated_at
    ) VALUES (?, ?, 1, 1)`,
  ).run(projectId, repoId);
  db.prepare(
    `INSERT OR REPLACE INTO ledger_project_checkouts (
      id, project_id, work_repo_id, root, name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(`checkout_${repoId}`, projectId, repoId, root, repoId);
}

function createLedgerIssue(issueId: string, projectName = "mandible"): string {
  const projectId = `prj_${projectName}`;
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)`,
  ).run(projectId, projectName);
  db.prepare(
    `INSERT INTO ledger_issues (
      id, short_id, project_id, title, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'open', 1, 1)`,
  ).run(issueId, issueId.slice(0, 7), projectId, `Issue ${issueId}`);
  return issueId;
}

function makeTrackedRepo(name: string, content: string): { root: string; filePath: string } {
  const root = path.join(tempDir, name);
  const filePath = path.join(root, "results", "report.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(filePath, content, "utf8");
  git(root, ["add", "results/report.md"]);
  git(root, ["commit", "-m", "v1"]);
  return { root, filePath };
}

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-versions-"));
  process.env.HOME = path.join(tempDir, "home");
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  delete process.env.MANDIBLE_HOME;
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("artifact versioning schema (migration v88)", () => {
  it("creates the artifact_series and artifact_versions tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('artifact_series','artifact_versions')")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(tables).toEqual(["artifact_series", "artifact_versions"]);
  });

  it("keeps artifacts immutability (UNIQUE(algorithm, content_hash)) intact", () => {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifacts'").get() as { sql: string }).sql;
    expect(sql).toContain("UNIQUE(algorithm, content_hash)");
  });

  it("enforces UNIQUE(series_key) on artifact_series", () => {
    db.prepare(
      `INSERT INTO artifact_series (id, series_key, source_kind, version_count, created_at, updated_at)
       VALUES ('s1', 'local:/a', 'local_only', 0, 1, 1)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO artifact_series (id, series_key, source_kind, version_count, created_at, updated_at)
         VALUES ('s2', 'local:/a', 'local_only', 0, 1, 1)`,
      ).run(),
    ).toThrow(/UNIQUE/i);
  });
});

describe("tracked_repo versions", () => {
  it("records commit A and commit B of one tracked path as one series, two versions", () => {
    const { root, filePath } = makeTrackedRepo("tracked-repo", "# v1\n");
    createLedgerCheckout("mandible", fs.realpathSync(root));
    const commitA = git(root, ["rev-parse", "HEAD"]);

    const r1 = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath, role: "report" }, 1000);
    expect(r1.created).toBe(true);
    expect(r1.version.version_no).toBe(1);
    expect(r1.version.commit_sha).toBe(commitA);
    expect(r1.version.repo_path).toBe("results/report.md");

    // Re-recording the same commit/path is idempotent.
    const r1again = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath, role: "report" }, 1001);
    expect(r1again.created).toBe(false);
    expect(r1again.version.id).toBe(r1.version.id);

    fs.writeFileSync(filePath, "# v2\n", "utf8");
    git(root, ["add", "results/report.md"]);
    git(root, ["commit", "-m", "v2"]);
    const commitB = git(root, ["rev-parse", "HEAD"]);

    const r2 = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath, role: "report" }, 2000);
    expect(r2.created).toBe(true);
    expect(r2.series.id).toBe(r1.series.id);
    expect(r2.version.version_no).toBe(2);
    expect(r2.version.commit_sha).toBe(commitB);

    const versions = listArtifactVersions(db, r1.series.id);
    expect(versions).toHaveLength(2);
    expect(getArtifactSeries(db, r1.series.id)?.version_count).toBe(2);
    expect(versions[0].artifact_id).not.toBe(versions[1].artifact_id);
  });
});

describe("local_only observations", () => {
  it("only writes history on explicit record; preview/check/resolve do not", () => {
    const filePath = path.join(tempDir, "notes.txt");
    fs.writeFileSync(filePath, "alpha\n", "utf8");

    const r1 = recordArtifactVersion(db, { source_kind: "local_only", path: filePath, media_type: "text/plain", logical_name: "notes" }, 1000);
    expect(r1.created).toBe(true);
    const seriesId = r1.series.id;
    expect(getArtifactSeries(db, seriesId)?.version_count).toBe(1);

    // Ordinary reads must NOT write history.
    getArtifactContent(db, r1.artifact.id);
    resolveArtifactRef(db, r1.artifact.id);
    fs.writeFileSync(filePath, "alpha\nbeta\n", "utf8"); // mutate, but no record yet
    getArtifactContent(db, r1.artifact.id);
    expect(getArtifactSeries(db, seriesId)?.version_count).toBe(1);

    // Explicit record after a real change appends a version.
    const r2 = recordArtifactVersion(db, { source_kind: "local_only", path: filePath, media_type: "text/plain", logical_name: "notes" }, 2000);
    expect(r2.created).toBe(true);
    expect(r2.series.id).toBe(seriesId);
    expect(getArtifactSeries(db, seriesId)?.version_count).toBe(2);

    // Recording the unchanged file again is a no-op observation.
    const r2again = recordArtifactVersion(db, { source_kind: "local_only", path: filePath, media_type: "text/plain", logical_name: "notes" }, 2001);
    expect(r2again.created).toBe(false);
    expect(getArtifactSeries(db, seriesId)?.version_count).toBe(2);
  });
});

describe("managed custody versions", () => {
  it("stores v1 and v2 as independently materializable full snapshots", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "m1\n", media_type: "text/plain", logical_name: "doc" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "m2\n", media_type: "text/plain", logical_name: "doc" }, 2000);
    expect(r1.series.id).toBe(r2.series.id);
    expect(getArtifactSeries(db, r1.series.id)?.version_count).toBe(2);

    const c1 = getArtifactContent(db, r1.version.artifact_id);
    const c2 = getArtifactContent(db, r2.version.artifact_id);
    expect(c1?.status).toBe("available");
    expect(c2?.status).toBe("available");
    expect(c1?.preview?.text).toBe("m1\n");
    expect(c2?.preview?.text).toBe("m2\n");
  });
});

describe("diff derivation", () => {
  it("derives a text unified diff from two versions' full snapshot bytes", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "line1\nline2\nline3\n", media_type: "text/plain", logical_name: "doc" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "line1\nline2-changed\nline3\n", media_type: "text/plain", logical_name: "doc" }, 2000);

    const diff = diffArtifacts(db, r1.version.id, r2.version.id);
    expect(diff.diffable).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.kind).toBe("text");
    expect(diff.unified).toContain("-line2");
    expect(diff.unified).toContain("+line2-changed");
    expect(diff.stats).toEqual({ added: 1, removed: 1 });
  });

  it("normalizes JSON before diffing and reports identical content", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: '{"a":1,"b":2}', media_type: "application/json", logical_name: "cfg" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: '{"a":1,"b":3}', media_type: "application/json", logical_name: "cfg" }, 2000);
    const diff = diffArtifacts(db, r1.version.id, r2.version.id);
    expect(diff.kind).toBe("json");
    expect(diff.diffable).toBe(true);
    expect(diff.unified).toContain('"b": 2');
    expect(diff.unified).toContain('"b": 3');

    const same = diffArtifacts(db, r1.version.id, r1.version.id);
    expect(same.identical).toBe(true);
    expect(same.stats).toEqual({ added: 0, removed: 0 });
  });
});

describe("canonical ref resolution and no silent retarget", () => {
  it("resolves new canonical logical/version/blob refs and rejects legacy hash refs", () => {
    const r1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      content: "A\n",
      media_type: "text/plain",
      logical_name: "ev",
    }, 1000);
    const logicalRef = `artifact:${r1.series.id.replace(/^artifact-series:/, "")}`;
    const blobRef = `artifact-blob:${r1.artifact.content_hash}`;

    const logical = resolveArtifactRef(db, logicalRef);
    expect(logical.status).toBe("resolved");
    expect(logical.target_type).toBe("artifact");
    expect(logical.logical_artifact?.id).toBe(logicalRef);
    expect(logical.artifact_version?.id).toBe(r1.version.id);
    expect(logical.artifact_blob?.id).toBe(blobRef);
    expect(logical.artifact?.id).toBe(r1.artifact.id);

    const version = resolveArtifactRef(db, r1.version.id);
    expect(version.status).toBe("resolved");
    expect(version.target_type).toBe("artifact_version");
    expect(version.target_id).toBe(r1.version.id);
    expect(version.artifact_version?.blob_id).toBe(blobRef);
    expect(version.version?.id).toBe(r1.version.id);

    const blob = resolveArtifactRef(db, blobRef.slice(0, "artifact-blob:".length + 12));
    expect(blob.status).toBe("resolved");
    expect(blob.target_type).toBe("artifact_blob");
    expect(blob.target_id).toBe(blobRef);

    for (const oldRef of [`artifact:sha256:${r1.artifact.content_hash}`, `sha256:${r1.artifact.content_hash}`, r1.artifact.content_hash]) {
      const legacy = resolveArtifactRef(db, oldRef);
      expect(legacy.status).toBe("unsupported");
      expect(legacy.artifact).toBeNull();
      expect(legacy.target_id).toBeNull();
      expect(legacy.warnings).toEqual(["legacy_artifact_ref_unsupported", "repair_to_artifact_blob_ref"]);
    }
  });

  it("records explicit project associations without inferring them from source repo", () => {
    createLedgerCheckout("mandible", tempDir);
    const r1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      content: "A\n",
      media_type: "text/plain",
      logical_name: "ev",
    }, 1000);
    const logicalRef = `artifact:${r1.series.id.replace(/^artifact-series:/, "")}`;

    expect(listProjectArtifactAssociations(db, { projectRef: "mandible" })).toEqual([]);

    const result = associateProjectArtifact(db, {
      project_ref: "mandible",
      target_ref: logicalRef,
      association_kind: "canonical",
      role: "context",
      title: "Evidence context",
    }, 1100);
    expect(result.association).toMatchObject({
      project_id: "prj_mandible",
      target_type: "artifact",
      target_id: logicalRef,
      association_kind: "canonical",
      role: "context",
      title: "Evidence context",
    });
    expect(listProjectArtifactAssociations(db, { projectRef: "mandible", associationKind: "canonical" }))
      .toHaveLength(1);
    associateProjectArtifact(db, {
      project_ref: "mandible",
      target_ref: logicalRef,
      association_kind: "associated",
      role: "context",
    }, 1200);
    expect(listProjectArtifactAssociations(db, { projectRef: "mandible" })[0]).toMatchObject({
      target_id: logicalRef,
      association_kind: "canonical",
      role: "context",
    });
    expect(() =>
      associateProjectArtifact(db, {
        project_ref: "mandible",
        target_ref: `artifact-blob:${r1.artifact.content_hash}`,
      }),
    ).toThrow(/not blobs/);
  });

  it("resolves artifact:<hex> as the canonical compact immutable ref", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "A\n", media_type: "text/plain", logical_name: "ev" }, 1000);
    const compactId = `artifact:${r1.artifact.content_hash.slice(0, 12)}`;
    const resolved = resolveArtifactRef(db, `artifact:${r1.artifact.content_hash}`);
    expect(resolved.status).toBe("resolved");
    expect(resolved.target_type).toBe("artifact_blob");
    expect(resolved.target_id).toBe(`artifact-blob:${r1.artifact.content_hash}`);
    expect(resolved.artifact?.id).toBe(r1.artifact.id);
    expect(resolved.warnings).toEqual([]);
    expect((projectArtifactPublicValue(db, resolved) as typeof resolved).artifact?.id).toBe(compactId);

    const blob = resolveArtifactRef(db, `artifact-blob:${r1.artifact.content_hash}`);
    expect(blob.status).toBe("resolved");
    expect(blob.target_type).toBe("artifact_blob");
    expect(blob.artifact?.id).toBe(r1.artifact.id);
    expect((projectArtifactPublicValue(db, blob) as typeof blob).artifact?.id).toBe(compactId);

    const versionResolved = resolveArtifactRef(db, r1.version.id);
    expect(versionResolved.artifact?.id).toBe(r1.artifact.id);
    expect((projectArtifactPublicValue(db, versionResolved) as typeof versionResolved).artifact?.id).toBe(compactId);
    expect(versionResolved.version?.id).toBe(r1.version.id);
    expect(versionResolved.warnings ?? []).toEqual([]);
  });

  it("does not silently retarget an existing issue link when a newer version is recorded", () => {
    const issueId = createLedgerIssue("f7a994e");
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "evidence v1\n", media_type: "text/plain", logical_name: "ev" }, 1000);
    const artifactA = r1.artifact.id;

    const linked = resolveAndLinkArtifact(db, {
      ref: r1.version.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "evidence",
    }, 1100);
    expect(linked.link?.artifact_id).toBe(artifactA);

    // Record a newer version into the SAME series.
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "evidence v2\n", media_type: "text/plain", logical_name: "ev" }, 2000);
    expect(r2.series.id).toBe(r1.series.id);
    const artifactB = r2.artifact.id;
    expect(artifactB).not.toBe(artifactA);

    // The existing issue link still points at the pinned immutable artifact A.
    const linkRows = db
      .prepare("SELECT artifact_id, target_type, target_id FROM artifact_links WHERE entity_type = 'issue' AND entity_id = ?")
      .all(issueId) as Array<{ artifact_id: string | null; target_type: string; target_id: string }>;
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]).toEqual({ artifact_id: null, target_type: "artifact_version", target_id: r1.version.id });

    // Logical artifact resolution floats to B. The compatibility series ref
    // reaches the same latest version without changing the existing pin.
    const logicalRef = `artifact:${r1.series.id.replace(/^artifact-series:/, "")}`;
    const latest = resolveArtifactRef(db, logicalRef);
    expect(latest.artifact?.id).toBe(artifactB);
    expect(latest.target_type).toBe("artifact");

    const oldSeries = resolveArtifactRef(db, r1.series.id);
    expect(oldSeries.status).toBe("resolved");
    expect(oldSeries.artifact?.id).toBe(artifactB);
    expect(oldSeries.target_type).toBe("artifact_version");
    expect(oldSeries.warnings).toEqual(["series_latest_not_pinned"]);

    // A pinned version ref resolves to B with no warning.
    const pinned2 = resolveArtifactRef(db, r2.version.id);
    expect(pinned2.artifact?.id).toBe(artifactB);
    expect(pinned2.warnings ?? []).toEqual([]);
  });
});

describe("version history query", () => {
  it("resolves history from a logical artifact ref, version id, or blob ref", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "h1\n", media_type: "text/plain", logical_name: "hist" }, 1000);
    recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "h2\n", media_type: "text/plain", logical_name: "hist" }, 2000);

    const logicalRef = `artifact:${r1.series.id.replace(/^artifact-series:/, "")}`;
    const byLogical = resolveArtifactVersionHistory(db, logicalRef);
    expect(byLogical?.versions).toHaveLength(2);
    const byVersion = resolveArtifactVersionHistory(db, r1.version.id);
    expect(byVersion?.series.id).toBe(r1.series.id);
    const byArtifact = resolveArtifactVersionHistory(db, `artifact-blob:${r1.artifact.content_hash}`);
    expect(byArtifact?.series.id).toBe(r1.series.id);
    expect(resolveArtifactVersionHistory(db, r1.series.id)?.series.id).toBe(r1.series.id);
  });
});

describe("backup/export coverage", () => {
  it("lists the new tables in METADATA_BACKUP_TABLES after artifacts/links", () => {
    expect(METADATA_BACKUP_TABLES).toContain("artifact_series");
    expect(METADATA_BACKUP_TABLES).toContain("artifact_versions");
    const idxArtifacts = METADATA_BACKUP_TABLES.indexOf("artifacts");
    const idxSeries = METADATA_BACKUP_TABLES.indexOf("artifact_series");
    const idxVersions = METADATA_BACKUP_TABLES.indexOf("artifact_versions");
    expect(idxSeries).toBeGreaterThan(idxArtifacts);
    expect(idxVersions).toBeGreaterThan(idxSeries);
  });

  it("round-trips canonical artifact and artifact_version rows through backup/restore", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "b1\n", media_type: "text/plain", logical_name: "bk" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "b2\n", media_type: "text/plain", logical_name: "bk" }, 2000);
    const sql = buildMetadataBackupSql(db);
    expect(sql).toContain("-- Table: artifact");
    expect(sql).toContain("-- Table: artifact_version");

    const restored = new Database(path.join(tempDir, "restored.db"));
    restored.pragma("foreign_keys = ON");
    restored.exec(sql);

    const series = restored.prepare("SELECT * FROM artifact").all() as Array<{ id: string; identity_key: string; version_count: number }>;
    expect(series).toHaveLength(1);
    expect(series[0].identity_key).toBe("managed:test:bk");
    expect(series[0].version_count).toBe(2);
    const versions = restored
      .prepare("SELECT id, version_no, content_hash FROM artifact_version ORDER BY version_no")
      .all() as Array<{ id: string; version_no: number; content_hash: string }>;
    expect(versions.map((v) => v.version_no)).toEqual([1, 2]);
    expect(versions[0].id).toBe(r1.version.id);
    expect(versions[1].id).toBe(r2.version.id);

    // UNIQUE(identity_key) survives the round-trip.
    expect(() =>
      restored.prepare(
        `INSERT INTO artifact (id, identity_key, source_kind, version_count, created_at, updated_at)
         VALUES ('dup', 'managed:test:bk', 'managed', 0, 1, 1)`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    restored.close();
  });
});

describe("appendArtifactVersion mixed source kinds", () => {
  it("marks a series mixed when versions span source kinds", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "x\n", media_type: "text/plain", logical_name: "mix", series_key: "shared:mix" }, 1000);
    expect(getArtifactSeries(db, r1.series.id)?.source_kind).toBe("managed");
    // Append a local_only-kind version under the same series id directly.
    const art = getArtifact(db, r1.artifact.id)!;
    const appended = appendArtifactVersion(db, {
      series_id: r1.series.id,
      artifact_id: art.id,
      source_kind: "local_only",
      content_hash: art.content_hash,
      natural_key: "distinct-observation",
      observed_path: "/tmp/whatever",
    }, 2000);
    expect(appended.created).toBe(true);
    expect(getArtifactSeries(db, r1.series.id)?.source_kind).toBe("mixed");
    expect(getArtifactVersion(db, appended.version.id)?.source_kind).toBe("local_only");
  });
});

describe("codex review fixes", () => {
  it("HIGH-1: dirty tracked files become content-hash CAS snapshots, not commit-collapsed", () => {
    const { root, filePath } = makeTrackedRepo("dirty-repo", "clean-v1\n");
    createLedgerCheckout("mandible", fs.realpathSync(root));

    // Clean commit → commit-pinned tracked_repo version.
    const v1 = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath }, 1000);
    expect(v1.version.source_kind).toBe("tracked_repo");
    expect(v1.warnings).not.toContain("tracked_repo_dirty_recorded_as_local_only");

    // Dirty (uncommitted) bytes A → CAS snapshot, NOT commit-pinned.
    fs.writeFileSync(filePath, "dirty-A\n", "utf8");
    const v2 = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath }, 2000);
    expect(v2.version.source_kind).toBe("local_only");
    expect(v2.warnings).toContain("tracked_repo_dirty_recorded_as_local_only");
    expect(v2.version.commit_sha).toBeNull();

    // Dirty bytes B (different) must NOT collapse into v2 (content-hash keyed).
    fs.writeFileSync(filePath, "dirty-B\n", "utf8");
    const v3 = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath }, 3000);
    expect(v3.created).toBe(true);
    expect(v3.version.artifact_id).not.toBe(v2.version.artifact_id);
    expect(getArtifactSeries(db, v1.series.id)?.version_count).toBe(3);
    expect(getArtifactSeries(db, v1.series.id)?.source_kind).toBe("mixed");

    // Re-recording the SAME dirty-B bytes is idempotent.
    const v3again = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath }, 3100);
    expect(v3again.created).toBe(false);
    expect(getArtifactSeries(db, v1.series.id)?.version_count).toBe(3);

    // Materialization reads the recorded dirty bytes, never HEAD's committed bytes.
    expect(getArtifactContent(db, v2.version.artifact_id)?.preview?.text).toBe("dirty-A\n");
    expect(getArtifactContent(db, v3.version.artifact_id)?.preview?.text).toBe("dirty-B\n");

    // Diff between the two dirty versions shows the recorded bytes.
    const diff = diffArtifacts(db, v2.version.id, v3.version.id);
    expect(diff.diffable).toBe(true);
    expect(diff.unified).toContain("-dirty-A");
    expect(diff.unified).toContain("+dirty-B");
  });

  it("HIGH-2: managed ref records a durable CAS snapshot that survives source deletion", () => {
    const src = path.join(tempDir, "mutable-src.txt");
    fs.writeFileSync(src, "managed-src\n", "utf8");
    // A link-custody (mutable) local artifact.
    const link = registerLocalArtifactPath(db, { path: src, custody_mode: "link", allow_local_only: true }, 1000);
    expect(link.artifact.custody_mode).toBe("link");

    const rec = recordArtifactVersion(db, {
      source_kind: "managed",
      ref: `artifact-blob:${link.artifact.content_hash}`,
      logical_name: "src",
      provider_id: "test",
      media_type: "text/plain",
    }, 2000);
    // The version records managed intent; the bytes are durably snapshotted.
    expect(rec.version.custody_mode).toBe("managed");

    // Delete the source; the managed CAS snapshot still materializes (the link
    // path is gone, but the hash-addressed CAS copy remains).
    fs.rmSync(src);
    const content = getArtifactContent(db, rec.version.artifact_id);
    expect(content?.status).toBe("available");
    expect(content?.preview?.text).toBe("managed-src\n");
  });

  it("MEDIUM-4: unrelated managed records sharing a logical_name do NOT share a series", () => {
    const a = recordArtifactVersion(db, { source_kind: "managed", provider_id: "alpha", content: "a\n", media_type: "text/plain", logical_name: "report" }, 1000);
    const b = recordArtifactVersion(db, { source_kind: "managed", provider_id: "beta", content: "b\n", media_type: "text/plain", logical_name: "report" }, 2000);
    expect(a.series.id).not.toBe(b.series.id);
    // No namespace and no series_key → reject rather than silently colliding.
    expect(() =>
      recordArtifactVersion(db, { source_kind: "managed", content: "c\n", media_type: "text/plain", logical_name: "report" }, 3000),
    ).toThrow(/explicit series_key/i);
  });

  it("MEDIUM-5: read-only history/diff do not materialize rows for unregistered refs", () => {
    const counts = () => ({
      artifacts: (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n,
      aliases: (db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get() as { n: number }).n,
      graph: (db.prepare("SELECT COUNT(*) AS n FROM graph_entities").get() as { n: number }).n,
    });
    const before = counts();
    const hashA = `artifact:${"a".repeat(64)}`;
    const hashB = `artifact:${"b".repeat(64)}`;
    expect(resolveArtifactVersionHistory(db, hashA)).toBeNull();
    const diff = diffArtifacts(db, hashA, hashB);
    expect(diff.diffable).toBe(false);
    expect(counts()).toEqual(before);
  });

  it("accepts artifact-series selectors at compatibility read boundaries", () => {
    const r = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "s\n", media_type: "text/plain", logical_name: "sel" }, 1000);
    expect(resolveArtifactRef(db, r.version.id).artifact?.id).toBe(r.artifact.id);
    const res = resolveArtifactRef(db, `${r.series.id}@1`);
    expect(res.artifact?.id).toBe(r.artifact.id);
    expect(res.status).toBe("resolved");
    expect(res.target_type).toBe("artifact_version");
    expect(res.warnings).toEqual([]);
  });

  it("LOW-8/HIGH-3: latest_version_id and version_count stay consistent and survive backup", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "c1\n", media_type: "text/plain", logical_name: "cache" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", provider_id: "test", content: "c2\n", media_type: "text/plain", logical_name: "cache" }, 2000);
    const series = getArtifactSeries(db, r1.series.id)!;
    const rows = listArtifactVersions(db, series.id);
    expect(series.version_count).toBe(rows.length);
    expect(series.latest_version_id).toBe(rows[rows.length - 1].id);
    expect(series.latest_version_id).toBe(r2.version.id);

    const restored = new Database(path.join(tempDir, "cache-restored.db"));
    restored.pragma("foreign_keys = ON");
    restored.exec(buildMetadataBackupSql(db));
    const logicalId = series.id.replace(/^artifact-series:/, "artifact:");
    const rSeries = restored.prepare("SELECT latest_version_id, version_count FROM artifact WHERE id = ?").get(logicalId) as { latest_version_id: string; version_count: number };
    const rMax = restored.prepare("SELECT id FROM artifact_version WHERE artifact_id = ? ORDER BY version_no DESC LIMIT 1").get(logicalId) as { id: string };
    expect(rSeries.version_count).toBe(2);
    expect(rSeries.latest_version_id).toBe(rMax.id);
    restored.close();
  });

  it("MEDIUM-6: migration 88 fails loudly on a pre-existing divergent table", () => {
    const divergentPath = path.join(tempDir, "divergent.db");
    const setup = openDb(divergentPath);
    setup.exec("DROP TABLE artifact_versions");
    // Columns present (so v88's CREATE INDEX statements still build) but the
    // UNIQUE(series_id, version_no) constraint and the FKs are absent — exactly
    // what CREATE TABLE IF NOT EXISTS would silently accept.
    setup.exec(`CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY, series_id TEXT, artifact_id TEXT, version_no INTEGER,
      source_kind TEXT, content_hash TEXT, commit_sha TEXT, repo_path TEXT,
      observed_path TEXT, custody_mode TEXT, label TEXT, note TEXT,
      metadata_json TEXT, created_at INTEGER
    )`);
    setup.prepare("UPDATE meta SET value = '87' WHERE key = 'schema_version'").run();
    expect(() => migrate(setup)).toThrow(/migration 88 verification/i);
    setup.close();
  });
});

describe("codex re-review hardening", () => {
  it("RR-1: CAS-fallback reads verify bytes hash and fail loudly on a tampered blob", () => {
    const src = path.join(tempDir, "cas-src.txt");
    fs.writeFileSync(src, "cas-int\n", "utf8");
    const link = registerLocalArtifactPath(db, { path: src, custody_mode: "link", allow_local_only: true }, 1000);
    const rec = recordArtifactVersion(db, {
      source_kind: "managed",
      ref: `artifact-blob:${link.artifact.content_hash}`,
      logical_name: "src",
      provider_id: "test",
      media_type: "text/plain",
    }, 2000);

    // Remove the link source so materialization must use the CAS fallback, then
    // corrupt the CAS blob in place (same filename, wrong bytes).
    fs.rmSync(src);
    const hash = link.artifact.content_hash;
    const casPath = path.join(tempDir, "artifacts", "sha256", hash.slice(0, 2), hash);
    expect(fs.existsSync(casPath)).toBe(true);
    fs.writeFileSync(casPath, "TAMPERED\n", "utf8");

    const read = readArtifactBytesFull(db, rec.version.artifact_id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/hash mismatch/i);

    // A managed re-snapshot of the same (now-corrupt) ref must refuse, not
    // silently re-snapshot wrong bytes.
    const canonicalBlobRef = `artifact-blob:${rec.version.content_hash}`;
    expect(() =>
      recordArtifactVersion(db, { source_kind: "managed", ref: canonicalBlobRef, logical_name: "src", provider_id: "test" }, 3000),
    ).toThrow(/not materializable|hash mismatch/i);
  });

  it("RR-2: schema verifier rejects a table missing the source_kind CHECK", () => {
    const divergentPath = path.join(tempDir, "no-check.db");
    const setup = openDb(divergentPath);
    setup.exec("DROP TABLE artifact_versions");
    // Full columns, UNIQUE, and FKs — but NO CHECK(source_kind ...).
    setup.exec(`CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES artifact_series(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_no INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      commit_sha TEXT, repo_path TEXT, observed_path TEXT, custody_mode TEXT,
      label TEXT, note TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER,
      UNIQUE(series_id, version_no)
    )`);
    setup.prepare("UPDATE meta SET value = '87' WHERE key = 'schema_version'").run();
    expect(() => migrate(setup)).toThrow(/CHECK\(source_kind/i);
    setup.close();
  });

  it("RR-3: managed default series key escapes components so they cannot collide", () => {
    const a = recordArtifactVersion(db, { source_kind: "managed", provider_id: "a:b", content: "x\n", media_type: "text/plain", logical_name: "c" }, 1000);
    const b = recordArtifactVersion(db, { source_kind: "managed", provider_id: "a", role: "b", content: "y\n", media_type: "text/plain", logical_name: "c" }, 2000);
    expect(a.series.id).not.toBe(b.series.id);
    expect(getArtifactSeries(db, a.series.id)?.series_key).toBe("managed:a%3Ab:c");
    expect(getArtifactSeries(db, b.series.id)?.series_key).toBe("managed:a:b:c");
  });

  it("RR-4: a dirty-file version records the HEAD commit in metadata (commit_sha stays null)", () => {
    const { root, filePath } = makeTrackedRepo("dirty-prov", "clean\n");
    createLedgerCheckout("mandible", fs.realpathSync(root));
    const head = git(root, ["rev-parse", "HEAD"]);

    fs.writeFileSync(filePath, "dirty-bytes\n", "utf8");
    const rec = recordArtifactVersion(db, { source_kind: "tracked_repo", path: filePath }, 2000);
    expect(rec.version.source_kind).toBe("local_only");
    expect(rec.version.commit_sha).toBeNull();
    expect(rec.version.metadata.head_commit).toBe(head);
    expect(rec.version.metadata.dirty_at_commit).toBe(head);
  });
});
