import { artifactDescriptiveMetadata as descriptiveArtifactMetadata } from './artifact-metadata.js';
import { fileURLToPath } from "node:url";
import { artifactFailure, artifactSourceLineage, artifactRequiredProjects, getArtifactCurrentSource, lookupArtifactCurrentSource, sourceKey, validateArtifactSource, type ArtifactSource, type ArtifactLifecycleResult } from './artifact-source.js';
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import { columnExists, tableExists } from "./db-introspection.js";
import { mediaTypeForPath } from "./artifact-media-type.js";
import {
  readCommittedArtifactFiles, retainArtifactCommit, type CommittedArtifactFile,
} from "./artifact-commit-source.js";
import { resolveProjectRef } from "./ledger/project-registry.js";
import { resolveId, shortRef, type RefResolution } from "./entity-refs.js";
import { nullableNumber, nullableString, parseJsonOr } from "./row-coerce.js";
import {
  classifyArtifactRef,
  projectCanonicalArtifactRecord,
  resolvedArtifactRecord,
  artifactMaterializationTarget,
  DEFAULT_ARTIFACT_ID_PREFIX_LENGTH,
  emptyArtifactIdentityPayload,
  failedArtifactIdentity,
  formatCompactArtifactId,
  type ArtifactIdentityResolution,
  type ArtifactRequestedKind,
  type ArtifactResolutionMode,
  type CanonicalArtifactTargetType
} from "./artifact-identity.js";
import {
  readArtifactMaterial
} from "./artifact-materialization.js";
import { materializeArtifactFileIntoCas, readAndHashArtifactFile } from "./artifact-ingest-pool.js";
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
  ArtifactDraftRecord,
  ArtifactRecoverability,
  ArtifactSeriesSummary,
  ArtifactSeriesRecord,
  ArtifactSeriesSourceKind,
  ArtifactVersionHistory,
  ArtifactVersionRecord,
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
    "external_reference",
    "report",
  ],
  "artifact-lineage": [
    "provider_manifest",
    "run",
    "analysis",
    "model",
    "dataset",
    "artifact",
    "external_reference",
    "report",
  ],
};

type JsonRecord = Record<string, unknown>;
type ArtifactCustodyMode = "git" | "managed";
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

const VERIFIED_GIT_DESCRIPTOR = Symbol("verified-git-descriptor");

interface ArtifactInput {
  [VERIFIED_GIT_DESCRIPTOR]?: true;
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
  // Internal in-process handoff from the off-thread ingest pool (issue aadf45e).
  // `precomputed_sha256` skips the main-thread hashBuffer when the worker already
  // hashed the bytes. `cas_materialized` means the worker already wrote the
  // content-addressed copy for `precomputed_sha256`, so ingestArtifact should
  // treat the artifact as managed/present without reading or writing any bytes.
  precomputed_sha256?: string;
  cas_materialized?: boolean;
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
  resolution: ArtifactIdentityResolution;
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
  custody_mode?: "managed" | string;
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
  target_type?: "artifact" | "artifact_version" | "artifact_blob";
  target_id?: string;
  canonical_artifact_id?: string;
  canonical_version_id?: string;
  canonical_blob_id?: string;
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
  linkedTargetType?: "artifact" | "artifact_version" | "artifact_blob";
  linkedTargetId?: string;
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
  if (value === undefined || value === null) return fallback;
  if (value === "git" || value === "managed") return value;
  throw new Error("custody_mode must be git or managed");
}


function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonRecord(value: string | null | undefined): JsonRecord {
  return asRecord(parseJsonOr(value, {}));
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  const parsed = parseJsonOr<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
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

// Key order for artifact content addressing.
//
// Keys are compared by UTF-16 code unit, never with `localeCompare`. A content
// address must be a pure function of the value; `localeCompare` with no locale
// argument reads the host's default collation, so the same artifact JSON
// serialized on an en-US host and on a sv-SE host produced different bytes and
// therefore different ids ("ä" sorts beside "a" under en-US and after "z"
// under sv-SE).
//
// Deliberately NOT `canonicalJson` from ./canonical-json.js, despite the
// obvious family resemblance. That function builds its output string directly
// and so does not implement `JSON.stringify` semantics: it emits the bare token
// `undefined` for undefined/function/symbol values and holes in sparse arrays,
// and it ignores `toJSON`. For digest inputs, which is what it is for, an
// unparseable-but-deterministic string is harmless. Here the output is the
// artifact's stored bytes, so it has to be valid JSON that round-trips. Routing
// the final serialization through `JSON.stringify` keeps those semantics exact.
//
// One consequence of that round trip through an object literal: integer-like
// keys are emitted first, in ascending numeric order, whatever the sort said,
// because that is how JS orders own property keys. That ordering is fixed by
// the language rather than by the host, so addresses stay reproducible. Do not
// "correct" it — it would change the address of every artifact with a numeric
// key.
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function artifactPathForHash(hash: string, root = getArtifactRoot()): string {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

// Deterministic storage location for managed bytes; never a Git read fallback.
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
  const match = /^(?:artifact-blob:|artifact:sha256:)([a-f0-9]{64})$/i.exec(ref.trim());
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
    const resolution = options.db ? resolveProjectRef(options.db, inputRepoId) : null;
    if (resolution && !resolution.ok && options.validateRepo) {
      return {
        scheme: "repo",
        alias,
        normalizedRef: alias,
        locator: { repo_id: inputRepoId, ref: refName ?? null, path: repoPath },
        invalidReason: resolution.reason === "ambiguous" ? "ambiguous_repo" : "unknown_repo",
      };
    }
    const repoId = resolution?.ok ? resolution.project.project_key : inputRepoId;
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

function bindArtifactIdentifierSearch(
  bindings: Record<string, unknown>,
  query: string,
): void {
  const normalized = query.trim().toLowerCase();
  bindings.q = `%${escapeLike(query)}%`;
  bindings.qIdentifierFullPrefix = `${escapeLike(normalized)}%`;
  // Bare sidebar input (`de13`) matches the payload of any public typed ref.
  // An explicitly typed input keeps that type boundary through the full-ref
  // predicates below instead of also matching other identity kinds by payload.
  bindings.qIdentifierBarePrefix = /^artifact(?:-series|-version|-blob)?:/i.test(normalized)
    ? null
    : `${escapeLike(normalized)}%`;
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
  const resolved = resolveProjectRef(db, projectRef);
  return resolved.ok ? resolved.project.id : null;
}

function resolveProviderIssueRef(db: Db, issueRef: string, projectId: string | null): RefResolution {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_issue_aliases")) return { ok: false, error: "not_found" };
  return resolveId(db, "issue", issueRef, projectId ? { scope: projectId } : {});
}

function ledgerIssueGraphInfo(db: Db, issueId: string, providerId: string, rawRef: string, now: number): {
  nodeId: string;
  metadata: JsonRecord;
} | null {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_projects")) return null;
  const projectKeyExpr = columnExists(db, "ledger_projects", "project_key") ? "p.project_key" : "''";
  const row = db.prepare(
    `SELECT i.id, i.short_id, i.project_id, i.title, i.status, i.kind, i.priority,
            ${projectKeyExpr} AS project_key, p.display_name, c.work_repo_id, c.root, c.name AS checkout_name
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
    project_key: string;
    display_name: string;
    work_repo_id: string | null;
    root: string | null;
    checkout_name: string | null;
  } | undefined;
  if (!row) return null;
  const displayId = row.short_id || row.id.slice(0, 7);
  const repoId = row.project_key || row.work_repo_id || (row.root ? path.basename(row.root) : row.project_id);
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
      project_key: row.project_key || null,
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
      project_key: row.project_key || null,
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
  const issue = resolveProviderIssueRef(db, issueRef, projectId);
  const resolved = issue.ok
    ? ledgerIssueGraphInfo(db, issue.id, args.providerId, args.issueId, args.now)
    : null;
  const nodeId = resolved?.nodeId ?? graphEntityId(args.providerId, "issue", args.issueId);
  const resolutionMetadata = resolved?.metadata ?? {
    issue_ref: args.issueId,
    issue_ref_normalized: issueRef,
    project_ref: projectHint ?? null,
    resolution_status: !issue.ok && issue.error === "ambiguous" ? "ambiguous" : "unresolved",
    resolution_source: "provider_fallback",
    candidate_count: issue.ok ? 1 : issue.error === "ambiguous" ? issue.matches.length : 0,
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

/** The canonical blob behind any historical artifact identifier spelling. */
function canonicalBlobForCompatibilityRef(db: Db, ref: string): ArtifactBlobRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const trimmed = ref.trim();
  const hash = artifactHashFromRef(trimmed)
    ?? (isSha256(trimmed.toLowerCase()) ? trimmed.toLowerCase() : undefined);
  if (hash) return getArtifactBlob(db, hash);
  if (/^artifact-blob:/i.test(trimmed)) return getArtifactBlob(db, trimmed);
  if (/^artifact-version:/i.test(trimmed)) {
    const version = getCanonicalArtifactVersion(db, trimmed);
    return version ? getArtifactBlob(db, version.blob_id) : null;
  }
  if (/^artifact:ref:/i.test(trimmed)) return blobByCompatibilityArtifactId(db, trimmed);
  if (/^artifact:/i.test(trimmed)) {
    const logical = getLogicalArtifact(db, trimmed);
    const version = logical?.latest_version_id ? getCanonicalArtifactVersion(db, logical.latest_version_id) : null;
    return version ? getArtifactBlob(db, version.blob_id) : null;
  }
  return null;
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
  const blobId = args.artifactId
    ? canonicalBlobForCompatibilityRef(db, args.artifactId)?.id ?? null
    : null;
  const status = blobId ? "resolved" : (args.resolutionStatus ?? "unresolved");
  const id = artifactRegistryId("artifact_alias", [normalized.scheme, normalized.normalizedRef]);
  db.prepare(
    `INSERT INTO artifact_aliases (
      id, blob_id, scheme, alias, normalized_ref, locator_json,
      resolution_status, source, created_at, updated_at
    ) VALUES (
      @id, @blob_id, @scheme, @alias, @normalized_ref, @locator_json,
      @resolution_status, @source, @created_at, @updated_at
    )
    ON CONFLICT(scheme, normalized_ref) DO UPDATE SET
      blob_id = CASE
        WHEN artifact_aliases.blob_id IS NULL THEN excluded.blob_id
        WHEN excluded.blob_id IS NULL THEN artifact_aliases.blob_id
        WHEN artifact_aliases.blob_id = excluded.blob_id THEN artifact_aliases.blob_id
        ELSE NULL
      END,
      alias = excluded.alias,
      locator_json = CASE
        WHEN excluded.locator_json != '{}' THEN excluded.locator_json
        ELSE artifact_aliases.locator_json
      END,
      resolution_status = CASE
        WHEN artifact_aliases.blob_id IS NOT NULL
         AND excluded.blob_id IS NOT NULL
         AND artifact_aliases.blob_id != excluded.blob_id THEN 'ambiguous'
        WHEN COALESCE(excluded.blob_id, artifact_aliases.blob_id) IS NOT NULL THEN 'resolved'
        ELSE excluded.resolution_status
      END,
      source = excluded.source,
      updated_at = excluded.updated_at`
  ).run({
    id,
    blob_id: blobId,
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
  const linkKind: "pinned" | "living" = input.link_kind === "living" ? "living" : "pinned";
  let seriesId = asString(input.series_id) ?? null;
  const seriesRef = asString(input.series_ref) ?? null;
  const requestedCanonicalArtifactId = asString(input.canonical_artifact_id) ?? null;
  // AUTHORITATIVE typed-link invariants, enforced at this low-level chokepoint so
  // EVERY write path is covered — including /api/artifacts/ingest, which forwards
  // caller-supplied `link`/`links` straight here and would otherwise bypass the
  // route and resolveAndLinkArtifact guards (which remain as defense in depth).
  if (linkKind === "living") {
    // Evidence on an issue must pin one immutable version, never track a head.
    if (entityType === "issue" && linkType === "evidence") {
      throw new Error("evidence_links_must_be_pinned");
    }
    if (!seriesId && requestedCanonicalArtifactId) {
      seriesId = legacySeriesIdFromCanonicalArtifact(requestedCanonicalArtifactId);
    }
    if (!seriesId) throw new Error("living_link_requires_series");
  }
  // PINNED keeps the byte-identical legacy identity: [artifactId, entityType,
  // entityId, linkType, role??""]. LIVING is keyed by the SERIES (not the
  // resolved artifact, which is only a latest-at-creation fallback) plus a
  // trailing "living" discriminator, so a pinned and a living link to the same
  // (entity, relation, role) coexist as distinct rows.
  const id = linkKind === "living"
    ? artifactRegistryId("artifact_link", [seriesId, entityType, entityId, linkType, role ?? "", "living"])
    : artifactRegistryId("artifact_link", [artifactId, entityType, entityId, linkType, role ?? ""]);
  let canonicalArtifactId = requestedCanonicalArtifactId;
  let canonicalVersion = asString(input.canonical_version_id)
    ? getCanonicalArtifactVersion(db, String(input.canonical_version_id))
    : null;
  let canonicalBlob = asString(input.canonical_blob_id)
    ? getArtifactBlob(db, String(input.canonical_blob_id))
    : null;
  if (!canonicalArtifactId && canonicalVersion) canonicalArtifactId = canonicalVersion.artifact_id;
  if (!canonicalBlob && canonicalVersion) canonicalBlob = getArtifactBlob(db, canonicalVersion.blob_id);
  if (!canonicalBlob) canonicalBlob = canonicalBlobForCompatibilityRef(db, artifactId);

  if (linkKind === "living") {
    // A caller may still name the series the old way. Resolve it to the
    // canonical logical artifact, and require the artifact it anchors on to be
    // a genuine member: a non-member would freeze a wrong or dangling fallback.
    if (!canonicalArtifactId) {
      const logical = seriesId ? getLogicalArtifact(db, canonicalArtifactIdForSeriesRef(seriesId)) : null;
      const requestedBlob = canonicalBlob;
      if (!logical || !requestedBlob) throw new Error("living_link_series_mismatch");
      const row = db.prepare(
        `SELECT * FROM artifact_version
          WHERE artifact_id = ? AND blob_id = ?
          ORDER BY version_no DESC LIMIT 1`,
      ).get(logical.id, requestedBlob.id) as Record<string, unknown> | undefined;
      if (!row) throw new Error("living_link_series_mismatch");
      canonicalArtifactId = logical.id;
      canonicalVersion = canonicalArtifactVersionFromRow(row);
      canonicalBlob = requestedBlob;
    }
    const logical = canonicalArtifactId ? getLogicalArtifact(db, canonicalArtifactId) : null;
    if (!logical) throw new Error("living_link_requires_canonical_artifact");
    if (!canonicalVersion && logical.latest_version_id) {
      canonicalVersion = getCanonicalArtifactVersion(db, logical.latest_version_id);
    }
    if (!canonicalVersion || canonicalVersion.artifact_id !== logical.id) {
      throw new Error("living_link_series_mismatch");
    }
    canonicalBlob = getArtifactBlob(db, canonicalVersion.blob_id);
  }
  if (!canonicalBlob) throw new Error("artifact_link_requires_canonical_blob");

  const requestedTargetType = input.target_type;
  const requestedTargetId = asString(input.target_id);
  const targetType = linkKind === "living"
    ? "artifact"
    : requestedTargetType === "artifact_version" && canonicalVersion
      ? "artifact_version"
      : requestedTargetType === "artifact_blob"
        ? "artifact_blob"
        : canonicalVersion
          ? "artifact_version"
          : "artifact_blob";
  const targetId = linkKind === "living"
    ? canonicalArtifactId as string
    : targetType === "artifact_version"
      ? canonicalVersion!.id
      : requestedTargetId && requestedTargetType === "artifact_blob"
        ? requestedTargetId
        : canonicalBlob.id;
  db.prepare(
    // NOTE: blob_id and target_id are intentionally NOT in the ON CONFLICT DO
    // UPDATE SET. A re-submission MUST NOT silently retarget an existing link
    // — for living links the latest-at-creation fallback stays pinned to its
    // first write.
    `INSERT INTO artifact_links (
      id, blob_id, entity_type, entity_id, link_type, role, repo_id,
      provider_id, source, metadata_json, link_kind, series_ref,
      target_type, target_id, fallback_version_id, created_at, updated_at
    ) VALUES (
      @id, @blob_id, @entity_type, @entity_id, @link_type, @role, @repo_id,
      @provider_id, @source, @metadata_json, @link_kind, @series_ref,
      @target_type, @target_id, @fallback_version_id, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      repo_id = COALESCE(excluded.repo_id, artifact_links.repo_id),
      provider_id = COALESCE(excluded.provider_id, artifact_links.provider_id),
      source = excluded.source,
      metadata_json = excluded.metadata_json,
      link_kind = excluded.link_kind,
      series_ref = excluded.series_ref,
      updated_at = excluded.updated_at`
  ).run({
    id,
    blob_id: canonicalBlob.id,
    entity_type: entityType,
    entity_id: entityId,
    link_type: linkType,
    role,
    repo_id: asString(input.repo_id) ?? null,
    provider_id: asString(input.provider_id) ?? null,
    source: asString(input.source) ?? "artifact_registry",
    metadata_json: jsonStringify(descriptiveArtifactMetadata(input.metadata ?? {})),
    link_kind: linkKind,
    series_ref: seriesRef,
    target_type: targetType,
    target_id: targetId,
    fallback_version_id: linkKind === "living" ? canonicalVersion?.id ?? null : null,
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

function repoInfoForRoot(db: Db, root: string, observedRoot?: string): { repo_id: string | null; name: string | null } {
  const realRoot = path.resolve(root);
  const canonical = resolveProjectRef(db, realRoot, { observedPath: observedRoot });
  if (canonical.ok) return { repo_id: canonical.project.project_key, name: canonical.checkout?.name ?? null };
  return { repo_id: null, name: null };
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
  const repoInfo = repoInfoForRoot(db, repoRoot, path.dirname(expanded));

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
  if (custodyMode === "managed") {
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
        "input traverses a symlink whose target is outside any git repo; Git custody requires committed repository bytes; use --managed",
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
  const requestedCustody = asCustodyMode(input.custody_mode, "git");
  let { recoverability, warnings } = recoverabilityForLocalPath(gitState, input, requestedCustody);
  if (gitState.inside_worktree && !gitState.repo_id && recoverability.startsWith("repo_")) {
    recoverability = "local_only";
    warnings.push("unknown_repo_identity");
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
type LocalArtifactPlanCore = ReturnType<typeof computeLocalArtifactPlanCore>;

function buildLocalArtifactPlan(
  input: LocalArtifactPathInput,
  core: LocalArtifactPlanCore,
  hash: string,
  sizeBytes: number,
): LocalArtifactPlan {
  const canonicalRef = core.recoverability === "repo_commit" && core.uri.startsWith("repo://")
    ? core.uri
    : `artifact-blob:${hash}`;
  return {
    ok: true,
    input_path: core.lexicalPath,
    resolved_path: core.resolvedPath,
    sha256: hash,
    size_bytes: sizeBytes,
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

export function planLocalArtifactPath(db: Db, input: LocalArtifactPathInput): LocalArtifactPlan {
  if (!input.path || typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const lexicalForStat = path.resolve(expandHomePath(input.path));
  const stat = fs.statSync(lexicalForStat);
  if (!stat.isFile()) {
    throw new Error("artifact path must point to a regular file");
  }
  const core = computeLocalArtifactPlanCore(db, { ...input, custody_mode: input.custody_mode ?? "managed" });
  const hash = hashBuffer(fs.readFileSync(core.resolvedPath));
  return buildLocalArtifactPlan(input, core, hash, stat.size);
}

// Off-thread twin of planLocalArtifactPath: the read+hash of the (potentially
// multi-MiB) source file runs in the bounded ingest pool instead of blocking the
// event loop (issue aadf45e). No bytes are written — this is a dry-run planner.
export async function planLocalArtifactPathAsync(db: Db, input: LocalArtifactPathInput): Promise<LocalArtifactPlan> {
  if (!input.path || typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const lexicalForStat = path.resolve(expandHomePath(input.path));
  const stat = fs.statSync(lexicalForStat);
  if (!stat.isFile()) {
    throw new Error("artifact path must point to a regular file");
  }
  const core = computeLocalArtifactPlanCore(db, { ...input, custody_mode: input.custody_mode ?? "managed" });
  const materialized = await readAndHashArtifactFile(core.resolvedPath);
  return buildLocalArtifactPlan(input, core, materialized.hash, stat.size);
}

// Shared tail for the sync/async local-path registration paths. `delivery`
// selects how the bytes reach ingestArtifact: an in-memory buffer (sync path,
// managed custody), a CAS blob the ingest pool already wrote (async path,
// managed custody), or nothing at all (Git custody keeps the exact committed locator).
type LocalArtifactBytesDelivery =
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "cas" }
  | { kind: "none" };

function ingestFromLocalPlan(
  db: Db,
  input: LocalArtifactPathInput,
  core: LocalArtifactPlanCore,
  hash: string,
  sizeBytes: number,
  now: number,
  artifactRoot: string,
  delivery: LocalArtifactBytesDelivery,
): LocalArtifactPathRegistration {
  const { resolvedPath, gitState, recoverability, warnings, repoLocator, uri, decision, requestedCustody } = core;
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
    precomputed_sha256: hash,
    uri,
    role: input.role,
    media_type: input.media_type ?? mediaTypeForPath(resolvedPath),
    filename: input.filename ?? path.basename(resolvedPath),
    logical_name: input.logical_name ?? gitState.relative_path ?? path.basename(resolvedPath),
    size_bytes: sizeBytes,
    custody_mode: requestedCustody,
    home_repo_id: gitState.repo_id ?? undefined,
    repo_locator: repoLocator,
    availability: "present",
    retention: { recoverability },
    reference,
    metadata,
    pinned: input.pinned,
    ...(delivery.kind === "buffer" ? { content_buffer: delivery.buffer } : {}),
    ...(delivery.kind === "cas" ? { cas_materialized: true } : {}),
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
  const core = computeLocalArtifactPlanCore(db, { ...input, custody_mode: input.custody_mode ?? "managed" });
  const needsBytes = core.requestedCustody === "managed";
  // Read bytes through the realpath so a deleted worktree symlink can never make
  // the read race the URI we store.
  const fileBuffer = fs.readFileSync(core.resolvedPath);
  const hash = hashBuffer(fileBuffer);
  const delivery: LocalArtifactBytesDelivery = needsBytes ? { kind: "buffer", buffer: fileBuffer } : { kind: "none" };
  return ingestFromLocalPlan(db, input, core, hash, stat.size, now, artifactRoot, delivery);
}

// Off-thread twin of registerLocalArtifactPath (issue aadf45e). The read, hash,
// and (for managed custody) content-addressed write all happen in the
// bounded ingest pool, which also re-stats the source to guard against a
// mid-read mutation, so this route never blocks the daemon event loop.
export async function registerLocalArtifactPathAsync(
  db: Db,
  input: LocalArtifactPathInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): Promise<LocalArtifactPathRegistration> {
  if (!input.path || typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const absolutePath = path.resolve(expandHomePath(input.path));
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error("artifact path must point to a regular file");
  }
  const core = computeLocalArtifactPlanCore(db, { ...input, custody_mode: input.custody_mode ?? "managed" });
  const needsBytes = core.requestedCustody === "managed";
  const materialized = needsBytes
    ? await materializeArtifactFileIntoCas(core.resolvedPath, artifactRoot)
    : await readAndHashArtifactFile(core.resolvedPath);
  const delivery: LocalArtifactBytesDelivery = needsBytes ? { kind: "cas" } : { kind: "none" };
  return ingestFromLocalPlan(db, input, core, materialized.hash, materialized.size, now, artifactRoot, delivery);
}

function resolveIssueEntity(
  db: Db,
  rawIssueRef: string,
  projectRef?: string,
): { entity_id: string; metadata: JsonRecord } {
  const split = splitProviderIssueRef(rawIssueRef);
  const projectId = projectIdForRef(db, projectRef ?? split.projectRef);
  const issue = resolveProviderIssueRef(db, split.issueRef, projectId);
  if (!issue.ok) {
    throw new Error(issue.error === "ambiguous"
      ? `ambiguous issue ref ${rawIssueRef}: ${issue.matches.join(", ")}`
      : `issue ref not found: ${rawIssueRef}`);
  }
  return {
    entity_id: issue.id,
    metadata: {
      issue_ref: rawIssueRef,
      issue_project: projectRef ?? split.projectRef ?? null,
      ledger_issue_id: issue.id,
      resolution_status: "resolved",
    },
  };
}

// Series candidates for a LIVING link. A series/version ref resolves to exactly
// one series (`resolution.series`). For a content/hash ref the resolver carries
// no series, so fall back to the series that contain the resolved artifact
// version: a unique hit is usable, while 0 or >1 is ambiguous. This never
// touches the resolver core — it is a link-write-time lookup only.
function livingSeriesCandidates(db: Db, resolution: ArtifactIdentityResolution): ArtifactSeriesRecord[] {
  if (resolution.logical_artifact) return [projectCanonicalSeriesRecord(resolution.logical_artifact)];
  if (artifactIdentityTablesExist(db)) {
    const blob = resolution.artifact_blob;
    if (blob) {
      const rows = db.prepare(
        "SELECT DISTINCT artifact_id FROM artifact_version WHERE blob_id = ?",
      ).all(blob.id) as Array<{ artifact_id: string }>;
      return rows
        .map((row) => getLogicalArtifact(db, row.artifact_id))
        .filter((logical): logical is ArtifactIdentityRecord => Boolean(logical))
        .map(projectCanonicalSeriesRecord);
    }
  }
  return [];
}

export function resolveAndLinkArtifact(
  db: Db,
  input: ArtifactResolveAndLinkInput,
  now = Date.now(),
): ArtifactResolveAndLinkResult {
  const ref = asString(input.ref) ?? asString(input.artifact_ref) ?? asString(input.artifact_id);
  if (!ref) throw new Error("artifact ref is required");
  const resolution = resolveArtifactIdentity(db, ref, "link", now);
  if (resolution.status === "ambiguous") {
    throw new Error(`ambiguous artifact ref: ${ref}`);
  }
  if (!resolvedArtifactRecord(resolution)) {
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
  const canonicalArtifact = resolution.logical_artifact;
  let canonicalVersion = resolution.artifact_version;
  if (!canonicalVersion && canonicalArtifact?.latest_version_id) {
    canonicalVersion = getCanonicalArtifactVersion(db, canonicalArtifact.latest_version_id);
  }
  if (linkKind === "living") {
    if (entityType === "issue" && linkType === "evidence") {
      throw new Error("evidence_links_must_be_pinned");
    }
    if (canonicalArtifact) {
      seriesId = legacySeriesIdFromCanonicalArtifact(canonicalArtifact.id);
    } else {
      const candidates = livingSeriesCandidates(db, resolution);
      if (candidates.length !== 1) throw new Error("living_link_requires_series");
      seriesId = candidates[0].id;
    }
    // `series_ref` records the author-facing ref exactly as supplied; the stored
    // artifact_id is the latest-at-creation fallback (resolvedArtifactRecord(resolution)!.id).
    seriesRef = ref;
  }

  const issueResolution = entityType === "issue"
    ? resolveIssueEntity(db, rawEntityId, asString(input.issue_project) ?? asString(input.repo_id))
    : null;
  const link = registerArtifactLink(db, resolvedArtifactRecord(resolution)!.id, {
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
    target_type: resolution.target_type === "artifact_version"
      || resolution.target_type === "artifact_blob"
      || resolution.target_type === "artifact"
      ? resolution.target_type
      : undefined,
    target_id: resolution.target_id ?? undefined,
    canonical_artifact_id: canonicalArtifact?.id,
    canonical_version_id: canonicalVersion?.id,
    canonical_blob_id: resolution.artifact_blob?.id ?? canonicalVersion?.blob_id,
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
    const existing = resolvedArtifactRecord(resolveArtifactIdentity(db, ref, "strict-read", now));
    if (existing?.algorithm === "sha256" && existing.content_hash.toLowerCase() !== hash) {
      throw new Error("snapshot bytes do not match registered sha256");
    }
  }

  const custodyMode = asCustodyMode(input.custody_mode, "managed");
  if (custodyMode !== "managed") {
    throw new Error("snapshot custody_mode must be managed");
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

  return artifact;
}

// Off-thread twin of snapshotArtifactBytes (issue aadf45e). When the snapshot
// source is a filesystem path, the read + hash + content-addressed write run in
// the bounded ingest pool instead of on the event loop. Inline byte inputs
// (content/base64/json/buffer) are already in memory and stay synchronous.
export async function snapshotArtifactBytesAsync(
  db: Db,
  input: ArtifactSnapshotInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): Promise<ArtifactRecord> {
  const pathInput = !Buffer.isBuffer(input.content_buffer)
    && typeof input.content !== "string"
    && typeof input.content_base64 !== "string"
    && !("json" in input)
    ? (typeof input.path === "string" && input.path.trim() ? input.path
      : typeof input.content_path === "string" && input.content_path.trim() ? input.content_path
      : null)
    : null;
  if (!pathInput) {
    return snapshotArtifactBytes(db, input, now, artifactRoot);
  }
  const custodyMode = asCustodyMode(input.custody_mode, "managed");
  if (custodyMode !== "managed") {
    throw new Error("snapshot custody_mode must be managed");
  }
  const resolved = path.resolve(expandHomePath(pathInput));
  const materialized = await materializeArtifactFileIntoCas(resolved, artifactRoot);
  const hash = materialized.hash;
  const ref = asString(input.ref) ?? asString(input.artifact_ref);
  if (ref) {
    const existing = resolvedArtifactRecord(resolveArtifactIdentity(db, ref, "strict-read", now));
    if (existing?.algorithm === "sha256" && existing.content_hash.toLowerCase() !== hash) {
      throw new Error("snapshot bytes do not match registered sha256");
    }
  }
  const filePath = artifactPathForHash(hash, artifactRoot);
  return ingestArtifact(db, {
    sha256: hash,
    precomputed_sha256: hash,
    cas_materialized: true,
    size_bytes: materialized.size,
    custody_mode: custodyMode,
    availability: "present",
    media_type: input.media_type,
    role: input.role,
    filename: input.filename ?? path.basename(resolved),
    logical_name: input.logical_name,
    metadata: mergeJsonRecords(input.metadata, {
      recoverability: "mandible_cas",
      snapshot_source_ref: ref ?? null,
      snapshot_source_path: resolved,
    }),
    reference: mergeJsonRecords(input.reference, {
      recoverability: "mandible_cas",
      snapshot_source_ref: ref ?? null,
      uri: `file://${filePath}`,
    }),
  }, now, artifactRoot);
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
      metadata: member.metadata,
    }, now).artifact;
  }
  return resolveBundleMemberRef(db, member, now);
}

