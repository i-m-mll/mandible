import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkArtifactMaterialization, getArtifactContent, getArtifactContentAsync } from "../src/artifact-content.js";
import {
  addArtifactBundleMembers,
  createArtifactBundle,
  getArtifact,
  getArtifactBundle,
  getArtifactRoot,
  getIndexedGraph,
  getIndexedGraphCount,
  getProviderCapabilities,
  getProviderHealth,
  ingestArtifact,
  ingestProviderManifest,
  listArtifacts,
  listProviders,
  getArtifactSeries,
  listArtifactVersions,
  planLocalArtifactPath,
  recordArtifactVersion,
  registerArtifactAlias,
  registerLocalArtifactPath,
  registerProvider,
  resolveAndLinkArtifact,
  resolveArtifactRef,
  resolveArtifactVersionHistory,
  snapshotArtifactBytes,
} from "../src/provider-artifacts.js";
import { discoverRepoArtifacts, scanRepoArtifacts } from "../src/repo-artifact-scanner.js";

let tempDir = "";
let db: Database.Database;
let savedEnv: Record<string, string | undefined>;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      version TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      transport TEXT NOT NULL DEFAULT 'manifest',
      endpoint TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      actions_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      content_hash TEXT NOT NULL,
      uri TEXT NOT NULL,
      media_type TEXT,
      role TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT,
      manifest_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      pinned INTEGER NOT NULL DEFAULT 1,
      custody_mode TEXT NOT NULL DEFAULT 'managed',
      home_repo_id TEXT,
      repo_locator_json TEXT NOT NULL DEFAULT '{}',
      availability TEXT NOT NULL DEFAULT 'unchecked',
      retention_json TEXT NOT NULL DEFAULT '{}',
      reference_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(algorithm, content_hash)
    );
    CREATE TABLE artifact_aliases (
      id TEXT PRIMARY KEY,
      artifact_id TEXT,
      scheme TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_ref TEXT NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}',
      resolution_status TEXT NOT NULL DEFAULT 'resolved',
      source TEXT NOT NULL DEFAULT 'artifact_registry',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_artifact_aliases_scheme_ref
      ON artifact_aliases(scheme, normalized_ref);
    CREATE INDEX idx_artifact_aliases_artifact
      ON artifact_aliases(artifact_id)
      WHERE artifact_id IS NOT NULL;
    CREATE INDEX idx_artifact_aliases_status
      ON artifact_aliases(resolution_status, scheme);
    CREATE TABLE artifact_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      role TEXT,
      repo_id TEXT,
      provider_id TEXT,
      source TEXT NOT NULL DEFAULT 'artifact_registry',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      link_kind TEXT NOT NULL DEFAULT 'pinned' CHECK(link_kind IN ('pinned','living')),
      series_id TEXT,
      series_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_artifact_links_artifact
      ON artifact_links(artifact_id, link_type);
    CREATE INDEX idx_artifact_links_entity
      ON artifact_links(entity_type, entity_id);
    CREATE INDEX idx_artifact_links_repo
      ON artifact_links(repo_id)
      WHERE repo_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_provider
      ON artifact_links(provider_id)
      WHERE provider_id IS NOT NULL;
    CREATE INDEX idx_artifact_links_role
      ON artifact_links(role)
      WHERE role IS NOT NULL;
    CREATE INDEX idx_artifact_links_kind
      ON artifact_links(link_kind);
    CREATE INDEX idx_artifact_links_series
      ON artifact_links(series_id)
      WHERE series_id IS NOT NULL;
    CREATE TABLE artifact_series (
      id TEXT PRIMARY KEY,
      series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'managed'
        CHECK(source_kind IN ('tracked_repo','local_only','managed','mixed')),
      title TEXT,
      repo_id TEXT,
      logical_name TEXT,
      latest_version_id TEXT,
      version_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(series_key)
    );
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      version_no INTEGER NOT NULL,
      source_kind TEXT NOT NULL
        CHECK(source_kind IN ('tracked_repo','local_only','managed')),
      content_hash TEXT NOT NULL,
      commit_sha TEXT,
      repo_path TEXT,
      observed_path TEXT,
      custody_mode TEXT,
      label TEXT,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(series_id, version_no)
    );
    CREATE INDEX idx_artifact_versions_series
      ON artifact_versions(series_id, version_no DESC);
    CREATE TABLE artifact_blob (
      id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      content_hash TEXT NOT NULL,
      storage_uri TEXT,
      media_type TEXT,
      role TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT,
      manifest_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      custody_mode TEXT NOT NULL DEFAULT 'managed'
        CHECK(custody_mode IN ('link','copy','managed','external')),
      availability TEXT NOT NULL DEFAULT 'unchecked'
        CHECK(availability IN ('present','missing','stale','unchecked','remote_only','pinned')),
      retention_json TEXT NOT NULL DEFAULT '{}',
      reference_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(algorithm, content_hash)
    );
    CREATE TABLE artifact (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'managed'
        CHECK(source_kind IN ('tracked_repo','local_only','managed','external','mixed')),
      title TEXT,
      source_project_id TEXT,
      source_repo_id TEXT,
      logical_name TEXT,
      source_path TEXT,
      latest_version_id TEXT,
      version_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(identity_key)
    );
    CREATE TABLE artifact_version (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      blob_id TEXT NOT NULL,
      source_kind TEXT NOT NULL
        CHECK(source_kind IN ('tracked_repo','local_only','managed','external')),
      content_hash TEXT NOT NULL,
      source_project_id TEXT,
      source_repo_id TEXT,
      repo_path TEXT,
      commit_sha TEXT,
      observed_path TEXT,
      source_locator_json TEXT NOT NULL DEFAULT '{}',
      custody_mode TEXT
        CHECK(custody_mode IS NULL OR custody_mode IN ('link','copy','managed','external')),
      label TEXT,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(artifact_id, version_no)
    );
    CREATE TABLE project_artifact_associations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('artifact','artifact_version')),
      target_id TEXT NOT NULL,
      association_kind TEXT NOT NULL DEFAULT 'associated'
        CHECK(association_kind IN ('associated','canonical')),
      role TEXT NOT NULL DEFAULT '',
      title TEXT,
      description TEXT,
      rank INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','superseded','archived')),
      source TEXT NOT NULL DEFAULT 'user'
        CHECK(source IN ('user','agent_explicit','space_rule','migration','system')),
      source_ref_type TEXT,
      source_ref_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, target_type, target_id, role)
    );
    CREATE TABLE provider_manifests (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      manifest_type TEXT NOT NULL DEFAULT 'provider_manifest',
      version TEXT,
      content_hash TEXT NOT NULL,
      artifact_id TEXT,
      source TEXT NOT NULL DEFAULT 'ingest',
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE graph_entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      repo_id TEXT,
      provider_id TEXT,
      external_id TEXT,
      title TEXT NOT NULL,
      status TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT NOT NULL DEFAULT '{}',
      detail_ref_json TEXT NOT NULL DEFAULT '{}',
      action_context_json TEXT NOT NULL DEFAULT '{}',
      visual_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER,
      updated_at INTEGER,
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      edge_class TEXT NOT NULL DEFAULT 'provenance',
      provenance TEXT NOT NULL DEFAULT 'system',
      confidence TEXT NOT NULL DEFAULT 'observed',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER,
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_projects (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      remote_identity TEXT NOT NULL DEFAULT '',
      upstream_identity TEXT NOT NULL DEFAULT '',
      namespace_policy TEXT NOT NULL DEFAULT 'remote',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_project_checkouts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_repo_id TEXT,
      root TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT '',
      remote_url TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_issues (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      resolution TEXT,
      kind TEXT NOT NULL DEFAULT 'unknown',
      priority TEXT NOT NULL DEFAULT 'unknown',
      author_actor_id TEXT,
      author_actor_type TEXT NOT NULL DEFAULT 'external_adapter',
      author_display TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'mandible',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE ledger_issue_aliases (
      issue_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      external_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (alias_kind, project_id, alias)
    );
  `);
}

function createLedgerIssue(projectName: string, alias: string, title = `Issue ${alias}`): string {
  const projectId = `prj_${projectName}`;
  const issueId = `${alias}_${projectName}`;
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (
      id, project_key, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
    ) VALUES (?, ?, ?, '', '', 'remote', 1, 1)`,
  ).run(projectId, projectName, projectName);
  db.prepare(
    `INSERT OR IGNORE INTO ledger_project_checkouts (
      id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'main', '', 1, 1)`,
  ).run(`checkout_${projectName}`, projectId, projectName, `/tmp/${projectName}`, projectName);
  db.prepare(
    `INSERT INTO ledger_issues (
      id, short_id, project_id, title, body, status, kind, priority,
      author_actor_type, author_display, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'open', 'feature', 'normal', 'agent', 'Codex', 'mandible', 1, 1)`,
  ).run(issueId, alias, projectId, title);
  db.prepare(
    `INSERT INTO ledger_issue_aliases (
      issue_id, alias_kind, project_id, alias, external_id, source, is_primary, created_at
    ) VALUES (?, 'git_bug_short', ?, ?, ?, 'git_bug', 1, 1)`,
  ).run(issueId, projectId, alias, alias);
  return issueId;
}

function createLedgerCheckout(repoId: string, root: string, options: {
  projectKey?: string;
  displayName?: string;
  workRepoId?: string;
  remoteIdentity?: string;
  remoteUrl?: string;
  defaultBranch?: string;
} = {}): void {
  const projectKey = options.projectKey ?? repoId;
  const projectId = `prj_${projectKey}`;
  const displayName = options.displayName ?? projectKey;
  const workRepoId = options.workRepoId ?? repoId;
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (
      id, project_key, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'remote', 1, 1)`,
  ).run(projectId, projectKey, displayName, options.remoteIdentity ?? "");
  db.prepare(
    `INSERT OR REPLACE INTO ledger_project_checkouts (
      id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(
    `checkout_${workRepoId}`,
    projectId,
    workRepoId,
    root,
    displayName,
    options.defaultBranch ?? "main",
    options.remoteUrl ?? "",
  );
}

function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function commitRepoFile(root: string, rel: string, body: string): string {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
  git(root, ["add", rel]);
  git(root, ["commit", "-m", `add ${rel}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-provider-test-"));
  process.env.HOME = path.join(tempDir, "home");
  delete process.env.MANDIBLE_ARTIFACT_DIR;
  delete process.env.MANDIBLE_HOME;
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("provider/artifact substrate", () => {
  it("defaults the artifact root to non-cache local app data under HOME", () => {
    expect(getArtifactRoot()).toBe(path.join(process.env.HOME!, ".mandible", "artifacts"));
    expect(getArtifactRoot()).not.toContain(`${path.sep}.cache${path.sep}`);
  });

  it("uses MANDIBLE_HOME/artifacts when no artifact-specific override is set", () => {
    process.env.MANDIBLE_HOME = path.join(tempDir, "mandible-home");

    expect(getArtifactRoot()).toBe(path.join(tempDir, "mandible-home", "artifacts"));
  });

  it("uses artifact_root from settings when no environment override is set", () => {
    const configuredRoot = path.join(tempDir, "settings-root");
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('artifact_root', ?, 1000)"
    ).run(configuredRoot);

    const artifact = ingestArtifact(db, {
      media_type: "application/json",
      json: { configured: true },
    }, 1000);

    expect(getArtifactRoot(db)).toBe(configuredRoot);
    expect(artifact.uri.startsWith(`file://${configuredRoot}${path.sep}`)).toBe(true);
    expect(fs.existsSync(artifact.uri.replace("file://", ""))).toBe(true);
  });

  it("lets MANDIBLE_ARTIFACT_DIR override settings and MANDIBLE_HOME", () => {
    const envRoot = path.join(tempDir, "env-root");
    process.env.MANDIBLE_HOME = path.join(tempDir, "mandible-home");
    process.env.MANDIBLE_ARTIFACT_DIR = envRoot;
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('artifact_root', ?, 1000)"
    ).run(path.join(tempDir, "settings-root"));

    expect(getArtifactRoot(db)).toBe(envRoot);
  });

  it("ships a static Mandible-HumbleB bridge contract fixture", () => {
    const fixturePath = path.join(process.cwd(), "test/fixtures/mandible-humbleb-bridge.v1.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
      schema_version: string;
      issue: { id: string; repo_id: string };
      references: Array<Record<string, unknown>>;
      humbleb_return_refs: Record<string, unknown>;
    };

    expect(fixture.schema_version).toBe("mandible.humbleb_bridge.v1");
    expect(fixture.issue).toMatchObject({ repo_id: "mandible" });
    expect(fixture.references[0]).toMatchObject({
      custody_mode: "link",
      home_repo_id: "rlrmp",
      availability: "unchecked",
    });
    expect(fixture.humbleb_return_refs.knowledge_backrefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref_type: "document",
          external_ref: "humbleb:document:doc_0000000000000001",
        }),
        expect.objectContaining({
          ref_type: "entity",
          external_ref: "humbleb:entity:ent_0000000000000001",
        }),
        expect.objectContaining({
          ref_type: "claim",
          external_ref: "humbleb:claim:claim_0000000000000001",
        }),
      ])
    );
  });

  it("registers providers and mirrors them into graph entities", () => {
    const provider = registerProvider(db, {
      id: "Feedbax",
      display_name: "Feedbax",
      version: "0.1.0",
      capabilities: { validate: true },
    }, 1000);

    expect(provider.id).toBe("feedbax");
    expect(listProviders(db)).toHaveLength(1);

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 20 });
    expect(graph.nodes.map((node) => node.id)).toContain("provider:feedbax");
  });

  it("stores artifacts by content hash and returns stable IDs", () => {
    const first = ingestArtifact(db, {
      provider_id: "feedbax",
      role: "metrics",
      media_type: "application/json",
      json: { loss: 0.1 },
      metadata: { title: "metrics.json" },
    }, 1000, tempDir);
    const second = ingestArtifact(db, {
      provider_id: "feedbax",
      role: "metrics",
      media_type: "application/json",
      json: { loss: 0.1 },
      metadata: { title: "metrics.json" },
    }, 2000, tempDir);

    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^artifact:sha256:/);
    expect(first.custody_mode).toBe("managed");
    expect(first.availability).toBe("present");
    expect(first.retention).toMatchObject({ pinned: true });
    expect(fs.existsSync(first.uri.replace("file://", ""))).toBe(true);
  });

  it("stores explicit artifact custody and cross-repo reference metadata", () => {
    const artifact = ingestArtifact(db, {
      provider_id: "mandible",
      role: "document_snapshot",
      media_type: "text/markdown",
      sha256: "e".repeat(64),
      uri: "file:///tmp/rlrmp/results/b41c940/report.md",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      availability: "unchecked",
      repo_locator: {
        repo_id: "rlrmp",
        ref: "main",
        path: "results/b41c940/report.md",
      },
      retention: { pin_reason: "bridge-fixture" },
      reference: { owner_system: "repo", document_role: "report" },
    }, 1000, tempDir);

    expect(artifact).toMatchObject({
      custody_mode: "link",
      home_repo_id: "rlrmp",
      availability: "unchecked",
      pinned: true,
    });
    expect(artifact.repo_locator).toMatchObject({ repo_id: "rlrmp", path: "results/b41c940/report.md" });
    expect(artifact.reference).toMatchObject({ owner_system: "repo", document_role: "report" });
  });

  it("lists managed artifacts with aliases and filterable custody metadata", () => {
    const artifact = ingestArtifact(db, {
      provider_id: "mandible",
      role: "metrics",
      media_type: "application/json",
      json: { accuracy: 0.95 },
      metadata: { title: "metrics.json" },
    }, 1000, tempDir);

    const byHash = listArtifacts(db, { hashPrefix: artifact.content_hash.slice(0, 12) });
    const byQuery = listArtifacts(db, { q: "metrics", provider: "mandible", custody: "managed", availability: "present" });
    const detail = getArtifact(db, artifact.id);

    expect(byHash.map((item) => item.id)).toContain(artifact.id);
    expect(byQuery.map((item) => item.id)).toContain(artifact.id);
    expect(detail?.aliases?.map((alias) => alias.normalized_ref)).toContain(`artifact-blob:${artifact.content_hash}`);
    expect(detail?.aliases?.some((alias) => alias.scheme === "file")).toBe(true);
  });

  it("can list lightweight artifact summaries while detail remains enriched", () => {
    const artifact = ingestArtifact(db, {
      provider_id: "mandible",
      role: "metrics",
      media_type: "application/json",
      json: { accuracy: 0.95 },
      metadata: {
        title: "metrics.json",
        filename: "metrics.json",
        nested: { expensive: "x".repeat(1000) },
      },
      reference: {
        owner_system: "repo",
        nested: { expensive: "y".repeat(1000) },
      },
      link: {
        entity_type: "issue",
        entity_id: "mandible/419fa00",
        link_type: "references",
        repo_id: "mandible",
      },
    }, 1000, tempDir);

    const summaries = listArtifacts(db, { summary: true });
    const summary = summaries.find((item) => item.id === artifact.id);
    const detail = getArtifact(db, artifact.id);

    expect(summary).toBeTruthy();
    expect(summary?.metadata).toEqual({ title: "metrics.json" });
    expect(summary?.reference).toEqual({});
    expect(summary?.aliases).toBeUndefined();
    expect(summary?.links).toBeUndefined();
    expect(summary?.alias_schemes).toEqual(expect.arrayContaining(["artifact-blob", "file"]));
    expect(detail?.metadata).toMatchObject({ nested: { expensive: expect.any(String) } });
    expect(detail?.reference).toMatchObject({ owner_system: "repo" });
    expect(detail?.aliases?.length).toBeGreaterThan(0);
    expect(detail?.links?.map((link) => link.entity_id)).toContain("mandible/419fa00");
  });

  it("resolves compact artifact-blob hash prefixes without changing canonical artifact identity", () => {
    const hash = "1234567890abcdef".repeat(4);
    const artifact = ingestArtifact(db, {
      sha256: hash,
      role: "report",
      uri: "repo://mandible@main/results/report.md",
      custody_mode: "link",
      repo_locator: { repo_id: "mandible", ref: "main", path: "results/report.md" },
    }, 1000, tempDir);

    const compact = resolveArtifactRef(db, "artifact-blob:1234567890ab", 2000);
    const canonicalBlob = resolveArtifactRef(db, `artifact-blob:${hash}`, 2000);
    const legacyColon = resolveArtifactRef(db, `artifact:sha256:${hash}`, 2000);
    const unsupportedPlain = resolveArtifactRef(db, `sha256:${hash}`, 2000);

    expect(compact).toMatchObject({
      status: "resolved",
      artifact: { id: artifact.id, content_hash: hash },
      alias: null,
      artifact_blob: { id: `artifact-blob:${hash}`, content_hash: hash },
    });
    expect(canonicalBlob).toMatchObject({
      status: "resolved",
      artifact: { id: artifact.id, content_hash: hash },
      alias: null,
      artifact_blob: { id: `artifact-blob:${hash}`, content_hash: hash },
    });
    expect(legacyColon).toMatchObject({ status: "unsupported", artifact: null, alias: null });
    expect(unsupportedPlain).toMatchObject({ status: "unsupported", artifact: null, alias: null });
    expect(getArtifact(db, artifact.id)?.id).toBe(`artifact:sha256:${hash}`);
  });

  it("reports ambiguous, unresolved, and unsupported compact artifact-blob hash refs explicitly", () => {
    const firstHash = `abc1234${"0".repeat(57)}`;
    const secondHash = `abc1234${"1".repeat(57)}`;
    ingestArtifact(db, { sha256: firstHash, uri: `artifact-blob:${firstHash}` }, 1000, tempDir);
    ingestArtifact(db, { sha256: secondHash, uri: `artifact-blob:${secondHash}` }, 1001, tempDir);

    const ambiguous = resolveArtifactRef(db, "artifact-blob:abc1234", 2000);
    const unresolved = resolveArtifactRef(db, "artifact-blob:fffffff", 2001);
    const unsupported = resolveArtifactRef(db, "artifact-blob:abc", 2002);

    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      artifact: null,
      alias: null,
      warnings: ["artifact_blob_ambiguous"],
    });
    expect(unresolved).toMatchObject({
      status: "unresolved",
      artifact: null,
      alias: null,
      warnings: ["artifact_blob_unresolved"],
    });
    expect(unsupported).toMatchObject({
      status: "unsupported",
      artifact: null,
      alias: null,
      warnings: ["artifact_blob_prefix_too_short"],
    });
  });

  it("resolves logical artifact and version prefixes with explicit ambiguity states", () => {
    const first = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "alpha-report",
      logical_name: "alpha.md",
      content: "alpha v1\n",
      media_type: "text/markdown",
      role: "report",
    }, 1000, tempDir);
    const second = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "alpha-report",
      logical_name: "alpha.md",
      content: "alpha v2\n",
      media_type: "text/markdown",
      role: "report",
    }, 2000, tempDir);
    recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "ambiguous-one",
      logical_name: "ambiguous-one.md",
      content: "ambiguous one\n",
      media_type: "text/markdown",
      role: "report",
    }, 3000, tempDir);
    recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "ambiguous-two",
      logical_name: "ambiguous-two.md",
      content: "ambiguous two\n",
      media_type: "text/markdown",
      role: "report",
    }, 4000, tempDir);

    const logicalKeyPrefix = resolveArtifactRef(db, "artifact:alpha-r", 5000);
    const logicalIdPrefix = resolveArtifactRef(
      db,
      `artifact:${first.series.id.replace(/^artifact-series:/, "").slice(0, 7)}`,
      5001,
    );
    const latest = resolveArtifactRef(db, "artifact:alpha-r", 5002);
    const pinned = resolveArtifactRef(
      db,
      `artifact-version:${first.version.id.replace(/^artifact-version:/, "").slice(0, 7)}`,
      5003,
    );
    const versionPrefix = resolveArtifactRef(
      db,
      `artifact-version:${second.version.id.replace(/^artifact-version:/, "").slice(0, 7)}`,
      5004,
    );
    const ambiguous = resolveArtifactRef(db, "artifact:ambiguo", 5005);
    const unresolved = resolveArtifactRef(db, "artifact:missing", 5006);
    const tooShort = resolveArtifactRef(db, "artifact:alpha", 5007);
    const versionTooShort = resolveArtifactRef(db, "artifact-version:abc", 5008);

    expect(logicalKeyPrefix).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      logical_artifact: { id: `artifact:${first.series.id.replace(/^artifact-series:/, "")}`, identity_key: "alpha-report" },
      artifact_version: { id: `artifact-version:${second.version.id.replace(/^artifact-version:/, "")}`, version_no: 2 },
      warnings: [],
    });
    expect(logicalIdPrefix).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      logical_artifact: { id: `artifact:${first.series.id.replace(/^artifact-series:/, "")}` },
      artifact_version: { version_no: 2 },
    });
    expect(latest).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      artifact_version: { version_no: 2 },
      warnings: [],
    });
    expect(pinned).toMatchObject({
      status: "resolved",
      artifact: { id: first.artifact.id },
      artifact_version: { version_no: 1 },
      warnings: [],
    });
    expect(versionPrefix).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      series: { id: first.series.id },
      version: { id: second.version.id },
      warnings: [],
    });
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      artifact: null,
      alias: null,
      warnings: ["artifact_ambiguous"],
    });
    expect(unresolved).toMatchObject({
      status: "unresolved",
      artifact: null,
      alias: null,
      warnings: ["artifact_unresolved"],
    });
    expect(tooShort).toMatchObject({
      status: "unsupported",
      artifact: null,
      alias: null,
      warnings: ["artifact_prefix_too_short"],
    });
    expect(versionTooShort).toMatchObject({
      status: "unsupported",
      artifact: null,
      alias: null,
      warnings: ["artifact_version_prefix_too_short"],
    });
  });

  it("resolves short artifact series refs through version history", () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "history-report",
      logical_name: "history.md",
      content: "history\n",
      media_type: "text/markdown",
      role: "report",
    }, 1000, tempDir);

    const history = resolveArtifactVersionHistory(db, "artifact:history");
    const versionHistory = resolveArtifactVersionHistory(
      db,
      `artifact-version:${recorded.version.id.replace(/^artifact-version:/, "").slice(0, 7)}`,
    );

    expect(history?.series.id).toBe(recorded.series.id);
    expect(history?.versions.map((version) => version.id)).toEqual([recorded.version.id]);
    expect(versionHistory?.series.id).toBe(recorded.series.id);
  });

  it("resolves repo and provider aliases without requiring issue association", () => {
    const hash = "f".repeat(64);
    createLedgerCheckout("rlrmp", path.join(tempDir, "rlrmp"));
    const artifact = ingestArtifact(db, {
      provider_id: "feedbax",
      role: "model_parameters",
      media_type: "application/x-equinox",
      sha256: hash,
      uri: "feedbax://models/baseline/parameters",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: {
        repo_id: "rlrmp",
        ref: "main",
        path: "_artifacts/b41c940/model.params.eqx",
      },
      availability: "unchecked",
    }, 1000, tempDir);

    const repoResolution = resolveArtifactRef(db, "repo://rlrmp@main/_artifacts/b41c940/model.params.eqx", 2000);
    const providerResolution = resolveArtifactRef(db, "feedbax://models/baseline/parameters", 2000);
    const repoList = listArtifacts(db, { repo: "rlrmp", scheme: "repo" });
    const providerList = listArtifacts(db, { provider: "feedbax", scheme: "feedbax" });

    expect(repoResolution).toMatchObject({ status: "resolved", artifact: { id: artifact.id } });
    expect(providerResolution).toMatchObject({ status: "resolved", artifact: { id: artifact.id } });
    expect(repoList.map((item) => item.id)).toEqual([artifact.id]);
    expect(providerList.map((item) => item.id)).toEqual([artifact.id]);
  });

  it("rejects arbitrary feature-worktree repo refs before materializing artifact rows", () => {
    createLedgerCheckout("rlrmp", path.join(tempDir, "rlrmp"));

    const resolution = resolveArtifactRef(
      db,
      "repo://feature__31e67ff-cap-independent-soft-lambda-redo@main/results/report.md",
      2000,
    );

    expect(resolution).toMatchObject({
      status: "unsupported",
      artifact: null,
      alias: null,
    });
    expect(listArtifacts(db)).toEqual([]);
  });

  it("keeps multiple contextual links for one content artifact", () => {
    const payload = { rows: [1, 2, 3] };
    const first = ingestArtifact(db, {
      role: "report",
      media_type: "application/json",
      json: payload,
      metadata: { title: "first context" },
      link: {
        entity_type: "issue",
        entity_id: "mandible/e16807c",
        link_type: "references",
        repo_id: "mandible",
        metadata: { comment: "issue mention" },
      },
    }, 1000, tempDir);
    const second = ingestArtifact(db, {
      role: "report",
      media_type: "application/json",
      json: payload,
      metadata: { title: "second context should not overwrite" },
      link: {
        entity_type: "auth_request",
        entity_id: "auth-1",
        link_type: "references",
        repo_id: "mandible",
      },
    }, 2000, tempDir);

    const detail = getArtifact(db, first.id);
    const linkedToIssue = listArtifacts(db, { linkedEntityType: "issue", linkedEntityId: "mandible/e16807c" });
    const linkedToAuth = listArtifacts(db, { linkedEntityType: "auth_request", linkedEntityId: "auth-1" });

    expect(second.id).toBe(first.id);
    expect(detail?.metadata).toMatchObject({ title: "first context" });
    expect(detail?.links?.map((link) => `${link.entity_type}:${link.entity_id}`).sort()).toEqual([
      "auth_request:auth-1",
      "issue:mandible/e16807c",
    ]);
    expect(linkedToIssue.map((item) => item.id)).toEqual([first.id]);
    expect(linkedToAuth.map((item) => item.id)).toEqual([first.id]);
  });

  it("materializes unknown scheme refs as external artifact records instead of failing", () => {
    const resolution = resolveArtifactRef(db, "zotero://library/items/ABC123", 1000);
    const row = db.prepare(
      "SELECT scheme, normalized_ref, resolution_status, artifact_id FROM artifact_aliases WHERE alias = ?"
    ).get("zotero://library/items/ABC123") as {
      scheme: string;
      normalized_ref: string;
      resolution_status: string;
      artifact_id: string | null;
    };

    expect(resolution).toMatchObject({
      status: "resolved",
      scheme: "zotero",
      artifact: {
        algorithm: "ref-sha256",
        uri: "zotero://library/items/ABC123",
        custody_mode: "external",
        availability: "remote_only",
      },
    });
    expect(row).toMatchObject({
      scheme: "zotero",
      normalized_ref: "zotero://library/items/ABC123",
      resolution_status: "resolved",
      artifact_id: resolution.artifact?.id,
    });
    expect(listArtifacts(db, { scheme: "zotero" }).map((item) => item.id)).toEqual([
      resolution.artifact?.id,
    ]);
  });

  it("does not materialize missing legacy content-hash refs as external records", () => {
    const hash = "a".repeat(64);
    const resolution = resolveArtifactRef(db, `artifact:${hash}`, 1000);
    const legacy = resolveArtifactRef(db, `artifact:sha256:${hash}`, 1000);
    const blob = resolveArtifactRef(db, `artifact-blob:${hash}`, 1000);

    expect(resolution).toMatchObject({
      status: "unresolved",
      scheme: "artifact",
      artifact: null,
    });
    expect(legacy).toMatchObject({ status: "unsupported", artifact: null, alias: null });
    expect(blob).toMatchObject({ status: "unresolved", artifact: null, alias: null });
    expect(getIndexedGraph(db, { mode: "artifact-lineage", limit: 20 }).nodes.map((node) => node.id)).not.toContain(
      `artifact:sha256:${hash}`,
    );
  });

  it("scaffolds clean tracked repo artifact output with repo_commit recoverability", () => {
    const report = "# Run report\n\nComplete.\n";
    const commit = "1234567890abcdef1234567890abcdef12345678";
    const repoRef = `repo://rlrmp@${commit}/results/run-1/report.md`;

    const artifact = ingestArtifact(db, {
      sha256: sha256(report),
      uri: repoRef,
      role: "report",
      media_type: "text/markdown",
      size_bytes: Buffer.byteLength(report),
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: {
        repo_id: "rlrmp",
        ref: commit,
        path: "results/run-1/report.md",
        git: { tracked: true, ignored: false, staged: false, dirty: false },
      },
      availability: "present",
      reference: {
        recoverability: "repo_commit",
        preferred_ref: repoRef,
        warnings: [],
        git: { tracked: true, ignored: false, staged: false, dirty: false, commit },
      },
      metadata: {
        source: "artifact_cli_contract",
        warning_codes: [],
      },
    }, 1000, tempDir);

    expect(artifact).toMatchObject({
      custody_mode: "link",
      home_repo_id: "rlrmp",
      availability: "present",
      content_hash: sha256(report),
      reference: expect.objectContaining({ recoverability: "repo_commit", preferred_ref: repoRef }),
    });
    expect(artifact.repo_locator).toMatchObject({
      repo_id: "rlrmp",
      ref: commit,
      path: "results/run-1/report.md",
    });
    expect(artifact.aliases?.map((alias) => alias.normalized_ref)).toContain(repoRef);
    expect(artifact.metadata.warning_codes).not.toContain("local_only");
    expect(artifact.reference.warnings).not.toContain("local_only");
  });

  it("scaffolds ignored local repo artifacts as local_only without repo_commit claims", () => {
    const checkpointPath = path.join(tempDir, "repo", "_artifacts", "run-1", "checkpoint.bin");
    const checkpoint = Buffer.from("checkpoint bytes");
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(checkpointPath, checkpoint);

    const artifact = ingestArtifact(db, {
      sha256: sha256(checkpoint),
      uri: `file://${checkpointPath}`,
      role: "model_checkpoint",
      media_type: "application/octet-stream",
      size_bytes: checkpoint.length,
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: {
        repo_id: "rlrmp",
        path: "_artifacts/run-1/checkpoint.bin",
        git: { tracked: false, ignored: true, staged: false, dirty: false },
      },
      availability: "present",
      reference: {
        recoverability: "local_only",
        preferred_ref: `artifact:${sha256(checkpoint)}`,
        warnings: ["local_only"],
        git: { tracked: false, ignored: true, staged: false, dirty: false },
      },
      metadata: {
        source: "artifact_cli_contract",
        warning_codes: ["local_only"],
      },
    }, 1000, tempDir);

    expect(artifact).toMatchObject({
      custody_mode: "link",
      availability: "present",
      content_hash: sha256(checkpoint),
      reference: expect.objectContaining({ recoverability: "local_only" }),
    });
    expect(artifact.metadata.warning_codes).toContain("local_only");
    expect(artifact.reference.warnings).toContain("local_only");
    expect(artifact.reference).not.toMatchObject({ recoverability: "repo_commit" });
    expect(artifact.repo_locator).not.toMatchObject({ ref: expect.any(String) });
  });

  it("registers clean tracked local paths as commit-pinned repo artifacts", () => {
    const repoRoot = path.join(tempDir, "tracked-repo");
    const reportPath = path.join(repoRoot, "results", "report.md");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" });
    git(repoRoot, ["config", "user.email", "test@example.invalid"]);
    git(repoRoot, ["config", "user.name", "Test User"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(reportPath, "# Report\n", "utf8");
    git(repoRoot, ["add", "results/report.md"]);
    git(repoRoot, ["commit", "-m", "add report"]);
    const commit = git(repoRoot, ["rev-parse", "HEAD"]);
    createLedgerCheckout("mandible", fs.realpathSync(repoRoot));

    const registered = registerLocalArtifactPath(db, {
      path: reportPath,
      role: "report",
    }, 1000, tempDir);
    const check = checkArtifactMaterialization(db, registered.artifact.id);

    expect(registered).toMatchObject({
      recoverability: "repo_commit",
      warnings: [],
      artifact: {
        custody_mode: "link",
        availability: "present",
        home_repo_id: "mandible",
        repo_locator: {
          repo_id: "mandible",
          ref: commit,
          commit,
          path: "results/report.md",
        },
        metadata: expect.objectContaining({ recoverability: "repo_commit" }),
      },
    });
    expect(registered.artifact.uri).toBe(`repo://mandible@${commit}/results/report.md`);
    expect(check).toMatchObject({
      materializable: true,
      hash_matches: true,
      recoverability: "repo_commit",
      source: expect.stringContaining(`repo_commit:mandible@${commit}:results/report.md`),
    });
  });

  it("canonicalizes a registered feature worktree checkout to the project key", () => {
    const mainRepo = path.join(tempDir, "rlrmp-main");
    initGitRepo(mainRepo);
    const commit = commitRepoFile(mainRepo, "results/report.md", "# Report\n");
    const featureRoot = path.join(tempDir, "worktrees", "feature__31e67ff-redo");
    fs.mkdirSync(path.dirname(featureRoot), { recursive: true });
    git(mainRepo, ["worktree", "add", "-b", "feature/31e67ff-redo", featureRoot]);
    createLedgerCheckout("rlrmp", fs.realpathSync(mainRepo));
    createLedgerCheckout("feature__31e67ff-redo", fs.realpathSync(featureRoot), {
      projectKey: "rlrmp",
      workRepoId: "feature__31e67ff-redo",
    });

    const registered = registerLocalArtifactPath(db, {
      path: path.join(featureRoot, "results", "report.md"),
      role: "report",
    }, 1000, tempDir);

    expect(registered.artifact).toMatchObject({
      home_repo_id: "rlrmp",
      repo_locator: {
        repo_id: "rlrmp",
        ref: commit,
        commit,
        path: "results/report.md",
      },
    });
    expect(registered.artifact.uri).toBe(`repo://rlrmp@${commit}/results/report.md`);
    expect(registered.artifact.uri).not.toContain("feature__31e67ff-redo");
  });

  it("resolves an unregistered feature worktree through the registered common git dir", () => {
    const mainRepo = path.join(tempDir, "rlrmp-main");
    initGitRepo(mainRepo);
    const commit = commitRepoFile(mainRepo, "results/report.md", "# Report\n");
    const featureRoot = path.join(tempDir, "worktrees", "feature__unregistered");
    fs.mkdirSync(path.dirname(featureRoot), { recursive: true });
    git(mainRepo, ["worktree", "add", "-b", "feature/unregistered", featureRoot]);
    createLedgerCheckout("rlrmp", fs.realpathSync(mainRepo));

    const registered = registerLocalArtifactPath(db, {
      path: path.join(featureRoot, "results", "report.md"),
      role: "report",
    }, 1000, tempDir);

    expect(registered.artifact).toMatchObject({
      home_repo_id: "rlrmp",
      repo_locator: {
        repo_id: "rlrmp",
        ref: commit,
        path: "results/report.md",
      },
    });
    expect(registered.artifact.uri).toBe(`repo://rlrmp@${commit}/results/report.md`);
  });

  it("fails closed for clean tracked files in unknown repos instead of inventing repo ids", () => {
    const repoRoot = path.join(tempDir, "unknown-feature");
    initGitRepo(repoRoot);
    commitRepoFile(repoRoot, "results/report.md", "# Report\n");

    const registered = registerLocalArtifactPath(db, {
      path: path.join(repoRoot, "results", "report.md"),
      role: "report",
    }, 1000, tempDir);

    expect(registered.recoverability).toBe("local_only");
    expect(registered.warnings).toEqual(
      expect.arrayContaining(["unknown_repo_identity", "local_only_link_requires_override_for_issue_evidence"]),
    );
    expect(registered.artifact.home_repo_id).toBeNull();
    expect(registered.artifact.repo_locator).toEqual({});
    expect(registered.artifact.uri).toMatch(/^file:\/\//);
    expect(registered.artifact.uri).not.toContain("repo://unknown-feature");
  });

  it("links existing repo and artifact refs directly to issues", () => {
    const issueId = createLedgerIssue(
      "mandible",
      "44074ed",
      "Artifact CLI for custody-aware registration, bundles, and issue links",
    );
    const repoResolution = resolveArtifactRef(
      db,
      "repo://mandible@1234567890abcdef1234567890abcdef12345678/results/run-1/report.md",
      1000,
    );
    const hash = "b".repeat(64);
    ingestArtifact(db, {
      sha256: hash,
      uri: `artifact-blob:${hash}`,
      custody_mode: "external",
      availability: "remote_only",
    }, 1000, tempDir);
    const hashResolution = resolveArtifactRef(db, `artifact-blob:${hash}`, 1000);

    const repoLink = resolveAndLinkArtifact(db, {
      ref: repoResolution.normalized_ref,
      entity_type: "issue",
      entity_id: "44074ed",
      issue_project: "mandible",
      link_type: "evidence",
      role: "report",
      repo_id: "mandible",
      source: "artifact_cli",
      metadata: { input_ref: repoResolution.normalized_ref },
    }, 2000).link;
    const hashLink = resolveAndLinkArtifact(db, {
      ref: `artifact-blob:${hash}`,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "external_hash",
      repo_id: "mandible",
      source: "artifact_cli",
      metadata: { input_ref: hashResolution.normalized_ref },
    }, 2000).link;

    expect(repoLink).toMatchObject({
      artifact_id: repoResolution.artifact?.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "evidence",
      role: "report",
      source: "artifact_cli",
    });
    expect(hashLink).toMatchObject({
      artifact_id: hashResolution.artifact?.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "external_hash",
    });
    expect(listArtifacts(db, { linkedEntityType: "issue", linkedEntityId: issueId }).map((item) => item.id).sort())
      .toEqual([hashResolution.artifact?.id, repoResolution.artifact?.id].sort());
  });

  it("distinguishes repo artifact hash mismatch from missing bytes", () => {
    const repoRoot = path.join(tempDir, "repo");
    const reportPath = path.join(repoRoot, "results", "report.md");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, "original\n", "utf8");
    createLedgerCheckout("rlrmp", repoRoot);

    const artifact = ingestArtifact(db, {
      sha256: sha256("original\n"),
      uri: "repo://rlrmp@main/results/report.md",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", ref: "main", path: "results/report.md" },
      availability: "present",
    }, 1000, tempDir);

    fs.writeFileSync(reportPath, "changed\n", "utf8");
    const mismatched = getArtifactContent(db, artifact.id);
    fs.rmSync(reportPath);
    const missing = getArtifactContent(db, artifact.id);

    expect(mismatched).toMatchObject({
      status: "unavailable",
      reason: "artifact bytes do not match registered sha256",
      download: { available: false, reason: "artifact bytes do not match registered sha256" },
    });
    expect(missing).toMatchObject({
      status: "unavailable",
      reason: "artifact bytes are not available on disk",
      download: { available: false, reason: "artifact bytes are not available on disk" },
    });
    expect(mismatched?.reason).not.toBe(missing?.reason);
  });

  it("promotes a hash-only external artifact when bytes are snapshotted into Mandible custody", () => {
    const content = "external bytes\n";
    const hash = sha256(content);
    ingestArtifact(db, {
      sha256: hash,
      uri: `artifact-blob:${hash}`,
      custody_mode: "external",
      availability: "remote_only",
    }, 1000, tempDir);
    const external = resolveArtifactRef(db, `artifact-blob:${hash}`, 1000);

    expect(external.artifact).toMatchObject({
      id: `artifact:sha256:${hash}`,
      custody_mode: "external",
      availability: "remote_only",
    });

    const snapshotted = snapshotArtifactBytes(db, {
      ref: `artifact-blob:${hash}`,
      content,
      media_type: "text/plain",
      filename: "external.txt",
      custody_mode: "copy",
      reference: {
        snapshot_of: external.artifact?.id,
      },
    }, 2000, tempDir);
    const contentResult = getArtifactContent(db, snapshotted.id);

    expect(snapshotted).toMatchObject({
      id: external.artifact?.id,
      custody_mode: "copy",
      availability: "present",
      uri: expect.stringMatching(/^file:\/\//),
    });
    expect(contentResult).toMatchObject({
      status: "available",
      source: { kind: "managed_file" },
      download: { available: true, filename: "external.txt" },
    });
  });

  it("ingests multi-MiB bytes from a daemon-visible content_path without inline base64 (issue 833e972)", () => {
    const big = crypto.randomBytes(3 * 1024 * 1024); // 3 MiB, well over OS ARG_MAX
    const srcPath = path.join(tempDir, "big-ingest.bin");
    fs.writeFileSync(srcPath, big);

    const artifact = ingestArtifact(db, {
      content_path: srcPath,
      sha256: sha256(big),
      filename: "big-ingest.bin",
      media_type: "application/octet-stream",
      custody_mode: "copy",
      availability: "present",
    }, 1000, tempDir);

    expect(artifact).toMatchObject({
      id: `artifact:sha256:${sha256(big)}`,
      custody_mode: "copy",
      availability: "present",
      size_bytes: big.length,
    });
    const stored = getArtifactContent(db, artifact.id);
    expect(stored).toMatchObject({ status: "available", download: { available: true } });
  });

  it("rejects a content_path ingest whose declared sha256 disagrees with the bytes (issue 833e972)", () => {
    const big = crypto.randomBytes(2 * 1024 * 1024);
    const srcPath = path.join(tempDir, "mismatch.bin");
    fs.writeFileSync(srcPath, big);

    expect(() =>
      ingestArtifact(db, {
        content_path: srcPath,
        sha256: sha256("a different declared value"),
        custody_mode: "copy",
        availability: "present",
      }, 1000, tempDir),
    ).toThrow(/sha256 does not match supplied content/);
  });

  it("snapshots a multi-MiB content_path and still rejects declared-hash mismatch (issue 833e972)", () => {
    const big = crypto.randomBytes(4 * 1024 * 1024); // 4 MiB
    const srcPath = path.join(tempDir, "big-snapshot.bin");
    fs.writeFileSync(srcPath, big);

    const snapshotted = snapshotArtifactBytes(db, {
      content_path: srcPath,
      media_type: "application/octet-stream",
      filename: "big-snapshot.bin",
      custody_mode: "copy",
    }, 1000, tempDir);

    expect(snapshotted).toMatchObject({
      id: `artifact:sha256:${sha256(big)}`,
      custody_mode: "copy",
      availability: "present",
      size_bytes: big.length,
      uri: expect.stringMatching(/^file:\/\//),
    });
    expect(getArtifactContent(db, snapshotted.id)).toMatchObject({
      status: "available",
      download: { available: true },
    });

    // Declared-hash integrity must survive the path/buffer transport: a snapshot
    // onto a ref whose registered sha differs from the bytes is rejected.
    const otherHash = sha256("registered-as-something-else");
    ingestArtifact(db, {
      sha256: otherHash,
      uri: `artifact-blob:${otherHash}`,
      custody_mode: "external",
      availability: "remote_only",
    }, 1500, tempDir);
    const conflictPath = path.join(tempDir, "conflict.bin");
    fs.writeFileSync(conflictPath, crypto.randomBytes(1024 * 1024));
    expect(() =>
      snapshotArtifactBytes(db, {
        ref: `artifact-blob:${otherHash}`,
        content_path: conflictPath,
        custody_mode: "copy",
      }, 2000, tempDir),
    ).toThrow(/do not match registered sha256/);
  });

  it("copies a multi-MiB local path into custody via a single buffered read (issue 833e972)", () => {
    const big = crypto.randomBytes(3 * 1024 * 1024);
    const srcPath = path.join(tempDir, "local-copy.bin");
    fs.writeFileSync(srcPath, big);

    const registration = registerLocalArtifactPath(db, {
      path: srcPath,
      custody_mode: "copy",
      filename: "local-copy.bin",
    }, 1000, tempDir);

    expect(registration.artifact).toMatchObject({
      id: `artifact:sha256:${sha256(big)}`,
      custody_mode: "copy",
      availability: "present",
      size_bytes: big.length,
    });
    expect(getArtifactContent(db, registration.artifact.id)).toMatchObject({
      status: "available",
      download: { available: true },
    });
  });

  it("preserves member refs and recoverability in mixed tracked/local bundle manifests", () => {
    const commit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const runJson = '{"status":"complete"}\n';
    const checkpoint = Buffer.from("checkpoint");
    const tracked = ingestArtifact(db, {
      sha256: sha256(runJson),
      uri: `repo://rlrmp@${commit}/results/run-7/run.json`,
      role: "run_record",
      media_type: "application/json",
      size_bytes: Buffer.byteLength(runJson),
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", ref: commit, path: "results/run-7/run.json" },
      availability: "present",
      reference: { recoverability: "repo_commit", warnings: [] },
    }, 1000, tempDir);
    const local = ingestArtifact(db, {
      sha256: sha256(checkpoint),
      uri: "file:///tmp/rlrmp/_artifacts/run-7/checkpoint.bin",
      role: "model_checkpoint",
      media_type: "application/octet-stream",
      size_bytes: checkpoint.length,
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", path: "_artifacts/run-7/checkpoint.bin" },
      availability: "present",
      reference: { recoverability: "local_only", warnings: ["local_only"] },
      metadata: { warning_codes: ["local_only"] },
    }, 1000, tempDir);
    const figure = ingestArtifact(db, {
      sha256: sha256("figure\n"),
      uri: "file:///tmp/rlrmp/_artifacts/run-7/figure.png",
      role: "figure",
      media_type: "image/png",
      size_bytes: Buffer.byteLength("figure\n"),
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", path: "_artifacts/run-7/figure.png" },
      availability: "present",
      reference: { recoverability: "local_only", warnings: ["local_only"] },
    }, 1000, tempDir);
    const bundleResult = createArtifactBundle(db, {
      name: "run-7 packet",
      role: "artifact_bundle",
      members: [
        { ref: `artifact-blob:${tracked.content_hash}`, role: "run_record" },
        { ref: `artifact-blob:${local.content_hash}`, role: "model_checkpoint", metadata: { warning_codes: ["local_only"] } },
      ],
    }, 2000, tempDir);
    const bundle = bundleResult.bundle;
    const appended = addArtifactBundleMembers(db, bundle.id, [
      { ref: `artifact-blob:${figure.content_hash}`, role: "figure" },
    ], 3000);

    const trackedDetail = getArtifact(db, tracked.id);
    const localDetail = getArtifact(db, local.id);
    const figureDetail = getArtifact(db, figure.id);
    const bundleDetail = getArtifactBundle(db, bundle.id);
    const bundleContent = getArtifactContent(db, bundle.id);

    expect(bundle).toMatchObject({
      role: "artifact_bundle",
      custody_mode: "managed",
      availability: "present",
      reference: expect.objectContaining({ identity_kind: "artifact_bundle" }),
    });
    expect(bundleResult.members).toHaveLength(2);
    expect(appended.members.map((member) => member.artifact.id).sort()).toEqual([figure.id, local.id, tracked.id].sort());
    expect(bundleDetail?.members.map((member) => member.artifact.id).sort()).toEqual([figure.id, local.id, tracked.id].sort());
    expect(trackedDetail?.reference).toMatchObject({ recoverability: "repo_commit" });
    expect(localDetail?.reference).toMatchObject({ recoverability: "local_only" });
    expect(trackedDetail?.links).toContainEqual(expect.objectContaining({
      entity_type: "artifact_bundle",
      entity_id: bundle.id,
      link_type: "bundle_member",
      role: "run_record",
    }));
    expect(localDetail?.links).toContainEqual(expect.objectContaining({
      entity_type: "artifact_bundle",
      entity_id: bundle.id,
      link_type: "bundle_member",
      role: "model_checkpoint",
      metadata: expect.objectContaining({ warning_codes: ["local_only"] }),
    }));
    expect(figureDetail?.links).toContainEqual(expect.objectContaining({
      entity_type: "artifact_bundle",
      entity_id: bundle.id,
      link_type: "bundle_member",
      role: "figure",
    }));
    expect(bundleContent?.preview?.text).toContain(tracked.id);
    expect(bundleContent?.preview?.text).toContain(local.id);
  });

  it("keeps repo artifact discovery dry-run read-only and scan registration mutating", () => {
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "results"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "results", "summary.md"), "# Summary\n", "utf8");
    createLedgerCheckout("mandible", repoRoot);

    const dryRun = scanRepoArtifacts(db, {
      roots: [{ root: repoRoot, repo_id: "mandible", name: "Mandible", default_branch: "main" }],
      register: false,
      now: 1000,
    });
    const afterDryRun = listArtifacts(db);
    const registered = scanRepoArtifacts(db, {
      roots: [{ root: repoRoot, repo_id: "mandible", name: "Mandible", default_branch: "main" }],
      now: 2000,
    });

    expect(dryRun.discovered).toBe(1);
    expect(dryRun).toMatchObject({ ingested: 0, artifacts: [] });
    expect(dryRun.discovered_artifacts?.[0]).toMatchObject({ relative_path: "results/summary.md" });
    expect(afterDryRun).toEqual([]);
    expect(registered).toMatchObject({ discovered: 1, ingested: 1 });
    expect(listArtifacts(db).map((artifact) => artifact.repo_locator.path)).toEqual(["results/summary.md"]);
  });

  it("ingests provider manifests into lineage graph nodes and edges", () => {
    const manifest = ingestProviderManifest(db, {
      provider_id: "feedbax",
      manifest: {
        provider: { id: "feedbax", name: "Feedbax" },
        entities: [
          { id: "run-1", type: "run", title: "Training run 1", status: "complete", metrics: { loss: 0.12 } },
          { id: "analysis-1", type: "analysis", title: "Robustness analysis" },
        ],
        artifacts: [
          { id: "trajectory-table", title: "Trajectory table", summary: { rows: 32 } },
        ],
        edges: [
          { source: "run-1", target: "analysis-1", type: "produced" },
          { source: "analysis-1", target: "trajectory-table", type: "produced" },
        ],
      },
    }, 1000, tempDir);

    expect(manifest.id).toMatch(/^provider_manifest:feedbax:/);
    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 50 });
    expect(getIndexedGraphCount(db, "provider-lineage")).toBeGreaterThanOrEqual(5);
    expect(graph.nodes.map((node) => node.type)).toContain("provider");
    expect(graph.nodes.map((node) => node.type)).toContain("provider_manifest");
    expect(graph.nodes.map((node) => node.type)).toContain("run");
    expect(graph.nodes.map((node) => node.type)).toContain("analysis");
    expect(graph.nodes.map((node) => node.type)).toContain("artifact");
    expect(graph.edges.map((edge) => edge.type)).toContain("provider_emitted_manifest");
    expect(graph.edges.map((edge) => edge.type)).toContain("produced");
  });

  it("normalizes native Feedbax provider capability manifests", () => {
    ingestProviderManifest(db, {
      manifest: {
        provider: "feedbax",
        kind: "experiment_provider",
        version: "feedbax-provider.v1",
        feedbax_version: "0.1.0",
        schema_version: "feedbax.manifest.v1",
        health: { check: "python:feedbax.provider.health" },
        capabilities: {
          validate_graph_spec: {
            input_schema: "GraphSpec",
            output_schema: "ProviderValidationResult",
            requires_review: false,
          },
          start_training_run: {
            input_schema: "TrainingSpec",
            output_schema: "TrainingRunManifest",
            requires_review: true,
          },
        },
        artifact_roles: ["training_checkpoint", "training_history"],
        schemas: { GraphSpec: { type: "object" } },
        entry_points: {
          cli: "feedbax-provider manifest",
          http: "/api/provider/manifest",
        },
      },
    }, 1000, tempDir);

    const capabilities = getProviderCapabilities(db, "feedbax");
    expect(capabilities?.provider.display_name).toBe("Feedbax");
    expect(capabilities?.capabilities.validate_graph_spec).toMatchObject({
      input_schema: "GraphSpec",
    });
    expect(capabilities?.artifact_roles).toEqual(["training_checkpoint", "training_history"]);
    expect(capabilities?.actions.some((action) => action.id === "feedbax.start_training_run" && action.requires_auth)).toBe(true);

    const health = getProviderHealth(db, "feedbax");
    expect(health?.status).toBe("active");
    expect(health?.health).toMatchObject({ check: "python:feedbax.provider.health" });
  });

  it("normalizes native Feedbax training manifests into provider lineage", () => {
    const checkpointHash = "a".repeat(64);
    const graphHash = "b".repeat(64);
    const trainingHash = "c".repeat(64);
    const taskHash = "d".repeat(64);
    ingestProviderManifest(db, {
      manifest: {
        provider: "feedbax",
        kind: "experiment_provider",
        version: "feedbax-provider.v1",
        schema_version: "feedbax.manifest.v1",
        capabilities: {
          start_training_run: {
            input_schema: "TrainingSpec",
            output_schema: "TrainingRunManifest",
            requires_review: true,
          },
        },
      },
    }, 500, tempDir);

    const manifest = ingestProviderManifest(db, {
      manifest: {
        kind: "TrainingRunManifest",
        schema_version: "feedbax.manifest.v1",
        id: "feedbax-training-run:stub-job",
        created_at: "2026-05-17T12:00:00Z",
        feedbax_version: "0.1.0",
        provider_version: "feedbax-provider.v1",
        status: "completed",
        job_id: "stub-job",
        summary_metrics: { final_loss: 0.25, total_batches: 1 },
        provenance: {
          source_repo: "https://example.invalid/feedbax.git",
          source_branch: "develop",
          source_commit: "abc123",
          dirty: false,
          issues: ["5429a23"],
          parents: [
            { kind: "GraphSpecManifest", id: "feedbax-graph:baseline", role: "graph_spec" },
          ],
        },
        graph_spec: {
          kind: "GraphSpec",
          inline: { nodes: {}, wires: [] },
          sha256: graphHash,
        },
        training_spec: {
          kind: "TrainingSpec",
          inline: { n_batches: 1 },
          sha256: trainingHash,
        },
        task_spec: {
          kind: "TaskSpec",
          inline: { type: "SimpleReaches" },
          sha256: taskHash,
        },
        artifacts: [
          {
            role: "training_checkpoint",
            logical_name: "feedbax_checkpoint_stub-job.eqx",
            artifact_id: `artifact:${checkpointHash}`,
            sha256: checkpointHash,
            media_type: "application/x-equinox",
            size_bytes: 16,
            storage_backend: "feedbax-local",
            uri: "/tmp/feedbax_checkpoint_stub-job.eqx",
            metadata: { relative_path: "artifacts/sha256/aa/checkpoint.eqx" },
          },
        ],
      },
    }, 1000, tempDir);

    expect(manifest.provider_id).toBe("feedbax");
    expect(manifest.manifest_type).toBe("TrainingRunManifest");
    expect(getArtifact(db, `artifact:sha256:${checkpointHash}`)).toMatchObject({
      id: `artifact:sha256:${checkpointHash}`,
      provider_id: "feedbax",
      manifest_id: manifest.id,
      role: "training_checkpoint",
      size_bytes: 16,
    });

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 100 });
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edgeTypes = graph.edges.map((edge) => edge.type);
    expect(nodeIds).toContain("provider:feedbax");
    expect(nodeIds).toContain(manifest.id);
    expect(nodeIds).toContain("run:feedbax:feedbax-training-run:stub-job");
    expect(nodeIds).toContain(`artifact:sha256:${checkpointHash}`);
    expect(graph.nodes.some((node) => node.type === "provider_spec" && node.detail?.manifest_id === manifest.id)).toBe(true);
    expect(edgeTypes).toContain("manifest_declares");
    expect(edgeTypes).toContain("manifest_references_artifact");
    expect(edgeTypes).toContain("produced");
    expect(edgeTypes).toContain("run_used_spec");
    expect(edgeTypes).toContain("derived_from");
    expect(edgeTypes).toContain("requested_by");
    expect(getProviderCapabilities(db, "feedbax")?.actions).toContainEqual(
      expect.objectContaining({ id: "feedbax.start_training_run", requires_auth: true }),
    );
  });

  it("resolves native provider issue refs to canonical ledger issue graph nodes", () => {
    const issueId = createLedgerIssue("rlrmp", "b41c940", "Migrate RLRMP Feedbax models");

    ingestProviderManifest(db, {
      manifest: {
        kind: "TrainingRunManifest",
        schema_version: "feedbax.manifest.v1",
        id: "run-with-ledger-issue",
        status: "completed",
        provenance: {
          issues: ["rlrmp/b41c940"],
        },
      },
    }, 1000, tempDir);

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 100 });
    const issueNode = graph.nodes.find((node) => node.id === "issue:rlrmp:b41c940");
    expect(issueNode).toMatchObject({
      type: "issue",
      label: "Migrate RLRMP Feedbax models",
      repo_id: "rlrmp",
      detail: expect.objectContaining({ ledger_issue_id: issueId }),
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "issue:rlrmp:b41c940",
      target: "run:feedbax:run-with-ledger-issue",
      type: "requested_by",
      metadata: expect.objectContaining({
        issue_ref: "rlrmp/b41c940",
        ledger_issue_id: issueId,
        resolution_status: "resolved",
      }),
    }));
  });

  it("keeps provider-scoped issue refs when ledger resolution is unresolved or ambiguous", () => {
    createLedgerIssue("alpha", "dupe123", "Alpha duplicate");
    createLedgerIssue("beta", "dupe123", "Beta duplicate");

    ingestProviderManifest(db, {
      manifest: {
        kind: "TrainingRunManifest",
        schema_version: "feedbax.manifest.v1",
        id: "run-with-ambiguous-issues",
        status: "completed",
        provenance: {
          issues: ["dupe123", "missing123"],
        },
      },
    }, 1000, tempDir);

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 100 });
    expect(graph.nodes.find((node) => node.id === "issue:feedbax:dupe123")?.detail?.resolution).toMatchObject({
      resolution_status: "ambiguous",
      candidate_count: 2,
    });
    expect(graph.nodes.find((node) => node.id === "issue:feedbax:missing123")?.detail?.resolution).toMatchObject({
      resolution_status: "unresolved",
      candidate_count: 0,
    });
  });

  it("normalizes Feedbax model artifact manifests and role-addressed stores", () => {
    const issueId = createLedgerIssue("rlrmp", "b41c940", "Migrate RLRMP Feedbax models");
    const parameterHash = "1".repeat(64);
    const graphHash = "2".repeat(64);
    const parentHash = "3".repeat(64);

    const manifest = ingestProviderManifest(db, {
      manifest: {
        kind: "ModelArtifactManifest",
        schema_version: "feedbax.manifest.v1",
        id: "feedbax-model:baseline",
        status: "available",
        feedbax_version: "0.1.0",
        provider_version: "feedbax-provider.v1",
        provenance: {
          issues: ["rlrmp/b41c940"],
          parents: [
            { kind: "TrainingRunManifest", id: "feedbax-training-run:stub-job", role: "checkpoint" },
          ],
        },
        graph_spec: {
          kind: "GraphSpec",
          id: "feedbax-graph:baseline",
          sha256: graphHash,
        },
        parameter_store: {
          artifact_id: `artifact:${parameterHash}`,
          sha256: parameterHash,
          logical_name: "model.params.eqx",
          media_type: "application/x-equinox",
          size_bytes: 64,
          storage_backend: "feedbax-local",
          uri: "/tmp/feedbax/model.params.eqx",
          array_roles: ["parameter"],
          custody_mode: "link",
          home_repo_id: "rlrmp",
          repo_locator: { repo_id: "rlrmp", path: "_artifacts/b41c940/model.params.eqx" },
        },
        state_store: {
          artifact_id: `artifact:${parentHash}`,
          sha256: parentHash,
          logical_name: "model.state.eqx",
          storage_backend: "feedbax-local",
        },
        validation_records: [{ validator: "feedbax", status: "passed" }],
        migration_records: [{ from: "legacy-equinox", to: "graph-spec" }],
      },
    }, 1000, tempDir);

    expect(manifest.manifest_type).toBe("ModelArtifactManifest");
    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 200 });
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edgeTypes = graph.edges.map((edge) => edge.type);

    expect(nodeIds).toContain("model:feedbax:feedbax-model:baseline");
    expect(nodeIds).toContain(`artifact:sha256:${parameterHash}`);
    expect(nodeIds).toContain("provider_spec:feedbax:feedbax-graph:baseline");
    expect(nodeIds).toContain("issue:rlrmp:b41c940");
    expect(edgeTypes).toContain("model_references_store");
    expect(edgeTypes).toContain("model_used_spec");
    expect(edgeTypes).toContain("derived_from");
    expect(edgeTypes).toContain("requested_by");

    const parameterArtifact = getArtifact(db, `artifact:sha256:${parameterHash}`);
    expect(parameterArtifact).toMatchObject({
      role: "parameter_store",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      manifest_id: manifest.id,
    });
    expect(parameterArtifact?.metadata).toMatchObject({ store_field: "parameter_store" });
    expect(parameterArtifact?.repo_locator).toMatchObject({ repo_id: "rlrmp" });
    expect(graph.nodes.find((node) => node.id === "model:feedbax:feedbax-model:baseline")?.detail).toMatchObject({
      validation_records: [{ validator: "feedbax", status: "passed" }],
      migration_records: [{ from: "legacy-equinox", to: "graph-spec" }],
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "issue:rlrmp:b41c940",
      target: "model:feedbax:feedbax-model:baseline",
      metadata: expect.objectContaining({ ledger_issue_id: issueId }),
    }));
  });

  it("serves managed JSON previews from registered artifact storage", () => {
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      json: { accuracy: 0.95 },
      filename: "metrics.json",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      media_type: "application/json",
      source: { kind: "managed_file" },
      download: { available: true, filename: "metrics.json" },
    });
    expect(content?.preview?.text).toContain('"accuracy": 0.95');
  });

  it("keeps raw compact JSON available when the preview is auto-formatted", () => {
    const compact = '{"accuracy":0.95,"tags":["fast","stable"]}';
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: compact,
      filename: "metrics.json",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      preview: {
        raw_text: compact,
        formatted: "json",
      },
    });
    expect(content?.preview?.text).toContain('\n  "accuracy": 0.95,');
  });

  it("keeps tiny JSON previews on the async fallback path", async () => {
    const compact = '{"accuracy":0.95,"tags":["fast","stable"]}';
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: compact,
      filename: "metrics.json",
    }, 1000, tempDir);

    const content = await getArtifactContentAsync(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      preview: {
        raw_text: compact,
        formatted: "json",
      },
    });
    expect(content?.preview?.text).toContain('\n  "accuracy": 0.95,');
  });

  it("auto-formats compact JSON beyond the default text preview window", () => {
    const compact = JSON.stringify({
      adam_grid: {
        initialization: "zero",
        learning_rates: [1e-5, 5e-5, 1e-4],
        steps: Array.from({ length: 40_000 }, (_value, index) => index),
      },
    });
    expect(compact.length).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(compact)).toBeLessThan(1024 * 1024);
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: compact,
      filename: "adam_soft_lambda_redo.json",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      preview: {
        raw_text: compact,
        formatted: "json",
        truncated: false,
      },
    });
    expect(content?.preview?.text).toContain('\n  "adam_grid": {');
    expect(content?.preview?.text).toContain('\n      39999\n');
  });

  it("offloads non-trivial JSON preview formatting and hash validation", async () => {
    const compact = JSON.stringify({
      adam_grid: {
        initialization: "zero",
        learning_rates: [1e-5, 5e-5, 1e-4],
        steps: Array.from({ length: 40_000 }, (_value, index) => index),
      },
    });
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: compact,
      filename: "adam_soft_lambda_redo.json",
    }, 1000, tempDir);

    let contentResolved = false;
    const contentPromise = getArtifactContentAsync(db, artifact.id).finally(() => {
      contentResolved = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(contentResolved).toBe(false);
    const content = await contentPromise;

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      warnings: [],
      preview: {
        raw_text: compact,
        formatted: "json",
        truncated: false,
      },
    });
    expect(content?.preview?.text).toContain('\n  "adam_grid": {');
    expect(content?.preview?.text).toContain('\n      39999\n');
  });

  it("falls back to raw text for malformed JSON on the async worker path", async () => {
    const malformed = `{"payload":"${"x".repeat(20 * 1024)}"`;
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: malformed,
      filename: "broken-metrics.json",
    }, 1000, tempDir);

    const content = await getArtifactContentAsync(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      preview: {
        text: malformed,
        truncated: false,
      },
    });
    expect(content?.preview?.raw_text).toBeUndefined();
    expect(content?.preview?.formatted).toBeUndefined();
  });

  it("serves only a bounded initial slice for reported-size JSON previews", () => {
    const targetBytes = 1_781_484;
    const emptyJsonBytes = Buffer.byteLength(JSON.stringify({ payload: "" }));
    const compact = JSON.stringify({ payload: "x".repeat(targetBytes - emptyJsonBytes) });
    expect(Buffer.byteLength(compact)).toBe(targetBytes);
    const artifact = ingestArtifact(db, {
      role: "metrics",
      media_type: "application/json",
      content: compact,
      filename: "large-metrics.json",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "json",
      warnings: ["large artifact preview defers full sha256 validation"],
      preview: {
        truncated: true,
        format_skipped: "partial_preview",
      },
    });
    expect(content?.preview?.text).toBe(compact.slice(0, 256 * 1024));
    expect(content?.preview?.raw_text).toBeUndefined();
    expect(content?.preview?.formatted).toBeUndefined();
    expect(content?.preview?.preview_bytes).toBe(256 * 1024);
    expect(content?.preview?.total_bytes).toBe(Buffer.byteLength(compact));
    expect(content?.preview?.omitted_bytes).toBe(Buffer.byteLength(compact) - (256 * 1024));
  });

  it("returns binary download metadata without inline preview", () => {
    const payload = Buffer.from([0, 1, 2, 3, 4]);
    const artifact = ingestArtifact(db, {
      media_type: "application/octet-stream",
      content_base64: payload.toString("base64"),
      filename: "model.bin",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "binary",
      preview: null,
      download: {
        available: true,
        media_type: "application/octet-stream",
        size_bytes: payload.length,
        filename: "model.bin",
      },
    });
  });

  it("previews source-like UTF-8 artifacts as text despite octet-stream media type", () => {
    const source = "def train():\n    return 1\n";
    const artifact = ingestArtifact(db, {
      media_type: "application/octet-stream",
      content: source,
      filename: "train.py",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "text",
      media_type: "application/octet-stream",
      preview: { encoding: "utf-8", text: source, truncated: false },
    });
  });

  it("keeps source-like filenames binary when bytes are not safe UTF-8", () => {
    const payload = Buffer.from([0, 1, 2, 3, 4]);
    const artifact = ingestArtifact(db, {
      media_type: "application/octet-stream",
      content_base64: payload.toString("base64"),
      filename: "train.py",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "binary",
      preview: null,
    });
  });

  it("serves present link-custody local file URI previews", () => {
    const outsidePath = path.join(tempDir, "outside.txt");
    fs.writeFileSync(outsidePath, "not managed\n", "utf8");
    const artifact = ingestArtifact(db, {
      sha256: sha256("not managed\n"),
      media_type: "text/plain",
      uri: `file://${outsidePath}`,
      custody_mode: "link",
      availability: "present",
      reference: { recoverability: "local_only" },
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "text",
      source: { kind: "local_file", locator: `file://${outsidePath}` },
      download: { available: true },
    });
    expect(content?.preview?.text).toBe("not managed\n");
  });

  it("falls back to a resolved local file alias when the primary local link path is missing", () => {
    const missingPath = path.join(tempDir, "old-worktree", "detail.json");
    const aliasPath = path.join(tempDir, "repo", "_artifacts", "detail.json");
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.writeFileSync(aliasPath, '{"status":"current"}\n', "utf8");
    const artifact = ingestArtifact(db, {
      sha256: sha256('{"status":"registered"}\n'),
      media_type: "text/plain",
      uri: `file://${missingPath}`,
      custody_mode: "link",
      availability: "present",
    }, 1000, tempDir);
    registerArtifactAlias(db, {
      artifactId: artifact.id,
      ref: `file://${aliasPath}`,
      source: "artifact_cli",
      now: 1001,
    });

    const content = getArtifactContent(db, artifact.id);
    const check = checkArtifactMaterialization(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "text",
      source: { kind: "local_file", locator: `file://${aliasPath}` },
      warnings: ["local_only artifact bytes differ from the registered sha256; previewing current local bytes"],
    });
    expect(content?.preview?.text).toBe('{"status":"current"}\n');
    expect(check).toMatchObject({
      materializable: true,
      hash_matches: false,
      source: "local_file",
      reasons: ["local_file_drift"],
      warnings: ["local_only artifact bytes differ from the registered sha256"],
    });
  });

  it("treats bare local file links as mutable drift without weakening managed integrity", () => {
    const outsidePath = path.join(tempDir, "mutable.txt");
    fs.writeFileSync(outsidePath, "original\n", "utf8");
    const local = ingestArtifact(db, {
      sha256: sha256("original\n"),
      media_type: "text/plain",
      uri: `file://${outsidePath}`,
      custody_mode: "link",
      availability: "present",
    }, 1000, tempDir);
    const managed = ingestArtifact(db, {
      content: "managed original\n",
      media_type: "text/plain",
      filename: "managed.txt",
    }, 1000, tempDir);
    const managedPath = new URL(managed.uri);

    fs.writeFileSync(outsidePath, "changed\n", "utf8");
    fs.writeFileSync(managedPath, "managed changed\n", "utf8");

    const localContent = getArtifactContent(db, local.id);
    const localCheck = checkArtifactMaterialization(db, local.id);
    const managedContent = getArtifactContent(db, managed.id);

    expect(localContent).toMatchObject({
      status: "available",
      kind: "text",
      source: { kind: "local_file", locator: `file://${outsidePath}` },
      warnings: ["local_only artifact bytes differ from the registered sha256; previewing current local bytes"],
    });
    expect(localContent?.preview?.text).toBe("changed\n");
    expect(localCheck).toMatchObject({
      materializable: true,
      hash_matches: false,
      reasons: ["local_file_drift"],
      warnings: ["local_only artifact bytes differ from the registered sha256"],
    });
    expect(managedContent).toMatchObject({
      status: "unavailable",
      reason: "artifact bytes do not match registered sha256",
      download: { available: false, reason: "artifact bytes do not match registered sha256" },
    });
  });

  it("serves HTML artifacts as sandboxable inline previews", () => {
    const html = "<!doctype html><html><body><h1>Plot</h1><script>window.plotReady = true;</script></body></html>";
    const artifact = ingestArtifact(db, {
      content: html,
      media_type: "text/html",
      filename: "plot.html",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "html",
      media_type: "text/html",
      source: { kind: "managed_file" },
      download: { available: true, filename: "plot.html" },
    });
    expect(content?.preview?.text).toContain("<script>window.plotReady = true;</script>");
  });

  it("serves repo locator previews only under a registered checkout", () => {
    const repoRoot = path.join(tempDir, "repo");
    const reportPath = path.join(repoRoot, "results", "report.md");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, "# Report\n\nReady.\n", "utf8");
    createLedgerCheckout("rlrmp", repoRoot);

    const artifact = ingestArtifact(db, {
      sha256: sha256("# Report\n\nReady.\n"),
      media_type: "text/markdown",
      uri: "repo://rlrmp@main/results/report.md",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", ref: "main", path: "results/report.md" },
      availability: "present",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "available",
      kind: "markdown",
      source: { kind: "repo_locator", locator: "repo://rlrmp/results/report.md" },
      download: { available: true },
    });
    expect(content?.preview?.text).toContain("# Report");
  });

  it("rejects repo locator traversal outside the registered checkout", () => {
    const repoRoot = path.join(tempDir, "repo");
    const outsidePath = path.join(tempDir, "outside.txt");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(outsidePath, "outside", "utf8");
    createLedgerCheckout("rlrmp", repoRoot);

    const artifact = ingestArtifact(db, {
      sha256: sha256("outside"),
      media_type: "text/plain",
      uri: "repo://rlrmp/../outside.txt",
      custody_mode: "link",
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", path: "../outside.txt" },
      availability: "present",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "unavailable",
      kind: "unavailable",
      download: { available: false },
      reason: "artifact repo locator path is outside the registered checkout",
    });
  });

  it("scans repo-owned artifacts with repo locators, hashes, and inferred issue links", () => {
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "results", "issue-5423f64"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "report.md"), "# Report\n\nDone.\n");
    fs.writeFileSync(path.join(repoRoot, "results", "issue-5423f64", "metrics.json"), '{"loss":0.1}\n');
    const issueId = createLedgerIssue("mandible", "5423f64", "Repo artifact discovery and indexing");

    const result = scanRepoArtifacts(db, {
      roots: [{ root: repoRoot, repo_id: "mandible", name: "mandible", default_branch: "main" }],
      now: 2000,
    });

    expect(result.scanned_repos).toEqual([{ repo_id: "mandible", root: repoRoot, exists: true }]);
    expect(result.discovered).toBe(2);
    expect(result.ingested).toBe(2);

    const report = result.artifacts.find((artifact) => artifact.repo_locator.path === "docs/report.md");
    expect(report).toMatchObject({
      custody_mode: "link",
      home_repo_id: "mandible",
      availability: "present",
      media_type: "text/markdown",
      role: "report",
      repo_locator: { repo_id: "mandible", ref: "main", path: "docs/report.md", root: repoRoot },
    });
    expect(report?.content_hash).toBe(
      crypto.createHash("sha256").update("# Report\n\nDone.\n").digest("hex"),
    );
    expect(report?.aliases?.map((alias) => alias.normalized_ref)).toContain("repo://mandible@main/docs/report.md");

    const metrics = result.artifacts.find(
      (artifact) => artifact.repo_locator.path === "results/issue-5423f64/metrics.json",
    );
    expect(metrics?.links).toContainEqual(expect.objectContaining({
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "repo_path_inferred",
      repo_id: "mandible",
      source: "repo_artifact_scanner",
    }));
  });

  it("scans registered feature worktrees under the canonical project key", () => {
    const featureRoot = path.join(tempDir, "feature__31e67ff-redo");
    fs.mkdirSync(path.join(featureRoot, "results"), { recursive: true });
    fs.writeFileSync(path.join(featureRoot, "results", "report.md"), "# Report\n");
    createLedgerCheckout("feature__31e67ff-redo", featureRoot, {
      projectKey: "rlrmp",
      workRepoId: "feature__31e67ff-redo",
      defaultBranch: "main",
    });

    const result = scanRepoArtifacts(db, {
      roots: [{ root: featureRoot, repo_id: "feature__31e67ff-redo", default_branch: "main" }],
      now: 2000,
    });

    expect(result.scanned_repos).toEqual([{ repo_id: "rlrmp", root: featureRoot, exists: true }]);
    expect(result.artifacts[0]).toMatchObject({
      home_repo_id: "rlrmp",
      repo_locator: { repo_id: "rlrmp", ref: "main", path: "results/report.md", root: featureRoot },
    });
    expect(result.artifacts[0].aliases?.map((alias) => alias.normalized_ref)).toContain(
      "repo://rlrmp@main/results/report.md",
    );
  });

  it("uses configured repo roots and skips dependency, build, and bulk directories", () => {
    const repoRoot = path.join(tempDir, "configured-repo");
    fs.mkdirSync(path.join(repoRoot, "reports"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "node_modules", "pkg", "reports"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "reports"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "data", "reports"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "reports", "summary.md"), "summary\n");
    fs.writeFileSync(path.join(repoRoot, "node_modules", "pkg", "reports", "ignored.md"), "ignored\n");
    fs.writeFileSync(path.join(repoRoot, "dist", "reports", "ignored.md"), "ignored\n");
    fs.writeFileSync(path.join(repoRoot, "data", "reports", "ignored.md"), "ignored\n");
    fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export {};\n");
    db.prepare(
      `INSERT INTO ledger_projects (
        id, project_key, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
      ) VALUES ('prj_configured', 'configured', 'Configured', '', '', 'remote', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO ledger_project_checkouts (
        id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at
      ) VALUES ('checkout_configured', 'prj_configured', 'configured', ?, 'Configured', 'develop', '', 1, 1)`,
    ).run(repoRoot);

    const result = discoverRepoArtifacts(db);

    expect(result.artifacts.map((artifact) => artifact.relative_path)).toEqual(["reports/summary.md"]);
    expect(result.artifacts[0]).toMatchObject({
      repo_id: "configured",
      repo_name: "Configured",
      default_branch: "develop",
      role: "report",
    });
    expect(result.skipped.map((entry) => entry.reason)).toContain("excluded_dir");
  });
});

