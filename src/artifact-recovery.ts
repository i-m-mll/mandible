import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson } from "./canonical-json.js";
import { artifactDescriptiveMetadata } from "./artifact-metadata.js";
import { readCommittedArtifactFiles } from "./artifact-commit-source.js";
import type { Db } from "./db.js";

/**
 * Recovery runs immediately before the strict two-custody migration.  The
 * v184 database still accepts `link`, `copy`, `managed`, and `external`; this
 * module deliberately emits only `link` or `managed`, leaving the v185
 * migration to rename the former to `git` and rebuild the rows.
 */
export const ARTIFACT_RECOVERY_SCHEMA = "mandible-artifact-recovery@1";

type JsonObject = Record<string, unknown>;
type LegacyCustodyMode = "link" | "copy" | "managed" | "external";
type RecoveryCustodyMode = "link" | "managed";

export type RecoveryDisposition = "git" | "managed" | "retire";
export type DependencyClass = "content-owning" | "derived-reference" | "unknown-reference";

export interface GitReadInput {
  project: string;
  commit: string;
  path: string;
}

export interface GitReadResult {
  project_id: string;
  commit: string;
  path: string;
  bytes: Buffer;
}

export type GitReader = (db: Db, input: GitReadInput) => GitReadResult;

export interface ManagedByteStageInput {
  bytes: Buffer;
  content_hash: string;
  version_id: string;
}

export type ManagedByteStage = (input: ManagedByteStageInput) => string;

export interface GitCommitRetainInput {
  project: string;
  commit: string;
  path: string;
  sha256: string;
}

export type GitCommitRetainer = (db: Db, input: GitCommitRetainInput) => string;

export interface ArtifactRecoveryOptions {
  /** Maximum versions inspected in one bounded invocation. Defaults to all. */
  max_versions?: number;
  /** Root under which staged managed bytes are written. */
  stage_root?: string;
  /** Override the default Git object-store reader in tests or newer runtimes. */
  git_reader?: GitReader;
  /** Override staging in tests or a migration-owned durable storage service. */
  stage_managed_bytes?: ManagedByteStage;
  /** Override Git retention in tests or a migration-owned retention service. */
  retain_git_commit?: GitCommitRetainer;
  /** Destination for the exact restorable retirement packet. */
  retirement_packet_path?: string;
  /** Destination for the complete evidence receipt for every inspected row. */
  recovery_receipt_path?: string;
}

export interface RecoveryEvidence {
  kind: "git" | "managed-bytes";
  source: string;
  locator: string;
  verified: boolean;
  expected_sha256: string;
  actual_sha256: string | null;
  size_bytes: number | null;
  project_id?: string;
  commit_sha?: string;
  repo_path?: string;
  reason?: string;
  requires_staging?: boolean;
}

export interface ArtifactDependencyReference {
  table: string;
  column: string;
  identity: JsonObject;
  dependency_class: DependencyClass;
  unique_user_content: boolean;
  value: string;
  row: JsonObject;
}

interface ArtifactVersionRow extends JsonObject {
  id: string;
  artifact_id: string;
  version_no: number;
  blob_id: string;
  source_kind: string;
  content_hash: string;
  source_project_id: string | null;
  source_repo_id: string | null;
  repo_path: string | null;
  commit_sha: string | null;
  observed_path: string | null;
  source_locator_json: string;
  custody_mode: LegacyCustodyMode | null;
  label: string | null;
  note: string | null;
  metadata_json: string;
  created_at: number;
}

interface ArtifactBlobRow extends JsonObject {
  id: string;
  algorithm: string;
  content_hash: string;
  storage_uri: string | null;
  metadata_json: string;
  custody_mode: LegacyCustodyMode | null;
  availability: string | null;
  retention_json: string;
  reference_json: string;
  size_bytes: number;
  [key: string]: unknown;
}

interface ArtifactLogicalRow extends JsonObject {
  id: string;
  [key: string]: unknown;
}

interface RepoCandidate {
  project: string;
  commit: string;
  path: string;
  source: string;
  direct: boolean;
}

interface FileCandidate {
  path: string;
  source: string;
  is_cas: boolean;
}

interface PlannedVersion {
  version_id: string;
  artifact_id: string;
  blob_id: string;
  version_no: number;
  original: JsonObject;
  disposition: RecoveryDisposition;
  hash_origin: "known" | "legacy-uri-derived";
  desired: {
    custody_mode: RecoveryCustodyMode;
    source_kind: "tracked_repo" | "managed";
    source_project_id: string | null;
    source_repo_id: null;
    repo_path: string | null;
    commit_sha: string | null;
    source_locator_json: string;
    metadata_json: string;
    blob_storage_uri: string | null;
    requires_staging: boolean;
  } | null;
  evidence: RecoveryEvidence[];
  reason_codes: string[];
  dependencies: ArtifactDependencyReference[];
  artifact_dependencies: ArtifactDependencyReference[];
  retirement?: {
    version_row: JsonObject;
    artifact_row: JsonObject | null;
    blob_row: JsonObject | null;
  };
}

type BlobRecoveryDisposition = "git-referenced" | "managed" | "retire";

interface PlannedBlob {
  blob_id: string;
  original: JsonObject;
  disposition: BlobRecoveryDisposition;
  content_hash: string;
  desired_storage_uri: string | null;
  requires_staging: boolean;
  evidence: RecoveryEvidence[];
  reason_codes: string[];
  dependencies: ArtifactDependencyReference[];
}

export interface ArtifactRetirementPacket {
  schema: "mandible-artifact-retirement@1";
  versions: JsonObject[];
  artifacts: JsonObject[];
  blobs: JsonObject[];
  dependencies: ArtifactDependencyReference[];
  graph_entities: JsonObject[];
  graph_edges: JsonObject[];
  graph_reclassified_entities: JsonObject[];
}

export interface ArtifactRecoverySummary {
  versions: number;
  git: number;
  managed: number;
  retire: number;
  already_canonical: number;
  staged_managed_bytes: number;
  malformed: number;
  unrecoverable: number;
  dependent_versions: number;
  content_owning_dependencies: number;
  derived_dependencies: number;
  unknown_dependencies: number;
  known_hashes: number;
  synthetic_hashes: number;
  retire_known_hashes: number;
  retire_synthetic_hashes: number;
  blobs: number;
  blobs_git_referenced: number;
  blobs_managed: number;
  blobs_retire: number;
  blob_content_owning_dependencies: number;
  blob_derived_dependencies: number;
  graph_entities: number;
  graph_edges: number;
  graph_legacy_authority_entities: number;
  graph_unknown_references: number;
}

export interface ArtifactRecoveryPlan {
  schema: typeof ARTIFACT_RECOVERY_SCHEMA;
  source_schema_version: number | null;
  summary: ArtifactRecoverySummary;
  versions: PlannedVersion[];
  artifacts: ArtifactLogicalRow[];
  sources: JsonObject[];
  blobs: PlannedBlob[];
  graph_entities: JsonObject[];
  graph_observed_entities: JsonObject[];
  graph_edges: JsonObject[];
  graph_reclassified_entities: Array<{ original: JsonObject; desired: JsonObject }>;
  graph_blockers: string[];
  retirement_packet: ArtifactRetirementPacket;
  dependency_scan_errors: string[];
  plan_digest: string;
}

export interface ArtifactRecoveryApplyResult {
  status: "applied" | "blocked";
  plan: ArtifactRecoveryPlan;
  applied_versions: number;
  skipped_versions: number;
  updated_blobs: number;
  staged_managed_bytes: number;
  retirement_packet: ArtifactRetirementPacket;
  retirement_packet_path: string | null;
  recovery_receipt_path: string | null;
  retired_versions: number;
  retired_blobs: number;
  removed_graph_entities: number;
  removed_graph_edges: number;
  staged_managed_blobs: number;
  retained_git_commits: string[];
  historical_source_associations: number;
  blockers: string[];
}

