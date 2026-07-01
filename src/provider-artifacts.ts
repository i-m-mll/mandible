import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import {
  resolveCanonicalArtifactRepoForRoot,
  resolveCanonicalArtifactRepoRef,
} from "./artifact-repo-resolution.js";
import { resolveProjectRef } from "./ledger/project-registry.js";
// Cyclic import (artifact-content also imports from this module). Safe: both
// sides reference each other only from inside functions, never at module-eval
// top level. Used by recordArtifactVersion's managed-`ref` path to read the
// full bytes of an existing artifact before snapshotting it into CAS.
import { readArtifactBytesFull } from "./artifact-content.js";
import type {
  ArtifactAliasRecord,
  ArtifactBlobRecord,
  ArtifactBundleMemberRecord,
  ArtifactBundleRecord,
  ArtifactGitState,
  ArtifactIdentityRecord,
  ArtifactIdentitySourceKind,
  ArtifactLinkRecord,
  ArtifactRecord,
  ArtifactRecoverability,
  ArtifactResolveResult,
  ArtifactSeriesSummary,
  ArtifactSeriesRecord,
  ArtifactSeriesSourceKind,
  ArtifactVersionHistory,
  ArtifactVersionRecord,
  ArtifactVersionRecordResult,
  ArtifactVersionSourceKind,
  CanonicalArtifactVersionRecord,
  GraphAction,
  GraphEdge,
  GraphMode,
  GraphNode,
  ProjectArtifactAssociationRecord,
  ProviderManifestRecord,
  ProviderRecord,
} from "./types.js";

const ARTIFACT_ROOT_SETTING = "artifact_root";

const MODE_ENTITY_TYPES: Record<GraphMode, string[] | null> = {
  activity: null,
  issue: ["issue", "curated_topic"],
  work: ["repo", "issue", "work_unit", "session", "auth_request", "branch", "commit"],
  provenance: null,
  "provider-lineage": [
    "provider",
    "issue",
    "provider_spec",
    "provider_manifest",
    "run",
    "analysis",
    "model",
    "dataset",
    "artifact",
    "report",
  ],
  "artifact-lineage": [
    "provider_manifest",
    "run",
    "analysis",
    "model",
    "dataset",
    "artifact",
    "report",
  ],
};

type JsonRecord = Record<string, unknown>;
type ArtifactCustodyMode = "link" | "copy" | "managed" | "external";
type ArtifactAvailability = "present" | "missing" | "stale" | "unchecked" | "remote_only" | "pinned";

const RECOVERABILITY_VALUES = new Set<ArtifactRecoverability>([
  "repo_commit",
  "repo_worktree",
  "local_only",
  "mandible_cas",
  "provider_store",
  "external_remote",
  "regenerable",
]);

interface ProviderInput {
  id?: string;
  provider_id?: string;
  display_name?: string;
  name?: string;
  version?: string;
  status?: string;
  transport?: string;
  endpoint?: string;
  capabilities?: JsonRecord;
  actions?: GraphAction[];
  source?: string;
}

interface ArtifactInput {
  artifact_id?: string;
  provider_id?: string;
  manifest_id?: string;
  role?: string;
  media_type?: string;
  filename?: string;
  logical_name?: string;
  sha256?: string;
  size_bytes?: number;
  storage_backend?: string;
  uri?: string;
  custody_mode?: ArtifactCustodyMode | string;
  home_repo_id?: string;
  repo_locator?: JsonRecord;
  availability?: ArtifactAvailability | string;
  retention?: JsonRecord;
  reference?: JsonRecord;
  link?: ArtifactLinkInput;
  links?: ArtifactLinkInput[];
  metadata?: JsonRecord;
  pinned?: boolean;
  content?: string;
  content_base64?: string;
  // Daemon-visible filesystem path to read bytes from. Lets large artifacts be
  // ingested without routing base64 through shell argv / JSON request bodies
  // (issue 833e972). Over the file transport this is set only by the transport
  // from a validated spool attachment, never honored from client request bodies.
  content_path?: string;
  // In-process Buffer handoff (e.g. snapshotArtifactBytes -> ingestArtifact)
  // that avoids the base64 encode/decode amplification round-trip. Not
  // JSON-serializable; only used within the same process.
  content_buffer?: Buffer;
  json?: unknown;
}

export interface LocalArtifactPathInput {
  path: string;
  role?: string;
  media_type?: string;
  logical_name?: string;
  filename?: string;
  custody_mode?: ArtifactCustodyMode | string;
  issue?: string;
  issue_project?: string;
  link_type?: string;
  link_role?: string;
  allow_dirty_link?: boolean;
  allow_local_only?: boolean;
  recoverability?: ArtifactRecoverability | string;
  regenerable_from?: string;
  metadata?: JsonRecord;
  reference?: JsonRecord;
  pinned?: boolean;
}

export interface LocalArtifactPathRegistration {
  artifact: ArtifactRecord;
  git_state: ArtifactGitState;
  recoverability: ArtifactRecoverability;
  warnings: string[];
}

export interface ArtifactResolveAndLinkInput {
  ref?: string;
  artifact_ref?: string;
  artifact_id?: string;
  entity_type?: string;
  entity_id?: string;
  issue?: string;
  issue_project?: string;
  link_type?: string;
  role?: string;
  repo_id?: string;
  provider_id?: string;
  source?: string;
  metadata?: JsonRecord;
  // `pinned` (default) stores the concrete resolved artifact id; `living`
  // requires a single resolvable series and tracks its head (migration v89,
  // issue 10960ea).
  link_kind?: "pinned" | "living";
}

export interface ArtifactResolveAndLinkResult {
  resolution: ArtifactResolveResult;
  link: ArtifactLinkRecord | null;
}

export interface ArtifactSnapshotInput {
  ref?: string;
  artifact_ref?: string;
  path?: string;
  content?: string;
  content_base64?: string;
  // Daemon-visible path (e.g. a validated file-RPC spool attachment) read in
  // place of inline base64 so multi-MiB snapshots never travel through argv
  // (issue 833e972).
  content_path?: string;
  // In-process Buffer handoff (e.g. recordArtifactVersion managed-ref -> snapshot)
  // that avoids the base64 encode/decode amplification round-trip. Not
  // JSON-serializable; only used within the same process.
  content_buffer?: Buffer;
  json?: unknown;
  custody_mode?: "copy" | "managed" | string;
  media_type?: string;
  role?: string;
  filename?: string;
  logical_name?: string;
  metadata?: JsonRecord;
  reference?: JsonRecord;
}

export interface ArtifactBundleMemberInput {
  ref?: string;
  artifact_ref?: string;
  path?: string;
  role?: string;
  custody_mode?: ArtifactCustodyMode | string;
  allow_local_only?: boolean;
  allow_dirty_link?: boolean;
  metadata?: JsonRecord;
}

export interface ArtifactBundleInput {
  name: string;
  role?: string;
  members: ArtifactBundleMemberInput[];
  issue?: string;
  issue_project?: string;
  metadata?: JsonRecord;
}

interface ArtifactLinkInput {
  entity_type?: string;
  entity_id?: string;
  link_type?: string;
  role?: string;
  repo_id?: string;
  provider_id?: string;
  source?: string;
  metadata?: JsonRecord;
  // Typed-link write inputs (migration v89, issue 10960ea). For `living` links
  // the caller must supply `series_id` (the link id is keyed by it) and should
  // supply `series_ref` (the author-facing ref). Omitted/`pinned` keeps the
  // byte-identical legacy id formula and leaves both series fields null.
  link_kind?: "pinned" | "living";
  series_id?: string;
  series_ref?: string;
}

export interface ArtifactListOptions {
  q?: string;
  hashPrefix?: string;
  repo?: string;
  provider?: string;
  role?: string;
  custody?: string;
  availability?: string;
  scheme?: string;
  location?: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
  limit?: number;
  offset?: number;
  summary?: boolean;
}

interface ManifestEntityInput {
  id?: string;
  external_id?: string;
  type?: string;
  title?: string;
  label?: string;
  status?: string;
  labels?: string[];
  summary?: JsonRecord;
  detail?: JsonRecord;
  metrics?: Record<string, number | string | boolean>;
  visual?: JsonRecord;
  actions?: GraphAction[];
  created_at?: string | number;
  updated_at?: string | number;
  repo_id?: string;
}

interface ManifestEdgeInput {
  id?: string;
  source?: string;
  target?: string;
  type?: string;
  edge_type?: string;
  edge_class?: string;
  provenance?: string;
  confidence?: string;
  metadata?: JsonRecord;
  created_at?: string | number;
}

interface ManifestInput {
  provider_id?: string;
  provider?: ProviderInput;
  manifest?: JsonRecord;
  manifest_type?: string;
  version?: string;
  source?: string;
}

interface GraphEntityRow {
  id: string;
  entity_type: string;
  repo_id: string | null;
  provider_id: string | null;
  external_id: string | null;
  title: string;
  status: string | null;
  labels_json: string;
  summary_json: string;
  detail_ref_json: string;
  action_context_json: string;
  visual_json: string;
  created_at: number | null;
  updated_at: number | null;
  observed_at: number;
  source: string;
}

interface GraphEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  edge_class: string;
  provenance: string;
  confidence: string;
  metadata_json: string;
  created_at: number | null;
  observed_at: number;
  source: string;
}

export interface IndexedGraphOptions {
  mode: GraphMode;
  providerId?: string;
  root?: string;
  limit?: number;
}

export interface IndexedGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function expandHomePath(value: string): string {
  if (value === "~") return userHome();
  if (value.startsWith("~/")) return path.join(userHome(), value.slice(2));
  return value;
}

function normalizeArtifactRoot(value: string): string {
  return path.resolve(expandHomePath(value));
}

function asCustodyMode(value: unknown, fallback: ArtifactCustodyMode): ArtifactCustodyMode {
  return value === "link" || value === "copy" || value === "managed" || value === "external"
    ? value
    : fallback;
}

function asAvailability(value: unknown, fallback: ArtifactAvailability): ArtifactAvailability {
  return value === "present" || value === "missing" || value === "stale" || value === "unchecked"
    || value === "remote_only" || value === "pinned"
    ? value
    : fallback;
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function tableExists(db: Db, table: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) as { name: string } | undefined;
  return Boolean(row);
}

function artifactRootFromSettings(db?: Db): string | undefined {
  if (!db || !tableExists(db, "settings")) return undefined;
  const row = db.prepare(
    "SELECT value FROM settings WHERE key = ?"
  ).get(ARTIFACT_ROOT_SETTING) as { value: string } | undefined;
  return asString(row?.value);
}

export function getArtifactRoot(db?: Db): string {
  const envOverride = asString(process.env.MANDIBLE_ARTIFACT_DIR);
  if (envOverride) return normalizeArtifactRoot(envOverride);

  const settingOverride = artifactRootFromSettings(db);
  if (settingOverride) return normalizeArtifactRoot(settingOverride);

  const mandibleHome = asString(process.env.MANDIBLE_HOME);
  if (mandibleHome) return path.join(normalizeArtifactRoot(mandibleHome), "artifacts");

  return path.join(normalizeArtifactRoot(userHome()), ".mandible", "artifacts");
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function assertProviderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("provider_id is required");
  }
  const normalized = normalizeIdentifier(value);
  if (!normalized) {
    throw new Error("provider_id is invalid");
  }
  return normalized;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).sort(([a], [b]) => a.localeCompare(b));
    const out: JsonRecord = {};
    for (const [key, nested] of entries) {
      out[key] = stableJson(nested);
    }
    return out;
  }
  return value;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJson(value));
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashString(value: string): string {
  return hashBuffer(Buffer.from(value, "utf8"));
}

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function artifactPathForHash(hash: string, root = getArtifactRoot()): string {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

// The content-addressed storage path for a sha256 hash. Exposed so materializers
// can fall back to a durable CAS copy (e.g. one written by an explicit managed
// snapshot) when an artifact's registered location is gone — the bytes are
// hash-verified by construction.
export function artifactCasPath(db: Db, hash: string): string {
  return artifactPathForHash(hash, getArtifactRoot(db));
}

function contentBuffer(input: ArtifactInput): Buffer {
  if (Buffer.isBuffer(input.content_buffer)) {
    return input.content_buffer;
  }
  if (typeof input.content_path === "string" && input.content_path.trim()) {
    return fs.readFileSync(path.resolve(expandHomePath(input.content_path)));
  }
  if (typeof input.content_base64 === "string") {
    return Buffer.from(input.content_base64, "base64");
  }
  if (typeof input.content === "string") {
    return Buffer.from(input.content, "utf8");
  }
  if ("json" in input) {
    return Buffer.from(stableJsonStringify(input.json), "utf8");
  }
  throw new Error("artifact content, content_base64, content_path, or json is required");
}

function hasInlineArtifactContent(input: ArtifactInput): boolean {
  return (
    Buffer.isBuffer(input.content_buffer) ||
    (typeof input.content_path === "string" && Boolean(input.content_path.trim())) ||
    typeof input.content_base64 === "string" ||
    typeof input.content === "string" ||
    "json" in input
  );
}

function hashFromArtifactRef(input: ArtifactInput): string | undefined {
  if (isSha256(input.sha256)) {
    return input.sha256.toLowerCase();
  }
  if (!input.artifact_id) return undefined;
  const match = /^artifact-blob:([a-f0-9]{64})$/i.exec(input.artifact_id.trim());
  return match?.[1]?.toLowerCase();
}

function artifactHashFromRef(ref: string): string | undefined {
  const match = /^artifact-blob:([a-f0-9]{64})$/i.exec(ref.trim());
  return match?.[1]?.toLowerCase();
}

type ArtifactHashRefParse =
  | { kind: "full"; hash: string; prefix: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "too_short"; prefix: string }
  | { kind: "invalid"; prefix: string };

const MIN_ARTIFACT_HASH_PREFIX_LENGTH = 7;
const MIN_ARTIFACT_ID_PREFIX_LENGTH = MIN_ARTIFACT_HASH_PREFIX_LENGTH;

type PrefixLookupResult<T> =
  | { status: "resolved"; value: T }
  | { status: "ambiguous" | "unresolved" | "unsupported"; value: null };

function artifactHashRefFromRef(ref: string): ArtifactHashRefParse | null {
  const trimmed = ref.trim();
  const match = /^(?:artifact:(?:sha256:)?)?([a-f0-9]+)$/i.exec(trimmed);
  if (!match) {
    if (/^artifact:/i.test(trimmed)) {
      return { kind: "invalid", prefix: "" };
    }
    return null;
  }
  const prefix = match[1].toLowerCase();
  if (prefix.length === 64) return { kind: "full", hash: prefix, prefix };
  if (prefix.length >= MIN_ARTIFACT_HASH_PREFIX_LENGTH) return { kind: "prefix", prefix };
  return { kind: "too_short", prefix };
}

function schemeFromRef(ref: string): string {
  const trimmed = ref.trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return schemeMatch ? schemeMatch[1].toLowerCase() : "unknown";
}

function isRegisterableArtifactRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (/^artifact-series:/i.test(trimmed)) return false;
  if (/^artifact:sha256:/i.test(trimmed) || /^sha256:/i.test(trimmed)) return false;
  if (/^[a-f0-9]{7,64}$/i.test(trimmed)) return false;
  if (/^artifact:[a-f0-9]{7,64}$/i.test(trimmed)) return false;
  if (/^artifact(?:-version|-blob)?:/i.test(trimmed)) return true;
  return schemeFromRef(trimmed) !== "unknown" && trimmed.includes("://");
}

function normalizeRef(ref: string, options: { db?: Db; validateRepo?: boolean } = {}): {
  scheme: string;
  alias: string;
  normalizedRef: string;
  locator: JsonRecord;
  invalidReason?: string;
} {
  const alias = ref.trim();
  const artifactHashRef = artifactHashRefFromRef(alias);
  if (artifactHashRef && artifactHashRef.kind !== "invalid" && artifactHashRef.kind !== "too_short") {
    return {
      scheme: "artifact",
      alias,
      normalizedRef: `artifact:${artifactHashRef.prefix}`,
      locator: {
        algorithm: "sha256",
        prefix: artifactHashRef.prefix,
        ...(artifactHashRef.kind === "full" ? { hash: artifactHashRef.hash } : {}),
      },
    };
  }

  const repoMatch = /^repo:\/\/([^/@\s]+)(?:@([^/\s]+))?\/(.+)$/i.exec(alias);
  if (repoMatch) {
    const inputRepoId = repoMatch[1];
    const refName = repoMatch[2];
    const repoPath = repoMatch[3].replace(/^\/+/, "");
    const resolution = options.db ? resolveCanonicalArtifactRepoRef(options.db, inputRepoId) : null;
    if (resolution && !resolution.ok && options.validateRepo) {
      return {
        scheme: "repo",
        alias,
        normalizedRef: alias,
        locator: { repo_id: inputRepoId, ref: refName ?? null, path: repoPath },
        invalidReason: resolution.reason,
      };
    }
    const repoId = resolution?.ok ? resolution.project_key : inputRepoId;
    return {
      scheme: "repo",
      alias,
      normalizedRef: `repo://${repoId}${refName ? `@${refName}` : ""}/${repoPath}`,
      locator: { repo_id: repoId, ref: refName ?? null, path: repoPath },
    };
  }

  const scheme = schemeFromRef(alias);
  return {
    scheme,
    alias,
    normalizedRef: scheme === "unknown" ? alias : alias.replace(/^([a-z][a-z0-9+.-]*):/i, `${scheme}:`),
    locator: scheme === "unknown" ? { raw_ref: alias } : { uri: alias },
  };
}

function repoLocatorUri(locator: JsonRecord): string | undefined {
  const repoId = asString(locator.repo_id) ?? asString(locator.repo);
  const repoPath = asString(locator.path) ?? asString(locator.relative_path);
  if (!repoId || !repoPath) return undefined;
  const ref = asString(locator.ref) ?? asString(locator.commit) ?? asString(locator.branch);
  return `repo://${repoId}${ref ? `@${ref}` : ""}/${repoPath.replace(/^\/+/, "")}`;
}

function artifactRegistryId(prefix: string, parts: unknown[]): string {
  return `${prefix}:${hashBuffer(Buffer.from(stableJsonStringify(parts), "utf8")).slice(0, 32)}`;
}

function referenceArtifactId(normalizedRef: string): string {
  return `artifact:ref:${hashString(normalizedRef)}`;
}

