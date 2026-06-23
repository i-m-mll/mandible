import { getDb, type Db } from "../db.js";
import { LedgerStore } from "../ledger/store.js";
import { getArtifact, resolveArtifactRef } from "../provider-artifacts.js";
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
  seedSpaceFromPredicate,
  updateSpace,
  updateSpaceEdge,
  updateSpaceItem,
  updateSpaceOccurrence,
  batchWriteOccurrences,
  SPACE_ITEM_REF_TYPES,
  SPACE_OCCURRENCE_RENDERERS,
  SPACE_RENDERERS,
  type BatchOccurrenceEntry,
  type SpaceItemRefType,
  type SpaceOccurrenceRenderer,
  type SpaceRecord,
  type SpaceRenderer,
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
  BlockValidationError,
  BLOCK_TYPES,
  type BlockItemSnapshot,
  type BlockType,
} from "../ledger/space-blocks.js";
import { SPACE_EVENTS, type SpaceEvent } from "../spaces/events.js";
import {
  exportAndTrack,
  exportUntrackedCopy,
  listSpaceExportsForSpace,
  resolveCheckoutForSpace,
  resolveDocsSettings,
  setGlobalDocsDefault,
  setRepoDocsOverride,
  ExportError,
} from "../spaces/export.js";
import { broadcastSpaceEvent } from "../sse.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { TimelineIssuePredicate } from "../types.js";

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function bodyRecord(req: RequestLike): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
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

function loadSpaceOr404(db: Db, id: string): SpaceRecord {
  const space = getSpace(db, id);
  if (!space) throw new HttpError(404, "space not found");
  return space;
}

function projectExists(db: Db, projectId: string): boolean {
  const row = db.prepare("SELECT 1 FROM ledger_projects WHERE id = ?").get(projectId);
  return !!row;
}

/**
 * Enforce the project-scoping policy: `issue`/`comment` refs must belong to the
 * Space's project; `artifact`/`external_ref` may cross project boundaries.
 */
function validateItemProjectScope(
  db: Db,
  space: SpaceRecord,
  refType: SpaceItemRefType,
  refId: string,
): void {
  if (refType === "artifact" || refType === "external_ref") return;
  if (refType === "issue") {
    const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?").get(refId) as
      | { project_id: string }
      | undefined;
    if (!row) throw new HttpError(400, `issue ref not found: ${refId}`);
    if (row.project_id !== space.project_id) {
      throw new HttpError(400, "issue ref belongs to a different project than the space");
    }
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
  if (row.project_id !== space.project_id) {
    throw new HttpError(400, "comment ref belongs to a different project than the space");
  }
}

// --- unified ref resolver ----------------------------------------------------

type ResolverRefKind = "issue" | "comment" | "artifact" | "mandible" | "repo" | "unknown";

interface ResolverResult {
  ref: string;
  kind: ResolverRefKind;
  resolved: boolean;
  entity: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  error?: string;
}

function resolveUnifiedRef(db: Db, rawRef: string): ResolverResult {
  const ref = rawRef.trim();
  const store = new LedgerStore(db);

  // mandible:// app-route refs (e.g. mandible:///issues?issue=...) — parse the
  // embedded entity ref where present, otherwise report as an app route.
  if (ref.startsWith("mandible://")) {
    return resolveMandibleRef(db, store, ref);
  }

  // repo:// refs are repo-relative artifact/file refs — defer to the artifact
  // resolver, which understands repo-relative custody refs.
  if (ref.startsWith("repo://")) {
    const resolution = resolveArtifactRef(db, ref);
    return {
      ref,
      kind: "repo",
      resolved: resolution.artifact !== null,
      entity: resolution.artifact as Record<string, unknown> | null,
      detail: { resolution },
    };
  }

  // Typed entity prefixes.
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const prefix = ref.slice(0, colon);
    const rest = ref.slice(colon + 1);
    if (prefix === "issue") return resolveIssueRef(store, rest, ref);
    if (prefix === "comment") return resolveCommentRef(db, rest, ref);
    if (prefix === "artifact") return resolveArtifactResult(db, ref);
    if (prefix === "uri" && rest) return resolveArtifactResult(db, rest);
  }

  // Bare artifact hash refs (sha256:...) and any other scheme the artifact
  // resolver supports.
  if (ref.startsWith("sha256:") || ref.includes("://")) {
    return resolveArtifactResult(db, ref);
  }

  // Fall back: try issue ref resolution, then artifact resolution.
  const issue = store.resolveIssueRef(ref);
  if (issue.ok) return resolveIssueRef(store, ref, ref);
  return resolveArtifactResult(db, ref);
}

