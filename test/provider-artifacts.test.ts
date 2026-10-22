import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getArtifactContent } from "../src/artifact-content.js";
import {
  addArtifactBundleMembers,
  canonicalArtifactSeriesShortRef,
  canonicalArtifactVersionShortRef,
  createArtifactBundle,
  getArtifact,
  getArtifactBundle,
  getArtifactRoot,
  getIndexedGraph,
  getIndexedGraphCount,
  getProviderCapabilities,
  ingestArtifact,
  ingestProviderManifest,
  listArtifacts,
  projectArtifactPublicValue,
} from "../src/provider-artifacts.js";
import { recordArtifactVersion, resolveArtifactRef } from "./helpers/artifact-http-write-fixtures.js";
import { scanRepoArtifacts } from "../src/repo-artifact-scanner.js";
import {
  insertRawLedgerCheckout,
  insertRawLedgerIssue,
  insertRawLedgerProject,
  migratedMemoryDb,
} from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: SqliteDatabase;
let savedEnv: Record<string, string | undefined>;

function createLedgerIssue(projectName: string, alias: string, title = `Issue ${alias}`): string {
  const projectId = insertRawLedgerProject(db, {
    name: projectName,
    projectKey: projectName,
    remoteIdentity: "",
    upstreamIdentity: "",
    namespacePolicy: "remote",
  });
  insertRawLedgerCheckout(db, {
    projectId,
    name: projectName,
    root: `/tmp/${projectName}`,
    defaultBranch: "main",
    remoteUrl: "",
  });
  return insertRawLedgerIssue(db, {
    id: `${alias}_${projectName}`,
    projectId,
    shortId: alias,
    title,
    body: "",
    kind: "feature",
    priority: "normal",
    authorActorType: "agent",
    authorDisplay: "Codex",
    source: "mandible",
    alias: { alias },
  });
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
  db = migratedMemoryDb();
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

  it("lets MANDIBLE_ARTIFACT_DIR override settings and MANDIBLE_HOME", () => {
    const envRoot = path.join(tempDir, "env-root");
    process.env.MANDIBLE_HOME = path.join(tempDir, "mandible-home");
    process.env.MANDIBLE_ARTIFACT_DIR = envRoot;
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('artifact_root', ?, 1000)"
    ).run(path.join(tempDir, "settings-root"));

    expect(getArtifactRoot(db)).toBe(envRoot);
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
    expect(first.id).toMatch(/^artifact-blob:/);
    expect(first.custody_mode).toBe("managed");
    expect(first.availability).toBe("present");
    expect(first.retention).toEqual({});
    expect(fs.existsSync(first.uri.replace("file://", ""))).toBe(true);
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
    const seriesLatest = resolveArtifactRef(db, "artifact-series:alpha-r@latest", 5009);
    const seriesPinned = resolveArtifactRef(db, "artifact-series:alpha-r@1", 5010);
    const seriesAmbiguous = resolveArtifactRef(db, "artifact-series:ambiguo", 5011);
    const seriesUnresolved = resolveArtifactRef(db, "artifact-series:missing", 5012);
    const seriesTooShort = resolveArtifactRef(db, "artifact-series:alpha", 5013);

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
      logical_artifact: { id: first.series.id.replace("artifact-series:","artifact:") },
      artifact_version: { id: second.version.id },
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
    expect(seriesLatest).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      logical_artifact: { id: first.series.id.replace("artifact-series:","artifact:") },
      artifact_version: { version_no: 2 },
    });
    expect(seriesPinned).toMatchObject({
      status: "resolved",
      artifact: { id: first.artifact.id },
      artifact_version: { version_no: 1 },
    });
    expect(seriesAmbiguous).toMatchObject({
      status: "ambiguous",
      warnings: ["artifact_series_ambiguous"],
    });
    expect(seriesUnresolved).toMatchObject({
      status: "unresolved",
      warnings: ["artifact_series_unresolved"],
    });
    expect(seriesTooShort).toMatchObject({
      status: "unsupported",
      warnings: ["artifact_series_prefix_too_short"],
    });

    const seriesRef = canonicalArtifactSeriesShortRef(db, first.series.id);
    const versionRef = canonicalArtifactVersionShortRef(db, first.version.id);
    expect(seriesRef).toMatch(/^artifact-series:.{12,}$/);
    expect(versionRef).toMatch(/^artifact-version:.{12,}$/);
    expect(resolveArtifactRef(db, seriesRef)).toMatchObject({ status: "resolved", logical_artifact: { id: first.series.id.replace("artifact-series:","artifact:") } });
    expect(resolveArtifactRef(db, versionRef)).toMatchObject({ status: "resolved", artifact_version: { id: first.version.id } });
    expect(projectArtifactPublicValue(db, { series: first.series, version: first.version })).toMatchObject({
      series: { ref: seriesRef },
      version: { ref: versionRef },
    });
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

  it("ingests multi-MiB bytes from a daemon-visible content_path without inline base64 (issue 833e972)", () => {
    const big = crypto.randomBytes(3 * 1024 * 1024); // 3 MiB, well over OS ARG_MAX
    const srcPath = path.join(tempDir, "big-ingest.bin");
    fs.writeFileSync(srcPath, big);

    const artifact = ingestArtifact(db, {
      content_path: srcPath,
      sha256: sha256(big),
      filename: "big-ingest.bin",
      media_type: "application/octet-stream",
      custody_mode: "managed",
      availability: "present",
    }, 1000, tempDir);

    expect(artifact).toMatchObject({
      id: `artifact-blob:${sha256(big)}`,
      custody_mode: "managed",
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
        custody_mode: "managed",
        availability: "present",
      }, 1000, tempDir),
    ).toThrow(/sha256 does not match supplied content/);
  });

  it("preserves member refs and recoverability in mixed tracked/local bundle manifests", () => {
    const runJson = '{"status":"complete"}\n';
    const checkpoint = Buffer.from("checkpoint");
    const tracked=ingestArtifact(db,{content:runJson,role:'run_record',media_type:'application/json'},1000,tempDir);
    const local=ingestArtifact(db,{content_buffer:checkpoint,role:'model_checkpoint'},1000,tempDir);
    const figure=ingestArtifact(db,{content:'figure\n',role:'figure',media_type:'image/png'},1000,tempDir);
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
    });
    expect(bundleResult.members).toHaveLength(2);
    expect(appended.members.map((member) => member.artifact.id).sort()).toEqual([figure.id, local.id, tracked.id].sort());
    expect(bundleDetail?.members.map((member) => member.artifact.id).sort()).toEqual([figure.id, local.id, tracked.id].sort());
    expect(trackedDetail?.custody_mode).toBe("managed");
    expect(localDetail?.custody_mode).toBe("managed");
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
    expect(registered.artifacts.map((artifact) => artifact.metadata.logical_name)).toEqual(["results/summary.md"]);
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
    expect(getArtifact(db, `artifact-blob:${checkpointHash}`)).toBeNull();

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 100 });
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edgeTypes = graph.edges.map((edge) => edge.type);
    expect(nodeIds).toContain("provider:feedbax");
    expect(nodeIds).toContain(manifest.id);
    expect(nodeIds).toContain("run:feedbax:feedbax-training-run:stub-job");
    expect(graph.nodes.some(node => node.type === 'external_reference' && node.status === 'referenced')).toBe(true);
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

  it("resolves provider issue refs by project_key and keeps checkout ids out of graph identity", () => {
    const issueId = createLedgerIssue("feedbax", "fbx1234", "Feedbax provider ref");
    db.prepare("UPDATE ledger_project_checkouts SET work_repo_id = ? WHERE project_id = ?")
      .run("20-widgets-widgets", "prj_feedbax");

    ingestProviderManifest(db, {
      manifest: {
        kind: "TrainingRunManifest",
        schema_version: "feedbax.manifest.v1",
        id: "run-with-feedbax-key",
        status: "completed",
        provenance: {
          issues: ["feedbax/fbx1234"],
        },
      },
    }, 1000, tempDir);

    const graph = getIndexedGraph(db, { mode: "provider-lineage", limit: 100 });
    const issueNode = graph.nodes.find((node) => node.id === "issue:feedbax:fbx1234");
    expect(issueNode).toMatchObject({
      type: "issue",
      repo_id: "feedbax",
      detail: expect.objectContaining({
        ledger_issue_id: issueId,
        project_key: "feedbax",
      }),
    });
    expect(graph.nodes.some((node) => node.id === "issue:20-widgets-widgets:fbx1234")).toBe(false);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "issue:feedbax:fbx1234",
      target: "run:feedbax:run-with-feedbax-key",
      type: "requested_by",
      metadata: expect.objectContaining({
        project_key: "feedbax",
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
    expect(graph.nodes.some(node => node.type === 'external_reference')).toBe(true);
    expect(nodeIds).toContain("provider_spec:feedbax:feedbax-graph:baseline");
    expect(nodeIds).toContain("issue:rlrmp:b41c940");
    expect(edgeTypes).toContain("model_references_store");
    expect(edgeTypes).toContain("model_used_spec");
    expect(edgeTypes).toContain("derived_from");
    expect(edgeTypes).toContain("requested_by");

    expect(getArtifact(db, `artifact-blob:${parameterHash}`)).toBeNull();
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
      warnings: [],
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

  it("scans repo-owned artifacts with repo locators, hashes, and inferred issue links", () => {
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "results", "issue-5423f64"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "report.md"), "# Report\n\nDone.\n");
    fs.writeFileSync(path.join(repoRoot, "results", "issue-5423f64", "metrics.json"), '{"loss":0.1}\n');
    const issueId = createLedgerIssue("mandible", "5423f64", "Repo artifact discovery and indexing");
    initGitRepo(repoRoot);git(repoRoot,['add','.']);git(repoRoot,['commit','-m','artifacts']);
    db.prepare("UPDATE ledger_project_checkouts SET root=? WHERE project_id=(SELECT id FROM ledger_projects WHERE project_key='mandible')").run(repoRoot);


    const result = scanRepoArtifacts(db, {
      roots: [{ root: repoRoot, repo_id: "mandible", name: "mandible", default_branch: "main" }],
      now: 2000,
    });

    expect(result.scanned_repos).toEqual([{ repo_id: "mandible", root: repoRoot, exists: true }]);
    expect(result.discovered).toBe(2);
    expect(result.ingested).toBe(2);

    const report = result.artifacts.find((artifact) => artifact.repo_locator.path === "docs/report.md");
    expect(report).toMatchObject({
      custody_mode: "git",
      home_repo_id: expect.any(String),
      availability: "present",
      media_type: "text/markdown",
      role: "report",
      repo_locator: { repo_id: expect.any(String), commit: expect.any(String), path: "docs/report.md" },
    });
    expect(report?.content_hash).toBe(
      crypto.createHash("sha256").update("# Report\n\nDone.\n").digest("hex"),
    );
    expect(report?.aliases?.some(alias=>alias.normalized_ref.endsWith("/docs/report.md"))).toBe(true);

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
      custody_mode: "managed", home_repo_id: null, repo_locator: {},
    });
    expect(db.prepare("SELECT source_json FROM artifact_source").get()).toEqual({source_json:JSON.stringify({kind:'repo',project_id:'prj_rlrmp',path:'results/report.md'})});
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
  it("stores symlinked input bytes independently of disposable and original paths",()=>{
    const fixture=buildWorktreeSymlinkFixture();
    const saved=recordArtifactVersion(db,{source_kind:'local_only',path:fixture.disposablePath,custody_mode:'managed'});
    fs.unlinkSync(path.join(fixture.featWorktree,'_artifacts'));
    fs.unlinkSync(fixture.persistentReal);
    expect(getArtifactContent(db,saved.version.id)?.preview?.text).toBe('<html>plot</html>\n');
  });

});
