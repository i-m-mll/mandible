import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildArtifactRepoIdentityAudit } from "../scripts/audit-artifact-repo-identity.mjs";

let tempDir = "";
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-repo-audit-"));
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("artifact repo identity audit planner", () => {
  it("plans canonical rewrites for feature-worktree repo identities without mutating", () => {
    const repoRoot = createGitRepo("feature__31e67ff-cap-independent-soft-lambda-redo", {
      "results/report.md": "# Report\n",
    });
    const commit = git(repoRoot, ["rev-parse", "HEAD"]);
    const contentHash = sha256("# Report\n");
    insertProject({
      projectKey: "rlrmp",
      workRepoId: "feature__31e67ff-cap-independent-soft-lambda-redo",
      root: repoRoot,
    });
    insertArtifactGraph({
      badRepo: "feature__31e67ff-cap-independent-soft-lambda-redo",
      canonicalRepo: "rlrmp",
      commit,
      contentHash,
      includeCollision: false,
    });

    const report = buildArtifactRepoIdentityAudit(db, { dbPath: "fixture.db", reportPath: "report.json" });

    expect(report.mode).toBe("dry_run");
    expect(report.mutates_db).toBe(false);
    expect(report.summary.safe_updates).toBeGreaterThanOrEqual(8);
    expect(report.summary.blocked_updates).toBe(0);
    expect(
      report.safe_updates.some((update: any) =>
        update.table === "artifacts" &&
        update.column === "uri" &&
        update.before === `repo://feature__31e67ff-cap-independent-soft-lambda-redo@${commit}/results/report.md` &&
        update.after === `repo://rlrmp@${commit}/results/report.md` &&
        update.validation.checks.content_hash_match === true
      ),
    ).toBe(true);
    expect(
      report.safe_updates.some((update: any) =>
        update.table === "artifact_links" &&
        update.column === "repo_id" &&
        update.after === "rlrmp"
      ),
    ).toBe(true);
    expect(
      report.safe_updates.some((update: any) =>
        update.table === "graph_entities" &&
        update.column === "repo_id" &&
        update.after === "rlrmp"
      ),
    ).toBe(true);
    expect(
      db.prepare("SELECT home_repo_id FROM artifacts WHERE id = 'artifact:sha256:fixture'").get(),
    ).toEqual({ home_repo_id: "feature__31e67ff-cap-independent-soft-lambda-redo" });
  });

  it("blocks alias rewrites that would collide with an existing canonical alias", () => {
    const repoRoot = createGitRepo("feature__31e67ff-cap-independent-soft-lambda-redo", {
      "results/report.md": "# Report\n",
    });
    const commit = git(repoRoot, ["rev-parse", "HEAD"]);
    insertProject({
      projectKey: "rlrmp",
      workRepoId: "feature__31e67ff-cap-independent-soft-lambda-redo",
      root: repoRoot,
    });
    insertArtifactGraph({
      badRepo: "feature__31e67ff-cap-independent-soft-lambda-redo",
      canonicalRepo: "rlrmp",
      commit,
      contentHash: sha256("# Report\n"),
      includeCollision: true,
    });

    const report = buildArtifactRepoIdentityAudit(db);
    const blockedAlias = report.blocked_updates.find((update: any) =>
      update.table === "artifact_aliases" &&
      update.column === "normalized_ref" &&
      update.row_id === "alias-bad"
    );

    expect(blockedAlias).toBeTruthy();
    expect(blockedAlias.blockers.some((blocker: any) => blocker.kind === "alias_collision")).toBe(true);
    expect(report.summary.alias_collisions).toBeGreaterThan(0);
  });

  it("reports ambiguous project candidates instead of proposing unsafe rewrites", () => {
    db.prepare(
      `INSERT INTO ledger_projects
       (id, project_key, display_name, remote_identity, upstream_identity, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 1, 1)`,
    ).run("prj_a", "alpha", "feature__ambiguous");
    db.prepare(
      `INSERT INTO ledger_projects
       (id, project_key, display_name, remote_identity, upstream_identity, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 1, 1)`,
    ).run("prj_b", "beta", "feature__ambiguous");
    db.prepare(
      `INSERT INTO artifacts
       (id, algorithm, content_hash, uri, home_repo_id, repo_locator_json, metadata_json, reference_json)
       VALUES (?, 'sha256', ?, ?, ?, '{}', '{}', '{}')`,
    ).run(
      "artifact:sha256:ambiguous",
      "a".repeat(64),
      "repo://feature__ambiguous@main/results/report.md",
      "feature__ambiguous",
    );

    const report = buildArtifactRepoIdentityAudit(db);

    expect(report.summary.ambiguous_occurrences).toBe(2);
    expect(report.ambiguous.every((update: any) => update.after === update.before)).toBe(true);
    expect(report.ambiguous[0].resolution.candidates).toEqual(["alpha", "beta"]);
  });
});

function createSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE ledger_projects (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      remote_identity TEXT NOT NULL DEFAULT '',
      upstream_identity TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_project_checkouts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_repo_id TEXT,
      root TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      content_hash TEXT NOT NULL,
      uri TEXT NOT NULL,
      home_repo_id TEXT,
      repo_locator_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      reference_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifact_aliases (
      id TEXT PRIMARY KEY,
      artifact_id TEXT,
      scheme TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_ref TEXT NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}',
      resolution_status TEXT NOT NULL DEFAULT 'resolved'
    );
    CREATE TABLE artifact_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      repo_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifact_series (
      id TEXT PRIMARY KEY,
      series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'tracked_repo',
      title TEXT,
      repo_id TEXT,
      logical_name TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      commit_sha TEXT,
      repo_path TEXT,
      observed_path TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE graph_entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      repo_id TEXT,
      provider_id TEXT,
      external_id TEXT,
      title TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      detail_ref_json TEXT NOT NULL DEFAULT '{}',
      action_context_json TEXT NOT NULL DEFAULT '{}',
      visual_json TEXT NOT NULL DEFAULT '{}',
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      edge_class TEXT NOT NULL DEFAULT 'provenance',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
  `);
}

function insertProject(input: { projectKey: string; workRepoId: string; root: string }) {
  db.prepare(
    `INSERT INTO ledger_projects
     (id, project_key, display_name, remote_identity, upstream_identity, created_at, updated_at)
     VALUES ('prj_rlrmp', ?, 'RLRMP', 'github.com/i-m-mll/rlrmp', '', 1, 1)`,
  ).run(input.projectKey);
  db.prepare(
    `INSERT INTO ledger_project_checkouts
     (id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at)
     VALUES ('chk_rlrmp_feature', 'prj_rlrmp', ?, ?, 'feature checkout', 'main',
             'git@github.com:i-m-mll/rlrmp.git', 1, 1)`,
  ).run(input.workRepoId, input.root);
}

function insertArtifactGraph(input: {
  badRepo: string;
  canonicalRepo: string;
  commit: string;
  contentHash: string;
  includeCollision: boolean;
}) {
  const badUri = `repo://${input.badRepo}@${input.commit}/results/report.md`;
  const canonicalUri = `repo://${input.canonicalRepo}@${input.commit}/results/report.md`;
  db.prepare(
    `INSERT INTO artifacts
     (id, algorithm, content_hash, uri, home_repo_id, repo_locator_json, metadata_json, reference_json)
     VALUES (?, 'sha256', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "artifact:sha256:fixture",
    input.contentHash,
    badUri,
    input.badRepo,
    JSON.stringify({ repo_id: input.badRepo, ref: input.commit, path: "results/report.md" }),
    JSON.stringify({ source: { repo_id: input.badRepo, uri: badUri } }),
    JSON.stringify({ locator: { repo_id: input.badRepo, ref: input.commit, path: "results/report.md" } }),
  );
  db.prepare(
    `INSERT INTO artifact_aliases
     (id, artifact_id, scheme, alias, normalized_ref, locator_json)
     VALUES (?, ?, 'repo', ?, ?, ?)`,
  ).run(
    "alias-bad",
    "artifact:sha256:fixture",
    badUri,
    badUri,
    JSON.stringify({ repo_id: input.badRepo, ref: input.commit, path: "results/report.md" }),
  );
  if (input.includeCollision) {
    db.prepare(
      `INSERT INTO artifact_aliases
       (id, artifact_id, scheme, alias, normalized_ref, locator_json)
       VALUES ('alias-existing', 'artifact:sha256:other', 'repo', ?, ?, '{}')`,
    ).run(canonicalUri, canonicalUri);
  }
  db.prepare(
    `INSERT INTO artifact_links
     (id, artifact_id, entity_type, entity_id, repo_id, metadata_json)
     VALUES ('link-1', 'artifact:sha256:fixture', 'issue', 'abc1234', ?, ?)`,
  ).run(input.badRepo, JSON.stringify({ repo_id: input.badRepo, ref: input.commit, path: "results/report.md" }));
  db.prepare(
    `INSERT INTO artifact_series
     (id, series_key, repo_id, logical_name, metadata_json, created_at, updated_at)
     VALUES ('series-1', ?, ?, 'results/report.md', ?, 1, 1)`,
  ).run(badUri, input.badRepo, JSON.stringify({ repo_id: input.badRepo }));
  db.prepare(
    `INSERT INTO artifact_versions
     (id, series_id, artifact_id, version_no, source_kind, content_hash,
      commit_sha, repo_path, observed_path, metadata_json, created_at)
     VALUES ('version-1', 'series-1', 'artifact:sha256:fixture', 1, 'tracked_repo',
             ?, ?, 'results/report.md', ?, ?, 1)`,
  ).run(
    input.contentHash,
    input.commit,
    path.join(tempDir, input.badRepo, "results", "report.md"),
    JSON.stringify({ repo_id: input.badRepo, ref: input.commit, path: "results/report.md" }),
  );
  db.prepare(
    `INSERT INTO graph_entities
     (id, entity_type, repo_id, external_id, title, summary_json, detail_ref_json,
      action_context_json, visual_json, observed_at, source)
     VALUES ('graph-artifact', 'artifact', ?, 'artifact:sha256:fixture', 'Report',
             ?, ?, '{}', '{}', 1, 'test')`,
  ).run(
    input.badRepo,
    JSON.stringify({ locator: badUri }),
    JSON.stringify({ repo_id: input.badRepo, ref: input.commit, path: "results/report.md" }),
  );
  db.prepare(
    `INSERT INTO graph_edges
     (id, source_id, target_id, edge_type, metadata_json, observed_at, source)
     VALUES ('edge-1', 'graph-artifact', 'issue', 'references', ?, 1, 'test')`,
  ).run(JSON.stringify({ repo_id: input.badRepo, uri: badUri }));
}

function createGitRepo(name: string, files: Record<string, string>) {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Mandible Test"]);
  git(root, ["config", "user.email", "mandible-test@example.invalid"]);
  git(root, ["remote", "add", "origin", "git@github.com:i-m-mll/rlrmp.git"]);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