function uriSizeBytes(uri: string | undefined): number | undefined {
  if (!uri) return undefined;
  const filePath = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  if (!filePath || filePath.startsWith("artifact://")) return undefined;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function isoFromMs(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function msFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function defaultActionsForType(type: string, nodeId: string): GraphAction[] {
  if (type === "issue") {
    return [{ id: "open-issue", label: "Open Issue", kind: "navigate", target: nodeId }];
  }
  if (type === "session") {
    return [{ id: "open-session", label: "Open Session", kind: "navigate", target: nodeId }];
  }
  if (type === "auth_request") {
    return [{ id: "open-auth", label: "Open Auth", kind: "navigate", target: nodeId }];
  }
  if (type === "artifact") {
    return [
      { id: "open-artifact", label: "Open Artifact", kind: "preview", target: nodeId },
      { id: "validate-artifact", label: "Validate", kind: "validate", target: nodeId },
    ];
  }
  if (type === "run" || type === "analysis") {
    return [
      { id: "open-node", label: "Open", kind: "preview", target: nodeId },
      { id: "request-compute", label: "Request Compute", kind: "auth_request", target: nodeId, requires_auth: true },
    ];
  }
  return [{ id: "inspect", label: "Inspect", kind: "preview", target: nodeId }];
}

function titleFromIdentifier(value: string): string {
  return value
    .replace(/[_:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function actionKindFromCapability(id: string, capability: JsonRecord): GraphAction["kind"] {
  const lower = id.toLowerCase();
  if (lower.includes("validate")) return "validate";
  if (lower.includes("start") || lower.includes("execute") || lower.includes("run")) return "compute";
  if (lower.includes("import") || lower.includes("manifest") || lower.includes("register")) return "ingest";
  return (asString(capability.kind) as GraphAction["kind"] | undefined) ?? "preview";
}

function actionsFromCapabilities(providerId: string, capabilities: JsonRecord): GraphAction[] {
  return Object.entries(capabilities)
    .filter(([, capability]) => capability && typeof capability === "object" && !Array.isArray(capability))
    .map(([id, rawCapability]) => {
      const capability = rawCapability as JsonRecord;
      const kind = actionKindFromCapability(id, capability);
      const requiresReview = Boolean(capability.requires_review) || kind === "compute";
      return {
        id: `${providerId}.${normalizeIdentifier(id)}`,
        label: titleFromIdentifier(id),
        kind,
        target: `provider:${providerId}`,
        requires_auth: requiresReview,
        description: asString(capability.description),
      };
    });
}

function graphEntityId(providerId: string, type: string, rawId: string): string {
  const id = rawId.trim();
  if (/^[a-z_]+:[^\s]+/.test(id)) {
    return id;
  }
  return `${normalizeIdentifier(type)}:${providerId}:${normalizeIdentifier(id)}`;
}

function inferProviderId(input: ManifestInput, manifest: JsonRecord): string {
  const providerRaw = manifest.provider ?? input.provider;
  if (asString(input.provider_id)) return assertProviderId(input.provider_id);
  if (asString(providerRaw)) return assertProviderId(providerRaw);
  const providerInfo = asRecord(providerRaw);
  if (asString(providerInfo.id) || asString(providerInfo.provider_id)) {
    return assertProviderId(providerInfo.id ?? providerInfo.provider_id);
  }
  if (asString(manifest.provider_id)) return assertProviderId(manifest.provider_id);
  const schemaVersion = asString(manifest.schema_version);
  const providerVersion = asString(manifest.provider_version);
  const kind = asString(manifest.kind);
  if (
    schemaVersion?.startsWith("feedbax.") ||
    providerVersion?.startsWith("feedbax-") ||
    "feedbax_version" in manifest ||
    (kind !== undefined && MANIFEST_KIND_TYPES[kind] !== undefined)
  ) {
    return "feedbax";
  }
  throw new Error("provider_id is required");
}

function providerInputFromManifest(
  providerId: string,
  manifest: JsonRecord,
  input: ManifestInput,
): ProviderInput {
  const providerRaw = manifest.provider ?? input.provider;
  const providerInfo = asRecord(providerRaw);
  const capabilities = {
    ...asRecord(providerInfo.capabilities),
    ...asRecord(manifest.capabilities),
  };
  const entryPoints = asRecord(manifest.entry_points ?? providerInfo.entry_points);
  const artifactRoles = Array.isArray(manifest.artifact_roles) ? manifest.artifact_roles : undefined;
  const schemas = asRecord(manifest.schemas);
  const health = asRecord(manifest.health);
  const storedCapabilities: JsonRecord = {
    ...capabilities,
    ...(Object.keys(entryPoints).length ? { entry_points: entryPoints } : {}),
    ...(artifactRoles ? { artifact_roles: artifactRoles } : {}),
    ...(Object.keys(schemas).length ? { schemas } : {}),
    ...(Object.keys(health).length ? { health } : {}),
    ...(asString(manifest.schema_version) ? { schema_version: manifest.schema_version } : {}),
  };
  const displayName = asString(providerInfo.display_name)
    ?? asString(providerInfo.name)
    ?? (providerId === "feedbax" ? "Feedbax" : providerId);
  return {
    ...providerInfo,
    id: providerId,
    display_name: displayName,
    version: asString(providerInfo.version)
      ?? asString(manifest.provider_version)
      ?? asString(manifest.version)
      ?? asString(manifest.feedbax_version),
    status: asString(providerInfo.status) ?? "active",
    transport: asString(providerInfo.transport) ?? (Object.keys(entryPoints).length ? "manifest" : "manifest"),
    endpoint: asString(providerInfo.endpoint) ?? asString(entryPoints.http),
    capabilities: storedCapabilities,
    actions: Array.isArray(providerInfo.actions)
      ? (providerInfo.actions as GraphAction[])
      : actionsFromCapabilities(providerId, capabilities),
    source: input.source ?? "manifest",
  };
}

const MANIFEST_KIND_TYPES: Record<string, string> = {
  GraphSpecManifest: "provider_spec",
  ModelArtifactManifest: "model",
  TrainingRunSetManifest: "run",
  TrainingRunManifest: "run",
  EvaluationRunManifest: "run",
  AnalysisRunManifest: "analysis",
  ReportManifest: "report",
};

const SPEC_FIELD_KINDS: Array<[field: string, fallbackKind: string]> = [
  ["graph_spec", "GraphSpec"],
  ["training_spec", "TrainingSpec"],
  ["task_spec", "TaskSpec"],
  ["evaluation_spec", "EvaluationRunSpec"],
  ["analysis_spec", "AnalysisRunSpec"],
  ["report_spec", "ReportSpec"],
];

const MODEL_STORE_FIELDS = ["parameter_store", "state_store", "optimizer_store"] as const;

function isNativeProviderManifest(manifest: JsonRecord): boolean {
  return asString(manifest.kind) === "experiment_provider" && (
    typeof manifest.provider === "string" || typeof manifest.provider_id === "string"
  );
}

function nativeSubjectType(manifest: JsonRecord): string | null {
  const kind = asString(manifest.kind);
  return kind ? MANIFEST_KIND_TYPES[kind] ?? null : null;
}

function nativeSubjectTitle(manifest: JsonRecord, type: string): string {
  const kind = asString(manifest.kind) ?? type;
  const id = asString(manifest.id);
  const name = asString(manifest.name) ?? asString(manifest.job_id) ?? id;
  if (!name) return titleFromIdentifier(kind);
  if (kind === "TrainingRunManifest") return `Training run ${name}`;
  if (kind === "TrainingRunSetManifest") return `Training run set ${name}`;
  if (kind === "EvaluationRunManifest") return `Evaluation run ${name}`;
  if (kind === "AnalysisRunManifest") return `Analysis ${name}`;
  if (kind === "ReportManifest") return `Report ${name}`;
  if (kind === "GraphSpecManifest") return `Graph spec ${name}`;
  if (kind === "ModelArtifactManifest") return `Model ${name}`;
  return name;
}

function isNativeArtifactRef(item: JsonRecord): boolean {
  return Boolean(
    asString(item.artifact_id) ||
    isSha256(asString(item.sha256)) ||
    asString(item.logical_name) ||
    asString(item.storage_backend),
  );
}

function modelStoreRefs(manifest: JsonRecord): Array<{ field: string; ref: JsonRecord }> {
  const refs: Array<{ field: string; ref: JsonRecord }> = [];
  for (const field of MODEL_STORE_FIELDS) {
    const raw = manifest[field];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const ref = asRecord(item);
        if (Object.keys(ref).length > 0) refs.push({ field, ref });
      }
      continue;
    }
    const ref = asRecord(raw);
    if (Object.keys(ref).length > 0) refs.push({ field, ref });
  }
  return refs;
}

function entityTypeForParentKind(kind: string): string {
  return MANIFEST_KIND_TYPES[kind] ?? (kind.endsWith("Spec") ? "provider_spec" : "provider_manifest");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function splitProviderIssueRef(rawRef: string): { projectRef?: string; issueRef: string } {
  const trimmed = rawRef.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1 && !trimmed.includes("://")) {
    return { projectRef: trimmed.slice(0, slash), issueRef: trimmed.slice(slash + 1) };
  }
  return { issueRef: trimmed };
}

function projectIdForRef(db: Db, projectRef: string | undefined): string | null {
  const ref = projectRef?.trim();
  if (!ref || !tableExists(db, "ledger_projects")) return null;
  const checkoutPredicate = tableExists(db, "ledger_project_checkouts")
    ? `UNION
       SELECT project_id AS id FROM ledger_project_checkouts
        WHERE lower(name) = lower(@ref) OR work_repo_id = @ref OR root = @ref`
    : "";
  const rows = db.prepare(
    `SELECT id FROM ledger_projects
      WHERE lower(display_name) = lower(@ref)
         OR id = @ref
         OR remote_identity = @ref
     ${checkoutPredicate}`
  ).all({ ref }) as Array<{ id: string }>;
  const ids = Array.from(new Set(rows.map((row) => row.id)));
  return ids.length === 1 ? ids[0] : null;
}

function issueMatches(db: Db, issueRef: string, projectId: string | null): string[] {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_issue_aliases")) return [];
  const trimmed = issueRef.trim();
  if (!trimmed) return [];
  const matches = new Set<string>();
  const addRows = (rows: Array<{ id?: string; issue_id?: string }>) => {
    for (const row of rows) {
      const id = row.id ?? row.issue_id;
      if (id) matches.add(id);
    }
  };

  if (projectId) {
    addRows(db.prepare(
      "SELECT id FROM ledger_issues WHERE id = ? AND project_id = ?",
    ).all(trimmed, projectId) as Array<{ id: string }>);
    addRows(db.prepare(
      "SELECT id FROM ledger_issues WHERE short_id = ? AND project_id = ?",
    ).all(trimmed, projectId) as Array<{ id: string }>);
    addRows(db.prepare(
      "SELECT issue_id FROM ledger_issue_aliases WHERE alias = ? AND project_id = ?",
    ).all(trimmed, projectId) as Array<{ issue_id: string }>);
  } else {
    addRows(db.prepare("SELECT id FROM ledger_issues WHERE id = ?").all(trimmed) as Array<{ id: string }>);
    addRows(db.prepare("SELECT id FROM ledger_issues WHERE short_id = ?").all(trimmed) as Array<{ id: string }>);
    addRows(db.prepare("SELECT issue_id FROM ledger_issue_aliases WHERE alias = ?").all(trimmed) as Array<{ issue_id: string }>);
  }

  if (matches.size === 0 && trimmed.length >= 4) {
    const like = `${escapeLike(trimmed)}%`;
    if (projectId) {
      addRows(db.prepare(
        "SELECT id FROM ledger_issues WHERE id LIKE ? ESCAPE '\\' AND project_id = ?",
      ).all(like, projectId) as Array<{ id: string }>);
      addRows(db.prepare(
        "SELECT id FROM ledger_issues WHERE short_id LIKE ? ESCAPE '\\' AND project_id = ?",
      ).all(like, projectId) as Array<{ id: string }>);
      addRows(db.prepare(
        "SELECT issue_id FROM ledger_issue_aliases WHERE alias LIKE ? ESCAPE '\\' AND project_id = ?",
      ).all(like, projectId) as Array<{ issue_id: string }>);
    } else {
      addRows(db.prepare("SELECT id FROM ledger_issues WHERE id LIKE ? ESCAPE '\\'").all(like) as Array<{ id: string }>);
      addRows(db.prepare("SELECT id FROM ledger_issues WHERE short_id LIKE ? ESCAPE '\\'").all(like) as Array<{ id: string }>);
      addRows(db.prepare("SELECT issue_id FROM ledger_issue_aliases WHERE alias LIKE ? ESCAPE '\\'").all(like) as Array<{ issue_id: string }>);
    }
  }

  return Array.from(matches).sort();
}

function ledgerIssueGraphInfo(db: Db, issueId: string, providerId: string, rawRef: string, now: number): {
  nodeId: string;
  metadata: JsonRecord;
} | null {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_projects")) return null;
  const row = db.prepare(
    `SELECT i.id, i.short_id, i.project_id, i.title, i.status, i.kind, i.priority,
            p.display_name, c.work_repo_id, c.root, c.name AS checkout_name
       FROM ledger_issues i
       JOIN ledger_projects p ON p.id = i.project_id
       LEFT JOIN ledger_project_checkouts c ON c.project_id = i.project_id
      WHERE i.id = ?
      ORDER BY c.updated_at DESC
      LIMIT 1`
  ).get(issueId) as {
    id: string;
    short_id: string;
    project_id: string;
    title: string;
    status: string;
    kind: string;
    priority: string;
    display_name: string;
    work_repo_id: string | null;
    root: string | null;
    checkout_name: string | null;
  } | undefined;
  if (!row) return null;
  const displayId = row.short_id || row.id.slice(0, 7);
  const repoId = row.work_repo_id ?? (row.root ? path.basename(row.root) : row.project_id);
  const nodeId = `issue:${repoId}:${displayId}`;
  upsertGraphEntity(db, {
    id: nodeId,
    entity_type: "issue",
    provider_id: providerId,
    repo_id: repoId,
    external_id: row.id,
    title: row.title,
    status: row.status,
    labels: [row.kind],
    summary: {
      issue_id: displayId,
      ledger_issue_id: row.id,
      kind: row.kind,
      priority: row.priority,
      reference_source: "provider_provenance",
      provider_reference: rawRef,
      resolution_status: "resolved",
    },
    detail: {
      ledger_issue_id: row.id,
      project_id: row.project_id,
      repo_root: row.root,
      repo_name: row.checkout_name ?? row.display_name,
      display_id: displayId,
      provider_reference: rawRef,
    },
    visual: { icon: "issue", shape: "document" },
    created_at: null,
    updated_at: now,
    observed_at: now,
    source: "provider_manifest",
  });
  return {
    nodeId,
    metadata: {
      issue_ref: rawRef,
      ledger_issue_id: row.id,
      project_id: row.project_id,
      display_id: displayId,
      resolution_status: "resolved",
      resolution_source: "ledger",
    },
  };
}

function upsertNativeReferenceNode(db: Db, args: {
  providerId: string;
  ref: JsonRecord;
  fallbackKind: string;
  sourceId: string;
  manifestId: string;
  edgeType: string;
  now: number;
  source: string;
  idMap: Map<string, string>;
}): string | null {
  const kind = asString(args.ref.kind) ?? args.fallbackKind;
  const refId = asString(args.ref.id) ?? asString(args.ref.ref) ?? asString(args.ref.sha256);
  const inline = asRecord(args.ref.inline);
  const inlineHash = asString(args.ref.sha256);
  const rawId = refId ?? inlineHash ?? `${kind}:${hashBuffer(Buffer.from(stableJsonStringify(inline), "utf8"))}`;
  if (!rawId) return null;
  const entityType = asString(args.ref.id) ? entityTypeForParentKind(kind) : "provider_spec";
  const nodeId = graphEntityId(args.providerId, entityType, rawId);
  args.idMap.set(rawId, nodeId);
  if (refId) args.idMap.set(refId, nodeId);
  upsertGraphEntity(db, {
    id: nodeId,
    entity_type: entityType,
    provider_id: args.providerId,
    external_id: rawId,
    title: asString(args.ref.label) ?? asString(args.ref.name) ?? `${titleFromIdentifier(kind)} ${refId ?? inlineHash?.slice(0, 12) ?? ""}`.trim(),
    status: asString(args.ref.status) ?? "referenced",
    summary: {
      kind,
      role: asString(args.ref.role) ?? null,
      sha256: inlineHash ?? null,
      ref: asString(args.ref.ref) ?? null,
    },
    detail: {
      manifest_id: args.manifestId,
      uri: asString(args.ref.uri) ?? null,
      metadata: asRecord(args.ref.metadata),
      inline: Object.keys(inline).length > 0 ? inline : undefined,
    },
    visual: { icon: entityType === "provider_spec" ? "spec" : "manifest", shape: "document" },
    created_at: msFromUnknown(args.ref.created_at),
    updated_at: msFromUnknown(args.ref.updated_at) ?? args.now,
    observed_at: args.now,
    source: args.source,
  });
  upsertGraphEdge(db, {
    id: `${args.edgeType}:${args.sourceId}:${nodeId}`,
    source_id: args.sourceId,
    target_id: nodeId,
    edge_type: args.edgeType,
    edge_class: "provenance",
    provenance: "provider_manifest",
    metadata: {
      kind,
      role: asString(args.ref.role) ?? null,
    },
    observed_at: args.now,
    source: args.source,
  });
  return nodeId;
}

function upsertNativeIssueRef(db: Db, args: {
  providerId: string;
  issueId: string;
  sourceId: string;
  provenance?: JsonRecord;
  now: number;
  source: string;
}): void {
  const { projectRef, issueRef } = splitProviderIssueRef(args.issueId);
  const provenance = args.provenance ?? {};
  const projectHint = projectRef
    ?? asString(provenance.issue_project)
    ?? asString(provenance.project)
    ?? asString(provenance.repo_id)
    ?? asString(provenance.source_repo_id);
  const projectId = projectIdForRef(db, projectHint);
  const matches = issueMatches(db, issueRef, projectId);
  const resolved = matches.length === 1
    ? ledgerIssueGraphInfo(db, matches[0], args.providerId, args.issueId, args.now)
    : null;
  const nodeId = resolved?.nodeId ?? graphEntityId(args.providerId, "issue", args.issueId);
  const resolutionMetadata = resolved?.metadata ?? {
    issue_ref: args.issueId,
    issue_ref_normalized: issueRef,
    project_ref: projectHint ?? null,
    resolution_status: matches.length > 1 ? "ambiguous" : "unresolved",
    resolution_source: "provider_fallback",
    candidate_count: matches.length,
  };
  if (resolved) {
    upsertGraphEdge(db, {
      id: `requested_by:${nodeId}:${args.sourceId}`,
      source_id: nodeId,
      target_id: args.sourceId,
      edge_type: "requested_by",
      edge_class: "provenance",
      provenance: "provider_manifest",
      metadata: resolutionMetadata,
      observed_at: args.now,
      source: args.source,
    });
    return;
  }

  upsertGraphEntity(db, {
    id: nodeId,
    entity_type: "issue",
    provider_id: args.providerId,
    external_id: args.issueId,
    title: `Issue ${args.issueId}`,
    status: "referenced",
    summary: {
      issue_id: args.issueId,
      reference_source: "provider_provenance",
      resolution_status: resolutionMetadata.resolution_status,
    },
    detail: {
      provider_id: args.providerId,
      note: "Provider manifest provenance issue reference",
      resolution: resolutionMetadata,
    },
    visual: { icon: "issue", shape: "document" },
    created_at: null,
    updated_at: args.now,
    observed_at: args.now,
    source: args.source,
  });
  upsertGraphEdge(db, {
    id: `requested_by:${nodeId}:${args.sourceId}`,
    source_id: nodeId,
    target_id: args.sourceId,
    edge_type: "requested_by",
    edge_class: "provenance",
    provenance: "provider_manifest",
    metadata: resolutionMetadata,
    observed_at: args.now,
    source: args.source,
  });
}

function upsertNativeManifestSubject(db: Db, args: {
  providerId: string;
  manifest: JsonRecord;
  manifestId: string;
  manifestArtifactId: string;
  now: number;
  source: string;
  idMap: Map<string, string>;
}): string | null {
  const subjectType = nativeSubjectType(args.manifest);
  const manifestExternalId = asString(args.manifest.id);
  if (!subjectType || !manifestExternalId) return null;
  const nodeId = graphEntityId(args.providerId, subjectType, manifestExternalId);
  args.idMap.set(manifestExternalId, nodeId);
  args.idMap.set("subject", nodeId);
  const kind = asString(args.manifest.kind) ?? subjectType;
  const summaryMetrics = asRecord(args.manifest.summary_metrics);
  upsertGraphEntity(db, {
    id: nodeId,
    entity_type: subjectType,
    provider_id: args.providerId,
    external_id: manifestExternalId,
    title: nativeSubjectTitle(args.manifest, subjectType),
    status: asString(args.manifest.status) ?? "ingested",
    labels: [kind],
    summary: {
      kind,
      schema_version: asString(args.manifest.schema_version) ?? null,
      provider_version: asString(args.manifest.provider_version) ?? null,
      feedbax_version: asString(args.manifest.feedbax_version) ?? null,
      job_id: asString(args.manifest.job_id) ?? null,
      run_set_id: asString(args.manifest.run_set_id) ?? null,
      metrics: summaryMetrics,
    },
    detail: {
      manifest_id: args.manifestId,
      manifest_artifact_id: args.manifestArtifactId,
      provenance: asRecord(args.manifest.provenance),
      metadata: asRecord(args.manifest.metadata),
      summary_metrics: summaryMetrics,
      validation_records: asArray<JsonRecord>(args.manifest.validation_records),
      migration_records: asArray<JsonRecord>(args.manifest.migration_records),
    },
    actions: defaultActionsForType(subjectType, nodeId),
    visual: { icon: subjectType, shape: subjectType === "run" ? "circle" : "document" },
    created_at: msFromUnknown(args.manifest.created_at),
    updated_at: msFromUnknown(args.manifest.completed_at) ?? msFromUnknown(args.manifest.updated_at) ?? args.now,
    observed_at: args.now,
    source: args.source,
  });
  upsertGraphEdge(db, {
    id: `manifest_declares:${args.manifestId}:${nodeId}`,
    source_id: args.manifestId,
    target_id: nodeId,
    edge_type: "manifest_declares",
    edge_class: "provenance",
    provenance: "provider_manifest",
    metadata: { kind },
    observed_at: args.now,
    source: args.source,
  });
  return nodeId;
}

function upsertGraphEntity(db: Db, entity: {
  id: string;
  entity_type: string;
  title: string;
  repo_id?: string | null;
  provider_id?: string | null;
  external_id?: string | null;
  status?: string | null;
  labels?: string[];
  summary?: JsonRecord;
  detail?: JsonRecord;
  actions?: GraphAction[];
  visual?: JsonRecord;
  created_at?: number | null;
  updated_at?: number | null;
  observed_at: number;
  source: string;
}): void {
  db.prepare(
    `INSERT INTO graph_entities (
      id, entity_type, repo_id, provider_id, external_id, title, status,
      labels_json, summary_json, detail_ref_json, action_context_json,
      visual_json, created_at, updated_at, observed_at, source
    ) VALUES (
      @id, @entity_type, @repo_id, @provider_id, @external_id, @title, @status,
      @labels_json, @summary_json, @detail_ref_json, @action_context_json,
      @visual_json, @created_at, @updated_at, @observed_at, @source
    )
    ON CONFLICT(id) DO UPDATE SET
      entity_type = excluded.entity_type,
      repo_id = excluded.repo_id,
      provider_id = excluded.provider_id,
      external_id = excluded.external_id,
      title = excluded.title,
      status = excluded.status,
      labels_json = excluded.labels_json,
      summary_json = excluded.summary_json,
      detail_ref_json = excluded.detail_ref_json,
      action_context_json = excluded.action_context_json,
      visual_json = excluded.visual_json,
      updated_at = excluded.updated_at,
      observed_at = excluded.observed_at,
      source = excluded.source`
  ).run({
    id: entity.id,
    entity_type: entity.entity_type,
    repo_id: entity.repo_id ?? null,
    provider_id: entity.provider_id ?? null,
    external_id: entity.external_id ?? null,
    title: entity.title,
    status: entity.status ?? null,
    labels_json: jsonStringify(entity.labels ?? []),
    summary_json: jsonStringify(entity.summary ?? {}),
    detail_ref_json: jsonStringify(entity.detail ?? {}),
    action_context_json: jsonStringify(entity.actions ?? defaultActionsForType(entity.entity_type, entity.id)),
    visual_json: jsonStringify(entity.visual ?? {}),
    created_at: entity.created_at ?? null,
    updated_at: entity.updated_at ?? entity.observed_at,
    observed_at: entity.observed_at,
    source: entity.source,
  });
}

function upsertGraphEdge(db: Db, edge: {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  edge_class?: string;
  provenance?: string;
  confidence?: string;
  metadata?: JsonRecord;
  created_at?: number | null;
  observed_at: number;
  source: string;
}): void {
  if (edge.source_id === edge.target_id) return;
  db.prepare(
    `INSERT INTO graph_edges (
      id, source_id, target_id, edge_type, edge_class, provenance,
      confidence, metadata_json, created_at, observed_at, source
    ) VALUES (
      @id, @source_id, @target_id, @edge_type, @edge_class, @provenance,
      @confidence, @metadata_json, @created_at, @observed_at, @source
    )
    ON CONFLICT(id) DO UPDATE SET
      source_id = excluded.source_id,
      target_id = excluded.target_id,
      edge_type = excluded.edge_type,
      edge_class = excluded.edge_class,
      provenance = excluded.provenance,
      confidence = excluded.confidence,
      metadata_json = excluded.metadata_json,
      observed_at = excluded.observed_at,
      source = excluded.source`
  ).run({
    id: edge.id,
    source_id: edge.source_id,
    target_id: edge.target_id,
    edge_type: edge.edge_type,
    edge_class: edge.edge_class ?? "provenance",
    provenance: edge.provenance ?? "system",
    confidence: edge.confidence ?? "observed",
    metadata_json: jsonStringify(edge.metadata ?? {}),
    created_at: edge.created_at ?? null,
    observed_at: edge.observed_at,
    source: edge.source,
  });
}

function artifactAliasTablesExist(db: Db): boolean {
  return tableExists(db, "artifact_aliases") && tableExists(db, "artifact_links");
}

export function registerArtifactAlias(db: Db, args: {
  artifactId?: string | null;
  ref: string;
  locator?: JsonRecord;
  resolutionStatus?: "resolved" | "unresolved" | "ambiguous" | "unsupported";
  source?: string;
  now?: number;
}): ArtifactAliasRecord {
  if (!tableExists(db, "artifact_aliases")) {
    throw new Error("artifact_aliases table is missing; run database migrations");
  }
  const now = args.now ?? Date.now();
  const normalized = normalizeRef(args.ref, { db });
  const artifactId = args.artifactId ?? null;
  const status = artifactId ? "resolved" : (args.resolutionStatus ?? "unresolved");
  const id = artifactRegistryId("artifact_alias", [normalized.scheme, normalized.normalizedRef]);
  db.prepare(
    `INSERT INTO artifact_aliases (
      id, artifact_id, scheme, alias, normalized_ref, locator_json,
      resolution_status, source, created_at, updated_at
    ) VALUES (
      @id, @artifact_id, @scheme, @alias, @normalized_ref, @locator_json,
      @resolution_status, @source, @created_at, @updated_at
    )
    ON CONFLICT(scheme, normalized_ref) DO UPDATE SET
      artifact_id = CASE
        WHEN artifact_aliases.artifact_id IS NULL THEN excluded.artifact_id
        WHEN excluded.artifact_id IS NULL THEN artifact_aliases.artifact_id
        WHEN artifact_aliases.artifact_id = excluded.artifact_id THEN artifact_aliases.artifact_id
        ELSE NULL
      END,
      alias = excluded.alias,
      locator_json = CASE
        WHEN excluded.locator_json != '{}' THEN excluded.locator_json
        ELSE artifact_aliases.locator_json
      END,
      resolution_status = CASE
        WHEN artifact_aliases.artifact_id IS NOT NULL
         AND excluded.artifact_id IS NOT NULL
         AND artifact_aliases.artifact_id != excluded.artifact_id THEN 'ambiguous'
        WHEN COALESCE(excluded.artifact_id, artifact_aliases.artifact_id) IS NOT NULL THEN 'resolved'
        ELSE excluded.resolution_status
      END,
      source = excluded.source,
      updated_at = excluded.updated_at`
  ).run({
    id,
    artifact_id: artifactId,
    scheme: normalized.scheme,
    alias: normalized.alias,
    normalized_ref: normalized.normalizedRef,
    locator_json: jsonStringify({ ...normalized.locator, ...(args.locator ?? {}) }),
    resolution_status: status,
    source: args.source ?? "artifact_registry",
    created_at: now,
    updated_at: now,
  });
  return getArtifactAlias(db, normalized.scheme, normalized.normalizedRef) as ArtifactAliasRecord;
}

// Whether `artifactId` is a genuine member of `seriesId` (has a version row).
function seriesContainsArtifact(db: Db, seriesId: string, artifactId: string): boolean {
  if (!artifactVersioningTablesExist(db)) return false;
  const row = db.prepare(
    "SELECT 1 FROM artifact_versions WHERE series_id = ? AND artifact_id = ? LIMIT 1",
  ).get(seriesId, artifactId);
  return Boolean(row);
}

export function registerArtifactLink(
  db: Db,
  artifactId: string,
  input: ArtifactLinkInput,
  now = Date.now(),
): ArtifactLinkRecord | null {
  if (!tableExists(db, "artifact_links")) {
    throw new Error("artifact_links table is missing; run database migrations");
  }
  const entityType = asString(input.entity_type);
  const entityId = asString(input.entity_id);
  if (!entityType || !entityId) return null;
  const linkType = asString(input.link_type) ?? "references";
  const role = asString(input.role) ?? null;
  const linkKind: "pinned" | "living" = input.link_kind === "living" ? "living" : "pinned";
  const seriesId = asString(input.series_id) ?? null;
  const seriesRef = asString(input.series_ref) ?? null;
  // AUTHORITATIVE typed-link invariants, enforced at this low-level chokepoint so
  // EVERY write path is covered — including /api/artifacts/ingest, which forwards
  // caller-supplied `link`/`links` straight here and would otherwise bypass the
  // route and resolveAndLinkArtifact guards (which remain as defense in depth).
  if (linkKind === "living") {
    // Evidence on an issue must pin one immutable version, never track a head.
    if (entityType === "issue" && linkType === "evidence") {
      throw new Error("evidence_links_must_be_pinned");
    }
    // A living link must name a real series, and its stored artifact_id (the
    // latest-at-creation fallback anchor) must be a genuine member of that
    // series; a bogus/non-member series_id could otherwise freeze a wrong or
    // dangling fallback. resolveAndLinkArtifact supplies a resolved series id and
    // a member artifact, so it passes unchanged.
    if (!seriesId) {
      throw new Error("living_link_requires_series");
    }
    if (!getArtifactSeries(db, seriesId) || !seriesContainsArtifact(db, seriesId, artifactId)) {
      throw new Error("living_link_series_mismatch");
    }
  }
  // PINNED keeps the byte-identical legacy identity: [artifactId, entityType,
  // entityId, linkType, role??""]. LIVING is keyed by the SERIES (not the
  // resolved artifact, which is only a latest-at-creation fallback) plus a
  // trailing "living" discriminator, so a pinned and a living link to the same
  // (entity, relation, role) coexist as distinct rows.
  const id = linkKind === "living"
    ? artifactRegistryId("artifact_link", [seriesId, entityType, entityId, linkType, role ?? "", "living"])
    : artifactRegistryId("artifact_link", [artifactId, entityType, entityId, linkType, role ?? ""]);
  db.prepare(
    // NOTE: artifact_id is intentionally NOT in the ON CONFLICT DO UPDATE SET.
    // A re-submission MUST NOT silently retarget an existing link's stored
    // artifact id (no silent retarget) — for living links the stored
    // latest-at-creation fallback stays pinned to its first write.
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
      provider_id, source, metadata_json, link_kind, series_id, series_ref,
      created_at, updated_at
    ) VALUES (
      @id, @artifact_id, @entity_type, @entity_id, @link_type, @role, @repo_id,
      @provider_id, @source, @metadata_json, @link_kind, @series_id, @series_ref,
      @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      repo_id = COALESCE(excluded.repo_id, artifact_links.repo_id),
      provider_id = COALESCE(excluded.provider_id, artifact_links.provider_id),
      source = excluded.source,
      metadata_json = excluded.metadata_json,
      link_kind = excluded.link_kind,
      series_id = excluded.series_id,
      series_ref = excluded.series_ref,
      updated_at = excluded.updated_at`
  ).run({
    id,
    artifact_id: artifactId,
    entity_type: entityType,
    entity_id: entityId,
    link_type: linkType,
    role,
    repo_id: asString(input.repo_id) ?? null,
    provider_id: asString(input.provider_id) ?? null,
    source: asString(input.source) ?? "artifact_registry",
    metadata_json: jsonStringify(input.metadata ?? {}),
    link_kind: linkKind,
    series_id: seriesId,
    series_ref: seriesRef,
    created_at: now,
    updated_at: now,
  });
  return getArtifactLink(db, id);
}

function asRecoverability(value: unknown, fallback: ArtifactRecoverability): ArtifactRecoverability {
  return typeof value === "string" && RECOVERABILITY_VALUES.has(value as ArtifactRecoverability)
    ? value as ArtifactRecoverability
    : fallback;
}

function mergeJsonRecords(...records: Array<JsonRecord | undefined>): JsonRecord {
  return Object.assign({}, ...records.filter(Boolean));
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function repoInfoForRoot(db: Db, root: string): { repo_id: string | null; name: string | null } {
  const realRoot = path.resolve(root);
  const canonical = resolveCanonicalArtifactRepoForRoot(db, realRoot);
  if (canonical.ok) return { repo_id: canonical.project_key, name: canonical.checkout_name };
  return { repo_id: null, name: null };
}

function mediaTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".htm":
    case ".html":
      return "text/html";
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".toml":
      return "application/toml";
    case ".tsv":
      return "text/tab-separated-values";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "application/octet-stream";
  }
}

function classifyLocalArtifactPath(db: Db, filePath: string): ArtifactGitState {
  const expanded = path.resolve(expandHomePath(filePath));
  const resolved = fs.existsSync(expanded) ? fs.realpathSync(expanded) : expanded;
  const dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
  const root = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return {
      inside_worktree: false,
      repo_root: null,
      repo_id: null,
      relative_path: null,
      commit: null,
      branch: null,
      tracked: false,
      ignored: false,
      staged: false,
      dirty: false,
      status: null,
    };
  }

  const repoRoot = path.resolve(root);
  const relativePath = path.relative(repoRoot, resolved).split(path.sep).join("/");
  const commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const branch = runGit(repoRoot, ["branch", "--show-current"]);
  const tracked = runGit(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]) !== null;
  const ignored = runGit(repoRoot, ["check-ignore", "--quiet", "--", relativePath]) === "";
  const status = runGit(repoRoot, ["status", "--porcelain=v1", "--", relativePath]);
  const staged = Boolean(status && status.length >= 2 && status[0] !== " " && status[0] !== "?");
  const dirty = Boolean(status && status.length >= 2 && (status[1] !== " " || status.startsWith("??")));
  const repoInfo = repoInfoForRoot(db, repoRoot);

  return {
    inside_worktree: true,
    repo_root: repoRoot,
    repo_id: repoInfo.repo_id,
    relative_path: relativePath,
    commit,
    branch,
    tracked,
    ignored,
    staged,
    dirty,
    status: status || null,
  };
}

function recoverabilityForLocalPath(
  gitState: ArtifactGitState,
  input: LocalArtifactPathInput,
  custodyMode: ArtifactCustodyMode,
): { recoverability: ArtifactRecoverability; warnings: string[] } {
  const warnings: string[] = [];
  if (custodyMode === "copy" || custodyMode === "managed") {
    return { recoverability: "mandible_cas", warnings };
  }
  if (asRecoverability(input.recoverability, "local_only") === "regenerable" || input.regenerable_from) {
    return { recoverability: "regenerable", warnings };
  }
  if (!gitState.inside_worktree) {
    warnings.push("outside_repo");
    return { recoverability: "local_only", warnings };
  }
  if (gitState.tracked && !gitState.dirty && !gitState.staged && gitState.commit) {
    return { recoverability: "repo_commit", warnings };
  }
  if (gitState.tracked) {
    if (gitState.dirty) warnings.push("tracked_dirty");
    if (gitState.staged) warnings.push("tracked_staged");
    return { recoverability: "repo_worktree", warnings };
  }
  warnings.push(gitState.ignored ? "ignored_local_only" : "untracked_local_only");
  return { recoverability: "local_only", warnings };
}

export type LocalPathSymlinkClass =
  | "none"
  | "prefix_only"
  | "same_repo_durable"
  | "cross_repo"
  | "outside_repo";

export interface LocalPathDecision {
  // The user-supplied path, lexically absolute (symlinks NOT resolved).
  input_path: string;
  // The filesystem realpath (symlinks resolved): where the bytes physically live.
  resolved_path: string;
  // The URI Mandible chose to store and later materialize from.
  stored_uri: string;
  // Whether the input path differed from its realpath (a symlink was followed).
  symlink_resolved: boolean;
  // How the resolved symlink relates to the input path's apparent location.
  symlink_class: LocalPathSymlinkClass;
  // True when the symlink moved the bytes to a different worktree of the SAME
  // repo (e.g. a feature worktree's `_artifacts` symlink to the persistent
  // repo-root `_artifacts`), so the stored realpath survives worktree deletion.
  worktree_substitution: boolean;
  // Warning codes contributed by symlink classification.
  decision_warnings: string[];
  // Human-readable explanation of why the stored URI was chosen.
  reason: string;
}

function gitToplevelAbs(dir: string): string | null {
  const out = runGit(dir, ["rev-parse", "--show-toplevel"]);
  return out ? path.resolve(out) : null;
}

function gitCommonDirAbs(dir: string): string | null {
  const out = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return out ? path.resolve(out) : null;
}

function safeRealpathSync(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// Find the input path's apparent worktree directory: the first ancestor that is
// not itself a symlink. Walking up past the leaf `_artifacts`-style directory
// symlink lands on the worktree the user actually wrote through (which git still
// reports as a linked worktree even when it is nested under the main repo), and
// stopping at the first real directory ignores benign prefix symlinks such as
// macOS /tmp -> /private/tmp.
function lexicalWorktreeDir(lexicalPath: string): string | null {
  let dir = path.dirname(path.resolve(lexicalPath));
  for (let i = 0; i < 64; i += 1) {
    let isLink = false;
    try {
      isLink = fs.lstatSync(dir).isSymbolicLink();
    } catch {
      return dir;
    }
    if (!isLink) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Classify the relationship between a user-supplied local path and its realpath
// so the durable-path planner can pick a non-disposable stored URI and explain
// the decision (issue 2f9c3c3).
function classifyLocalSymlink(
  lexicalAbs: string,
  resolvedAbs: string,
  gitState: ArtifactGitState,
): Omit<LocalPathDecision, "stored_uri"> {
  const symlinkResolved = lexicalAbs !== resolvedAbs;
  if (!symlinkResolved) {
    return {
      input_path: lexicalAbs,
      resolved_path: resolvedAbs,
      symlink_resolved: false,
      symlink_class: "none",
      worktree_substitution: false,
      decision_warnings: [],
      reason: "input path is already a realpath; stored as-is",
    };
  }
  if (!gitState.inside_worktree) {
    return {
      input_path: lexicalAbs,
      resolved_path: resolvedAbs,
      symlink_resolved: true,
      symlink_class: "outside_repo",
      worktree_substitution: false,
      decision_warnings: ["outside_repo_symlink"],
      reason:
        "input traverses a symlink whose target is outside any git repo; link custody is non-durable, use --copy/--managed",
    };
  }
  const realRoot = gitState.repo_root ? path.resolve(gitState.repo_root) : null;
  const realCommon = gitCommonDirAbs(path.dirname(resolvedAbs));
  const lexDir = lexicalWorktreeDir(lexicalAbs);
  const lexRoot = lexDir ? gitToplevelAbs(lexDir) : null;
  const lexCommon = lexDir ? gitCommonDirAbs(lexDir) : null;
  if (lexCommon && realCommon && lexCommon !== realCommon) {
    return {
      input_path: lexicalAbs,
      resolved_path: resolvedAbs,
      symlink_resolved: true,
      symlink_class: "cross_repo",
      worktree_substitution: true,
      decision_warnings: ["cross_repo_symlink"],
      reason:
        "input traverses a symlink crossing into a different git repository; stored the cross-repo realpath",
    };
  }
  if (lexRoot && realRoot && lexRoot !== realRoot) {
    return {
      input_path: lexicalAbs,
      resolved_path: resolvedAbs,
      symlink_resolved: true,
      symlink_class: "same_repo_durable",
      worktree_substitution: true,
      decision_warnings: ["symlink_resolved_to_durable_target"],
      reason:
        "input traverses a same-repo worktree symlink; stored the persistent realpath so it survives feature-worktree deletion",
    };
  }
  return {
    input_path: lexicalAbs,
    resolved_path: resolvedAbs,
    symlink_resolved: true,
    symlink_class: "prefix_only",
    worktree_substitution: false,
    decision_warnings: [],
    reason: "input differs from its realpath only by a path-prefix symlink; stored the realpath",
  };
}

export interface LocalArtifactPlan {
  ok: true;
  input_path: string;
  resolved_path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  filename: string;
  logical_name: string;
  custody_mode: ArtifactCustodyMode;
  recoverability: ArtifactRecoverability;
  uri: string;
  canonical_ref: string;
  repo_locator: JsonRecord;
  git_state: ArtifactGitState;
  warnings: string[];
  path_decision: LocalPathDecision;
}

// Compute the cheap (no-bytes) classification + durable URI selection shared by
// registration and the read-only plan endpoint. Both registration and the
// /api/artifacts/plan dry run flow through this so the backend stays the single
// source of truth for which path gets stored (issue 2f9c3c3).
function computeLocalArtifactPlanCore(
  db: Db,
  input: LocalArtifactPathInput,
): {
  lexicalPath: string;
  resolvedPath: string;
  gitState: ArtifactGitState;
  recoverability: ArtifactRecoverability;
  warnings: string[];
  repoLocator: JsonRecord;
  uri: string;
  decision: LocalPathDecision;
  requestedCustody: ArtifactCustodyMode;
} {
  const lexicalPath = path.resolve(expandHomePath(input.path));
  const resolvedPath = safeRealpathSync(lexicalPath);
  const gitState = classifyLocalArtifactPath(db, lexicalPath);
  const requestedCustody = asCustodyMode(input.custody_mode, "link");
  let { recoverability, warnings } = recoverabilityForLocalPath(gitState, input, requestedCustody);
  if (gitState.inside_worktree && !gitState.repo_id && recoverability.startsWith("repo_")) {
    recoverability = "local_only";
    warnings.push("unknown_repo_identity");
  }
  if (recoverability === "repo_worktree" && !input.allow_dirty_link && requestedCustody === "link") {
    warnings.push("dirty_link_requires_override_for_issue_evidence");
  }
  if (recoverability === "local_only" && !input.allow_local_only && requestedCustody === "link") {
    warnings.push("local_only_link_requires_override_for_issue_evidence");
  }
  const decisionBase = classifyLocalSymlink(lexicalPath, resolvedPath, gitState);
  for (const code of decisionBase.decision_warnings) {
    if (!warnings.includes(code)) warnings.push(code);
  }
  const repoLocator: JsonRecord = gitState.inside_worktree && gitState.repo_id && gitState.relative_path
    ? {
        repo_id: gitState.repo_id,
        ref: recoverability === "repo_commit" ? gitState.commit : gitState.branch,
        commit: gitState.commit,
        branch: gitState.branch,
        path: gitState.relative_path,
        root: gitState.repo_root,
      }
    : {};
  const repoUri = repoLocatorUri(repoLocator);
  // For commit-pinned recoverability the durable identity is the repo:// locator.
  // Otherwise store the realpath (never the possibly-disposable lexical input)
  // so materialization survives feature-worktree deletion.
  const uri = recoverability === "repo_commit" && repoUri ? repoUri : `file://${resolvedPath}`;
  const decision: LocalPathDecision = { ...decisionBase, stored_uri: uri };
  return {
    lexicalPath,
    resolvedPath,
    gitState,
    recoverability,
    warnings,
    repoLocator,
    uri,
    decision,
    requestedCustody,
  };
}

// Read-only classifier: report exactly what registration would store for a path
// without mutating the ledger. Backs POST /api/artifacts/plan so CLI dry runs
// and SDK callers can defer to the authoritative backend planner.
export function planLocalArtifactPath(db: Db, input: LocalArtifactPathInput): LocalArtifactPlan {
  if (!input.path || typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const lexicalForStat = path.resolve(expandHomePath(input.path));
  const stat = fs.statSync(lexicalForStat);
  if (!stat.isFile()) {
    throw new Error("artifact path must point to a regular file");
  }
  const core = computeLocalArtifactPlanCore(db, input);
  const hash = hashBuffer(fs.readFileSync(core.resolvedPath));
  const canonicalRef = core.recoverability === "repo_commit" && core.uri.startsWith("repo://")
    ? core.uri
    : `artifact-blob:${hash}`;
  return {
    ok: true,
    input_path: core.lexicalPath,
    resolved_path: core.resolvedPath,
    sha256: hash,
    size_bytes: stat.size,
    media_type: input.media_type ?? mediaTypeForPath(core.resolvedPath),
    filename: input.filename ?? path.basename(core.resolvedPath),
    logical_name: input.logical_name ?? core.gitState.relative_path ?? path.basename(core.resolvedPath),
    custody_mode: core.requestedCustody,
    recoverability: core.recoverability,
    uri: core.uri,
    canonical_ref: canonicalRef,
    repo_locator: core.repoLocator,
    git_state: core.gitState,
    warnings: core.warnings,
    path_decision: core.decision,
  };
}

export function registerLocalArtifactPath(
  db: Db,
  input: LocalArtifactPathInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): LocalArtifactPathRegistration {
  if (!input.path || typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const absolutePath = path.resolve(expandHomePath(input.path));
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error("artifact path must point to a regular file");
  }
  const {
    resolvedPath,
    gitState,
    recoverability,
    warnings,
    repoLocator,
    uri,
    decision,
    requestedCustody,
  } = computeLocalArtifactPlanCore(db, input);

  const needsBytes = requestedCustody === "copy" || requestedCustody === "managed";
  // Read bytes through the realpath so a deleted worktree symlink can never make
  // the read race the URI we store.
  const fileBuffer = fs.readFileSync(resolvedPath);
  const hash = hashBuffer(fileBuffer);
  const metadata = mergeJsonRecords(input.metadata, {
    filename: input.filename ?? path.basename(resolvedPath),
    logical_name: input.logical_name ?? gitState.relative_path ?? path.basename(resolvedPath),
    recoverability,
    git_state: gitState,
    warnings,
    // The durable materialization path (realpath); never the disposable input.
    source_path: resolvedPath,
    input_path: decision.input_path,
    path_decision: decision,
  });
  const reference = mergeJsonRecords(input.reference, {
    owner_system: recoverability.startsWith("repo_") ? "repo" : "local",
    recoverability,
    git_state: gitState,
    path_decision: decision,
    regenerable_from: input.regenerable_from,
  });
  const artifact = ingestArtifact(db, {
    sha256: hash,
    uri,
    role: input.role,
    media_type: input.media_type ?? mediaTypeForPath(resolvedPath),
    filename: input.filename ?? path.basename(resolvedPath),
    logical_name: input.logical_name ?? gitState.relative_path ?? path.basename(resolvedPath),
    size_bytes: stat.size,
    custody_mode: requestedCustody,
    home_repo_id: gitState.repo_id ?? undefined,
    repo_locator: repoLocator,
    availability: "present",
    retention: { recoverability },
    reference,
    metadata,
    pinned: input.pinned,
    ...(needsBytes ? { content_buffer: fileBuffer } : {}),
  }, now, artifactRoot);

  if (input.issue) {
    resolveAndLinkArtifact(db, {
      artifact_ref: artifact.id,
      entity_type: "issue",
      entity_id: input.issue,
      issue_project: input.issue_project,
      link_type: input.link_type ?? "references",
      role: input.link_role ?? input.role,
      repo_id: gitState.repo_id ?? undefined,
      source: "local_artifact_path",
      metadata: { warnings, recoverability, source_path: resolvedPath, path_decision: decision },
    }, now);
  }

  return { artifact: getArtifact(db, artifact.id) as ArtifactRecord, git_state: gitState, recoverability, warnings };
}

function resolveIssueEntity(
  db: Db,
  rawIssueRef: string,
  projectRef?: string,
): { entity_id: string; metadata: JsonRecord } {
  const split = splitProviderIssueRef(rawIssueRef);
  const projectId = projectIdForRef(db, projectRef ?? split.projectRef);
  const matches = issueMatches(db, split.issueRef, projectId);
  if (matches.length === 0) {
    throw new Error(`issue ref not found: ${rawIssueRef}`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous issue ref ${rawIssueRef}: ${matches.join(", ")}`);
  }
  return {
    entity_id: matches[0],
    metadata: {
      issue_ref: rawIssueRef,
      issue_project: projectRef ?? split.projectRef ?? null,
      ledger_issue_id: matches[0],
      resolution_status: "resolved",
    },
  };
}

// Series candidates for a LIVING link. A series/version ref resolves to exactly
// one series (`resolution.series`). For a content/hash ref the resolver carries
// no series, so fall back to the series that contain the resolved artifact
// version: a unique hit is usable, while 0 or >1 is ambiguous. This never
// touches the resolver core — it is a link-write-time lookup only.
function livingSeriesCandidates(db: Db, resolution: ArtifactResolveResult): ArtifactSeriesRecord[] {
  if (resolution.series) return [resolution.series];
  if (!resolution.artifact || !artifactVersioningTablesExist(db)) return [];
  const rows = db.prepare(
    `SELECT DISTINCT series_id FROM artifact_versions WHERE artifact_id = ?`,
  ).all(resolution.artifact.id) as Array<{ series_id: unknown }>;
  const series: ArtifactSeriesRecord[] = [];
  for (const row of rows) {
    const found = getArtifactSeries(db, String(row.series_id));
    if (found) series.push(found);
  }
  return series;
}

export function resolveAndLinkArtifact(
  db: Db,
  input: ArtifactResolveAndLinkInput,
  now = Date.now(),
): ArtifactResolveAndLinkResult {
  const ref = asString(input.ref) ?? asString(input.artifact_ref) ?? asString(input.artifact_id);
  if (!ref) throw new Error("artifact ref is required");
  const resolution = resolveArtifactRef(db, ref, now);
  if (resolution.status === "ambiguous") {
    throw new Error(`ambiguous artifact ref: ${ref}`);
  }
  if (!resolution.artifact) {
    throw new Error(`artifact ref did not resolve: ${ref}`);
  }

  const entityType = asString(input.entity_type) ?? (asString(input.issue) ? "issue" : undefined);
  const rawEntityId = asString(input.entity_id) ?? asString(input.issue);
  if (!entityType || !rawEntityId) {
    throw new Error("entity_type and entity_id are required");
  }
  const linkType = asString(input.link_type) ?? "references";
  const linkKind: "pinned" | "living" = asString(input.link_kind) === "living" ? "living" : "pinned";

  // LIVING link gating. Resolve the target series and enforce the evidence rule
  // in the BACKEND so every write path (route, CLI, in-process) rejects the same
  // way — the route also pre-validates this for a clean HTTP-edge contract.
  let seriesId: string | undefined;
  let seriesRef: string | undefined;
  if (linkKind === "living") {
    if (entityType === "issue" && linkType === "evidence") {
      throw new Error("evidence_links_must_be_pinned");
    }
    const candidates = livingSeriesCandidates(db, resolution);
    if (candidates.length !== 1) {
      throw new Error("living_link_requires_series");
    }
    seriesId = candidates[0].id;
    // `series_ref` records the author-facing ref exactly as supplied; the stored
    // artifact_id is the latest-at-creation fallback (resolution.artifact.id).
    seriesRef = ref;
  }

  const issueResolution = entityType === "issue"
    ? resolveIssueEntity(db, rawEntityId, asString(input.issue_project) ?? asString(input.repo_id))
    : null;
  const link = registerArtifactLink(db, resolution.artifact.id, {
    entity_type: entityType,
    entity_id: issueResolution?.entity_id ?? rawEntityId,
    link_type: linkType,
    role: asString(input.role),
    repo_id: asString(input.repo_id),
    provider_id: asString(input.provider_id),
    source: asString(input.source) ?? "artifact_link",
    link_kind: linkKind,
    series_id: seriesId,
    series_ref: seriesRef,
    metadata: mergeJsonRecords(input.metadata, issueResolution?.metadata, {
      artifact_ref: ref,
      normalized_ref: resolution.normalized_ref,
    }),
  }, now);
  return { resolution, link };
}

function bufferFromSnapshotInput(input: ArtifactSnapshotInput): Buffer {
  if (Buffer.isBuffer(input.content_buffer)) {
    return input.content_buffer;
  }
  if (typeof input.path === "string" && input.path.trim()) {
    return fs.readFileSync(path.resolve(expandHomePath(input.path)));
  }
  if (typeof input.content_path === "string" && input.content_path.trim()) {
    return fs.readFileSync(path.resolve(expandHomePath(input.content_path)));
  }
  if (typeof input.content_base64 === "string") return Buffer.from(input.content_base64, "base64");
  if (typeof input.content === "string") return Buffer.from(input.content, "utf8");
  if ("json" in input) return Buffer.from(stableJsonStringify(input.json), "utf8");
  throw new Error("snapshot path, content, content_base64, content_path, or json is required");
}

export function snapshotArtifactBytes(
  db: Db,
  input: ArtifactSnapshotInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ArtifactRecord {
  const bytes = bufferFromSnapshotInput(input);
  const hash = hashBuffer(bytes);
  const ref = asString(input.ref) ?? asString(input.artifact_ref);
  if (ref) {
    const existing = resolveArtifactRef(db, ref, now).artifact;
    if (existing?.algorithm === "sha256" && existing.content_hash.toLowerCase() !== hash) {
      throw new Error("snapshot bytes do not match registered sha256");
    }
  }

  const custodyMode = asCustodyMode(input.custody_mode, "copy");
  if (custodyMode !== "copy" && custodyMode !== "managed") {
    throw new Error("snapshot custody_mode must be copy or managed");
  }
  const filePath = artifactPathForHash(hash, artifactRoot);
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, bytes);
  }
  const artifact = ingestArtifact(db, {
    sha256: hash,
    // Hand the already-read Buffer straight through instead of re-encoding to
    // base64 and decoding again in ingestArtifact (issue 833e972: cut the
    // snapshot -> ingest memory amplification). The CAS file is already written
    // above, so ingestArtifact's existsSync short-circuit avoids a second write.
    content_buffer: bytes,
    custody_mode: custodyMode,
    availability: "present",
    media_type: input.media_type,
    role: input.role,
    filename: input.filename ?? (input.path ? path.basename(input.path) : undefined),
    logical_name: input.logical_name,
    metadata: mergeJsonRecords(input.metadata, {
      recoverability: "mandible_cas",
      snapshot_source_ref: ref ?? null,
      snapshot_source_path: input.path ? path.resolve(expandHomePath(input.path)) : null,
    }),
    reference: mergeJsonRecords(input.reference, {
      recoverability: "mandible_cas",
      snapshot_source_ref: ref ?? null,
      uri: `file://${filePath}`,
    }),
  }, now, artifactRoot);

  const stored = getArtifact(db, artifact.id) as ArtifactRecord;
  return stored;
}

function linkBundleMember(
  db: Db,
  bundleId: string,
  artifact: ArtifactRecord,
  member: ArtifactBundleMemberInput,
  order: number,
  now: number,
): ArtifactBundleMemberRecord {
  const link = registerArtifactLink(db, artifact.id, {
    entity_type: "artifact_bundle",
    entity_id: bundleId,
    link_type: "bundle_member",
    role: asString(member.role) ?? artifact.role ?? undefined,
    repo_id: artifact.home_repo_id ?? undefined,
    provider_id: artifact.provider_id ?? undefined,
    source: "artifact_bundle",
    metadata: mergeJsonRecords(member.metadata, {
      bundle_id: bundleId,
      order,
      // Freeze a durable ref (resolved artifact URI), not the possibly-disposable
      // input path. The original path is kept separately for provenance.
      member_ref: member.ref ?? member.artifact_ref ?? artifact.uri ?? artifact.id,
      ...(member.path ? { member_input_path: member.path } : {}),
    }),
  }, now);
  upsertGraphEdge(db, {
    id: `bundle_contains:${bundleId}:${artifact.id}:${order}`,
    source_id: bundleId,
    target_id: artifact.id,
    edge_type: "bundle_contains",
    edge_class: "provenance",
    provenance: "artifact_bundle",
    metadata: { order, role: asString(member.role) ?? artifact.role ?? null },
    observed_at: now,
    source: "artifact_bundle",
  });
  return {
    artifact,
    link: link as ArtifactLinkRecord,
    order,
    role: link?.role ?? null,
  };
}

function resolveBundleMemberArtifact(
  db: Db,
  member: ArtifactBundleMemberInput,
  now: number,
): ArtifactRecord {
  if (asString(member.path)) {
    return registerLocalArtifactPath(db, {
      path: member.path as string,
      role: member.role,
      custody_mode: member.custody_mode,
      allow_local_only: member.allow_local_only,
      allow_dirty_link: member.allow_dirty_link,
      metadata: member.metadata,
    }, now).artifact;
  }
  const ref = asString(member.ref) ?? asString(member.artifact_ref);
  if (!ref) throw new Error("bundle member ref or path is required");
  const resolution = resolveArtifactRef(db, ref, now);
  if (resolution.status === "ambiguous") throw new Error(`ambiguous artifact ref: ${ref}`);
  if (!resolution.artifact) throw new Error(`artifact ref did not resolve: ${ref}`);
  return resolution.artifact;
}

export function createArtifactBundle(
  db: Db,
  input: ArtifactBundleInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ArtifactBundleRecord {
  const name = asString(input.name);
  if (!name) throw new Error("bundle name is required");
  const memberArtifacts = input.members.map((member) => resolveBundleMemberArtifact(db, member, now));
  const manifest = {
    schema_version: "mandible.artifact_bundle.v1",
    name,
    role: input.role ?? "artifact_bundle",
    created_at: new Date(now).toISOString(),
    members: memberArtifacts.map((artifact, index) => ({
      artifact_id: artifact.id,
      // Store the normalized, durable member ref. When a member was added by
      // path, freeze the resolved artifact URI (a worktree `_artifacts` symlink
      // becomes its persistent realpath) rather than the disposable input path.
      ref: input.members[index].ref
        ?? input.members[index].artifact_ref
        ?? artifact.uri
        ?? `artifact-blob:${artifact.content_hash}`,
      ...(input.members[index].path ? { input_path: input.members[index].path } : {}),
      role: input.members[index].role ?? artifact.role ?? null,
      order: index,
      recoverability: artifact.metadata.recoverability ?? artifact.reference.recoverability ?? null,
    })),
  };
  const bundle = ingestArtifact(db, {
    role: input.role ?? "artifact_bundle",
    media_type: "application/vnd.mandible.artifact-bundle+json",
    json: manifest,
    logical_name: name,
    metadata: mergeJsonRecords(input.metadata, {
      title: name,
      bundle: true,
      bundle_name: name,
      bundle_member_count: memberArtifacts.length,
      entity_type: "artifact_bundle",
    }),
    reference: {
      identity_kind: "artifact_bundle",
      bundle_name: name,
      recoverability: "mandible_cas",
    },
  }, now, artifactRoot);

  upsertGraphEntity(db, {
    id: bundle.id,
    entity_type: "artifact_bundle",
    external_id: bundle.content_hash,
    title: name,
    status: "present",
    summary: { role: bundle.role, member_count: memberArtifacts.length },
    detail: { artifact_id: bundle.id, manifest },
    visual: { icon: "artifact", shape: "folder" },
    created_at: now,
    updated_at: now,
    observed_at: now,
    source: "artifact_bundle",
  });

  const members = memberArtifacts.map((artifact, index) =>
    linkBundleMember(db, bundle.id, artifact, input.members[index], index, now)
  );
  if (input.issue) {
    resolveAndLinkArtifact(db, {
      artifact_ref: `artifact-blob:${bundle.content_hash}`,
      entity_type: "issue",
      entity_id: input.issue,
      issue_project: input.issue_project,
      link_type: "references",
      role: input.role ?? "artifact_bundle",
      source: "artifact_bundle",
      metadata: { bundle_name: name },
    }, now);
  }
  return { bundle: getArtifact(db, bundle.id) as ArtifactRecord, members };
}

export function addArtifactBundleMembers(
  db: Db,
  bundleRef: string,
  members: ArtifactBundleMemberInput[],
  now = Date.now(),
): ArtifactBundleRecord {
  const bundle = getArtifact(db, bundleRef) ?? resolveArtifactRef(db, bundleRef, now).artifact;
  if (!bundle) throw new Error(`bundle ref did not resolve: ${bundleRef}`);
  const existingMembers = listArtifactBundleMembers(db, bundle.id);
  const start = existingMembers.length;
  const added = members.map((member, index) =>
    linkBundleMember(db, bundle.id, resolveBundleMemberArtifact(db, member, now), member, start + index, now)
  );
  return { bundle: getArtifact(db, bundle.id) as ArtifactRecord, members: [...existingMembers, ...added] };
}

export function listArtifactBundleMembers(db: Db, bundleId: string): ArtifactBundleMemberRecord[] {
  if (!tableExists(db, "artifact_links")) return [];
  const rows = db.prepare(
    `SELECT id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_id, series_ref,
            created_at, updated_at
       FROM artifact_links
      WHERE entity_type = 'artifact_bundle'
        AND entity_id = ?
        AND link_type = 'bundle_member'
      ORDER BY CAST(json_extract(metadata_json, '$.order') AS INTEGER), artifact_id`,
  ).all(bundleId) as Array<Record<string, unknown>>;
  return rows.map((row, index) => {
    const link = artifactLinkFromRow(row);
    return {
      artifact: getArtifact(db, link.artifact_id) as ArtifactRecord,
      link,
      order: typeof link.metadata.order === "number" ? link.metadata.order : index,
      role: link.role,
    };
  }).filter((member) => Boolean(member.artifact));
}

export function getArtifactBundle(db: Db, bundleRef: string): ArtifactBundleRecord | null {
  const artifact = getArtifact(db, bundleRef) ?? resolveArtifactRef(db, bundleRef).artifact;
  if (!artifact) return null;
  return { bundle: artifact, members: listArtifactBundleMembers(db, artifact.id) };
}

function getArtifactAlias(db: Db, scheme: string, normalizedRef: string): ArtifactAliasRecord | null {
  const row = db.prepare(
    `SELECT id, artifact_id, scheme, alias, normalized_ref, locator_json,
            resolution_status, source, created_at, updated_at
       FROM artifact_aliases
      WHERE scheme = ? AND normalized_ref = ?`
  ).get(scheme, normalizedRef) as Record<string, unknown> | undefined;
  return row ? artifactAliasFromRow(row) : null;
}

function getArtifactLink(db: Db, id: string): ArtifactLinkRecord | null {
  const row = db.prepare(
    `SELECT id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_id, series_ref,
            created_at, updated_at
       FROM artifact_links
      WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? artifactLinkFromRow(row) : null;
}

function materializeReferenceArtifact(
  db: Db,
  ref: string,
  now = Date.now(),
): { artifact: ArtifactRecord; alias: ArtifactAliasRecord } {
  const normalized = normalizeRef(ref, { db, validateRepo: true });
  if (normalized.invalidReason) {
    throw new Error(`invalid repo artifact ref: ${normalized.invalidReason}`);
  }
  const id = referenceArtifactId(normalized.normalizedRef);
  const identityHash = hashString(normalized.normalizedRef);
  const repoId = asString(normalized.locator.repo_id) ?? null;
  const custodyMode: ArtifactCustodyMode = normalized.scheme === "repo" ? "link" : "external";
  const availability: ArtifactAvailability = normalized.scheme === "repo" ? "unchecked" : "remote_only";
  const role = normalized.scheme === "repo" ? "repo_artifact" : "external_reference";
  const metadata = {
    title: normalized.normalizedRef,
    source_ref: ref,
    normalized_ref: normalized.normalizedRef,
    scheme: normalized.scheme,
    identity_kind: "reference",
    locator: normalized.locator,
  };
  const reference = {
    owner_system: normalized.scheme,
    identity_kind: "reference",
    normalized_ref: normalized.normalizedRef,
    locator: normalized.locator,
    content_identity: null,
  };
  const repoLocator = normalized.scheme === "repo" ? normalized.locator : {};

  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, pinned, custody_mode, home_repo_id,
      repo_locator_json, availability, retention_json, reference_json, created_at
    ) VALUES (
      @id, 'ref-sha256', @content_hash, @uri, @media_type, @role, 0,
      NULL, NULL, @metadata_json, 0, @custody_mode, @home_repo_id,
      @repo_locator_json, @availability, @retention_json, @reference_json, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      uri = excluded.uri,
      metadata_json = excluded.metadata_json,
      custody_mode = excluded.custody_mode,
      home_repo_id = COALESCE(excluded.home_repo_id, artifacts.home_repo_id),
      repo_locator_json = CASE
        WHEN excluded.repo_locator_json != '{}' THEN excluded.repo_locator_json
        ELSE artifacts.repo_locator_json
      END,
      availability = excluded.availability,
      reference_json = excluded.reference_json`
  ).run({
    id,
    content_hash: identityHash,
    uri: normalized.normalizedRef,
    media_type: null,
    role,
    metadata_json: jsonStringify(metadata),
    custody_mode: custodyMode,
    home_repo_id: repoId,
    repo_locator_json: jsonStringify(repoLocator),
    availability,
    retention_json: jsonStringify({ pinned: false }),
    reference_json: jsonStringify(reference),
    created_at: now,
  });

  upsertGraphEntity(db, {
    id,
    entity_type: "artifact",
    repo_id: repoId,
    external_id: normalized.normalizedRef,
    title: normalized.normalizedRef,
    status: availability,
    summary: {
      role,
      media_type: null,
      size_bytes: 0,
      custody_mode: custodyMode,
      home_repo_id: repoId,
      availability,
      scheme: normalized.scheme,
      identity_kind: "reference",
    },
    detail: {
      uri: normalized.normalizedRef,
      content_hash: null,
      metadata,
      artifact_id: id,
      custody: {
        mode: custodyMode,
        home_repo_id: repoId,
        repo_locator: repoLocator,
        availability,
        retention: { pinned: false },
        reference,
      },
    },
    visual: { icon: "artifact", shape: "document" },
    created_at: now,
    updated_at: now,
    observed_at: now,
    source: "artifact_references",
  });

  const alias = registerArtifactAlias(db, {
    artifactId: id,
    ref,
    locator: normalized.locator,
    source: "artifact_resolver",
    now,
  });
  return { artifact: getArtifact(db, id) as ArtifactRecord, alias };
}

export function registerProvider(db: Db, input: ProviderInput, now = Date.now()): ProviderRecord {
  const id = assertProviderId(input.id ?? input.provider_id);
  const displayName = input.display_name ?? input.name ?? id;
  const capabilities = input.capabilities ?? {};
  const actions = input.actions ?? actionsFromCapabilities(id, capabilities);
  db.prepare(
    `INSERT INTO providers (
      id, display_name, version, status, transport, endpoint,
      capabilities_json, actions_json, source, created_at, updated_at, last_seen_at
    ) VALUES (
      @id, @display_name, @version, @status, @transport, @endpoint,
      @capabilities_json, @actions_json, @source, @created_at, @updated_at, @last_seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      version = COALESCE(excluded.version, providers.version),
      status = excluded.status,
      transport = excluded.transport,
      endpoint = COALESCE(excluded.endpoint, providers.endpoint),
      capabilities_json = CASE
        WHEN excluded.capabilities_json = '{}' AND providers.capabilities_json != '{}'
          THEN providers.capabilities_json
        ELSE excluded.capabilities_json
      END,
      actions_json = CASE
        WHEN excluded.actions_json = '[]' AND providers.actions_json != '[]'
          THEN providers.actions_json
        ELSE excluded.actions_json
      END,
      source = excluded.source,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at`
  ).run({
    id,
    display_name: displayName,
    version: input.version ?? null,
    status: input.status ?? "active",
    transport: input.transport ?? "manifest",
    endpoint: input.endpoint ?? null,
    capabilities_json: jsonStringify(capabilities),
    actions_json: jsonStringify(actions),
    source: input.source ?? "local",
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });

  const storedProvider = getProvider(db, id) as ProviderRecord;
  upsertGraphEntity(db, {
    id: `provider:${id}`,
    entity_type: "provider",
    provider_id: id,
    external_id: id,
    title: displayName,
    status: input.status ?? "active",
    summary: storedProvider.capabilities,
    detail: {
      transport: storedProvider.transport,
      endpoint: storedProvider.endpoint,
      version: storedProvider.version,
    },
    actions: storedProvider.actions.length > 0 ? storedProvider.actions : [
      { id: "refresh-provider", label: "Refresh", kind: "ingest", target: `provider:${id}` },
    ],
    visual: { icon: "provider", shape: "hexagon" },
    created_at: now,
    updated_at: now,
    observed_at: now,
    source: "providers",
  });

  return storedProvider;
}

export function ingestArtifact(
  db: Db,
  input: ArtifactInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ArtifactRecord {
  const bytes = hasInlineArtifactContent(input) ? contentBuffer(input) : null;
  const declaredHash = hashFromArtifactRef(input);
  const hash = bytes ? hashBuffer(bytes) : declaredHash;
  if (!hash) {
    throw new Error("artifact content, content_base64, json, sha256, or artifact_id is required");
  }
  if (declaredHash && bytes && declaredHash !== hash) {
    throw new Error("artifact sha256 does not match supplied content");
  }
  const id = `artifact:sha256:${hash}`;
  const filePath = artifactPathForHash(hash, artifactRoot);
  let uri = input.uri ?? input.artifact_id ?? `artifact-blob:${hash}`;
  let sizeBytes = input.size_bytes ?? uriSizeBytes(uri) ?? 0;
  if (bytes) {
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, bytes);
    }
    uri = `file://${filePath}`;
    sizeBytes = bytes.byteLength;
  }
  const defaultCustody: ArtifactCustodyMode = bytes ? "managed" : (input.storage_backend === "external" ? "external" : "link");
  const custodyMode = asCustodyMode(input.custody_mode, defaultCustody);
  const availability = asAvailability(input.availability, bytes ? "present" : "unchecked");
  const repoLocator = input.repo_locator ?? asRecord(input.metadata?.repo_locator);
  const homeRepoId = input.home_repo_id ?? asString(input.metadata?.home_repo_id) ?? asString(input.metadata?.repo_id) ?? null;
  const retention = {
    ...(input.retention ?? {}),
    pinned: input.pinned !== false,
  };
  const reference = {
    ...(input.reference ?? {}),
    artifact_id: input.artifact_id,
    logical_name: input.logical_name,
    storage_backend: input.storage_backend,
    uri,
    content_identity: {
      algorithm: "sha256",
      hash,
      artifact_uri: id,
    },
  };
  const metadata = {
    ...(input.metadata ?? {}),
    filename: input.filename,
    logical_name: input.logical_name,
    artifact_id: input.artifact_id,
    storage_backend: input.storage_backend,
    custody_mode: custodyMode,
    availability,
  };
  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, pinned, custody_mode, home_repo_id,
      repo_locator_json, availability, retention_json, reference_json, created_at
    ) VALUES (
      @id, 'sha256', @content_hash, @uri, @media_type, @role, @size_bytes,
      @provider_id, @manifest_id, @metadata_json, @pinned, @custody_mode, @home_repo_id,
      @repo_locator_json, @availability, @retention_json, @reference_json, @created_at
    )
    ON CONFLICT(algorithm, content_hash) DO UPDATE SET
      media_type = COALESCE(excluded.media_type, artifacts.media_type),
      role = COALESCE(excluded.role, artifacts.role),
      provider_id = COALESCE(excluded.provider_id, artifacts.provider_id),
      manifest_id = COALESCE(excluded.manifest_id, artifacts.manifest_id),
      metadata_json = CASE
        WHEN artifacts.metadata_json = '{}' THEN excluded.metadata_json
        WHEN artifacts.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present'
         AND excluded.uri LIKE 'file://%'
          THEN excluded.metadata_json
        ELSE artifacts.metadata_json
      END,
      uri = CASE
        WHEN artifacts.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present'
         AND excluded.uri LIKE 'file://%' THEN excluded.uri
        ELSE COALESCE(artifacts.uri, excluded.uri)
      END,
      custody_mode = CASE
        WHEN artifacts.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present'
         AND excluded.uri LIKE 'file://%' THEN excluded.custody_mode
        ELSE artifacts.custody_mode
      END,
      home_repo_id = COALESCE(excluded.home_repo_id, artifacts.home_repo_id),
      repo_locator_json = CASE
        WHEN artifacts.repo_locator_json = '{}' THEN excluded.repo_locator_json
        ELSE artifacts.repo_locator_json
      END,
      availability = CASE
        WHEN artifacts.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present'
         AND excluded.uri LIKE 'file://%' THEN excluded.availability
        ELSE artifacts.availability
      END,
      retention_json = CASE
        WHEN artifacts.retention_json = '{}' THEN excluded.retention_json
        ELSE artifacts.retention_json
      END,
      reference_json = CASE
        WHEN artifacts.reference_json = '{}' THEN excluded.reference_json
        WHEN artifacts.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present'
         AND excluded.uri LIKE 'file://%'
          THEN excluded.reference_json
        ELSE artifacts.reference_json
      END,
      size_bytes = CASE
        WHEN artifacts.size_bytes = 0
          OR (excluded.availability = 'present' AND excluded.uri LIKE 'file://%') THEN excluded.size_bytes
        ELSE artifacts.size_bytes
      END,
      pinned = MAX(artifacts.pinned, excluded.pinned)`
  ).run({
    id,
    content_hash: hash,
    uri,
    media_type: input.media_type ?? ("json" in input ? "application/json" : "application/octet-stream"),
    role: input.role ?? null,
    size_bytes: sizeBytes,
    provider_id: input.provider_id ?? null,
    manifest_id: input.manifest_id ?? null,
    metadata_json: jsonStringify(metadata),
    pinned: input.pinned === false ? 0 : 1,
    custody_mode: custodyMode,
    home_repo_id: homeRepoId,
    repo_locator_json: jsonStringify(repoLocator),
    availability,
    retention_json: jsonStringify(retention),
    reference_json: jsonStringify(reference),
    created_at: now,
  });

  upsertGraphEntity(db, {
    id,
    entity_type: "artifact",
    provider_id: input.provider_id ?? null,
    external_id: hash,
    title: input.metadata?.title as string | undefined
      ?? input.logical_name
      ?? input.filename
      ?? input.role
      ?? hash.slice(0, 12),
    status: "available",
    summary: {
      role: input.role ?? null,
      media_type: input.media_type ?? null,
      size_bytes: sizeBytes,
      storage_backend: input.storage_backend ?? null,
      custody_mode: custodyMode,
      home_repo_id: homeRepoId,
      availability,
    },
    detail: {
      uri,
      content_hash: hash,
      metadata,
      artifact_id: input.artifact_id ?? null,
      custody: {
        mode: custodyMode,
        home_repo_id: homeRepoId,
        repo_locator: repoLocator,
        availability,
        retention,
        reference,
      },
    },
    visual: { icon: "artifact", shape: "document" },
    created_at: now,
    updated_at: now,
    observed_at: now,
    source: "artifacts",
  });

  if (artifactAliasTablesExist(db)) {
    registerArtifactAlias(db, {
      artifactId: id,
      ref: `artifact-blob:${hash}`,
      source: "artifact_identity",
      now,
    });
    if (input.artifact_id && input.artifact_id !== id && isRegisterableArtifactRef(input.artifact_id)) {
      registerArtifactAlias(db, {
        artifactId: id,
        ref: input.artifact_id,
        source: "artifact_input",
        now,
      });
    }
    if (uri && isRegisterableArtifactRef(uri)) {
      registerArtifactAlias(db, {
        artifactId: id,
        ref: uri,
        source: "artifact_input",
        now,
      });
    }
    const repoUri = repoLocatorUri(repoLocator);
    if (repoUri) {
      registerArtifactAlias(db, {
        artifactId: id,
        ref: repoUri,
        locator: repoLocator,
        source: "repo_locator",
        now,
      });
    }
    if (input.manifest_id) {
      registerArtifactLink(db, id, {
        entity_type: "provider_manifest",
        entity_id: input.manifest_id,
        link_type: "manifest_references_artifact",
        role: input.role,
        repo_id: homeRepoId ?? undefined,
        provider_id: input.provider_id,
        source: "provider_manifest",
        metadata: { artifact_ref: input.artifact_id ?? null },
      }, now);
    }
    const links = [input.link, ...(input.links ?? [])].filter((link): link is ArtifactLinkInput => Boolean(link));
    for (const link of links) {
      registerArtifactLink(db, id, {
        ...link,
        repo_id: link.repo_id ?? homeRepoId ?? undefined,
        provider_id: link.provider_id ?? input.provider_id,
      }, now);
    }
  }

  const stored = getArtifact(db, id) as ArtifactRecord;
  mirrorLegacyArtifactBlob(db, stored, now);
  return stored;
}

export function ingestProviderManifest(
  db: Db,
  input: ManifestInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ProviderManifestRecord {
  const rawManifest = input.manifest ?? asRecord(input);
  const manifest = asRecord(rawManifest);
  const providerId = inferProviderId(input, manifest);
  const provider = registerProvider(db, providerInputFromManifest(providerId, manifest, input), now);

  const artifact = ingestArtifact(db, {
    provider_id: provider.id,
    role: "provider_manifest",
    media_type: "application/json",
    json: manifest,
    metadata: {
      title: `${provider.display_name} manifest`,
      manifest_type: input.manifest_type ?? (manifest.manifest_type as string | undefined) ?? "provider_manifest",
    },
  }, now, artifactRoot);

  const manifestType = input.manifest_type
    ?? (manifest.manifest_type as string | undefined)
    ?? (manifest.kind as string | undefined)
    ?? (isNativeProviderManifest(manifest) ? "provider_manifest" : "provider_manifest");
  const manifestId = `provider_manifest:${provider.id}:${artifact.content_hash.slice(0, 16)}`;

  const ingest = db.transaction(() => {
    db.prepare(
      `INSERT INTO provider_manifests (
        id, provider_id, manifest_type, version, content_hash, artifact_id,
        source, content_json, created_at
      ) VALUES (
        @id, @provider_id, @manifest_type, @version, @content_hash, @artifact_id,
        @source, @content_json, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        artifact_id = excluded.artifact_id,
        source = excluded.source,
        content_json = excluded.content_json`
    ).run({
      id: manifestId,
      provider_id: provider.id,
      manifest_type: manifestType,
      version: input.version ?? (manifest.version as string | undefined) ?? provider.version,
      content_hash: artifact.content_hash,
      artifact_id: artifact.id,
      source: input.source ?? "ingest",
      content_json: stableJsonStringify(manifest),
      created_at: now,
    });

    upsertGraphEntity(db, {
      id: manifestId,
      entity_type: "provider_manifest",
      provider_id: provider.id,
      external_id: artifact.content_hash,
      title: `${provider.display_name} manifest`,
      status: "ingested",
      summary: { manifest_type: manifestType, version: input.version ?? manifest.version ?? provider.version },
      detail: { artifact_id: artifact.id, content_hash: artifact.content_hash },
      actions: [
        { id: "open-manifest-artifact", label: "Open Artifact", kind: "preview", target: artifact.id },
        { id: "validate-manifest", label: "Validate", kind: "validate", target: manifestId },
      ],
      visual: { icon: "manifest", shape: "document" },
      created_at: now,
      updated_at: now,
      observed_at: now,
      source: "provider_manifests",
    });

    upsertGraphEdge(db, {
      id: `provider_emitted_manifest:provider:${provider.id}:${manifestId}`,
      source_id: `provider:${provider.id}`,
      target_id: manifestId,
      edge_type: "provider_emitted_manifest",
      edge_class: "provenance",
      provenance: "provider_manifest",
      observed_at: now,
      source: "provider_manifests",
    });
    upsertGraphEdge(db, {
      id: `manifest_references_artifact:${manifestId}:${artifact.id}`,
      source_id: manifestId,
      target_id: artifact.id,
      edge_type: "manifest_references_artifact",
      edge_class: "provenance",
      provenance: "provider_manifest",
      observed_at: now,
      source: "provider_manifests",
    });
    if (artifactAliasTablesExist(db)) {
      registerArtifactLink(db, artifact.id, {
        entity_type: "provider_manifest",
        entity_id: manifestId,
        link_type: "manifest_content",
        role: "provider_manifest",
        provider_id: provider.id,
        source: "provider_manifests",
        metadata: { content_hash: artifact.content_hash },
      }, now);
    }

    const idMap = new Map<string, string>();
    idMap.set("provider", `provider:${provider.id}`);
    idMap.set(provider.id, `provider:${provider.id}`);
    idMap.set("manifest", manifestId);
    idMap.set(manifestId, manifestId);
    idMap.set(artifact.id, artifact.id);
    const nativeSubjectId = upsertNativeManifestSubject(db, {
      providerId: provider.id,
      manifest,
      manifestId,
      manifestArtifactId: artifact.id,
      now,
      source: "provider_manifest",
      idMap,
    });

    const artifacts = asArray<ManifestEntityInput>(manifest.artifacts);
    for (const item of artifacts) {
      if (isNativeArtifactRef(asRecord(item))) {
        const ref = asRecord(item);
        const artifactRecord = ingestArtifact(db, {
          provider_id: provider.id,
          manifest_id: manifestId,
          artifact_id: asString(ref.artifact_id),
          sha256: asString(ref.sha256),
          uri: asString(ref.uri),
          role: asString(ref.role),
          media_type: asString(ref.media_type),
          size_bytes: typeof ref.size_bytes === "number" ? ref.size_bytes : undefined,
          storage_backend: asString(ref.storage_backend),
          logical_name: asString(ref.logical_name),
          custody_mode: asString(ref.custody_mode),
          home_repo_id: asString(ref.home_repo_id),
          repo_locator: asRecord(ref.repo_locator),
          availability: asString(ref.availability),
          retention: asRecord(ref.retention),
          reference: {
            provider_manifest_id: manifestId,
            provider_artifact_ref: asString(ref.artifact_id) ?? asString(ref.logical_name),
            source_field: "artifacts",
          },
          metadata: asRecord(ref.metadata),
        }, now, artifactRoot);
        const refKeys = [
          asString(ref.artifact_id),
          asString(ref.sha256),
          asString(ref.logical_name),
          artifactRecord.id,
        ].filter((value): value is string => Boolean(value));
        for (const key of refKeys) idMap.set(key, artifactRecord.id);
        upsertGraphEdge(db, {
          id: `manifest_references_artifact:${manifestId}:${artifactRecord.id}`,
          source_id: manifestId,
          target_id: artifactRecord.id,
          edge_type: "manifest_references_artifact",
          edge_class: "provenance",
          provenance: "provider_manifest",
          metadata: { role: asString(ref.role) ?? null },
          observed_at: now,
          source: "provider_manifest",
        });
        if (nativeSubjectId) {
          upsertGraphEdge(db, {
            id: `produced:${nativeSubjectId}:${artifactRecord.id}`,
            source_id: nativeSubjectId,
            target_id: artifactRecord.id,
            edge_type: "produced",
            edge_class: "provenance",
            provenance: "provider_manifest",
            metadata: { role: asString(ref.role) ?? null },
            observed_at: now,
            source: "provider_manifest",
          });
          if (artifactAliasTablesExist(db)) {
            registerArtifactLink(db, artifactRecord.id, {
              entity_type: nativeSubjectType(manifest) ?? "provider_entity",
              entity_id: nativeSubjectId,
              link_type: "produced_by",
              role: asString(ref.role),
              repo_id: artifactRecord.home_repo_id ?? undefined,
              provider_id: provider.id,
              source: "provider_manifest",
              metadata: { manifest_id: manifestId },
            }, now);
          }
        }
        continue;
      }
      const externalId = item.id ?? item.external_id ?? item.title ?? item.label ?? `${item.type ?? "artifact"}-${idMap.size}`;
      const nodeId = item.id?.startsWith("artifact:") ? item.id : graphEntityId(provider.id, "artifact", externalId);
      idMap.set(externalId, nodeId);
      if (item.id) idMap.set(item.id, nodeId);
      upsertGraphEntity(db, {
        id: nodeId,
        entity_type: "artifact",
        provider_id: provider.id,
        external_id: externalId,
        title: item.title ?? item.label ?? externalId,
        status: item.status ?? "referenced",
        labels: item.labels ?? [],
        summary: item.summary ?? item.metrics ?? {},
        detail: item.detail ?? asRecord(item),
        actions: item.actions ?? defaultActionsForType("artifact", nodeId),
        visual: item.visual ?? { icon: "artifact", shape: "document" },
        created_at: msFromUnknown(item.created_at),
        updated_at: msFromUnknown(item.updated_at) ?? now,
        observed_at: now,
        source: "provider_manifest",
      });
      upsertGraphEdge(db, {
        id: `manifest_declares:${manifestId}:${nodeId}`,
        source_id: manifestId,
        target_id: nodeId,
        edge_type: "manifest_declares",
        edge_class: "provenance",
        provenance: "provider_manifest",
        observed_at: now,
        source: "provider_manifest",
      });
    }

    for (const { field, ref } of modelStoreRefs(manifest)) {
      const role = asString(ref.role) ?? field;
      const artifactRecord = ingestArtifact(db, {
        provider_id: provider.id,
        manifest_id: manifestId,
        artifact_id: asString(ref.artifact_id),
        sha256: asString(ref.sha256),
        uri: asString(ref.uri),
        role,
        media_type: asString(ref.media_type),
        size_bytes: typeof ref.size_bytes === "number" ? ref.size_bytes : undefined,
        storage_backend: asString(ref.storage_backend),
        logical_name: asString(ref.logical_name) ?? field,
        custody_mode: asString(ref.custody_mode),
        home_repo_id: asString(ref.home_repo_id),
        repo_locator: asRecord(ref.repo_locator),
        availability: asString(ref.availability),
        retention: asRecord(ref.retention),
        reference: {
          provider_manifest_id: manifestId,
          provider_artifact_ref: asString(ref.artifact_id) ?? asString(ref.logical_name) ?? field,
          source_field: field,
        },
        metadata: {
          ...asRecord(ref.metadata),
          store_field: field,
          array_roles: Array.isArray(ref.array_roles) ? ref.array_roles : asArray<string>(ref.roles),
        },
      }, now, artifactRoot);
      idMap.set(field, artifactRecord.id);
      if (asString(ref.artifact_id)) idMap.set(asString(ref.artifact_id)!, artifactRecord.id);
      if (asString(ref.sha256)) idMap.set(asString(ref.sha256)!, artifactRecord.id);
      upsertGraphEdge(db, {
        id: `manifest_references_artifact:${manifestId}:${artifactRecord.id}`,
        source_id: manifestId,
        target_id: artifactRecord.id,
        edge_type: "manifest_references_artifact",
        edge_class: "provenance",
        provenance: "provider_manifest",
        metadata: { role, store_field: field },
        observed_at: now,
        source: "provider_manifest",
      });
      if (nativeSubjectId) {
        upsertGraphEdge(db, {
          id: `model_references_store:${nativeSubjectId}:${artifactRecord.id}`,
          source_id: nativeSubjectId,
          target_id: artifactRecord.id,
          edge_type: "model_references_store",
          edge_class: "provenance",
          provenance: "provider_manifest",
          metadata: { role, store_field: field },
          observed_at: now,
          source: "provider_manifest",
        });
        if (artifactAliasTablesExist(db)) {
          registerArtifactLink(db, artifactRecord.id, {
            entity_type: nativeSubjectType(manifest) ?? "provider_entity",
            entity_id: nativeSubjectId,
            link_type: "referenced_by",
            role,
            repo_id: artifactRecord.home_repo_id ?? undefined,
            provider_id: provider.id,
            source: "provider_manifest",
            metadata: { manifest_id: manifestId, store_field: field },
          }, now);
        }
      }
    }

    const entities = asArray<ManifestEntityInput>(manifest.entities);
    for (const item of entities) {
      const type = normalizeIdentifier(item.type ?? "artifact");
      const externalId = item.id ?? item.external_id ?? item.title ?? item.label ?? `${type}-${idMap.size}`;
      const nodeId = graphEntityId(provider.id, type, externalId);
      idMap.set(externalId, nodeId);
      if (item.id) idMap.set(item.id, nodeId);
      upsertGraphEntity(db, {
        id: nodeId,
        entity_type: type,
        provider_id: provider.id,
        repo_id: item.repo_id ?? null,
        external_id: externalId,
        title: item.title ?? item.label ?? externalId,
        status: item.status ?? undefined,
        labels: item.labels ?? [],
        summary: item.summary ?? item.metrics ?? {},
        detail: item.detail ?? asRecord(item),
        actions: item.actions ?? defaultActionsForType(type, nodeId),
        visual: item.visual ?? {},
        created_at: msFromUnknown(item.created_at),
        updated_at: msFromUnknown(item.updated_at) ?? now,
        observed_at: now,
        source: "provider_manifest",
      });
      upsertGraphEdge(db, {
        id: `manifest_declares:${manifestId}:${nodeId}`,
        source_id: manifestId,
        target_id: nodeId,
        edge_type: "manifest_declares",
        edge_class: "provenance",
        provenance: "provider_manifest",
        observed_at: now,
        source: "provider_manifest",
      });
    }

    const edges = asArray<ManifestEdgeInput>(manifest.edges);
    for (const item of edges) {
      if (!item.source || !item.target) continue;
      const sourceId = idMap.get(item.source) ?? item.source;
      const targetId = idMap.get(item.target) ?? item.target;
      const edgeType = item.edge_type ?? item.type ?? "derived_from";
      upsertGraphEdge(db, {
        id: item.id ?? `${edgeType}:${sourceId}:${targetId}`,
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
        edge_class: item.edge_class ?? "provenance",
        provenance: item.provenance ?? "provider_manifest",
        confidence: item.confidence ?? "observed",
        metadata: item.metadata ?? {},
        created_at: msFromUnknown(item.created_at),
        observed_at: now,
        source: "provider_manifest",
      });
    }

    if (nativeSubjectId) {
      const subjectType = nativeSubjectType(manifest);
      for (const [field, fallbackKind] of SPEC_FIELD_KINDS) {
        const ref = asRecord(manifest[field]);
        if (Object.keys(ref).length === 0) continue;
        upsertNativeReferenceNode(db, {
          providerId: provider.id,
          ref,
          fallbackKind,
          sourceId: nativeSubjectId,
          manifestId,
          edgeType: subjectType === "model" ? "model_used_spec" : "run_used_spec",
          now,
          source: "provider_manifest",
          idMap,
        });
      }
      const provenance = asRecord(manifest.provenance);
      for (const parent of asArray<JsonRecord>(provenance.parents)) {
        upsertNativeReferenceNode(db, {
          providerId: provider.id,
          ref: asRecord(parent),
          fallbackKind: "ProviderManifest",
          sourceId: nativeSubjectId,
          manifestId,
          edgeType: "derived_from",
          now,
          source: "provider_manifest",
          idMap,
        });
      }
      for (const issueId of asArray<string>(provenance.issues)) {
        if (typeof issueId === "string" && issueId.trim()) {
          upsertNativeIssueRef(db, {
            providerId: provider.id,
            issueId: issueId.trim(),
            sourceId: nativeSubjectId,
            provenance,
            now,
            source: "provider_manifest",
          });
        }
      }
    }
  });

  ingest();
  return getProviderManifest(db, manifestId) as ProviderManifestRecord;
}

export function listProviders(db: Db): ProviderRecord[] {
  const rows = db.prepare(
    `SELECT id, display_name, version, status, transport, endpoint,
            capabilities_json, actions_json, source, created_at, updated_at, last_seen_at
       FROM providers
      ORDER BY display_name COLLATE NOCASE`
  ).all() as Array<Record<string, unknown>>;
  return rows.map(providerFromRow);
}

export function ingestProviderManifestFile(
  db: Db,
  filePath: string,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ProviderManifestRecord {
  const resolved = path.resolve(filePath);
  const manifest = JSON.parse(fs.readFileSync(resolved, "utf8")) as JsonRecord;
  return ingestProviderManifest(db, {
    manifest,
    source: `file:${resolved}`,
  }, now, artifactRoot);
}

export function getProvider(db: Db, id: string): ProviderRecord | null {
  const row = db.prepare(
    `SELECT id, display_name, version, status, transport, endpoint,
            capabilities_json, actions_json, source, created_at, updated_at, last_seen_at
       FROM providers WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? providerFromRow(row) : null;
}

export function getProviderCapabilities(db: Db, id: string): {
  provider: ProviderRecord;
  capabilities: Record<string, unknown>;
  actions: GraphAction[];
  schemas?: unknown;
  artifact_roles?: unknown;
  entry_points?: unknown;
} | null {
  const provider = getProvider(db, id);
  if (!provider) return null;
  return {
    provider,
    capabilities: provider.capabilities,
    actions: provider.actions,
    schemas: provider.capabilities.schemas,
    artifact_roles: provider.capabilities.artifact_roles,
    entry_points: provider.capabilities.entry_points,
  };
}

export function getProviderHealth(db: Db, id: string): {
  provider_id: string;
  status: string;
  checked_at: number | null;
  health: unknown;
} | null {
  const provider = getProvider(db, id);
  if (!provider) return null;
  return {
    provider_id: provider.id,
    status: provider.status,
    checked_at: provider.last_seen_at,
    health: provider.capabilities.health ?? { status: provider.status },
  };
}

export function getArtifact(db: Db, id: string): ArtifactRecord | null {
  const artifactHash = artifactHashFromRef(id);
  const lookupId = artifactHash ? `artifact:sha256:${artifactHash}` : id;
  const row = db.prepare(
    `SELECT id, algorithm, content_hash, uri, media_type, role, size_bytes,
            provider_id, manifest_id, metadata_json, pinned, custody_mode,
            home_repo_id, repo_locator_json, availability, retention_json,
            reference_json, created_at
       FROM artifacts WHERE id = ?`
  ).get(lookupId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const artifact = artifactFromRow(row);
  if (artifactAliasTablesExist(db)) {
    artifact.aliases = listArtifactAliases(db, artifact.id);
    artifact.links = listArtifactLinks(db, artifact.id);
  }
  return artifact;
}

export function listArtifacts(db: Db, options: ArtifactListOptions = {}): ArtifactRecord[] {
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const hasAliases = tableExists(db, "artifact_aliases");
  const hasLinks = tableExists(db, "artifact_links");

  const q = asString(options.q);
  const hashPrefix = asString(options.hashPrefix);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    bindings.q = like;
    where.push(`(
      a.id LIKE @q ESCAPE '\\'
      OR a.content_hash LIKE @q ESCAPE '\\'
      OR a.uri LIKE @q ESCAPE '\\'
      OR a.provider_id LIKE @q ESCAPE '\\'
      OR a.home_repo_id LIKE @q ESCAPE '\\'
      OR a.role LIKE @q ESCAPE '\\'
      ${hasAliases ? `OR EXISTS (
        SELECT 1 FROM artifact_aliases aa
         WHERE aa.artifact_id = a.id
           AND (aa.alias LIKE @q ESCAPE '\\' OR aa.normalized_ref LIKE @q ESCAPE '\\')
      )` : ""}
    )`);
  }
  if (hashPrefix) {
    bindings.hashPrefix = `${escapeLike(hashPrefix.toLowerCase())}%`;
    where.push("lower(a.content_hash) LIKE @hashPrefix ESCAPE '\\'");
  }
  if (asString(options.repo)) {
    bindings.repo = options.repo;
    where.push(`(a.home_repo_id = @repo${hasLinks ? " OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.artifact_id = a.id AND al.repo_id = @repo)" : ""})`);
  }
  if (asString(options.provider)) {
    bindings.provider = options.provider;
    where.push(`(a.provider_id = @provider${hasLinks ? " OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.artifact_id = a.id AND al.provider_id = @provider)" : ""})`);
  }
  if (asString(options.role)) {
    bindings.role = options.role;
    where.push(`(a.role = @role${hasLinks ? " OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.artifact_id = a.id AND al.role = @role)" : ""})`);
  }
  if (asString(options.custody)) {
    bindings.custody = options.custody;
    where.push("a.custody_mode = @custody");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("a.availability = @availability");
  }
  if (asString(options.scheme) && hasAliases) {
    bindings.scheme = options.scheme?.toLowerCase();
    where.push("EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.artifact_id = a.id AND aa.scheme = @scheme)");
  }
  if (asString(options.location)) {
    const like = `%${escapeLike(options.location!.trim())}%`;
    bindings.location = like;
    where.push(`(
      a.uri LIKE @location ESCAPE '\\'
      OR a.repo_locator_json LIKE @location ESCAPE '\\'
      OR a.reference_json LIKE @location ESCAPE '\\'
      ${hasAliases ? `OR EXISTS (
        SELECT 1 FROM artifact_aliases aa
         WHERE aa.artifact_id = a.id
           AND (aa.alias LIKE @location ESCAPE '\\' OR aa.normalized_ref LIKE @location ESCAPE '\\')
      )` : ""}
    )`);
  }
  if ((asString(options.linkedEntityType) || asString(options.linkedEntityId)) && hasLinks) {
    if (asString(options.linkedEntityType) && asString(options.linkedEntityId)) {
      bindings.linkedEntityType = options.linkedEntityType;
      bindings.linkedEntityId = options.linkedEntityId;
      where.push(`EXISTS (
        SELECT 1 FROM artifact_links al
         WHERE al.artifact_id = a.id
           AND al.entity_type = @linkedEntityType
           AND al.entity_id = @linkedEntityId
      )`);
    } else if (asString(options.linkedEntityType)) {
      bindings.linkedEntityType = options.linkedEntityType;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.artifact_id = a.id AND al.entity_type = @linkedEntityType)");
    } else if (asString(options.linkedEntityId)) {
      bindings.linkedEntityId = options.linkedEntityId;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.artifact_id = a.id AND al.entity_id = @linkedEntityId)");
    }
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  bindings.limit = limit;
  bindings.offset = offset;
  const sql = `
    SELECT a.id, a.algorithm, a.content_hash, a.uri, a.media_type, a.role, a.size_bytes,
           a.provider_id, a.manifest_id, a.metadata_json, a.pinned, a.custody_mode,
           a.home_repo_id, a.repo_locator_json, a.availability, a.retention_json,
           a.reference_json, a.created_at
      FROM artifacts a
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.created_at DESC, a.id
     LIMIT @limit OFFSET @offset`;
  const rows = db.prepare(sql).all(bindings) as Array<Record<string, unknown>>;
  if (options.summary) {
    const artifacts = rows.map(summaryArtifactFromRow);
    attachArtifactAliasSchemes(db, artifacts);
    return artifacts;
  }
  return rows.map((row) => {
    const artifact = artifactFromRow(row);
    if (hasAliases && hasLinks) {
      artifact.aliases = listArtifactAliases(db, artifact.id);
      artifact.links = listArtifactLinks(db, artifact.id);
    }
    return artifact;
  });
}

export function listArtifactSeries(db: Db, options: ArtifactListOptions = {}): ArtifactSeriesSummary[] {
  if (!artifactVersioningTablesExist(db)) return [];
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const hasAliases = tableExists(db, "artifact_aliases");
  const hasLinks = tableExists(db, "artifact_links");
  // Series filters match both series-scoped links and links on the latest artifact.
  const linkScopePredicate = `(al.series_id = s.id OR (a.id IS NOT NULL AND al.artifact_id = a.id))`;

  const q = asString(options.q);
  const hashPrefix = asString(options.hashPrefix);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    bindings.q = like;
    where.push(`(
      s.id LIKE @q ESCAPE '\\'
      OR s.series_key LIKE @q ESCAPE '\\'
      OR s.title LIKE @q ESCAPE '\\'
      OR s.repo_id LIKE @q ESCAPE '\\'
      OR s.logical_name LIKE @q ESCAPE '\\'
      OR a.id LIKE @q ESCAPE '\\'
      OR a.content_hash LIKE @q ESCAPE '\\'
      OR a.uri LIKE @q ESCAPE '\\'
      OR a.provider_id LIKE @q ESCAPE '\\'
      OR a.home_repo_id LIKE @q ESCAPE '\\'
      OR a.role LIKE @q ESCAPE '\\'
      ${hasAliases ? `OR EXISTS (
        SELECT 1 FROM artifact_aliases aa
         WHERE aa.artifact_id = a.id
           AND (aa.alias LIKE @q ESCAPE '\\' OR aa.normalized_ref LIKE @q ESCAPE '\\')
      )` : ""}
    )`);
  }
  if (hashPrefix) {
    bindings.hashPrefix = `${escapeLike(hashPrefix.toLowerCase())}%`;
    where.push("lower(a.content_hash) LIKE @hashPrefix ESCAPE '\\'");
  }
  if (asString(options.repo)) {
    bindings.repo = options.repo;
    where.push(`(s.repo_id = @repo OR a.home_repo_id = @repo${hasLinks ? ` OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScopePredicate} AND al.repo_id = @repo)` : ""})`);
  }
  if (asString(options.provider)) {
    bindings.provider = options.provider;
    where.push(`(a.provider_id = @provider${hasLinks ? ` OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScopePredicate} AND al.provider_id = @provider)` : ""})`);
  }
  if (asString(options.role)) {
    bindings.role = options.role;
    where.push(`(a.role = @role${hasLinks ? ` OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScopePredicate} AND al.role = @role)` : ""})`);
  }
  if (asString(options.custody)) {
    bindings.custody = options.custody;
    where.push("a.custody_mode = @custody");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("a.availability = @availability");
  }
  if (asString(options.scheme) && hasAliases) {
    bindings.scheme = options.scheme?.toLowerCase();
    where.push("EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.artifact_id = a.id AND aa.scheme = @scheme)");
  }
  if (asString(options.location)) {
    const like = `%${escapeLike(options.location!.trim())}%`;
    bindings.location = like;
    where.push(`(
      a.uri LIKE @location ESCAPE '\\'
      OR a.repo_locator_json LIKE @location ESCAPE '\\'
      OR a.reference_json LIKE @location ESCAPE '\\'
      ${hasAliases ? `OR EXISTS (
        SELECT 1 FROM artifact_aliases aa
         WHERE aa.artifact_id = a.id
           AND (aa.alias LIKE @location ESCAPE '\\' OR aa.normalized_ref LIKE @location ESCAPE '\\')
      )` : ""}
    )`);
  }
  if ((asString(options.linkedEntityType) || asString(options.linkedEntityId)) && hasLinks) {
    if (asString(options.linkedEntityType) && asString(options.linkedEntityId)) {
      bindings.linkedEntityType = options.linkedEntityType;
      bindings.linkedEntityId = options.linkedEntityId;
      where.push(`EXISTS (
        SELECT 1 FROM artifact_links al
         WHERE ${linkScopePredicate}
           AND al.entity_type = @linkedEntityType
           AND al.entity_id = @linkedEntityId
      )`);
    } else if (asString(options.linkedEntityType)) {
      bindings.linkedEntityType = options.linkedEntityType;
      where.push(`EXISTS (
        SELECT 1 FROM artifact_links al
         WHERE ${linkScopePredicate}
           AND al.entity_type = @linkedEntityType
      )`);
    } else if (asString(options.linkedEntityId)) {
      bindings.linkedEntityId = options.linkedEntityId;
      where.push(`EXISTS (
        SELECT 1 FROM artifact_links al
         WHERE ${linkScopePredicate}
           AND al.entity_id = @linkedEntityId
      )`);
    }
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  bindings.limit = limit;
  bindings.offset = offset;
  const rows = db.prepare(
    `SELECT
        s.id AS series_id, s.series_key, s.source_kind AS series_source_kind,
        s.title AS series_title, s.repo_id AS series_repo_id,
        s.logical_name AS series_logical_name, s.latest_version_id,
        s.version_count, s.metadata_json AS series_metadata_json,
        s.created_at AS series_created_at, s.updated_at AS series_updated_at,
        v.id AS version_id, v.artifact_id AS version_artifact_id,
        v.version_no, v.source_kind AS version_source_kind,
        v.content_hash AS version_content_hash, v.commit_sha, v.repo_path,
        v.observed_path, v.custody_mode AS version_custody_mode,
        v.label, v.note, v.metadata_json AS version_metadata_json,
        v.created_at AS version_created_at,
        a.id AS artifact_id, a.algorithm, a.content_hash, a.uri, a.media_type,
        a.role, a.size_bytes, a.provider_id, a.manifest_id,
        a.metadata_json AS artifact_metadata_json, a.pinned,
        a.custody_mode AS artifact_custody_mode, a.home_repo_id,
        a.repo_locator_json, a.availability, a.retention_json,
        a.reference_json, a.created_at AS artifact_created_at
       FROM artifact_series s
       LEFT JOIN artifact_versions v ON v.id = s.latest_version_id
       LEFT JOIN artifacts a ON a.id = v.artifact_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.updated_at DESC, s.id
      LIMIT @limit OFFSET @offset`,
  ).all(bindings) as Array<Record<string, unknown>>;
  const linksBySeriesId = listArtifactSeriesLinksForSeries(
    db,
    rows.map((row) => String(row.series_id)),
  );
  return rows.map((row) => artifactSeriesSummaryFromRow(row, linksBySeriesId.get(String(row.series_id)) ?? []));
}