export class ArtifactRecoveryBlockedError extends Error {
  constructor(readonly plan: ArtifactRecoveryPlan) {
    super(
      `Artifact recovery is blocked by ${plan.summary.retire} unresolved version(s), `
      + `${plan.summary.blobs_retire} unresolved blob(s), ${plan.summary.graph_unknown_references} unsafe graph reference(s), `
      + "or unsafe dependency evidence; "
      + "the v185 migration must not discard them without a restorable retirement policy",
    );
    this.name = "ArtifactRecoveryBlockedError";
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{7,64}$/i;
const DERIVED_ARTIFACT_GRAPH_SOURCES = new Set(["artifacts", "artifact_references"]);
const LEGACY_ARTIFACT_AUTHORITY_KEYS = new Set([
  "availability",
  "custody_mode",
  "home_repo_id",
  "recoverability",
  "reference",
  "repo_locator",
  "retention",
  "storage_backend",
]);

interface ArtifactGraphScan {
  entities: JsonObject[];
  observedEntities: JsonObject[];
  edges: JsonObject[];
  reclassifiedEntities: Array<{ original: JsonObject; desired: JsonObject }>;
  blockers: string[];
  legacyAuthorityEntities: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseJsonObject(value: unknown): { value: JsonObject; valid: boolean } {
  if (typeof value !== "string") return { value: {}, valid: false };
  try {
    const parsed = JSON.parse(value) as unknown;
    return { value: asObject(parsed), valid: Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)) };
  } catch {
    return { value: {}, valid: false };
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function containsLegacyArtifactAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => containsLegacyArtifactAuthority(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(([key, child]) =>
    LEGACY_ARTIFACT_AUTHORITY_KEYS.has(key) || containsLegacyArtifactAuthority(child));
}

function graphRowsEqual(left: JsonObject[], right: JsonObject[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function graphIdentityKeys(value: unknown): string[] {
  const text = asString(value);
  if (!text) return [];
  const keys = new Set([text]);
  const sha256 = text.match(/^artifact-(?:blob|sha256):([a-f0-9]{64})$/i)?.[1]
    ?? text.match(/^artifact:sha256:([a-f0-9]{64})$/i)?.[1]
    ?? (SHA256_RE.test(text) ? text : undefined);
  if (sha256) keys.add(`sha256:${sha256.toLowerCase()}`);
  return Array.from(keys);
}

function stripGraphAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGraphAuthority);
  if (!value || typeof value !== "object") return value;
  const removed = new Set([
    "artifact_id",
    "artifact_recovery",
    "availability",
    "content_identity",
    "custody",
    "custody_mode",
    "home_repo_id",
    "recoverability",
    "registered_source_migration",
    "repo_locator",
    "repo_locator_json",
    "retention",
    "source_locator",
    "source_locator_json",
    "storage_backend",
    "storage_uri",
  ]);
  return Object.fromEntries(Object.entries(value as JsonObject)
    .filter(([key]) => !removed.has(key))
    .map(([key, child]) => [key, stripGraphAuthority(child)]));
}

function jsonObjectString(value: unknown): string {
  return JSON.stringify(stripGraphAuthority(value));
}

function graphBlobForEntity(db: Db, entity: JsonObject): ArtifactBlobRow | null {
  for (const value of [entity.id, entity.external_id]) {
    for (const key of graphIdentityKeys(value)) {
      const exactId = key.startsWith("sha256:") ? `artifact-blob:${key.slice("sha256:".length)}` : key;
      const byId = readBlob(db, exactId);
      if (byId) return byId;
      if (key.startsWith("sha256:")) {
        const byHash = db.prepare("SELECT * FROM artifact_blob WHERE algorithm = 'sha256' AND lower(content_hash) = ? LIMIT 1")
          .get(key.slice("sha256:".length)) as ArtifactBlobRow | undefined;
        if (byHash) return byHash;
      }
    }
  }
  return null;
}

function regeneratedArtifactGraphEntity(db: Db, entity: JsonObject): JsonObject | null {
  const blob = graphBlobForEntity(db, entity);
  if (!blob) return null;
  const version = db.prepare(
    `SELECT * FROM artifact_version WHERE blob_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
  ).get(blob.id) as JsonObject | undefined;
  const logical = version ? readArtifact(db, String(version.artifact_id)) : null;
  const blobMetadata = parseJsonObject(blob.metadata_json).value;
  const logicalMetadata = parseJsonObject(logical?.metadata_json).value;
  const versionMetadata = parseJsonObject(version?.metadata_json).value;
  const metadata = artifactDescriptiveMetadata({ ...blobMetadata, ...logicalMetadata, ...versionMetadata });
  const contentHash = String(blob.content_hash).toLowerCase();
  return {
    ...entity,
    entity_type: "artifact",
    repo_id: null,
    provider_id: blob.provider_id ?? null,
    external_id: contentHash,
    status: blob.storage_uri || version?.custody_mode === "link" ? "available" : "missing",
    labels_json: "[]",
    summary_json: JSON.stringify({
      role: blob.role ?? null,
      media_type: blob.media_type ?? null,
      size_bytes: blob.size_bytes,
    }),
    detail_ref_json: JSON.stringify({ content_hash: contentHash, metadata }),
    action_context_json: JSON.stringify([
      { id: "open-artifact", label: "Open Artifact", kind: "preview", target: entity.id },
      { id: "validate-artifact", label: "Validate", kind: "validate", target: entity.id },
    ]),
    visual_json: JSON.stringify({ icon: "artifact", shape: "document" }),
    source: "artifacts",
  };
}

function externalReferenceGraphEntity(entity: JsonObject): JsonObject {
  return {
    ...entity,
    entity_type: "external_reference",
    repo_id: null,
    summary_json: jsonObjectString(parseJsonObject(entity.summary_json).value),
    detail_ref_json: jsonObjectString(parseJsonObject(entity.detail_ref_json).value),
    action_context_json: JSON.stringify([
      { id: "inspect", label: "Inspect", kind: "preview", target: entity.id },
    ]),
    visual_json: JSON.stringify({ icon: "link", shape: "document" }),
  };
}

function readArtifactGraphScan(
  db: Db,
  retirementIdentityKeys: Set<string>,
): ArtifactGraphScan {
  if (!tableExists(db, "graph_entities")) {
    return {
      entities: [], observedEntities: [], edges: [], reclassifiedEntities: [], blockers: [], legacyAuthorityEntities: 0,
    };
  }
  const observedEntities = db.prepare(
    "SELECT * FROM graph_entities WHERE entity_type = 'artifact' ORDER BY id",
  ).all() as JsonObject[];
  const blockers: string[] = [];
  const entities: JsonObject[] = [];
  const reclassifiedEntities: Array<{ original: JsonObject; desired: JsonObject }> = [];
  for (const entity of observedEntities) {
    const source = asString(entity.source);
    const identityMatch = [...graphIdentityKeys(entity.id), ...graphIdentityKeys(entity.external_id)]
      .some(key => retirementIdentityKeys.has(key));
    if (source === "artifact_references") {
      // These rows are provenance references, not custody-bearing artifacts.
      // Keep their identity and incident edges, but make the graph type agree
      // with the current provenance-only producer and strip old authority.
      reclassifiedEntities.push({ original: { ...entity }, desired: externalReferenceGraphEntity(entity) });
      continue;
    }
    if (!DERIVED_ARTIFACT_GRAPH_SOURCES.has(source ?? "") && identityMatch) {
      blockers.push(`artifact graph entity ${String(entity.id)} has unknown source ${source ?? "<missing>"}`);
      continue;
    }
    if (!DERIVED_ARTIFACT_GRAPH_SOURCES.has(source ?? "")) continue;
    const regenerated = regeneratedArtifactGraphEntity(db, entity);
    if (!regenerated) {
      if (identityMatch) {
        entities.push({ ...entity });
        continue;
      }
      blockers.push(`artifact graph entity ${String(entity.id)} has no canonical artifact blob`);
      continue;
    }
    // Remove only canonical projections whose content identity is retiring.
    // Retained projections are regenerated below so no old custody envelope
    // survives merely because a graph row happened to be retained.
    if (identityMatch) entities.push({ ...entity });
    else if (canonicalJson(entity) !== canonicalJson(regenerated)) {
      reclassifiedEntities.push({ original: { ...entity }, desired: regenerated });
    }
  }
  const removedIds = new Set(entities.map(entity => String(entity.id)));
  const entityIds = tableExists(db, "graph_entities")
    ? new Set((db.prepare("SELECT id FROM graph_entities").all() as Array<{ id: string }>).map(row => String(row.id)))
    : new Set<string>();
  const legacyAuthorityEntities = observedEntities.filter(entity => [
    "summary_json",
    "detail_ref_json",
    "action_context_json",
  ].some(column => containsLegacyArtifactAuthority(parseJsonValue(entity[column])))).length;
  const edges = tableExists(db, "graph_edges")
    ? (db.prepare("SELECT * FROM graph_edges ORDER BY id").all() as JsonObject[])
      .filter(edge => removedIds.has(String(edge.source_id)) || removedIds.has(String(edge.target_id)))
    : [];
  for (const edge of edges) {
    const sourceId = String(edge.source_id);
    const targetId = String(edge.target_id);
    if (!entityIds.has(sourceId) || !entityIds.has(targetId)) {
      blockers.push(
        `artifact graph edge ${String(edge.id)} references unknown or independent endpoint `
        + `${sourceId} -> ${targetId}`,
      );
    }
  }
  return {
    entities,
    observedEntities,
    edges,
    reclassifiedEntities,
    blockers: Array.from(new Set(blockers)).sort(),
    legacyAuthorityEntities,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileUriPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : null;
  } catch {
    return null;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function defaultArtifactRoot(db: Db): string {
  const envRoot = asString(process.env.MANDIBLE_ARTIFACT_DIR);
  if (envRoot) return path.resolve(envRoot.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
  if (tableExists(db, "settings")) {
    const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("artifact_root") as { value?: unknown } | undefined;
    const configured = asString(setting?.value);
    if (configured) return path.resolve(configured.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
  }
  const home = process.env.MANDIBLE_HOME
    ? path.resolve(process.env.MANDIBLE_HOME)
    : path.join(process.env.HOME ?? process.cwd(), ".mandible");
  return path.join(home, "artifacts");
}

function casPath(root: string, hash: string): string {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

function defaultGitReader(db: Db, input: GitReadInput): GitReadResult {
  const [file] = readCommittedArtifactFiles(db, {
    project: input.project,
    commit: input.commit,
    paths: [input.path],
  });
  return file;
}


function readVersionRows(db: Db, maxVersions?: number): ArtifactVersionRow[] {
  const limit = maxVersions === undefined ? "" : ` LIMIT ${Math.max(0, Math.floor(maxVersions))}`;
  return db.prepare(
    `SELECT id, artifact_id, version_no, blob_id, source_kind, content_hash,
            source_project_id, source_repo_id, repo_path, commit_sha, observed_path,
            source_locator_json, custody_mode, label, note, metadata_json, created_at
       FROM artifact_version
      ORDER BY id${limit}`,
  ).all() as ArtifactVersionRow[];
}

function readBlob(db: Db, id: string): ArtifactBlobRow | null {
  if (!tableExists(db, "artifact_blob")) return null;
  return db.prepare("SELECT * FROM artifact_blob WHERE id = ?").get(id) as ArtifactBlobRow | undefined ?? null;
}

function readAllBlobs(db: Db): ArtifactBlobRow[] {
  if (!tableExists(db, "artifact_blob")) return [];
  return db.prepare("SELECT * FROM artifact_blob ORDER BY id").all() as ArtifactBlobRow[];
}

function readArtifact(db: Db, id: string): ArtifactLogicalRow | null {
  if (!tableExists(db, "artifact")) return null;
  return db.prepare("SELECT * FROM artifact WHERE id = ?").get(id) as ArtifactLogicalRow | undefined ?? null;
}

function sourceSchemaVersion(db: Db): number | null {
  if (!tableExists(db, "meta")) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as { value?: unknown } | undefined;
  const value = Number(row?.value);
  return Number.isSafeInteger(value) ? value : null;
}

function parentVersionId(locator: JsonObject): string | null {
  const parent = asString(locator.parent_version_id);
  return parent ?? null;
}

function normalizedSourceLocator(locator: JsonObject): string {
  return canonicalJson({ parent_version_id: parentVersionId(locator) });
}

function addRepoCandidate(
  candidates: RepoCandidate[],
  candidate: Partial<RepoCandidate> & { source: string; direct?: boolean },
): void {
  const project = asString(candidate.project);
  const commit = asString(candidate.commit);
  const repoPath = asString(candidate.path);
  if (!project || !commit || !repoPath || !COMMIT_RE.test(commit)) return;
  if (repoPath.startsWith("/") || repoPath.includes("\\") || repoPath.split("/").some(part => !part || part === "." || part === "..")) return;
  const key = `${project}\0${commit}\0${repoPath}`;
  if (!candidates.some(existing => `${existing.project}\0${existing.commit}\0${existing.path}` === key)) {
    candidates.push({ project, commit, path: repoPath, source: candidate.source, direct: candidate.direct ?? false });
  }
}

function walkLegacyRepoEvidence(
  value: unknown,
  source: string,
  candidates: RepoCandidate[],
  depth = 0,
): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") walkLegacyRepoEvidence(parsed, source, candidates, depth + 1);
    } catch {
      const uri = /^repo:\/\/([^/@\s]+)@([^/\s]+)\/(.+)$/.exec(value.trim());
      if (uri) addRepoCandidate(candidates, { project: uri[1], commit: uri[2], path: uri[3], source, direct: false });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkLegacyRepoEvidence(entry, `${source}[${index}]`, candidates, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as JsonObject;
  const project = asString(record.source_project_id)
    ?? asString(record.project_id)
    ?? asString(record.repo_id)
    ?? asString(record.repo)
    ?? asString(record.project);
  const commit = asString(record.commit_sha) ?? asString(record.commit) ?? asString(record.ref);
  const repoPath = asString(record.repo_path) ?? asString(record.relative_path) ?? asString(record.path);
  if (project && commit && repoPath) addRepoCandidate(candidates, { project, commit, path: repoPath, source, direct: false });
  for (const [key, nested] of Object.entries(record)) {
    if (key === "legacy_repo_locator" || key === "repo_locator" || key === "legacy_uri" || key === "uri" || key.endsWith("_locator")) {
      walkLegacyRepoEvidence(nested, `${source}.${key}`, candidates, depth + 1);
    }
  }
}

function repoCandidates(version: ArtifactVersionRow, artifact: ArtifactLogicalRow | null, blob: ArtifactBlobRow | null, locator: JsonObject): RepoCandidate[] {
  const candidates: RepoCandidate[] = [];
  if (version.source_project_id && version.commit_sha && version.repo_path) {
    addRepoCandidate(candidates, {
      project: version.source_project_id,
      commit: version.commit_sha,
      path: version.repo_path,
      source: "version.columns",
      direct: true,
    });
  }
  const versionMetadata = parseJsonObject(version.metadata_json).value;
  const artifactMetadata = parseJsonObject(artifact?.metadata_json).value;
  const blobMetadata = parseJsonObject(blob?.metadata_json).value;
  const blobReference = parseJsonObject(blob?.reference_json).value;
  walkLegacyRepoEvidence(locator, "version.source_locator_json", candidates);
  walkLegacyRepoEvidence(versionMetadata, "version.metadata_json", candidates);
  walkLegacyRepoEvidence(artifactMetadata, "artifact.metadata_json", candidates);
  walkLegacyRepoEvidence(blobMetadata, "blob.metadata_json", candidates);
  walkLegacyRepoEvidence(blobReference, "blob.reference_json", candidates);
  return candidates;
}

function fileCandidates(db: Db, version: ArtifactVersionRow, blob: ArtifactBlobRow | null, expectedHash: string): FileCandidate[] {
  const candidates: FileCandidate[] = [];
  const add = (value: unknown, source: string, isCas: boolean): void => {
    const raw = asString(value);
    if (!raw) return;
    const filePath = raw.startsWith("file://") ? fileUriPath(raw) : raw;
    if (!filePath) return;
    let resolved: string;
    try { resolved = fs.realpathSync.native(path.resolve(filePath)); }
    catch { resolved = path.resolve(filePath); }
    if (!candidates.some(candidate => candidate.path === resolved)) candidates.push({ path: resolved, source, is_cas: isCas });
  };
  const root = defaultArtifactRoot(db);
  add(blob?.storage_uri, "blob.storage_uri", true);
  const reference = parseJsonObject(blob?.reference_json).value;
  add(reference.uri, "blob.reference_json.uri", false);
  if (tableExists(db, "artifact_aliases") && blob) {
    const aliases = db.prepare(
      `SELECT normalized_ref FROM artifact_aliases
        WHERE blob_id = ? AND scheme = 'file' AND resolution_status = 'resolved'
        ORDER BY normalized_ref`,
    ).all(blob.id) as Array<{ normalized_ref?: unknown }>;
    for (const alias of aliases) add(alias.normalized_ref, "artifact_aliases.file", true);
  }
  add(version.observed_path, "version.observed_path", false);
  const versionMetadata = parseJsonObject(version.metadata_json).value;
  add(versionMetadata.observed_path, "version.metadata_json.observed_path", false);
  add(versionMetadata.path, "version.metadata_json.path", false);
  if (SHA256_RE.test(expectedHash)) add(casPath(root, expectedHash), "default-cas", true);
  return candidates;
}

function blobFileCandidates(db: Db, blob: ArtifactBlobRow, expectedHash: string): FileCandidate[] {
  const candidates: FileCandidate[] = [];
  const add = (value: unknown, source: string, isCas: boolean): void => {
    const raw = asString(value);
    if (!raw) return;
    const filePath = raw.startsWith("file://") ? fileUriPath(raw) : raw;
    if (!filePath) return;
    let resolved: string;
    try { resolved = fs.realpathSync.native(path.resolve(filePath)); }
    catch { resolved = path.resolve(filePath); }
    if (!candidates.some(candidate => candidate.path === resolved)) candidates.push({ path: resolved, source, is_cas: isCas });
  };
  const root = defaultArtifactRoot(db);
  add(blob.storage_uri, "blob.storage_uri", true);
  const reference = parseJsonObject(blob.reference_json).value;
  add(reference.uri, "blob.reference_json.uri", false);
  if (tableExists(db, "artifact_aliases")) {
    const aliases = db.prepare(
      `SELECT normalized_ref FROM artifact_aliases
        WHERE blob_id = ? AND scheme = 'file' AND resolution_status = 'resolved'
        ORDER BY normalized_ref`,
    ).all(blob.id) as Array<{ normalized_ref?: unknown }>;
    for (const alias of aliases) add(alias.normalized_ref, "artifact_aliases.file", true);
  }
  if (SHA256_RE.test(expectedHash)) add(casPath(root, expectedHash), "default-cas", true);
  return candidates;
}

function hashOrigin(
  version: ArtifactVersionRow,
  blob: ArtifactBlobRow | null,
  locator: JsonObject,
  metadata: JsonObject,
): "known" | "legacy-uri-derived" {
  const reference = parseJsonObject(blob?.reference_json).value;
  const values = [version.source_locator_json, version.metadata_json, blob?.reference_json, JSON.stringify(locator), JSON.stringify(metadata), JSON.stringify(reference)]
    .filter((value): value is string => typeof value === "string");
  return values.some(value => /artifact:ref:|uri-derived|synthetic[_-]hash/i.test(value))
    ? "legacy-uri-derived"
    : "known";
}

function verifyFileCandidate(candidate: FileCandidate, expectedHash: string): RecoveryEvidence {
  try {
    const stat = fs.statSync(candidate.path);
    if (!stat.isFile()) throw new Error("not a regular file");
    const bytes = fs.readFileSync(candidate.path);
    const actual = sha256(bytes);
    return {
      kind: "managed-bytes",
      source: candidate.source,
      locator: candidate.path,
      verified: actual === expectedHash,
      expected_sha256: expectedHash,
      actual_sha256: actual,
      size_bytes: bytes.byteLength,
      ...(actual === expectedHash ? {} : { reason: "hash_mismatch" }),
      ...(actual === expectedHash ? { requires_staging: !candidate.is_cas } : {}),
    };
  } catch (error) {
    return {
      kind: "managed-bytes",
      source: candidate.source,
      locator: candidate.path,
      verified: false,
      expected_sha256: expectedHash,
      actual_sha256: null,
      size_bytes: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function verifyGitCandidate(db: Db, candidate: RepoCandidate, expectedHash: string, reader: GitReader): RecoveryEvidence {
  try {
    const result = reader(db, { project: candidate.project, commit: candidate.commit, path: candidate.path });
    const actual = sha256(result.bytes);
    const verified = actual === expectedHash;
    return {
      kind: "git",
      source: candidate.source,
      locator: `${result.project_id}@${result.commit}:${result.path}`,
      verified,
      expected_sha256: expectedHash,
      actual_sha256: actual,
      size_bytes: result.bytes.byteLength,
      project_id: result.project_id,
      commit_sha: result.commit,
      repo_path: result.path,
      ...(verified ? {} : { reason: "hash_mismatch" }),
    };
  } catch (error) {
    return {
      kind: "git",
      source: candidate.source,
      locator: `${candidate.project}@${candidate.commit}:${candidate.path}`,
      verified: false,
      expected_sha256: expectedHash,
      actual_sha256: null,
      size_bytes: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function contentDependencyClass(table: string): { dependency_class: DependencyClass; unique_user_content: boolean } {
  const contentTables = new Set([
    "briefings", "briefing_rounds", "briefing_submissions", "briefing_submission_answers",
    "briefing_submission_annotations", "briefing_response_events", "briefing_annotation_events",
    "briefing_directive_definitions", "briefing_directive_instances", "briefing_runs",
    "briefing_composition_runs", "briefing_composition_inputs", "briefing_composition_contributions",
    "briefing_composition_report_publications", "briefing_group_review_dispositions",
    "briefing_group_review_disposition_items", "briefing_group_review_destination_items",
    "artifact_drafts",
    "provider_manifests", "space_exports",
  ]);
  if (contentTables.has(table)) return { dependency_class: "content-owning", unique_user_content: true };
  if (new Set(["artifact", "artifact_links", "project_artifact_associations"]).has(table)) {
    return { dependency_class: "derived-reference", unique_user_content: false };
  }
  return { dependency_class: "unknown-reference", unique_user_content: false };
}

function primaryIdentity(columns: Array<{ name: string; pk: number }>, row: JsonObject): JsonObject {
  const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
  if (primary.length > 0) return Object.fromEntries(primary.map(column => [column.name, row[column.name]]));
  if ("id" in row) return { id: row.id };
  if ("__recovery_rowid" in row) return { rowid: row.__recovery_rowid };
  return {};
}

interface DependencyScan {
  references: Map<string, ArtifactDependencyReference[]>;
  errors: string[];
}

type DependencyTarget = "artifact" | "artifact_version" | "artifact_blob";

interface DependencyRule {
  excluded_tables: readonly string[];
  recognized_column: RegExp | null;
  retry_without_rowid: boolean;
  classify: typeof contentDependencyClass;
}

const DEPENDENCY_RULES: Record<DependencyTarget, DependencyRule> = {
  artifact: {
    excluded_tables: ["artifact", "artifact_version"],
    recognized_column: null,
    retry_without_rowid: false,
    classify: table => table === "project_artifact_associations"
      ? { dependency_class: "content-owning", unique_user_content: true }
      : contentDependencyClass(table),
  },
  artifact_version: {
    excluded_tables: ["artifact_version"],
    recognized_column: /(?:^version_id$|_version_id$|^artifact_version_id$)/,
    retry_without_rowid: true,
    classify: contentDependencyClass,
  },
  artifact_blob: {
    excluded_tables: ["artifact_blob"],
    recognized_column: /(?:^blob_id$|_blob_id$)/,
    retry_without_rowid: true,
    classify: table => ["artifact_version", "artifact_aliases", "artifact_links"].includes(table)
      ? { dependency_class: "derived-reference", unique_user_content: false }
      : contentDependencyClass(table),
  },
};

function collectDependencies(db: Db, target: DependencyTarget, ids: Set<string>): DependencyScan {
  const references = new Map<string, ArtifactDependencyReference[]>();
  const errors: string[] = [];
  if (ids.size === 0) return { references, errors };
  const rule = DEPENDENCY_RULES[target];
  const placeholders = Array.from(ids, () => "?").join(",");
  const captured = new Map<string, Map<string, ArtifactDependencyReference>>();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  for (const { name: table } of tables) {
    if (table.startsWith("sqlite_") || rule.excluded_tables.includes(table)) continue;
    let columns: Array<{ name: string; pk: number }>;
    try {
      columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>;
    } catch {
      continue;
    }
    const columnNames = new Set(columns.map(column => column.name));
    const referenceColumns = new Set(columns.map(column => column.name).filter(column => rule.recognized_column?.test(column)));
    if (rule.recognized_column) {
      try {
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{ table?: string; from?: string }>;
        for (const foreignKey of foreignKeys) {
          if (foreignKey.table === target && foreignKey.from) referenceColumns.add(foreignKey.from);
        }
      } catch {
        errors.push(`${table}.[foreign_key_list]`);
      }
    }
    if (columnNames.has("target_id") && columnNames.has("target_type")) referenceColumns.add("target_id");
    for (const column of Array.from(referenceColumns).sort()) {
      const where = `${target === "artifact" ? "target_type = 'artifact' AND " : ""}${quoteIdentifier(column)} IN (${placeholders})`;
      const readRows = (withRowid: boolean): JsonObject[] => db.prepare(
        `SELECT ${withRowid ? "rowid AS __recovery_rowid, " : ""}* FROM ${quoteIdentifier(table)} WHERE ${where}`,
      ).all(...ids) as JsonObject[];
      let rows: JsonObject[];
      try {
        rows = readRows(true);
      } catch {
        if (!rule.retry_without_rowid) {
          errors.push(`${table}.${column}`);
          continue;
        }
        try {
          rows = readRows(false);
        } catch {
          errors.push(`${table}.${column}`);
          continue;
        }
      }
      for (const row of rows) {
        const value = asString(row[column]);
        if (!value || !ids.has(value)) continue;
        if (column === "target_id" && row.target_type !== target) continue;
        const reference: ArtifactDependencyReference = {
          table,
          column,
          identity: primaryIdentity(columns, row),
          ...rule.classify(table),
          value,
          row: { ...row },
        };
        const existing = captured.get(value) ?? new Map<string, ArtifactDependencyReference>();
        existing.set(canonicalJson(reference), reference);
        captured.set(value, existing);
      }
    }
  }
  for (const [value, rows] of captured) {
    references.set(value, Array.from(rows).sort(([a], [b]) => a.localeCompare(b)).map(([, reference]) => reference));
  }
  return { references, errors: Array.from(new Set(errors)).sort() };
}

function versionFingerprint(row: ArtifactVersionRow | JsonObject): string {
  return canonicalJson({
    id: row.id,
    artifact_id: row.artifact_id,
    version_no: row.version_no,
    blob_id: row.blob_id,
    source_kind: row.source_kind,
    content_hash: row.content_hash,
    source_project_id: row.source_project_id,
    source_repo_id: row.source_repo_id,
    repo_path: row.repo_path,
    commit_sha: row.commit_sha,
    observed_path: row.observed_path,
    source_locator_json: row.source_locator_json,
    custody_mode: row.custody_mode,
    metadata_json: row.metadata_json,
    label: row.label,
    note: row.note,
    created_at: row.created_at,
  });
}

function blobFingerprint(row: JsonObject): string {
  return canonicalJson(row);
}

function verifiedInCustodyStorageUri(db: Db, uri: unknown, expectedHash: string, stageRoot?: string): boolean {
  const raw = asString(uri);
  const filePath = raw?.startsWith("file://") ? fileUriPath(raw) : null;
  if (!filePath || ![defaultArtifactRoot(db), ...(stageRoot ? [path.resolve(stageRoot)] : [])].some(root => pathInside(root, filePath))) return false;
  try { return sha256(fs.readFileSync(filePath)) === expectedHash; }
  catch { return false; }
}

function desiredVersionFingerprint(version: PlannedVersion): string {
  if (!version.desired) return "";
  return canonicalJson({
    id: version.version_id,
    artifact_id: version.artifact_id,
    version_no: version.version_no,
    blob_id: version.blob_id,
    source_kind: version.desired.source_kind,
    content_hash: version.original.content_hash,
    source_project_id: version.desired.source_project_id,
    source_repo_id: null,
    repo_path: version.desired.repo_path,
    commit_sha: version.desired.commit_sha,
    observed_path: version.original.observed_path,
    source_locator_json: version.desired.source_locator_json,
    custody_mode: version.desired.custody_mode,
    metadata_json: version.desired.metadata_json,
    label: version.original.label,
    note: version.original.note,
    created_at: version.original.created_at,
  });
}

function recoveryMetadata(
  metadata: JsonObject,
): string {
  const priorProvenance = asObject(metadata.provenance);
  const priorRecovery = asObject(priorProvenance.artifact_recovery);
  if (priorRecovery.schema === ARTIFACT_RECOVERY_SCHEMA) {
    const { artifact_recovery: _ignored, ...cleanProvenance } = priorProvenance;
    return Object.keys(cleanProvenance).length > 0
      ? canonicalJson({ ...metadata, provenance: cleanProvenance })
      : canonicalJson(Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "provenance")));
  }
  return canonicalJson(metadata);
}

function planBlobRecovery(
  db: Db,
  blobs: ArtifactBlobRow[],
  versions: PlannedVersion[],
  dependencies: Map<string, ArtifactDependencyReference[]>,
): PlannedBlob[] {
  const versionsByBlob = new Map<string, PlannedVersion[]>();
  for (const version of versions) {
    const list = versionsByBlob.get(version.blob_id) ?? [];
    list.push(version);
    versionsByBlob.set(version.blob_id, list);
  }
  return blobs.map(blob => {
    const expectedHash = asString(blob.content_hash)?.toLowerCase() ?? "";
    const linkedVersions = versionsByBlob.get(blob.id) ?? [];
    const reasonCodes: string[] = [];
    const evidence: RecoveryEvidence[] = [];
    if (blob.algorithm !== "sha256" || !SHA256_RE.test(expectedHash)) reasonCodes.push("malformed_blob_hash");
    const blobDependencies = dependencies.get(blob.id) ?? [];
    const managedVersions = linkedVersions.filter(version => version.disposition === "managed");
    const gitReferenced = linkedVersions.some(version => version.disposition === "git");
    const managedVersionRequiringStaging = managedVersions.find(version => version.desired?.requires_staging);
    const managedCasVersion = managedVersions.find(version => {
      const uri = version.desired?.blob_storage_uri;
      const candidate = uri ? fileUriPath(uri) : null;
      return Boolean(candidate && pathInside(defaultArtifactRoot(db), candidate));
    });
    if (gitReferenced && !managedVersionRequiringStaging && !managedCasVersion) {
      const root = defaultArtifactRoot(db);
      if (reasonCodes.length === 0) {
        for (const candidate of blobFileCandidates(db, blob, expectedHash)) {
          const item = verifyFileCandidate(candidate, expectedHash);
          evidence.push(item);
          if (item.verified && item.requires_staging === false && pathInside(root, item.locator)) break;
        }
      }
      const verifiedCas = evidence.find(item => item.verified && item.requires_staging === false && pathInside(root, item.locator));
      return {
        blob_id: blob.id,
        original: { ...blob },
        disposition: "git-referenced",
        content_hash: expectedHash,
        desired_storage_uri: verifiedCas ? pathToFileURL(verifiedCas.locator).href : null,
        requires_staging: false,
        evidence,
        reason_codes: reasonCodes,
        dependencies: blobDependencies,
      };
    }
    if (managedVersions.length > 0) {
      const managedEvidence = managedVersions.flatMap(version => version.evidence)
        .filter(item => item.kind === "managed-bytes" && item.verified && item.actual_sha256 === expectedHash);
      for (const item of managedEvidence) {
        if (!evidence.some(existing => existing.locator === item.locator)) evidence.push(item);
      }
      const desiredStorageUri = managedVersionRequiringStaging
        ? null
        : managedCasVersion?.desired?.blob_storage_uri ?? null;
      return {
        blob_id: blob.id,
        original: { ...blob },
        disposition: "managed",
        content_hash: expectedHash,
        desired_storage_uri: desiredStorageUri,
        requires_staging: Boolean(managedVersionRequiringStaging),
        evidence,
        reason_codes: reasonCodes,
        dependencies: blobDependencies,
      };
    }
    if (reasonCodes.length === 0) {
      for (const candidate of blobFileCandidates(db, blob, expectedHash)) evidence.push(verifyFileCandidate(candidate, expectedHash));
    }
    const verified = evidence.find(item => item.verified && item.actual_sha256 === expectedHash);
    if (verified) {
      const root = defaultArtifactRoot(db);
      const isManagedCas = pathInside(root, verified.locator) && !verified.requires_staging;
      return {
        blob_id: blob.id,
        original: { ...blob },
        disposition: "managed",
        content_hash: expectedHash,
        desired_storage_uri: isManagedCas ? pathToFileURL(verified.locator).href : null,
        requires_staging: !isManagedCas,
        evidence,
        reason_codes: reasonCodes,
        dependencies: blobDependencies,
      };
    }
    if (reasonCodes.length === 0) reasonCodes.push("unrecoverable_blob_bytes");
    return {
      blob_id: blob.id,
      original: { ...blob },
      disposition: "retire",
      content_hash: expectedHash,
      desired_storage_uri: null,
      requires_staging: false,
      evidence,
      reason_codes: Array.from(new Set(reasonCodes)).sort(),
      dependencies: blobDependencies,
    };
  });
}

function buildRetirementPacket(
  versions: PlannedVersion[],
  blobPlans: PlannedBlob[],
  graph: ArtifactGraphScan,
): ArtifactRetirementPacket {
  const retired = versions.filter(version => version.disposition === "retire");
  const artifacts = new Map<string, JsonObject>();
  const blobRows = new Map<string, JsonObject>();
  const dependencies: ArtifactDependencyReference[] = [];
  for (const version of retired) {
    if (version.retirement?.artifact_row) artifacts.set(String(version.retirement.artifact_row.id), version.retirement.artifact_row);
    if (version.retirement?.blob_row) blobRows.set(String(version.retirement.blob_row.id), version.retirement.blob_row);
    for (const dependency of [...version.dependencies, ...version.artifact_dependencies]) {
      const entry = { ...dependency, row: { ...dependency.row } };
      if (!dependencies.some(existing => canonicalJson(existing) === canonicalJson(entry))) dependencies.push(entry);
    }
  }
  for (const blob of blobPlans.filter(item => item.disposition === "retire")) {
    blobRows.set(blob.blob_id, blob.original);
    for (const dependency of blob.dependencies) {
      const entry = { ...dependency, row: { ...dependency.row } };
      if (!dependencies.some(existing => canonicalJson(existing) === canonicalJson(entry))) dependencies.push(entry);
    }
  }
  return {
    schema: "mandible-artifact-retirement@1",
    versions: retired.map(version => version.retirement?.version_row ?? {}).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    artifacts: Array.from(artifacts.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    blobs: Array.from(blobRows.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    dependencies: dependencies.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    graph_entities: graph.entities.map(row => ({ ...row })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    graph_edges: graph.edges.map(row => ({ ...row })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    graph_reclassified_entities: graph.reclassifiedEntities.map(item => ({ ...item.original }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

function planDigestInput(plan: Omit<ArtifactRecoveryPlan, "plan_digest">): string {
  return canonicalJson(plan);
}

export function artifactRecoveryPlanDigest(plan: ArtifactRecoveryPlan): string {
  const { plan_digest: _ignored, ...withoutDigest } = plan;
  return sha256(Buffer.from(planDigestInput(withoutDigest), "utf8"));
}

function makeSummary(versions: PlannedVersion[], blobs: PlannedBlob[], dependencyScanErrors: string[]): ArtifactRecoverySummary {
  const dependencies = [
    ...versions.flatMap(version => [...version.dependencies, ...version.artifact_dependencies]),
    ...blobs.flatMap(blob => blob.dependencies),
  ];
  return {
    versions: versions.length,
    git: versions.filter(version => version.disposition === "git").length,
    managed: versions.filter(version => version.disposition === "managed").length,
    retire: versions.filter(version => version.disposition === "retire").length,
    already_canonical: versions.filter(version => version.original.custody_mode === "link" || version.original.custody_mode === "managed").length,
    staged_managed_bytes: versions.filter(version => version.desired?.requires_staging).length,
    malformed: versions.filter(version => version.reason_codes.some(code => code.startsWith("malformed_"))).length,
    unrecoverable: versions.filter(version => version.disposition === "retire" && !version.reason_codes.some(code => code.startsWith("malformed_"))).length,
    dependent_versions: versions.filter(version => version.dependencies.length > 0).length,
    content_owning_dependencies: dependencies.filter(dependency => dependency.unique_user_content).length,
    derived_dependencies: dependencies.filter(dependency => !dependency.unique_user_content).length,
    unknown_dependencies: dependencyScanErrors.length + dependencies.filter(dependency => dependency.dependency_class === "unknown-reference").length,
    known_hashes: versions.filter(version => version.hash_origin === "known").length,
    synthetic_hashes: versions.filter(version => version.hash_origin === "legacy-uri-derived").length,
    retire_known_hashes: versions.filter(version => version.disposition === "retire" && version.hash_origin === "known").length,
    retire_synthetic_hashes: versions.filter(version => version.disposition === "retire" && version.hash_origin === "legacy-uri-derived").length,
    blobs: blobs.length,
    blobs_git_referenced: blobs.filter(blob => blob.disposition === "git-referenced").length,
    blobs_managed: blobs.filter(blob => blob.disposition === "managed").length,
    blobs_retire: blobs.filter(blob => blob.disposition === "retire").length,
    blob_content_owning_dependencies: blobs.flatMap(blob => blob.dependencies).filter(dependency => dependency.unique_user_content).length,
    blob_derived_dependencies: blobs.flatMap(blob => blob.dependencies).filter(dependency => !dependency.unique_user_content).length,
    graph_entities: 0,
    graph_edges: 0,
    graph_legacy_authority_entities: 0,
    graph_unknown_references: 0,
  };
}

export function planArtifactRecovery(db: Db, options: ArtifactRecoveryOptions = {}): ArtifactRecoveryPlan {
  const versions = readVersionRows(db, options.max_versions);
  const dependencyScan = collectDependencies(db, "artifact_version", new Set(versions.map(version => version.id)));
  const artifactDependencyScan = collectDependencies(db, "artifact", new Set(versions.map(version => version.artifact_id)));
  const blobRows = readAllBlobs(db);
  const blobDependencyScan = collectDependencies(db, "artifact_blob", new Set(blobRows.map(blob => blob.id)));
  const dependencyScanErrors = Array.from(new Set([
    ...dependencyScan.errors,
    ...artifactDependencyScan.errors,
    ...blobDependencyScan.errors,
  ])).sort();
  const reader = options.git_reader ?? defaultGitReader;
  const planned: PlannedVersion[] = [];

  for (const version of versions) {
    const artifact = readArtifact(db, version.artifact_id);
    const blob = readBlob(db, version.blob_id);
    const locatorResult = parseJsonObject(version.source_locator_json);
    const metadataResult = parseJsonObject(version.metadata_json);
    const expectedHash = asString(version.content_hash)?.toLowerCase() ?? "";
    const hashOriginValue = hashOrigin(version, blob, locatorResult.value, metadataResult.value);
    const evidence: RecoveryEvidence[] = [];
    const reasonCodes: string[] = [];
    const refs = dependencyScan.references.get(version.id) ?? [];
    let disposition: RecoveryDisposition = "retire";
    let desired: PlannedVersion["desired"] = null;

    if (!metadataResult.valid) reasonCodes.push("malformed_metadata_json");
    if (!locatorResult.valid) reasonCodes.push("malformed_source_locator_json");
    if (!SHA256_RE.test(expectedHash)) reasonCodes.push("malformed_content_hash");
    if (!artifact) reasonCodes.push("malformed_artifact_reference");
    if (!blob) reasonCodes.push("malformed_blob_reference");
    if (blob && (blob.algorithm !== "sha256" || blob.content_hash.toLowerCase() !== expectedHash)) {
      reasonCodes.push("malformed_blob_hash");
    }

    if (reasonCodes.length === 0 && blob && artifact) {
      const candidates = repoCandidates(version, artifact, blob, locatorResult.value);
      const directCandidates = candidates.filter(candidate => candidate.direct);
      const candidatesToVerify = directCandidates.length > 0 ? directCandidates : candidates;
      for (const candidate of candidatesToVerify) evidence.push(verifyGitCandidate(db, candidate, expectedHash, reader));
      const verifiedGit = evidence.filter(item => item.kind === "git" && item.verified);
      const uniqueGit = new Map(verifiedGit.map(item => [
        `${item.project_id}\0${item.commit_sha}\0${item.repo_path}`,
        item,
      ]));
      if (uniqueGit.size === 1) {
        const item = Array.from(uniqueGit.values())[0];
        disposition = "git";
        desired = {
          custody_mode: "link",
          source_kind: "tracked_repo",
          source_project_id: item.project_id ?? null,
          source_repo_id: null,
          repo_path: item.repo_path ?? null,
          commit_sha: item.commit_sha ?? null,
          source_locator_json: normalizedSourceLocator(locatorResult.value),
          metadata_json: recoveryMetadata(metadataResult.value),
          blob_storage_uri: blob.storage_uri,
          requires_staging: false,
        };
      } else if (uniqueGit.size > 1) {
        reasonCodes.push("ambiguous_verified_git_evidence");
      } else {
        const fileEvidence = fileCandidates(db, version, blob, expectedHash).map(candidate => verifyFileCandidate(candidate, expectedHash));
        evidence.push(...fileEvidence);
        const verifiedFiles = fileEvidence.filter(item => item.verified);
        if (verifiedFiles.length > 0) {
          const first = verifiedFiles.find(item => !item.requires_staging && pathInside(defaultArtifactRoot(db), item.locator))
            ?? verifiedFiles[0];
          const candidatePath = first.locator;
          const root = defaultArtifactRoot(db);
          const isManagedCas = !first.requires_staging && pathInside(root, candidatePath);
          disposition = "managed";
          desired = {
            custody_mode: "managed",
            source_kind: "managed",
            source_project_id: null,
            source_repo_id: null,
            repo_path: null,
            commit_sha: null,
            source_locator_json: normalizedSourceLocator(locatorResult.value),
            metadata_json: recoveryMetadata(metadataResult.value),
            blob_storage_uri: isManagedCas ? pathToFileURL(candidatePath).href : null,
            requires_staging: !isManagedCas,
          };
        } else {
          reasonCodes.push("unrecoverable_bytes");
        }
      }
    }

    if (desired === null) {
      disposition = "retire";
      if (reasonCodes.length === 0) reasonCodes.push("unrecoverable");
    }
    const retirement = disposition === "retire"
      ? { version_row: { ...version }, artifact_row: artifact ? { ...artifact } : null, blob_row: blob ? { ...blob } : null }
      : undefined;
    planned.push({
      version_id: version.id,
      artifact_id: version.artifact_id,
      blob_id: version.blob_id,
      version_no: version.version_no,
      original: { ...version, original_fingerprint: versionFingerprint(version) },
      disposition,
      hash_origin: hashOriginValue,
      desired,
      evidence,
      reason_codes: Array.from(new Set(reasonCodes)).sort(),
      dependencies: refs,
      artifact_dependencies: artifactDependencyScan.references.get(version.artifact_id) ?? [],
      ...(retirement ? { retirement } : {}),
    });
  }

  planned.sort((a, b) => a.version_id.localeCompare(b.version_id));
  const plannedBlobs = planBlobRecovery(db, blobRows, planned, blobDependencyScan.references);
  const retirementIdentityKeys = new Set<string>();
  for (const version of planned.filter(item => item.disposition === "retire")) {
    for (const value of [version.version_id, version.artifact_id, version.blob_id]) {
      for (const key of graphIdentityKeys(value)) retirementIdentityKeys.add(key);
    }
  }
  for (const blob of plannedBlobs.filter(item => item.disposition === "retire")) {
    for (const key of graphIdentityKeys(blob.blob_id)) retirementIdentityKeys.add(key);
    for (const key of graphIdentityKeys(blob.content_hash)) retirementIdentityKeys.add(key);
  }
  const graphScan = readArtifactGraphScan(db, retirementIdentityKeys);
  const retirementPacket = buildRetirementPacket(planned, plannedBlobs, graphScan);
  const summary: ArtifactRecoverySummary = {
    ...makeSummary(planned, plannedBlobs, dependencyScanErrors),
    graph_entities: graphScan.entities.length,
    graph_edges: graphScan.edges.length,
    graph_legacy_authority_entities: graphScan.legacyAuthorityEntities,
    graph_unknown_references: graphScan.blockers.length,
  };
  const withoutDigest: Omit<ArtifactRecoveryPlan, "plan_digest"> = {
    schema: ARTIFACT_RECOVERY_SCHEMA,
    source_schema_version: sourceSchemaVersion(db),
    summary,
    versions: planned,
    artifacts: db.prepare("SELECT * FROM artifact ORDER BY id").all() as ArtifactLogicalRow[],
    sources: tableExists(db,"artifact_source") ? db.prepare("SELECT * FROM artifact_source ORDER BY artifact_id").all() as JsonObject[] : [],
    blobs: plannedBlobs,
    graph_entities: graphScan.entities,
    graph_observed_entities: graphScan.observedEntities,
    graph_edges: graphScan.edges,
    graph_reclassified_entities: graphScan.reclassifiedEntities,
    graph_blockers: graphScan.blockers,
    retirement_packet: retirementPacket,
    dependency_scan_errors: dependencyScanErrors,
  };
  return { ...withoutDigest, plan_digest: sha256(Buffer.from(planDigestInput(withoutDigest), "utf8")) };
}

function defaultStageManagedBytes(input: ManagedByteStageInput, root: string): string {
  const target = casPath(root, input.content_hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (sha256(existing) !== input.content_hash) throw new Error(`staged CAS collision at ${target}`);
    return pathToFileURL(target).href;
  }
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, input.bytes, { flag: "wx" });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    if (!fs.existsSync(target)) throw error;
    fs.unlinkSync(temporary);
  }
  const stored = fs.readFileSync(target);
  if (sha256(stored) !== input.content_hash) throw new Error(`staged CAS verification failed at ${target}`);
  return pathToFileURL(target).href;
}

function readCurrentVersion(db: Db, id: string): JsonObject | null {
  return db.prepare("SELECT * FROM artifact_version WHERE id = ?").get(id) as JsonObject | undefined ?? null;
}

function materializeDesiredStorage(db: Db, version: PlannedVersion, options: ArtifactRecoveryOptions): string | null {
  if (!version.desired || version.disposition !== "managed") return version.desired?.blob_storage_uri ?? null;
  if (!version.desired.requires_staging) return version.desired.blob_storage_uri;
  const stage = options.stage_managed_bytes ?? ((input: ManagedByteStageInput) => defaultStageManagedBytes(
    input,
    options.stage_root ?? defaultArtifactRoot(db),
  ));
  const evidence = version.evidence.find(item => item.kind === "managed-bytes" && item.verified && item.actual_sha256 === version.original.content_hash);
  if (!evidence) throw new Error(`no verified managed bytes to stage for ${version.version_id}`);
  return stage({
    bytes: fs.readFileSync(evidence.locator),
    content_hash: String(version.original.content_hash),
    version_id: version.version_id,
  });
}

function verifyPlan(plan: ArtifactRecoveryPlan): void {
  if (artifactRecoveryPlanDigest(plan) !== plan.plan_digest) throw new Error("artifact recovery plan digest mismatch");
}

function packetPath(db: Db, plan: ArtifactRecoveryPlan, options: ArtifactRecoveryOptions): string | null {
  if (plan.summary.retire === 0 && plan.summary.blobs_retire === 0
    && plan.graph_entities.length === 0 && plan.graph_edges.length === 0 && plan.graph_reclassified_entities.length === 0) return null;
  return path.resolve(options.retirement_packet_path
    ?? path.join(path.dirname(defaultArtifactRoot(db)), "repairs", "artifact-recovery", `${plan.plan_digest}.json`));
}

function receiptPath(db: Db, plan: ArtifactRecoveryPlan, options: ArtifactRecoveryOptions): string {
  return path.resolve(options.recovery_receipt_path
    ?? path.join(path.dirname(defaultArtifactRoot(db)), "repairs", "artifact-recovery", `${plan.plan_digest}.receipt.json`));
}

function writeRecoveryReceipt(
  plan: ArtifactRecoveryPlan,
  destination: string,
  execution?: JsonObject,
): void {
  const receipt = {
    schema: "mandible-artifact-recovery-receipt@1",
    plan_digest: plan.plan_digest,
    source_schema_version: plan.source_schema_version,
    summary: plan.summary,
    versions: plan.versions.map(version => ({
      version_id: version.version_id,
      artifact_id: version.artifact_id,
      blob_id: version.blob_id,
      disposition: version.disposition,
      hash_origin: version.hash_origin,
      original: version.original,
      desired: version.desired,
      evidence: version.evidence,
      reason_codes: version.reason_codes,
      dependencies: version.dependencies,
      artifact_dependencies: version.artifact_dependencies,
    })),
    artifacts: plan.artifacts,
    sources: plan.sources,
    blobs: plan.blobs,
    graph_entities: plan.graph_entities,
    graph_observed_entities: plan.graph_observed_entities,
    graph_edges: plan.graph_edges,
    graph_reclassified_entities: plan.graph_reclassified_entities,
    graph_blockers: plan.graph_blockers,
    retirement_packet: plan.retirement_packet,
    ...(execution ? { execution } : {}),
  };
  const bytes = Buffer.from(canonicalJson(receipt), "utf8");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (existing.equals(bytes)) return;
    try {
      const prior = JSON.parse(existing.toString("utf8")) as JsonObject;
      if (prior.plan_digest !== plan.plan_digest) throw new Error("different plan digest");
      if (prior.execution && execution) return;
      if (prior.execution && !execution) return;
    } catch (error) {
      throw new Error(`recovery receipt already exists with different bytes: ${destination}: ${String(error)}`);
    }
  }
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (!fs.existsSync(destination)) throw error;
    fs.unlinkSync(temporary);
    const existing = fs.readFileSync(destination);
    if (!existing.equals(bytes)) throw new Error(`recovery receipt raced with different bytes: ${destination}`);
  }
}

function writeRetirementPacket(
  plan: ArtifactRecoveryPlan,
  destination: string | null,
): void {
  if (!destination) return;
  const packet = {
    ...plan.retirement_packet,
    plan_digest: plan.plan_digest,
    hash_origins: Object.fromEntries(plan.versions
      .filter(version => version.disposition === "retire")
      .map(version => [version.version_id, version.hash_origin])),
  };
  const bytes = Buffer.from(canonicalJson(packet), "utf8");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (!existing.equals(bytes)) throw new Error(`retirement packet already exists with different bytes: ${destination}`);
    return;
  }
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (!fs.existsSync(destination)) throw error;
    fs.unlinkSync(temporary);
    const existing = fs.readFileSync(destination);
    if (!existing.equals(bytes)) throw new Error(`retirement packet raced with different bytes: ${destination}`);
  }
}

function identityWhere(identity: JsonObject): { sql: string; values: unknown[] } {
  const entries = Object.entries(identity);
  if (entries.length === 0) throw new Error("retirement dependency has no stable identity");
  return {
    sql: entries.map(([column]) => column === "rowid" ? "rowid = ?" : `${quoteIdentifier(column)} = ?`).join(" AND "),
    values: entries.map(([, value]) => value),
  };
}

function deleteDerivedDependency(db: Db, dependency: ArtifactDependencyReference): void {
  const where = identityWhere(dependency.identity);
  if (dependency.table === "artifact" && dependency.column === "latest_version_id") {
    db.prepare(`UPDATE ${quoteIdentifier(dependency.table)} SET ${quoteIdentifier(dependency.column)} = NULL WHERE ${where.sql}`).run(...where.values);
    return;
  }
  if (dependency.table === "artifact_links" && dependency.column === "fallback_version_id") {
    db.prepare(`UPDATE ${quoteIdentifier(dependency.table)} SET ${quoteIdentifier(dependency.column)} = NULL WHERE ${where.sql}`).run(...where.values);
    return;
  }
  db.prepare(`DELETE FROM ${quoteIdentifier(dependency.table)} WHERE ${where.sql}`).run(...where.values);
}

function ensureHistoricalSourceAssociation(db: Db, version: PlannedVersion): number {
  const projectId = version.original.source_project_id;
  if (!projectId || !tableExists(db, "project_artifact_associations")) return 0;
  const existing = db.prepare(
    `SELECT 1 FROM project_artifact_associations
      WHERE project_id = ? AND target_type = 'artifact_version' AND target_id = ?
        AND role = 'historical-source-access' LIMIT 1`,
  ).get(projectId, version.version_id);
  if (existing) return 0;
  db.prepare(
    `INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, title, description, rank,
       status, source, source_ref_type, source_ref_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, 'artifact_version', ?, 'associated', 'historical-source-access', NULL, NULL, NULL,
       'active', 'migration', NULL, NULL, '{}', ?, ?)`,
  ).run(
    `artifact-source-access:${version.version_id}:${projectId}`,
    projectId,
    version.version_id,
    version.original.created_at,
    version.original.created_at,
  );
  return 1;
}

function recalculateArtifacts(db: Db, artifactIds: Set<string>): void {
  for (const artifactId of artifactIds) {
    const versions = db.prepare(
      `SELECT id, source_kind, version_no FROM artifact_version
        WHERE artifact_id = ? ORDER BY version_no DESC, id DESC`,
    ).all(artifactId) as Array<{ id: string; source_kind: string; version_no: number }>;
    if (versions.length === 0) {
      if (tableExists(db, "artifact_source_move")) db.prepare("DELETE FROM artifact_source_move WHERE artifact_id = ?").run(artifactId);
      if (tableExists(db, "artifact_source")) db.prepare("DELETE FROM artifact_source WHERE artifact_id = ?").run(artifactId);
      db.prepare("DELETE FROM artifact WHERE id = ?").run(artifactId);
      continue;
    }
    const kinds = new Set(versions.map(version => version.source_kind));
    const sourceKind = kinds.size > 1 ? "mixed" : Array.from(kinds)[0];
    db.prepare(
      `UPDATE artifact
          SET source_kind = ?, latest_version_id = ?, version_count = ?, updated_at = ?
        WHERE id = ?`,
    ).run(sourceKind, versions[0].id, versions.length, Date.now(), artifactId);
  }
}

function comparableDependencies(dependencies: ArtifactDependencyReference[]): ArtifactDependencyReference[] {
  return dependencies.filter(dependency => !(
    dependency.table === "project_artifact_associations"
    && dependency.row.role === "historical-source-access"
    && dependency.row.source === "migration"
  ));
}

function dependencySet(dependencies: ArtifactDependencyReference[]): string {
  return canonicalJson(comparableDependencies(dependencies).map(({ row: _row, ...dependency }) => dependency));
}

function dependencyIdentityKey(dependency: ArtifactDependencyReference): string {
  return `${dependency.table}\0${dependency.column}\0${canonicalJson(dependency.identity)}`;
}

function assertRetirementDependencyRowsUnchanged(
  planned: ArtifactDependencyReference[],
  actual: ArtifactDependencyReference[],
  context: string,
): void {
  const actualByIdentity = new Map(actual.map(dependency => [dependencyIdentityKey(dependency), dependency]));
  for (const dependency of comparableDependencies(planned)) {
    const current = actualByIdentity.get(dependencyIdentityKey(dependency));
    if (!current) throw new Error(`retirement dependency disappeared since recovery plan: ${context}`);
    if (canonicalJson(current.row) !== canonicalJson(dependency.row)) {
      throw new Error(`retirement dependency row changed since recovery plan: ${context}`);
    }
  }
}

function currentArtifactGraphEntities(db: Db): JsonObject[] {
  if (!tableExists(db, "graph_entities")) return [];
  return db.prepare("SELECT * FROM graph_entities WHERE entity_type = 'artifact' ORDER BY id").all() as JsonObject[];
}

function currentGraphEntitiesById(db: Db, ids: Set<string>): Map<string, JsonObject> {
  if (!tableExists(db, "graph_entities") || ids.size === 0) return new Map();
  const rows = db.prepare("SELECT * FROM graph_entities ORDER BY id").all() as JsonObject[];
  return new Map(rows.filter(row => ids.has(String(row.id))).map(row => [String(row.id), row]));
}

function currentIncidentGraphEdges(db: Db, ids: Set<string>): JsonObject[] {
  if (!tableExists(db, "graph_edges") || ids.size === 0) return [];
  return (db.prepare("SELECT * FROM graph_edges ORDER BY id").all() as JsonObject[])
    .filter(edge => ids.has(String(edge.source_id)) || ids.has(String(edge.target_id)));
}

function assertArtifactGraphInputsUnchanged(db: Db, plan: ArtifactRecoveryPlan): void {
  if (!tableExists(db, "graph_entities")) {
    if (plan.graph_observed_entities.length > 0 || plan.graph_entities.length > 0 || plan.graph_reclassified_entities.length > 0) {
      throw new Error("artifact graph tables disappeared since recovery plan");
    }
    return;
  }
  const removedIds = new Set(plan.graph_entities.map(row => String(row.id)));
  const reclassifiedById = new Map(plan.graph_reclassified_entities.map(item => [String(item.original.id), item]));
  const expectedPost = plan.graph_observed_entities
    .filter(row => !removedIds.has(String(row.id)))
    .flatMap(row => {
      const desired = reclassifiedById.get(String(row.id))?.desired ?? row;
      return desired.entity_type === "artifact" ? [desired] : [];
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const current = currentArtifactGraphEntities(db);
  const pre = [...plan.graph_observed_entities].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!graphRowsEqual(current, pre) && !graphRowsEqual(current, expectedPost)) {
    throw new Error("artifact graph entities changed since recovery plan");
  }
  const allIds = new Set([
    ...plan.graph_observed_entities.map(row => String(row.id)),
    ...plan.graph_reclassified_entities.map(item => String(item.original.id)),
  ]);
  const currentById = currentGraphEntitiesById(db, allIds);
  for (const row of plan.graph_entities) {
    const actual = currentById.get(String(row.id));
    if (actual && canonicalJson(actual) !== canonicalJson(row)) {
      throw new Error(`retiring artifact graph entity changed since recovery plan: ${String(row.id)}`);
    }
  }
  for (const item of plan.graph_reclassified_entities) {
    const actual = currentById.get(String(item.original.id));
    const isOriginal = actual && canonicalJson(actual) === canonicalJson(item.original);
    const isDesired = actual && canonicalJson(actual) === canonicalJson(item.desired);
    if (!actual || (!isOriginal && !isDesired)) {
      throw new Error(`artifact graph entity changed since recovery plan: ${String(item.original.id)}`);
    }
  }
  const currentEdges = currentIncidentGraphEdges(db, removedIds);
  const plannedEdges = [...plan.graph_edges].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (currentEdges.length > 0 && !graphRowsEqual(currentEdges.sort((a, b) => String(a.id).localeCompare(String(b.id))), plannedEdges)) {
    throw new Error("artifact graph edges changed since recovery plan");
  }
}

function artifactWillBeRemoved(db: Db, plan: ArtifactRecoveryPlan, artifactId: string): boolean {
  const plannedRetirements = new Set(
    plan.versions.filter(version => version.disposition === "retire").map(version => version.version_id),
  );
  const rows = db.prepare("SELECT id FROM artifact_version WHERE artifact_id = ?").all(artifactId) as Array<{ id: string }>;
  return rows.length > 0 && rows.every(row => plannedRetirements.has(row.id));
}

function assertPlanInputsUnchanged(
  db: Db,
  plan: ArtifactRecoveryPlan,
  expectedBlobStorage = new Map<string, string | null>(),
  stageRoot?: string,
): void {
  assertArtifactGraphInputsUnchanged(db, plan);
  const originals = new Map(plan.artifacts.map(row => [row.id, row]));
  const currentArtifacts = db.prepare("SELECT id,metadata_json FROM artifact ORDER BY id").all() as {id:string;metadata_json:string}[];
  for (const current of currentArtifacts) {
    const original = originals.get(current.id);
    if (!original || original.metadata_json !== current.metadata_json) throw new Error(`artifact metadata changed since recovery plan: ${current.id}`);
  }
  const currentVersions = readVersionRows(db);
  const currentById = new Map(currentVersions.map(version => [version.id, version]));
  const currentDependencyScan = collectDependencies(db, "artifact_version", new Set(currentVersions.map(version => version.id)));
  const currentArtifactDependencyScan = collectDependencies(db, "artifact", new Set(plan.versions.map(version => version.artifact_id)));
  const currentBlobRows = readAllBlobs(db);
  const currentBlobById = new Map(currentBlobRows.map(blob => [blob.id, blob]));
  const currentBlobDependencyScan = collectDependencies(db, "artifact_blob", new Set(plan.blobs.map(blob => blob.blob_id)));
  if (currentDependencyScan.errors.length > 0 || currentArtifactDependencyScan.errors.length > 0) {
    throw new Error(`dependency scan failed during recovery: ${[...currentDependencyScan.errors, ...currentArtifactDependencyScan.errors].join(", ")}`);
  }
  if (currentBlobDependencyScan.errors.length > 0) {
    throw new Error(`blob dependency scan failed during recovery: ${currentBlobDependencyScan.errors.join(", ")}`);
  }
  for (const version of plan.versions) {
    const current = currentById.get(version.version_id);
    if (!current) {
      if (version.disposition === "retire") continue;
      throw new Error(`artifact version disappeared during recovery: ${version.version_id}`);
    }
    const currentFingerprint = versionFingerprint(current);
    if (version.disposition === "retire") {
      if (currentFingerprint !== String(version.original.original_fingerprint)) {
        throw new Error(`artifact version changed since recovery plan: ${version.version_id}`);
      }
    } else if (currentFingerprint !== String(version.original.original_fingerprint)
      && currentFingerprint !== desiredVersionFingerprint(version)) {
      throw new Error(`artifact version changed since recovery plan: ${version.version_id}`);
    }
    const actual = currentDependencyScan.references.get(version.version_id) ?? [];
    if (dependencySet(version.dependencies) !== dependencySet(actual)) {
      throw new Error(`artifact dependencies changed since recovery plan: ${version.version_id}`);
    }
    if (version.disposition === "retire") {
      assertRetirementDependencyRowsUnchanged(version.dependencies, actual, `version ${version.version_id}`);
    }
    const actualArtifact = currentArtifactDependencyScan.references.get(version.artifact_id) ?? [];
    if (dependencySet(version.artifact_dependencies) !== dependencySet(actualArtifact)) {
      throw new Error(`artifact identity dependencies changed since recovery plan: ${version.artifact_id}`);
    }
    if (version.disposition === "retire" && artifactWillBeRemoved(db, plan, version.artifact_id)) {
      assertRetirementDependencyRowsUnchanged(version.artifact_dependencies, actualArtifact, `artifact ${version.artifact_id}`);
      const plannedArtifact = version.retirement?.artifact_row;
      const currentArtifact = readArtifact(db, version.artifact_id);
      if (!plannedArtifact || !currentArtifact || canonicalJson(plannedArtifact) !== canonicalJson(currentArtifact)) {
        throw new Error(`artifact row changed since recovery plan: ${version.artifact_id}`);
      }
    }
  }
  for (const blob of plan.blobs) {
    const current = currentBlobById.get(blob.blob_id);
    if (!current) {
      if (blob.disposition === "retire") continue;
      throw new Error(`artifact blob disappeared during recovery: ${blob.blob_id}`);
    }
    const currentStorage = current.storage_uri;
    const originalStorage = blob.original.storage_uri;
    const desiredStorage = expectedBlobStorage.has(blob.blob_id)
      ? expectedBlobStorage.get(blob.blob_id) ?? null
      : blob.desired_storage_uri;
    const currentComparable = { ...current, storage_uri: null };
    const originalComparable = { ...blob.original, storage_uri: null };
    const storageMatches = currentStorage === originalStorage
      || currentStorage === desiredStorage
      || (blob.requires_staging && verifiedInCustodyStorageUri(db, currentStorage, blob.content_hash, stageRoot));
    if (blobFingerprint(currentComparable) !== blobFingerprint(originalComparable)
      || !storageMatches) {
      throw new Error(`artifact blob changed since recovery plan: ${blob.blob_id}`);
    }
    if (blob.disposition === "retire" && blobFingerprint(current) !== blobFingerprint(blob.original)) {
      throw new Error(`retiring artifact blob row changed since recovery plan: ${blob.blob_id}`);
    }
    const actualDependencies = (currentBlobDependencyScan.references.get(blob.blob_id) ?? [])
      .filter(dependency => dependency.table !== "artifact_version");
    const plannedDependencies = blob.dependencies.filter(dependency => dependency.table !== "artifact_version");
    if (dependencySet(plannedDependencies) !== dependencySet(actualDependencies)) {
      throw new Error(`artifact blob dependencies changed since recovery plan: ${blob.blob_id}`);
    }
    if (blob.disposition === "retire") {
      assertRetirementDependencyRowsUnchanged(plannedDependencies, actualDependencies, `blob ${blob.blob_id}`);
    }
  }
}

function retainGitCommits(db: Db, plan: ArtifactRecoveryPlan, options: ArtifactRecoveryOptions): string[] {
  const gitVersions = plan.versions.filter(version => version.disposition === "git");
  if (gitVersions.length > 0 && !options.retain_git_commit) {
    throw new Error("Git recovery requires the migration-owned retain_git_commit callback");
  }
  const retainer = options.retain_git_commit;
  const refs = new Map<string, string>();
  for (const version of plan.versions) {
    if (version.disposition !== "git" || !version.desired?.source_project_id || !version.desired.commit_sha || !version.desired.repo_path) continue;
    const input = {
      project: version.desired.source_project_id,
      commit: version.desired.commit_sha,
      path: version.desired.repo_path,
      sha256: String(version.original.content_hash),
    };
    const ref = retainer!(db, input);
    refs.set(`${input.project}\0${input.commit}`, ref);
  }
  return Array.from(refs.values()).sort();
}

export function applyArtifactRecovery(db: Db, plan: ArtifactRecoveryPlan, options: ArtifactRecoveryOptions = {}): ArtifactRecoveryApplyResult {
  verifyPlan(plan);
  const recoveryReceiptPath = receiptPath(db, plan, options);
  const blockers: string[] = [];
  const retiring = plan.versions.filter(version => version.disposition === "retire");
  const retirementDependencies = retiring.flatMap(version => [...version.dependencies, ...version.artifact_dependencies]);
  const retiringBlobs = plan.blobs.filter(blob => blob.disposition === "retire");
  const blobRetirementDependencies = retiringBlobs.flatMap(blob => blob.dependencies);
  const retirementPacketPath = packetPath(db, plan, options);
  if (plan.dependency_scan_errors.length > 0 || plan.summary.unknown_dependencies > 0) {
    blockers.push(
      `recovery is blocked by ${plan.summary.unknown_dependencies} unknown dependency reference or scan failure(s): `
      + [...plan.dependency_scan_errors].join(", "),
    );
  }
  if (retirementDependencies.some(dependency => dependency.unique_user_content)) {
    blockers.push(
      `retirement is blocked by ${retirementDependencies.filter(dependency => dependency.unique_user_content).length} content-owning dependency reference(s)`,
    );
  }
  if (blobRetirementDependencies.some(dependency => dependency.unique_user_content)) {
    blockers.push(
      `blob retirement is blocked by ${blobRetirementDependencies.filter(dependency => dependency.unique_user_content).length} content-owning dependency reference(s)`,
    );
  }
  if (plan.graph_blockers.length > 0) {
    blockers.push(
      `artifact graph reconciliation is blocked by ${plan.graph_blockers.length} unknown reference(s): `
      + plan.graph_blockers.join(", "),
    );
  }
  if (blockers.length > 0) {
    writeRecoveryReceipt(plan, recoveryReceiptPath);
    writeRetirementPacket(plan, retirementPacketPath);
    return {
      status: "blocked",
      plan,
      applied_versions: 0,
      skipped_versions: 0,
      updated_blobs: 0,
      staged_managed_bytes: 0,
      retirement_packet: plan.retirement_packet,
      retirement_packet_path: retirementPacketPath,
      recovery_receipt_path: recoveryReceiptPath,
      retired_versions: 0,
      retired_blobs: 0,
      removed_graph_entities: 0,
      removed_graph_edges: 0,
      staged_managed_blobs: 0,
      retained_git_commits: [],
      historical_source_associations: 0,
      blockers,
    };
  }

  assertPlanInputsUnchanged(db, plan, new Map(), options.stage_root);
  writeRecoveryReceipt(plan, recoveryReceiptPath);

  writeRetirementPacket(plan, retirementPacketPath);
  let stagedManagedBytes = 0;
  let stagedManagedBlobs = 0;
  const canonicalBlobStorage = new Map<string, string | null>();
  for (const blob of plan.blobs) {
    if (blob.disposition === "retire") {
      canonicalBlobStorage.set(blob.blob_id, null);
      continue;
    }
    if (blob.disposition !== "managed" || !blob.requires_staging) {
      canonicalBlobStorage.set(blob.blob_id, blob.desired_storage_uri);
      continue;
    }
    const sourceVersion = plan.versions.find(version =>
      version.blob_id === blob.blob_id
      && version.disposition === "managed"
      && version.desired?.requires_staging,
    );
    let stagedUri: string;
    if (sourceVersion) {
      stagedUri = materializeDesiredStorage(db, sourceVersion, options) ?? (() => {
        throw new Error(`managed byte staging returned no URI for ${sourceVersion.version_id}`);
      })();
    } else {
      const evidence = blob.evidence.find(item => item.kind === "managed-bytes" && item.verified && item.actual_sha256 === blob.content_hash);
      if (!evidence) throw new Error(`no verified managed bytes to stage for ${blob.blob_id}`);
      const stage = options.stage_managed_bytes ?? ((input: ManagedByteStageInput) => defaultStageManagedBytes(input, options.stage_root ?? defaultArtifactRoot(db)));
      stagedUri = stage({
        bytes: fs.readFileSync(evidence.locator),
        content_hash: blob.content_hash,
        version_id: `blob:${blob.blob_id}`,
      });
    }
    canonicalBlobStorage.set(blob.blob_id, stagedUri);
    stagedManagedBlobs += 1;
  }
  stagedManagedBytes = plan.versions.filter(version => version.disposition === "managed" && version.desired?.requires_staging).length;
  const retainedGitCommits = retainGitCommits(db, plan, options);

  let appliedVersions = 0;
  let skippedVersions = 0;
  let updatedBlobs = 0;
  let retiredVersions = 0;
  let retiredBlobs = 0;
  let removedGraphEntities = 0;
  let removedGraphEdges = 0;
  let historicalSourceAssociations = 0;
  const affectedArtifacts = new Set(plan.versions.map(version => version.artifact_id));
  const apply = db.transaction(() => {
    assertPlanInputsUnchanged(db, plan, canonicalBlobStorage, options.stage_root);
    for (const version of plan.versions) {
      const current = readCurrentVersion(db, version.version_id);
      if (version.disposition === "retire") {
        if (!current) {
          skippedVersions += 1;
          continue;
        }
        for (const dependency of version.dependencies) deleteDerivedDependency(db, dependency);
        db.prepare("DELETE FROM artifact_version WHERE id = ?").run(version.version_id);
        retiredVersions += 1;
        continue;
      }
      if (!version.desired || !current) throw new Error(`artifact version disappeared during recovery: ${version.version_id}`);
      const currentFingerprint = versionFingerprint(current);
      if (currentFingerprint === desiredVersionFingerprint(version)) {
        skippedVersions += 1;
      } else {
        db.prepare(
          `UPDATE artifact_version
              SET source_kind = @source_kind,
                  source_project_id = @source_project_id,
                  source_repo_id = NULL,
                  repo_path = @repo_path,
                  commit_sha = @commit_sha,
                  source_locator_json = @source_locator_json,
                  custody_mode = @custody_mode,
                  metadata_json = @metadata_json
            WHERE id = @id`,
        ).run({
          id: version.version_id,
          source_kind: version.desired.source_kind,
          source_project_id: version.desired.source_project_id,
          repo_path: version.desired.repo_path,
          commit_sha: version.desired.commit_sha,
          source_locator_json: version.desired.source_locator_json,
          custody_mode: version.desired.custody_mode,
          metadata_json: version.desired.metadata_json,
        });
        if (version.original.source_project_id) historicalSourceAssociations += ensureHistoricalSourceAssociation(db, version);
        appliedVersions += 1;
      }
      if (version.original.source_project_id && currentFingerprint === desiredVersionFingerprint(version)) {
        historicalSourceAssociations += ensureHistoricalSourceAssociation(db, version);
      }
    }
    for (const blob of plan.blobs) {
      const current = readBlob(db, blob.blob_id);
      if (blob.disposition === "retire") {
        if (!current) continue;
        for (const dependency of blob.dependencies) {
          if (dependency.table !== "artifact_version") deleteDerivedDependency(db, dependency);
        }
        const remainingVersion = db.prepare("SELECT 1 FROM artifact_version WHERE blob_id = ? LIMIT 1").get(blob.blob_id);
        if (remainingVersion) throw new Error(`artifact blob remains referenced by a version: ${blob.blob_id}`);
        db.prepare("DELETE FROM artifact_blob WHERE id = ?").run(blob.blob_id);
        retiredBlobs += 1;
        continue;
      }
      if (!current) throw new Error(`artifact blob disappeared during recovery: ${blob.blob_id}`);
      const desiredStorageUri = canonicalBlobStorage.has(blob.blob_id)
        ? canonicalBlobStorage.get(blob.blob_id) ?? null
        : blob.desired_storage_uri;
      if (desiredStorageUri !== current.storage_uri) {
        db.prepare("UPDATE artifact_blob SET storage_uri = ? WHERE id = ?").run(desiredStorageUri, blob.blob_id);
        updatedBlobs += 1;
      }
    }
    for (const edge of plan.graph_edges) {
      const result = db.prepare("DELETE FROM graph_edges WHERE id = ?").run(edge.id);
      removedGraphEdges += result.changes;
    }
    for (const entity of plan.graph_entities) {
      const result = db.prepare("DELETE FROM graph_entities WHERE id = ?").run(entity.id);
      removedGraphEntities += result.changes;
    }
    for (const item of plan.graph_reclassified_entities) {
      db.prepare(
        `UPDATE graph_entities
            SET entity_type = @entity_type,
                repo_id = @repo_id,
                provider_id = @provider_id,
                external_id = @external_id,
                title = @title,
                status = @status,
                labels_json = @labels_json,
                summary_json = @summary_json,
                detail_ref_json = @detail_ref_json,
                action_context_json = @action_context_json,
                visual_json = @visual_json,
                created_at = @created_at,
                updated_at = @updated_at,
                observed_at = @observed_at,
                source = @source
          WHERE id = @id`,
      ).run(item.desired);
    }
    recalculateArtifacts(db, affectedArtifacts);
  });
  apply.immediate();
  writeRecoveryReceipt(plan, recoveryReceiptPath, {
    status: "applied",
    applied_versions: appliedVersions,
    skipped_versions: skippedVersions,
    retired_versions: retiredVersions,
    retired_blobs: retiredBlobs,
    removed_graph_entities: removedGraphEntities,
    removed_graph_edges: removedGraphEdges,
    updated_blobs: updatedBlobs,
    staged_managed_bytes: stagedManagedBytes,
    staged_managed_blobs: stagedManagedBlobs,
    retained_git_commits: retainedGitCommits,
    historical_source_associations: historicalSourceAssociations,
  });
  return {
    status: "applied",
    plan,
    applied_versions: appliedVersions,
    skipped_versions: skippedVersions,
    updated_blobs: updatedBlobs,
    staged_managed_bytes: stagedManagedBytes,
    retirement_packet: plan.retirement_packet,
    retirement_packet_path: retirementPacketPath,
    recovery_receipt_path: recoveryReceiptPath,
    retired_versions: retiredVersions,
    retired_blobs: retiredBlobs,
    removed_graph_entities: removedGraphEntities,
    removed_graph_edges: removedGraphEdges,
    staged_managed_blobs: stagedManagedBlobs,
    retained_git_commits: retainedGitCommits,
    historical_source_associations: historicalSourceAssociations,
    blockers: [],
  };
}

/**
 * Migration-facing entry point. It is intentionally fail-closed: a caller
 * that does not have a retirement/tombstone policy receives a packet and no
 * database mutation when any version is unresolved.
 */
export function recoverArtifactVersions(db: Db, options: ArtifactRecoveryOptions = {}): ArtifactRecoveryApplyResult {
  const plan = planArtifactRecovery(db, options);
  return applyArtifactRecovery(db, plan, options);
}

/** Strict migration entry point: return a receipt or fail before migration. */
export function recoverArtifactCustody(db: Db, options: ArtifactRecoveryOptions = {}): ArtifactRecoveryApplyResult {
  const result = recoverArtifactVersions(db, options);
  if (result.status === "blocked") throw new ArtifactRecoveryBlockedError(result.plan);
  return result;
}

export function retirementPacketJson(packet: ArtifactRetirementPacket): string {
  return canonicalJson(packet);
}
