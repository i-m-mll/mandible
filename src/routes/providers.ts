import { broadcast } from "../sse.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import {
  artifactMaterializationTarget
} from "../artifact-identity.js";
import { getDb } from "../db.js";
import {
  createKnowledgeBackref,
  listKnowledgeBackrefs,
} from "../knowledge-backrefs.js";
import { scanRepoArtifacts, type RepoArtifactRoot } from "../repo-artifact-scanner.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { checkArtifactMaterialization, diffArtifacts, getArtifactContentAsync } from "../artifact-content.js";
import { openArtifactExternally } from "../artifact-open.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import {
  addArtifactBundleMembersAsync,
  associateProjectArtifact,
  createArtifactBundleAsync,
  getArtifactBundle,
  getArtifact,
  getProviderCapabilities,
  getProviderDetail,
  getProviderHealth,
  getArtifactDraft,
  ingestArtifactAsync,
  ingestProviderManifest,
  ingestProviderManifestFile,
  deleteArtifactDraft,
  listArtifactBlobs,
  listLogicalArtifacts,
  listArtifactSeries,
  listArtifacts,
  listProjectArtifactAssociations,
  listProviders,
  planLocalArtifactPathAsync,
  projectArtifactPublicValue,
  projectArtifactResolution,
  projectArtifactVersionWriteResult,
  publishArtifactDraft,
  planArtifactVersion,
  planArtifactVersionBatch,
  commitArtifactVersion,
  commitArtifactVersionBatch,
  registerLocalArtifactPathAsync,
  registerProvider,
  resolveAndLinkArtifact,
  resolveArtifactIdentity,
  resolvedArtifactRecord,
  resolveArtifactVersionHistory,
  rebaseArtifactDraft,
  saveArtifactDraft,
  snapshotArtifactBytesAsync,
} from "../provider-artifacts.js";
import { ClientAuthzError, requireIdentity } from "../client-auth/authz.js";
import {
  artifactRequiredProjects, artifactVersionCustody, getArtifactCurrentSource, planArtifactSourceMove, commitArtifactSourceMove,
  type ArtifactSource, type ArtifactLifecycleResult,
} from "../artifact-source.js";
import type { RecordArtifactVersionInput } from "../provider-artifacts.js";
import type { ArtifactVersionSourceKind } from "../types.js";
import { isInlineManagedArtifactByteRequest } from "../security/operation-policy.js";
import { bodyRecord, sendJson } from "./http.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { resolveArtifactProject, resolveArtifactProjects, resolveIssueProject } from "../permissions/resources.js";
import {
  PermissionError,
  requireProjectAccess,
  sendPermissionError,
} from "../permissions/store.js";


function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof PermissionError || error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