// Shared ref-resolution tail for a non-path bundle member (pure in-memory work).
function resolveBundleMemberRef(
  db: Db,
  member: ArtifactBundleMemberInput,
  now: number,
): ArtifactRecord {
  const ref = asString(member.ref) ?? asString(member.artifact_ref);
  if (!ref) throw new Error("bundle member ref or path is required");
  const resolution = resolveArtifactIdentity(db, ref, "strict-read", now);
  if (resolution.status === "ambiguous") throw new Error(`ambiguous artifact ref: ${ref}`);
  if (!resolvedArtifactRecord(resolution)) throw new Error(`artifact ref did not resolve: ${ref}`);
  return resolvedArtifactRecord(resolution)!;
}

// Off-thread twin of resolveBundleMemberArtifact: a path member is read+hashed
// through the bounded ingest pool via registerLocalArtifactPathAsync.
async function resolveBundleMemberArtifactAsync(
  db: Db,
  member: ArtifactBundleMemberInput,
  now: number,
): Promise<ArtifactRecord> {
  if (asString(member.path)) {
    return (await registerLocalArtifactPathAsync(db, {
      path: member.path as string,
      role: member.role,
      custody_mode: member.custody_mode,
      metadata: member.metadata,
    }, now)).artifact;
  }
  return resolveBundleMemberRef(db, member, now);
}

