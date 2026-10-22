import * as z from "zod";
import { documentArtifactImportEffects, documentHistoryImportEffects } from "../security/document-import-effects.js";
import { getDb, type Db } from "../db.js";
import { entityRefs, resolveCommentRef, resolveId, shortRef } from "../entity-refs.js";
import { parseIssueRefTarget } from "../ledger/authored-references.js";
import { LedgerStore } from "../ledger/store.js";
import {
  projectArtifactPublicValue,
  resolveArtifactIdentity,
  resolvedArtifactRecord,
  projectArtifactResolution,
} from "../provider-artifacts.js";
import {
  addSpaceItem,
  createSpace,
  createSpaceEdge,
  createSpaceOccurrence,
  deleteSpace,
  deleteSpaceEdge,
  deleteSpaceItem,
  deleteSpaceOccurrence,
  getSpace,
  getSpaceEdge,
  getSpaceItem,
  getSpaceOccurrence,
  listSpaceEdges,
  listSpaceItems,
  listSpaceOccurrences,
  listSpaces,
  listSpacesGrouped,
  listTopLevelSpaces,
  seedSpaceFromPredicate,
  updateSpace,
  updateSpaceEdge,
  updateSpaceItem,
  updateSpaceOccurrence,
  batchWriteOccurrences,
  type BatchOccurrenceEntry,
} from "../ledger/spaces.js";
import {
  createSpaceBlock,
  deleteSpaceBlock,
  detachItemFromBlocks,
  getSpaceBlock,
  isBlockType,
  isEmbedBlockType,
  listSpaceBlocks,
  updateSpaceBlock,
  BLOCK_TYPES,
  type BlockItemSnapshot,
  type BlockType,
} from "../ledger/space-blocks.js";
import { SPACE_EVENTS, type SpaceEvent } from "../spaces/events.js";
import { exportUntrackedCopy, serializeSpaceDocument, ExportError, resolveCheckoutForSpace, getProjectCheckout } from "../spaces/export.js";
import { preparePublication, executePublication, getPublication, listPublications, importManagedDocument, importHistoryDocument, importGitDocument, type PublicationResult, publicationDestinations } from "../spaces/publication.js";
import { documentHistoryEntry, listDocumentHistory } from "../spaces/history.js";
import { broadcastSpaceEvent } from "../sse.js";
import {
  SPACE_ITEM_REF_TYPES,
  SPACE_OCCURRENCE_RENDERERS,
  SPACE_RENDERERS,
  type ResolverRefKind,
  type ResolverResult,
  type Space,
  type SpaceFactPacket,
  type SpaceItemRefType,
  type SpaceOccurrenceRenderer,
  type SpaceRenderer,
} from "../contracts.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { TimelineIssuePredicate } from "../types.js";
import { bodyRecord, sendJson } from "./http.js";
import { requireProjectAccess, PermissionError, sendPermissionError, type ProjectRole } from "../permissions/store.js";
import { artifactAccessProjectIds, resolveArtifactProject, resolveWorkProject } from "../permissions/resources.js";
import { BriefingStoreError, resolveBriefingId, shortBriefingRef } from "../feedback/briefings.js";
import { ClientAuthzError } from "../client-auth/authz.js";
import { briefingReadViewer } from "./briefing.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { effectiveWorkerStatus } from "../ledger/issue-work-state.js";
import { candidateProjectIds, resolveOperationalIssueRef } from "../ledger/operational-links.js";
import { projectRouteRef } from "../ledger/issue-detail.js";

function documentProjectAccess(db: Db, req: RequestLike, project: string | null | undefined, role: ProjectRole): void {
  if (project) requireProjectAccess(db, req, project, role);
}
function documentArtifactAccess(db: Db, req: RequestLike, ref: string): string {
  const resolution = resolveArtifactIdentity(db, ref, "strict-read");
  if (resolution.status !== "resolved") throw new HttpError(400, `Artifact reference is ${resolution.status}`);
  const pinned = resolution.artifact_version?.id ?? resolution.artifact_blob?.id ?? resolution.logical_artifact?.id;
  if (!pinned) throw new HttpError(400, "Artifact identity is unavailable");
  const projects = new Set(artifactAccessProjectIds(db, pinned));
  const version = resolution.artifact_version;
  if (version?.custody_mode === "git" && version.source_project_id) projects.add(version.source_project_id);
  for (const project of projects) requireProjectAccess(db, req, project, "read");
  return pinned;
}
function documentCheckoutAccess(db: Db, req: RequestLike, id: string, role: ProjectRole): void {
  const checkout = getProjectCheckout(db, id);
  if (!checkout) throw new HttpError(404, "Destination checkout unavailable");
  requireProjectAccess(db, req, checkout.project_id, role);
}
function documentHistoryAccess(db: Db, req: RequestLike, entry: Record<string, unknown>): void {
  const provenance = JSON.parse(String(entry.provenance_json)) as { repo_id?: string };
  if (provenance.repo_id) documentCheckoutAccess(db, req, provenance.repo_id, "read");
  if (typeof entry.artifact_ref === "string") documentArtifactAccess(db, req, entry.artifact_ref);
}
function visibleDocument<T>(check: () => void, value: T): T[] {
  try { check(); return [value]; }
  catch (error) { if (error instanceof PermissionError) return []; throw error; }
}
function queryString(req: RequestLike, key: string): string | undefined {
  const value = req.query?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof PermissionError) { sendPermissionError(res, error); return; }
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${key} is required`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${key} must be a finite number`);
  }
  return value;
}

function optionalMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body.metadata;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireRenderer(value: unknown, key: string): SpaceRenderer {
  if (typeof value !== "string" || !SPACE_RENDERERS.includes(value as SpaceRenderer)) {
    throw new HttpError(400, `${key} must be one of: ${SPACE_RENDERERS.join(", ")}`);
  }
  return value as SpaceRenderer;
}