describe("durable local-only artifact paths across worktree symlinks (issue 2f9c3c3)", () => {
  function initRepo(root: string): void {
    fs.mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "commit.gpgsign", "false"]);
  }

  function commitFile(root: string, rel: string, body: string): void {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
    git(root, ["add", rel]);
    git(root, ["commit", "-m", `add ${rel}`]);
  }

  // A persistent repo-root `_artifacts` directory reached from a feature
  // worktree through a symlink — the canonical disposable-path scenario.
  function buildWorktreeSymlinkFixture(): {
    mainRepo: string;
    featWorktree: string;
    disposablePath: string;
    persistentReal: string;
  } {
    const mainRepo = path.join(tempDir, "main-repo");
    initRepo(mainRepo);
    commitFile(mainRepo, "README.md", "# main\n");
    const persistentArtifacts = path.join(mainRepo, "_artifacts");
    fs.mkdirSync(persistentArtifacts, { recursive: true });
    fs.writeFileSync(path.join(persistentArtifacts, "plot.html"), "<html>plot</html>\n", "utf8");
    const featWorktree = path.join(tempDir, "worktrees", "feat");
    fs.mkdirSync(path.dirname(featWorktree), { recursive: true });
    git(mainRepo, ["worktree", "add", "-b", "feat", featWorktree]);
    fs.symlinkSync(persistentArtifacts, path.join(featWorktree, "_artifacts"));
    return {
      mainRepo,
      featWorktree,
      disposablePath: path.join(featWorktree, "_artifacts", "plot.html"),
      persistentReal: fs.realpathSync(path.join(persistentArtifacts, "plot.html")),
    };
  }

  it("stores the persistent realpath and materializes after the feature worktree is deleted", () => {
    const fixture = buildWorktreeSymlinkFixture();

    const registration = registerLocalArtifactPath(db, {
      path: fixture.disposablePath,
      role: "figure",
      allow_local_only: true,
    }, 1000, tempDir);

    expect(registration.recoverability).toBe("local_only");
    expect(registration.artifact.uri).toBe(`file://${fixture.persistentReal}`);
    expect(registration.artifact.uri).not.toContain(`${path.sep}feat${path.sep}`);
    expect(registration.warnings).toContain("symlink_resolved_to_durable_target");
    expect(registration.artifact.metadata.path_decision).toMatchObject({
      symlink_resolved: true,
      symlink_class: "same_repo_durable",
      worktree_substitution: true,
      resolved_path: fixture.persistentReal,
      input_path: path.resolve(fixture.disposablePath),
      stored_uri: `file://${fixture.persistentReal}`,
    });
    // The disposable input path is preserved as metadata, not the only locator.
    expect(registration.artifact.metadata.input_path).toBe(path.resolve(fixture.disposablePath));

    expect(checkArtifactMaterialization(db, registration.artifact.id)).toMatchObject({ materializable: true });

    // Remove the disposable feature worktree; the persistent target remains.
    fs.rmSync(fixture.featWorktree, { recursive: true, force: true });
    expect(fs.existsSync(fixture.disposablePath)).toBe(false);
    expect(fs.existsSync(fixture.persistentReal)).toBe(true);

    expect(checkArtifactMaterialization(db, registration.artifact.id)).toMatchObject({ materializable: true });
    expect(getArtifactContent(db, registration.artifact.id)).toMatchObject({ status: "available" });
  });

  it("plan endpoint classification equals what registration stores", () => {
    const fixture = buildWorktreeSymlinkFixture();
    const plan = planLocalArtifactPath(db, { path: fixture.disposablePath, allow_local_only: true });
    const registration = registerLocalArtifactPath(db, {
      path: fixture.disposablePath,
      allow_local_only: true,
    }, 1000, tempDir);

    expect(plan.uri).toBe(registration.artifact.uri);
    expect(plan.recoverability).toBe(registration.recoverability);
    expect(plan.sha256).toBe(registration.artifact.content_hash);
    expect(plan.path_decision).toMatchObject(
      registration.artifact.metadata.path_decision as Record<string, unknown>,
    );
  });

  it("CLI dry-run classification matches backend registration for the symlink fixture", () => {
    const fixture = buildWorktreeSymlinkFixture();
    const registration = registerLocalArtifactPath(db, {
      path: fixture.disposablePath,
      allow_local_only: true,
    }, 1000, tempDir);

    const cli = spawnSync(
      path.join(process.cwd(), "bin", "mandible"),
      ["artifact", "ingest", fixture.disposablePath, "--allow-local-only", "--dry-run", "--json"],
      { cwd: fixture.featWorktree, encoding: "utf8", env: { ...process.env, MANDIBLE_PORT: "9" } },
    );
    expect(cli.status).toBe(0);
    const planned = JSON.parse(cli.stdout).registered[0].planned_payload;
    expect(planned.uri).toBe(registration.artifact.uri);
    expect(planned.metadata.recoverability).toBe(registration.recoverability);
    expect(planned.metadata.path_decision.symlink_class).toBe(
      (registration.artifact.metadata.path_decision as Record<string, unknown>).symlink_class,
    );
    expect(planned.metadata.path_decision.resolved_path).toBe(
      (registration.artifact.metadata.path_decision as Record<string, unknown>).resolved_path,
    );
  });

  it("flags cross-repo symlinks while keeping them local-only", () => {
    const repoA = path.join(tempDir, "repo-a");
    const repoB = path.join(tempDir, "repo-b");
    initRepo(repoA);
    commitFile(repoA, "a.txt", "a\n");
    initRepo(repoB);
    commitFile(repoB, "b.txt", "b\n");
    const repoBData = path.join(repoB, "data");
    fs.mkdirSync(repoBData, { recursive: true });
    fs.writeFileSync(path.join(repoBData, "result.bin"), "result\n", "utf8");
    fs.symlinkSync(repoBData, path.join(repoA, "link"));
    const crossPath = path.join(repoA, "link", "result.bin");

    const registration = registerLocalArtifactPath(db, {
      path: crossPath,
      allow_local_only: true,
    }, 1000, tempDir);

    expect(registration.recoverability).toBe("local_only");
    expect(registration.warnings).toContain("cross_repo_symlink");
    expect(registration.artifact.metadata.path_decision).toMatchObject({
      symlink_class: "cross_repo",
      worktree_substitution: true,
    });
    expect(registration.artifact.uri).toBe(`file://${fs.realpathSync(path.join(repoBData, "result.bin"))}`);
  });

  it("rejects an outside-repo symlink for link custody unless explicitly allowed", () => {
    const repoOut = path.join(tempDir, "repo-out");
    initRepo(repoOut);
    commitFile(repoOut, "a.txt", "a\n");
    const outsideDir = path.join(tempDir, "outside-store");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "blob.bin"), "blob\n", "utf8");
    fs.symlinkSync(outsideDir, path.join(repoOut, "ext"));
    const outsidePath = path.join(repoOut, "ext", "blob.bin");

    // Without allow_local_only, link custody to an outside-repo symlink is gated
    // (the override-required warning is the backend's "warn or reject" signal;
    // the CLI turns the same classification into a hard outside_repo rejection).
    const gated = registerLocalArtifactPath(db, {
      path: outsidePath,
    }, 1000, tempDir);
    expect(gated.warnings).toEqual(
      expect.arrayContaining(["outside_repo", "outside_repo_symlink", "local_only_link_requires_override_for_issue_evidence"]),
    );

    const allowed = registerLocalArtifactPath(db, {
      path: outsidePath,
      allow_local_only: true,
    }, 2000, tempDir);
    expect(allowed.recoverability).toBe("local_only");
    expect(allowed.artifact.metadata.path_decision).toMatchObject({
      symlink_class: "outside_repo",
      worktree_substitution: false,
    });
    expect(allowed.artifact.uri).toBe(`file://${fs.realpathSync(path.join(outsideDir, "blob.bin"))}`);
  });

  it("freezes a durable realpath ref for a symlinked local-only bundle member", () => {
    const fixture = buildWorktreeSymlinkFixture();
    const bundle = createArtifactBundle(db, {
      name: "symlinked packet",
      members: [{ path: fixture.disposablePath, role: "figure", allow_local_only: true }],
    }, 2000, tempDir);

    const member = bundle.members[0];
    expect(member.artifact.uri).toBe(`file://${fixture.persistentReal}`);

    const content = getArtifactContent(db, bundle.bundle.id);
    const manifest = JSON.parse(content?.preview?.text ?? "{}");
    expect(manifest.members[0].ref).toBe(`file://${fixture.persistentReal}`);
    expect(manifest.members[0].input_path).toBe(fixture.disposablePath);

    // The frozen ref still materializes after the feature worktree is deleted.
    fs.rmSync(fixture.featWorktree, { recursive: true, force: true });
    expect(checkArtifactMaterialization(db, member.artifact.id)).toMatchObject({ materializable: true });
  });
});

describe("artifact version series", () => {
  it("records managed v1/v2 under one series with sequential version numbers", () => {
    const r1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "rlrmp",
      content: "v1\n",
      media_type: "text/plain",
      logical_name: "report",
    }, 1000, tempDir);
    const r2 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "rlrmp",
      content: "v2\n",
      media_type: "text/plain",
      logical_name: "report",
    }, 2000, tempDir);

    expect(r1.series.id).toBe(r2.series.id);
    expect(r1.version.version_no).toBe(1);
    expect(r2.version.version_no).toBe(2);
    expect(r2.version.artifact_id).not.toBe(r1.version.artifact_id);
    expect(getArtifactSeries(db, r1.series.id)?.version_count).toBe(2);
    expect(listArtifactVersions(db, r1.series.id).map((v) => v.version_no)).toEqual([1, 2]);

    // Re-recording identical bytes is an idempotent no-op observation.
    const dup = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "rlrmp",
      content: "v2\n",
      media_type: "text/plain",
      logical_name: "report",
    }, 3000, tempDir);
    expect(dup.created).toBe(false);
    expect(getArtifactSeries(db, r1.series.id)?.version_count).toBe(2);
  });
});
