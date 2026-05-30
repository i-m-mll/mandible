import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getArtifact,
  getArtifactRoot,
  getIndexedGraph,
  getIndexedGraphCount,
  getProviderCapabilities,
  getProviderHealth,
  ingestArtifact,
  ingestProviderManifest,
  listArtifacts,
  listProviders,
  registerProvider,
  resolveArtifactRef,
} from "../src/provider-artifacts.js";

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
    expect(fixture.humbleb_return_refs.claim_refs).toEqual(["humbleb:claim:claim_0000000000000001"]);
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
    expect(detail?.aliases?.map((alias) => alias.normalized_ref)).toContain(`artifact://sha256/${artifact.content_hash}`);
    expect(detail?.aliases?.some((alias) => alias.scheme === "file")).toBe(true);
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
    const resolution = resolveArtifactRef(db, `artifact://sha256/${hash}`, 1000);

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
            artifact_id: `artifact://sha256/${checkpointHash}`,
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
          artifact_id: `artifact://sha256/${parameterHash}`,
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
          artifact_id: `artifact://sha256/${parentHash}`,
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
});