function requireOccurrenceRenderer(value: unknown): SpaceOccurrenceRenderer {
  if (typeof value !== "string" || !SPACE_OCCURRENCE_RENDERERS.includes(value as SpaceOccurrenceRenderer)) {
    throw new HttpError(400, `renderer must be one of: ${SPACE_OCCURRENCE_RENDERERS.join(", ")}`);
  }
  return value as SpaceOccurrenceRenderer;
}

function requireRefType(value: unknown): SpaceItemRefType {
  if (typeof value !== "string" || !SPACE_ITEM_REF_TYPES.includes(value as SpaceItemRefType)) {
    throw new HttpError(400, `ref_type must be one of: ${SPACE_ITEM_REF_TYPES.join(", ")}`);
  }
  return value as SpaceItemRefType;
}

function loadSpaceOr404(db: Db, ref: string): Space {
  const resolved = resolveId(db, "space", ref);
  if (resolved.ok) return getSpace(db, resolved.id)!;
  if (resolved.error === "ambiguous") throw new HttpError(409, `ambiguous space ref '${ref}'`);
  throw new HttpError(404, "space not found");
}

function resolveSpacesProjectFilter(db: Db, ref: string): string {
  const exactId = db.prepare("SELECT id FROM ledger_projects WHERE id = ?").get(ref) as
    | { id: string }
    | undefined;
  if (exactId) return exactId.id;

  const exactKey = db.prepare("SELECT id FROM ledger_projects WHERE project_key = ?").get(ref) as
    | { id: string }
    | undefined;
  if (exactKey) return exactKey.id;

  if (!ref.startsWith("prj_") || ref.length < 4) {
    throw new HttpError(404, "project not found");
  }
  const rows = db.prepare(
    `SELECT id FROM ledger_projects
      WHERE project_key = '' AND substr(id, 1, length(?)) = ?
      ORDER BY id LIMIT 2`,
  ).all(ref, ref) as Array<{ id: string }>;
  if (rows.length === 0) throw new HttpError(404, "project not found");
  if (rows.length > 1) throw new HttpError(409, `ambiguous project ref '${ref}'`);
  return rows[0].id;
}

function projectExists(db: Db, projectId: string): boolean {
  const row = db.prepare("SELECT 1 FROM ledger_projects WHERE id = ?").get(projectId);
  return !!row;
}

/**
 * Validate that an item ref exists. Cross-project membership is a UNIVERSAL,
 * item-level capability for EVERY Space (issue 812df41): a Space's optional
 * `project_id` only controls where it appears in the sidebar (under that
 * project's header, or top-level when null), never which items it may contain.
 * So `issue`/`comment`/`space` refs from ANY project are accepted for ANY Space
 * — project-scoped and top-level alike — exactly like `artifact`/`external_ref`
 * refs. The only constraint is existence: the ref must resolve to a real row.
 * Space-to-space self links are rejected to avoid canvas nodes that recurse into
 * their own container.
 */
function validateItemRef(
  db: Db,
  space: Space,
  refType: SpaceItemRefType,
  refId: string,
): void {
  if (refType === "artifact" || refType === "external_ref") return;
  if (refType === "space") {
    if (refId === space.id) {
      throw new HttpError(400, "space ref cannot link to its containing space");
    }
    if (!getSpace(db, refId)) {
      throw new HttpError(400, `space ref not found: ${refId}`);
    }
    return;
  }
  if (refType === "issue") {
    const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?").get(refId) as
      | { project_id: string }
      | undefined;
    if (!row) throw new HttpError(400, `issue ref not found: ${refId}`);
    return;
  }
  // comment
  const row = db.prepare(
    `SELECT i.project_id AS project_id
       FROM ledger_comments c
       JOIN ledger_issues i ON i.id = c.issue_id
      WHERE c.id = ?`,
  ).get(refId) as { project_id: string } | undefined;
  if (!row) throw new HttpError(400, `comment ref not found: ${refId}`);
}

// --- unified ref resolver ----------------------------------------------------

/**
 * `context` names the project the ref was written in (a project or repo ref).
 * A bare issue ref resolves there first, and the result says whether the issue
 * belongs to it.
 */
function resolveUnifiedRef(db: Db, req: RequestLike, rawRef: string, context?: string): ResolverResult {
  const ref = rawRef.trim();
  const store = new LedgerStore(db);

  // mandible:// app-route refs (e.g. mandible:///issues?issue=...) — parse the
  // embedded entity ref where present, otherwise report as an app route.
  if (ref.startsWith("mandible://")) {
    return resolveMandibleRef(db, req, store, ref);
  }

  // repo:// refs are repo-relative artifact/file refs — defer to the artifact
  // resolver, which understands repo-relative custody refs.
  if (ref.startsWith("repo://")) {
    const resolution = resolveArtifactIdentity(db, ref, "surface");
    return {
      ref,
      kind: "repo",
      resolved: resolvedArtifactRecord(resolution) !== null,
      entity: resolvedArtifactRecord(resolution) as Record<string, unknown> | null,
      detail: { resolution: projectArtifactResolution(db, resolution) },
    };
  }

  // Typed entity prefixes.
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const prefix = ref.slice(0, colon);
    const rest = ref.slice(colon + 1);
    if (prefix === "issue") return resolveIssueRef(db, store, rest, ref, context);
    if (prefix === "comment") return resolveCommentResult(db, rest, ref);
    if (prefix === "auth") return resolveAuthRef(db, req, rest, ref);
    if (prefix === "briefing") return resolveBriefingRef(db, req, ref);
    if (prefix === "artifact") return resolveArtifactResult(db, ref);
    if (prefix === "uri" && rest) return resolveArtifactResult(db, rest);
  }

  // Other URI-style artifact schemes are delegated to the artifact resolver so
  // unsupported diagnostics are consistent.
  if (ref.startsWith("sha256:") || ref.includes("://")) {
    return resolveArtifactResult(db, ref);
  }

  // Fall back: try issue ref resolution, then artifact resolution.
  const issue = store.resolveIssueRef(ref);
  if (issue.ok) return resolveIssueRef(db, store, ref, ref, context);
  return resolveArtifactResult(db, ref);
}

