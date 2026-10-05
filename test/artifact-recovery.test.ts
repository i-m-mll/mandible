import SqliteDatabase from "../src/sqlite.ts";
import { MIGRATIONS } from '../src/db-migrations.js';
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyArtifactRecovery,
  planArtifactRecovery,
  recoverArtifactCustody,
} from "../src/artifact-recovery.js";
import { insertRawLedgerCheckout, insertRawLedgerProject } from "./helpers/ledger-fixtures.js";
import type { Db } from "../src/db.js";

function createMigratedDb(): Db {
  const db=new SqliteDatabase(':memory:');
  db.exec(fs.readFileSync('test/fixtures/schema-v158.sql','utf8'));
  db.function('mandible_sha256',{deterministic:true},(value:unknown)=>crypto.createHash('sha256').update(String(value)).digest('hex'));
  for(const migration of MIGRATIONS.filter(m=>m.version>158 && m.version<=184)) {
    db.transaction(()=>{for(const sql of migration.statements) db.exec(sql);})();
  }
  db.prepare("UPDATE meta SET value='184' WHERE key='schema_version'").run();
  db.pragma('foreign_keys=ON');
  return db;
}

const sha256 = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-c", "commit.gpgsign=false", "-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_COUNT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(root: string, content = "tracked bytes\n"): { project: string; commit: string; file: string } {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Artifact Recovery Test");
  git(root, "config", "user.email", "artifact-recovery@example.invalid");
  const file = path.join(root, "report.md");
  fs.writeFileSync(file, content);
  git(root, "add", "report.md");
  git(root, "commit", "-m", "record artifact");
  return { project: "", commit: git(root, "rev-parse", "HEAD"), file };
}

function addProject(db: Db, root: string, name: string): string {
  const project = insertRawLedgerProject(db, { id: `project-${name}`, name, projectKey: name });
  insertRawLedgerCheckout(db, { id: `checkout-${name}`, projectId: project, name, root, defaultBranch: "main" });
  return project;
}

function addArtifact(
  db: Db,
  input: {
    id: string;
    versionId: string;
    blobId: string;
    hash: string;
    sourceKind: string;
    custodyMode: string;
    sourceProjectId?: string | null;
    sourceRepoId?: string | null;
    repoPath?: string | null;
    commitSha?: string | null;
    observedPath?: string | null;
    locator?: object;
    metadata?: object;
    blobStorageUri?: string | null;
    blobCustody?: string;
    blobAvailability?: string;
    reuseBlobId?: string;
  }): void {
  db.prepare(
    `INSERT INTO artifact
      (id, identity_key, source_kind, title, source_project_id, logical_name, latest_version_id,
       version_count, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 0, '{}', 1, 1)`,
  ).run(input.id, `artifact-key-${input.id}`, input.sourceKind, input.sourceProjectId ?? null, `${input.id}.md`);
  if (!input.reuseBlobId) {
    db.prepare(
      `INSERT INTO artifact_blob
        (id, algorithm, content_hash, storage_uri, size_bytes, metadata_json, custody_mode,
         availability, retention_json, reference_json, created_at)
       VALUES (?, 'sha256', ?, ?, 0, '{}', ?, ?, '{}', '{}', 1)`,
    ).run(
      input.blobId,
      input.hash,
      input.blobStorageUri ?? null,
      input.blobCustody ?? input.custodyMode,
      input.blobAvailability ?? "unchecked",
    );
  }
  db.prepare(
    `INSERT INTO artifact_version
      (id, artifact_id, version_no, blob_id, source_kind, content_hash, source_project_id,
       source_repo_id, repo_path, commit_sha, observed_path, source_locator_json, custody_mode,
       label, note, metadata_json, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)`,
  ).run(
    input.versionId,
    input.id,
    input.reuseBlobId ?? input.blobId,
    input.sourceKind,
    input.hash,
    input.sourceProjectId ?? null,
    input.sourceRepoId ?? null,
    input.repoPath ?? null,
    input.commitSha ?? null,
    input.observedPath ?? null,
    JSON.stringify(input.locator ?? { parent_version_id: null }),
    input.custodyMode,
    JSON.stringify(input.metadata ?? {}),
  );
  db.prepare("UPDATE artifact SET latest_version_id = ?, version_count = 1 WHERE id = ?").run(input.versionId, input.id);
}