function resolveMandibleRef(db: Db, store: LedgerStore, ref: string): ResolverResult {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { ref, kind: "mandible", resolved: false, entity: null, error: "invalid mandible ref" };
  }
  const issueParam = url.searchParams.get("issue");
  const requestParam = url.searchParams.get("request");
  const artifactParam = url.searchParams.get("ref");
  if (issueParam) return resolveIssueRef(store, issueParam, ref);
  if (artifactParam) return resolveArtifactResult(db, artifactParam, "mandible", ref);
  return {
    ref,
    kind: "mandible",
    resolved: false,
    entity: null,
    detail: {
      route: url.pathname.replace(/^\/+/, ""),
      params: Object.fromEntries(url.searchParams.entries()),
      ...(requestParam ? { auth_request_id: requestParam } : {}),
    },
  };
}

function resolveIssueRef(store: LedgerStore, refValue: string, ref: string): ResolverResult {
  const resolved = store.resolveIssueRef(refValue.trim());
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
  try {
    const issue = store.getIssue(resolved.id);
    return { ref, kind: "issue", resolved: true, entity: issue as unknown as Record<string, unknown> };
  } catch (error) {
    return { ref, kind: "issue", resolved: false, entity: null, error: String(error) };
  }
}

function resolveCommentRef(db: Db, refValue: string, ref: string): ResolverResult {
  const store = new LedgerStore(db);
  try {
    const comment = store.getComment(refValue.trim());
    return { ref, kind: "comment", resolved: true, entity: comment as unknown as Record<string, unknown> };
  } catch {
    return { ref, kind: "comment", resolved: false, entity: null, error: "comment not found" };
  }
}