function finalizeArtifactBundle(
  db: Db,
  input: ArtifactBundleInput,
  memberArtifacts: ArtifactRecord[],
  now: number,
  artifactRoot: string,
): ArtifactBundleRecord {
  const name = asString(input.name) as string;
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
      recoverability: artifact.custody_mode === 'git' ? 'repo_commit' : 'mandible_cas',
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

export function createArtifactBundle(
  db: Db,
  input: ArtifactBundleInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): ArtifactBundleRecord {
  const name = asString(input.name);
  if (!name) throw new Error("bundle name is required");
  const memberArtifacts = input.members.map((member) => resolveBundleMemberArtifact(db, member, now));
  return finalizeArtifactBundle(db, input, memberArtifacts, now, artifactRoot);
}

// Off-thread twin of createArtifactBundle (issue aadf45e). Path members are the
// source of the POST /api/artifacts/bundles freezes: each was read+hashed
// synchronously on the event loop. Here they materialize through the bounded
// ingest pool before the (small, in-memory) manifest is written synchronously.
export async function createArtifactBundleAsync(
  db: Db,
  input: ArtifactBundleInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): Promise<ArtifactBundleRecord> {
  const name = asString(input.name);
  if (!name) throw new Error("bundle name is required");
  const memberArtifacts: ArtifactRecord[] = [];
  for (const member of input.members) {
    memberArtifacts.push(await resolveBundleMemberArtifactAsync(db, member, now));
  }
  return finalizeArtifactBundle(db, input, memberArtifacts, now, artifactRoot);
}

export function addArtifactBundleMembers(
  db: Db,
  bundleRef: string,
  members: ArtifactBundleMemberInput[],
  now = Date.now(),
): ArtifactBundleRecord {
  const bundle = getArtifact(db, bundleRef);
  if (!bundle) throw new Error(`bundle ref did not resolve: ${bundleRef}`);
  const existingMembers = listArtifactBundleMembers(db, bundle.id);
  const start = existingMembers.length;
  const added = members.map((member, index) =>
    linkBundleMember(db, bundle.id, resolveBundleMemberArtifact(db, member, now), member, start + index, now)
  );
  return { bundle: getArtifact(db, bundle.id) as ArtifactRecord, members: [...existingMembers, ...added] };
}

// Off-thread twin of addArtifactBundleMembers (issue aadf45e): path members are
// read+hashed through the bounded ingest pool before their links are written.
export async function addArtifactBundleMembersAsync(
  db: Db,
  bundleRef: string,
  members: ArtifactBundleMemberInput[],
  now = Date.now(),
): Promise<ArtifactBundleRecord> {
  const bundle = getArtifact(db, bundleRef);
  if (!bundle) throw new Error(`bundle ref did not resolve: ${bundleRef}`);
  const existingMembers = listArtifactBundleMembers(db, bundle.id);
  const start = existingMembers.length;
  const resolved: ArtifactRecord[] = [];
  for (const member of members) {
    resolved.push(await resolveBundleMemberArtifactAsync(db, member, now));
  }
  const added = resolved.map((artifact, index) =>
    linkBundleMember(db, bundle.id, artifact, members[index], start + index, now)
  );
  return { bundle: getArtifact(db, bundle.id) as ArtifactRecord, members: [...existingMembers, ...added] };
}

export function listArtifactBundleMembers(db: Db, bundleId: string): ArtifactBundleMemberRecord[] {
  if (!tableExists(db, "artifact_links")) return [];
  const rows = db.prepare(
    `SELECT ${ARTIFACT_LINK_COLUMNS}
       FROM artifact_links
      WHERE entity_type = 'artifact_bundle'
        AND entity_id = ?
        AND link_type = 'bundle_member'
      ORDER BY CAST(json_extract(metadata_json, '$.order') AS INTEGER), blob_id`,
  ).all(bundleId) as Array<Record<string, unknown>>;
  return rows.map((row, index) => {
    const link = artifactLinkFromRow(db, row);
    return {
      artifact: getArtifact(db, link.artifact_id) as ArtifactRecord,
      link,
      order: typeof link.metadata.order === "number" ? link.metadata.order : index,
      role: link.role,
    };
  }).filter((member) => Boolean(member.artifact));
}

export function getArtifactBundle(db: Db, bundleRef: string): ArtifactBundleRecord | null {
  const artifact = getArtifact(db, bundleRef);
  if (!artifact) return null;
  return { bundle: artifact, members: listArtifactBundleMembers(db, artifact.id) };
}

function getArtifactAlias(db: Db, scheme: string, normalizedRef: string): ArtifactAliasRecord | null {
  const row = db.prepare(
    `SELECT id, blob_id, scheme, alias, normalized_ref, locator_json,
            resolution_status, source, created_at, updated_at
       FROM artifact_aliases
      WHERE scheme = ? AND normalized_ref = ?`
  ).get(scheme, normalizedRef) as Record<string, unknown> | undefined;
  return row ? artifactAliasFromRow(db, row) : null;
}

function getArtifactLink(db: Db, id: string): ArtifactLinkRecord | null {
  const row = db.prepare(
    `SELECT ${ARTIFACT_LINK_COLUMNS} FROM artifact_links WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? artifactLinkFromRow(db, row) : null;
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
  // When the off-thread ingest pool already read+hashed (and, for cas_materialized,
  // wrote) the bytes, skip touching them again on the event loop.
  const preHash = typeof input.precomputed_sha256 === "string" ? input.precomputed_sha256.toLowerCase() : undefined;
  const casMaterialized = input.cas_materialized === true && Boolean(preHash);
  const bytes = (!casMaterialized && hasInlineArtifactContent(input)) ? contentBuffer(input) : null;
  const declaredHash = hashFromArtifactRef(input);
  const hash = preHash ?? (bytes ? hashBuffer(bytes) : declaredHash);
  if (!hash) {
    throw new Error("artifact content, content_base64, json, sha256, or artifact_id is required");
  }
  if (declaredHash && bytes && declaredHash !== hash) {
    throw new Error("artifact sha256 does not match supplied content");
  }
  if (declaredHash && preHash && declaredHash !== hash) {
    throw new Error("artifact sha256 does not match supplied content");
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('artifact requires a SHA-256 content hash');
  const custodyMode = asCustodyMode(input.custody_mode, 'managed');
  if (custodyMode === 'git' && (!input[VERIFIED_GIT_DESCRIPTOR] || bytes || casMaterialized)) throw new Error('Git custody must be registered as a verified logical version');
  const hasBytes = bytes != null || casMaterialized;
  const id = `artifact:sha256:${hash}`;
  const filePath = artifactPathForHash(hash, artifactRoot);
  let uri = input.uri ?? input.artifact_id ?? `artifact-blob:${hash}`;
  let sizeBytes = input.size_bytes ?? uriSizeBytes(uri) ?? 0;
  if (hasBytes) {
    if (bytes) {
      ensureDir(path.dirname(filePath));
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, bytes);
      }
      sizeBytes = bytes.byteLength;
    } else {
      // Bytes already live in the CAS at filePath (written by the ingest pool).
      sizeBytes = input.size_bytes ?? sizeBytes;
    }
    uri = `file://${filePath}`;
  }
  if (custodyMode === 'git') {
    const locator = input.repo_locator;
    if (hasBytes || !locator || typeof locator.repo_id !== 'string' || typeof locator.path !== 'string' || typeof locator.commit !== 'string') throw new Error('Git custody requires only a canonical committed source');
    retainArtifactCommit(db,{project:locator.repo_id,commit:locator.commit,path:locator.path,sha256:hash});
  } else {
    if (!hasBytes && !fs.existsSync(filePath)) throw new Error('Managed custody requires stored bytes');
    if (hashBuffer(fs.readFileSync(filePath)) !== hash) throw new Error('Stored bytes do not match sha256');
    uri = `file://${filePath}`;
  }
  const availability = "present" as const;
  const repoLocator = input.repo_locator ?? asRecord(input.metadata?.repo_locator);
  const homeRepoId = input.home_repo_id ?? asString(input.metadata?.home_repo_id) ?? asString(input.metadata?.repo_id) ?? null;
  const metadata = descriptiveArtifactMetadata({
    ...(input.metadata ?? {}), filename: input.filename, logical_name: input.logical_name,
  });
  const blob = upsertCanonicalArtifactBlob(db, {
    id,
    algorithm: "sha256",
    content_hash: hash,
    uri,
    media_type: input.media_type ?? ("json" in input ? "application/json" : "application/octet-stream"),
    role: input.role ?? null,
    size_bytes: sizeBytes,
    provider_id: input.provider_id ?? null,
    manifest_id: input.manifest_id ?? null,
    metadata: mergeJsonRecords(metadata, { home_repo_id: homeRepoId, repo_locator: repoLocator }),
    pinned: input.pinned !== false,
    custody_mode: custodyMode,
    home_repo_id: homeRepoId,
    repo_locator: repoLocator,
    availability,
    retention: {},
    reference: {},
    created_at: now,
  }, now);
  if (!blob) throw new Error("canonical artifact blob tables are unavailable");

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
    },
    detail: { content_hash: hash, metadata },
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

  return getArtifact(db, id) ?? projectCanonicalArtifactRecord(blob);
}

// Off-thread twin of ingestArtifact for the HTTP ingest route (issue aadf45e).
// A `content_path` input (a daemon-visible file, e.g. a validated file-RPC spool
// attachment) is read, hashed, and written into the CAS by the bounded ingest
// pool; every other input variant already carries its bytes in memory and stays
// on the synchronous path.
export async function ingestArtifactAsync(
  db: Db,
  input: ArtifactInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(db),
): Promise<ArtifactRecord> {
  const pathOnly = typeof input.content_path === "string"
    && input.content_path.trim().length > 0
    && !Buffer.isBuffer(input.content_buffer)
    && typeof input.content !== "string"
    && typeof input.content_base64 !== "string"
    && !("json" in input);
  if (!pathOnly) {
    return ingestArtifact(db, input, now, artifactRoot);
  }
  const resolved = path.resolve(expandHomePath(input.content_path as string));
  const materialized = await materializeArtifactFileIntoCas(resolved, artifactRoot);
  const { content_path: _contentPath, ...rest } = input;
  return ingestArtifact(db, {
    ...rest,
    precomputed_sha256: materialized.hash,
    cas_materialized: true,
    size_bytes: input.size_bytes ?? materialized.size,
  }, now, artifactRoot);
}

/** A provider's declaration is provenance, not evidence that Mandible owns its bytes. */
function registerManifestArtifactReference(db: Db,input:ArtifactInput,now:number): {id:string;home_repo_id:string|null;registered:boolean} {
  const ref=input.artifact_id ?? (input.sha256 ? `artifact-blob:${input.sha256}` : input.uri);
  const existing=ref ? resolveArtifactRefReadonly(db,ref) : null;
  if (existing) return {...existing,registered:true};
  const id=artifactRegistryId('provider-reference',[input.provider_id,input.manifest_id,ref,input.logical_name]);
  upsertGraphEntity(db,{id,entity_type:'external_reference',provider_id:input.provider_id ?? null,
    external_id:ref ?? input.logical_name ?? id,title:input.logical_name ?? input.role ?? ref ?? id,status:'referenced',
    summary:{role:input.role,materializable:false},detail:{manifest_id:input.manifest_id,reference:ref,metadata:input.metadata},
    created_at:now,updated_at:now,observed_at:now,source:'provider_manifest'});
  return {id,home_repo_id:null,registered:false};
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
        id, provider_id, manifest_type, version, content_hash, blob_id,
        source, content_json, created_at
      ) VALUES (
        @id, @provider_id, @manifest_type, @version, @content_hash, @blob_id,
        @source, @content_json, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        blob_id = excluded.blob_id,
        source = excluded.source,
        content_json = excluded.content_json`
    ).run({
      id: manifestId,
      provider_id: provider.id,
      manifest_type: manifestType,
      version: input.version ?? (manifest.version as string | undefined) ?? provider.version,
      content_hash: artifact.content_hash,
      blob_id: canonicalBlobForCompatibilityRef(db, artifact.id)?.id ?? null,
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
        const artifactRecord = registerManifestArtifactReference(db, {
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
        }, now);
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
          if (artifactRecord.registered && artifactAliasTablesExist(db)) {
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
      const artifactRecord = registerManifestArtifactReference(db, {
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
      }, now);
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
        if (artifactRecord.registered && artifactAliasTablesExist(db)) {
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

/**
 * Resolve any historical artifact identifier through the canonical store and
 * project it back into the `ArtifactRecord` compatibility shape.
 *
 * Accepts every spelling durable ledger text uses: `artifact:sha256:<hash>`,
 * `artifact-blob:<hash>`, a bare hash, `artifact-version:<id>`, a logical
 * `artifact:<key>`, and the `artifact:ref:<hash>` external-reference locators
 * (recorded on their blob as `metadata.compatibility_artifact_id`).
 */
export function getArtifact(db: Db, id: string): ArtifactRecord | null {
  const artifact = resolvedArtifactRecord(resolveArtifactIdentity(db, id, "surface"));
  if (!artifact) return null;
  if (artifactAliasTablesExist(db)) {
    artifact.aliases = listArtifactAliases(db, artifact.content_hash);
    artifact.links = listArtifactLinks(db, artifact.content_hash);
  }
  return artifact;
}

function blobByCompatibilityArtifactId(db: Db, id: string): ArtifactBlobRecord | null {
  const row = db.prepare(
    "SELECT * FROM artifact_blob WHERE json_extract(metadata_json, '$.compatibility_artifact_id') = ? LIMIT 1",
  ).get(id) as Record<string, unknown> | undefined;
  return row ? artifactBlobFromRow(row) : null;
}

function listCanonicalArtifactCompatibility(db: Db, options: ArtifactListOptions): ArtifactRecord[] {
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const q = asString(options.q);
  if (q) {
    bindings.q = `%${escapeLike(q)}%`;
    where.push(`(
      b.id LIKE @q ESCAPE '\\' OR ('artifact:sha256:' || b.content_hash) LIKE @q ESCAPE '\\'
      OR b.content_hash LIKE @q ESCAPE '\\'
      OR b.storage_uri LIKE @q ESCAPE '\\' OR b.provider_id LIKE @q ESCAPE '\\'
      OR b.role LIKE @q ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM artifact_version cv JOIN artifact ca ON ca.id = cv.artifact_id
         WHERE cv.blob_id = b.id
           AND (ca.id LIKE @q ESCAPE '\\' OR ca.identity_key LIKE @q ESCAPE '\\'
             OR ca.title LIKE @q ESCAPE '\\' OR ca.logical_name LIKE @q ESCAPE '\\')
      )
      OR EXISTS (
        SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id
          AND (aa.alias LIKE @q ESCAPE '\\' OR aa.normalized_ref LIKE @q ESCAPE '\\')
      )
      OR b.metadata_json LIKE @q ESCAPE '\\'
    )`);
  }
  if (asString(options.hashPrefix)) {
    bindings.hashPrefix = `${escapeLike(options.hashPrefix!.toLowerCase())}%`;
    where.push("lower(b.content_hash) LIKE @hashPrefix ESCAPE '\\'");
  }
  if (asString(options.repo)) {
    bindings.repo = options.repo;
    where.push(`(
      EXISTS (SELECT 1 FROM artifact_version cv JOIN artifact ca ON ca.id = cv.artifact_id
        WHERE cv.blob_id = b.id AND (cv.source_project_id = @repo OR ca.source_project_id = @repo OR (SELECT p.project_key FROM ledger_projects p WHERE p.id=ca.source_project_id) = @repo OR (SELECT p.project_key FROM artifact_source s JOIN ledger_projects p ON p.id=json_extract(s.source_json,'$.project_id') WHERE s.artifact_id=ca.id) = @repo))
      OR EXISTS (SELECT 1 FROM artifact_version pv JOIN project_artifact_associations pa
        ON (pa.target_type='artifact' AND pa.target_id=pv.artifact_id) OR (pa.target_type='artifact_version' AND pa.target_id=pv.id)
        JOIN ledger_projects pp ON pp.id=pa.project_id
        WHERE pv.blob_id=b.id AND (pp.id=@repo OR pp.project_key=@repo))
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.repo_id = @repo)
      OR json_extract(b.metadata_json, '$.home_repo_id') = @repo
    )`);
  }
  if (asString(options.provider)) {
    bindings.provider = options.provider;
    where.push(`(b.provider_id = @provider
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.provider_id = @provider))`);
  }
  if (asString(options.role)) {
    bindings.role = options.role;
    where.push(`(b.role = @role
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.role = @role))`);
  }
  if (asString(options.custody)) {
    bindings.custody = options.custody;
    where.push("((@custody='managed' AND b.storage_uri IS NOT NULL) OR EXISTS (SELECT 1 FROM artifact_version custody_v WHERE custody_v.blob_id=b.id AND custody_v.custody_mode=@custody))");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("CASE WHEN b.storage_uri IS NULL THEN 'unchecked' ELSE 'present' END = @availability");
  }
  if (asString(options.scheme)) {
    bindings.scheme = options.scheme!.toLowerCase();
    where.push("EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id AND aa.scheme = @scheme)");
  }
  if (asString(options.location)) {
    bindings.location = `%${escapeLike(options.location!.trim())}%`;
    where.push(`(
      b.storage_uri LIKE @location ESCAPE '\\' OR b.metadata_json LIKE @location ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM artifact_version cv WHERE cv.blob_id = b.id
        AND (cv.repo_path LIKE @location ESCAPE '\\' OR cv.observed_path LIKE @location ESCAPE '\\'
          OR cv.parent_version_id LIKE @location ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id
        AND (aa.alias LIKE @location ESCAPE '\\' OR aa.normalized_ref LIKE @location ESCAPE '\\'))
      OR json_extract(b.metadata_json, '$.repo_locator') LIKE @location ESCAPE '\\'
    )`);
  }
  if (asString(options.linkedEntityType) || asString(options.linkedEntityId)) {
    if (asString(options.linkedEntityType) && asString(options.linkedEntityId)) {
      bindings.linkedEntityType = options.linkedEntityType;
      bindings.linkedEntityId = options.linkedEntityId;
      where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id
        AND al.entity_type = @linkedEntityType AND al.entity_id = @linkedEntityId)`);
    } else if (asString(options.linkedEntityType)) {
      bindings.linkedEntityType = options.linkedEntityType;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.entity_type = @linkedEntityType)");
    } else {
      bindings.linkedEntityId = options.linkedEntityId;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.entity_id = @linkedEntityId)");
    }
  }
  if (options.linkedTargetType || asString(options.linkedTargetId)) {
    if (options.linkedTargetType && asString(options.linkedTargetId)) {
      bindings.linkedTargetType = options.linkedTargetType;
      bindings.linkedTargetId = options.linkedTargetId;
      where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id
        AND al.target_type = @linkedTargetType AND al.target_id = @linkedTargetId)`);
    } else if (options.linkedTargetType) {
      bindings.linkedTargetType = options.linkedTargetType;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.target_type = @linkedTargetType)");
    } else {
      bindings.linkedTargetId = options.linkedTargetId;
      where.push("EXISTS (SELECT 1 FROM artifact_links al WHERE al.blob_id = b.id AND al.target_id = @linkedTargetId)");
    }
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);
  const rows = db.prepare(
    `SELECT b.* FROM artifact_blob b
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.created_at DESC, b.id
      LIMIT @limit OFFSET @offset`,
  ).all(bindings) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const blob = artifactBlobFromRow(row);
    const artifact = projectCanonicalArtifactRecord(blob);
    if (options.summary) {
      artifact.metadata = summaryArtifactMetadata(artifact.metadata);
      artifact.repo_locator = summaryRepoLocator(artifact.repo_locator);
      artifact.retention = {};
      artifact.reference = {};
      artifact.alias_schemes = [...new Set(listArtifactAliases(db, artifact.content_hash)
        .map((alias) => alias.scheme))].sort();
    } else {
      artifact.aliases = listArtifactAliases(db, artifact.content_hash);
      artifact.links = listArtifactLinks(db, artifact.content_hash);
    }
    return artifact;
  });
}

export function listArtifacts(db: Db, options: ArtifactListOptions = {}): ArtifactRecord[] {
  if (!artifactIdentityTablesExist(db)) return [];
  return listCanonicalArtifactCompatibility(db, options);
}

function listCanonicalArtifactSeriesCompatibility(
  db: Db,
  options: ArtifactListOptions,
): ArtifactSeriesSummary[] {
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  const linkScope = "(al.blob_id = b.id OR al.target_id = a.id OR al.target_id = v.id)";
  const q = asString(options.q);
  if (q) {
    bindArtifactIdentifierSearch(bindings, q);
    where.push(`(
      lower(a.id) LIKE @qIdentifierFullPrefix ESCAPE '\\'
      OR lower(replace(a.id, 'artifact:', 'artifact-series:'))
         LIKE @qIdentifierFullPrefix ESCAPE '\\'
      OR lower(substr(a.id, length('artifact:') + 1))
         LIKE @qIdentifierBarePrefix ESCAPE '\\'
      OR a.identity_key LIKE @q ESCAPE '\\'
      OR a.title LIKE @q ESCAPE '\\' OR a.logical_name LIKE @q ESCAPE '\\'
      OR (SELECT p.project_key FROM artifact_source s JOIN ledger_projects p ON p.id=json_extract(s.source_json,'$.project_id') WHERE s.artifact_id=a.id) LIKE @q ESCAPE '\\' OR b.storage_uri LIKE @q ESCAPE '\\'
      OR b.provider_id LIKE @q ESCAPE '\\' OR b.role LIKE @q ESCAPE '\\'
      OR EXISTS (
        SELECT 1
          FROM artifact_version search_v
          LEFT JOIN artifact_blob search_b ON search_b.id = search_v.blob_id
         WHERE search_v.artifact_id = a.id
           AND (
             lower(search_v.id) LIKE @qIdentifierFullPrefix ESCAPE '\\'
             OR lower(substr(search_v.id, length('artifact-version:') + 1))
                LIKE @qIdentifierBarePrefix ESCAPE '\\'
             OR lower(search_b.id) LIKE @qIdentifierFullPrefix ESCAPE '\\'
             OR lower(substr(search_b.id, length('artifact-blob:') + 1))
                LIKE @qIdentifierBarePrefix ESCAPE '\\'
             OR lower(search_b.content_hash) LIKE @qIdentifierBarePrefix ESCAPE '\\'
           )
      )
      OR EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id
        AND (aa.alias LIKE @q ESCAPE '\\' OR aa.normalized_ref LIKE @q ESCAPE '\\'))
    )`);
  }
  if (asString(options.hashPrefix)) {
    bindings.hashPrefix = `${escapeLike(options.hashPrefix!.toLowerCase())}%`;
    where.push("lower(b.content_hash) LIKE @hashPrefix ESCAPE '\\'");
  }
  if (asString(options.repo)) {
    bindings.repo = options.repo;
    where.push(`(v.source_project_id = @repo OR (SELECT p.project_key FROM artifact_source s JOIN ledger_projects p ON p.id=json_extract(s.source_json,'$.project_id') WHERE s.artifact_id=a.id) = @repo
      OR json_extract(b.metadata_json, '$.home_repo_id') = @repo
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope} AND al.repo_id = @repo))`);
  }
  if (asString(options.provider)) {
    bindings.provider = options.provider;
    where.push(`(b.provider_id = @provider
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope} AND al.provider_id = @provider))`);
  }
  if (asString(options.role)) {
    bindings.role = options.role;
    where.push(`(b.role = @role
      OR EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope} AND al.role = @role))`);
  }
  if (asString(options.custody)) {
    bindings.custody = options.custody;
    where.push("v.custody_mode = @custody");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("CASE WHEN b.storage_uri IS NULL THEN 'unchecked' ELSE 'present' END = @availability");
  }
  if (asString(options.scheme)) {
    bindings.scheme = options.scheme!.toLowerCase();
    where.push("EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id AND aa.scheme = @scheme)");
  }
  if (asString(options.location)) {
    bindings.location = `%${escapeLike(options.location!.trim())}%`;
    where.push(`(b.storage_uri LIKE @location ESCAPE '\\'
      OR b.metadata_json LIKE @location ESCAPE '\\'
      OR v.repo_path LIKE @location ESCAPE '\\' OR v.observed_path LIKE @location ESCAPE '\\'
      OR v.parent_version_id LIKE @location ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM artifact_aliases aa WHERE aa.blob_id = b.id
        AND (aa.alias LIKE @location ESCAPE '\\' OR aa.normalized_ref LIKE @location ESCAPE '\\')))`);
  }
  if (asString(options.linkedEntityType) && asString(options.linkedEntityId)) {
    bindings.linkedEntityType = options.linkedEntityType;
    bindings.linkedEntityId = options.linkedEntityId;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.entity_type = @linkedEntityType AND al.entity_id = @linkedEntityId)`);
  } else if (asString(options.linkedEntityType)) {
    bindings.linkedEntityType = options.linkedEntityType;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.entity_type = @linkedEntityType)`);
  } else if (asString(options.linkedEntityId)) {
    bindings.linkedEntityId = options.linkedEntityId;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.entity_id = @linkedEntityId)`);
  }
  if (options.linkedTargetType && asString(options.linkedTargetId)) {
    bindings.linkedTargetType = options.linkedTargetType;
    bindings.linkedTargetId = options.linkedTargetId;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.target_type = @linkedTargetType AND al.target_id = @linkedTargetId)`);
  } else if (options.linkedTargetType) {
    bindings.linkedTargetType = options.linkedTargetType;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.target_type = @linkedTargetType)`);
  } else if (asString(options.linkedTargetId)) {
    bindings.linkedTargetId = options.linkedTargetId;
    where.push(`EXISTS (SELECT 1 FROM artifact_links al WHERE ${linkScope}
      AND al.target_id = @linkedTargetId)`);
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);
  const rows = db.prepare(
    `SELECT a.id AS artifact_id, v.id AS version_id, b.id AS blob_id
       FROM artifact a
       LEFT JOIN artifact_version v ON v.id = a.latest_version_id
       LEFT JOIN artifact_blob b ON b.id = v.blob_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.updated_at DESC, a.id
      LIMIT @limit OFFSET @offset`,
  ).all(bindings) as Array<{ artifact_id: string; version_id: string | null; blob_id: string | null }>;
  return rows.map((row) => {
    const logical = getLogicalArtifact(db, row.artifact_id) as ArtifactIdentityRecord;
    const version = row.version_id ? getCanonicalArtifactVersion(db, row.version_id) : null;
    const blob = row.blob_id ? getArtifactBlob(db, row.blob_id) : null;
    const series = projectCanonicalSeriesRecord(logical);
    const latestVersion = version ? projectCanonicalVersionRecord(db, version) : null;
    const latestArtifact = blob ? projectCanonicalArtifactRecord(blob, logical, version) : null;
    return {
      ...series,
      ref: series.id,
      latest_version: latestVersion,
      latest_artifact: latestArtifact,
      links: listArtifactSeriesLinks(db, series.id),
    };
  });
}