export function primarySeriesForArtifact(db: Db, artifactId: string): ArtifactSeriesRecord | null {
  if (!artifactVersioningTablesExist(db)) return null;
  const row = db
    .prepare(
      `SELECT s.* FROM artifact_series s
         JOIN artifact_versions v ON v.series_id = s.id
        WHERE v.artifact_id = ?
        ORDER BY v.version_no DESC LIMIT 1`,
    )
    .get(artifactId) as Record<string, unknown> | undefined;
  return row ? seriesFromRow(row) : null;
}

// ---------------------------------------------------------------------------
// Artifact version identity (series) and custody history (issue f7a994e).
//
// The immutable `artifacts` rows remain the source of truth. A `artifact_series`
// row is the stable LOGICAL identity; `artifact_versions` rows pin specific
// immutable `artifacts.id` rows under a series. History is written ONLY through
// the explicit recordArtifactVersion path — ordinary ingest/preview/check never
// touch these tables.
// ---------------------------------------------------------------------------

const VERSION_SOURCE_KINDS = new Set<ArtifactVersionSourceKind>([
  "tracked_repo",
  "local_only",
  "managed",
]);

function artifactVersioningTablesExist(db: Db): boolean {
  return tableExists(db, "artifact_series") && tableExists(db, "artifact_versions");
}

