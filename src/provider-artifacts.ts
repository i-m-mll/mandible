import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db.js";
import type {
  ArtifactRecord,
  GraphAction,
  GraphEdge,
  GraphMode,
  GraphNode,
  ProviderManifestRecord,
  ProviderRecord,
} from "./types.js";

const DEFAULT_ARTIFACT_ROOT = path.join(os.homedir(), ".cache", "mandible", "artifacts");

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
  metadata?: JsonRecord;
  pinned?: boolean;
  content?: string;
  content_base64?: string;
  json?: unknown;
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

export function getArtifactRoot(): string {
  return process.env.MANDIBLE_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_ROOT;
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
  const ref = input.artifact_id ?? input.uri;
  if (!ref) return undefined;
  const match = /(?:artifact(?::|:\/\/)sha256[:/]|sha256[:/])([a-f0-9]{64})/i.exec(ref);
  return match?.[1]?.toLowerCase();
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

function entityTypeForParentKind(kind: string): string {
  return MANIFEST_KIND_TYPES[kind] ?? (kind.endsWith("Spec") ? "provider_spec" : "provider_manifest");
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
  now: number;
  source: string;
}): void {
  const nodeId = graphEntityId(args.providerId, "issue", args.issueId);
  upsertGraphEntity(db, {
    id: nodeId,
    entity_type: "issue",
    provider_id: args.providerId,
    external_id: args.issueId,
    title: `Issue ${args.issueId}`,
    status: "referenced",
    summary: { issue_id: args.issueId, reference_source: "provider_provenance" },
    detail: { provider_id: args.providerId, note: "Provider manifest provenance issue reference" },
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
  artifactRoot = getArtifactRoot(),
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
  let uri = input.uri ?? input.artifact_id ?? `artifact://sha256/${hash}`;
  let sizeBytes = input.size_bytes ?? uriSizeBytes(uri) ?? 0;
  if (bytes) {
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, bytes);
    }
    uri = `file://${filePath}`;
    sizeBytes = bytes.byteLength;
  }
  const metadata = {
    ...(input.metadata ?? {}),
    filename: input.filename,
    logical_name: input.logical_name,
    artifact_id: input.artifact_id,
    storage_backend: input.storage_backend,
  };
  db.prepare(
    `INSERT INTO artifacts (
      id, algorithm, content_hash, uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, pinned, created_at
    ) VALUES (
      @id, 'sha256', @content_hash, @uri, @media_type, @role, @size_bytes,
      @provider_id, @manifest_id, @metadata_json, @pinned, @created_at
    )
    ON CONFLICT(algorithm, content_hash) DO UPDATE SET
      media_type = COALESCE(excluded.media_type, artifacts.media_type),
      role = COALESCE(excluded.role, artifacts.role),
      provider_id = COALESCE(excluded.provider_id, artifacts.provider_id),
      manifest_id = COALESCE(excluded.manifest_id, artifacts.manifest_id),
      metadata_json = excluded.metadata_json,
      uri = COALESCE(excluded.uri, artifacts.uri),
      size_bytes = CASE
        WHEN artifacts.size_bytes = 0 THEN excluded.size_bytes
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
    },
    detail: { uri, content_hash: hash, metadata, artifact_id: input.artifact_id ?? null },
    visual: { icon: "artifact", shape: "document" },
    created_at: now,
    updated_at: now,
    observed_at: now,
    source: "artifacts",
  });

  return getArtifact(db, id) as ArtifactRecord;
}

export function ingestProviderManifest(
  db: Db,
  input: ManifestInput,
  now = Date.now(),
  artifactRoot = getArtifactRoot(),
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
      for (const [field, fallbackKind] of SPEC_FIELD_KINDS) {
        const ref = asRecord(manifest[field]);
        if (Object.keys(ref).length === 0) continue;
        upsertNativeReferenceNode(db, {
          providerId: provider.id,
          ref,
          fallbackKind,
          sourceId: nativeSubjectId,
          manifestId,
          edgeType: "run_used_spec",
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
  artifactRoot = getArtifactRoot(),
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
  const row = db.prepare(
    `SELECT id, algorithm, content_hash, uri, media_type, role, size_bytes,
            provider_id, manifest_id, metadata_json, pinned, created_at
       FROM artifacts WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? artifactFromRow(row) : null;
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
            provider_id, manifest_id, metadata_json, pinned, created_at
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
    created_at: Number(row.created_at),
  };
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