function resolveArtifactResult(
  db: Db,
  refValue: string,
  kind: ResolverRefKind = "artifact",
  displayRef?: string,
): ResolverResult {
  // Canonical artifact *ids* are `artifact:sha256:<hash>`, but the artifact
  // resolver's resolvable *ref* form is `artifact:<hash>` / bare `<hash>`.
  // Normalize the id form to the ref form before delegating, and fall back to a
  // direct id lookup so a stored artifact id always resolves.
  const trimmed = refValue.trim();
  const idLookup = getArtifact(db, trimmed);
  if (idLookup) {
    return {
      ref: displayRef ?? refValue,
      kind,
      resolved: true,
      entity: idLookup as unknown as Record<string, unknown>,
    };
  }
  const normalizedRef = trimmed.replace(/^artifact:sha256:/i, "artifact:").replace(/^sha256:/i, "");
  const resolution = resolveArtifactRef(db, normalizedRef);
  return {
    ref: displayRef ?? refValue,
    kind,
    resolved: resolution.artifact !== null,
    entity: resolution.artifact as Record<string, unknown> | null,
    detail: { resolution },
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
      sendJson(res, 200, { resolution: resolveUnifiedRef(getDb(), ref) });
    } catch (error) {
      handleError(res, error);
    }
  };
  router.get("/api/spaces/resolve", resolveHandler);
  router.get("/api/refs/resolve", resolveHandler);

  // --- spaces CRUD ---
  router.get("/api/spaces", (req, res) => {
    try {
      const projectId = queryString(req, "project_id");
      if (!projectId) throw new HttpError(400, "project_id query parameter required");
      sendJson(res, 200, { spaces: listSpaces(getDb(), projectId) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/api/spaces", (req, res) => {
    try {
      const db = getDb();
      const body = bodyRecord(req);
      const projectId = requireString(body, "project_id");
      if (!projectExists(db, projectId)) throw new HttpError(400, "project not found");
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
  });

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
  });

  router.patch("/api/spaces/:id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const space = updateSpace(db, req.params.id, {
        title: optionalString(body, "title") ?? undefined,
        default_renderer: body.default_renderer === undefined
          ? undefined
          : requireRenderer(body.default_renderer, "default_renderer"),
        description: optionalString(body, "description"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_UPDATED, req.params.id);
      sendJson(res, 200, { space });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/api/spaces/:id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      deleteSpace(db, req.params.id);
      emit(SPACE_EVENTS.SPACE_DELETED, req.params.id);
      sendJson(res, 200, { ok: true, id: req.params.id });
    } catch (error) {
      handleError(res, error);
    }
  });

  // --- items ---
  router.post("/api/spaces/:id/items", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const refType = requireRefType(body.ref_type);
      const refId = requireString(body, "ref_id");
      validateItemProjectScope(db, space, refType, refId);
      const result = addSpaceItem(db, space.id, {
        ref_type: refType,
        ref_id: refId,
        ref_uri: optionalString(body, "ref_uri"),
        title: optionalString(body, "title"),
        metadata: optionalMetadata(body),
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
  });

  router.patch("/api/spaces/:id/items/:item_id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      if (!getSpaceItem(db, req.params.id, req.params.item_id)) {
        throw new HttpError(404, "item not found");
      }
      const body = bodyRecord(req);
      const item = updateSpaceItem(db, req.params.id, req.params.item_id, {
        ref_uri: optionalString(body, "ref_uri"),
        title: optionalString(body, "title"),
        metadata: optionalMetadata(body),
      });
      emit(SPACE_EVENTS.SPACE_ITEM_UPDATED, req.params.id);
      sendJson(res, 200, { item });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/api/spaces/:id/items/:item_id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceItem(db, req.params.id, req.params.item_id)) {
        throw new HttpError(404, "item not found");
      }
      emit(SPACE_EVENTS.SPACE_ITEM_REMOVED, req.params.id);
      sendJson(res, 200, { ok: true, id: req.params.item_id });
    } catch (error) {
      handleError(res, error);
    }
  });

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
  });

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
  });

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
  });

  router.delete("/api/spaces/:id/occurrences/:occurrence_id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceOccurrence(db, req.params.id, req.params.occurrence_id)) {
        throw new HttpError(404, "occurrence not found");
      }
      emit(SPACE_EVENTS.SPACE_OCCURRENCE_REMOVED, req.params.id);
      sendJson(res, 200, { ok: true, id: req.params.occurrence_id });
    } catch (error) {
      handleError(res, error);
    }
  });

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
  });

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
  });

  router.delete("/api/spaces/:id/edges/:edge_id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceEdge(db, req.params.id, req.params.edge_id)) {
        throw new HttpError(404, "edge not found");
      }
      emit(SPACE_EVENTS.SPACE_EDGE_REMOVED, req.params.id);
      sendJson(res, 200, { ok: true, id: req.params.edge_id });
    } catch (error) {
      handleError(res, error);
    }
  });

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
  });

  // --- blocks (C11, issue d2a8e77) ---
  // The document/canvas block tree. Block identity (`id`/`parent`/`sort`/`type`/
  // `item`) agrees with the C12 `spaces-doc.v1` serialization; the helper layer
  // (src/ledger/space-blocks.ts) owns sort-key generation, parent-cycle
  // rejection, the snapshot invariant, and detach/degrade. All mutations emit
  // the frozen `space:block:changed` event.
  router.get("/api/spaces/:id/blocks", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      sendJson(res, 200, { blocks: listSpaceBlocks(db, req.params.id) });
    } catch (error) {
      handleError(res, error);
    }
  });

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
  });

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
  });

  router.delete("/api/spaces/:id/blocks/:block_id", (req, res) => {
    try {
      const db = getDb();
      loadSpaceOr404(db, req.params.id);
      if (!deleteSpaceBlock(db, req.params.id, req.params.block_id)) {
        throw new HttpError(404, "block not found");
      }
      emit(SPACE_EVENTS.SPACE_BLOCK_CHANGED, req.params.id);
      sendJson(res, 200, { ok: true, id: req.params.block_id });
    } catch (error) {
      handleError(res, error);
    }
  });

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
  });

  // --- export / custody (C13b, issue 8730bf9) ---
  // The deterministic export-and-track op, untracked export-of-copy, the
  // tracking-row read surface, and the docs-path settings surface. Writes are
  // narrow, non-privileged (agent-key docs-branch commits — never the auth
  // queue), so they stay within the file-transport write boundary (standing
  // AC #1). All emit frozen `space:export:*` / `space:document:*` events.

  // Read the current tracking rows + resolved export settings for a Space.
  router.get("/api/spaces/:id/exports", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const checkout = resolveCheckoutForSpace(db, space, queryString(req, "repo_id") ?? null);
      sendJson(res, 200, {
        exports: listSpaceExportsForSpace(db, space.id),
        repo_id: checkout.id,
        settings: resolveDocsSettings(db, checkout.id, space.id),
      });
    } catch (error) {
      handleExportError(res, error);
    }
  });

  // Export-and-track: the explicit user commit that moves a document into repo
  // custody (creates/refreshes a `space_exports` row + agent-key linked commit).
  router.post("/api/spaces/:id/exports", async (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const result = await exportAndTrack(db, {
        spaceId: space.id,
        repoId: optionalString(body, "repo_id") ?? null,
        path: optionalString(body, "path") ?? null,
        branch: optionalString(body, "branch") ?? null,
        issues: requireIssueRefs(body),
        message: optionalString(body, "message") ?? null,
      });
      broadcastSpaceEvent(SPACE_EVENTS.SPACE_EXPORT_TRACKED, {
        space_id: space.id,
        export_id: result.export.id,
        repo_id: result.export.repo_id,
        branch: result.export.branch,
        path: result.export.path,
        commit: result.commit,
      });
      sendJson(res, 201, result);
    } catch (error) {
      handleExportError(res, error);
    }
  });

  // Untracked export-of-copy: a one-shot local file export with no custody.
  router.post("/api/spaces/:id/exports/untracked", (req, res) => {
    try {
      const db = getDb();
      const space = loadSpaceOr404(db, req.params.id);
      const body = bodyRecord(req);
      const result = exportUntrackedCopy(db, {
        spaceId: space.id,
        destPath: requireString(body, "dest_path"),
        repoId: optionalString(body, "repo_id") ?? null,
      });
      broadcastSpaceEvent(SPACE_EVENTS.SPACE_EXPORT_COPIED, {
        space_id: space.id,
        path: result.path,
        warning: result.warning,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleExportError(res, error);
    }
  });

  // Register/update the docs-path export settings (global default or per-repo
  // override). This is the settings storage backing the export dialog (§5.1).
  router.post("/api/spaces/exports/settings", (req, res) => {
    try {
      const db = getDb();
      const body = bodyRecord(req);
      const repoId = optionalString(body, "repo_id");
      const path = optionalString(body, "path") ?? undefined;
      const branch = optionalString(body, "branch") ?? undefined;
      if (path === undefined && branch === undefined) {
        throw new HttpError(400, "path or branch is required");
      }
      if (typeof repoId === "string" && repoId) {
        setRepoDocsOverride(db, repoId, { path, branch });
      } else {
        setGlobalDocsDefault(db, { path, branch });
      }
      broadcastSpaceEvent(SPACE_EVENTS.SPACE_DOCUMENT_SETTINGS_UPDATED, {
        scope: repoId ? "repo" : "global",
        repo_id: repoId ?? null,
      });
      sendJson(res, 200, { ok: true, scope: repoId ? "repo" : "global", repo_id: repoId ?? null });
    } catch (error) {
      handleExportError(res, error);
    }
  });
}

/** Parse a required non-empty `issues: string[]` (or single `issue`) field. */
function requireIssueRefs(body: Record<string, unknown>): string[] {
  const raw = body.issues ?? body.issue;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const issues = list
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  if (issues.length === 0) {
    throw new HttpError(400, "issues (or issue) is required for a tracked export's linked commit");
  }
  return issues;
}

/** Map an {@link ExportError} machine code to a clean HTTP status. */
function handleExportError(res: ResponseLike, error: unknown): void {
  if (error instanceof ExportError) {
    const status =
      error.code === "space_not_found"
        ? 404
        : error.code === "checkout_not_found"
          ? 404
          : error.code === "worktree_dirty" || error.code === "locked"
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
export function loadSpaceFactPacket(db: Db, id: string): {
  space: SpaceRecord;
  items: ReturnType<typeof listSpaceItems>;
  occurrences: ReturnType<typeof listSpaceOccurrences>;
  edges: ReturnType<typeof listSpaceEdges>;
} | null {
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