function assertVersioningTables(db: Db): void {
  if (!artifactVersioningTablesExist(db)) {
    throw new Error("artifact versioning tables are not present in this database");
  }
}

function artifactIdentityTablesExist(db: Db): boolean {
  return tableExists(db, "artifact") && tableExists(db, "artifact_version") && tableExists(db, "artifact_blob");
}

function artifactBlobIdFromHash(hash: string): string {
  return `artifact-blob:${hash.toLowerCase()}`;
}

function canonicalArtifactKey(ref: string): string | null {
  const trimmed = ref.trim();
  if (!/^artifact:/i.test(trimmed) || /^artifact:sha256:/i.test(trimmed)) return null;
  if (/^artifact-/.test(trimmed)) return null;
  const key = trimmed.replace(/^artifact:/i, "");
  return key.trim() ? key.trim() : null;
}

function getLogicalArtifactPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactIdentityRecord> {
  if (!artifactIdentityTablesExist(db)) return { status: "unsupported", value: null };
  const key = canonicalArtifactKey(ref);
  if (!key) return { status: "unsupported", value: null };
  const fullRef = `artifact:${key}`;
  const exact = getLogicalArtifact(db, fullRef);
  if (exact) return { status: "resolved", value: exact };
  if (key.length < MIN_ARTIFACT_ID_PREFIX_LENGTH) return { status: "unsupported", value: null };
  const rows = db
    .prepare(
      `SELECT * FROM artifact
        WHERE id LIKE ? ESCAPE '\\'
           OR identity_key LIKE ? ESCAPE '\\'
        ORDER BY id ASC
        LIMIT 2`,
    )
    .all(`${escapeLike(fullRef)}%`, `${escapeLike(key)}%`) as Array<Record<string, unknown>>;
  if (rows.length === 1) return { status: "resolved", value: artifactIdentityFromRow(rows[0]) };
  return { status: rows.length > 1 ? "ambiguous" : "unresolved", value: null };
}