function resolveMandibleRef(db: Db, req: RequestLike, store: LedgerStore, ref: string): ResolverResult {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { ref, kind: "mandible", resolved: false, entity: null, error: "invalid mandible ref" };
  }
  const issueParam = url.searchParams.get("issue");
  const requestParam = url.searchParams.get("request");
  const artifactParam = url.searchParams.get("ref");
  const route = url.pathname.replace(/^\/+/, "");
  if (requestParam && route === "auth") return resolveAuthRef(db, req, requestParam, ref);
  if (issueParam) return resolveIssueRef(db, store, issueParam, ref, url.searchParams.get("repo") ?? undefined);
  if (artifactParam) return resolveArtifactResult(db, artifactParam, "mandible", ref);
  return {
    ref,
    kind: "mandible",
    resolved: false,
    entity: null,
    detail: {
      route: url.pathname.replace(/^\/+/, ""),
      params: Object.fromEntries(url.searchParams.entries()),
    },
  };
}

function resolveIssueRef(
  db: Db,
  store: LedgerStore,
  refValue: string,
  ref: string,
  context?: string,
): ResolverResult {
  // `issue:<id>#<n>` addresses comment ordinal n; `#0` is the description.
  const target = parseIssueRefTarget(refValue.trim());
  const issueRef = target
    ? `${target.project ? `${target.project}/` : ""}${target.issue}`
    : refValue.trim();
  const operational = resolveOperationalIssueRef(db, issueRef, context);
  const resolved = operational.ok
    ? { ok: true as const, id: operational.issue_id }
    : operational.error === "ambiguous"
      ? { ok: false as const, error: "ambiguous" as const, matches: operational.matches ?? [] }
      : { ok: false as const, error: "not_found" as const };
  if (!resolved.ok) {
    return {
      ref,
      kind: "issue",
      resolved: false,
      entity: null,
      error: resolved.error,
      ...(resolved.error === "ambiguous"
        ? { detail: { matches: resolved.matches } }
        : {}),
    };
  }
  if (target?.ordinal) return resolveCommentOrdinal(store, resolved.id, String(target.ordinal), ref);
  try {
    const issue = store.getIssue(resolved.id);
    const entity = {
      ...issue,
      worker_status: effectiveWorkerStatus(db, issue.id),
      project_ref: projectRouteRef(db, issue.project_id),
    };
    return {
      ref,
      kind: "issue",
      resolved: true,
      entity: entity as unknown as Record<string, unknown>,
      ...(context ? { detail: { same_project: candidateProjectIds(db, context).includes(issue.project_id) } } : {}),
    };
  } catch (error) {
    return { ref, kind: "issue", resolved: false, entity: null, error: String(error) };
  }
}

function resolveCommentOrdinal(store: LedgerStore, issueId: string, selector: string, ref: string): ResolverResult {
  const comment = /^\d+$/.test(selector) ? store.findCommentByOrdinal(issueId, Number(selector)) : null;
  return comment
    ? { ref, kind: "comment", resolved: true, entity: comment as unknown as Record<string, unknown> }
    : { ref, kind: "comment", resolved: false, entity: null, error: "comment not found" };
}

function resolveAuthRef(db: Db, req: RequestLike, refValue: string, ref: string): ResolverResult {
  const resolved = resolveId(db, "auth_request", refValue.trim());
  if (!resolved.ok) {
    return { ref, kind: "auth", resolved: false, entity: null, error: resolved.error };
  }
  const request = db.prepare(
    `SELECT id, type, title, status, repo, target_repo_root, base_branch, head_branch,
            created_at, approved_at, resolved_at, exit_code
       FROM auth_requests WHERE id = ?`,
  ).get(resolved.id) as Record<string, unknown>;
  const projects = new Set<string>();
  for (const projectRef of [request.target_repo_root, request.repo]) {
    if (typeof projectRef !== "string" || !projectRef.trim()) continue;
    const project = resolveWorkProject(db, projectRef);
    if (!project.ok && project.reason === "ambiguous") {
      return { ref, kind: "auth", resolved: false, entity: null, error: "project_unresolved" };
    }
    if (project.ok) projects.add(project.project_id);
  }
  if (projects.size !== 1) {
    return { ref, kind: "auth", resolved: false, entity: null, error: "project_unresolved" };
  }
  requireProjectAccess(db, req, [...projects][0], "read");
  const id = shortRef(db, "auth_request", request.id as string);
  const { target_repo_root: _root, ...entity } = request;
  return { ref, kind: "auth", resolved: true, entity: { ...entity, id } };
}

