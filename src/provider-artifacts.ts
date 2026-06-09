import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import type {
  ArtifactAliasRecord,
  ArtifactBundleMemberRecord,
  ArtifactBundleRecord,
  ArtifactGitState,
  ArtifactLinkRecord,
  ArtifactRecord,
  ArtifactRecoverability,
  ArtifactResolveResult,
  GraphAction,
  GraphEdge,
  GraphMode,
  GraphNode,
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

function contentBuffer(input: ArtifactInput): Buffer {
  if (typeof input.content_base64 === "string") {
    return Buffer.from(input.content_base64, "base64");
  }
  if (typeof input.content === "string") {
    return Buffer.from(input.content, "utf8");
  }
  if ("json" in input) {
    return Buffer.from(stableJsonStringify(input.json), "utf8");
  }
  throw new Error("artifact content, content_base64, or json is required");
}

function hasInlineArtifactContent(input: ArtifactInput): boolean {
  return typeof input.content_base64 === "string" || typeof input.content === "string" || "json" in input;
}

function hashFromArtifactRef(input: ArtifactInput): string | undefined {
  if (isSha256(input.sha256)) {
    return input.sha256.toLowerCase();
  }
  if (!input.artifact_id) return undefined;
  const match = /^(?:artifact:sha256:|artifact:)([a-f0-9]{64})$/i.exec(input.artifact_id.trim());
  return match?.[1]?.toLowerCase();
}

function artifactHashFromRef(ref: string): string | undefined {
  const match = /^(?:artifact:sha256:|artifact:)([a-f0-9]{64})$/i.exec(ref.trim());
  return match?.[1]?.toLowerCase();
}

type ArtifactHashRefParse =
  | { kind: "full"; hash: string; prefix: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "too_short"; prefix: string }
  | { kind: "invalid"; prefix: string };

const MIN_ARTIFACT_HASH_PREFIX_LENGTH = 7;

function artifactHashRefFromRef(ref: string): ArtifactHashRefParse | null {
  const trimmed = ref.trim();
  const match = /^(?:artifact:)?([a-f0-9]+)$/i.exec(trimmed);
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

function isDeprecatedArtifactHashSyntax(ref: string): boolean {
  return /^(?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)[a-f0-9]{7,64}$/i.test(ref.trim());
}

function schemeFromRef(ref: string): string {
  const trimmed = ref.trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return schemeMatch ? schemeMatch[1].toLowerCase() : "unknown";
}

function normalizeRef(ref: string): {
  scheme: string;
  alias: string;
  normalizedRef: string;
  locator: JsonRecord;
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
    const repoId = repoMatch[1];
    const refName = repoMatch[2];
    const repoPath = repoMatch[3].replace(/^\/+/, "");
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
  const normalized = normalizeRef(args.ref);
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
  const id = artifactRegistryId("artifact_link", [artifactId, entityType, entityId, linkType, role ?? ""]);
  db.prepare(
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id, link_type, role, repo_id,
      provider_id, source, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @artifact_id, @entity_type, @entity_id, @link_type, @role, @repo_id,
      @provider_id, @source, @metadata_json, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      repo_id = COALESCE(excluded.repo_id, artifact_links.repo_id),
      provider_id = COALESCE(excluded.provider_id, artifact_links.provider_id),
      source = excluded.source,
      metadata_json = excluded.metadata_json,
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
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function repoInfoForRoot(db: Db, root: string): { repo_id: string | null; name: string | null } {
  const realRoot = path.resolve(root);
  const rootCandidates = Array.from(new Set([
    realRoot,
    (() => {
      try {
        return fs.realpathSync(realRoot);
      } catch {
        return realRoot;
      }
    })(),
  ]));
  if (tableExists(db, "ledger_project_checkouts")) {
    const row = db.prepare(
      `SELECT work_repo_id, name
         FROM ledger_project_checkouts
        WHERE root IN (${rootCandidates.map(() => "?").join(", ")})
        ORDER BY updated_at DESC
        LIMIT 1`,
    ).get(...rootCandidates) as { work_repo_id: string | null; name: string | null } | undefined;
    if (row) return { repo_id: row.work_repo_id ?? row.name ?? null, name: row.name ?? null };
  }
  if (tableExists(db, "work_repos")) {
    const row = db.prepare(
      `SELECT id, name
         FROM work_repos
        WHERE root IN (${rootCandidates.map(() => "?").join(", ")})
        LIMIT 1`,
    ).get(...rootCandidates) as { id: string | null; name: string | null } | undefined;
    if (row) return { repo_id: row.id ?? row.name ?? null, name: row.name ?? null };
  }
  return { repo_id: path.basename(realRoot), name: path.basename(realRoot) };
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
  const gitState = classifyLocalArtifactPath(db, absolutePath);
  const requestedCustody = asCustodyMode(input.custody_mode, "link");
  const { recoverability, warnings } = recoverabilityForLocalPath(gitState, input, requestedCustody);
  if (recoverability === "repo_worktree" && !input.allow_dirty_link && requestedCustody === "link") {
    warnings.push("dirty_link_requires_override_for_issue_evidence");
  }
  if (recoverability === "local_only" && !input.allow_local_only && requestedCustody === "link") {
    warnings.push("local_only_link_requires_override_for_issue_evidence");
  }

  const hash = hashBuffer(fs.readFileSync(absolutePath));
  const repoLocator = gitState.inside_worktree && gitState.repo_id && gitState.relative_path
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
  const uri = recoverability === "repo_commit" && repoUri
    ? repoUri
    : `file://${absolutePath}`;
  const metadata = mergeJsonRecords(input.metadata, {
    filename: input.filename ?? path.basename(absolutePath),
    logical_name: input.logical_name ?? gitState.relative_path ?? path.basename(absolutePath),
    recoverability,
    git_state: gitState,
    warnings,
    source_path: absolutePath,
  });
  const reference = mergeJsonRecords(input.reference, {
    owner_system: recoverability.startsWith("repo_") ? "repo" : "local",
    recoverability,
    git_state: gitState,
    regenerable_from: input.regenerable_from,
  });
  const artifact = ingestArtifact(db, {
    sha256: hash,
    uri,
    role: input.role,
    media_type: input.media_type ?? mediaTypeForPath(absolutePath),
    filename: input.filename ?? path.basename(absolutePath),
    logical_name: input.logical_name ?? gitState.relative_path ?? path.basename(absolutePath),
    size_bytes: stat.size,
    custody_mode: requestedCustody,
    home_repo_id: gitState.repo_id ?? undefined,
    repo_locator: repoLocator,
    availability: "present",
    retention: { recoverability },
    reference,
    metadata,
    pinned: input.pinned,
    ...(requestedCustody === "copy" || requestedCustody === "managed"
      ? { content_base64: fs.readFileSync(absolutePath).toString("base64") }
      : {}),
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
      metadata: { warnings, recoverability, source_path: absolutePath },
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
  const issueResolution = entityType === "issue"
    ? resolveIssueEntity(db, rawEntityId, asString(input.issue_project) ?? asString(input.repo_id))
    : null;
  const link = registerArtifactLink(db, resolution.artifact.id, {
    entity_type: entityType,
    entity_id: issueResolution?.entity_id ?? rawEntityId,
    link_type: asString(input.link_type) ?? "references",
    role: asString(input.role),
    repo_id: asString(input.repo_id),
    provider_id: asString(input.provider_id),
    source: asString(input.source) ?? "artifact_link",
    metadata: mergeJsonRecords(input.metadata, issueResolution?.metadata, {
      artifact_ref: ref,
      normalized_ref: resolution.normalized_ref,
    }),
  }, now);
  return { resolution, link };
}

function bufferFromSnapshotInput(input: ArtifactSnapshotInput): Buffer {
  if (typeof input.path === "string" && input.path.trim()) {
    return fs.readFileSync(path.resolve(expandHomePath(input.path)));
  }
  if (typeof input.content_base64 === "string") return Buffer.from(input.content_base64, "base64");
  if (typeof input.content === "string") return Buffer.from(input.content, "utf8");
  if ("json" in input) return Buffer.from(stableJsonStringify(input.json), "utf8");
  throw new Error("snapshot path, content, content_base64, or json is required");
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
    content_base64: bytes.toString("base64"),
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
      member_ref: member.ref ?? member.artifact_ref ?? member.path ?? artifact.id,
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
      ref: input.members[index].ref ?? input.members[index].artifact_ref ?? input.members[index].path ?? artifact.id,
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
      artifact_ref: `artifact:${bundle.content_hash}`,
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
            provider_id, source, metadata_json, created_at, updated_at
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
            provider_id, source, metadata_json, created_at, updated_at
       FROM artifact_links
      WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? artifactLinkFromRow(row) : null;
}

function registerHashPrefixAlias(
  db: Db,
  ref: string,
  prefix: string,
  status: "unresolved" | "ambiguous" | "unsupported",
  now: number,
): ArtifactAliasRecord {
  return registerArtifactAlias(db, {
    ref,
    locator: {
      algorithm: "sha256",
      prefix,
      min_prefix_length: MIN_ARTIFACT_HASH_PREFIX_LENGTH,
    },
    resolutionStatus: status,
    source: "artifact_resolver",
    now,
  });
}

function materializeReferenceArtifact(
  db: Db,
  ref: string,
  now = Date.now(),
): { artifact: ArtifactRecord; alias: ArtifactAliasRecord } {
  const normalized = normalizeRef(ref);
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

function materializeHashArtifact(
  db: Db,
  ref: string,
  hash: string,
  now = Date.now(),
): { artifact: ArtifactRecord; alias: ArtifactAliasRecord } {
  const id = `artifact:sha256:${hash}`;
  const normalizedRef = `artifact:${hash}`;
  const metadata = {
    title: normalizedRef,
    source_ref: ref,
    normalized_ref: normalizedRef,
    scheme: "artifact",
    identity_kind: "content_hash",
  };
  const reference = {
    owner_system: "artifact",
    identity_kind: "content_hash",
    normalized_ref: normalizedRef,
    content_identity: {
      algorithm: "sha256",
      hash,
      artifact_uri: id,
    },
  };

  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, pinned, custody_mode, home_repo_id,
      repo_locator_json, availability, retention_json, reference_json, created_at
    ) VALUES (
      @id, 'sha256', @content_hash, @uri, NULL, 'content_reference', 0,
      NULL, NULL, @metadata_json, 0, 'external', NULL,
      '{}', 'remote_only', @retention_json, @reference_json, @created_at
    )
    ON CONFLICT(algorithm, content_hash) DO UPDATE SET
      uri = COALESCE(artifacts.uri, excluded.uri),
      reference_json = CASE
        WHEN artifacts.reference_json = '{}' THEN excluded.reference_json
        ELSE artifacts.reference_json
      END`
  ).run({
    id,
    content_hash: hash,
    uri: normalizedRef,
    metadata_json: jsonStringify(metadata),
    retention_json: jsonStringify({ pinned: false }),
    reference_json: jsonStringify(reference),
    created_at: now,
  });

  upsertGraphEntity(db, {
    id,
    entity_type: "artifact",
    external_id: hash,
    title: normalizedRef,
    status: "remote_only",
    summary: {
      role: "content_reference",
      media_type: null,
      size_bytes: 0,
      custody_mode: "external",
      availability: "remote_only",
      scheme: "artifact",
      identity_kind: "content_hash",
    },
    detail: {
      uri: normalizedRef,
      content_hash: hash,
      metadata,
      artifact_id: id,
      custody: {
        mode: "external",
        home_repo_id: null,
        repo_locator: {},
        availability: "remote_only",
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
    locator: { algorithm: "sha256", hash },
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
  let uri = input.uri ?? input.artifact_id ?? `artifact:${hash}`;
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
      ref: `artifact:${hash}`,
      source: "artifact_identity",
      now,
    });
    if (input.artifact_id && input.artifact_id !== id && !isDeprecatedArtifactHashSyntax(input.artifact_id)) {
      registerArtifactAlias(db, {
        artifactId: id,
        ref: input.artifact_id,
        source: "artifact_input",
        now,
      });
    }
    if (uri && !isDeprecatedArtifactHashSyntax(uri)) {
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

  return getArtifact(db, id) as ArtifactRecord;
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
  return (db.prepare(sql).all(bindings) as Array<Record<string, unknown>>).map((row) => {
    const artifact = artifactFromRow(row);
    if (artifactAliasTablesExist(db)) {
      artifact.aliases = listArtifactAliases(db, artifact.id);
      artifact.links = listArtifactLinks(db, artifact.id);
    }
    return artifact;
  });
}

export function resolveArtifactRef(db: Db, ref: string, now = Date.now()): ArtifactResolveResult {
  if (isDeprecatedArtifactHashSyntax(ref)) {
    const trimmed = ref.trim();
    return {
      status: "unsupported",
      ref,
      scheme: schemeFromRef(trimmed),
      normalized_ref: trimmed,
      artifact: null,
      alias: null,
    };
  }

  const normalized = normalizeRef(ref);
  const hashRef = artifactHashRefFromRef(ref);
  if (hashRef) {
    if (hashRef.kind === "too_short" || hashRef.kind === "invalid") {
      const alias = registerHashPrefixAlias(db, ref, hashRef.prefix, "unsupported", now);
      return {
        status: "unsupported",
        ref,
        scheme: normalized.scheme,
        normalized_ref: normalized.normalizedRef,
        artifact: null,
        alias,
      };
    }

    const hash = hashRef.kind === "full" ? hashRef.hash : null;
    if (hash) {
      let artifact = getArtifact(db, `artifact:sha256:${hash}`);
      if (!artifact) {
        const materialized = materializeHashArtifact(db, ref, hash, now);
        artifact = materialized.artifact;
        return {
          status: materialized.alias.resolution_status,
          ref,
          scheme: normalized.scheme,
          normalized_ref: normalized.normalizedRef,
          artifact,
          alias: materialized.alias,
        };
      }
      const alias = registerArtifactAlias(db, {
        artifactId: artifact.id,
        ref,
        source: "artifact_resolver",
        now,
      });
      return {
        status: alias.resolution_status,
        ref,
        scheme: normalized.scheme,
        normalized_ref: normalized.normalizedRef,
        artifact,
        alias,
      };
    }

    const matches = listArtifacts(db, { hashPrefix: hashRef.prefix, limit: 2 });
    if (matches.length === 1) {
      const alias = registerArtifactAlias(db, {
        artifactId: matches[0].id,
        ref,
        locator: {
          algorithm: "sha256",
          prefix: hashRef.prefix,
          resolved_hash: matches[0].content_hash,
        },
        source: "artifact_resolver",
        now,
      });
      return {
        status: alias.resolution_status,
        ref,
        scheme: normalized.scheme,
        normalized_ref: normalized.normalizedRef,
        artifact: matches[0],
        alias,
      };
    }
    const alias = registerHashPrefixAlias(
      db,
      ref,
      hashRef.prefix,
      matches.length > 1 ? "ambiguous" : "unresolved",
      now,
    );
    return {
      status: alias.resolution_status,
      ref,
      scheme: normalized.scheme,
      normalized_ref: normalized.normalizedRef,
      artifact: null,
      alias,
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
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
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
            provider_id, source, metadata_json, created_at, updated_at
       FROM artifact_links
      WHERE artifact_id = ?
      ORDER BY entity_type, entity_id, link_type, role`
  ).all(artifactId) as Array<Record<string, unknown>>;
  return rows.map(artifactLinkFromRow);
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