function getCanonicalArtifactVersionPrefix(
  db: Db,
  ref: string,
): PrefixLookupResult<CanonicalArtifactVersionRecord> {
  if (!artifactIdentityTablesExist(db)) return { status: "unsupported", value: null };
  const trimmed = ref.trim();
  const key = trimmed.replace(/^artifact-version:/i, "");
  const fullRef = /^artifact-version:/i.test(trimmed) ? trimmed : `artifact-version:${key}`;
  const exact = getCanonicalArtifactVersion(db, fullRef);
  if (exact) return { status: "resolved", value: exact };
  if (key.length < MIN_ARTIFACT_ID_PREFIX_LENGTH) return { status: "unsupported", value: null };
  const rows = db
    .prepare(
      `SELECT * FROM artifact_version
        WHERE id LIKE ? ESCAPE '\\'
        ORDER BY id ASC
        LIMIT 2`,
    )
    .all(`${escapeLike(fullRef)}%`) as Array<Record<string, unknown>>;
  if (rows.length === 1) return { status: "resolved", value: canonicalArtifactVersionFromRow(rows[0]) };
  return { status: rows.length > 1 ? "ambiguous" : "unresolved", value: null };
}

function getArtifactBlobPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactBlobRecord> {
  if (!artifactIdentityTablesExist(db)) return { status: "unsupported", value: null };
  const trimmed = ref.trim();
  const explicit = /^artifact-blob:/i.test(trimmed);
  const key = explicit ? trimmed.replace(/^artifact-blob:/i, "") : "";
  if (!key) return { status: "unsupported", value: null };
  const fullRef = explicit ? `artifact-blob:${key}` : artifactBlobIdFromHash(key);
  const exact = getArtifactBlob(db, fullRef) ?? (isSha256(key) ? getArtifactBlob(db, artifactBlobIdFromHash(key)) : null);
  if (exact) return { status: "resolved", value: exact };
  if (key.length < MIN_ARTIFACT_HASH_PREFIX_LENGTH) return { status: "unsupported", value: null };
  const rows = db
    .prepare(
      `SELECT * FROM artifact_blob
        WHERE id LIKE ? ESCAPE '\\'
           OR lower(content_hash) LIKE ? ESCAPE '\\'
        ORDER BY id ASC
        LIMIT 2`,
    )
    .all(`${escapeLike(fullRef)}%`, `${escapeLike(key.toLowerCase())}%`) as Array<Record<string, unknown>>;
  if (rows.length === 1) return { status: "resolved", value: artifactBlobFromRow(rows[0]) };
  return { status: rows.length > 1 ? "ambiguous" : "unresolved", value: null };
}