// `briefing:<id-or-prefix>` resolves through the shared Briefing resolver, which
// also matches legacy ids stored with a `briefing:` prefix. Agents read
// Briefings as the configured operator, scoped by the Briefing's artifact project.
function resolveBriefingRef(db: Db, req: RequestLike, ref: string): ResolverResult {
  const viewer = briefingReadViewer(db, req);
  let briefingId: string;
  try {
    briefingId = resolveBriefingId(db, ref, viewer);
  } catch (error) {
    if (!(error instanceof BriefingStoreError)) throw error;
    const reason = error.code === "ambiguous_ref" ? "ambiguous" : error.code === "not_found" ? "not_found" : error.message;
    return { ref, kind: "briefing", resolved: false, entity: null, error: reason };
  }
  const briefing = db.prepare(
    `SELECT id, title, description, logical_artifact_id, archived_at, created_at, updated_at
       FROM briefings WHERE id = ?`,
  ).get(briefingId) as Record<string, unknown> & { logical_artifact_id: string | null };
  if (viewer.projectScoped) {
    const scope = briefing.logical_artifact_id ? resolveArtifactProject(db, briefing.logical_artifact_id) : null;
    if (!scope?.ok) return { ref, kind: "briefing", resolved: false, entity: null, error: "project_unresolved" };
    requireProjectAccess(db, req, scope.project_id, "read");
  }
  const short = shortBriefingRef(db, briefingId);
  return { ref, kind: "briefing", resolved: true, entity: { ...briefing, id: short.slice("briefing:".length), ref: short } };
}

function resolveCommentResult(db: Db, refValue: string, ref: string): ResolverResult {
  const resolved = resolveCommentRef(db, refValue);
  if (!resolved.ok) {
    return { ref, kind: "comment", resolved: false, entity: null, error: resolved.error === "ambiguous" ? "ambiguous" : "comment not found" };
  }
  const comment = new LedgerStore(db).getComment(resolved.id);
  return { ref, kind: "comment", resolved: true, entity: comment as unknown as Record<string, unknown> };
}

function resolveArtifactResult(
  db: Db,
  refValue: string,
  kind: ResolverRefKind = "artifact",
  displayRef?: string,
): ResolverResult {
  const trimmed = refValue.trim();
  const resolution = /^artifact:sha256:[0-9a-f]{64}$/i.test(trimmed)
    ? resolveArtifactIdentity(db, trimmed, "strict-read")
    : resolveArtifactIdentity(db, trimmed, "surface");
  const publicResolution = projectArtifactPublicValue(db, projectArtifactResolution(db, resolution)) as ReturnType<typeof projectArtifactResolution>;
  return {
    ref: displayRef ?? refValue,
    kind,
    resolved: resolvedArtifactRecord(resolution) !== null,
    entity: publicResolution.artifact as Record<string, unknown> | null,
    detail: { resolution: publicResolution },
  };
}

// --- route registration ------------------------------------------------------