function queryString(req: RequestLike, key: string): string | undefined {
  const value = req.query?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryNumber(req: RequestLike, key: string): number | undefined {
  const value = queryString(req, key);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryBoolean(req: RequestLike, key: string): boolean | undefined {
  const value = queryString(req, key);
  if (!value) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function resolveArtifactRouteRecord(id: string) {
  const db = getDb();
  return getArtifact(db, id) ?? resolvedArtifactRecord(resolveArtifactIdentity(db, id, "surface"));
}

function enforceProjectRefWrite(req: RequestLike, res: ResponseLike, projectRef: string): boolean {
  const db = getDb();
  const resolved = resolveProjectRef(db, projectRef);
  if ((!resolved.ok && resolved.reason === "ambiguous")) {
    sendJson(res, 403, { error: "ambiguous project", code: "ambiguous_project" });
    return false;
  }
  if (!resolved.ok) {
    sendJson(res, 404, { error: "project not found", code: "unknown_project" });
    return false;
  }
  try {
    requireProjectAccess(db, req, resolved.project.id, "write");
    return true;
  } catch (error) {
    if (error instanceof PermissionError) {
      sendPermissionError(res, error);
      return false;
    }
    throw error;
  }
}

/**
 * The entries of a list the caller may read: an entry is kept when its
 * artifact has no project, or one project the caller can read. An entry
 * without an artifact is kept.
 */
function readableArtifactEntries<T>(req: RequestLike, entries: T[], artifactId: (entry: T) => string | null): T[] {
  const db = getDb();
  const projects = resolveArtifactProjects(db, entries.flatMap((entry) => artifactId(entry) ?? []));
  const readable = new Map<string, boolean>();
  return entries.filter((entry) => {
    const id = artifactId(entry);
    if (id === null) return true;
    const project = projects.get(id)!;
    if (!project.ok) return project.reason === "unassociated";
    let allowed = readable.get(project.project_id);
    if (allowed === undefined) {
      try {
        requireProjectAccess(db, req, project.project_id, "read");
        allowed = true;
      } catch {
        allowed = false;
      }
      readable.set(project.project_id, allowed);
    }
    return allowed;
  });
}

function enforceArtifactAccess(
  req: RequestLike,
  res: ResponseLike,
  artifactId: string,
  role: "read" | "write",
): boolean {
  const db = getDb();
  const resolved = resolveArtifactProject(db, artifactId);
  // A successfully resolved artifact without a project is deliberately unscoped.
  if (!resolved.ok && resolved.reason === "unassociated") return true;
  if (!resolved.ok) {
    sendJson(res, 403, { error: "ambiguous artifact project", code: "ambiguous_project" });
    return false;
  }
  try {
    requireProjectAccess(db, req, resolved.project_id, role);
    return true;
  } catch (error) {
    if (error instanceof PermissionError) {
      sendPermissionError(res, error);
      return false;
    }
    throw error;
  }
}

/**
 * The project-bearing resource behind an artifact ref is the logical artifact
 * whenever the ref resolves to one, and only otherwise the version.
 *
 * `resolveArtifactProject` reaches a version's project through the version id
 * and the parent artifact it joins, but it reaches artifact-level
 * `project_artifact_associations` rows only through the logical artifact id.
 * Gating a logical or series ref on its selected version would therefore miss
 * exactly those associations and allow the request.
 *
 * Blob refs are gated on the canonical blob identity. Historical authored
 * spelling is input provenance and cannot select another access identity.
 */
function enforceArtifactRefAccess(
  req: RequestLike,
  res: ResponseLike,
  ref: string,
  role: "read" | "write",
): boolean {
  try {
    const resolved = resolveArtifactIdentity(getDb(), ref, "surface");
    const id = resolved.logical_artifact?.id
      ?? resolved.artifact_version?.id
      ?? resolved.artifact_blob?.id
      ?? null;
    if (!id && resolved.status === "ambiguous") {
      sendJson(res, 403, { error: "ambiguous artifact project", code: "ambiguous_project" });
      return false;
    }
    return id ? enforceArtifactAccess(req, res, id, role) : true;
  } catch {
    sendJson(res, 500, { error: "Artifact access check failed", code: "artifact_access_check_failed" });
    return false;
  }
}

function lifecycleValue<T>(res: ResponseLike, result: ArtifactLifecycleResult<T>): T | undefined {
  if (result.ok) return result.value;
  const status = result.error.code === "unknown_artifact" ? 404
    : result.error.code === "storage_error" ? 500
      : ["invalid_source", "invalid_input"].includes(result.error.code) ? 400 : 409;
  sendJson(res, status, { error: result.error.message, code: result.error.code });
  return undefined;
}

function canonicalArtifactId(res: ResponseLike, ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.trim() || ref.startsWith("artifact-series:") || ref.startsWith("artifact-version:")) {
    sendJson(res, 400, { error: "canonical artifact identity is required", code: "invalid_input" });
    return;
  }
  const resolved = resolveArtifactIdentity(getDb(), ref, "surface");
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact" || !resolved.logical_artifact) {
    sendJson(res, 404, { error: "ref must name one logical artifact", code: "unknown_artifact" });
    return;
  }
  return resolved.logical_artifact.id;
}

function authorizeArtifactPlan(req: RequestLike, res: ResponseLike,
  plan: { artifact_id: string | null; required_project_ids: string[] }): boolean {
  if (plan.artifact_id && !enforceArtifactAccess(req, res, plan.artifact_id, "write")) return false;
  for (const projectId of plan.required_project_ids) requireProjectAccess(getDb(), req, projectId, "write");
  return true;
}

function recordAuthorizedVersion(req: RequestLike, res: ResponseLike, input: RecordArtifactVersionInput) {
  if (input.artifact_id !== undefined) {
    const id = canonicalArtifactId(res, input.artifact_id);
    if (!id) return;
    input = { ...input, artifact_id: id };
  }
  if (input.source !== undefined) {
    const source = sourceInput(input.source);
    if (!source) { sendJson(res, 400, { error: "invalid source", code: "invalid_source" }); return; }
    if (source.kind === "repo") {
      const project = resolveProjectRef(getDb(), source.project_id);
      if (!project.ok) {
        sendJson(res, 400, { error: "source project is unknown or ambiguous", code: "invalid_source" }); return;
      }
      source.project_id = project.project.id;
    }
    input = { ...input, source };
  }
  const plan = lifecycleValue(res, planArtifactVersion(getDb(), input));
  if (!plan || !authorizeArtifactPlan(req, res, plan)) return;
  const result = lifecycleValue(res, commitArtifactVersion(getDb(), plan));
  return result ? projectArtifactVersionWriteResult(getDb(), result) : undefined;
}

function sourceInput(value: unknown): ArtifactSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.kind === "repo" && typeof source.project_id === "string" && typeof source.path === "string") {
    return { kind: "repo", project_id: source.project_id, path: source.path };
  }
  if (source.kind === "local" && typeof source.path === "string") return { kind: "local", path: source.path };
  if (source.kind === "managed" && typeof source.key === "string") return { kind: "managed", key: source.key };
  return null;
}

function enforceBodyArtifactRefs(
  req: RequestLike,
  res: ResponseLike,
  body: Record<string, unknown>,
  role: "read" | "write",
): boolean {
  const keys = [
    "ref", "artifact", "artifact_ref", "artifact_id", "source_ref",
    "series", "series_id", "version", "version_id", "base_version_id",
  ];
  const refs = new Set(keys
    .map((key) => body[key])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim())));
  return [...refs].every((ref) => enforceArtifactRefAccess(req, res, ref, role));
}