function legacyArtifactForBlob(db: Db, blob: ArtifactBlobRecord | null): ArtifactRecord | null {
  if (!blob) return null;
  return getArtifact(db, `artifact:sha256:${blob.content_hash}`) ?? getArtifact(db, `artifact:${blob.content_hash}`);
}

function resolutionForCanonicalVersion(
  db: Db,
  ref: string,
  lookup: PrefixLookupResult<CanonicalArtifactVersionRecord>,
): ArtifactResolveResult {
  const base = {
    ref,
    scheme: schemeFromRef(ref),
    normalized_ref: ref,
    artifact: null,
    alias: null,
    logical_artifact: null,
    artifact_version: null,
    artifact_blob: null,
    version: null,
    series: null,
  };
  if (lookup.status !== "resolved") {
    return {
      ...base,
      status: lookup.status,
      target_type: "artifact_version",
      target_id: null,
      warnings: lookup.status === "unsupported" ? ["artifact_version_prefix_too_short"] : [`artifact_version_${lookup.status}`],
    };
  }
  const version = lookup.value;
  const logical = getLogicalArtifact(db, version.artifact_id);
  const blob = getArtifactBlob(db, version.blob_id);
  const legacyVersion = getArtifactVersion(db, version.id);
  const legacySeries = legacyVersion ? getArtifactSeries(db, legacyVersion.series_id) : null;
  return {
    ...base,
    status: "resolved",
    normalized_ref: version.id,
    target_type: "artifact_version",
    target_id: version.id,
    artifact: legacyArtifactForBlob(db, blob),
    logical_artifact: logical,
    artifact_version: version,
    artifact_blob: blob,
    version: legacyVersion,
    series: legacySeries,
    warnings: [],
  };
}

function resolutionForLogicalArtifact(
  db: Db,
  ref: string,
  lookup: PrefixLookupResult<ArtifactIdentityRecord>,
): ArtifactResolveResult {
  const base = {
    ref,
    scheme: schemeFromRef(ref),
    normalized_ref: ref,
    artifact: null,
    alias: null,
    logical_artifact: null,
    artifact_version: null,
    artifact_blob: null,
    version: null,
    series: null,
  };
  if (lookup.status !== "resolved") {
    return {
      ...base,
      status: lookup.status,
      target_type: "artifact",
      target_id: null,
      warnings: lookup.status === "unsupported" ? ["artifact_prefix_too_short"] : [`artifact_${lookup.status}`],
    };
  }
  const logical = lookup.value;
  const version = logical.latest_version_id ? getCanonicalArtifactVersion(db, logical.latest_version_id) : null;
  const blob = version ? getArtifactBlob(db, version.blob_id) : null;
  return {
    ...base,
    status: "resolved",
    normalized_ref: logical.id,
    target_type: "artifact",
    target_id: logical.id,
    artifact: legacyArtifactForBlob(db, blob),
    logical_artifact: logical,
    artifact_version: version,
    artifact_blob: blob,
    warnings: version ? [] : ["artifact_has_no_latest_version"],
  };
}

function resolutionForArtifactBlob(
  db: Db,
  ref: string,
  lookup: PrefixLookupResult<ArtifactBlobRecord>,
  legacy: boolean,
): ArtifactResolveResult {
  const base = {
    ref,
    scheme: schemeFromRef(ref),
    normalized_ref: ref,
    artifact: null,
    alias: null,
    logical_artifact: null,
    artifact_version: null,
    artifact_blob: null,
    version: null,
    series: null,
  };
  const legacyWarnings = legacy ? ["legacy_artifact_ref_read_only", "repair_to_artifact_blob_ref"] : [];
  if (lookup.status !== "resolved") {
    return {
      ...base,
      status: lookup.status,
      target_type: "artifact_blob",
      target_id: null,
      warnings: [
        ...legacyWarnings,
        ...(lookup.status === "unsupported" ? ["artifact_blob_prefix_too_short"] : [`artifact_blob_${lookup.status}`]),
      ],
    };
  }
  const blob = lookup.value;
  return {
    ...base,
    status: "resolved",
    normalized_ref: blob.id,
    target_type: "artifact_blob",
    target_id: blob.id,
    artifact: legacyArtifactForBlob(db, blob),
    artifact_blob: blob,
    warnings: legacyWarnings,
  };
}

function unsupportedLegacyArtifactRef(ref: string, warning: string, repairWarning?: string): ArtifactResolveResult {
  const trimmed = ref.trim();
  return {
    status: "unsupported",
    ref,
    scheme: schemeFromRef(trimmed),
    normalized_ref: trimmed,
    target_id: null,
    artifact: null,
    alias: null,
    logical_artifact: null,
    artifact_version: null,
    artifact_blob: null,
    version: null,
    series: null,
    warnings: repairWarning ? [warning, repairWarning] : [warning],
  };
}

function resolveArtifactIdentityRef(db: Db, ref: string): ArtifactResolveResult | null {
  const trimmed = ref.trim();
  if (/^artifact-series:/i.test(trimmed)) {
    return unsupportedLegacyArtifactRef(
      ref,
      "artifact_series_ref_unsupported",
      "repair_to_artifact_or_artifact_version_ref",
    );
  }
  if (/^artifact:sha256:/i.test(trimmed) || /^sha256:/i.test(trimmed) || /^[a-f0-9]{7,64}$/i.test(trimmed)) {
    return unsupportedLegacyArtifactRef(
      ref,
      "legacy_artifact_ref_unsupported",
      "repair_to_artifact_blob_ref",
    );
  }
  if (!artifactIdentityTablesExist(db)) {
    if (/^artifact(?:-version|-blob)?:/i.test(trimmed)) {
      return unsupportedLegacyArtifactRef(ref, "artifact_identity_tables_unavailable");
    }
    return null;
  }
  if (/^artifact-version:/i.test(trimmed)) {
    return resolutionForCanonicalVersion(db, ref, getCanonicalArtifactVersionPrefix(db, trimmed));
  }
  if (/^artifact-blob:/i.test(trimmed)) {
    return resolutionForArtifactBlob(db, ref, getArtifactBlobPrefix(db, trimmed), false);
  }
  if (/^artifact:/i.test(trimmed)) {
    const logical = getLogicalArtifactPrefix(db, trimmed);
    return resolutionForLogicalArtifact(db, ref, logical);
  }
  return null;
}

export interface ArtifactIdentityListOptions {
  q?: string;
  sourceProjectId?: string;
  sourceRepoId?: string;
  sourceKind?: string;
  limit?: number;
  offset?: number;
}

export function getLogicalArtifact(db: Db, id: string): ArtifactIdentityRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const row = db.prepare("SELECT * FROM artifact WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? artifactIdentityFromRow(row) : null;
}

export function listLogicalArtifacts(
  db: Db,
  options: ArtifactIdentityListOptions = {},
): ArtifactIdentityRecord[] {
  if (!artifactIdentityTablesExist(db)) return [];
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const q = asString(options.q);
  if (q) {
    bindings.q = `%${escapeLike(q)}%`;
    where.push(`(
      id LIKE @q ESCAPE '\\'
      OR identity_key LIKE @q ESCAPE '\\'
      OR title LIKE @q ESCAPE '\\'
      OR logical_name LIKE @q ESCAPE '\\'
      OR source_repo_id LIKE @q ESCAPE '\\'
    )`);
  }
  if (asString(options.sourceProjectId)) {
    bindings.sourceProjectId = options.sourceProjectId;
    where.push("source_project_id = @sourceProjectId");
  }
  if (asString(options.sourceRepoId)) {
    bindings.sourceRepoId = options.sourceRepoId;
    where.push("source_repo_id = @sourceRepoId");
  }
  if (asString(options.sourceKind)) {
    bindings.sourceKind = options.sourceKind;
    where.push("source_kind = @sourceKind");
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM artifact
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, id
       LIMIT @limit OFFSET @offset`,
    )
    .all(bindings) as Array<Record<string, unknown>>;
  return rows.map(artifactIdentityFromRow);
}

export interface ArtifactBlobListOptions {
  q?: string;
  hashPrefix?: string;
  custody?: string;
  availability?: string;
  limit?: number;
  offset?: number;
}

export function getArtifactBlob(db: Db, id: string): ArtifactBlobRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const hash = /^artifact-blob:([a-f0-9]{64})$/i.exec(id.trim())?.[1] ?? (isSha256(id) ? id : null);
  const lookupId = hash ? artifactBlobIdFromHash(hash) : id;
  const row = db.prepare("SELECT * FROM artifact_blob WHERE id = ?").get(lookupId) as
    | Record<string, unknown>
    | undefined;
  return row ? artifactBlobFromRow(row) : null;
}

export function listArtifactBlobs(db: Db, options: ArtifactBlobListOptions = {}): ArtifactBlobRecord[] {
  if (!artifactIdentityTablesExist(db)) return [];
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const q = asString(options.q);
  if (q) {
    bindings.q = `%${escapeLike(q)}%`;
    where.push(`(
      id LIKE @q ESCAPE '\\'
      OR content_hash LIKE @q ESCAPE '\\'
      OR storage_uri LIKE @q ESCAPE '\\'
      OR role LIKE @q ESCAPE '\\'
    )`);
  }
  if (asString(options.hashPrefix)) {
    bindings.hashPrefix = `${escapeLike(options.hashPrefix!.toLowerCase())}%`;
    where.push("lower(content_hash) LIKE @hashPrefix ESCAPE '\\'");
  }
  if (asString(options.custody)) {
    bindings.custody = options.custody;
    where.push("custody_mode = @custody");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("availability = @availability");
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM artifact_blob
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id
       LIMIT @limit OFFSET @offset`,
    )
    .all(bindings) as Array<Record<string, unknown>>;
  return rows.map(artifactBlobFromRow);
}

export function getCanonicalArtifactVersion(db: Db, id: string): CanonicalArtifactVersionRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const row = db.prepare("SELECT * FROM artifact_version WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? canonicalArtifactVersionFromRow(row) : null;
}

export function listCanonicalArtifactVersions(db: Db, artifactId: string): CanonicalArtifactVersionRecord[] {
  if (!artifactIdentityTablesExist(db)) return [];
  const rows = db
    .prepare("SELECT * FROM artifact_version WHERE artifact_id = ? ORDER BY version_no ASC")
    .all(artifactId) as Array<Record<string, unknown>>;
  return rows.map(canonicalArtifactVersionFromRow);
}

function logicalArtifactIdFromLegacySeries(seriesId: string): string {
  const trimmed = seriesId.trim();
  const match = /^artifact-series:(.+)$/i.exec(trimmed);
  return match ? `artifact:${match[1]}` : `artifact:${trimmed.replace(/^artifact:/i, "")}`;
}

function canonicalVersionIdFromLegacy(versionId: string): string {
  const trimmed = versionId.trim();
  return /^artifact-version:/i.test(trimmed) ? trimmed : `artifact-version:${trimmed}`;
}

function mirrorLegacyArtifactBlob(db: Db, artifact: ArtifactRecord, now = Date.now()): ArtifactBlobRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const blobId = artifactBlobIdFromHash(artifact.content_hash);
  db.prepare(
    `INSERT INTO artifact_blob (
      id, algorithm, content_hash, storage_uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, custody_mode, availability,
      retention_json, reference_json, created_at
    ) VALUES (
      @id, @algorithm, @content_hash, @storage_uri, @media_type, @role, @size_bytes,
      @provider_id, @manifest_id, @metadata_json, @custody_mode, @availability,
      @retention_json, @reference_json, @created_at
    )
    ON CONFLICT(algorithm, content_hash) DO UPDATE SET
      storage_uri = COALESCE(excluded.storage_uri, artifact_blob.storage_uri),
      media_type = COALESCE(excluded.media_type, artifact_blob.media_type),
      role = COALESCE(excluded.role, artifact_blob.role),
      size_bytes = CASE WHEN artifact_blob.size_bytes = 0 THEN excluded.size_bytes ELSE artifact_blob.size_bytes END,
      provider_id = COALESCE(excluded.provider_id, artifact_blob.provider_id),
      manifest_id = COALESCE(excluded.manifest_id, artifact_blob.manifest_id),
      metadata_json = CASE WHEN artifact_blob.metadata_json = '{}' THEN excluded.metadata_json ELSE artifact_blob.metadata_json END,
      custody_mode = CASE
        WHEN artifact_blob.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present' THEN excluded.custody_mode
        ELSE artifact_blob.custody_mode
      END,
      availability = CASE
        WHEN artifact_blob.availability IN ('remote_only', 'missing', 'unchecked')
         AND excluded.availability = 'present' THEN excluded.availability
        ELSE artifact_blob.availability
      END,
      retention_json = CASE WHEN artifact_blob.retention_json = '{}' THEN excluded.retention_json ELSE artifact_blob.retention_json END,
      reference_json = CASE WHEN artifact_blob.reference_json = '{}' THEN excluded.reference_json ELSE artifact_blob.reference_json END`,
  ).run({
    id: blobId,
    algorithm: artifact.algorithm,
    content_hash: artifact.content_hash,
    storage_uri: artifact.uri?.startsWith("repo://") ? null : artifact.uri,
    media_type: artifact.media_type,
    role: artifact.role,
    size_bytes: artifact.size_bytes,
    provider_id: artifact.provider_id,
    manifest_id: artifact.manifest_id,
    metadata_json: jsonStringify(artifact.metadata),
    custody_mode: artifact.custody_mode,
    availability: artifact.availability,
    retention_json: jsonStringify(artifact.retention),
    reference_json: jsonStringify(artifact.reference),
    created_at: artifact.created_at || now,
  });
  return getArtifactBlob(db, blobId);
}

function mirrorLegacyVersionIdentity(
  db: Db,
  series: ArtifactSeriesRecord,
  version: ArtifactVersionRecord,
  artifact: ArtifactRecord,
  now = Date.now(),
): void {
  if (!artifactIdentityTablesExist(db)) return;
  const blob = mirrorLegacyArtifactBlob(db, artifact, now);
  if (!blob) return;
  const logicalId = logicalArtifactIdFromLegacySeries(series.id);
  const canonicalVersionId = canonicalVersionIdFromLegacy(version.id);
  db.prepare(
    `INSERT INTO artifact (
      id, identity_key, source_kind, title, source_project_id, source_repo_id,
      logical_name, source_path, latest_version_id, version_count, metadata_json,
      created_at, updated_at
    ) VALUES (
      @id, @identity_key, @source_kind, @title, NULL, @source_repo_id,
      @logical_name, @source_path, @latest_version_id, @version_count, @metadata_json,
      @created_at, @updated_at
    )
    ON CONFLICT(identity_key) DO UPDATE SET
      source_kind = excluded.source_kind,
      title = COALESCE(excluded.title, artifact.title),
      source_repo_id = COALESCE(excluded.source_repo_id, artifact.source_repo_id),
      logical_name = COALESCE(excluded.logical_name, artifact.logical_name),
      source_path = COALESCE(excluded.source_path, artifact.source_path),
      latest_version_id = excluded.latest_version_id,
      version_count = MAX(artifact.version_count, excluded.version_count),
      metadata_json = CASE WHEN artifact.metadata_json = '{}' THEN excluded.metadata_json ELSE artifact.metadata_json END,
      updated_at = excluded.updated_at`,
  ).run({
    id: logicalId,
    identity_key: series.series_key,
    source_kind: series.source_kind,
    title: series.title,
    source_repo_id: series.repo_id,
    logical_name: series.logical_name,
    source_path: version.repo_path ?? version.observed_path,
    latest_version_id: canonicalVersionId,
    version_count: series.version_count,
    metadata_json: jsonStringify(series.metadata),
    created_at: series.created_at || now,
    updated_at: series.updated_at || now,
  });
  db.prepare(
    `INSERT INTO artifact_version (
      id, artifact_id, version_no, blob_id, source_kind, content_hash,
      source_project_id, source_repo_id, repo_path, commit_sha, observed_path,
      source_locator_json, custody_mode, label, note, metadata_json, created_at
    ) VALUES (
      @id, @artifact_id, @version_no, @blob_id, @source_kind, @content_hash,
      NULL, @source_repo_id, @repo_path, @commit_sha, @observed_path,
      @source_locator_json, @custody_mode, @label, @note, @metadata_json, @created_at
    )
    ON CONFLICT(artifact_id, version_no) DO UPDATE SET
      id = excluded.id,
      blob_id = excluded.blob_id,
      source_kind = excluded.source_kind,
      content_hash = excluded.content_hash,
      source_repo_id = COALESCE(excluded.source_repo_id, artifact_version.source_repo_id),
      repo_path = COALESCE(excluded.repo_path, artifact_version.repo_path),
      commit_sha = COALESCE(excluded.commit_sha, artifact_version.commit_sha),
      observed_path = COALESCE(excluded.observed_path, artifact_version.observed_path),
      source_locator_json = excluded.source_locator_json,
      custody_mode = COALESCE(excluded.custody_mode, artifact_version.custody_mode),
      label = COALESCE(excluded.label, artifact_version.label),
      note = COALESCE(excluded.note, artifact_version.note),
      metadata_json = excluded.metadata_json`,
  ).run({
    id: canonicalVersionId,
    artifact_id: logicalId,
    version_no: version.version_no,
    blob_id: blob.id,
    source_kind: version.source_kind,
    content_hash: version.content_hash,
    source_repo_id: series.repo_id,
    repo_path: version.repo_path,
    commit_sha: version.commit_sha,
    observed_path: version.observed_path,
    source_locator_json: jsonStringify({
      migrated_from: "artifact_versions",
      legacy_series_id: series.id,
      legacy_version_id: version.id,
      legacy_blob_id: artifact.id,
    }),
    custody_mode: version.custody_mode,
    label: version.label,
    note: version.note,
    metadata_json: jsonStringify(version.metadata),
    created_at: version.created_at || now,
  });
}

export interface ProjectArtifactAssociationInput {
  project_ref: string;
  target_ref?: string;
  target_type?: "artifact" | "artifact_version";
  target_id?: string;
  association_kind?: "associated" | "canonical";
  role?: string;
  title?: string;
  description?: string;
  rank?: number;
  status?: "active" | "superseded" | "archived";
  source?: "user" | "agent_explicit" | "space_rule" | "migration" | "system";
  source_ref_type?: string;
  source_ref_id?: string;
  metadata?: JsonRecord;
}

function resolveAssociationTarget(
  db: Db,
  input: ProjectArtifactAssociationInput,
): { targetType: "artifact" | "artifact_version"; targetId: string; resolution: ArtifactResolveResult | null } {
  if (input.target_type && input.target_id) {
    return { targetType: input.target_type, targetId: input.target_id, resolution: null };
  }
  if (!input.target_ref) throw new Error("target_ref or target_type plus target_id is required");
  const resolution = resolveArtifactRef(db, input.target_ref);
  if (resolution.status !== "resolved" || !resolution.target_type || !resolution.target_id) {
    throw new Error(`artifact target did not resolve: ${input.target_ref}`);
  }
  if (resolution.target_type === "artifact_blob" || resolution.target_type === "legacy_artifact") {
    throw new Error("project associations target logical artifacts or artifact versions, not blobs");
  }
  return {
    targetType: resolution.target_type,
    targetId: resolution.target_id,
    resolution,
  };
}

export function associateProjectArtifact(
  db: Db,
  input: ProjectArtifactAssociationInput,
  now = Date.now(),
): { association: ProjectArtifactAssociationRecord; resolution: ArtifactResolveResult | null } {
  if (!tableExists(db, "project_artifact_associations")) {
    throw new Error("project_artifact_associations table is not present in this database");
  }
  const project = resolveProjectRef(db, input.project_ref);
  if (!project.ok || !project.project) {
    throw new Error(project.ambiguous ? `ambiguous project ref: ${input.project_ref}` : `project not found: ${input.project_ref}`);
  }
  const projectId = project.project.id;
  const target = resolveAssociationTarget(db, input);
  const associationKind = input.association_kind ?? "associated";
  const role = input.role ?? "";
  const id = artifactRegistryId("project_artifact_association", [
    projectId,
    target.targetType,
    target.targetId,
    role,
  ]);
  db.prepare(
    `INSERT INTO project_artifact_associations (
      id, project_id, target_type, target_id, association_kind, role, title,
      description, rank, status, source, source_ref_type, source_ref_id,
      metadata_json, created_at, updated_at
    ) VALUES (
      @id, @project_id, @target_type, @target_id, @association_kind, @role, @title,
      @description, @rank, @status, @source, @source_ref_type, @source_ref_id,
      @metadata_json, @created_at, @updated_at
    )
    ON CONFLICT(project_id, target_type, target_id, role) DO UPDATE SET
      association_kind = CASE
        WHEN project_artifact_associations.association_kind = 'canonical'
         AND excluded.association_kind = 'associated' THEN project_artifact_associations.association_kind
        ELSE excluded.association_kind
      END,
      title = COALESCE(excluded.title, project_artifact_associations.title),
      description = COALESCE(excluded.description, project_artifact_associations.description),
      rank = COALESCE(excluded.rank, project_artifact_associations.rank),
      status = excluded.status,
      source = excluded.source,
      source_ref_type = COALESCE(excluded.source_ref_type, project_artifact_associations.source_ref_type),
      source_ref_id = COALESCE(excluded.source_ref_id, project_artifact_associations.source_ref_id),
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
  ).run({
    id,
    project_id: projectId,
    target_type: target.targetType,
    target_id: target.targetId,
    association_kind: associationKind,
    role,
    title: input.title ?? null,
    description: input.description ?? null,
    rank: typeof input.rank === "number" ? input.rank : null,
    status: input.status ?? "active",
    source: input.source ?? "agent_explicit",
    source_ref_type: input.source_ref_type ?? null,
    source_ref_id: input.source_ref_id ?? null,
    metadata_json: jsonStringify(input.metadata ?? {}),
    created_at: now,
    updated_at: now,
  });
  const association = db
    .prepare("SELECT * FROM project_artifact_associations WHERE project_id = ? AND target_type = ? AND target_id = ? AND role = ?")
    .get(projectId, target.targetType, target.targetId, role) as Record<string, unknown>;
  return { association: projectArtifactAssociationFromRow(association), resolution: target.resolution };
}

export interface ProjectArtifactAssociationListOptions {
  projectRef?: string;
  targetType?: "artifact" | "artifact_version";
  targetId?: string;
  associationKind?: "associated" | "canonical";
  status?: "active" | "superseded" | "archived";
  limit?: number;
  offset?: number;
}

export function listProjectArtifactAssociations(
  db: Db,
  options: ProjectArtifactAssociationListOptions = {},
): ProjectArtifactAssociationRecord[] {
  if (!tableExists(db, "project_artifact_associations")) return [];
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  if (asString(options.projectRef)) {
    const project = resolveProjectRef(db, options.projectRef!);
    if (!project.ok || !project.project) return [];
    bindings.projectId = project.project.id;
    where.push("project_id = @projectId");
  }
  if (options.targetType) {
    bindings.targetType = options.targetType;
    where.push("target_type = @targetType");
  }
  if (asString(options.targetId)) {
    bindings.targetId = options.targetId;
    where.push("target_id = @targetId");
  }
  if (options.associationKind) {
    bindings.associationKind = options.associationKind;
    where.push("association_kind = @associationKind");
  }
  if (options.status) {
    bindings.status = options.status;
    where.push("status = @status");
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM project_artifact_associations
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(rank, 2147483647), updated_at DESC, id
       LIMIT @limit OFFSET @offset`,
    )
    .all(bindings) as Array<Record<string, unknown>>;
  return rows.map(projectArtifactAssociationFromRow);
}