export function listArtifactSeries(db: Db, options: ArtifactListOptions = {}): ArtifactSeriesSummary[] {
  if (!artifactIdentityTablesExist(db)) return [];
  return listCanonicalArtifactSeriesCompatibility(db, options);
}

// ---------------------------------------------------------------------------
// Artifact version identity and custody history (issue f7a994e).
//
// `artifact_blob` rows are the immutable bytes. An `artifact` row is the stable
// LOGICAL identity; `artifact_version` rows pin specific blobs under it. History
// is written ONLY through the explicit recordArtifactVersion path — ordinary
// ingest/preview/check never touch these tables.
//
// The `artifact-series:` and `artifact-version:` ref spellings, and the
// ArtifactSeriesRecord/ArtifactVersionRecord shapes, remain as boundary
// projections of that canonical state: they are how authored text and existing
// API clients name a living identity. The `artifact_series` and
// `artifact_versions` TABLES were retired in schema v160.
// ---------------------------------------------------------------------------

const VERSION_SOURCE_KINDS = new Set<ArtifactVersionSourceKind>([
  "tracked_repo",
  "local_only",
  "managed",
]);

function artifactDraftTablesExist(db: Db): boolean {
  return artifactIdentityTablesExist(db) && tableExists(db, "artifact_drafts");
}

function assertVersioningTables(db: Db): void {
  if (!artifactIdentityTablesExist(db)) {
    throw new Error("artifact identity tables are not present in this database");
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

/** A typed artifact lookup of a bare key through the shared entity-ref resolver. */
function artifactLookup<T>(
  db: Db,
  kind: "artifact" | "artifact_version" | "artifact_blob",
  key: string,
  load: (id: string) => T | null,
): PrefixLookupResult<T> {
  if (!artifactIdentityTablesExist(db)) return { status: "unsupported", value: null };
  const resolved = resolveId(db, kind, key);
  if (resolved.ok) {
    const value = load(resolved.id);
    return value ? { status: "resolved", value } : { status: "unresolved", value: null };
  }
  if (resolved.error === "ambiguous") return { status: "ambiguous", value: null };
  return { status: key.length < MIN_ARTIFACT_ID_PREFIX_LENGTH ? "unsupported" : "unresolved", value: null };
}

function getLogicalArtifactPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactIdentityRecord> {
  const key = canonicalArtifactKey(ref);
  if (!key) return { status: "unsupported", value: null };
  return artifactLookup(db, "artifact", key, (id) => getLogicalArtifact(db, id));
}

function getCanonicalArtifactVersionPrefix(
  db: Db,
  ref: string,
): PrefixLookupResult<CanonicalArtifactVersionRecord> {
  const key = ref.trim().replace(/^artifact-version:/i, "");
  return artifactLookup(db, "artifact_version", key, (id) => getCanonicalArtifactVersion(db, id));
}

function getArtifactBlobPrefix(db: Db, ref: string): PrefixLookupResult<ArtifactBlobRecord> {
  const trimmed = ref.trim();
  if (!/^artifact-blob:/i.test(trimmed)) return { status: "unsupported", value: null };
  const key = trimmed.replace(/^artifact-blob:/i, "").toLowerCase();
  if (!key) return { status: "unsupported", value: null };
  return artifactLookup(db, "artifact_blob", key, (id) => getArtifactBlob(db, id));
}

export function canonicalArtifactShortRef(db: Db, hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!isSha256(normalized)) throw new Error("artifact hash must be 64 hexadecimal characters");
  if (!artifactIdentityTablesExist(db)) return formatCompactArtifactId(normalized);
  for (let length = DEFAULT_ARTIFACT_ID_PREFIX_LENGTH; length <= normalized.length; length += 1) {
    const prefix = normalized.slice(0, length);
    const blobCount = Number((db.prepare(
      "SELECT COUNT(*) AS n FROM artifact_blob WHERE lower(content_hash) LIKE ?",
    ).get(`${prefix}%`) as { n: number }).n);
    const logicalCount = Number((db.prepare(
      "SELECT COUNT(*) AS n FROM artifact WHERE lower(id) LIKE ?",
    ).get(`artifact:${prefix}%`) as { n: number }).n);
    if (blobCount === 1 && logicalCount === 0) return formatCompactArtifactId(normalized, length);
  }
  return `artifact-blob:${normalized}`;
}

export function canonicalArtifactBlobShortRef(db: Db, ref: string): string {
  const trimmed = ref.trim();
  const hash = trimmed.replace(/^artifact-blob:/i, "").toLowerCase();
  if (!isSha256(hash)) throw new Error("artifact blob ref must contain a 64-character SHA-256 hash");
  const blob = getArtifactBlob(db, artifactBlobIdFromHash(hash));
  if (!blob) return artifactBlobIdFromHash(hash);
  return `artifact-blob:${shortRef(db, "artifact_blob", blob.id, { key: hash, minimum: DEFAULT_ARTIFACT_ID_PREFIX_LENGTH })}`;
}

export function canonicalLogicalArtifactShortRef(db: Db, ref: string): string {
  const logical = getLogicalArtifact(db, ref);
  if (!logical) return ref.trim();
  const key = logical.id.replace(/^artifact:/i, "");
  for (let length = Math.min(DEFAULT_ARTIFACT_ID_PREFIX_LENGTH, key.length); length <= key.length; length += 1) {
    const candidate = `artifact:${key.slice(0, length)}`;
    const resolution = resolveArtifactIdentityRef(db, candidate);
    if (resolution?.status === "resolved"
      && resolution.target_type === "artifact"
      && resolution.target_id === logical.id) {
      return candidate;
    }
  }
  return logical.id;
}

/** Strip internal legacy compatibility refs from current API projections. */
export function projectArtifactPublicValue(db: Db, value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /artifact:sha256:([a-f0-9]{64})/gi,
      (_match, hash: string) => canonicalArtifactShortRef(db, hash),
    );
  }
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => projectArtifactPublicValue(db, entry));
  if (value && typeof value === "object") {
    const projected = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, projectArtifactPublicValue(db, entry)]),
    );
    if (typeof projected.scheme === "string" && typeof projected.normalized_ref === "string" && "blob_id" in projected) {
      projected.artifact_id = projected.blob_id;
    }
    const id = asString(projected.id);
    if (id && /^artifact-blob:/i.test(id) && asString(projected.content_hash)) {
      projected.ref = canonicalArtifactBlobShortRef(db, id);
    } else if (id && /^artifact-series:/i.test(id) && asString(projected.series_key)) {
      projected.ref = canonicalArtifactSeriesShortRef(db, id);
    } else if (id && /^artifact-version:/i.test(id) && typeof projected.version_no === "number") {
      projected.ref = canonicalArtifactVersionShortRef(db, id);
    } else if (asString(projected.content_hash)
      && asString(projected.custody_mode)
      && !asString(projected.identity_key)) {
      projected.ref = canonicalArtifactBlobShortRef(db, `artifact-blob:${asString(projected.content_hash)}`);
    } else if (id && /^artifact:/i.test(id) && asString(projected.identity_key)) {
      projected.ref = canonicalLogicalArtifactShortRef(db, id);
    }
    return projected;
  }
  return value;
}

function makeResolutionBase(ref: string) {
  return { ref, scheme: schemeFromRef(ref), normalized_ref: ref, ...emptyArtifactIdentityPayload() };
}

type ArtifactResolutionInput = Omit<ReturnType<typeof makeResolutionBase>, "logical_artifact" | "artifact_version" | "artifact_blob" | "alias"> & {
  status: "resolved" | "unresolved" | "ambiguous" | "unsupported";
  target_type?: CanonicalArtifactTargetType | null;
  target_id?: string | null;
  logical_artifact: ArtifactIdentityRecord | null;
  artifact_version: CanonicalArtifactVersionRecord | null;
  artifact_blob: ArtifactBlobRecord | null;
  alias: ArtifactAliasRecord | null;
  warnings: string[];
};

function artifactIdentityFromRecords(input: ArtifactResolutionInput): ArtifactIdentityResolution {
  const { ref, scheme, normalized_ref, warnings, alias } = input;
  const base = { ref, scheme, normalized_ref, warnings, alias };
  if (input.status === "resolved") {
    if (input.target_type === "artifact" && input.logical_artifact) {
      const head = input.artifact_version && input.artifact_blob
        ? { artifact_version: input.artifact_version, artifact_blob: input.artifact_blob }
        : { artifact_version: null, artifact_blob: null };
      return { ...base, status: "resolved", kind: "logical", target_type: "artifact", target_id: input.logical_artifact.id,
        logical_artifact: input.logical_artifact, ...head };
    }
    if (input.target_type === "artifact_version" && input.logical_artifact && input.artifact_version && input.artifact_blob) return {
      ...base, status: "resolved", kind: "pinned-version", target_type: "artifact_version", target_id: input.artifact_version.id,
      logical_artifact: input.logical_artifact, artifact_version: input.artifact_version, artifact_blob: input.artifact_blob,
    };
    if (input.target_type === "artifact_blob" && input.artifact_blob) return {
      ...base, status: "resolved", kind: "blob", target_type: "artifact_blob", target_id: input.artifact_blob.id,
      logical_artifact: null, artifact_version: null, artifact_blob: input.artifact_blob,
    };
  }
  return failedArtifactIdentity({ ...base, status: input.status === "resolved" ? "unresolved" : input.status,
    requested_kind: requestedIdentityKind(ref), target_type: input.target_type
      ?? (requestedIdentityKind(ref) === "logical" ? "artifact"
        : ["pinned-version", "series"].includes(requestedIdentityKind(ref)) ? "artifact_version"
          : requestedIdentityKind(ref) === "blob" ? "artifact_blob" : null),
    logical_artifact: input.logical_artifact, artifact_version: null, artifact_blob: null });
}

/** Historical HTTP fields are owned by the provider API boundary. */
export function projectArtifactResolution(db: Db, resolution: ArtifactIdentityResolution): import("./types.js").ArtifactResolveResult {
  return { ...resolution, alias: resolution.alias ? { ...resolution.alias, artifact_id: resolution.alias.blob_id } : null, artifact: resolvedArtifactRecord(resolution),
    series: resolution.logical_artifact ? projectCanonicalSeriesRecord(resolution.logical_artifact) : null,
    version: resolution.artifact_version ? projectCanonicalVersionRecord(db, resolution.artifact_version) : null };
}

function resolutionForCanonicalVersion(
  db: Db,
  ref: string,
  lookup: PrefixLookupResult<CanonicalArtifactVersionRecord>,
): ArtifactIdentityResolution {
  const base = makeResolutionBase(ref);
  if (lookup.status !== "resolved") {
    return artifactIdentityFromRecords({
      ...base,
      status: lookup.status,
      target_type: "artifact_version",
      target_id: null,
      warnings: lookup.status === "unsupported" ? ["artifact_version_prefix_too_short"] : [`artifact_version_${lookup.status}`],
    });
  }
  const version = lookup.value;
  const logical = getLogicalArtifact(db, version.artifact_id);
  const blob = getArtifactBlob(db, version.blob_id);
  return artifactIdentityFromRecords({
    ...base,
    status: "resolved",
    normalized_ref: version.id,
    target_type: "artifact_version",
    target_id: version.id,

    logical_artifact: logical,
    artifact_version: version,
    artifact_blob: blob,
    warnings: [],
  });
}