function enforceArtifactMembers(
  req: RequestLike,
  res: ResponseLike,
  value: unknown,
  role: "read" | "write",
): boolean {
  if (!Array.isArray(value)) return true;
  return value.every((member) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) return true;
    return enforceBodyArtifactRefs(req, res, member as Record<string, unknown>, role);
  });
}

function enforceIssueRefWrite(req: RequestLike, res: ResponseLike, issueRef: string): boolean {
  const db = getDb();
  const resolved = resolveIssueProject(db, issueRef);
  if (!resolved.ok) {
    if (resolved.reason === "not_found") return true;
    sendJson(res, 403, { error: "ambiguous issue project", code: "ambiguous_project" });
    return false;
  }
  try {
    requireProjectAccess(db, req, resolved.project_id, "write");
    return true;
  } catch (error) {
    if (error instanceof PermissionError) {
      sendPermissionError(res, error);
      return false;
    }
    throw error;
  }
}

function bodyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function bodyRepoRoots(value: unknown): Array<string | RepoArtifactRoot> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string | RepoArtifactRoot => {
    if (typeof item === "string") return Boolean(item.trim());
    return Boolean(item && typeof item === "object" && typeof (item as RepoArtifactRoot).root === "string");
  });
}

function bodyBoolean(body: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function linkedEntityQuery(req: RequestLike): { type?: string; id?: string } {
  const type = queryString(req, "entity_type") ?? queryString(req, "linked_entity_type");
  const id = queryString(req, "entity_id") ?? queryString(req, "linked_entity_id");
  const combined = queryString(req, "linked_entity");
  if (!combined || type || id) return { type, id };
  const colon = combined.indexOf(":");
  if (colon > 0 && colon < combined.length - 1) {
    return { type: combined.slice(0, colon), id: combined.slice(colon + 1) };
  }
  return { id: combined };
}

export function registerProviderRoutes(app: RouteRegistrar): void {
  app.get("/api/providers", (_req, res) => {
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { providers: listProviders(getDb()) }));
  }, { operation: { id: "get:/api/providers", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.get("/api/providers/:id/capabilities", (req, res) => {
    const capabilities = getProviderCapabilities(getDb(), req.params.id);
    if (!capabilities) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), capabilities));
  }, { operation: { id: "get:/api/providers/:id/capabilities", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.get("/api/providers/:id/health", (req, res) => {
    const health = getProviderHealth(getDb(), req.params.id);
    if (!health) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), health));
  }, { operation: { id: "get:/api/providers/:id/health", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.get("/api/providers/:id", (req, res) => {
    const detail = getProviderDetail(getDb(), req.params.id);
    if (!detail) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), detail));
  }, { operation: { id: "get:/api/providers/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.post("/api/providers/register", (req, res) => {
    try {
      const provider = registerProvider(getDb(), bodyRecord(req));
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { provider }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/providers/register", effects: ["ledger:write"], requestSchema: null, reportingCategory: "providers" }, fileRpc: "deny" });

  app.post("/api/providers/register-manifest", (req, res) => {
    try {
      const body = bodyRecord(req);
      if (typeof body.path === "string" && body.path.trim()) {
        const manifest = ingestProviderManifestFile(getDb(), body.path);
        sendJson(res, 200, projectArtifactPublicValue(getDb(), { manifest }));
        return;
      }
      const manifest = ingestProviderManifest(getDb(), body);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { manifest }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/providers/register-manifest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "providers" }, fileRpc: "deny" });

  app.post("/api/artifacts/ingest", async (req, res) => {
    try {
      const body = bodyRecord(req);
      if (body.paths !== undefined || body.commit !== undefined) {
        if (body.blob_only || body.identity_mode === 'blob_only' || body.content_path || body.content_base64) {
          sendJson(res, 400, { error: 'Batch/commit ingestion requires daemon-visible paths and logical versions', code: 'invalid_input' }); return;
        }
        const paths = body.paths ?? [body.path];
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > 256 || paths.some(p => typeof p !== 'string' || !p.trim())
          || (body.commit !== undefined && (typeof body.commit !== 'string' || !body.commit.trim()))
          || (body.project !== undefined && (typeof body.project !== 'string' || !body.project.trim()))
          || (body.artifact_id && paths.length !== 1)) {
          sendJson(res, 400, { error: 'Supply 1–256 paths, an optional commit/project, and at most one path with artifact_id', code: 'invalid_input' }); return;
        }
        const artifactId = body.artifact_id === undefined ? undefined : canonicalArtifactId(res, body.artifact_id);
        if (body.artifact_id !== undefined && !artifactId) return;
        if (typeof body.issue === 'string' && !enforceIssueRefWrite(req, res, body.issue)) return;
        const inputs: RecordArtifactVersionInput[] = [];
        for (const path of paths as string[]) {
          const local = body.commit ? null : await planLocalArtifactPathAsync(getDb(), { ...body, path });
          inputs.push({ ...body, artifact_id: artifactId, path,
            source_kind: body.commit || local?.git_state.tracked && local?.git_state.repo_id ? 'tracked_repo' : 'local_only' });
        }
        const batch = getDb().transaction(() => {
          const plans = lifecycleValue(res, planArtifactVersionBatch(getDb(), inputs));
          if (!plans || !plans.every(plan => authorizeArtifactPlan(req, res, plan))) return;
          if (body.dry_run === true) { sendJson(res, 200, { command: 'ingest', dry_run: true, plans, registered: [], failed: [] }); return; }
          const committed = lifecycleValue(res, commitArtifactVersionBatch(getDb(), plans));
          if (!committed) return;
          const registered = committed.map((result, index) => ({ ...projectArtifactVersionWriteResult(getDb(), result),
            status: !result.created ? 'unchanged' : plans[index].artifact_id ? 'updated' : 'created' }));
          return projectArtifactPublicValue(getDb(), { command: 'ingest', registered, failed: [], atomic: true });
        }).immediate();
        if (batch) sendJson(res, 200, batch);
        return;
      }
      const projectRef = [body.source_project_id, body.project_id, body.project]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (projectRef && !enforceProjectRefWrite(req, res, projectRef)) return;
      const localPath = typeof body.path === "string" && body.path.trim()
        ? body.path
        : typeof body.local_path === "string" && body.local_path.trim()
          ? body.local_path
          : undefined;
      if (localPath) {
        const local = await planLocalArtifactPathAsync(getDb(), { ...body, path: localPath });
        const source_kind = local.git_state.tracked && local.git_state.repo_id ? "tracked_repo" : "local_only";
        if (body.blob_only === true || body.identity_mode === "blob_only") {
          if (body.artifact_id || body.series_key) {
            sendJson(res, 400, { error: "blob-only ingest cannot target a logical artifact", code: "invalid_input" }); return;
          }
          const plan = lifecycleValue(res, planArtifactVersion(getDb(), { source_kind, path: localPath }));
          if (!plan || !authorizeArtifactPlan(req, res, plan)) return;
          const result = await registerLocalArtifactPathAsync(getDb(), { ...body, path: localPath });
          sendJson(res, 200, projectArtifactPublicValue(getDb(), { ...result, blob_only: true }));
          return;
        }
        const result = recordAuthorizedVersion(req, res, { ...body, source_kind, path: localPath });
        if (result) sendJson(res, 200, projectArtifactPublicValue(getDb(), { ...result,
          git_state: local.git_state, recoverability: local.recoverability, warnings: local.warnings }));
        return;
      }
      // Blob-only ingress cannot select or update a logical identity.
      if (body.artifact_id || body.series_key) {
        sendJson(res, 400, { error: "logical updates require /api/artifacts/versions", code: "invalid_input" });
        return;
      }
      if (!enforceBodyArtifactRefs(req, res, body, "write")) return;
      const metadata = body.metadata as { git?: { repo_id?: string } } | undefined;
      const repoRef = typeof body.repo_id === "string" ? body.repo_id : metadata?.git?.repo_id;
      if (repoRef && !enforceProjectRefWrite(req, res, repoRef)) return;
      const artifact = await ingestArtifactAsync(getDb(), isInlineManagedArtifactByteRequest("ingest", body)
        ? { ...body, custody_mode: "managed" }
        : body);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { artifact }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/ingest", effects: ({ instanceRole, body }) => instanceRole === "preview" && isInlineManagedArtifactByteRequest("ingest", body) ? ["ledger:write", "files:preview"] : ["files:production"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/plan", async (req, res) => {
    try {
      const body = bodyRecord(req);
      const localPath = typeof body.path === "string" && body.path.trim()
        ? body.path
        : typeof body.local_path === "string" && body.local_path.trim()
          ? body.local_path
          : undefined;
      if (!localPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const plan = await planLocalArtifactPathAsync(getDb(), { ...body, path: localPath });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { plan }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/plan", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/scan-repos", (req, res) => {
    try {
      const body = bodyRecord(req);
      const result = scanRepoArtifacts(getDb(), {
        roots: bodyRepoRoots(body.roots) ?? bodyRepoRoots(body.repo_roots),
        repoIds: bodyStringArray(body.repo_ids),
        maxDepth: typeof body.max_depth === "number" ? body.max_depth : undefined,
        maxFileBytes: typeof body.max_file_bytes === "number" ? body.max_file_bytes : undefined,
        register: bodyBoolean(body, "register"),
        discoveryOnly: bodyBoolean(body, "discovery_only"),
        dryRun: bodyBoolean(body, "dry_run", "dryRun"),
      });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), result));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/scan-repos", effects: ["files:production"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.get("/api/artifacts", (req, res) => {
    const linked = linkedEntityQuery(req);
    const linkedTargetType = queryString(req, "linked_target_type");
    const artifacts = listArtifacts(getDb(), {
      q: queryString(req, "q"),
      hashPrefix: queryString(req, "hash") ?? queryString(req, "hash_prefix"),
      repo: queryString(req, "repo"),
      provider: queryString(req, "provider"),
      role: queryString(req, "role"),
      custody: queryString(req, "custody"),
      availability: queryString(req, "availability"),
      scheme: queryString(req, "scheme"),
      location: queryString(req, "location"),
      linkedEntityType: linked.type,
      linkedEntityId: linked.id,
      linkedTargetType: linkedTargetType === "artifact"
        || linkedTargetType === "artifact_version"
        || linkedTargetType === "artifact_blob"
        ? linkedTargetType
        : undefined,
      linkedTargetId: queryString(req, "linked_target_id"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
      summary: queryBoolean(req, "summary"),
    });
    const readable = readableArtifactEntries(req, artifacts, (artifact) => artifact.id);
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { artifacts: readable }));
  }, { operation: { id: "get:/api/artifacts", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/resolve", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "uri");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "read")) return;
      sendJson(res, 200, projectArtifactPublicValue(getDb(), {
        resolution: projectArtifactResolution(getDb(), resolveArtifactIdentity(getDb(), ref, "surface")),
      }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/artifacts/resolve", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/logical", (req, res) => {
    const artifacts = listLogicalArtifacts(getDb(), {
      q: queryString(req, "q"),
      sourceProjectId: queryString(req, "source_project_id"),
      sourceRepoId: queryString(req, "source_repo_id") ?? queryString(req, "repo"),
      sourceKind: queryString(req, "source_kind"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    const readable = readableArtifactEntries(req, artifacts, (artifact) => artifact.id);
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { artifacts: readable }));
  }, { operation: { id: "get:/api/artifacts/logical", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/blobs", (req, res) => {
    const blobs = listArtifactBlobs(getDb(), {
      q: queryString(req, "q"),
      hashPrefix: queryString(req, "hash") ?? queryString(req, "hash_prefix"),
      custody: queryString(req, "custody"),
      availability: queryString(req, "availability"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { blobs }));
  }, { operation: { id: "get:/api/artifacts/blobs", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/associations", (req, res) => {
    const targetType = queryString(req, "target_type");
    const associationKind = queryString(req, "association_kind");
    const status = queryString(req, "status");
    const associations = listProjectArtifactAssociations(getDb(), {
      projectRef: queryString(req, "project") ?? queryString(req, "project_ref"),
      targetType: targetType === "artifact" || targetType === "artifact_version" ? targetType : undefined,
      targetId: queryString(req, "target_id"),
      associationKind: associationKind === "associated" || associationKind === "canonical" ? associationKind : undefined,
      status: status === "active" || status === "superseded" || status === "archived" ? status : undefined,
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    }).filter((association) => {
      try {
        requireProjectAccess(getDb(), req, association.project_id, "read");
        return true;
      } catch {
        return false;
      }
    });
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { associations }));
  }, { operation: { id: "get:/api/artifacts/associations", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/artifacts/associations", (req, res) => {
    try {
      const body = bodyRecord(req);
      const projectRef = [body.project_ref, body.project, body.project_id]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (projectRef && !enforceProjectRefWrite(req, res, projectRef)) return;
      const result = associateProjectArtifact(
        getDb(),
        body as unknown as Parameters<typeof associateProjectArtifact>[1],
      );
      sendJson(res, 200, projectArtifactPublicValue(getDb(), result));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/associations", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.get("/api/artifacts/series", (req, res) => {
    const linked = linkedEntityQuery(req);
    const series = listArtifactSeries(getDb(), {
      q: queryString(req, "q"),
      hashPrefix: queryString(req, "hash") ?? queryString(req, "hash_prefix"),
      repo: queryString(req, "repo"),
      provider: queryString(req, "provider"),
      role: queryString(req, "role"),
      custody: queryString(req, "custody"),
      availability: queryString(req, "availability"),
      scheme: queryString(req, "scheme"),
      location: queryString(req, "location"),
      linkedEntityType: linked.type,
      linkedEntityId: linked.id,
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    const readable = readableArtifactEntries(req, series, (entry) => entry.latest_artifact?.id ?? null);
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { series: readable }));
  }, { operation: { id: "get:/api/artifacts/series", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.post("/api/artifacts/link", (req, res) => {
    try {
      const body = bodyRecord(req);
      if (!enforceBodyArtifactRefs(req, res, body, "write")) return;
      const issueRef = typeof body.issue === "string"
        ? body.issue
        : body.entity_type === "issue" && typeof body.entity_id === "string"
          ? body.entity_id
          : null;
      if (issueRef && !enforceIssueRefWrite(req, res, issueRef)) return;
      // Evidence links on issues must pin a concrete artifact version. Reject a
      // living evidence link at the route boundary (issue 10960ea) so the
      // contract is enforced at the HTTP edge, not only later in the CLI; the
      // backend (resolveAndLinkArtifact) enforces the same rule as defense in
      // depth for every other caller.
      const linkKind = typeof body.link_kind === "string" ? body.link_kind.trim() : undefined;
      const linkType = typeof body.link_type === "string" && body.link_type.trim()
        ? body.link_type.trim()
        : "references";
      const entityType = typeof body.entity_type === "string" && body.entity_type.trim()
        ? body.entity_type.trim()
        : (typeof body.issue === "string" && body.issue.trim() ? "issue" : undefined);
      if (linkKind === "living" && entityType === "issue" && linkType === "evidence") {
        sendJson(res, 400, { error: "evidence_links_must_be_pinned" });
        return;
      }
      const result = resolveAndLinkArtifact(getDb(), body);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { ...result, resolution: projectArtifactResolution(getDb(), result.resolution) }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/link", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/check", async (req, res) => {
    try {
      const body = bodyRecord(req);
      const refs = bodyStringArray(body.refs)
        ?? bodyStringArray(body.artifact_refs)
        ?? (typeof body.ref === "string" && body.ref.trim() ? [body.ref] : undefined);
      if (!refs?.length) {
        sendJson(res, 400, { error: "ref or refs is required" });
        return;
      }
      for (const ref of refs) {
        if (!enforceArtifactRefAccess(req, res, ref, "read")) return;
      }
      const checks = [];
      for (const ref of refs) {
        const resolution = resolveArtifactIdentity(getDb(), ref, "strict-read");
        const target = artifactMaterializationTarget(resolution);
        const check = await checkArtifactMaterialization(getDb(), target.ok ? target.value : ref, { ref });
        checks.push({ ref, resolution: projectArtifactResolution(getDb(), resolution), check });
      }
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { checks }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/check", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/snapshot", async (req, res) => {
    try {
      const body = bodyRecord(req);
      if (!enforceBodyArtifactRefs(req, res, body, "write")) return;
      const artifact = await snapshotArtifactBytesAsync(getDb(), isInlineManagedArtifactByteRequest("snapshot", body)
        ? { ...body, custody_mode: "managed" }
        : body);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { artifact }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/snapshot", effects: ({ instanceRole, body }) => instanceRole === "preview" && isInlineManagedArtifactByteRequest("snapshot", body) ? ["ledger:write", "files:preview"] : ["files:production"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  // Read-only version history for a logical artifact series. `ref` may be a
  // series id, series_key, version id, or any artifact ref (resolves to the
  // most recent series pinning that immutable artifact).
  app.get("/api/artifacts/versions", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "series");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "read")) return;
      const history = resolveArtifactVersionHistory(getDb(), ref);
      if (!history) {
        sendJson(res, 404, { error: "no artifact version series found for ref" });
        return;
      }
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { history }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/artifacts/versions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Read-only text/JSON/Markdown diff derived from two artifacts' full snapshot
  // bytes. Accepts any resolvable refs (hash, version, or series selectors).
  app.get("/api/artifacts/diff", async (req, res) => {
    try {
      const refA = queryString(req, "a") ?? queryString(req, "from");
      const refB = queryString(req, "b") ?? queryString(req, "to");
      if (!refA || !refB) {
        sendJson(res, 400, { error: "a and b query parameters required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, refA, "read")) return;
      if (!enforceArtifactRefAccess(req, res, refB, "read")) return;
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { diff: await diffArtifacts(getDb(), refA, refB) }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/artifacts/diff", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/drafts", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "series");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "read")) return;
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { draft: getArtifactDraft(getDb(), ref) }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/artifacts/drafts", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/artifacts/drafts", (req, res) => {
    try {
      const body = bodyRecord(req);
      if (!enforceBodyArtifactRefs(req, res, body, "write")) return;
      const content = typeof body.content === "string" ? body.content : undefined;
      if (content === undefined) {
        sendJson(res, 400, { error: "content is required" });
        return;
      }
      const draft = saveArtifactDraft(getDb(), {
        ref: typeof body.ref === "string" ? body.ref : undefined,
        series_id: typeof body.series_id === "string" ? body.series_id : undefined,
        base_version_id: typeof body.base_version_id === "string" ? body.base_version_id : undefined,
        content,
        media_type: typeof body.media_type === "string" ? body.media_type : null,
        label: typeof body.label === "string" ? body.label : null,
        note: typeof body.note === "string" ? body.note : null,
        metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown>
          : undefined,
      });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { draft }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/drafts", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/drafts/rebase", (req, res) => {
    try {
      const body = bodyRecord(req);
      const ref = typeof body.ref === "string" ? body.ref : undefined;
      if (!ref) {
        sendJson(res, 400, { error: "ref is required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "write")) return;
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { draft: rebaseArtifactDraft(getDb(), ref) }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/drafts/rebase", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write","files:preview"] : ["files:production"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/drafts/publish", (req, res) => {
    try {
      const body = bodyRecord(req);
      const ref = typeof body.ref === "string" ? body.ref : undefined;
      if (!ref) {
        sendJson(res, 400, { error: "ref is required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "write")) return;
      const resolved = resolveArtifactIdentity(getDb(), ref, "surface");
      if (!resolved.logical_artifact) {
        sendJson(res, 404, { error: "draft artifact not found", code: "unknown_artifact" }); return;
      }
      const current = getArtifactCurrentSource(getDb(), resolved.logical_artifact.id);
      for (const projectId of artifactRequiredProjects(getDb(), resolved.logical_artifact.id, current?.source ?? null)) {
        requireProjectAccess(getDb(), req, projectId, "write");
      }
      const published = publishArtifactDraft(getDb(), {
        ref,
        label: typeof body.label === "string" ? body.label : null,
        note: typeof body.note === "string" ? body.note : null,
        allow_stale: body.allow_stale === true,
      });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { draft: published.draft, result: projectArtifactVersionWriteResult(getDb(), published.result) }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/drafts/publish", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write","files:preview"] : ["files:production"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.delete("/api/artifacts/drafts", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "series");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      if (!enforceArtifactRefAccess(req, res, ref, "write")) return;
      sendJson(res, 200, projectArtifactPublicValue(getDb(), deleteArtifactDraft(getDb(), ref)));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/artifacts/drafts", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/versions", (req, res) => {
    try {
      const body = bodyRecord(req);
      if (!enforceBodyArtifactRefs(req, res, body, "write")) return;
      const projectRef = [body.source_project_id, body.project_id, body.project]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (projectRef && !enforceProjectRefWrite(req, res, projectRef)) return;
      const sourceKind = typeof body.source_kind === "string" ? body.source_kind : undefined;
      if (!sourceKind) {
        sendJson(res, 400, { error: "source_kind is required (tracked_repo, local_only, or managed)" });
        return;
      }
      const input: RecordArtifactVersionInput = { ...body, source_kind: sourceKind as ArtifactVersionSourceKind };
      const result = recordAuthorizedVersion(req, res, input);
      if (result) sendJson(res, 200, projectArtifactPublicValue(getDb(), { result }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/versions", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.get("/api/artifacts/source", (req, res) => {
    try {
      const id = canonicalArtifactId(res, queryString(req, "ref"));
      if (!id || !enforceArtifactAccess(req, res, id, "read")) return;
      const source = getArtifactCurrentSource(getDb(), id);
      if (!source) { sendJson(res, 404, { error: "source state not found", code: "unknown_artifact" }); return; }
      sendJson(res, 200, { source, version_custody: artifactVersionCustody(getDb(), id) });
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "get:/api/artifacts/source", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/artifacts/source/move", (req, res) => {
    try {
      getDb().transaction(() => {
        const actor = requireIdentity(req).user_id;
        const body = bodyRecord(req);
        const id = canonicalArtifactId(res, body.artifact_id);
        if (!id || !enforceArtifactAccess(req, res, id, "write")) return;
        const current = getArtifactCurrentSource(getDb(), id);
        if (!current) { sendJson(res, 404, { error: 'source state not found', code: 'unknown_artifact' }); return; }
        let source = sourceInput(body.source);
        const advanced = body.source !== undefined;
        if (advanced && (body.project !== undefined || body.path !== undefined)) {
          sendJson(res, 400, { error: 'Use source or project/path, not both', code: 'invalid_input' }); return;
        }
        if (!advanced) {
          if (body.project === undefined && body.path === undefined) {
            sendJson(res, 400, { error: 'Request a project or path change', code: 'invalid_input' }); return;
          }
          if ((body.path !== undefined && (typeof body.path !== 'string' || !body.path.trim()))
            || (body.project !== undefined && (typeof body.project !== 'string' || !body.project.trim()))) {
            sendJson(res, 400, { error: 'project and path must be nonempty strings', code: 'invalid_input' }); return;
          }
          if (body.project !== undefined) {
            const project = resolveProjectRef(getDb(), body.project as string);
            if (!project.ok) {
              sendJson(res, 400, { error: 'Project is unknown or ambiguous', code: 'invalid_source' }); return;
            }
            const path = body.path ?? (current.source?.kind === 'repo' ? current.source.path : undefined);
            if (typeof path === 'string') source = { kind: 'repo', project_id: project.project.id, path };
          } else if (current.source?.kind === 'repo' || current.source?.kind === 'local') {
            source = { ...current.source, path: body.path as string };
          }
        }
        const revision = body.expected_revision === undefined ? (advanced ? undefined : current.revision) : body.expected_revision;
        if (!source || !Number.isSafeInteger(revision) || Number(revision) < 0) {
          sendJson(res, 400, { error: 'A valid source and optional nonnegative revision are required; unresolved sources need project and path or advanced source JSON', code: 'invalid_input' }); return;
        }
        const plan = lifecycleValue(res, planArtifactSourceMove(getDb(), {
          artifact_id: id, expected_revision: Number(revision), source, actor, reconcile: body.reconcile === true,
        }));
        if (!plan || !authorizeArtifactPlan(req, res, plan)) return;
        const state = lifecycleValue(res, commitArtifactSourceMove(getDb(), plan));
        if (state) sendJson(res, 200, { source: state, version_custody: artifactVersionCustody(getDb(), id), status: state.revision === current.revision ? 'unchanged' : 'updated' });
      }).immediate();
    } catch (error) { handleError(res, error); }
  }, { operation: { id: "post:/api/artifacts/source/move", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/bundles", async (req, res) => {
    try {
      const body = bodyRecord(req);
      if (!enforceArtifactMembers(req, res, body.members, "write")) return;
      if (typeof body.issue === "string" && !enforceIssueRefWrite(req, res, body.issue)) return;
      const result = await createArtifactBundleAsync(getDb(), body as unknown as Parameters<typeof createArtifactBundleAsync>[1]);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), result));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/bundles", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.post("/api/artifacts/bundles/:id/members", async (req, res) => {
    try {
      const body = bodyRecord(req);
      const members = Array.isArray(body.members) ? body.members : [];
      if (!enforceArtifactRefAccess(req, res, req.params.id, "write")) return;
      if (!enforceArtifactMembers(req, res, members, "write")) return;
      const result = await addArtifactBundleMembersAsync(getDb(), req.params.id, members as Parameters<typeof addArtifactBundleMembersAsync>[2]);
      sendJson(res, 200, projectArtifactPublicValue(getDb(), result));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/bundles/:id/members", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.get("/api/artifacts/bundles/:id", (req, res) => {
    if (!enforceArtifactRefAccess(req, res, req.params.id, "read")) return;
    const bundle = getArtifactBundle(getDb(), req.params.id);
    if (!bundle) {
      sendJson(res, 404, { error: "bundle not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), bundle));
  }, { operation: { id: "get:/api/artifacts/bundles/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/knowledge-backrefs", (req, res) => {
    const backrefs = listKnowledgeBackrefs(getDb(), {
      sourceType: queryString(req, "source_type"),
      sourceId: queryString(req, "source_id"),
      providerId: queryString(req, "provider") ?? queryString(req, "provider_id"),
      refType: queryString(req, "ref_type"),
      externalRef: queryString(req, "external_ref"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { backrefs }));
  }, { operation: { id: "get:/api/knowledge-backrefs", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/knowledge-backrefs", (req, res) => {
    try {
      const backref = createKnowledgeBackref(getDb(), bodyRecord(req));
      if (backref.source_type === "artifact") broadcast(DOMAIN_EVENTS.ARTIFACT_CHANGED, { artifact_id: backref.source_id });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { backref }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/knowledge-backrefs", effects: ["ledger:write"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "allow" });

  app.get("/api/artifacts/:id/content", async (req, res) => {
    if (!enforceArtifactRefAccess(req, res, req.params.id, "read")) return;
    const resolution = resolveArtifactIdentity(getDb(), req.params.id, "surface");
    const target = artifactMaterializationTarget(resolution);
    const content = target.ok ? await getArtifactContentAsync(getDb(), target.value) : await getArtifactContentAsync(getDb(), req.params.id);
    if (!content) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { content }));
  }, { operation: { id: "get:/api/artifacts/:id/content", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/artifacts/:id/open-externally", globalCapabilityRoute("open_path", async (req, res) => {
    const artifact = resolveArtifactRouteRecord(req.params.id);
    if (artifact && !enforceArtifactAccess(req, res, artifact.id, "read")) return;
    const result = await openArtifactExternally(getDb(), artifact?.id ?? req.params.id);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.reason });
      return;
    }
    sendJson(res, 200, result);
  }), { operation: { id: "post:/api/artifacts/:id/open-externally", effects: ["process:external"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "deny" });

  app.get("/api/artifacts/:id/check", async (req, res) => {
    const artifact = resolveArtifactRouteRecord(req.params.id);
    if (artifact && !enforceArtifactAccess(req, res, artifact.id, "read")) return;
    const check = artifact ? await checkArtifactMaterialization(getDb(), artifact.id) : null;
    if (!check) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { check }));
  }, { operation: { id: "get:/api/artifacts/:id/check", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/artifacts/:id/knowledge-backrefs", (req, res) => {
    const artifact = resolveArtifactRouteRecord(req.params.id);
    if (artifact && !enforceArtifactAccess(req, res, artifact.id, "read")) return;
    const backrefs = listKnowledgeBackrefs(getDb(), {
      sourceType: "artifact",
      sourceId: artifact?.id ?? req.params.id,
      providerId: queryString(req, "provider") ?? queryString(req, "provider_id"),
      refType: queryString(req, "ref_type"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { backrefs }));
  }, { operation: { id: "get:/api/artifacts/:id/knowledge-backrefs", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.post("/api/artifacts/:id/knowledge-backrefs", (req, res) => {
    try {
      if (!enforceArtifactAccess(req, res, req.params.id, "write")) return;
      const artifact = resolveArtifactRouteRecord(req.params.id);
      const backref = createKnowledgeBackref(getDb(), {
        ...bodyRecord(req),
        source_type: "artifact",
        source_id: artifact?.id ?? req.params.id,
      });
      if (backref.source_type === "artifact") broadcast(DOMAIN_EVENTS.ARTIFACT_CHANGED, { artifact_id: backref.source_id });
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { backref }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/artifacts/:id/knowledge-backrefs", effects: ["ledger:write","files:preview"], requestSchema: null, reportingCategory: "artifacts" }, fileRpc: "deny" });

  app.get("/api/artifacts/:id", (req, res) => {
    const artifact = resolveArtifactRouteRecord(req.params.id);
    if (!artifact) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    if (!enforceArtifactAccess(req, res, artifact.id, "read")) return;
    sendJson(res, 200, projectArtifactPublicValue(getDb(), { artifact }));
  }, { operation: { id: "get:/api/artifacts/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/provider-manifests/ingest", (req, res) => {
    try {
      const manifest = ingestProviderManifest(getDb(), bodyRecord(req));
      sendJson(res, 200, projectArtifactPublicValue(getDb(), { manifest }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/provider-manifests/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "providers" }, fileRpc: "deny" });
}
