import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getIndexedGraph,
  getIndexedGraphCount,
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
});
