import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getArtifact,
  getIndexedGraph,
  getIndexedGraphCount,
  getProviderCapabilities,
  getProviderHealth,
  ingestArtifact,
  ingestProviderManifest,
  listProviders,
  registerProvider,
} from "../src/provider-artifacts.js";

let tempDir = "";
let db: Database.Database;

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
      created_at INTEGER NOT NULL,
      UNIQUE(algorithm, content_hash)
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
  `);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-provider-test-"));
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("provider/artifact substrate", () => {
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
    expect(fs.existsSync(first.uri.replace("file://", ""))).toBe(true);
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
});