function seriesIdFromKey(seriesKey: string): string {
  return artifactRegistryId("artifact-series", [seriesKey]);
}

function versionIdFor(seriesId: string, sourceKind: string, naturalKey: string): string {
  return artifactRegistryId("artifact-version", [seriesId, sourceKind, naturalKey]);
}

// Percent-escape `:` (and the escape char itself) within a single series-key
// component so a `:`-joined default key is unambiguous: namespace "a:b" + name
// "c" must not collide with namespace "a" + role "b" + name "c".
function escapeSeriesKeyComponent(value: string): string {
  return value.replace(/%/g, "%25").replace(/:/g, "%3A");
}

function seriesFromRow(row: Record<string, unknown>): ArtifactSeriesRecord {
  return {
    id: String(row.id),
    series_key: String(row.series_key),
    source_kind: String(row.source_kind) as ArtifactSeriesSourceKind,
    title: (row.title as string | null) ?? null,
    repo_id: (row.repo_id as string | null) ?? null,
    logical_name: (row.logical_name as string | null) ?? null,
    latest_version_id: (row.latest_version_id as string | null) ?? null,
    version_count: Number(row.version_count ?? 0),
    metadata: parseJsonRecord(row.metadata_json as string | null),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function artifactSeriesSummaryFromRow(
  row: Record<string, unknown>,
  links: ArtifactLinkRecord[],
): ArtifactSeriesSummary {
  const latestArtifact = row.artifact_id === null || row.artifact_id === undefined
    ? null
    : summaryArtifactFromRow({
        id: row.artifact_id,
        algorithm: row.algorithm,
        content_hash: row.content_hash,
        uri: row.uri,
        media_type: row.media_type,
        role: row.role,
        size_bytes: row.size_bytes,
        provider_id: row.provider_id,
        manifest_id: row.manifest_id,
        metadata_json: row.artifact_metadata_json,
        pinned: row.pinned,
        custody_mode: row.artifact_custody_mode,
        home_repo_id: row.home_repo_id,
        repo_locator_json: row.repo_locator_json,
        availability: row.availability,
        retention_json: row.retention_json,
        reference_json: row.reference_json,
        created_at: row.artifact_created_at,
      });
  const latestVersion = row.version_id === null || row.version_id === undefined
    ? null
    : versionFromRow({
        id: row.version_id,
        series_id: row.series_id,
        artifact_id: row.version_artifact_id,
        version_no: row.version_no,
        source_kind: row.version_source_kind,
        content_hash: row.version_content_hash,
        commit_sha: row.commit_sha,
        repo_path: row.repo_path,
        observed_path: row.observed_path,
        custody_mode: row.version_custody_mode,
        label: row.label,
        note: row.note,
        metadata_json: row.version_metadata_json,
        created_at: row.version_created_at,
      });
  const id = String(row.series_id);
  return {
    id,
    ref: logicalArtifactIdFromLegacySeries(id),
    series_key: String(row.series_key),
    source_kind: String(row.series_source_kind) as ArtifactSeriesSourceKind,
    title: row.series_title === null || row.series_title === undefined ? null : String(row.series_title),
    repo_id: row.series_repo_id === null || row.series_repo_id === undefined ? null : String(row.series_repo_id),
    logical_name: row.series_logical_name === null || row.series_logical_name === undefined
      ? null
      : String(row.series_logical_name),
    latest_version_id: row.latest_version_id === null || row.latest_version_id === undefined
      ? null
      : String(row.latest_version_id),
    version_count: Number(row.version_count ?? 0),
    metadata: parseJsonRecord(row.series_metadata_json as string | null),
    created_at: Number(row.series_created_at),
    updated_at: Number(row.series_updated_at),
    latest_version: latestVersion,
    latest_artifact: latestArtifact,
    links,
  };
}

function versionFromRow(row: Record<string, unknown>): ArtifactVersionRecord {
  return {
    id: String(row.id),
    series_id: String(row.series_id),
    artifact_id: String(row.artifact_id),
    version_no: Number(row.version_no),
    source_kind: String(row.source_kind) as ArtifactVersionSourceKind,
    content_hash: String(row.content_hash),
    commit_sha: (row.commit_sha as string | null) ?? null,
    repo_path: (row.repo_path as string | null) ?? null,
    observed_path: (row.observed_path as string | null) ?? null,
    custody_mode: (row.custody_mode as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    metadata: parseJsonRecord(row.metadata_json as string | null),
    created_at: Number(row.created_at),
  };
}

export function getArtifactSeries(db: Db, idOrKey: string): ArtifactSeriesRecord | null {
  if (!artifactVersioningTablesExist(db)) return null;
  const row = db
    .prepare("SELECT * FROM artifact_series WHERE id = ? OR series_key = ? LIMIT 1")
    .get(idOrKey, idOrKey) as Record<string, unknown> | undefined;
  return row ? seriesFromRow(row) : null;
}

function resolveArtifactSeriesPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactSeriesRecord> {
  if (!artifactVersioningTablesExist(db)) return { status: "unsupported", value: null };
  const trimmed = ref.trim();
  const key = trimmed.replace(/^artifact-series:/i, "");
  const exact = getArtifactSeries(db, trimmed) ?? getArtifactSeries(db, key);
  if (exact) return { status: "resolved", value: exact };
  if (key.length < MIN_ARTIFACT_ID_PREFIX_LENGTH) return { status: "unsupported", value: null };

  const idPrefix = trimmed.startsWith("artifact-series:") ? trimmed : `artifact-series:${key}`;
  const keyPrefix = key;
  const rows = db
    .prepare(
      `SELECT * FROM artifact_series
        WHERE id LIKE ? ESCAPE '\\'
           OR series_key LIKE ? ESCAPE '\\'
        ORDER BY id ASC
        LIMIT 2`,
    )
    .all(`${escapeLike(idPrefix)}%`, `${escapeLike(keyPrefix)}%`) as Array<Record<string, unknown>>;
  if (rows.length === 1) return { status: "resolved", value: seriesFromRow(rows[0]) };
  return { status: rows.length > 1 ? "ambiguous" : "unresolved", value: null };
}

export function getArtifactVersion(db: Db, id: string): ArtifactVersionRecord | null {
  if (!artifactVersioningTablesExist(db)) return null;
  const row = db
    .prepare("SELECT * FROM artifact_versions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? versionFromRow(row) : null;
}

function resolveArtifactVersionPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactVersionRecord> {
  if (!artifactVersioningTablesExist(db)) return { status: "unsupported", value: null };
  const trimmed = ref.trim();
  const key = trimmed.replace(/^artifact-version:/i, "");
  const fullRef = trimmed.startsWith("artifact-version:") ? trimmed : `artifact-version:${key}`;
  const exact = getArtifactVersion(db, fullRef);
  if (exact) return { status: "resolved", value: exact };
  if (key.length < MIN_ARTIFACT_ID_PREFIX_LENGTH) return { status: "unsupported", value: null };

  const rows = db
    .prepare(
      `SELECT * FROM artifact_versions
        WHERE id LIKE ? ESCAPE '\\'
        ORDER BY id ASC
        LIMIT 2`,
    )
    .all(`${escapeLike(fullRef)}%`) as Array<Record<string, unknown>>;
  if (rows.length === 1) return { status: "resolved", value: versionFromRow(rows[0]) };
  return { status: rows.length > 1 ? "ambiguous" : "unresolved", value: null };
}

export function listArtifactVersions(db: Db, seriesId: string): ArtifactVersionRecord[] {
  if (!artifactVersioningTablesExist(db)) return [];
  const rows = db
    .prepare("SELECT * FROM artifact_versions WHERE series_id = ? ORDER BY version_no ASC")
    .all(seriesId) as Array<Record<string, unknown>>;
  return rows.map(versionFromRow);
}

export interface EnsureArtifactSeriesInput {
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title?: string;
  repo_id?: string;
  logical_name?: string;
  metadata?: JsonRecord;
}

export function ensureArtifactSeries(
  db: Db,
  input: EnsureArtifactSeriesInput,
  now = Date.now(),
): ArtifactSeriesRecord {
  assertVersioningTables(db);
  const seriesKey = input.series_key.trim();
  if (!seriesKey) throw new Error("series_key is required");
  const id = seriesIdFromKey(seriesKey);
  db.prepare(
    `INSERT INTO artifact_series (
      id, series_key, source_kind, title, repo_id, logical_name,
      latest_version_id, version_count, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @series_key, @source_kind, @title, @repo_id, @logical_name,
      NULL, 0, @metadata_json, @created_at, @created_at
    )
    ON CONFLICT(series_key) DO UPDATE SET
      title = COALESCE(excluded.title, artifact_series.title),
      repo_id = COALESCE(excluded.repo_id, artifact_series.repo_id),
      logical_name = COALESCE(excluded.logical_name, artifact_series.logical_name),
      metadata_json = CASE
        WHEN artifact_series.metadata_json = '{}' THEN excluded.metadata_json
        ELSE artifact_series.metadata_json
      END,
      updated_at = excluded.updated_at`,
  ).run({
    id,
    series_key: seriesKey,
    source_kind: input.source_kind,
    title: input.title ?? null,
    repo_id: input.repo_id ?? null,
    logical_name: input.logical_name ?? null,
    metadata_json: jsonStringify(input.metadata ?? {}),
    created_at: now,
  });
  return getArtifactSeries(db, id) as ArtifactSeriesRecord;
}

export interface AppendArtifactVersionInput {
  series_id: string;
  artifact_id: string;
  source_kind: ArtifactVersionSourceKind;
  content_hash: string;
  natural_key?: string;
  commit_sha?: string;
  repo_path?: string;
  observed_path?: string;
  custody_mode?: string;
  label?: string;
  note?: string;
  metadata?: JsonRecord;
}

export function appendArtifactVersion(
  db: Db,
  input: AppendArtifactVersionInput,
  now = Date.now(),
): { version: ArtifactVersionRecord; created: boolean } {
  assertVersioningTables(db);
  if (!VERSION_SOURCE_KINDS.has(input.source_kind)) {
    throw new Error(`unsupported version source_kind: ${input.source_kind}`);
  }
  // The MAX(version_no) read, the version insert, and the series-counter update
  // must be one atomic unit so a crash never leaves version_count /
  // latest_version_id / source_kind out of sync with the actual rows, and so a
  // concurrent writer (separate process/connection) cannot read the same
  // MAX(version_no). The deterministic version id keeps re-records idempotent
  // (ON CONFLICT(id) DO NOTHING). We run with BEGIN IMMEDIATE so the write lock
  // is taken before the MAX read; within one process better-sqlite3 is already
  // serialized. If we are already inside a transaction, run inline (the caller's
  // transaction provides the boundary).
  const body = (): { version: ArtifactVersionRecord; created: boolean } => {
    const series = getArtifactSeries(db, input.series_id);
    if (!series) throw new Error(`artifact series not found: ${input.series_id}`);
    const naturalKey = input.natural_key
      ?? (input.source_kind === "tracked_repo"
        ? `${input.commit_sha ?? ""}:${input.repo_path ?? ""}`
        : input.content_hash);
    const versionId = versionIdFor(series.id, input.source_kind, naturalKey);
    const existing = getArtifactVersion(db, versionId);
    if (existing) {
      return { version: existing, created: false };
    }
    const nextNoRow = db
      .prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM artifact_versions WHERE series_id = ?")
      .get(series.id) as { n: number };
    const versionNo = Number(nextNoRow.n) + 1;
    const result = db.prepare(
      `INSERT INTO artifact_versions (
        id, series_id, artifact_id, version_no, source_kind, content_hash,
        commit_sha, repo_path, observed_path, custody_mode, label, note,
        metadata_json, created_at
      ) VALUES (
        @id, @series_id, @artifact_id, @version_no, @source_kind, @content_hash,
        @commit_sha, @repo_path, @observed_path, @custody_mode, @label, @note,
        @metadata_json, @created_at
      )
      ON CONFLICT(id) DO NOTHING`,
    ).run({
      id: versionId,
      series_id: series.id,
      artifact_id: input.artifact_id,
      version_no: versionNo,
      source_kind: input.source_kind,
      content_hash: input.content_hash,
      commit_sha: input.commit_sha ?? null,
      repo_path: input.repo_path ?? null,
      observed_path: input.observed_path ?? null,
      custody_mode: input.custody_mode ?? null,
      label: input.label ?? null,
      note: input.note ?? null,
      metadata_json: jsonStringify(input.metadata ?? {}),
      created_at: now,
    });
    const created = result.changes > 0;
    if (created) {
      const nextSourceKind: ArtifactSeriesSourceKind =
        series.version_count === 0
          ? input.source_kind
          : series.source_kind === "mixed" || series.source_kind === input.source_kind
            ? series.source_kind
            : "mixed";
      db.prepare(
        `UPDATE artifact_series
            SET latest_version_id = @version_id,
                version_count = version_count + 1,
                source_kind = @source_kind,
                updated_at = @now
          WHERE id = @series_id`,
      ).run({
        version_id: versionId,
        source_kind: nextSourceKind,
        now,
        series_id: series.id,
      });
    }
    return { version: getArtifactVersion(db, versionId) as ArtifactVersionRecord, created };
  };
  if (db.inTransaction) return body();
  return db.transaction(body).immediate();
}

// Migration-89 backfill (issue c154a27), invoked from db.ts migrate() like
// backfillProjectKeys. Wraps every series-less `artifacts` content row into a
// deterministic 1-version series so the "series IS the artifact" identity holds
// for every pre-existing row. The series source_kind is derived from the
// artifact's custody_mode (managed/copy -> managed, link/external -> local_only)
// while the version row preserves the TRUE custody_mode. series_key = the artifact
// id, so the series id (seriesIdFromKey) and version id (versionIdFor) are
// deterministic: re-runs are no-ops (ensureArtifactSeries ON CONFLICT(series_key)
// DO UPDATE + appendArtifactVersion ON CONFLICT(id) DO NOTHING, and a re-run also
// finds zero orphans). Runs as ONE immediate transaction (the nested
// appendArtifactVersion runs inline because db.inTransaction is true) so it is not
// one transaction per artifact. Returns the number of artifacts wrapped.
export function backfillOrphanArtifactSeries(db: Db, now = Date.now()): number {
  if (!artifactVersioningTablesExist(db)) return 0;
  if (!tableExists(db, "artifacts")) return 0;
  const orphans = db
    .prepare(
      `SELECT id, custody_mode, content_hash FROM artifacts
        WHERE id NOT IN (SELECT artifact_id FROM artifact_versions)
        ORDER BY created_at, id`,
    )
    .all() as Array<{ id: string; custody_mode: string | null; content_hash: string | null }>;
  if (orphans.length === 0) return 0;

  const wrap = (orphan: { id: string; custody_mode: string | null; content_hash: string | null }): void => {
    const custody = orphan.custody_mode ?? "managed";
    const sourceKind: ArtifactVersionSourceKind =
      custody === "managed" || custody === "copy" ? "managed" : "local_only";
    const series = ensureArtifactSeries(db, { series_key: orphan.id, source_kind: sourceKind }, now);
    appendArtifactVersion(
      db,
      {
        series_id: series.id,
        artifact_id: orphan.id,
        source_kind: sourceKind,
        content_hash: orphan.content_hash ?? "",
        natural_key: orphan.id,
        custody_mode: custody,
      },
      now,
    );
  };

  const run = (): void => {
    for (const orphan of orphans) wrap(orphan);
  };
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
  return orphans.length;
}

export interface RecordArtifactVersionInput {
  source_kind: ArtifactVersionSourceKind;
  path?: string;
  ref?: string;
  content?: string;
  content_base64?: string;
  json?: unknown;
  series_key?: string;
  title?: string;
  logical_name?: string;
  label?: string;
  note?: string;
  role?: string;
  media_type?: string;
  custody_mode?: ArtifactCustodyMode | string;
  // Namespace scopes for the DEFAULT managed series key so two unrelated
  // artifacts that share a logical_name (e.g. "report") do not collide into one
  // global series. At least one (or an explicit series_key) is required for
  // managed records.
  provider_id?: string;
  repo_id?: string;
  issue?: string;
  metadata?: JsonRecord;
}

// Explicit version recording. This is the ONLY write path into the version
// tables; ordinary ingest/preview/check never call it. For local-only files it
// is the explicit observation command, satisfying the "preview/check must not
// mutate history" rule.
export function recordArtifactVersion(
  db: Db,
  input: RecordArtifactVersionInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ArtifactVersionRecordResult {
  assertVersioningTables(db);
  if (!VERSION_SOURCE_KINDS.has(input.source_kind)) {
    throw new Error(`unsupported version source_kind: ${input.source_kind}`);
  }
  const warnings: string[] = [];
  // Per-kind work: ingest/snapshot the immutable artifact (outside the version
  // transaction — artifact rows are content-addressed and idempotent) and
  // compute the series + version descriptors. The ensure-series + append-version
  // write is then done atomically below.
  let artifact: ArtifactRecord;
  let seriesInput: EnsureArtifactSeriesInput;
  let versionInput: Omit<AppendArtifactVersionInput, "series_id">;

  if (input.source_kind === "tracked_repo") {
    if (!input.path) throw new Error("tracked_repo version requires a file path");
    // Classify read-only first so we never register a commit-pinned link for a
    // file that is not actually clean-committed.
    const plan = planLocalArtifactPath(db, {
      path: input.path,
      role: input.role,
      media_type: input.media_type,
      logical_name: input.logical_name,
      custody_mode: "link",
    });
    const git = plan.git_state;
    if (!git.repo_id || !git.relative_path) {
      throw new Error("tracked_repo version requires a tracked file inside a registered repo");
    }
    const seriesKey = input.series_key ?? `repo:${git.repo_id}:${git.relative_path}`;
    if (plan.recoverability !== "repo_commit") {
      // Dirty / staged / untracked: a commit-pinned tracked_repo version would
      // (a) collapse repeated dirty records by commit:path even when bytes
      // differ and (b) make diff/materialization read committed bytes via
      // `git show`, not the dirty bytes whose hash we recorded. Instead snapshot
      // the ACTUAL bytes into CAS and record a content-hash-keyed local_only
      // observation under the same repo-derived series (no commit-pinned read).
      warnings.push("tracked_repo_dirty_recorded_as_local_only", ...plan.warnings);
      // Preserve provenance: the HEAD commit the dirty file was observed against
      // (metadata only — commit_sha stays null since these bytes are NOT the
      // committed bytes at that commit).
      const dirtyProvenance = {
        recoverability: "local_only" as const,
        observed_path: plan.resolved_path,
        repo_id: git.repo_id,
        repo_path: git.relative_path,
        dirty_at_commit: git.commit ?? null,
        head_commit: git.commit ?? null,
      };
      artifact = snapshotArtifactBytes(db, {
        path: input.path,
        role: input.role,
        media_type: input.media_type,
        logical_name: input.logical_name ?? git.relative_path,
        custody_mode: "copy",
        metadata: mergeJsonRecords(input.metadata, dirtyProvenance),
      }, now, artifactRoot);
      seriesInput = {
        series_key: seriesKey,
        source_kind: "local_only",
        title: input.title,
        repo_id: git.repo_id,
        logical_name: input.logical_name ?? git.relative_path,
        metadata: input.metadata,
      };
      versionInput = {
        artifact_id: artifact.id,
        source_kind: "local_only",
        content_hash: artifact.content_hash,
        observed_path: plan.resolved_path,
        repo_path: git.relative_path,
        custody_mode: artifact.custody_mode,
        label: input.label,
        note: input.note,
        metadata: mergeJsonRecords(input.metadata, {
          dirty_at_commit: git.commit ?? null,
          head_commit: git.commit ?? null,
        }),
      };
    } else {
      const reg = registerLocalArtifactPath(db, {
        path: input.path,
        role: input.role,
        media_type: input.media_type,
        logical_name: input.logical_name,
        custody_mode: "link",
        metadata: input.metadata,
      }, now, artifactRoot);
      warnings.push(...reg.warnings);
      artifact = reg.artifact;
      seriesInput = {
        series_key: seriesKey,
        source_kind: "tracked_repo",
        title: input.title,
        repo_id: git.repo_id,
        logical_name: input.logical_name ?? git.relative_path,
        metadata: input.metadata,
      };
      versionInput = {
        artifact_id: reg.artifact.id,
        source_kind: "tracked_repo",
        content_hash: reg.artifact.content_hash,
        commit_sha: reg.git_state.commit ?? undefined,
        repo_path: reg.git_state.relative_path ?? git.relative_path,
        custody_mode: reg.artifact.custody_mode,
        label: input.label,
        note: input.note,
        metadata: input.metadata,
      };
    }
  } else if (input.source_kind === "local_only") {
    if (!input.path) throw new Error("local_only version requires a file path");
    const observedPath = safeRealpathSync(path.resolve(expandHomePath(input.path)));
    artifact = snapshotArtifactBytes(db, {
      path: input.path,
      role: input.role,
      media_type: input.media_type,
      logical_name: input.logical_name,
      custody_mode: (input.custody_mode === "managed" ? "managed" : "copy"),
      metadata: mergeJsonRecords(input.metadata, { recoverability: "local_only", observed_path: observedPath }),
    }, now, artifactRoot);
    seriesInput = {
      series_key: input.series_key ?? `local:${observedPath}`,
      source_kind: "local_only",
      title: input.title,
      repo_id: input.repo_id,
      logical_name: input.logical_name ?? path.basename(observedPath),
      metadata: input.metadata,
    };
    versionInput = {
      artifact_id: artifact.id,
      source_kind: "local_only",
      content_hash: artifact.content_hash,
      observed_path: observedPath,
      custody_mode: artifact.custody_mode,
      label: input.label,
      note: input.note,
      metadata: input.metadata,
    };
  } else {
    // managed: always materialize a durable CAS snapshot (custody managed), even
    // for a `ref` — resolving a ref alone could pin a link/repo/external artifact
    // whose bytes later drift or disappear, defeating managed durability.
    if (input.ref) {
      const resolved = resolveArtifactRef(db, input.ref, now).artifact;
      if (!resolved) throw new Error(`managed version ref did not resolve: ${input.ref}`);
      const bytes = readArtifactBytesFull(db, resolved.id);
      if (!bytes.ok) {
        throw new Error(`managed version ref bytes are not materializable (${bytes.reason}); cannot snapshot`);
      }
      artifact = snapshotArtifactBytes(db, {
        content_buffer: bytes.bytes,
        custody_mode: "managed",
        media_type: input.media_type ?? resolved.media_type ?? undefined,
        role: input.role ?? resolved.role ?? undefined,
        logical_name: input.logical_name ?? asString(resolved.metadata.logical_name) ?? asString(resolved.metadata.filename),
        metadata: mergeJsonRecords(input.metadata, { recoverability: "mandible_cas", managed_from_ref: input.ref }),
      }, now, artifactRoot);
    } else if (input.path || typeof input.content === "string" || typeof input.content_base64 === "string" || "json" in input) {
      artifact = snapshotArtifactBytes(db, {
        path: input.path,
        content: input.content,
        content_base64: input.content_base64,
        ...("json" in input ? { json: input.json } : {}),
        role: input.role,
        media_type: input.media_type,
        logical_name: input.logical_name,
        custody_mode: (input.custody_mode === "copy" ? "copy" : "managed"),
        metadata: mergeJsonRecords(input.metadata, { recoverability: "mandible_cas" }),
      }, now, artifactRoot);
    } else {
      throw new Error("managed version requires a path, content, content_base64, json, or ref");
    }
    const logicalName = input.logical_name ?? asString(artifact.metadata.logical_name) ?? asString(artifact.metadata.filename);
    // Scope the default managed series key by an explicit namespace so unrelated
    // artifacts that merely share a logical_name do not silently share a series.
    const namespace = asString(input.provider_id) ?? asString(input.repo_id) ?? asString(input.issue);
    let seriesKey = input.series_key;
    if (!seriesKey) {
      if (!logicalName) {
        throw new Error("managed version requires logical_name or series_key to identify the series");
      }
      if (!namespace) {
        throw new Error(
          `managed version requires an explicit series_key (or a provider_id/repo_id/issue namespace) so unrelated artifacts named '${logicalName}' do not share a series`,
        );
      }
      const components = [namespace, ...(input.role ? [input.role] : []), logicalName];
      seriesKey = `managed:${components.map(escapeSeriesKeyComponent).join(":")}`;
    }
    seriesInput = {
      series_key: seriesKey,
      source_kind: "managed",
      title: input.title,
      repo_id: input.repo_id,
      logical_name: logicalName ?? undefined,
      metadata: input.metadata,
    };
    versionInput = {
      artifact_id: artifact.id,
      source_kind: "managed",
      content_hash: artifact.content_hash,
      // Records the managed intent of this version. The shared immutable content
      // row may report a different custody_mode when these exact bytes were
      // first registered another way (content-addressed dedup) — but the bytes
      // are durably in CAS, so the version is materializable regardless.
      custody_mode: "managed",
      label: input.label,
      note: input.note,
      metadata: input.metadata,
    };
  }

  // Atomic ensure-series + append-version (+ counter update inside append) and
  // mirror into the v91 artifact identity tables when they are present.
  const write = db.transaction(() => {
    const series = ensureArtifactSeries(db, seriesInput, now);
    const appended = appendArtifactVersion(db, { ...versionInput, series_id: series.id }, now);
    const storedSeries = getArtifactSeries(db, series.id) as ArtifactSeriesRecord;
    const storedArtifact = getArtifact(db, artifact.id) as ArtifactRecord;
    mirrorLegacyVersionIdentity(db, storedSeries, appended.version, storedArtifact, now);
    return { series: storedSeries, artifact: storedArtifact, ...appended };
  });
  const { series, version, artifact: storedArtifact, created } = write.immediate();
  return {
    series,
    version,
    artifact: storedArtifact,
    created,
    warnings: Array.from(new Set(warnings)),
  };
}

// Flexible history resolver for read surfaces. Public callers use canonical
// logical artifact refs, artifact-version refs, or another non-legacy artifact
// ref that resolves to an already-registered immutable artifact. Old
// artifact-series/hash refs are repair inputs only and are not accepted here.
export function resolveArtifactVersionHistory(db: Db, ref: string): ArtifactVersionHistory | null {
  if (!artifactVersioningTablesExist(db)) return null;
  const trimmed = ref.trim();
  let series: ArtifactSeriesRecord | null = null;
  if (/^artifact-series:/i.test(trimmed) || /^artifact:sha256:/i.test(trimmed) || /^sha256:/i.test(trimmed) || /^[a-f0-9]{7,64}$/i.test(trimmed)) {
    return null;
  }
  if (/^artifact-version:/i.test(trimmed)) {
    const resolved = resolveArtifactVersionRef(db, trimmed, Date.now());
    if (resolved.series) {
      series = resolved.series;
    } else if (resolved.version) {
      series = getArtifactSeries(db, resolved.version.series_id);
    }
  }
  if (!series) {
    // Read-only: this GET endpoint must not materialize registry rows.
    const resolved = resolveArtifactRefReadonly(db, trimmed);
    if (resolved) {
      series = primarySeriesForArtifact(db, resolved.id);
    }
  }
  if (!series) return null;
  return { series, versions: listArtifactVersions(db, series.id), links: listArtifactSeriesLinks(db, series.id) };
}

// Non-mutating ref resolution for read-only surfaces (history/diff GETs). Unlike
// resolveArtifactRef, this NEVER materializes artifact rows, aliases, or graph
// entities: it resolves version/series refs and looks up already-registered
// artifacts/aliases only. Returns null for an unregistered ref.
export function resolveArtifactRefReadonly(db: Db, ref: string): ArtifactRecord | null {
  return resolveArtifactRefReadonlyFull(db, ref).artifact;
}

export function resolveArtifactRefReadonlyFull(db: Db, ref: string): ArtifactResolveResult {
  const trimmed = ref.trim();
  const identityResolution = resolveArtifactIdentityRef(db, trimmed);
  if (identityResolution) return identityResolution;
  if (/^artifact-version:/i.test(trimmed)) {
    return resolveArtifactVersionRef(db, trimmed, Date.now());
  }
  const normalized = normalizeRef(trimmed, { db, validateRepo: true });
  const direct = getArtifact(db, trimmed);
  if (direct) {
    return {
      status: "resolved",
      ref,
      scheme: normalized.scheme,
      normalized_ref: direct.id,
      artifact: direct,
      alias: null,
      series: null,
      version: null,
      warnings: [],
    };
  }
  if (normalized.invalidReason) {
    return {
      status: "unsupported",
      ref,
      scheme: normalized.scheme,
      normalized_ref: normalized.normalizedRef,
      artifact: null,
      alias: null,
      series: null,
      version: null,
      warnings: [normalized.invalidReason],
    };
  }
  if (tableExists(db, "artifact_aliases")) {
    const alias = getArtifactAlias(db, normalized.scheme, normalized.normalizedRef);
    if (alias?.artifact_id) {
      const artifact = getArtifact(db, alias.artifact_id);
      return {
        status: artifact ? "resolved" : "unresolved",
        ref,
        scheme: normalized.scheme,
        normalized_ref: alias.normalized_ref,
        artifact,
        alias,
        series: null,
        version: null,
        warnings: [],
      };
    }
  }
  return {
    status: "unresolved",
    ref,
    scheme: normalized.scheme,
    normalized_ref: normalized.normalizedRef,
    artifact: null,
    alias: null,
    series: null,
    version: null,
    warnings: [],
  };
}

// Resolve artifact-version: refs to their pinned immutable artifact.
function resolveArtifactVersionRef(db: Db, ref: string, _now: number): ArtifactResolveResult {
  const base: Omit<ArtifactResolveResult, "status" | "artifact" | "warnings"> = {
    ref,
    scheme: schemeFromRef(ref),
    normalized_ref: ref,
    alias: null,
    series: null,
    version: null,
  };
  if (!artifactVersioningTablesExist(db)) {
    return { ...base, status: "unsupported", artifact: null, warnings: ["artifact_versioning_unavailable"] };
  }

  if (!/^artifact-version:/i.test(ref)) {
    return { ...base, status: "unsupported", artifact: null, warnings: ["invalid_artifact_version_ref"] };
  }
  const versionLookup = resolveArtifactVersionPrefix(db, ref);
  if (versionLookup.status !== "resolved") {
    const warnings = versionLookup.status === "unsupported"
      ? ["artifact_version_prefix_too_short"]
      : [`artifact_version_${versionLookup.status}`];
    return { ...base, status: versionLookup.status, artifact: null, warnings };
  }
  const selected = versionLookup.value;
  const artifact = getArtifact(db, selected.artifact_id);
  const series = getArtifactSeries(db, selected.series_id);
  return {
    ...base,
    normalized_ref: selected.id,
    status: artifact ? "resolved" : "unresolved",
    artifact,
    series,
    version: selected,
    warnings: [],
  };
}

export function resolveArtifactRef(db: Db, ref: string, now = Date.now()): ArtifactResolveResult {
  const trimmedRef = ref.trim();
  const identityResolution = resolveArtifactIdentityRef(db, trimmedRef);
  if (identityResolution) return identityResolution;
  if (/^artifact-version:/i.test(trimmedRef)) {
    return resolveArtifactVersionRef(db, trimmedRef, now);
  }
  const normalized = normalizeRef(ref, { db, validateRepo: true });

  if (normalized.invalidReason || !isRegisterableArtifactRef(ref)) {
    return {
      status: "unsupported",
      ref,
      scheme: normalized.scheme,
      normalized_ref: normalized.normalizedRef,
      artifact: null,
      alias: null,
    };
  }

  const existing = tableExists(db, "artifact_aliases")
    ? getArtifactAlias(db, normalized.scheme, normalized.normalizedRef)
    : null;
  let artifact = existing?.artifact_id ? getArtifact(db, existing.artifact_id) : null;
  let alias = existing;
  if (!artifact) {
    const materialized = materializeReferenceArtifact(db, ref, now);
    artifact = materialized.artifact;
    alias = materialized.alias;
  }
  return {
    status: alias?.resolution_status ?? "resolved",
    ref,
    scheme: normalized.scheme,
    normalized_ref: normalized.normalizedRef,
    artifact,
    alias: alias as ArtifactAliasRecord,
  };
}

export function getProviderManifest(db: Db, id: string): ProviderManifestRecord | null {
  const row = db.prepare(
    `SELECT id, provider_id, manifest_type, version, content_hash, artifact_id,
            source, content_json, created_at
       FROM provider_manifests WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? manifestFromRow(row) : null;
}

export function getProviderDetail(db: Db, id: string): {
  provider: ProviderRecord;
  manifests: ProviderManifestRecord[];
  artifacts: ArtifactRecord[];
} | null {
  const provider = getProvider(db, id);
  if (!provider) return null;
  const manifests = (db.prepare(
    `SELECT id, provider_id, manifest_type, version, content_hash, artifact_id,
            source, content_json, created_at
       FROM provider_manifests
      WHERE provider_id = ?
      ORDER BY created_at DESC`
  ).all(id) as Array<Record<string, unknown>>).map(manifestFromRow);
  const artifacts = (db.prepare(
    `SELECT id, algorithm, content_hash, uri, media_type, role, size_bytes,
            provider_id, manifest_id, metadata_json, pinned, custody_mode,
            home_repo_id, repo_locator_json, availability, retention_json,
            reference_json, created_at
       FROM artifacts
      WHERE provider_id = ?
      ORDER BY created_at DESC`
  ).all(id) as Array<Record<string, unknown>>).map(artifactFromRow);
  return { provider, manifests, artifacts };
}

function providerFromRow(row: Record<string, unknown>): ProviderRecord {
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    version: row.version === null ? null : String(row.version),
    status: String(row.status),
    transport: String(row.transport),
    endpoint: row.endpoint === null ? null : String(row.endpoint),
    capabilities: parseJsonRecord(row.capabilities_json as string),
    actions: parseJsonArray<GraphAction>(row.actions_json as string),
    source: String(row.source),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

function artifactFromRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    algorithm: String(row.algorithm),
    content_hash: String(row.content_hash),
    uri: String(row.uri),
    media_type: row.media_type === null ? null : String(row.media_type),
    role: row.role === null ? null : String(row.role),
    size_bytes: Number(row.size_bytes),
    provider_id: row.provider_id === null ? null : String(row.provider_id),
    manifest_id: row.manifest_id === null ? null : String(row.manifest_id),
    metadata: parseJsonRecord(row.metadata_json as string),
    pinned: Number(row.pinned) !== 0,
    custody_mode: asCustodyMode(row.custody_mode, "managed"),
    home_repo_id: row.home_repo_id === null || row.home_repo_id === undefined ? null : String(row.home_repo_id),
    repo_locator: parseJsonRecord(row.repo_locator_json as string),
    availability: asAvailability(row.availability, "unchecked"),
    retention: parseJsonRecord(row.retention_json as string),
    reference: parseJsonRecord(row.reference_json as string),
    created_at: Number(row.created_at),
  };
}

function asArtifactIdentitySourceKind(value: unknown): ArtifactIdentitySourceKind {
  const kind = String(value ?? "");
  return kind === "tracked_repo" || kind === "local_only" || kind === "managed" || kind === "external" || kind === "mixed"
    ? kind
    : "managed";
}

function asCanonicalVersionSourceKind(value: unknown): Exclude<ArtifactIdentitySourceKind, "mixed"> {
  const kind = String(value ?? "");
  return kind === "tracked_repo" || kind === "local_only" || kind === "managed" || kind === "external"
    ? kind
    : "managed";
}

function artifactBlobFromRow(row: Record<string, unknown>): ArtifactBlobRecord {
  return {
    id: String(row.id),
    algorithm: String(row.algorithm ?? "sha256"),
    content_hash: String(row.content_hash),
    storage_uri: row.storage_uri === null || row.storage_uri === undefined ? null : String(row.storage_uri),
    media_type: row.media_type === null || row.media_type === undefined ? null : String(row.media_type),
    role: row.role === null || row.role === undefined ? null : String(row.role),
    size_bytes: Number(row.size_bytes ?? 0),
    provider_id: row.provider_id === null || row.provider_id === undefined ? null : String(row.provider_id),
    manifest_id: row.manifest_id === null || row.manifest_id === undefined ? null : String(row.manifest_id),
    metadata: parseJsonRecord(row.metadata_json as string),
    custody_mode: asCustodyMode(row.custody_mode, "managed"),
    availability: asAvailability(row.availability, "unchecked"),
    retention: parseJsonRecord(row.retention_json as string),
    reference: parseJsonRecord(row.reference_json as string),
    created_at: Number(row.created_at),
  };
}

function artifactIdentityFromRow(row: Record<string, unknown>): ArtifactIdentityRecord {
  return {
    id: String(row.id),
    identity_key: String(row.identity_key),
    source_kind: asArtifactIdentitySourceKind(row.source_kind),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    source_project_id: row.source_project_id === null || row.source_project_id === undefined
      ? null
      : String(row.source_project_id),
    source_repo_id: row.source_repo_id === null || row.source_repo_id === undefined ? null : String(row.source_repo_id),
    logical_name: row.logical_name === null || row.logical_name === undefined ? null : String(row.logical_name),
    source_path: row.source_path === null || row.source_path === undefined ? null : String(row.source_path),
    latest_version_id: row.latest_version_id === null || row.latest_version_id === undefined
      ? null
      : String(row.latest_version_id),
    version_count: Number(row.version_count ?? 0),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function canonicalArtifactVersionFromRow(row: Record<string, unknown>): CanonicalArtifactVersionRecord {
  return {
    id: String(row.id),
    artifact_id: String(row.artifact_id),
    version_no: Number(row.version_no),
    blob_id: String(row.blob_id),
    source_kind: asCanonicalVersionSourceKind(row.source_kind),
    content_hash: String(row.content_hash),
    source_project_id: row.source_project_id === null || row.source_project_id === undefined
      ? null
      : String(row.source_project_id),
    source_repo_id: row.source_repo_id === null || row.source_repo_id === undefined ? null : String(row.source_repo_id),
    repo_path: row.repo_path === null || row.repo_path === undefined ? null : String(row.repo_path),
    commit_sha: row.commit_sha === null || row.commit_sha === undefined ? null : String(row.commit_sha),
    observed_path: row.observed_path === null || row.observed_path === undefined ? null : String(row.observed_path),
    source_locator: parseJsonRecord(row.source_locator_json as string),
    custody_mode: row.custody_mode === null || row.custody_mode === undefined
      ? null
      : asCustodyMode(row.custody_mode, "managed"),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
  };
}

function projectArtifactAssociationFromRow(row: Record<string, unknown>): ProjectArtifactAssociationRecord {
  const targetType = row.target_type === "artifact_version" ? "artifact_version" : "artifact";
  const associationKind = row.association_kind === "canonical" ? "canonical" : "associated";
  const status = row.status === "superseded" || row.status === "archived" ? row.status : "active";
  const source =
    row.source === "user" ||
    row.source === "space_rule" ||
    row.source === "migration" ||
    row.source === "system"
      ? row.source
      : "agent_explicit";
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    target_type: targetType,
    target_id: String(row.target_id),
    association_kind: associationKind,
    role: String(row.role ?? ""),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    status,
    source,
    source_ref_type: row.source_ref_type === null || row.source_ref_type === undefined
      ? null
      : String(row.source_ref_type),
    source_ref_id: row.source_ref_id === null || row.source_ref_id === undefined ? null : String(row.source_ref_id),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function summaryArtifactFromRow(row: Record<string, unknown>): ArtifactRecord {
  const artifact = artifactFromRow(row);
  artifact.metadata = summaryArtifactMetadata(artifact.metadata);
  artifact.repo_locator = summaryRepoLocator(artifact.repo_locator);
  artifact.retention = {};
  artifact.reference = {};
  return artifact;
}

function summaryArtifactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["title", "filename", "logical_name"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      summary[key] = value;
    }
  }
  return summary;
}

function summaryRepoLocator(locator: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["repo_id", "ref", "path", "local_only"]) {
    const value = locator[key];
    if (typeof value === "string" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary;
}

function artifactAliasFromRow(row: Record<string, unknown>): ArtifactAliasRecord {
  const status = String(row.resolution_status);
  return {
    id: String(row.id),
    artifact_id: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
    scheme: String(row.scheme),
    alias: String(row.alias),
    normalized_ref: String(row.normalized_ref),
    locator: parseJsonRecord(row.locator_json as string),
    resolution_status:
      status === "resolved" || status === "unresolved" || status === "ambiguous" || status === "unsupported"
        ? status
        : "unresolved",
    source: String(row.source),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function artifactLinkFromRow(row: Record<string, unknown>): ArtifactLinkRecord {
  return {
    id: String(row.id),
    artifact_id: String(row.artifact_id),
    entity_type: String(row.entity_type),
    entity_id: String(row.entity_id),
    link_type: String(row.link_type),
    role: row.role === null || row.role === undefined ? null : String(row.role),
    repo_id: row.repo_id === null || row.repo_id === undefined ? null : String(row.repo_id),
    provider_id: row.provider_id === null || row.provider_id === undefined ? null : String(row.provider_id),
    source: String(row.source),
    metadata: parseJsonRecord(row.metadata_json as string),
    link_kind: row.link_kind === "living" ? "living" : "pinned",
    series_id: row.series_id === null || row.series_id === undefined ? null : String(row.series_id),
    series_ref: row.series_ref === null || row.series_ref === undefined ? null : String(row.series_ref),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function attachArtifactAliasSchemes(db: Db, artifacts: ArtifactRecord[]): void {
  if (artifacts.length === 0 || !tableExists(db, "artifact_aliases")) return;
  const placeholders = artifacts.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT artifact_id, scheme
       FROM artifact_aliases
      WHERE artifact_id IN (${placeholders})
      GROUP BY artifact_id, scheme
      ORDER BY scheme`
  ).all(...artifacts.map((artifact) => artifact.id)) as Array<{ artifact_id: string; scheme: string }>;
  const byArtifact = new Map<string, Set<string>>();
  for (const row of rows) {
    const artifactId = String(row.artifact_id);
    const scheme = String(row.scheme);
    const schemes = byArtifact.get(artifactId) ?? new Set<string>();
    schemes.add(scheme);
    byArtifact.set(artifactId, schemes);
  }
  for (const artifact of artifacts) {
    const schemes = byArtifact.get(artifact.id);
    if (schemes?.size) {
      artifact.alias_schemes = [...schemes].sort();
    }
  }
}

function listArtifactAliases(db: Db, artifactId: string): ArtifactAliasRecord[] {
  const rows = db.prepare(
    `SELECT id, artifact_id, scheme, alias, normalized_ref, locator_json,
            resolution_status, source, created_at, updated_at
       FROM artifact_aliases
      WHERE artifact_id = ?
      ORDER BY scheme, normalized_ref`
  ).all(artifactId) as Array<Record<string, unknown>>;
  return rows.map(artifactAliasFromRow);
}

function listArtifactLinks(db: Db, artifactId: string): ArtifactLinkRecord[] {
  const rows = db.prepare(
    `SELECT id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_id, series_ref,
            created_at, updated_at
       FROM artifact_links
      WHERE artifact_id = ?
      ORDER BY entity_type, entity_id, link_type, role`
  ).all(artifactId) as Array<Record<string, unknown>>;
  return rows.map(artifactLinkFromRow);
}

function listArtifactSeriesLinks(db: Db, seriesId: string): ArtifactLinkRecord[] {
  if (!tableExists(db, "artifact_links")) return [];
  const rows = db.prepare(
    `SELECT id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_id, series_ref,
            created_at, updated_at
       FROM artifact_links
      WHERE series_id = ?
      ORDER BY entity_type, entity_id, link_type, role`
  ).all(seriesId) as Array<Record<string, unknown>>;
  return rows.map(artifactLinkFromRow);
}

function listArtifactSeriesLinksForSeries(db: Db, seriesIds: string[]): Map<string, ArtifactLinkRecord[]> {
  const linksBySeriesId = new Map<string, ArtifactLinkRecord[]>();
  if (seriesIds.length === 0 || !tableExists(db, "artifact_links")) return linksBySeriesId;
  const uniqueSeriesIds = [...new Set(seriesIds)];
  const placeholders = uniqueSeriesIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_id, series_ref,
            created_at, updated_at
       FROM artifact_links
      WHERE series_id IN (${placeholders})
      ORDER BY series_id, entity_type, entity_id, link_type, role`
  ).all(...uniqueSeriesIds) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const seriesId = row.series_id === null || row.series_id === undefined ? null : String(row.series_id);
    if (!seriesId) continue;
    const links = linksBySeriesId.get(seriesId) ?? [];
    links.push(artifactLinkFromRow(row));
    linksBySeriesId.set(seriesId, links);
  }
  return linksBySeriesId;
}

function manifestFromRow(row: Record<string, unknown>): ProviderManifestRecord {
  return {
    id: String(row.id),
    provider_id: String(row.provider_id),
    manifest_type: String(row.manifest_type),
    version: row.version === null ? null : String(row.version),
    content_hash: String(row.content_hash),
    artifact_id: row.artifact_id === null ? null : String(row.artifact_id),
    source: String(row.source),
    content: parseJsonRecord(row.content_json as string),
    created_at: Number(row.created_at),
  };
}

function nodeFromRow(row: GraphEntityRow): GraphNode {
  const summary = parseJsonRecord(row.summary_json);
  const detail = parseJsonRecord(row.detail_ref_json);
  return {
    id: row.id,
    type: row.entity_type,
    label: row.title,
    status: row.status ?? undefined,
    labels: parseJsonArray<string>(row.labels_json),
    repo_id: row.repo_id ?? undefined,
    repo: row.repo_id ?? undefined,
    provider_id: row.provider_id ?? undefined,
    created_at: isoFromMs(row.created_at ?? row.observed_at),
    updated_at: isoFromMs(row.updated_at ?? row.observed_at),
    summary,
    detail,
    metrics: asRecord(summary.metrics) as Record<string, number | string | boolean>,
    visual: parseJsonRecord(row.visual_json),
    actions: parseJsonArray<GraphAction>(row.action_context_json),
    source: row.source,
  };
}

function edgeFromRow(row: GraphEdgeRow): GraphEdge {
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    type: row.edge_type,
    edge_class: row.edge_class,
    provenance: row.provenance,
    confidence: row.confidence,
    metadata: parseJsonRecord(row.metadata_json),
  };
}

export function getIndexedGraph(db: Db, options: IndexedGraphOptions): IndexedGraphResult {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const entityTypes = MODE_ENTITY_TYPES[options.mode];
  const where: string[] = [];
  const bindings: Record<string, unknown> = { limit };
  if (entityTypes) {
    where.push(`entity_type IN (${entityTypes.map((_, i) => `@type${i}`).join(", ")})`);
    entityTypes.forEach((type, i) => {
      bindings[`type${i}`] = type;
    });
  }
  if (options.providerId) {
    where.push("provider_id = @providerId");
    bindings.providerId = options.providerId;
  }
  if (options.mode === "provenance") {
    where.push(`id IN (
      SELECT source_id FROM graph_edges WHERE edge_class = 'provenance'
      UNION
      SELECT target_id FROM graph_edges WHERE edge_class = 'provenance'
    )`);
  }
  if (options.root) {
    where.push(`id IN (
      SELECT source_id FROM graph_edges WHERE target_id = @root
      UNION SELECT target_id FROM graph_edges WHERE source_id = @root
      UNION SELECT @root
    )`);
    bindings.root = options.root;
  }

  const sql = `
    SELECT id, entity_type, repo_id, provider_id, external_id, title, status,
           labels_json, summary_json, detail_ref_json, action_context_json,
           visual_json, created_at, updated_at, observed_at, source
      FROM graph_entities
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY observed_at DESC
     LIMIT @limit
  `;
  const rows = db.prepare(sql).all(bindings) as GraphEntityRow[];
  const nodes = rows.map(nodeFromRow);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size === 0) {
    return { nodes, edges: [] };
  }
  const ids = Array.from(nodeIds);
  const idPlaceholders = ids.map(() => "?").join(", ");
  const edgeRows = db.prepare(
    `SELECT id, source_id, target_id, edge_type, edge_class, provenance,
            confidence, metadata_json, created_at, observed_at, source
       FROM graph_edges
      WHERE source_id IN (${idPlaceholders})
        AND target_id IN (${idPlaceholders})
      ORDER BY observed_at DESC
      LIMIT ?`
  ).all(...ids, ...ids, Math.max(limit * 4, 100)) as GraphEdgeRow[];
  return { nodes, edges: edgeRows.map(edgeFromRow) };
}

export function getIndexedGraphCount(db: Db, mode: GraphMode): number {
  const entityTypes = MODE_ENTITY_TYPES[mode];
  if (!entityTypes) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM graph_entities").get() as { count: number };
    return row.count;
  }
  const placeholders = entityTypes.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM graph_entities WHERE entity_type IN (${placeholders})`
  ).get(...entityTypes) as { count: number };
  return row.count;
}