function resolutionForLogicalArtifact(
  db: Db,
  ref: string,
  lookup: PrefixLookupResult<ArtifactIdentityRecord>,
): ArtifactIdentityResolution {
  const base = makeResolutionBase(ref);
  if (lookup.status !== "resolved") {
    return artifactIdentityFromRecords({
      ...base,
      status: lookup.status,
      target_type: "artifact",
      target_id: null,
      warnings: lookup.status === "unsupported" ? ["artifact_prefix_too_short"] : [`artifact_${lookup.status}`],
    });
  }
  const logical = lookup.value;
  const version = logical.latest_version_id ? getCanonicalArtifactVersion(db, logical.latest_version_id) : null;
  const blob = version ? getArtifactBlob(db, version.blob_id) : null;
  return artifactIdentityFromRecords({
    ...base,
    status: "resolved",
    normalized_ref: logical.id,
    target_type: "artifact",
    target_id: logical.id,

    logical_artifact: logical,
    artifact_version: version,
    artifact_blob: blob,
    warnings: version ? [] : ["artifact_has_no_latest_version"],
  });
}

function resolutionForArtifactBlob(
  ref: string,
  lookup: PrefixLookupResult<ArtifactBlobRecord>,
  legacy: boolean,
): ArtifactIdentityResolution {
  const base = makeResolutionBase(ref);
  const legacyWarnings = legacy ? ["legacy_artifact_ref_read_only", "repair_to_artifact_blob_ref"] : [];
  if (lookup.status !== "resolved") {
    return artifactIdentityFromRecords({
      ...base,
      status: lookup.status,
      target_type: "artifact_blob",
      target_id: null,
      warnings: [
        ...legacyWarnings,
        ...(lookup.status === "unsupported" ? ["artifact_blob_prefix_too_short"] : [`artifact_blob_${lookup.status}`]),
      ],
    });
  }
  const blob = lookup.value;
  return artifactIdentityFromRecords({
    ...base,
    status: "resolved",
    normalized_ref: blob.id,
    target_type: "artifact_blob",
    target_id: blob.id,

    artifact_blob: blob,
    warnings: legacyWarnings,
  });
}

function unsupportedLegacyArtifactRef(ref: string, warning: string, repairWarning?: string): ArtifactIdentityResolution {
  const trimmed = ref.trim();
  return artifactIdentityFromRecords({
    ...makeResolutionBase(ref),
    status: "unsupported",
    normalized_ref: trimmed,
    target_id: null,
    warnings: repairWarning ? [warning, repairWarning] : [warning],
  });
}

function splitArtifactSeriesSelector(ref: string): { seriesRef: string; versionSelector: string | null } {
  const trimmed = ref.trim();
  const marker = trimmed.lastIndexOf("@");
  if (marker <= "artifact-series:".length) {
    return { seriesRef: trimmed, versionSelector: null };
  }
  return {
    seriesRef: trimmed.slice(0, marker),
    versionSelector: trimmed.slice(marker + 1).trim() || null,
  };
}

/**
 * Resolve `artifact-series:<key>` and `artifact-series:<key>@<selector>`.
 *
 * The spelling is a load-bearing authored "living identity" reference; the
 * table it was named after is gone, so it resolves through the canonical
 * logical artifact and its version history.
 */
function resolutionForArtifactSeries(db: Db, ref: string): ArtifactIdentityResolution {
  const { seriesRef, versionSelector } = splitArtifactSeriesSelector(ref);
  const base = { ...makeResolutionBase(ref), scheme: schemeFromRef(seriesRef), normalized_ref: seriesRef };
  if (!artifactIdentityTablesExist(db)) {
    return artifactIdentityFromRecords({ ...base, status: "unsupported", target_id: null, warnings: ["artifact_versioning_unavailable"] });
  }
  const lookup = resolveLogicalArtifactForSeriesRef(db, seriesRef);
  if (lookup.status !== "resolved") {
    return artifactIdentityFromRecords({
      ...base,
      status: lookup.status,
      target_id: null,
      warnings: lookup.status === "unsupported"
        ? ["artifact_series_prefix_too_short"]
        : [`artifact_series_${lookup.status}`],
    });
  }
  const logical = lookup.value;
  const seriesId = legacySeriesIdFromCanonicalArtifact(logical.id);
  const selector = versionSelector?.toLowerCase() ?? null;
  let version: CanonicalArtifactVersionRecord | null = null;
  if (selector && selector !== "latest") {
    const versionNo = Number.parseInt(selector, 10);
    if (!Number.isFinite(versionNo) || String(versionNo) !== selector || versionNo < 1) {
      return artifactIdentityFromRecords({
        ...base,
        normalized_ref: `${seriesId}@${versionSelector}`,
        logical_artifact: logical,
        status: "unsupported",
        target_id: null,
        warnings: ["artifact_series_version_invalid"],
      });
    }
    version = listCanonicalArtifactVersions(db, logical.id)
      .find((candidate) => candidate.version_no === versionNo) ?? null;
  } else if (logical.latest_version_id) {
    version = getCanonicalArtifactVersion(db, logical.latest_version_id);
  }
  if (!version) {
    return artifactIdentityFromRecords({
      ...base,
      normalized_ref: versionSelector ? `${seriesId}@${versionSelector}` : seriesId,
      logical_artifact: logical,
      status: "unresolved",
      target_id: null,
      warnings: ["artifact_series_version_unresolved"],
    });
  }
  const blob = getArtifactBlob(db, version.blob_id);
  return artifactIdentityFromRecords({
    ...base,
    normalized_ref: version.id,
    status: blob ? "resolved" : "unresolved",
    target_type: "artifact_version",
    target_id: blob ? version.id : null,

    logical_artifact: logical,
    artifact_version: version,
    artifact_blob: blob,
    warnings: selector === null || selector === "latest" ? ["series_latest_not_pinned"] : [],
  });
}

