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
  listArtifactVersions,
  recordArtifactVersion,
  resolveAndLinkArtifact,
  resolveArtifactRef,
  resolveArtifactVersionHistory,
} from "../src/provider-artifacts.js";
import { diffArtifacts, getArtifactContent } from "../src/artifact-content.js";
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
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "m1\n", media_type: "text/plain", logical_name: "doc" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", content: "m2\n", media_type: "text/plain", logical_name: "doc" }, 2000);
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
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "line1\nline2\nline3\n", media_type: "text/plain", logical_name: "doc" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", content: "line1\nline2-changed\nline3\n", media_type: "text/plain", logical_name: "doc" }, 2000);

    const diff = diffArtifacts(db, r1.version.id, r2.version.id);
    expect(diff.diffable).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.kind).toBe("text");
    expect(diff.unified).toContain("-line2");
    expect(diff.unified).toContain("+line2-changed");
    expect(diff.stats).toEqual({ added: 1, removed: 1 });
  });

  it("normalizes JSON before diffing and reports identical content", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: '{"a":1,"b":2}', media_type: "application/json", logical_name: "cfg" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", content: '{"a":1,"b":3}', media_type: "application/json", logical_name: "cfg" }, 2000);
    const diff = diffArtifacts(db, r1.version.artifact_id, r2.version.artifact_id);
    expect(diff.kind).toBe("json");
    expect(diff.diffable).toBe(true);
    expect(diff.unified).toContain('"b": 2');
    expect(diff.unified).toContain('"b": 3');

    const same = diffArtifacts(db, r1.version.artifact_id, r1.version.artifact_id);
    expect(same.identical).toBe(true);
    expect(same.stats).toEqual({ added: 0, removed: 0 });
  });
});

describe("ref resolution backward-compat and no silent retarget", () => {
  it("keeps artifact:sha256 refs immutable and resolves version/series refs", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "A\n", media_type: "text/plain", logical_name: "ev" }, 1000);
    const fullId = r1.artifact.id; // artifact:sha256:<hash>
    // The documented registerable hash ref still resolves to the immutable row.
    const resolved = resolveArtifactRef(db, `artifact:${r1.artifact.content_hash}`);
    expect(resolved.status).toBe("resolved");
    expect(resolved.artifact?.id).toBe(fullId);
    expect(resolved.series ?? null).toBeNull(); // hash ref carries no series context

    const versionResolved = resolveArtifactRef(db, r1.version.id);
    expect(versionResolved.artifact?.id).toBe(fullId);
    expect(versionResolved.version?.id).toBe(r1.version.id);
    expect(versionResolved.warnings ?? []).toEqual([]);
  });

  it("does not silently retarget an existing issue link when a newer version is recorded", () => {
    const issueId = createLedgerIssue("f7a994e");
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "evidence v1\n", media_type: "text/plain", logical_name: "ev" }, 1000);
    const artifactA = r1.artifact.id;

    const linked = resolveAndLinkArtifact(db, {
      ref: r1.version.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "evidence",
    }, 1100);
    expect(linked.link?.artifact_id).toBe(artifactA);

    // Record a newer version into the SAME series.
    const r2 = recordArtifactVersion(db, { source_kind: "managed", content: "evidence v2\n", media_type: "text/plain", logical_name: "ev" }, 2000);
    expect(r2.series.id).toBe(r1.series.id);
    const artifactB = r2.artifact.id;
    expect(artifactB).not.toBe(artifactA);

    // The existing issue link still points at the pinned immutable artifact A.
    const linkRows = db
      .prepare("SELECT artifact_id FROM artifact_links WHERE entity_type = 'issue' AND entity_id = ?")
      .all(issueId) as Array<{ artifact_id: string }>;
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0].artifact_id).toBe(artifactA);

    // Series-latest resolution floats to B but warns it is not pinned.
    const latest = resolveArtifactRef(db, r1.series.id);
    expect(latest.artifact?.id).toBe(artifactB);
    expect(latest.warnings).toContain("series_latest_not_pinned");

    // A pinned version-2 selector resolves to B with no warning.
    const pinned2 = resolveArtifactRef(db, `${r1.series.id}@2`);
    expect(pinned2.artifact?.id).toBe(artifactB);
    expect(pinned2.warnings ?? []).toEqual([]);
  });
});

describe("version history query", () => {
  it("resolves history from a series id, version id, or artifact ref", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "h1\n", media_type: "text/plain", logical_name: "hist" }, 1000);
    recordArtifactVersion(db, { source_kind: "managed", content: "h2\n", media_type: "text/plain", logical_name: "hist" }, 2000);

    const bySeries = resolveArtifactVersionHistory(db, r1.series.id);
    expect(bySeries?.versions).toHaveLength(2);
    const byVersion = resolveArtifactVersionHistory(db, r1.version.id);
    expect(byVersion?.series.id).toBe(r1.series.id);
    const byArtifact = resolveArtifactVersionHistory(db, r1.artifact.id);
    expect(byArtifact?.series.id).toBe(r1.series.id);
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

  it("round-trips artifact_series and artifact_versions through backup/restore", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "b1\n", media_type: "text/plain", logical_name: "bk" }, 1000);
    const r2 = recordArtifactVersion(db, { source_kind: "managed", content: "b2\n", media_type: "text/plain", logical_name: "bk" }, 2000);
    const sql = buildMetadataBackupSql(db);
    expect(sql).toContain("-- Table: artifact_series");
    expect(sql).toContain("-- Table: artifact_versions");

    const restored = new Database(path.join(tempDir, "restored.db"));
    restored.pragma("foreign_keys = ON");
    restored.exec(sql);

    const series = restored.prepare("SELECT * FROM artifact_series").all() as Array<{ id: string; series_key: string; version_count: number }>;
    expect(series).toHaveLength(1);
    expect(series[0].series_key).toBe("managed:bk");
    expect(series[0].version_count).toBe(2);
    const versions = restored
      .prepare("SELECT id, version_no, content_hash FROM artifact_versions ORDER BY version_no")
      .all() as Array<{ id: string; version_no: number; content_hash: string }>;
    expect(versions.map((v) => v.version_no)).toEqual([1, 2]);
    expect(versions[0].id).toBe(r1.version.id);
    expect(versions[1].id).toBe(r2.version.id);

    // UNIQUE(series_key) survives the round-trip.
    expect(() =>
      restored.prepare(
        `INSERT INTO artifact_series (id, series_key, source_kind, version_count, created_at, updated_at)
         VALUES ('dup', 'managed:bk', 'managed', 0, 1, 1)`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    restored.close();
  });
});

describe("appendArtifactVersion mixed source kinds", () => {
  it("marks a series mixed when versions span source kinds", () => {
    const r1 = recordArtifactVersion(db, { source_kind: "managed", content: "x\n", media_type: "text/plain", logical_name: "mix", series_key: "shared:mix" }, 1000);
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