function addDerivedRefs(db: Db, versionId: string, blobId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO artifact_links
      (id, blob_id, entity_type, entity_id, link_type, role, source, created_at, updated_at,
       link_kind, target_type, target_id)
     VALUES (?, ?, 'test', 'test', 'references', NULL, 'artifact_registry', 1, 1,
       'pinned', 'artifact_version', ?)`,
  ).run(`link-${versionId}`, blobId, versionId);
  db.prepare(
    `INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, status, source, metadata_json, created_at, updated_at)
     VALUES (?, ?, 'artifact_version', ?, 'associated', 'test-derived', 'active', 'migration', '{}', 1, 1)`,
  ).run(`association-${versionId}`, projectId, versionId);
}

function addGraphEntity(db: Db, input: {
  id: string;
  entityType?: string;
  source?: string;
  externalId?: string | null;
  summary?: object;
  detail?: object;
}): void {
  db.prepare(
    `INSERT INTO graph_entities
      (id, entity_type, repo_id, provider_id, external_id, title, status,
       labels_json, summary_json, detail_ref_json, action_context_json,
       visual_json, created_at, updated_at, observed_at, source)
     VALUES (?, ?, NULL, NULL, ?, ?, 'present', '[]', ?, ?, '[]', '{}', 1, 1, 1, ?)`,
  ).run(
    input.id,
    input.entityType ?? "artifact",
    input.externalId ?? input.id,
    input.id,
    JSON.stringify(input.summary ?? { custody_mode: "external", availability: "remote_only" }),
    JSON.stringify(input.detail ?? { custody: { mode: "external" }, artifact_id: input.id }),
    input.source ?? "artifacts",
  );
}

function addGraphEdge(db: Db, input: { id: string; sourceId: string; targetId: string }): void {
  db.prepare(
    `INSERT INTO graph_edges
      (id, source_id, target_id, edge_type, edge_class, provenance, confidence,
       metadata_json, created_at, observed_at, source)
     VALUES (?, ?, ?, 'bundle_contains', 'provenance', 'artifact_bundle', 'observed', '{}', 1, 1, 'artifact_bundle')`,
  ).run(input.id, input.sourceId, input.targetId);
}

let db: Db | undefined;
let tempRoot: string | undefined;
let previousArtifactDir: string | undefined;
const originalArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  const restoreArtifactDir = previousArtifactDir ?? originalArtifactDir;
  if (restoreArtifactDir === undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;
  else process.env.MANDIBLE_ARTIFACT_DIR = restoreArtifactDir;
  previousArtifactDir = undefined;
});

describe("artifact custody recovery", () => {
  it("recovers direct and nested Git evidence plus staged managed bytes, then retries idempotently", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-"));
    db = createMigratedDb();
    const repoRoot = path.join(tempRoot, "repo");
    const repoFile = makeRepo(repoRoot, "tracked bytes\n");
    const project = addProject(db, repoRoot, "recovery-repo");
    const commit = repoFile.commit;
    const trackedHash = sha256("tracked bytes\n");
    const legacyTrackedStorage = path.join(tempRoot, "legacy-tracked-storage.md");
    fs.writeFileSync(legacyTrackedStorage, "tracked bytes\n");
    const managedSource = path.join(tempRoot, "managed-source.md");
    fs.writeFileSync(managedSource, "managed bytes\n");

    addArtifact(db, {
      id: "artifact-direct",
      versionId: "version-direct",
      blobId: "blob-direct",
      hash: trackedHash,
      sourceKind: "tracked_repo",
      custodyMode: "copy",
      sourceProjectId: project,
      sourceRepoId: "legacy-repo-id",
      repoPath: "report.md",
      commitSha: commit,
      blobStorageUri: `file://${legacyTrackedStorage}`,
      blobCustody: "copy",
      blobAvailability: "present",
    });
    addArtifact(db, {
      id: "artifact-nested",
      versionId: "version-nested",
      blobId: "blob-nested",
      hash: trackedHash,
      sourceKind: "local_only",
      custodyMode: "copy",
      reuseBlobId: "blob-direct",
      locator: { legacy_uri: `repo://${project}@${commit}/report.md`, parent_version_id: null },
      blobCustody: "copy",
      blobAvailability: "present",
    });
    const managedHash = sha256("managed bytes\n");
    addArtifact(db, {
      id: "artifact-managed",
      versionId: "version-managed",
      blobId: "blob-managed",
      hash: managedHash,
      sourceKind: "local_only",
      custodyMode: "copy",
      observedPath: managedSource,
      blobCustody: "copy",
      blobAvailability: "present",
    });

    const stageRoot = path.join(tempRoot, "managed-cas");
    const recoveryReceiptPath = path.join(tempRoot, "recovery.receipt.json");
    const recoveryOptions = {
      stage_root: stageRoot,
      recovery_receipt_path: recoveryReceiptPath,
      retain_git_commit: (_db: Db, input: { project: string; commit: string; path: string; sha256: string }) => `refs/mandible/artifacts/${input.commit}`,
    };
    const plan = planArtifactRecovery(db, recoveryOptions);
    expect(plan.summary).toMatchObject({ versions: 3, git: 2, managed: 1, retire: 0, malformed: 0 });
    expect(plan.versions.find(version => version.version_id === "version-nested")?.evidence)
      .toEqual(expect.arrayContaining([expect.objectContaining({ source: "version.source_locator_json.legacy_uri", verified: true })]));
    expect(plan.versions.find(version => version.version_id === "version-nested")?.hash_origin).toBe("known");
    expect(plan.blobs.find(blob => blob.blob_id === "blob-direct")).toMatchObject({ disposition: "git-referenced", desired_storage_uri: null });
    expect(JSON.parse(plan.versions[0].desired?.metadata_json ?? "null")).not.toHaveProperty("provenance.artifact_recovery");

    const first = applyArtifactRecovery(db, plan, recoveryOptions);
    expect(first).toMatchObject({ status: "applied", applied_versions: 3, staged_managed_bytes: 1, retired_versions: 0 });
    expect(first.retained_git_commits.length).toBe(1);
    expect(fs.existsSync(path.join(stageRoot, "sha256", managedHash.slice(0, 2), managedHash))).toBe(true);
    expect(db.prepare("SELECT custody_mode, source_kind, source_repo_id, source_project_id, repo_path, commit_sha FROM artifact_version WHERE id = 'version-direct'").get())
      .toEqual({ custody_mode: "link", source_kind: "tracked_repo", source_repo_id: null, source_project_id: project, repo_path: "report.md", commit_sha: commit });
    expect(db.prepare("SELECT custody_mode, source_kind, source_project_id, repo_path, commit_sha, source_locator_json FROM artifact_version WHERE id = 'version-managed'").get())
      .toMatchObject({ custody_mode: "managed", source_kind: "managed", source_project_id: null, repo_path: null, commit_sha: null, source_locator_json: '{"parent_version_id":null}' });
    expect(db.prepare("SELECT role FROM project_artifact_associations WHERE target_id = 'version-direct'").get()).toEqual({ role: "historical-source-access" });
    expect(db.prepare("SELECT storage_uri FROM artifact_blob WHERE id = 'blob-direct'").get()).toEqual({ storage_uri: null });

    const second = applyArtifactRecovery(db, plan, recoveryOptions);
    expect(second).toMatchObject({ status: "applied", applied_versions: 0, skipped_versions: 3, retired_versions: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_artifact_associations WHERE target_id = 'version-direct' AND role = 'historical-source-access'").get())
      .toEqual({ count: 1 });
    const freshPlanRetry = planArtifactRecovery(db, recoveryOptions);
    const third = applyArtifactRecovery(db, freshPlanRetry, { ...recoveryOptions, recovery_receipt_path: path.join(tempRoot, "fresh-recovery.receipt.json") });
    expect(third).toMatchObject({ status: "applied", applied_versions: 0, skipped_versions: 3, retired_versions: 0 });
  });

  it("retires unresolved derived-only versions with an exact packet and deletes no bytes", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-retire-"));
    db = createMigratedDb();
    previousArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;
    const artifactRoot = path.join(tempRoot, "cas");
    process.env.MANDIBLE_ARTIFACT_DIR = artifactRoot;
    const project = addProject(db, path.join(tempRoot, "empty-checkout"), "retire-repo");
    const missingHash = sha256("not present");
    const keptHash = sha256("verified orphan bytes");
    const keptPath = path.join(artifactRoot, "sha256", keptHash.slice(0, 2), keptHash);
    fs.mkdirSync(path.dirname(keptPath), { recursive: true });
    fs.writeFileSync(keptPath, "verified orphan bytes");
    db.prepare(
      `INSERT INTO artifact_blob
        (id, algorithm, content_hash, storage_uri, size_bytes, metadata_json, custody_mode,
         availability, retention_json, reference_json, created_at)
       VALUES ('blob-orphan-kept', 'sha256', ?, NULL, 20, '{}', 'external', 'remote_only', '{}', '{}', 1)`,
    ).run(keptHash);
    addArtifact(db, {
      id: "artifact-retire",
      versionId: "version-retire",
      blobId: "blob-retire",
      hash: missingHash,
      sourceKind: "external",
      custodyMode: "external",
      blobCustody: "external",
      blobAvailability: "remote_only",
      metadata: { descriptor: "retain me", legacy_blob_id: `artifact:ref:${sha256("not present")}` },
    });
    addDerivedRefs(db, "version-retire", "blob-retire", project);
    const staleGraphId = `artifact-blob:${missingHash}`;
    const keptGraphId = `artifact-blob:${keptHash}`;
    addGraphEntity(db, { id: staleGraphId });
    addGraphEntity(db, { id: keptGraphId });
    addGraphEntity(db, {
      id: "artifact:ref:external-reference",
      source: "artifact_references",
      externalId: "git+ssh://example.invalid/repo.git@{ref}",
      summary: { role: "external_reference", custody_mode: "external", availability: "remote_only" },
      detail: { uri: "git+ssh://example.invalid/repo.git@{ref}", artifact_id: "artifact:ref:external-reference", custody: { mode: "external" } },
    });
    addGraphEntity(db, { id: "bundle-test", entityType: "artifact_bundle", source: "artifact_bundle" });
    addGraphEdge(db, { id: "bundle-edge-stale", sourceId: "bundle-test", targetId: staleGraphId });
    const packetPath = path.join(tempRoot, "retirement", "packet.json");
    const recoveryReceiptPath = path.join(tempRoot, "recovery.receipt.json");
    const plan = planArtifactRecovery(db, { retirement_packet_path: packetPath, recovery_receipt_path: recoveryReceiptPath });
    expect(plan.summary).toMatchObject({
      versions: 1,
      retire: 1,
      blobs: 2,
      blobs_managed: 1,
      blobs_retire: 1,
      content_owning_dependencies: 0,
      graph_entities: 1,
      graph_edges: 1,
      graph_legacy_authority_entities: 3,
      graph_unknown_references: 0,
    });
    expect(plan.versions[0].hash_origin).toBe("legacy-uri-derived");
    const result = recoverArtifactCustody(db, { retirement_packet_path: packetPath, recovery_receipt_path: recoveryReceiptPath });
    expect(result).toMatchObject({
      status: "applied",
      retired_versions: 1,
      retirement_packet_path: packetPath,
      removed_graph_entities: 1,
      removed_graph_edges: 1,
    });
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as Record<string, unknown>;
    expect(packet).toMatchObject({ schema: "mandible-artifact-retirement@1", plan_digest: plan.plan_digest });
    expect((packet.versions as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "version-retire", metadata_json: expect.any(String) });
    expect((packet.dependencies as Array<Record<string, unknown>>)[0].row).toHaveProperty("id");
    expect(packet.graph_entities).toEqual([expect.objectContaining({ id: staleGraphId })]);
    expect(packet.graph_edges).toEqual([expect.objectContaining({ id: "bundle-edge-stale" })]);
    expect(packet.graph_reclassified_entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: keptGraphId }),
      expect.objectContaining({ id: "artifact:ref:external-reference" }),
    ]));
    expect(JSON.parse(fs.readFileSync(recoveryReceiptPath, "utf8"))).toMatchObject({ schema: "mandible-artifact-recovery-receipt@1", plan_digest: plan.plan_digest });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_version WHERE id = 'version-retire'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact WHERE id = 'artifact-retire'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_links WHERE target_id = 'version-retire'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_artifact_associations WHERE target_id = 'version-retire'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_blob WHERE id = 'blob-retire'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT storage_uri FROM artifact_blob WHERE id = 'blob-orphan-kept'").get())
      .toEqual({ storage_uri: `file://${keptPath}` });
    expect(db.prepare("SELECT COUNT(*) AS count FROM graph_entities WHERE id = ?").get(staleGraphId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM graph_edges WHERE id = 'bundle-edge-stale'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT entity_type FROM graph_entities WHERE id = 'bundle-test'").get()).toEqual({ entity_type: "artifact_bundle" });
    expect(db.prepare("SELECT entity_type, summary_json, detail_ref_json FROM graph_entities WHERE id = ?").get(keptGraphId))
      .toMatchObject({ entity_type: "artifact" });
    const keptGraph = db.prepare("SELECT summary_json, detail_ref_json FROM graph_entities WHERE id = ?").get(keptGraphId) as { summary_json: string; detail_ref_json: string };
    expect(keptGraph.summary_json).not.toContain("custody_mode");
    expect(keptGraph.detail_ref_json).not.toContain("custody");
    const externalReference = db.prepare("SELECT entity_type, summary_json, detail_ref_json FROM graph_entities WHERE id = 'artifact:ref:external-reference'").get() as {
      entity_type: string;
      summary_json: string;
      detail_ref_json: string;
    };
    expect(externalReference).toMatchObject({ entity_type: "external_reference" });
    expect(externalReference.summary_json).not.toContain("custody_mode");
    expect(externalReference.detail_ref_json).not.toContain("custody");
    expect(externalReference.detail_ref_json).toContain("git+ssh://example.invalid/repo.git@{ref}");
  });

  it("blocks graph cleanup when a retiring projection has an unknown edge endpoint", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-graph-block-"));
    db = createMigratedDb();
    const missingHash = sha256("unknown graph endpoint");
    addArtifact(db, {
      id: "artifact-graph-block",
      versionId: "version-graph-block",
      blobId: "blob-graph-block",
      hash: missingHash,
      sourceKind: "external",
      custodyMode: "external",
      blobCustody: "external",
      blobAvailability: "remote_only",
    });
    const graphId = `artifact:sha256:${missingHash}`;
    addGraphEntity(db, { id: graphId });
    addGraphEdge(db, { id: "graph-edge-unknown", sourceId: graphId, targetId: "missing-independent-content" });
    const receiptPath = path.join(tempRoot, "graph-block.receipt.json");
    const packetPath = path.join(tempRoot, "graph-block.packet.json");
    const plan = planArtifactRecovery(db, { recovery_receipt_path: receiptPath, retirement_packet_path: packetPath });
    expect(plan.graph_entities).toEqual([expect.objectContaining({ id: graphId })]);
    expect(plan.summary.graph_unknown_references).toBe(1);
    const result = applyArtifactRecovery(db, plan, { recovery_receipt_path: receiptPath, retirement_packet_path: packetPath });
    expect(result).toMatchObject({ status: "blocked", removed_graph_entities: 0, removed_graph_edges: 0 });
    expect(result.blockers.join(" ")).toContain("unknown reference");
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_version WHERE id = 'version-graph-block'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM graph_entities WHERE id = ?").get(graphId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM graph_edges WHERE id = 'graph-edge-unknown'").get()).toEqual({ count: 1 });
  });

  it("blocks retirement when a Briefing round owns the unresolved version", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-block-"));
    db = createMigratedDb();
    addProject(db, path.join(tempRoot, "empty-checkout"), "block-repo");
    addArtifact(db, {
      id: "artifact-block",
      versionId: "version-block",
      blobId: "blob-block",
      hash: sha256("missing briefing bytes"),
      sourceKind: "external",
      custodyMode: "external",
      blobCustody: "external",
      blobAvailability: "remote_only",
    });
    db.prepare(
      `INSERT INTO briefings (id, briefing_key, title, description, latest_round_id, round_count, created_at, updated_at)
       VALUES ('briefing-block', 'briefing-block', 'Block', NULL, 'round-block', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO briefing_rounds
       (id, briefing_id, ordinal, artifact_version_id, profile, binding_digest, created_at)
       VALUES ('round-block', 'briefing-block', 1, 'version-block', 'mandible-briefing.v3', ?, 1)`,
    ).run("a".repeat(64));

    const recoveryReceiptPath = path.join(tempRoot, "recovery.receipt.json");
    const plan = planArtifactRecovery(db, { recovery_receipt_path: recoveryReceiptPath });
    expect(plan.summary).toMatchObject({ retire: 1, content_owning_dependencies: 1 });
    const result = applyArtifactRecovery(db, plan, { recovery_receipt_path: recoveryReceiptPath });
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]).toContain("content-owning");
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_version WHERE id = 'version-block'").get()).toEqual({ count: 1 });
    expect(() => recoverArtifactCustody(db!, { recovery_receipt_path: recoveryReceiptPath })).toThrow(/blocked/);
  });

  it("writes a restorable packet for blob-only retirement", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-blob-retire-"));
    db = createMigratedDb();
    const missingHash = sha256("blob-only missing bytes");
    db.prepare(
      `INSERT INTO artifact_blob
        (id, algorithm, content_hash, storage_uri, size_bytes, metadata_json, custody_mode,
         availability, retention_json, reference_json, created_at)
       VALUES ('blob-only-retire', 'sha256', ?, NULL, 0, '{}', 'external', 'remote_only', '{}', '{}', 1)`,
    ).run(missingHash);
    const packetPath = path.join(tempRoot, "retirement", "blob-only.json");
    const receiptPath = path.join(tempRoot, "blob-only.receipt.json");
    const plan = planArtifactRecovery(db, { retirement_packet_path: packetPath, recovery_receipt_path: receiptPath });
    expect(plan.summary).toMatchObject({ versions: 0, retire: 0, blobs: 1, blobs_retire: 1 });
    const result = applyArtifactRecovery(db, plan, { retirement_packet_path: packetPath, recovery_receipt_path: receiptPath });
    expect(result).toMatchObject({ status: "applied", retirement_packet_path: packetPath, retired_blobs: 1 });
    expect(JSON.parse(fs.readFileSync(packetPath, "utf8"))).toMatchObject({
      schema: "mandible-artifact-retirement@1",
      plan_digest: plan.plan_digest,
      blobs: [expect.objectContaining({ id: "blob-only-retire" })],
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_blob WHERE id = 'blob-only-retire'").get()).toEqual({ count: 0 });
  });

  it("resolves one canonical staged URI when Git and managed versions share a blob", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-shared-blob-"));
    db = createMigratedDb();
    const repoRoot = path.join(tempRoot, "repo");
    const repoFile = makeRepo(repoRoot, "shared bytes\n");
    const project = addProject(db, repoRoot, "shared-blob-repo");
    const hash = sha256("shared bytes\n");
    const legacyStorage = path.join(tempRoot, "legacy-storage.md");
    fs.writeFileSync(legacyStorage, "shared bytes\n");
    const managedSource = path.join(tempRoot, "managed-source.md");
    fs.writeFileSync(managedSource, "shared bytes\n");
    addArtifact(db, {
      id: "artifact-shared-git",
      versionId: "version-shared-git",
      blobId: "blob-shared",
      hash,
      sourceKind: "tracked_repo",
      custodyMode: "copy",
      sourceProjectId: project,
      repoPath: "report.md",
      commitSha: repoFile.commit,
      blobStorageUri: `file://${legacyStorage}`,
      blobCustody: "copy",
      blobAvailability: "present",
    });
    addArtifact(db, {
      id: "artifact-shared-managed",
      versionId: "version-shared-managed",
      blobId: "blob-shared",
      hash,
      sourceKind: "local_only",
      custodyMode: "copy",
      observedPath: managedSource,
      reuseBlobId: "blob-shared",
      blobCustody: "copy",
      blobAvailability: "present",
    });
    const stagedPath = path.join(tempRoot, "staged", "shared-bytes");
    let stageCalls = 0;
    const options = {
      recovery_receipt_path: path.join(tempRoot, "shared.receipt.json"),
      retain_git_commit: () => "refs/test/shared",
      stage_managed_bytes: (input: { bytes: Buffer; content_hash: string; version_id: string }) => {
        stageCalls += 1;
        expect(input.version_id).toBe("version-shared-managed");
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        fs.writeFileSync(stagedPath, input.bytes);
        return `file://${stagedPath}`;
      },
    };
    const plan = planArtifactRecovery(db, options);
    expect(plan.blobs.find(blob => blob.blob_id === "blob-shared")).toMatchObject({
      disposition: "managed",
      desired_storage_uri: null,
      requires_staging: true,
    });
    const result = applyArtifactRecovery(db, plan, options);
    expect(result).toMatchObject({ status: "applied", staged_managed_bytes: 1, staged_managed_blobs: 1 });
    expect(stageCalls).toBe(1);
    expect(db.prepare("SELECT storage_uri FROM artifact_blob WHERE id = 'blob-shared'").get()).toEqual({ storage_uri: `file://${stagedPath}` });
  });

  it("rechecks version state inside the transaction after staging callbacks run", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-race-"));
    db = createMigratedDb();
    const source = path.join(tempRoot, "source.md");
    fs.writeFileSync(source, "race bytes\n");
    const project = addProject(db, path.join(tempRoot, "empty-checkout"), "race-repo");
    addArtifact(db, {
      id: "artifact-race",
      versionId: "version-race",
      blobId: "blob-race",
      hash: sha256("race bytes\n"),
      sourceKind: "local_only",
      custodyMode: "copy",
      observedPath: source,
      blobCustody: "copy",
      blobAvailability: "present",
    });
    addArtifact(db, {
      id: "artifact-retire-race",
      versionId: "version-retire-race",
      blobId: "blob-retire-race",
      hash: sha256("missing race bytes\n"),
      sourceKind: "external",
      custodyMode: "external",
      blobCustody: "external",
      blobAvailability: "remote_only",
    });
    addDerivedRefs(db, "version-retire-race", "blob-retire-race", project);
    const receiptPath = path.join(tempRoot, "race.receipt.json");
    const plan = planArtifactRecovery(db, { recovery_receipt_path: receiptPath, stage_root: path.join(tempRoot, "cas") });
    expect(plan.summary.managed).toBe(1);
    expect(() => applyArtifactRecovery(db, plan, {
      recovery_receipt_path: receiptPath,
      stage_root: path.join(tempRoot, "cas"),
      stage_managed_bytes: input => {
        db!.prepare("UPDATE artifact_links SET role = 'raced' WHERE id = 'link-version-retire-race'").run();
        const target = path.join(tempRoot!, "callback-cas", input.content_hash);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, input.bytes);
        return `file://${target}`;
      },
    })).toThrow(/changed since recovery plan/);
    expect(db.prepare("SELECT note, custody_mode FROM artifact_version WHERE id = 'version-race'").get())
      .toEqual({ note: null, custody_mode: "copy" });
    expect(db.prepare("SELECT role FROM artifact_links WHERE id = 'link-version-retire-race'").get())
      .toEqual({ role: "raced" });
  });
});
