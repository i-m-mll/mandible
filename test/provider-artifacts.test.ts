import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkArtifactMaterialization, getArtifactContent } from "../src/artifact-content.js";
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
  registerLocalArtifactPath,
  registerProvider,
  resolveAndLinkArtifact,
  resolveArtifactRef,
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
      id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
    ) VALUES (?, ?, '', '', 'remote', 1, 1)`,
  ).run(projectId, projectName);
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

function createLedgerCheckout(repoId: string, root: string): void {
  const projectId = `prj_${repoId}`;
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (
      id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
    ) VALUES (?, ?, '', '', 'remote', 1, 1)`,
  ).run(projectId, repoId);
  db.prepare(
    `INSERT OR REPLACE INTO ledger_project_checkouts (
      id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'main', '', 1, 1)`,
  ).run(`checkout_${repoId}`, projectId, repoId, root, repoId);
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
    expect(detail?.aliases?.map((alias) => alias.normalized_ref)).toContain(`artifact:${artifact.content_hash}`);
    expect(detail?.aliases?.some((alias) => alias.scheme === "file")).toBe(true);
  });

  it("resolves compact artifact hash prefixes without changing canonical artifact identity", () => {
    const hash = "1234567890abcdef".repeat(4);
    const artifact = ingestArtifact(db, {
      sha256: hash,
      role: "report",
      uri: "repo://mandible@main/results/report.md",
      custody_mode: "link",
      repo_locator: { repo_id: "mandible", ref: "main", path: "results/report.md" },
    }, 1000, tempDir);

    const compact = resolveArtifactRef(db, "artifact:1234567890ab", 2000);
    const unsupportedColon = resolveArtifactRef(db, `artifact:sha256:${hash}`, 2000);
    const unsupportedPlain = resolveArtifactRef(db, `sha256:${hash}`, 2000);

    expect(compact).toMatchObject({
      status: "resolved",
      artifact: { id: artifact.id, content_hash: hash },
      alias: {
        artifact_id: artifact.id,
        normalized_ref: "artifact:1234567890ab",
        locator: { algorithm: "sha256", prefix: "1234567890ab", resolved_hash: hash },
      },
    });
    expect(unsupportedColon).toMatchObject({ status: "unsupported", artifact: null, alias: null });
    expect(unsupportedPlain).toMatchObject({ status: "unsupported", artifact: null, alias: null });
    expect(getArtifact(db, artifact.id)?.id).toBe(`artifact:sha256:${hash}`);
  });

  it("reports ambiguous, unresolved, and unsupported compact artifact hash refs explicitly", () => {
    const firstHash = `abc1234${"0".repeat(57)}`;
    const secondHash = `abc1234${"1".repeat(57)}`;
    ingestArtifact(db, { sha256: firstHash, uri: `artifact:${firstHash}` }, 1000, tempDir);
    ingestArtifact(db, { sha256: secondHash, uri: `artifact:${secondHash}` }, 1001, tempDir);

    const ambiguous = resolveArtifactRef(db, "artifact:abc1234", 2000);
    const unresolved = resolveArtifactRef(db, "artifact:fffffff", 2001);
    const unsupported = resolveArtifactRef(db, "artifact:abc123", 2002);

    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      artifact: null,
      alias: { resolution_status: "ambiguous", artifact_id: null },
    });
    expect(unresolved).toMatchObject({
      status: "unresolved",
      artifact: null,
      alias: { resolution_status: "unresolved", artifact_id: null },
    });
    expect(unsupported).toMatchObject({
      status: "unsupported",
      artifact: null,
      alias: { resolution_status: "unsupported", artifact_id: null },
    });
  });

  it("resolves repo and provider aliases without requiring issue association", () => {
    const hash = "f".repeat(64);
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

  it("materializes missing content-hash refs as external hash records", () => {
    const hash = "a".repeat(64);
    const resolution = resolveArtifactRef(db, `artifact:${hash}`, 1000);

    expect(resolution).toMatchObject({
      status: "resolved",
      scheme: "artifact",
      artifact: {
        id: `artifact:sha256:${hash}`,
        algorithm: "sha256",
        content_hash: hash,
        custody_mode: "external",
        availability: "remote_only",
      },
    });
    expect(getIndexedGraph(db, { mode: "artifact-lineage", limit: 20 }).nodes.map((node) => node.id)).toContain(
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
    const hashResolution = resolveArtifactRef(db, `artifact:${hash}`, 1000);

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
      ref: `artifact:${hash}`,
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
    const external = resolveArtifactRef(db, `artifact:${hash}`, 1000);

    expect(external.artifact).toMatchObject({
      id: `artifact:sha256:${hash}`,
      custody_mode: "external",
      availability: "remote_only",
    });

    const snapshotted = snapshotArtifactBytes(db, {
      ref: `artifact:${hash}`,
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
        { ref: `artifact:${tracked.content_hash}`, role: "run_record" },
        { ref: `artifact:${local.content_hash}`, role: "model_checkpoint", metadata: { warning_codes: ["local_only"] } },
      ],
    }, 2000, tempDir);
    const bundle = bundleResult.bundle;
    const appended = addArtifactBundleMembers(db, bundle.id, [
      { ref: `artifact:${figure.content_hash}`, role: "figure" },
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

  it("does not serve registered link file URIs outside managed storage", () => {
    const outsidePath = path.join(tempDir, "outside.txt");
    fs.writeFileSync(outsidePath, "not managed", "utf8");
    const artifact = ingestArtifact(db, {
      sha256: sha256("not managed"),
      media_type: "text/plain",
      uri: `file://${outsidePath}`,
      custody_mode: "link",
      availability: "present",
    }, 1000, tempDir);

    const content = getArtifactContent(db, artifact.id);

    expect(content).toMatchObject({
      status: "unavailable",
      kind: "unavailable",
      download: { available: false },
      reason: "local file URI is not managed by Mandible",
    });
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
        id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at
      ) VALUES ('prj_configured', 'Configured', '', '', 'remote', 1, 1)`,
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