function resolveArtifactIdentityRef(db: Db, ref: string): ArtifactIdentityResolution | null {
  const trimmed = ref.trim();
  const classified = classifyArtifactRef(trimmed);
  if (classified.kind === "series") return resolutionForArtifactSeries(db, ref);
  if (classified.kind === "legacy-blob") {
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
  if (classified.kind === "pinned-version") {
    return resolutionForCanonicalVersion(db, ref, getCanonicalArtifactVersionPrefix(db, trimmed));
  }
  if (classified.kind === "blob") {
    const blobRef = classified.compact
      ? `artifact-blob:${trimmed.replace(/^artifact:/i, "")}`
      : trimmed;
    if (classified.compact) {
      const logicalLookup = getLogicalArtifactPrefix(db, trimmed);
      if (logicalLookup.status === "resolved" && logicalLookup.value.id.toLowerCase() === trimmed.toLowerCase()) {
        return resolutionForLogicalArtifact(db, ref, logicalLookup);
      }
      const blobLookup = getArtifactBlobPrefix(db, blobRef);
      const logicalResolved = logicalLookup.status === "resolved";
      const blobResolved = blobLookup.status === "resolved";
      if ((logicalResolved && blobResolved)
        || logicalLookup.status === "ambiguous"
        || blobLookup.status === "ambiguous") {
        return artifactIdentityFromRecords({
          ...makeResolutionBase(ref),
          status: "ambiguous",
          target_id: null,
          warnings: ["artifact_identity_ambiguous"],
        });
      }
      if (logicalResolved) return resolutionForLogicalArtifact(db, ref, logicalLookup);
      return resolutionForArtifactBlob(ref, blobLookup, false);
    }
    return resolutionForArtifactBlob(ref, getArtifactBlobPrefix(db, blobRef), false);
  }
  if (/^artifact:ref:/i.test(trimmed)) {
    // Retired external-reference locator. Its blob records the id.
    const blob = blobByCompatibilityArtifactId(db, trimmed);
    return resolutionForArtifactBlob(
      ref,
      blob ? { status: "resolved", value: blob } : { status: "unresolved", value: null },
      false,
    );
  }
  if (classified.kind === "logical") {
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
  return row ? artifactIdentityFromRow(db, row) : null;
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
      OR (SELECT p.project_key FROM artifact_source s JOIN ledger_projects p ON p.id=json_extract(s.source_json,'$.project_id') WHERE s.artifact_id=artifact.id) LIKE @q ESCAPE '\\'
    )`);
  }
  if (asString(options.sourceProjectId)) {
    bindings.sourceProjectId = options.sourceProjectId;
    where.push("source_project_id = @sourceProjectId");
  }
  if (asString(options.sourceRepoId)) {
    bindings.sourceRepoId = options.sourceRepoId;
    where.push("(SELECT p.project_key FROM artifact_source s JOIN ledger_projects p ON p.id=json_extract(s.source_json,'$.project_id') WHERE s.artifact_id=artifact.id) = @sourceRepoId");
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
  return rows.map(row => artifactIdentityFromRow(db, row));
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
    where.push("EXISTS (SELECT 1 FROM artifact_version v WHERE v.blob_id=artifact_blob.id AND v.custody_mode=@custody)");
  }
  if (asString(options.availability)) {
    bindings.availability = options.availability;
    where.push("CASE WHEN storage_uri IS NULL THEN 'unchecked' ELSE 'present' END = @availability");
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

function canonicalArtifactIdForSeriesRef(seriesId: string): string {
  const trimmed = seriesId.trim();
  const match = /^artifact-series:(.+)$/i.exec(trimmed);
  return match ? `artifact:${match[1]}` : `artifact:${trimmed.replace(/^artifact:/i, "")}`;
}

function canonicalArtifactSeriesRef(seriesId: string): string {
  const trimmed = seriesId.trim();
  if (/^artifact-series:/i.test(trimmed)) return trimmed;
  return `artifact-series:${trimmed.replace(/^artifact:/i, "")}`;
}

function canonicalVersionIdForVersionRef(versionId: string): string {
  const trimmed = versionId.trim();
  return /^artifact-version:/i.test(trimmed) ? trimmed : `artifact-version:${trimmed}`;
}

function upsertCanonicalArtifactBlob(db: Db, artifact: ArtifactRecord, now = Date.now()): ArtifactBlobRecord {
  const blobId = artifactBlobIdFromHash(artifact.content_hash);
  db.prepare(`INSERT INTO artifact_blob
    (id,algorithm,content_hash,storage_uri,media_type,role,size_bytes,provider_id,manifest_id,metadata_json,created_at)
    VALUES (@id,@algorithm,@content_hash,@storage_uri,@media_type,@role,@size_bytes,@provider_id,@manifest_id,@metadata_json,@created_at)
    ON CONFLICT(algorithm,content_hash) DO UPDATE SET
      storage_uri=COALESCE(artifact_blob.storage_uri,excluded.storage_uri),
      media_type=COALESCE(artifact_blob.media_type,excluded.media_type),
      role=COALESCE(artifact_blob.role,excluded.role)
  `).run({id:blobId,algorithm:artifact.algorithm,content_hash:artifact.content_hash,
    storage_uri:artifact.custody_mode === 'managed' ? artifact.uri : null,
    media_type:artifact.media_type,role:artifact.role,size_bytes:artifact.size_bytes,
    provider_id:artifact.provider_id,manifest_id:artifact.manifest_id,
    metadata_json:jsonStringify(descriptiveArtifactMetadata(artifact.metadata)),created_at:artifact.created_at || now});
  return getArtifactBlob(db,blobId)!;
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
): { targetType: "artifact" | "artifact_version"; targetId: string; resolution: ArtifactIdentityResolution | null } {
  if (input.target_type && input.target_id) {
    return { targetType: input.target_type, targetId: input.target_id, resolution: null };
  }
  if (!input.target_ref) throw new Error("target_ref or target_type plus target_id is required");
  const resolution = resolveArtifactIdentity(db, input.target_ref, "strict-read");
  if (resolution.status !== "resolved" || !resolution.target_type || !resolution.target_id) {
    throw new Error(`artifact target did not resolve: ${input.target_ref}`);
  }
  if (resolution.target_type === "artifact_blob") {
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
): { association: ProjectArtifactAssociationRecord; resolution: ArtifactIdentityResolution | null } {
  if (!tableExists(db, "project_artifact_associations")) {
    throw new Error("project_artifact_associations table is not present in this database");
  }
  const project = resolveProjectRef(db, input.project_ref);
  if (!project.ok) {
    throw new Error((!project.ok && project.reason === "ambiguous") ? `ambiguous project ref: ${input.project_ref}` : `project not found: ${input.project_ref}`);
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
    metadata_json: jsonStringify(descriptiveArtifactMetadata(input.metadata ?? {})),
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
    if (!project.ok) return [];
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


function versionIdFor(seriesId: string, sourceKind: string, naturalKey: string): string {
  return artifactRegistryId("artifact-version", [seriesId, sourceKind, naturalKey]);
}

// Percent-escape `:` (and the escape char itself) within a single series-key
// component so a `:`-joined default key is unambiguous: namespace "a:b" + name
// "c" must not collide with namespace "a" + role "b" + name "c".
function escapeSeriesKeyComponent(value: string): string {
  return value.replace(/%/g, "%25").replace(/:/g, "%3A");
}

function projectCanonicalSeriesRecord(logical: ArtifactIdentityRecord): ArtifactSeriesRecord {
  return {
    id: legacySeriesIdFromCanonicalArtifact(logical.id),
    series_key: logical.identity_key,
    source_kind: logical.source_kind as ArtifactSeriesSourceKind,
    title: logical.title,
    repo_id: logical.source_repo_id,
    logical_name: logical.logical_name,
    latest_version_id: logical.latest_version_id,
    version_count: logical.version_count,
    metadata: logical.metadata,
    created_at: logical.created_at,
    updated_at: logical.updated_at,
  };
}

function projectCanonicalVersionRecord(
  _db: Db,
  version: CanonicalArtifactVersionRecord,
): ArtifactVersionRecord {
  return {
    id: version.id,
    series_id: legacySeriesIdFromCanonicalArtifact(version.artifact_id),
    artifact_id: version.id,
    version_no: version.version_no,
    parent_version_id: version.parent_version_id,
    source_kind: version.source_kind as ArtifactVersionSourceKind,
    content_hash: version.content_hash,
    commit_sha: version.commit_sha,
    repo_path: version.repo_path,
    observed_path: version.observed_path,
    custody_mode: version.custody_mode,
    label: version.label,
    note: version.note,
    metadata: version.metadata,
    created_at: version.created_at,
  };
}

export function getArtifactSeries(db: Db, idOrKey: string): ArtifactSeriesRecord | null {
  const logical = getLogicalArtifactForSeriesRef(db, idOrKey);
  return logical ? projectCanonicalSeriesRecord(logical) : null;
}

/** The canonical logical artifact an `artifact-series:` ref, id, or key names. */
function getLogicalArtifactForSeriesRef(db: Db, idOrKey: string): ArtifactIdentityRecord | null {
  if (!artifactIdentityTablesExist(db)) return null;
  const logicalId = /^artifact-series:/i.test(idOrKey)
    ? canonicalArtifactIdForSeriesRef(idOrKey)
    : /^artifact:/i.test(idOrKey)
      ? idOrKey
      : null;
  const row = logicalId
    ? db.prepare("SELECT * FROM artifact WHERE id = ?").get(logicalId)
    : db.prepare("SELECT * FROM artifact WHERE identity_key = ?").get(idOrKey);
  return row ? artifactIdentityFromRow(db, row as Record<string, unknown>) : null;
}

function resolveLogicalArtifactForSeriesRef(
  db: Db,
  ref: string,
): PrefixLookupResult<ArtifactIdentityRecord> {
  const key = ref.trim().replace(/^artifact(?:-series)?:/i, "");
  return artifactLookup(db, "artifact", key, (id) => getLogicalArtifact(db, id));
}

export function getArtifactVersion(db: Db, id: string): ArtifactVersionRecord | null {
  const canonical = getCanonicalArtifactVersion(db, id);
  return canonical ? projectCanonicalVersionRecord(db, canonical) : null;
}

export function canonicalArtifactSeriesShortRef(db: Db, ref: string): string {
  const series = getArtifactSeries(db, ref);
  if (!series) return canonicalArtifactSeriesRef(ref);
  const canonical = canonicalArtifactSeriesRef(series.id);
  const key = canonical.replace(/^artifact-series:/i, "");
  return `artifact-series:${shortRef(db, "artifact", `artifact:${key}`, { key, minimum: DEFAULT_ARTIFACT_ID_PREFIX_LENGTH })}`;
}

export function canonicalArtifactVersionShortRef(db: Db, ref: string): string {
  const version = getArtifactVersion(db, ref);
  if (!version) return canonicalVersionIdForVersionRef(ref);
  const canonical = canonicalVersionIdForVersionRef(version.id);
  const key = canonical.replace(/^artifact-version:/i, "");
  return `artifact-version:${shortRef(db, "artifact_version", canonical, { key, minimum: DEFAULT_ARTIFACT_ID_PREFIX_LENGTH })}`;
}

export function listArtifactVersions(db: Db, seriesId: string): ArtifactVersionRecord[] {
  if (!artifactIdentityTablesExist(db)) return [];
  const logicalId = /^artifact:/i.test(seriesId) && !/^artifact-series:/i.test(seriesId)
    ? seriesId
    : canonicalArtifactIdForSeriesRef(seriesId);
  return listCanonicalArtifactVersions(db, logicalId)
    .map((version) => projectCanonicalVersionRecord(db, version));
}

export interface EnsureArtifactSeriesInput {
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title?: string;
  repo_id?: string;
  logical_name?: string;
  metadata?: JsonRecord;
}

export function ensureArtifactSeries(db: Db, input: EnsureArtifactSeriesInput, now = Date.now()): ArtifactSeriesRecord {
  const existing = getArtifactSeries(db, input.series_key);
  if (existing) return existing;
  if (input.source_kind !== 'managed') throw new Error('File identities require the artifact version planner');
  const id = `artifact:${crypto.randomBytes(32).toString('hex')}`;
  db.transaction(() => {
    db.prepare(`INSERT INTO artifact (id,identity_key,source_kind,title,logical_name,version_count,metadata_json,created_at,updated_at)
      VALUES (?,?,'managed',?,?,0,?,?,?)`).run(id,input.series_key,input.title ?? null,input.logical_name ?? null,jsonStringify(input.metadata ?? {}),now,now);
    db.prepare('INSERT INTO artifact_source VALUES (?,?,1,NULL,?)').run(id,sourceKey({kind:'managed',key:input.series_key}),now);
  }).immediate();
  return getArtifactSeries(db, id)!;
}

export interface AppendArtifactVersionInput {
  source_project_id?: string;
  source_repo_id?: string;
  logical_artifact_id: string;
  blob_id: string;
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

function canonicalParentVersionId(db: Db, artifactId: string, versionNo: number): string | null {
  if (versionNo === 1) return null;
  const parent = db.prepare(
    "SELECT id FROM artifact_version WHERE artifact_id = ? AND version_no = ?",
  ).get(artifactId, versionNo - 1) as { id: string } | undefined;
  if (!parent) {
    throw new Error(
      `artifact version ${versionNo} requires canonical predecessor ${versionNo - 1} for ${artifactId}`,
    );
  }
  return parent.id;
}

type VersionEvidenceInput = {
  [K in keyof Omit<AppendArtifactVersionInput, 'logical_artifact_id' | 'blob_id' | 'source_kind'>]?: AppendArtifactVersionInput[K] | null;
};
function artifactVersionEvidence(input: VersionEvidenceInput): string {
  return stableJsonStringify({
    hash: input.content_hash, project: input.source_project_id ?? null, commit: input.commit_sha ?? null,
    path: input.repo_path ?? null, observed: input.commit_sha ? null : input.observed_path ?? null,
    custody: input.custody_mode ?? null, label: input.label ?? null, note: input.note ?? null, metadata: input.metadata ?? {},
  });
}
function artifactEvidenceVersionId(seriesId: string, input: Omit<AppendArtifactVersionInput, 'logical_artifact_id' | 'blob_id'>): string {
  return versionIdFor(seriesId, input.source_kind, stableJsonStringify([input.natural_key ?? null, artifactVersionEvidence(input)]));
}

function findRepeatedArtifactVersion(db: Db, seriesId: string, input: Omit<AppendArtifactVersionInput, 'logical_artifact_id' | 'blob_id'>, registeredFile = false): CanonicalArtifactVersionRecord | null {
  const current = getCanonicalArtifactVersion(db, artifactEvidenceVersionId(seriesId, input));
  if (current) return current;
  const legacyKey = input.natural_key ?? (input.source_kind === 'tracked_repo'
    ? `${input.commit_sha ?? ''}:${input.repo_path ?? ''}` : input.content_hash);
  const keys = new Set([legacyKey]);
  if (registeredFile && input.source_kind === 'tracked_repo') {
    // Registered file writes used both automatic key shapes; explicit producer keys remain distinct.
    keys.add(`${input.commit_sha}:${input.repo_path}`);
    keys.add(`${input.source_project_id}:${input.commit_sha}:${input.repo_path}`);
  }
  for (const key of keys) {
    const legacy = getCanonicalArtifactVersion(db, versionIdFor(seriesId, input.source_kind, key));
    if (legacy && artifactVersionEvidence(input) === artifactVersionEvidence(legacy)) return legacy;
  }
  return null;
}

export function appendArtifactVersion(
  db: Db,
  input: AppendArtifactVersionInput,
  now = Date.now(),
): { version: CanonicalArtifactVersionRecord; created: boolean } {
  assertVersioningTables(db);
  if (!VERSION_SOURCE_KINDS.has(input.source_kind)) {
    throw new Error(`unsupported version source_kind: ${input.source_kind}`);
  }
  // The MAX(version_no) read, the version insert, and the identity-counter
  // update must be one atomic unit so a crash never leaves version_count /
  // latest_version_id / source_kind out of sync with the actual rows, and so a
  // concurrent writer (separate process/connection) cannot read the same
  // MAX(version_no). The deterministic version id keeps re-records idempotent
  // (ON CONFLICT(id) DO NOTHING). We run with BEGIN IMMEDIATE so the write lock
  // is taken before the MAX read; within one process synchronous SQLite is already
  // serialized. If we are already inside a transaction, run inline (the
  // caller's transaction provides the boundary).
  const body = (): { version: CanonicalArtifactVersionRecord; created: boolean } => {
    const logical = getLogicalArtifact(db, input.logical_artifact_id);
    if (!logical) throw new Error(`Logical artifact not found: ${input.logical_artifact_id}`);
    const logicalId = logical.id;
    const seriesId = legacySeriesIdFromCanonicalArtifact(logicalId);
    const blob = getArtifactBlob(db, input.blob_id);
    if (!blob) throw new Error(`Canonical artifact blob not found: ${input.blob_id}`);
    if (blob.content_hash !== input.content_hash) throw new Error('Version hash differs from immutable blob');
    const state = getArtifactCurrentSource(db, logicalId);
    if (!state?.source || state.reconciliation_reason) throw new Error('Artifact source requires reconciliation');
    if (input.source_kind === 'tracked_repo' || (input.source_kind === 'local_only' && input.repo_path)) {
      if ((state.source.kind !== 'repo' || state.source.project_id !== input.source_project_id || state.source.path !== input.repo_path)
        && !(input.commit_sha && input.source_project_id && input.repo_path && artifactSourceLineage(db, { kind: 'repo', project_id: input.source_project_id, path: input.repo_path }).includes(logicalId))) {
        throw new Error('Version source does not match registered source');
      }
    } else if (input.source_kind === 'local_only' && (state.source.kind !== 'local' || state.source.path !== input.observed_path)) {
      throw new Error('Version source does not match registered source');
    }
    if (input.source_kind === 'tracked_repo') {
      if (!input.commit_sha || !/^[a-f0-9]{40,64}$/i.test(input.commit_sha) || !input.repo_path || !input.source_project_id) throw new Error('Tracked versions require canonical repository, commit and path');
    }
    const custody = asCustodyMode(input.custody_mode, 'managed');
    if (custody === 'git') {
      if (!input.source_project_id || !input.repo_path || !input.commit_sha) throw new Error('Git custody requires canonical project, commit and path');
      retainArtifactCommit(db,{project:input.source_project_id,commit:input.commit_sha,path:input.repo_path,sha256:input.content_hash});
    } else {
      if (!blob.storage_uri?.startsWith('file://') || hashBuffer(fs.readFileSync(fileURLToPath(blob.storage_uri))) !== input.content_hash) throw new Error('Managed version requires verified stored bytes');
    }
    const versionId = artifactEvidenceVersionId(seriesId, input);
    const existing = findRepeatedArtifactVersion(db, seriesId, input);
    if (existing) return { version: existing, created: false };
    const nextNo = Number((db.prepare(
      "SELECT COALESCE(MAX(version_no), 0) AS n FROM artifact_version WHERE artifact_id = ?",
    ).get(logicalId) as { n: number }).n) + 1;
    const parentVersionId = canonicalParentVersionId(db, logicalId, nextNo);
    const result = db.prepare(
      `INSERT INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash,
        source_project_id, repo_path, commit_sha, observed_path,
        parent_version_id, custody_mode, label, note, metadata_json, created_at
      ) VALUES (
        @id, @artifact_id, @version_no, @blob_id, @source_kind, @content_hash,
        @source_project_id, @repo_path, @commit_sha, @observed_path,
        @parent_version_id, @custody_mode, @label, @note, @metadata_json, @created_at
      ) ON CONFLICT(id) DO NOTHING`,
    ).run({
      id: versionId,
      artifact_id: logicalId,
      version_no: nextNo,
      blob_id: blob.id,
      source_kind: input.source_kind,
      content_hash: input.content_hash,
      source_project_id: input.custody_mode === "git" ? input.source_project_id : null,
      repo_path: input.custody_mode === "git" ? input.repo_path : null,
      commit_sha: input.custody_mode === "git" ? input.commit_sha : null,
      observed_path: input.observed_path ?? null,
      parent_version_id: parentVersionId,
      custody_mode: input.custody_mode ?? "managed",
      label: input.label ?? null,
      note: input.note ?? null,
      metadata_json: jsonStringify(descriptiveArtifactMetadata(input.metadata ?? {})),
      created_at: now,
    });
    const created = result.changes > 0;
    if (created) {
      const nextSourceKind: ArtifactSeriesSourceKind = logical.version_count === 0
        ? input.source_kind
        : logical.source_kind === "mixed" || logical.source_kind === input.source_kind
          ? logical.source_kind
          : "mixed";
      db.prepare(
        `UPDATE artifact
            SET latest_version_id = @version_id,
                version_count = version_count + 1,
                source_kind = @source_kind,
                updated_at = @now
          WHERE id = @artifact_id`,
      ).run({
        version_id: versionId,
        source_kind: nextSourceKind,
        now,
        artifact_id: logicalId,
      });
    }
    if (created && input.source_project_id && custody === 'managed') {
      associateProjectArtifact(db,{project_ref:input.source_project_id,target_type:'artifact_version',target_id:versionId,
        role:'historical-source-access',source:'system'},now);
    }
    return {
      version: getCanonicalArtifactVersion(db, versionId) as CanonicalArtifactVersionRecord,
      created,
    };
  };
  if (db.inTransaction) return body();
  return db.transaction(body).immediate();
}

export interface RecordArtifactVersionInput {
  commit?: string;
  project?: string;
  cwd?: string;
  artifact_id?: string;
  source?: ArtifactSource;
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

export interface ArtifactVersionPlan {
  artifact_id: string | null;
  source: ArtifactSource;
  expected_source_revision: number | null;
  required_project_ids: string[];
  content_hash: string;
  custody_mode: "git" | "managed";
  source_kind: ArtifactVersionSourceKind;
  commit_sha: string | null;
  repo_path: string | null;
  source_project_id: string | null;
  source_repo_id: string | null;
  observed_path: string | null;
  warnings: string[];
}
interface PreparedArtifactVersion {
  db: Db;
  input: RecordArtifactVersionInput;
  bytes: Buffer;
  frozen: string;
  series_key: string;
  logical_name?: string;
  media_type?: string;
  owner_project_id: string | null;
  metadata: JsonRecord;
  committed?: CommittedArtifactFile;
}
const versionPlans = new WeakMap<ArtifactVersionPlan, PreparedArtifactVersion>();

export function planArtifactVersion(db: Db, input: RecordArtifactVersionInput): ArtifactLifecycleResult<ArtifactVersionPlan> {
  try {
    const committed = input.commit ? readCommittedArtifactFiles(db, {
      project: input.project, cwd: input.cwd, commit: input.commit, paths: [input.path ?? ''],
    })[0] : undefined;
    return prepareArtifactVersion(db, input, committed);
  } catch (error) { return artifactFailure('invalid_input', String(error)); }
}

export function planArtifactVersionBatch(db: Db, inputs: RecordArtifactVersionInput[]): ArtifactLifecycleResult<ArtifactVersionPlan[]> {
  try {
    const plans: ArtifactVersionPlan[] = [];
    const groups = new Map<string, { indices: number[]; input: RecordArtifactVersionInput }>();
    inputs.forEach((input, index) => {
      if (!input.commit) return;
      const key = JSON.stringify([input.project, input.cwd, input.commit]);
      const group = groups.get(key) ?? { indices: [], input };
      group.indices.push(index); groups.set(key, group);
    });
    const committed = new Map<number, CommittedArtifactFile>();
    for (const {indices, input} of groups.values()) {
      const files = readCommittedArtifactFiles(db, { project: input.project, cwd: input.cwd,
        commit: input.commit!, paths: indices.map(i => inputs[i].path ?? '') });
      indices.forEach((index, i) => committed.set(index, files[i]));
    }
    for (const [i, input] of inputs.entries()) {
      const plan = prepareArtifactVersion(db, input, committed.get(i));
      if (!plan.ok) return plan;
      if (plans.some(p => sourceKey(p.source) === sourceKey(plan.value.source))) return artifactFailure('invalid_input', 'Batch paths must name distinct sources');
      plans.push(plan.value);
    }
    return { ok: true, value: plans };
  } catch (error) { return artifactFailure('invalid_input', String(error)); }
}

function prepareArtifactVersion(db: Db, input: RecordArtifactVersionInput, committed?: CommittedArtifactFile): ArtifactLifecycleResult<ArtifactVersionPlan> {
  try {
    if (!VERSION_SOURCE_KINDS.has(input.source_kind)) return artifactFailure('invalid_input', `unsupported version source_kind: ${input.source_kind}`);
    let source: ArtifactSource;
    let bytes: Buffer;
    let local: LocalArtifactPlan | null = null;
    let kind = input.source_kind;
    let commit: string | null = null;
    let repoPath: string | null = null;
    let repoId: string | null = null;
    let projectId: string | null = null;
    let observed: string | null = null;
    let logicalName = input.logical_name;
    let mediaType = input.media_type;
    let seriesKey = input.series_key;
    const warnings: string[] = [];
    if (input.custody_mode && !['git','managed'].includes(input.custody_mode)) return artifactFailure('invalid_input', 'Unsupported version custody mode');
    const named = input.artifact_id ? getLogicalArtifactPrefix(db, input.artifact_id) : null;
    if (named && named.status !== 'resolved') return artifactFailure('unknown_artifact', 'Canonical artifact ID did not resolve unambiguously');
    const explicit = named?.value ?? null;
    if (committed) {
      bytes = committed.bytes;
      logicalName ??= path.posix.basename(committed.path);
      mediaType ??= mediaTypeForPath(committed.path);
    } else if (input.path) {
      local = planLocalArtifactPath(db, { path: input.path, custody_mode: 'git' });
      bytes = fs.readFileSync(local.resolved_path);
      if (hashBuffer(bytes) !== local.sha256) return artifactFailure('stale_plan', 'File changed while planning');
      observed = local.resolved_path;
      logicalName ??= local.logical_name;
      mediaType ??= local.media_type;
    } else if (input.ref) {
      const resolved = resolveArtifactIdentity(db, input.ref, "strict-read");
      if (!resolvedArtifactRecord(resolved)) return artifactFailure('invalid_input', 'Artifact reference did not resolve');
      const target = artifactMaterializationTarget(resolved);
      if (!target.ok) return artifactFailure('invalid_input', target.error.message);
      const read = readArtifactMaterial(db, target.value, 4 * 1024 * 1024);
      if (!read.ok) return artifactFailure('invalid_input', `Artifact bytes are not materializable (${read.error.message})`);
      bytes = read.value.bytes;
      logicalName ??= asString(resolvedArtifactRecord(resolved)!.metadata.logical_name) ?? asString(resolvedArtifactRecord(resolved)!.metadata.filename);
      mediaType ??= resolvedArtifactRecord(resolved)!.media_type ?? undefined;
    } else if (typeof input.content === 'string' || typeof input.content_base64 === 'string' || 'json' in input) {
      bytes = bufferFromSnapshotInput(input);
    } else return artifactFailure('invalid_input', 'Version requires a path, content, content_base64, json, or ref');

    if (committed) {
      projectId = committed.project_id; repoId = committed.project_key;
      repoPath = committed.path; commit = committed.commit;
      source = { kind: 'repo', project_id: projectId, path: repoPath };
      seriesKey ??= `repo:${repoId}:${repoPath}`;
      kind = input.custody_mode === 'managed' ? 'managed' : 'tracked_repo';
      if (input.source && sourceKey(input.source) !== sourceKey(source)) return artifactFailure('source_mismatch', 'Declared source differs from committed source');
    } else if (local) {
      const git = local.git_state;
      const repo = resolveProjectRef(db, path.resolve(git.repo_root ?? path.dirname(local.resolved_path)), { observedPath: path.dirname(local.input_path) });
      if (!repo.ok && repo.reason === 'ambiguous') return artifactFailure('invalid_source', 'Repository is ambiguous');
      if (repo.ok && (git.relative_path || repo.checkout)) {
        projectId = repo.project.id;
        repoId = repo.project.project_key;
        repoPath = repo.matched_by === 'checkout_ancestry' || !git.relative_path
          ? path.relative(safeRealpathSync(repo.checkout!.root), local.resolved_path).split(path.sep).join('/')
          : git.relative_path;
        source = { kind: 'repo', project_id: projectId, path: repoPath };
        seriesKey ??= `repo:${repoId}:${repoPath}`;
        if (local.recoverability === 'repo_commit') commit = git.commit ?? null;
      } else {
        source = { kind: 'local', path: local.resolved_path };
        seriesKey ??= `local:${local.resolved_path}`;
      }
      if (input.source && sourceKey(input.source) !== sourceKey(source)) {
        return artifactFailure('source_mismatch', 'Declared source differs from the actual file source');
      }
      if (kind === 'tracked_repo') {
        if (source.kind !== 'repo') return artifactFailure('invalid_input', 'tracked_repo version requires a file inside a registered repo');
        if (commit) {
          if (input.custody_mode === 'managed') kind = 'managed';
        } else {
          kind = 'managed';
          warnings.push('tracked_repo_dirty_recorded_as_local_only', ...local.warnings);
        }
      }
    } else {
      if (kind !== 'managed') return artifactFailure('invalid_input', `${kind} version requires a file path`);
      const namespace = asString(input.provider_id) ?? asString(input.repo_id) ?? asString(input.issue);
      if (!seriesKey && !explicit && !input.source) {
        if (!logicalName || !namespace) return artifactFailure('invalid_input', 'managed version requires logical_name and a namespace or an explicit series_key');
        seriesKey = `managed:${[namespace, ...(input.role ? [input.role] : []), logicalName].map(escapeSeriesKeyComponent).join(':')}`;
      }
      const current = explicit ? getArtifactCurrentSource(db, explicit.id) : null;
      source = input.source ?? current?.source ?? { kind: 'managed', key: seriesKey ?? explicit!.identity_key };
      seriesKey ??= explicit?.identity_key ?? `source:${sourceKey(source)}`;
      observed = null;
    }
    if (input.custody_mode === 'git' && (!commit || !projectId || !repoPath)) return artifactFailure('invalid_input', 'Git custody requires exact committed bytes; commit the file or use managed custody');
    const valid = validateArtifactSource(db, source);
    if (!valid.ok) return valid;
    const lineage = committed ? artifactSourceLineage(db, source) : [];
    if (committed && explicit && !lineage.includes(explicit.id)) return artifactFailure('source_mismatch', 'Historical target has no source lineage for this path');
    if (committed && !explicit && lineage.length > 1) return artifactFailure('ambiguous_source', 'Historical path belongs to multiple artifacts; select --artifact');
    const lookup = committed ? { ok: true as const, value: null } : lookupArtifactCurrentSource(db, source);
    if (!lookup.ok) return lookup;
    const target = explicit ?? (committed && lineage.length === 1 ? getLogicalArtifact(db, lineage[0])
      : lookup.value ? getLogicalArtifact(db, lookup.value.artifact_id) : null);
    // A creation label cannot redirect a write to a different registered source.
    const keyed = input.series_key ? getLogicalArtifactForSeriesRef(db, input.series_key) : null;
    if (keyed && (!target || keyed.id !== target.id)) return artifactFailure('source_mismatch', 'series_key names a different artifact; use its canonical artifact_id and registered source');
    const state = target ? getArtifactCurrentSource(db, target.id) : null;
    if (target && (!state || state.reconciliation_reason || !state.source)) return artifactFailure('reconciliation_required', state?.reconciliation_reason ?? 'Artifact current source is missing');
    if (!committed && state?.source && sourceKey(state.source) !== sourceKey(source)) return artifactFailure('source_mismatch', 'Artifact source differs; use an explicit guarded source move');
    if (lookup.value && target && lookup.value.artifact_id !== target.id) return artifactFailure('source_mismatch', 'Source is registered to another artifact');
    let ownerProject: string | null = null;
    for (const ref of [input.repo_id, input.project]) {
      if (!ref) continue;
      const owner = resolveProjectRef(db, ref);
      if (!owner.ok) return artifactFailure('invalid_source', `Artifact project ${ref} is unknown or ambiguous`);
      ownerProject = owner.project.id;
    }
    // A selected project names the artifact's project; a repository file's project is its repository.
    if (input.project && source.kind === 'repo' && source.project_id !== ownerProject) return artifactFailure('source_mismatch', 'Selected project differs from source repository');
    if (input.project && source.kind !== 'repo' && target && target.source_project_id !== ownerProject) return artifactFailure('source_mismatch', 'Selected project differs from the existing artifact\'s project; omit --project, or use mandible artifact associate');
    if (target) ownerProject = target.source_project_id;
    else ownerProject ??= projectId ?? (source.kind === 'repo' ? source.project_id : null);
    const required = artifactRequiredProjects(db, target?.id ?? null, state?.source ?? null, source);
    if (ownerProject && !required.includes(ownerProject)) required.push(ownerProject);
    if (input.custody_mode === 'managed' || kind === 'local_only') kind = 'managed';
    const plan: ArtifactVersionPlan = {
      artifact_id: target?.id ?? null, source, expected_source_revision: state?.revision ?? null,
      required_project_ids: required.sort(), content_hash: hashBuffer(bytes), source_kind: kind,
      custody_mode: input.custody_mode === 'managed' ? input.custody_mode
        : kind === 'tracked_repo' ? 'git' : 'managed',
      commit_sha: commit, repo_path: repoPath, source_project_id: projectId, source_repo_id: repoId,
      observed_path: observed, warnings: Array.from(new Set(warnings)),
    };
    versionPlans.set(plan, { db, input: structuredClone(input), bytes, committed, frozen: JSON.stringify(plan),
      series_key: seriesKey!, logical_name: logicalName, media_type: mediaType, owner_project_id: ownerProject,
      metadata: mergeJsonRecords(input.metadata, input.source_kind === "tracked_repo" && kind === "managed"
        ? { head_commit: local?.git_state.commit, dirty_at_commit: local?.git_state.commit } : {}) });
    return { ok: true, value: plan };
  } catch (error) { return artifactFailure('invalid_input', String(error)); }
}

function revalidateArtifactVersion(db: Db, plan: ArtifactVersionPlan): ArtifactLifecycleResult<PreparedArtifactVersion> {
  const prepared = versionPlans.get(plan);
  if (!prepared || prepared.db !== db || prepared.frozen !== JSON.stringify(plan)) return artifactFailure('stale_plan', 'Version plan is not an unchanged issued plan');
  const fresh = prepareArtifactVersion(db, prepared.input, prepared.committed);
  if (!fresh.ok) return fresh;
  if (JSON.stringify(fresh.value) !== prepared.frozen) return artifactFailure('stale_plan', 'Artifact source, ownership, or content changed after planning');
  return { ok: true, value: prepared };
}

function artifactVersionWriteResult(db: Db, version: CanonicalArtifactVersionRecord, created: boolean, warnings: string[]): import("./contracts.js").ArtifactVersionWriteResult {
  const resolution = resolutionForCanonicalVersion(db, version.id, { status: "resolved", value: version });
  if (resolution.status !== "resolved" || resolution.kind !== "pinned-version") throw new Error("Saved artifact version lacks canonical material");
  return { ...resolution, created, warnings };
}

export function projectArtifactVersionWriteResult(db: Db, result: import("./contracts.js").ArtifactVersionWriteResult): import("./contracts.js").ArtifactVersionRecordResult {
  const projected = projectArtifactResolution(db, result);
  if (!projected.series || !projected.version || !projected.artifact) throw new Error("Saved artifact HTTP projection lacks material");
  return { ...result, series: projected.series, version: projected.version, artifact: projected.artifact };
}

export function commitArtifactVersionBatch(db: Db, plans: ArtifactVersionPlan[], now = Date.now(), artifactRoot = getArtifactRoot(db)): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult[]> {
  try {
    return db.transaction((): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult[]> => {
      for (const plan of plans) {
        const checked = revalidateArtifactVersion(db, plan);
        if (!checked.ok) return checked;
      }
      const results = plans.map(plan => {
        const result = commitPreparedArtifactVersion(db, plan, versionPlans.get(plan)!, now, artifactRoot);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      });
      return { ok: true, value: results };
    }).immediate();
  } catch (error) { return artifactFailure('storage_error', String(error)); }
}

export function commitArtifactVersion(
  db: Db, plan: ArtifactVersionPlan, now = Date.now(), artifactRoot = getArtifactRoot(db),
): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult> {
  return db.transaction((): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult> => {
    const checked = revalidateArtifactVersion(db, plan);
    if (!checked.ok) return checked;
    return commitPreparedArtifactVersion(db, plan, checked.value, now, artifactRoot);
  }).immediate();
}

function commitPreparedArtifactVersion(db: Db, plan: ArtifactVersionPlan, prepared: PreparedArtifactVersion,
  now: number, artifactRoot: string): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult> {
  try {
    return db.transaction((): ArtifactLifecycleResult<import("./contracts.js").ArtifactVersionWriteResult> => {
      const input = prepared.input;
      let logicalId = plan.artifact_id;
      if (!logicalId) {
        logicalId = `artifact:${crypto.randomBytes(32).toString('hex')}`;
        const identityKey = db.prepare('SELECT 1 FROM artifact WHERE identity_key=?').get(prepared.series_key)
          ? `identity:${logicalId.slice(9)}` : prepared.series_key;
        db.prepare(`INSERT INTO artifact (id,identity_key,source_kind,title,source_project_id,
          logical_name,version_count,metadata_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,0,?,?,?)`).run(logicalId, identityKey, plan.source_kind, input.title ?? null,
            prepared.owner_project_id, prepared.logical_name ?? null, jsonStringify(descriptiveArtifactMetadata(input.metadata ?? {})), now, now);
        db.prepare('INSERT INTO artifact_source VALUES (?,?,1,NULL,?)').run(logicalId, sourceKey(plan.source), now);
      }
      const linked = plan.custody_mode === 'git';
      const custody = plan.custody_mode;
      const locator = linked ? { repo_id: plan.source_project_id, path: plan.repo_path, commit: plan.commit_sha } : {};
      const evidence = {
        source_kind: plan.source_kind, content_hash: plan.content_hash,
        source_project_id: plan.source_project_id ?? undefined, source_repo_id: plan.source_repo_id ?? undefined,
        natural_key: linked ? `${plan.source_project_id}:${plan.commit_sha}:${plan.repo_path}` : undefined,
        commit_sha: plan.commit_sha ?? undefined, repo_path: plan.repo_path ?? undefined,
        observed_path: plan.observed_path ?? undefined, custody_mode: custody,
        label: input.label, note: input.note, metadata: prepared.metadata,
      };
      const seriesId = legacySeriesIdFromCanonicalArtifact(logicalId);
      const repeated = findRepeatedArtifactVersion(db, seriesId, evidence, true);
      if (repeated) return { ok: true, value: artifactVersionWriteResult(db, repeated, false, plan.warnings) };
      const artifact = ingestArtifact(db, {
        ...(linked ? { [VERIFIED_GIT_DESCRIPTOR]: true as const, sha256: plan.content_hash, uri: `repo://${plan.source_repo_id}@${plan.commit_sha}/${plan.repo_path}` }
          : { content_buffer: prepared.bytes }),
        custody_mode: custody, role: input.role, media_type: prepared.media_type,
        logical_name: prepared.logical_name, size_bytes: prepared.bytes.length,
        home_repo_id: plan.source_project_id ?? undefined, repo_locator: locator, availability: 'present',
        metadata: mergeJsonRecords(input.metadata, { recoverability: linked ? 'repo_commit' : 'mandible_cas',
          observed_path: plan.observed_path, filename: prepared.logical_name }),
      }, now, artifactRoot);
      const appended = appendArtifactVersion(db, { ...evidence, logical_artifact_id: logicalId, blob_id: artifact.id }, now);
      return { ok: true, value: artifactVersionWriteResult(db, appended.version, appended.created, plan.warnings) };
    }).immediate();
  } catch (error) { return artifactFailure('storage_error', String(error)); }
}