export function registerSpacesRoutes(router: RouteRegistrar): void {
  // Unified resource-ref resolver. Registered before /api/spaces/:id so the
  // literal path is not shadowed by the param route.
  const resolveHandler = (req: RequestLike, res: ResponseLike) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "uri");
      if (!ref) throw new HttpError(400, "ref query parameter required");
      const db = getDb();
      sendJson(res, 200, { resolution: resolveUnifiedRef(db, req, ref, queryString(req, "project")) });
    } catch (error) {
      handleError(res, error);
    }
  };
  router.get("/api/spaces/resolve", resolveHandler, { operation: { id: "get:/api/spaces/resolve", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.get("/api/refs/resolve", resolveHandler, { operation: { id: "get:/api/refs/resolve", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // --- spaces CRUD ---
  // List modes (issue 812df41):
  //   ?project_id=<id>  → that project's Spaces (each carries its nullable project_id)
  //   ?scope=top-level  → only top-level / global Spaces (project_id IS NULL)
  //   (neither)         → grouped list: { groups: [...] } with a top-level group
  //                       first, then one group per project. The flat `spaces`
  //                       field (every Space, all groups flattened) is included so
  //                       existing flat-list callers keep working.
  router.get("/api/spaces", (req, res) => {
    try {
      const db = getDb();
      const projectId = queryString(req, "project_id");
      if (projectId) {
        sendJson(res, 200, { spaces: listSpaces(db, resolveSpacesProjectFilter(db, projectId)) });
        return;
      }
      if (queryString(req, "scope") === "top-level") {
        sendJson(res, 200, { spaces: listTopLevelSpaces(db) });
        return;
      }
      const groups = listSpacesGrouped(db);
      sendJson(res, 200, { groups, spaces: groups.flatMap((group) => group.spaces) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/spaces", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/spaces", (req, res) => {
    try {
      const db = getDb();
      const body = bodyRecord(req);
      // project_id is OPTIONAL (issue 812df41): omitted or null creates a
      // top-level / global Space owned by no project. When present it must
      // resolve to a real project.
      const projectId = optionalString(body, "project_id") ?? null;
      if (projectId !== null && !projectExists(db, projectId)) {
        throw new HttpError(400, "project not found");
      }
      const space = createSpace(db, {
        project_id: projectId,
        title: requireString(body, "title"),
        default_renderer: body.default_renderer === undefined
          ? undefined
          : requireRenderer(body.default_renderer, "default_renderer"),
        description: optionalString(body, "description"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_CREATED, space.id);
      sendJson(res, 201, { space });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.get("/api/spaces/:id", (req, res) => {
    try {
      const db = getDb();
      // Return the full fact packet (space + items/occurrences/edges) per the
      // umbrella plan §5.1 / §589: `GET /api/spaces/:id` is the read surface the
      // renderers (C8 collection, C9a canvas, …) load their model from. The
      // `space` field is preserved for backward compatibility; the additional
      // collections are a superset so existing callers are unaffected.
      const space = loadSpaceOr404(db, req.params.id);
      sendJson(res, 200, {
        space,
        items: listSpaceItems(db, space.id),
        occurrences: listSpaceOccurrences(db, space.id),
        edges: listSpaceEdges(db, space.id),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/spaces/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.patch("/api/spaces/:id", (req, res) => {
    try {
      const db = getDb();
      const resolved = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const space = updateSpace(db, resolved.id, {
        title: optionalString(body, "title") ?? undefined,
        default_renderer: body.default_renderer === undefined
          ? undefined
          : requireRenderer(body.default_renderer, "default_renderer"),
        description: optionalString(body, "description"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_UPDATED, resolved.id);
      sendJson(res, 200, { space });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/spaces/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.delete("/api/spaces/:id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      deleteSpace(db, space.id);
      emit(SPACE_EVENTS.SPACE_DELETED, space.id);
      sendJson(res, 200, { ok: true, id: space.id });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/spaces/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  // --- items ---
  router.post("/api/spaces/:id/items", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const refType = requireRefType(body.ref_type);
      const refId = requireString(body, "ref_id");
      validateItemRef(db, space, refType, refId);
      const metadata = optionalMetadata(body);
      const result = addSpaceItem(db, space.id, {
        ref_type: refType,
        ref_id: refId,
        ref_uri: optionalString(body, "ref_uri"),
        title: optionalString(body, "title"),
        metadata,
      });
      emit(SPACE_EVENTS.SPACE_ITEM_ADDED, space.id);
      sendJson(res, result.created ? 201 : 200, {
        item: result.item,
        created: result.created,
        already_present: !result.created,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/items", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.patch("/api/spaces/:id/items/:item_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const existing = getSpaceItem(db, space.id, req.params.item_id);
      if (!existing) {
        throw new HttpError(404, "item not found");
      }
      const body = bodyRecord(req);
      const rawMetadata = optionalMetadata(body);
      const metadata = rawMetadata;
      const item = updateSpaceItem(db, space.id, req.params.item_id, {
        ref_uri: optionalString(body, "ref_uri"),
        title: optionalString(body, "title"),
        metadata,
      });
      emit(SPACE_EVENTS.SPACE_ITEM_UPDATED, space.id);
      sendJson(res, 200, { item });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/spaces/:id/items/:item_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { item_id: entityRefs.spaceItem } } });

  router.delete("/api/spaces/:id/items/:item_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceItem(db, space.id, req.params.item_id)) {
        throw new HttpError(404, "item not found");
      }
      emit(SPACE_EVENTS.SPACE_ITEM_REMOVED, space.id);
      sendJson(res, 200, { ok: true, id: req.params.item_id });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/spaces/:id/items/:item_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { item_id: entityRefs.spaceItem } } });

  // --- occurrences ---
  router.post("/api/spaces/:id/occurrences", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const occurrence = createSpaceOccurrence(db, space.id, parseOccurrenceInput(db, space.id, body));
      emit(SPACE_EVENTS.SPACE_OCCURRENCE_CREATED, space.id);
      sendJson(res, 201, { occurrence });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/occurrences", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.post("/api/spaces/:id/occurrences/batch", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const rawEntries = body.occurrences;
      if (!Array.isArray(rawEntries)) {
        throw new HttpError(400, "occurrences must be an array");
      }
      const entries: BatchOccurrenceEntry[] = rawEntries.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new HttpError(400, "each occurrence entry must be an object");
        }
        const entry = raw as Record<string, unknown>;
        const parsed = parseOccurrenceInput(db, space.id, entry);
        const id = optionalString(entry, "id");
        return { ...parsed, id: id ?? undefined };
      });
      const result = batchWriteOccurrences(db, space.id, entries);
      emit(SPACE_EVENTS.SPACE_OCCURRENCE_MOVED, space.id);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/occurrences/batch", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.patch("/api/spaces/:id/occurrences/:occurrence_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!getSpaceOccurrence(db, space.id, req.params.occurrence_id)) {
        throw new HttpError(404, "occurrence not found");
      }
      const occurrence = updateSpaceOccurrence(
        db,
        space.id,
        req.params.occurrence_id,
        parseOccurrenceInput(db, space.id, bodyRecord(req)),
      );
      emit(SPACE_EVENTS.SPACE_OCCURRENCE_UPDATED, space.id);
      sendJson(res, 200, { occurrence });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/spaces/:id/occurrences/:occurrence_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { occurrence_id: entityRefs.spaceOccurrence } } });

  router.delete("/api/spaces/:id/occurrences/:occurrence_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceOccurrence(db, space.id, req.params.occurrence_id)) {
        throw new HttpError(404, "occurrence not found");
      }
      emit(SPACE_EVENTS.SPACE_OCCURRENCE_REMOVED, space.id);
      sendJson(res, 200, { ok: true, id: req.params.occurrence_id });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/spaces/:id/occurrences/:occurrence_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { occurrence_id: entityRefs.spaceOccurrence } } });

  // --- edges ---
  router.post("/api/spaces/:id/edges", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const source = requireString(body, "source");
      const target = requireString(body, "target");
      requireOccurrenceExists(db, space.id, source, "source");
      requireOccurrenceExists(db, space.id, target, "target");
      const edge = createSpaceEdge(db, space.id, {
        source,
        target,
        label: optionalString(body, "label"),
        style: optionalString(body, "style"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_EDGE_CREATED, space.id);
      sendJson(res, 201, { edge });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/edges", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.patch("/api/spaces/:id/edges/:edge_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!getSpaceEdge(db, space.id, req.params.edge_id)) {
        throw new HttpError(404, "edge not found");
      }
      const body = bodyRecord(req);
      const source = optionalString(body, "source");
      const target = optionalString(body, "target");
      if (source) requireOccurrenceExists(db, space.id, source, "source");
      if (target) requireOccurrenceExists(db, space.id, target, "target");
      const edge = updateSpaceEdge(db, space.id, req.params.edge_id, {
        source: source ?? undefined,
        target: target ?? undefined,
        label: optionalString(body, "label"),
        style: optionalString(body, "style"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_EDGE_UPDATED, space.id);
      sendJson(res, 200, { edge });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/spaces/:id/edges/:edge_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { edge_id: entityRefs.spaceEdge } } });

  router.delete("/api/spaces/:id/edges/:edge_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceEdge(db, space.id, req.params.edge_id)) {
        throw new HttpError(404, "edge not found");
      }
      emit(SPACE_EVENTS.SPACE_EDGE_REMOVED, space.id);
      sendJson(res, 200, { ok: true, id: req.params.edge_id });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/spaces/:id/edges/:edge_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { edge_id: entityRefs.spaceEdge } } });

  // --- seed-from-filter ---
  router.post("/api/spaces/:id/seed", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const predicate = (body.predicate ?? body.scope) as TimelineIssuePredicate | undefined;
      if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) {
        throw new HttpError(400, "predicate (or scope) object is required");
      }
      const result = seedSpaceFromPredicate(db, space, {
        predicate,
        with_shelf_occurrences: body.with_shelf_occurrences === true,
        include_artifacts: body.include_artifacts !== false,
      });
      emit(SPACE_EVENTS.SPACE_SEEDED, space.id);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/seed", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  // --- blocks (C11, issue d2a8e77) ---
  // The document/canvas block tree. Block identity (`id`/`parent`/`sort`/`type`/
  // `item`) agrees with the C12 `spaces-doc.v1` serialization; the helper layer
  // (src/ledger/space-blocks.ts) owns sort-key generation, parent-cycle
  // rejection, the snapshot invariant, and detach/degrade. All mutations emit
  // the frozen `space:block:changed` event.
  router.get("/api/spaces/:id/blocks", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      sendJson(res, 200, { blocks: listSpaceBlocks(db, space.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/spaces/:id/blocks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/spaces/:id/blocks", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const input = parseBlockCreateInput(db, space.id, body);
      const block = createSpaceBlock(db, space.id, input);
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED, space.id);
      sendJson(res, 201, { block });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/blocks", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });

  router.patch("/api/spaces/:id/blocks/:block_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!getSpaceBlock(db, space.id, req.params.block_id)) {
        throw new HttpError(404, "block not found");
      }
      const input = parseBlockUpdateInput(db, space.id, bodyRecord(req));
      const block = updateSpaceBlock(db, space.id, req.params.block_id, input);
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED, space.id);
      sendJson(res, 200, { block });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/spaces/:id/blocks/:block_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { block_id: entityRefs.spaceBlock } } });

  router.delete("/api/spaces/:id/blocks/:block_id", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceBlock(db, space.id, req.params.block_id)) {
        throw new HttpError(404, "block not found");
      }
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED, space.id);
      sendJson(res, 200, { ok: true, id: req.params.block_id });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/spaces/:id/blocks/:block_id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { block_id: entityRefs.spaceBlock } } });

  // Detach/degrade: drop the item_id embed from every block in the Space that
  // embeds it (preserving item_snapshot_json as a placeholder) so the item can
  // then be deleted without hitting the ON DELETE RESTRICT guard.
  router.post("/api/spaces/:id/items/:item_id/detach-blocks", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      if (!getSpaceItem(db, space.id, req.params.item_id)) {
        throw new HttpError(404, "item not found");
      }
      const result = detachItemFromBlocks(db, space.id, req.params.item_id);
      if (result.detached.length > 0) emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED, space.id);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/spaces/:id/items/:item_id/detach-blocks", effects: ["ledger:write"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow", refs: { params: { item_id: entityRefs.spaceItem } } });

  router.get("/api/spaces/:id/publications", (req,res)=> {
    try { const db=getDb(), space=loadSpaceOr404(db,req.params.id);
      documentProjectAccess(db,req,space.project_id,"read");
      sendJson(res,200,{
        publications:listPublications(db,space.id).flatMap(value=>visibleDocument(()=>{
          documentCheckoutAccess(db,req,value.repo_id,"read"); documentArtifactAccess(db,req,value.snapshot_ref);
          if(value.version_ref) documentArtifactAccess(db,req,value.version_ref);
        },value)),
        history:listDocumentHistory(db,space.id).flatMap(value=>visibleDocument(()=>documentHistoryAccess(db,req,value),value)),
        destinations:publicationDestinations(db,space.id).flatMap(value=>visibleDocument(()=>requireProjectAccess(db,req,value.project_id,"write"),value)),
      });
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "get:/api/spaces/:id/publications", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
  router.post("/api/spaces/:id/publications", (req,res)=> {
    try { const db=getDb(), space=loadSpaceOr404(db,req.params.id), body=bodyRecord(req);
      documentProjectAccess(db,req,space.project_id,"write");
      const checkout=resolveCheckoutForSpace(db,space,optionalString(body,"repo_id"));
      requireProjectAccess(db,req,checkout.project_id,"write");
      const publication=publicationValue(preparePublication(db,{ spaceId:space.id,repoId:optionalString(body,"repo_id"),
        path:requireString(body,"path"),issue:requireString(body,"issue"),message:optionalString(body,"message") ?? undefined }));
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED,space.id);
      sendJson(res,201,publication);
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "post:/api/spaces/:id/publications", effects: ["ledger:write", "files:production"], requestSchema: z.object({ repo_id: z.string().trim().min(1).nullish(), path: z.string().trim().min(1), issue: z.string().trim().min(1), message: z.string().optional() }).strict(), reportingCategory: "spaces" }, fileRpc: "allow" });
  router.post("/api/spaces/:id/publications/:publication_id/submit", async (req,res)=> {
    try { const db=getDb(), space=loadSpaceOr404(db,req.params.id);
      documentProjectAccess(db,req,space.project_id,"write");
      const selected=getPublication(db,space.id,req.params.publication_id);
      documentCheckoutAccess(db,req,selected.repo_id,"write");
      documentArtifactAccess(db,req,selected.snapshot_ref);
      if(selected.version_ref) documentArtifactAccess(db,req,selected.version_ref);
      const publication=publicationValue(await executePublication(db,space.id,req.params.publication_id));
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED,space.id);
      sendJson(res,200,publication);
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "post:/api/spaces/:id/publications/:publication_id/submit", effects: ["ledger:write", "files:production", "process:external", "auth:protected"], requestSchema: null, reportingCategory: "spaces" }, fileRpc: "allow" });
  router.post("/api/spaces/documents/import", (req,res)=> {
    try { const db=getDb(),body=bodyRecord(req);
      const destination=optionalString(body,"project_id");
      documentProjectAccess(db,req,destination,"write");
      let pinnedRef: string | undefined;
      if (body.ref) pinnedRef=documentArtifactAccess(db,req,requireString(body,"ref"));
      else {
        const project=resolveProjectRef(db,requireString(body,"project"));
        if(!project.ok) throw new HttpError(400,"Source project is unavailable or ambiguous");
        requireProjectAccess(db,req,project.project.id,"read");
      }
      const space = publicationValue(body.ref ? importManagedDocument(db,{ ref:pinnedRef!,title:requireString(body,"title"),projectId:destination })
        : importGitDocument(db,{project:requireString(body,"project"),commit:requireString(body,"commit"),path:requireString(body,"path"),title:requireString(body,"title"),projectId:optionalString(body,"project_id")}));
      emit(SPACE_EVENTS.SPACE_CREATED,space.id);
      sendJson(res,201,space);
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "post:/api/spaces/documents/import", effects: ({ body }) => (body as { ref?: string }).ref ? documentArtifactImportEffects(getDb(), (body as { ref: string }).ref) : ["ledger:read", "ledger:write", "files:production"], requestSchema: z.union([z.object({ ref: z.string().trim().min(1), title: z.string().trim().min(1), project_id: z.string().trim().min(1).nullish() }).strict(), z.object({ project: z.string().trim().min(1), commit: z.string().trim().min(1), path: z.string().trim().min(1), title: z.string().trim().min(1), project_id: z.string().trim().min(1).nullish() }).strict()]), reportingCategory: "spaces" }, fileRpc: "allow" });
  router.post("/api/spaces/:id/history/:history_id/import",(req,res)=> {
    try {const db=getDb(),source=loadSpaceOr404(db,req.params.id),body=bodyRecord(req);
      documentProjectAccess(db,req,source.project_id,"write");
      const entry=documentHistoryEntry(db,source.id,req.params.history_id);
      if(!entry) throw new HttpError(404,"Historical document not found");
      documentHistoryAccess(db,req,entry);
      const space=publicationValue(importHistoryDocument(db,source.id,req.params.history_id,requireString(body,"title")));
      emit(SPACE_EVENTS.SPACE_CREATED,space.id);sendJson(res,201,space);
    } catch(error){handleExportError(res,error);}
  }, { operation: { id: "post:/api/spaces/:id/history/:history_id/import", effects: ({ params }) => documentHistoryImportEffects(getDb(), params.id, params.history_id), requestSchema: z.object({ title: z.string().trim().min(1) }).strict(), reportingCategory: "spaces" }, fileRpc: "allow" });
  router.get("/api/spaces/:id/document/download", (req,res)=> {
    try { const db=getDb(),space=loadSpaceOr404(db,req.params.id);
      documentProjectAccess(db,req,space.project_id,"read");
      const result=serializeSpaceDocument(db,space.id);
      res.header?.("Content-Type","text/markdown; charset=utf-8");
      res.header?.("Content-Disposition",`attachment; filename="space-${space.id}.md"`);
      if (!res.text) throw new HttpError(500,"Download response unavailable");
      res.text(result,"text/markdown; charset=utf-8");
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "get:/api/spaces/:id/document/download", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
  router.post("/api/spaces/:id/document/export", (req,res)=> {
    try { const db=getDb(),space=loadSpaceOr404(db,req.params.id),body=bodyRecord(req);
      documentProjectAccess(db,req,space.project_id,"read");
      const checkoutId=optionalString(body,"repo_id");
      if(checkoutId) documentCheckoutAccess(db,req,checkoutId,"read");
      sendJson(res,200,exportUntrackedCopy(db,{spaceId:space.id,destPath:requireString(body,"dest_path"),repoId:optionalString(body,"repo_id")}));
    } catch(error) { handleExportError(res,error); }
  }, { operation: { id: "post:/api/spaces/:id/document/export", effects: ["ledger:read", "files:production"], requestSchema: z.object({ dest_path: z.string().trim().min(1), repo_id: z.string().trim().min(1).nullish() }).strict(), reportingCategory: "spaces" }, fileRpc: "allow" });

}

/** Map an {@link ExportError} machine code to a clean HTTP status. */
function handleExportError(res: ResponseLike, error: unknown): void {
  if (error instanceof ExportError) {
    const status =
      error.code === "space_not_found"
        ? 404
        : error.code === "checkout_not_found"
          ? 404
          : error.code === "worktree_dirty" || error.code === "locked" || error.code === "stale_destination"
            ? 409
            : error.code === "invalid_path"
              ? 400
              : 500;
    sendJson(res, status, { error: error.message, code: error.code });
    return;
  }
  handleError(res, error);
}

// --- block input parsing -----------------------------------------------------

function requireBlockType(value: unknown): BlockType {
  if (!isBlockType(value)) {
    throw new HttpError(400, `block_type must be one of: ${BLOCK_TYPES.join(", ")}`);
  }
  return value;
}

function optionalSnapshot(body: Record<string, unknown>): BlockItemSnapshot | null | undefined {
  const value = body.item_snapshot;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "item_snapshot must be a JSON object");
  }
  return value as BlockItemSnapshot;
}

/**
 * Validate that `parent_id`/`item_id` reference rows that exist in THIS space.
 * Cross-space refs are impossible at the DB level (composite FKs are scoped to
 * `space_id`), but validating here returns a clean 400 instead of a raw SQLite
 * constraint error.
 */
function requireBlockParentInSpace(db: Db, spaceId: string, parentId: string): void {
  if (!getSpaceBlock(db, spaceId, parentId)) {
    throw new HttpError(400, `parent_id not found in space: ${parentId}`);
  }
}

function requireItemInSpace(db: Db, spaceId: string, itemId: string): void {
  if (!getSpaceItem(db, spaceId, itemId)) {
    throw new HttpError(400, `item_id not found in space: ${itemId}`);
  }
}

function parseBlockCreateInput(db: Db, spaceId: string, body: Record<string, unknown>) {
  const blockType = requireBlockType(body.block_type);
  const parentId = optionalString(body, "parent_id");
  if (typeof parentId === "string" && parentId) {
    requireBlockParentInSpace(db, spaceId, parentId);
  }
  const itemId = optionalString(body, "item_id");
  if (typeof itemId === "string" && itemId) {
    requireItemInSpace(db, spaceId, itemId);
  }
  const snapshot = optionalSnapshot(body);
  enforceEmbedShape(blockType, itemId, snapshot);
  return {
    parent_id: parentId,
    block_type: blockType,
    item_id: itemId,
    item_snapshot: snapshot,
    sort_key: optionalString(body, "sort_key"),
    markdown: optionalString(body, "markdown"),
    metadata: optionalMetadata(body),
  };
}

function parseBlockUpdateInput(db: Db, spaceId: string, body: Record<string, unknown>) {
  const blockType =
    body.block_type === undefined ? undefined : requireBlockType(body.block_type);
  const parentId = optionalString(body, "parent_id");
  if (typeof parentId === "string" && parentId) {
    requireBlockParentInSpace(db, spaceId, parentId);
  }
  const itemId = optionalString(body, "item_id");
  if (typeof itemId === "string" && itemId) {
    requireItemInSpace(db, spaceId, itemId);
  }
  const snapshot = optionalSnapshot(body);
  return {
    parent_id: parentId,
    block_type: blockType,
    item_id: itemId,
    item_snapshot: snapshot,
    sort_key: optionalString(body, "sort_key"),
    markdown: optionalString(body, "markdown"),
    metadata: optionalMetadata(body),
  };
}

/**
 * On create, a `*_embed` / `reference` block that carries an `item_id` must also
 * carry an `item_snapshot` (the placeholder that survives item deletion). The DB
 * CHECK enforces this too; this gives a clearer 400 at the route boundary.
 */
function enforceEmbedShape(
  blockType: BlockType,
  itemId: string | null | undefined,
  snapshot: BlockItemSnapshot | null | undefined,
): void {
  if (typeof itemId === "string" && itemId) {
    if (!snapshot) {
      throw new HttpError(400, "assigning item_id requires item_snapshot");
    }
    if (!isEmbedBlockType(blockType)) {
      throw new HttpError(
        400,
        `block_type "${blockType}" cannot embed an item_id (embed types: reference, artifact_embed, issue_embed, comment_embed)`,
      );
    }
  }
}

/** Read-only convenience: full Space fact packet (items/occurrences/edges). */
export function loadSpaceFactPacket(db: Db, id: string): SpaceFactPacket | null {
  const space = getSpace(db, id);
  if (!space) return null;
  return {
    space,
    items: listSpaceItems(db, id),
    occurrences: listSpaceOccurrences(db, id),
    edges: listSpaceEdges(db, id),
  };
}

function parseOccurrenceInput(db: Db, spaceId: string, body: Record<string, unknown>) {
  const itemId = optionalString(body, "item_id");
  if (typeof itemId === "string" && itemId && !getSpaceItem(db, spaceId, itemId)) {
    throw new HttpError(400, `item_id not found in space: ${itemId}`);
  }
  const parentId = optionalString(body, "parent_id");
  if (typeof parentId === "string" && parentId && !getSpaceOccurrence(db, spaceId, parentId)) {
    throw new HttpError(400, `parent_id not found in space: ${parentId}`);
  }
  const zRaw = optionalNumber(body, "z_index");
  return {
    item_id: itemId,
    renderer: body.renderer === undefined ? undefined : requireOccurrenceRenderer(body.renderer),
    parent_id: parentId,
    x: optionalNumber(body, "x"),
    y: optionalNumber(body, "y"),
    width: optionalNumber(body, "width"),
    height: optionalNumber(body, "height"),
    z_index: zRaw === undefined || zRaw === null ? zRaw : Math.trunc(zRaw),
    sort_key: optionalString(body, "sort_key"),
    section_id: optionalString(body, "section_id"),
    note: optionalString(body, "note"),
    metadata: optionalMetadata(body),
  };
}

function requireOccurrenceExists(db: Db, spaceId: string, occurrenceId: string, field: string): void {
  if (!getSpaceOccurrence(db, spaceId, occurrenceId)) {
    throw new HttpError(400, `${field} occurrence not found in space: ${occurrenceId}`);
  }
}

/**
 * Emit a frozen `space:*` event. C5 (transport SSE) owns the actual broadcast
 * wiring over `src/sse.ts`; this hook keeps the C2 mutation points referencing
 * the shared {@link SPACE_EVENTS} enum so the integration is a one-line swap.
 */
function emit(event: SpaceEvent, spaceId: string): void {
  broadcastSpaceEvent(event, { space_id: spaceId });
}

function publicationValue<T>(result:PublicationResult<T>):T {
  if(result.ok)return result.value;
  const status=result.error.code==='stale_destination'||result.error.code==='locked' ? 409
    : result.error.code==='space_not_found'||result.error.code==='checkout_not_found' ? 404
    : result.error.code==='git_failed'||result.error.code==='storage_failed' ? 500:400;
  throw new HttpError(status,result.error.message);
}