export function recordArtifactVersion(
  db: Db, input: RecordArtifactVersionInput, now = Date.now(), artifactRoot = getArtifactRoot(db),
): import("./contracts.js").ArtifactVersionWriteResult {
  const plan = planArtifactVersion(db, input);
  if (!plan.ok) throw new Error(plan.error.message);
  const result = commitArtifactVersion(db, plan.value, now, artifactRoot);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function artifactDraftId(seriesId: string): string {
  return `artifact-draft:${crypto.createHash("sha256").update(seriesId).digest("hex")}`;
}

function legacySeriesIdFromCanonicalArtifact(artifactId: string): string {
  return artifactId.replace(/^artifact:/i, "artifact-series:");
}

function draftFromRow(db: Db, row: Record<string, unknown>): ArtifactDraftRecord {
  const canonicalArtifactId = String(row.artifact_id);
  const canonicalBaseVersionId = String(row.version_id);
  const seriesId = legacySeriesIdFromCanonicalArtifact(canonicalArtifactId);
  const canonicalArtifact = getLogicalArtifact(db, canonicalArtifactId);
  const canonicalBaseVersion = getCanonicalArtifactVersion(db, canonicalBaseVersionId);
  const latestId = canonicalArtifact?.latest_version_id ?? null;
  const latestCanonical = latestId ? getCanonicalArtifactVersion(db, latestId) : null;
  return {
    id: String(row.id),
    series_id: seriesId,
    base_version_id: canonicalBaseVersionId,
    base_version_no: canonicalBaseVersion?.version_no ?? 0,
    latest_version_id: latestCanonical?.id ?? latestId,
    latest_version_no: latestCanonical?.version_no ?? null,
    stale: Boolean(latestId && latestId !== canonicalBaseVersionId),
    content: String(row.content ?? ""),
    media_type: nullableString(row.media_type),
    label: nullableString(row.label),
    note: nullableString(row.note),
    metadata: parseJsonRecord(row.metadata_json as string | null),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function canonicalDraftArtifactId(db: Db, ref: string): string | null {
  const trimmed = ref.trim();
  if (/^artifact-series:/i.test(trimmed)) return canonicalArtifactIdForSeriesRef(trimmed);
  const logical = getLogicalArtifact(db, trimmed);
  if (logical) return logical.id;
  const version = getCanonicalArtifactVersion(db, trimmed);
  if (version) return version.artifact_id;
  const history = resolveArtifactVersionHistory(db, trimmed);
  return history ? canonicalArtifactIdForSeriesRef(history.series.id) : null;
}

export interface SaveArtifactDraftInput {
  ref?: string;
  series_id?: string;
  base_version_id?: string;
  content: string;
  media_type?: string | null;
  label?: string | null;
  note?: string | null;
  metadata?: JsonRecord;
}

function resolveCanonicalDraftContext(
  db: Db,
  ref: string,
  baseVersionRef?: string,
): { logical: ArtifactIdentityRecord; base: CanonicalArtifactVersionRecord; seriesId: string } {
  const trimmed = ref.trim();
  let logical = getLogicalArtifact(db, trimmed);
  let selected = getCanonicalArtifactVersion(db, trimmed);
  if (!logical && selected) logical = getLogicalArtifact(db, selected.artifact_id);
  if (!logical && /^artifact-series:/i.test(trimmed)) {
    logical = getLogicalArtifact(db, canonicalArtifactIdForSeriesRef(trimmed));
  }
  if (!logical && /^artifact-blob:/i.test(trimmed)) {
    const blob = getArtifactBlob(db, trimmed);
    const rows = blob ? db.prepare(
      "SELECT DISTINCT artifact_id FROM artifact_version WHERE blob_id = ? LIMIT 2",
    ).all(blob.id) as Array<{ artifact_id: string }> : [];
    if (rows.length === 1) logical = getLogicalArtifact(db, rows[0].artifact_id);
  }
  if (!logical) throw new Error(`artifact series not found for ref: ${ref}`);
  const base = baseVersionRef
    ? getCanonicalArtifactVersion(db, baseVersionRef)
    : selected ?? (logical.latest_version_id ? getCanonicalArtifactVersion(db, logical.latest_version_id) : null);
  if (!base || base.artifact_id !== logical.id) {
    throw new Error("artifact draft base version does not belong to the selected artifact");
  }
  return { logical, base, seriesId: legacySeriesIdFromCanonicalArtifact(logical.id) };
}

export function getArtifactDraft(db: Db, ref: string): ArtifactDraftRecord | null {
  if (!artifactDraftTablesExist(db)) return null;
  const canonicalArtifactId = canonicalDraftArtifactId(db, ref);
  if (!canonicalArtifactId) return null;
  const row = db.prepare(
    "SELECT * FROM artifact_drafts WHERE artifact_id = ? LIMIT 1",
  ).get(canonicalArtifactId) as Record<string, unknown> | undefined;
  return row ? draftFromRow(db, row) : null;
}

export function saveArtifactDraft(
  db: Db,
  input: SaveArtifactDraftInput,
  now = Date.now(),
): ArtifactDraftRecord {
  if (!artifactDraftTablesExist(db)) throw new Error("artifact draft tables are not present in this database");
  const ref = input.ref ?? input.series_id;
  if (!ref) throw new Error("ref or series_id is required");
  if (typeof input.content !== "string") throw new Error("draft content must be a string");
  const context = resolveCanonicalDraftContext(db, ref, input.base_version_id);
  const id = artifactDraftId(context.seriesId);
  db.prepare(
    `INSERT INTO artifact_drafts (
      id, artifact_id, version_id, content, media_type, label, note,
      metadata_json, created_at, updated_at
    ) VALUES (
      @id, @artifact_id, @version_id, @content, @media_type, @label, @note,
      @metadata_json, @created_at, @updated_at
    )
    ON CONFLICT(artifact_id) DO UPDATE SET
      version_id = excluded.version_id,
      content = excluded.content,
      media_type = excluded.media_type,
      label = excluded.label,
      note = excluded.note,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
  ).run({
    id,
    artifact_id: context.logical.id,
    version_id: context.base.id,
    content: input.content,
    media_type: input.media_type ?? null,
    label: input.label ?? null,
    note: input.note ?? null,
    metadata_json: jsonStringify(descriptiveArtifactMetadata(input.metadata ?? {})),
    created_at: now,
    updated_at: now,
  });
  return getArtifactDraft(db, context.logical.id) as ArtifactDraftRecord;
}

export function deleteArtifactDraft(db: Db, ref: string): { deleted: boolean } {
  if (!artifactDraftTablesExist(db)) return { deleted: false };
  const canonicalArtifactId = canonicalDraftArtifactId(db, ref);
  if (!canonicalArtifactId) return { deleted: false };
  const result = db.prepare("DELETE FROM artifact_drafts WHERE artifact_id = ?")
    .run(canonicalArtifactId);
  return { deleted: result.changes > 0 };
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split("\n");
}

function simpleLineThreeWayMerge(base: string, ours: string, theirs: string, baseLabel: string, theirsLabel: string): string {
  if (theirs === base || ours === theirs) return ours;
  if (ours === base) return theirs;
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  const max = Math.max(baseLines.length, oursLines.length, theirsLines.length);
  const merged: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const b = baseLines[i] ?? "";
    const o = oursLines[i] ?? "";
    const t = theirsLines[i] ?? "";
    if (o === t) merged.push(o);
    else if (o === b) merged.push(t);
    else if (t === b) merged.push(o);
    else {
      merged.push("<<<<<<< draft", o, `||||||| ${baseLabel}`, b, "=======", t, `>>>>>>> ${theirsLabel}`);
    }
  }
  return merged.join("\n");
}

export function rebaseArtifactDraft(db: Db, ref: string, now = Date.now()): ArtifactDraftRecord {
  const draft = getArtifactDraft(db, ref);
  if (!draft) throw new Error("artifact draft not found");
  if (!draft.stale || !draft.latest_version_id) return draft;
  const baseCanonical = getCanonicalArtifactVersion(db, draft.base_version_id);
  const latestCanonical = getCanonicalArtifactVersion(db, draft.latest_version_id);
  if (!baseCanonical || !latestCanonical) {
    throw new Error("artifact draft base or latest version is missing");
  }
  const readText = (versionId: string): string => {
    const target = artifactMaterializationTarget(resolveArtifactIdentity(db, versionId));
    if (!target.ok) throw new Error(target.error.message);
    const bytes = readArtifactMaterial(db, target.value, 4 * 1024 * 1024);
    if (!bytes.ok) throw new Error(`artifact version bytes unavailable: ${bytes.error.message}`);
    return bytes.value.bytes.toString("utf8");
  };
  const content = simpleLineThreeWayMerge(
    readText(draft.base_version_id),
    draft.content,
    readText(draft.latest_version_id),
    `base v${draft.base_version_no}`,
    `latest v${latestCanonical.version_no}`,
  );
  return saveArtifactDraft(db, {
    ref: baseCanonical.artifact_id,
    base_version_id: draft.latest_version_id,
    content,
    media_type: draft.media_type,
    label: draft.label,
    note: draft.note,
    metadata: mergeJsonRecords(draft.metadata, {
      rebased_from_version_id: draft.base_version_id,
      rebased_at: now,
    }),
  }, now);
}

export interface PublishArtifactDraftInput {
  ref: string;
  label?: string | null;
  note?: string | null;
  allow_stale?: boolean;
}

export function publishArtifactDraft(
  db: Db,
  input: PublishArtifactDraftInput,
  now = Date.now(),
): import("./contracts.js").ArtifactDraftWriteResult {
  const draft = getArtifactDraft(db, input.ref);
  if (!draft) throw new Error("artifact draft not found");
  if (draft.stale && !input.allow_stale) {
    throw new Error("artifact draft is stale; publish with allow_stale to fork from the base version");
  }
  const base = getCanonicalArtifactVersion(db, draft.base_version_id);
  const logical = base ? getLogicalArtifact(db, base.artifact_id) : null;
  const baseBlob = base ? getArtifactBlob(db, base.blob_id) : null;
  if (!base || !logical || !baseBlob) throw new Error("artifact draft canonical base is missing");
  const planned = planArtifactVersion(db, {
    source_kind: 'managed', artifact_id: logical.id, content: draft.content,
    media_type: draft.media_type ?? baseBlob.media_type ?? undefined,
    role: baseBlob.role ?? undefined, logical_name: logical.logical_name ?? undefined,
    label: input.label ?? draft.label ?? undefined, note: input.note ?? draft.note ?? undefined,
    metadata: mergeJsonRecords(draft.metadata, {
      edited_from_version_id: draft.base_version_id, edited_from_version_no: draft.base_version_no,
      stale_base_published: draft.stale,
    }),
  });
  if (!planned.ok) throw new Error(planned.error.message);
  return db.transaction(() => {
    const published = commitArtifactVersion(db, planned.value, now);
    if (!published.ok) throw new Error(published.error.message);
    deleteArtifactDraft(db, logical.id);
    return { draft, result: published.value };
  }).immediate();
}

// Flexible history resolver for read surfaces. Public callers use canonical
// logical artifact refs, artifact-version refs, the `artifact-series:` living
// spelling, or another artifact ref that resolves to an already-registered
// immutable blob owned by exactly one logical artifact.
export function resolveArtifactVersionHistory(db: Db, ref: string): ArtifactVersionHistory | null {
  const canonicalResolution = resolveArtifactIdentityRef(db, ref.trim());
  const canonicalLogical = canonicalResolution?.logical_artifact;
  if (canonicalLogical) return canonicalArtifactVersionHistory(db, canonicalLogical);
  if (canonicalResolution?.artifact_blob) {
    const owners = db.prepare(
      "SELECT DISTINCT artifact_id FROM artifact_version WHERE blob_id = ? LIMIT 2",
    ).all(canonicalResolution.artifact_blob.id) as Array<{ artifact_id: string }>;
    if (owners.length === 1) {
      const owner = getLogicalArtifact(db, owners[0].artifact_id);
      if (owner) return canonicalArtifactVersionHistory(db, owner);
    }
  }
  // Read-only: this GET endpoint must not materialize registry rows. An alias
  // or external ref resolves to a blob, which belongs to a logical artifact
  // only when exactly one owns it.
  const registered = resolveRegisteredArtifactRef(db, ref.trim());
  const blob = registered.artifact_blob
    ?? (resolvedArtifactRecord(registered) ? canonicalBlobForCompatibilityRef(db, resolvedArtifactRecord(registered)!.id) : null);
  if (!blob) return null;
  const owners = db.prepare(
    "SELECT DISTINCT artifact_id FROM artifact_version WHERE blob_id = ? LIMIT 2",
  ).all(blob.id) as Array<{ artifact_id: string }>;
  if (owners.length !== 1) return null;
  const owner = getLogicalArtifact(db, owners[0].artifact_id);
  return owner ? canonicalArtifactVersionHistory(db, owner) : null;
}

function canonicalArtifactVersionHistory(
  db: Db,
  logical: ArtifactIdentityRecord,
): ArtifactVersionHistory {
  const canonicalVersions = listCanonicalArtifactVersions(db, logical.id);
  const seriesId = legacySeriesIdFromCanonicalArtifact(logical.id);
  const versions = canonicalVersions.map((version) => {
    const projected = projectCanonicalVersionRecord(db, version);
    return version.source_kind === "external"
      ? { ...projected, source_kind: "managed" as const }
      : projected;
  });
  const series: ArtifactSeriesRecord = {
    id: seriesId,
    series_key: logical.identity_key,
    source_kind: logical.source_kind === "external" ? "managed" : logical.source_kind,
    title: logical.title,
    repo_id: logical.source_repo_id,
    logical_name: logical.logical_name,
    latest_version_id: logical.latest_version_id,
    version_count: canonicalVersions.length,
    metadata: logical.metadata,
    created_at: logical.created_at,
    updated_at: logical.updated_at,
  };
  const targetIds = [logical.id, ...canonicalVersions.map((version) => version.id)];
  const blobIds = canonicalVersions.map((version) => version.blob_id);
  const links = (db.prepare(
    `SELECT ${ARTIFACT_LINK_COLUMNS}
       FROM artifact_links
      WHERE target_id IN (${[...targetIds, ...blobIds].map(() => "?").join(",")})
      ORDER BY entity_type, entity_id, link_type, role`,
  ).all(...targetIds, ...blobIds) as Array<Record<string, unknown>>)
    .map((row) => artifactLinkFromRow(db, row));
  return { series, versions, links };
}

// Non-mutating ref resolution for read-only surfaces (history/diff GETs). Unlike
// resolveArtifactRef, this NEVER materializes artifact rows, aliases, or graph
// entities: it resolves version/series refs and looks up already-registered
// artifacts/aliases only. Returns null for an unregistered ref.
export function resolveArtifactRefReadonly(db: Db, ref: string): ArtifactRecord | null {
  return resolvedArtifactRecord(resolveArtifactIdentity(db, ref, "strict-read"));
}

/**
 * Strict read: resolve an already-registered identity, never materialize one.
 *
 * `resolveArtifactIdentityRef` covers every current artifact ref spelling. What
 * remains here is the alias namespace — external `repo://`, `https://`,
 * `git-bug://` and similar refs registered against a blob.
 */
function resolveRegisteredArtifactRef(db: Db, ref: string): ArtifactIdentityResolution {
  const trimmed = ref.trim();
  const identityResolution = resolveArtifactIdentityRef(db, trimmed);
  if (identityResolution) return identityResolution;
  const normalized = normalizeRef(trimmed, { db, validateRepo: true });
  const base = {
    ...makeResolutionBase(ref),
    scheme: normalized.scheme,
    normalized_ref: normalized.normalizedRef,
  };
  if (normalized.invalidReason) {
    return artifactIdentityFromRecords({ ...base, status: "unsupported", target_id: null, warnings: [normalized.invalidReason] });
  }
  if (tableExists(db, "artifact_aliases")) {
    const alias = getArtifactAlias(db, normalized.scheme, normalized.normalizedRef);
    if (alias) {
      if (alias.resolution_status === "ambiguous") return artifactIdentityFromRecords({
        ...base, alias, status: "ambiguous", warnings: ["artifact_alias_ambiguous"] });
      const blob = alias.blob_id ? getArtifactBlob(db, alias.blob_id) : null;
      return artifactIdentityFromRecords({
        ...base,
        status: blob ? "resolved" : "unresolved",
        normalized_ref: alias.normalized_ref,

        alias,
        target_type: blob ? "artifact_blob" : undefined,
        target_id: blob?.id ?? null,
        artifact_blob: blob,
        warnings: [],
      });
    }
  }
  return artifactIdentityFromRecords({ ...base, status: "unresolved", warnings: [] });
}

/**
 * The retired content-hash spellings (`artifact:sha256:<hash>`, `sha256:<hash>`,
 * a bare hash) are not accepted by the strict identity resolver, but the
 * surface and link boundaries still resolve them for existing clients and
 * authored text.
 */
function resolutionForRetiredContentHashRef(db: Db, ref: string): ArtifactIdentityResolution | null {
  const trimmed = ref.trim();
  if (classifyArtifactRef(trimmed).kind !== "legacy-blob") return null;
  const blob = canonicalBlobForCompatibilityRef(db, trimmed);
  if (!blob) return null;
  return artifactIdentityFromRecords({
    ...makeResolutionBase(ref),
    status: "resolved",
    scheme: schemeFromRef(trimmed),
    normalized_ref: blob.id,

    target_type: "artifact_blob",
    target_id: blob.id,
    artifact_blob: blob,
    warnings: [],
  });
}

/** Surface mode: strict read, plus the retired content-hash spellings. */
function resolveArtifactSurfaceRef(db: Db, ref: string): ArtifactIdentityResolution {
  return resolutionForRetiredContentHashRef(db, ref) ?? resolveRegisteredArtifactRef(db, ref);
}

function requestedIdentityKind(ref: string): ArtifactRequestedKind {
  const classified = classifyArtifactRef(ref);
  if (classified.kind === "legacy-blob") return "blob";
  if (classified.kind === "pinned-version") return "pinned-version";
  return classified.kind;
}

export function resolveArtifactIdentity(db: Db, ref: string, mode: ArtifactResolutionMode = "strict-read", _now = Date.now()): ArtifactIdentityResolution {
  return mode === "strict-read" ? resolveRegisteredArtifactRef(db, ref) : resolveArtifactSurfaceRef(db, ref);
}

export function getProviderManifest(db: Db, id: string): ProviderManifestRecord | null {
  const row = db.prepare(
    `SELECT id, provider_id, manifest_type, version, content_hash, blob_id,
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
    `SELECT id, provider_id, manifest_type, version, content_hash, blob_id,
            source, content_json, created_at
       FROM provider_manifests
      WHERE provider_id = ?
      ORDER BY created_at DESC`
  ).all(id) as Array<Record<string, unknown>>).map(manifestFromRow);
  const artifacts = listArtifacts(db, { provider: id, limit: 500 });
  return { provider, manifests, artifacts };
}

function providerFromRow(row: Record<string, unknown>): ProviderRecord {
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    version: nullableString(row.version),
    status: String(row.status),
    transport: String(row.transport),
    endpoint: nullableString(row.endpoint),
    capabilities: parseJsonRecord(row.capabilities_json as string),
    actions: parseJsonArray<GraphAction>(row.actions_json as string),
    source: String(row.source),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_seen_at: nullableNumber(row.last_seen_at),
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
    storage_uri: nullableString(row.storage_uri),
    media_type: nullableString(row.media_type),
    role: nullableString(row.role),
    size_bytes: Number(row.size_bytes ?? 0),
    provider_id: nullableString(row.provider_id),
    manifest_id: nullableString(row.manifest_id),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
  };
}

function artifactIdentityFromRow(db: Db, row: Record<string, unknown>): ArtifactIdentityRecord {
  const current = getArtifactCurrentSource(db, String(row.id));
  const repo = current?.source?.kind === "repo" ? resolveProjectRef(db, current.source.project_id) : null;
  return {
    id: String(row.id),
    identity_key: String(row.identity_key),
    source_kind: asArtifactIdentitySourceKind(row.source_kind),
    title: nullableString(row.title),
    source_project_id: nullableString(row.source_project_id),
    source_repo_id: repo?.ok ? repo.project.project_key : null,
    logical_name: nullableString(row.logical_name),
    source_path: current?.source && current.source.kind !== "managed" ? current.source.path : null,
    latest_version_id: nullableString(row.latest_version_id),
    version_count: Number(row.version_count ?? 0),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function canonicalArtifactVersionFromRow(row: Record<string, unknown>): CanonicalArtifactVersionRecord {
  const custodyMode = nullableString(row.custody_mode);
  return {
    id: String(row.id),
    artifact_id: String(row.artifact_id),
    version_no: Number(row.version_no),
    blob_id: String(row.blob_id),
    source_kind: asCanonicalVersionSourceKind(row.source_kind),
    content_hash: String(row.content_hash),
    source_project_id: nullableString(row.source_project_id),
    repo_path: nullableString(row.repo_path),
    commit_sha: nullableString(row.commit_sha),
    observed_path: nullableString(row.observed_path),
    parent_version_id: nullableString(row.parent_version_id),
    custody_mode: asCustodyMode(custodyMode, "managed"),
    label: nullableString(row.label),
    note: nullableString(row.note),
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
    title: nullableString(row.title),
    description: nullableString(row.description),
    rank: nullableNumber(row.rank),
    status,
    source,
    source_ref_type: nullableString(row.source_ref_type),
    source_ref_id: nullableString(row.source_ref_id),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
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

function compatibilityArtifactIdFromAssociationRow(db: Db, row: Record<string, unknown>): string | null {
  const blobId = nullableString(row.blob_id);
  if (blobId === null) return null;
  const blob = getArtifactBlob(db, blobId);
  return blob ? projectCanonicalArtifactRecord(blob).id : null;
}

function artifactAliasFromRow(_db: Db, row: Record<string, unknown>): ArtifactAliasRecord {
  const status = String(row.resolution_status);
  return {
    id: String(row.id),
    blob_id: nullableString(row.blob_id),
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

function artifactLinkFromRow(db: Db, row: Record<string, unknown>): ArtifactLinkRecord {
  const artifactId = compatibilityArtifactIdFromAssociationRow(db, row);
  if (!artifactId) throw new Error(`artifact link ${String(row.id)} has no canonical blob target`);
  return {
    id: String(row.id),
    artifact_id: artifactId,
    entity_type: String(row.entity_type),
    entity_id: String(row.entity_id),
    link_type: String(row.link_type),
    role: nullableString(row.role),
    repo_id: nullableString(row.repo_id),
    provider_id: nullableString(row.provider_id),
    source: String(row.source),
    metadata: parseJsonRecord(row.metadata_json as string),
    link_kind: row.link_kind === "living" ? "living" : "pinned",
    // A living link's series identity is its canonical target spelled the old
    // way; there is no separate stored fact.
    series_id: row.link_kind === "living" && nullableString(row.target_id)
      ? legacySeriesIdFromCanonicalArtifact(String(row.target_id))
      : null,
    series_ref: nullableString(row.series_ref),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function listArtifactAliases(db: Db, contentHash: string): ArtifactAliasRecord[] {
  const rows = db.prepare(
    `SELECT id, blob_id, scheme, alias, normalized_ref, locator_json,
            resolution_status, source, created_at, updated_at
       FROM artifact_aliases
      WHERE blob_id = ?
      ORDER BY scheme, normalized_ref`
  ).all(artifactBlobIdFromHash(contentHash)) as Array<Record<string, unknown>>;
  return rows.map((row) => artifactAliasFromRow(db, row));
}

const ARTIFACT_LINK_COLUMNS = `id, blob_id, entity_type, entity_id, link_type, role, repo_id,
            provider_id, source, metadata_json, link_kind, series_ref,
            target_type, target_id, created_at, updated_at`;

function listArtifactLinks(db: Db, contentHash: string): ArtifactLinkRecord[] {
  const rows = db.prepare(
    `SELECT ${ARTIFACT_LINK_COLUMNS}
       FROM artifact_links
      WHERE blob_id = ?
      ORDER BY entity_type, entity_id, link_type, role`
  ).all(artifactBlobIdFromHash(contentHash)) as Array<Record<string, unknown>>;
  return rows.map((row) => artifactLinkFromRow(db, row));
}

/** Living links on one logical artifact, addressed by its old series spelling. */
function listArtifactSeriesLinks(db: Db, seriesId: string): ArtifactLinkRecord[] {
  if (!tableExists(db, "artifact_links")) return [];
  const rows = db.prepare(
    `SELECT ${ARTIFACT_LINK_COLUMNS}
       FROM artifact_links
      WHERE link_kind = 'living' AND target_type = 'artifact' AND target_id = ?
      ORDER BY entity_type, entity_id, link_type, role`
  ).all(canonicalArtifactIdForSeriesRef(seriesId)) as Array<Record<string, unknown>>;
  return rows.map((row) => artifactLinkFromRow(db, row));
}

function manifestFromRow(row: Record<string, unknown>): ProviderManifestRecord {
  return {
    id: String(row.id),
    provider_id: String(row.provider_id),
    manifest_type: String(row.manifest_type),
    version: nullableString(row.version),
    content_hash: String(row.content_hash),
    blob_id: nullableString(row.blob_id),
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

export { projectCanonicalArtifactRecord, resolvedArtifactRecord } from "./artifact-identity.js";
