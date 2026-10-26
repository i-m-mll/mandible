import { mutateSpaceRecord } from "../spaces/mutation-history.js";
import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { TimelineDiagnostic, TimelineIssuePredicate } from "../types.js";
import { evaluatePredicate } from "./issue-predicate.js";
import { EMPTY_PROJECT_ISSUE_SET, loadProjectIssueSet } from "./issue-predicate-context.js";
import { parseJsonObject } from "../row-coerce.js";
import type {
  Space,
  SpaceEdge,
  SpaceItem,
  SpaceItemRefType,
  SpaceOccurrence,
  SpaceOccurrenceRenderer,
  SpaceRenderer,
} from "../contracts.js";

/**
 * Spaces data + query helpers (issue f108bba, umbrella de56ffa).
 *
 * This module owns the backend Spaces contract types and all read/write helpers
 * over the "core four" tables (spaces / space_items / space_occurrences /
 * space_edges) introduced by the C1 schema migration (db.ts `spaces_core`). The
 * C2 routes (`src/routes/spaces.ts`) are a thin HTTP shell over these helpers.
 *
 * Contract notes that downstream children depend on (FROZEN):
 * - Record shapes ({@link Space}, {@link SpaceItem},
 *   {@link SpaceOccurrence}, {@link SpaceEdge}) deserialize
 *   `metadata_json` into a `metadata` object; the raw column is never returned.
 * - Membership is idempotent on `UNIQUE(space_id, ref_type, ref_id)`:
 *   {@link addSpaceItem} returns `{ item, created }` and never throws on a repeat.
 * - Project-scoping is enforced in the route layer, not here; these helpers are
 *   pure storage and assume validated input.
 */

interface SpaceRow {
  id: string;
  project_id: string | null;
  title: string;
  default_renderer: SpaceRenderer;
  description: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface SpaceItemRow {
  id: string;
  space_id: string;
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri: string | null;
  title: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface SpaceOccurrenceRow {
  id: string;
  space_id: string;
  item_id: string | null;
  renderer: SpaceOccurrenceRenderer;
  parent_id: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  z_index: number | null;
  sort_key: string | null;
  section_id: string | null;
  note: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface SpaceEdgeRow {
  id: string;
  space_id: string;
  source: string;
  target: string;
  label: string | null;
  style: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}


function serializeMetadata(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a JSON object");
  }
  return JSON.stringify(value);
}

function newId(): string {
  return crypto.randomUUID();
}

function mapSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    default_renderer: row.default_renderer,
    description: row.description,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapItem(row: SpaceItemRow): SpaceItem {
  return {
    id: row.id,
    space_id: row.space_id,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    ref_uri: row.ref_uri,
    title: row.title,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapOccurrence(row: SpaceOccurrenceRow): SpaceOccurrence {
  return {
    id: row.id,
    space_id: row.space_id,
    item_id: row.item_id,
    renderer: row.renderer,
    parent_id: row.parent_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z_index: row.z_index,
    sort_key: row.sort_key,
    section_id: row.section_id,
    note: row.note,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapEdge(row: SpaceEdgeRow): SpaceEdge {
  return {
    id: row.id,
    space_id: row.space_id,
    source: row.source,
    target: row.target,
    label: row.label,
    style: row.style,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- spaces -----------------------------------------------------------------

export interface CreateSpaceInput {
  /** Owning project, or `null`/omitted for a top-level / global Space (issue 812df41). */
  project_id?: string | null;
  title: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export function createSpace(db: Db, input: CreateSpaceInput, now = Date.now()): Space {
  const id = newId();
  return mutateSpaceRecord(db, "spaces", id, id, () => {
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, default_renderer, description, metadata_json, created_at, updated_at)
       VALUES (@id, @project_id, @title, @default_renderer, @description, @metadata_json, @created_at, @updated_at)`,
    ).run({
      id,
      project_id: input.project_id ?? null,
      title: input.title,
      default_renderer: input.default_renderer ?? "canvas",
      description: input.description ?? null,
      metadata_json: serializeMetadata(input.metadata),
      created_at: now,
      updated_at: now,
    });
    return getSpace(db, id)!;
  }, input.project_id);
}

export function getSpace(db: Db, id: string): Space | null {
  const row = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as SpaceRow | undefined;
  return row ? mapSpace(row) : null;
}

/**
 * List the Spaces owned by one project (project_id matches). Top-level Spaces
 * (project_id IS NULL) are NOT returned here; use {@link listTopLevelSpaces} or
 * {@link listSpacesGrouped} for those.
 */
export function listSpaces(db: Db, projectId: string): Space[] {
  const rows = db.prepare(
    "SELECT * FROM spaces WHERE project_id = ? ORDER BY updated_at DESC, id ASC",
  ).all(projectId) as SpaceRow[];
  return rows.map(mapSpace);
}

/** List the top-level / global Spaces (project_id IS NULL, issue 812df41). */
export function listTopLevelSpaces(db: Db): Space[] {
  const rows = db.prepare(
    "SELECT * FROM spaces WHERE project_id IS NULL ORDER BY updated_at DESC, id ASC",
  ).all() as SpaceRow[];
  return rows.map(mapSpace);
}

/** List EVERY Space across all projects plus top-level (issue 812df41). */
export function listAllSpaces(db: Db): Space[] {
  const rows = db.prepare(
    "SELECT * FROM spaces ORDER BY updated_at DESC, id ASC",
  ).all() as SpaceRow[];
  return rows.map(mapSpace);
}

/** One group of Spaces in the grouped list: a project (with id) or the top-level bucket. */
export interface SpaceGroup {
  /** Owning project id, or `null` for the top-level / global group. */
  project_id: string | null;
  /**
   * Stable registry slug from `ledger_projects.project_key`, or `null` for the
   * top-level group and for project rows whose key is empty/unresolvable.
   */
  project_key: string | null;
  /** Project display name (already disambiguated when colliding), or `null` for the top-level group. */
  project_name: string | null;
  spaces: Space[];
}

/**
 * Grouped Spaces list for the home view (issue 812df41, 6fdd924): every Space
 * across all projects, partitioned into one group per owning project plus a
 * single top-level group (`project_id: null`). The top-level group sorts FIRST
 * (when non-empty); project groups follow for ONLY projects that own at least
 * one Space (empty projects are suppressed — issue 6fdd924). Within each group,
 * Spaces keep the canonical updated_at DESC, id ASC order.
 *
 * Each group carries the canonical `project_key` from `ledger_projects`. When
 * two distinct project rows share the same `display_name`, their `project_name`
 * is disambiguated by appending `(project_key)` so headings stay distinguishable.
 */
export function listSpacesGrouped(db: Db): SpaceGroup[] {
  const all = listAllSpaces(db);
  const projectRows = db
    .prepare("SELECT id, project_key, display_name FROM ledger_projects")
    .all() as Array<{ id: string; project_key: string; display_name: string | null }>;

  const topLevel: Space[] = [];
  const byProject = new Map<string, Space[]>();
  // Do NOT pre-populate every project — only emit groups that own at least one Space.
  // (Empty-project headers caused duplicate/empty headings in the sidebar, issue 6fdd924.)
  for (const space of all) {
    if (space.project_id === null) {
      topLevel.push(space);
    } else {
      const list = byProject.get(space.project_id) ?? [];
      list.push(space);
      byProject.set(space.project_id, list);
    }
  }

  // Build a lookup for project metadata keyed by project id.
  const projectById = new Map<
    string,
    { project_key: string; display_name: string | null }
  >();
  for (const row of projectRows) {
    projectById.set(row.id, { project_key: row.project_key, display_name: row.display_name });
  }

  // Count how many distinct project rows share the same display_name so we can
  // append the project_key as a disambiguation suffix for colliding names.
  const displayNameCount = new Map<string, number>();
  for (const row of projectRows) {
    const name = row.display_name ?? "";
    displayNameCount.set(name, (displayNameCount.get(name) ?? 0) + 1);
  }

  const groups: SpaceGroup[] = [];
  if (topLevel.length > 0) {
    groups.push({ project_id: null, project_key: null, project_name: null, spaces: topLevel });
  }
  const projectGroups = Array.from(byProject.entries()).map(([projectId, spaces]) => {
    const info = projectById.get(projectId);
    const displayName = info?.display_name ?? null;
    // Treat empty string project_key (unbackfilled rows) as null.
    const projectKey: string | null = info?.project_key || null;
    // Disambiguate: when multiple rows share the same display_name, append the
    // project_key (or a short id suffix when key is absent) to tell them apart.
    const nameCollides =
      displayName !== null && (displayNameCount.get(displayName) ?? 0) > 1;
    const disambigSuffix = projectKey ?? projectId.slice(0, 8);
    const project_name = nameCollides ? `${displayName} (${disambigSuffix})` : displayName;
    return {
      project_id: projectId,
      project_key: projectKey,
      project_name,
      spaces,
    };
  });
  projectGroups.sort((a, b) => {
    const an = a.project_name ?? "";
    const bn = b.project_name ?? "";
    if (an !== bn) return an < bn ? -1 : 1;
    return a.project_id! < b.project_id! ? -1 : a.project_id! > b.project_id! ? 1 : 0;
  });
  groups.push(...projectGroups);
  return groups;
}

export interface UpdateSpaceInput {
  title?: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export function updateSpace(
  db: Db,
  id: string,
  input: UpdateSpaceInput,
  now = Date.now(),
): Space | null {
  return mutateSpaceRecord(db, "spaces", id, id, () => {
    const existing = getSpace(db, id);
    if (!existing) return null;
    db.prepare(
      `UPDATE spaces
          SET title = @title,
              default_renderer = @default_renderer,
              description = @description,
              metadata_json = @metadata_json,
              updated_at = @updated_at
        WHERE id = @id`,
    ).run({
      id,
      title: input.title ?? existing.title,
      default_renderer: input.default_renderer ?? existing.default_renderer,
      description: input.description === undefined ? existing.description : input.description,
      metadata_json: serializeMetadata(input.metadata ?? existing.metadata),
      updated_at: now,
    });
    return getSpace(db, id);
  });
}

export function deleteSpace(db: Db, id: string): boolean {
  return mutateSpaceRecord(db, "spaces", id, id, () => {
    const result = db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    return result.changes > 0;
  });
}

// --- items ------------------------------------------------------------------

export interface AddSpaceItemInput {
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AddSpaceItemResult {
  item: SpaceItem;
  created: boolean;
}

export function getSpaceItem(db: Db, spaceId: string, itemId: string): SpaceItem | null {
  const row = db.prepare(
    "SELECT * FROM space_items WHERE space_id = ? AND id = ?",
  ).get(spaceId, itemId) as SpaceItemRow | undefined;
  return row ? mapItem(row) : null;
}

function findSpaceItemByRef(
  db: Db,
  spaceId: string,
  refType: SpaceItemRefType,
  refId: string,
): SpaceItem | null {
  const row = db.prepare(
    "SELECT * FROM space_items WHERE space_id = ? AND ref_type = ? AND ref_id = ?",
  ).get(spaceId, refType, refId) as SpaceItemRow | undefined;
  return row ? mapItem(row) : null;
}

export function listSpaceItems(db: Db, spaceId: string): SpaceItem[] {
  const rows = db.prepare(
    "SELECT * FROM space_items WHERE space_id = ? ORDER BY created_at ASC, id ASC",
  ).all(spaceId) as SpaceItemRow[];
  return rows.map(mapItem);
}

/**
 * Add an item to a Space. Idempotent on `UNIQUE(space_id, ref_type, ref_id)`:
 * a repeated add returns the existing row with `created: false` ("already
 * present") rather than failing.
 */
export function addSpaceItem(
  db: Db,
  spaceId: string,
  input: AddSpaceItemInput,
  now = Date.now(),
): AddSpaceItemResult {
  const existing = findSpaceItemByRef(db, spaceId, input.ref_type, input.ref_id);
  if (existing) {
    return { item: existing, created: false };
  }
  const id = newId();
  return mutateSpaceRecord(db, "space_items", id, spaceId, () => {
    db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, ref_uri, title, metadata_json, created_at, updated_at)
       VALUES (@id, @space_id, @ref_type, @ref_id, @ref_uri, @title, @metadata_json, @created_at, @updated_at)`,
    ).run({
      id,
      space_id: spaceId,
      ref_type: input.ref_type,
      ref_id: input.ref_id,
      ref_uri: input.ref_uri ?? null,
      title: input.title ?? null,
      metadata_json: serializeMetadata(input.metadata),
      created_at: now,
      updated_at: now,
    });
    return { item: getSpaceItem(db, spaceId, id)!, created: true };
  });
}

export interface UpdateSpaceItemInput {
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export function updateSpaceItem(
  db: Db,
  spaceId: string,
  itemId: string,
  input: UpdateSpaceItemInput,
  now = Date.now(),
): SpaceItem | null {
  return mutateSpaceRecord(db, "space_items", itemId, spaceId, () => {
    const existing = getSpaceItem(db, spaceId, itemId);
    if (!existing) return null;
    db.prepare(
      `UPDATE space_items
          SET ref_uri = @ref_uri,
              title = @title,
              metadata_json = @metadata_json,
              updated_at = @updated_at
        WHERE space_id = @space_id AND id = @id`,
    ).run({
      space_id: spaceId,
      id: itemId,
      ref_uri: input.ref_uri === undefined ? existing.ref_uri : input.ref_uri,
      title: input.title === undefined ? existing.title : input.title,
      metadata_json: serializeMetadata(input.metadata ?? existing.metadata),
      updated_at: now,
    });
    return getSpaceItem(db, spaceId, itemId);
  });
}

export function deleteSpaceItem(db: Db, spaceId: string, itemId: string): boolean {
  return mutateSpaceRecord(db, "space_items", itemId, spaceId, () => {
    const result = db.prepare(
      "DELETE FROM space_items WHERE space_id = ? AND id = ?",
    ).run(spaceId, itemId);
    return result.changes > 0;
  });
}

// --- occurrences ------------------------------------------------------------

export interface OccurrenceInput {
  id?: string;
  item_id?: string | null;
  renderer?: SpaceOccurrenceRenderer;
  parent_id?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  z_index?: number | null;
  sort_key?: string | null;
  section_id?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export function getSpaceOccurrence(
  db: Db,
  spaceId: string,
  occurrenceId: string,
): SpaceOccurrence | null {
  const row = db.prepare(
    "SELECT * FROM space_occurrences WHERE space_id = ? AND id = ?",
  ).get(spaceId, occurrenceId) as SpaceOccurrenceRow | undefined;
  return row ? mapOccurrence(row) : null;
}

export function listSpaceOccurrences(db: Db, spaceId: string): SpaceOccurrence[] {
  const rows = db.prepare(
    "SELECT * FROM space_occurrences WHERE space_id = ? ORDER BY sort_key ASC, created_at ASC, id ASC",
  ).all(spaceId) as SpaceOccurrenceRow[];
  return rows.map(mapOccurrence);
}

export function createSpaceOccurrence(
  db: Db,
  spaceId: string,
  input: OccurrenceInput,
  now = Date.now(),
): SpaceOccurrence {
  const id = input.id ?? newId();
  return mutateSpaceRecord(db, "space_occurrences", id, spaceId, () => {
    db.prepare(
      `INSERT INTO space_occurrences (
         id, space_id, item_id, renderer, parent_id, x, y, width, height,
         z_index, sort_key, section_id, note, metadata_json, created_at, updated_at
       ) VALUES (
         @id, @space_id, @item_id, @renderer, @parent_id, @x, @y, @width, @height,
         @z_index, @sort_key, @section_id, @note, @metadata_json, @created_at, @updated_at
       )`,
    ).run({
      id,
      space_id: spaceId,
      item_id: input.item_id ?? null,
      renderer: input.renderer ?? "canvas",
      parent_id: input.parent_id ?? null,
      x: input.x ?? null,
      y: input.y ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      z_index: input.z_index ?? null,
      sort_key: input.sort_key ?? null,
      section_id: input.section_id ?? null,
      note: input.note ?? null,
      metadata_json: serializeMetadata(input.metadata),
      created_at: now,
      updated_at: now,
    });
    return getSpaceOccurrence(db, spaceId, id)!;
  });
}

export interface UpdateOccurrenceInput {
  item_id?: string | null;
  renderer?: SpaceOccurrenceRenderer;
  parent_id?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  z_index?: number | null;
  sort_key?: string | null;
  section_id?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

function applyOccurrenceUpdate(
  db: Db,
  spaceId: string,
  occurrenceId: string,
  input: UpdateOccurrenceInput,
  now: number,
): SpaceOccurrence | null {
  return mutateSpaceRecord(db, "space_occurrences", occurrenceId, spaceId, () => {
    const existing = getSpaceOccurrence(db, spaceId, occurrenceId);
    if (!existing) return null;
    const pick = <K extends keyof UpdateOccurrenceInput>(
      key: K,
      fallback: SpaceOccurrence[K & keyof SpaceOccurrence],
    ) => (input[key] === undefined ? fallback : input[key]);
    db.prepare(
      `UPDATE space_occurrences
          SET item_id = @item_id,
              renderer = @renderer,
              parent_id = @parent_id,
              x = @x,
              y = @y,
              width = @width,
              height = @height,
              z_index = @z_index,
              sort_key = @sort_key,
              section_id = @section_id,
              note = @note,
              metadata_json = @metadata_json,
              updated_at = @updated_at
        WHERE space_id = @space_id AND id = @id`,
    ).run({
      space_id: spaceId,
      id: occurrenceId,
      item_id: pick("item_id", existing.item_id),
      renderer: pick("renderer", existing.renderer),
      parent_id: pick("parent_id", existing.parent_id),
      x: pick("x", existing.x),
      y: pick("y", existing.y),
      width: pick("width", existing.width),
      height: pick("height", existing.height),
      z_index: pick("z_index", existing.z_index),
      sort_key: pick("sort_key", existing.sort_key),
      section_id: pick("section_id", existing.section_id),
      note: pick("note", existing.note),
      metadata_json: serializeMetadata(input.metadata ?? existing.metadata),
      updated_at: now,
    });
    return getSpaceOccurrence(db, spaceId, occurrenceId);
  });
}

export function updateSpaceOccurrence(
  db: Db,
  spaceId: string,
  occurrenceId: string,
  input: UpdateOccurrenceInput,
  now = Date.now(),
): SpaceOccurrence | null {
  return applyOccurrenceUpdate(db, spaceId, occurrenceId, input, now);
}

export function deleteSpaceOccurrence(db: Db, spaceId: string, occurrenceId: string): boolean {
  return mutateSpaceRecord(db, "space_occurrences", occurrenceId, spaceId, () => {
    const result = db.prepare(
      "DELETE FROM space_occurrences WHERE space_id = ? AND id = ?",
    ).run(spaceId, occurrenceId);
    return result.changes > 0;
  });
}

export interface BatchOccurrenceEntry extends UpdateOccurrenceInput {
  id?: string;
}

export interface BatchOccurrenceResult {
  occurrences: SpaceOccurrence[];
  created: number;
  updated: number;
}

/**
 * Write N occurrence positions in a single transaction. Entries with an `id`
 * matching an existing occurrence are updated; entries without (or with an
 * unknown id) are created. Used for drag persistence / re-layout / seed.
 */
export function batchWriteOccurrences(
  db: Db,
  spaceId: string,
  entries: BatchOccurrenceEntry[],
  now = Date.now(),
): BatchOccurrenceResult {
  const run = db.transaction((items: BatchOccurrenceEntry[]): BatchOccurrenceResult => {
    const occurrences: SpaceOccurrence[] = [];
    let created = 0;
    let updated = 0;
    for (const entry of items) {
      const { id, ...rest } = entry;
      const existing = id ? getSpaceOccurrence(db, spaceId, id) : null;
      if (existing) {
        const result = applyOccurrenceUpdate(db, spaceId, existing.id, rest, now);
        if (result) {
          occurrences.push(result);
          updated += 1;
        }
      } else {
        const result = createSpaceOccurrence(db, spaceId, { id, ...rest }, now);
        occurrences.push(result);
        created += 1;
      }
    }
    return { occurrences, created, updated };
  });
  return run(entries);
}

// --- edges ------------------------------------------------------------------

export interface CreateEdgeInput {
  source: string;
  target: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
}

export function getSpaceEdge(db: Db, spaceId: string, edgeId: string): SpaceEdge | null {
  const row = db.prepare(
    "SELECT * FROM space_edges WHERE space_id = ? AND id = ?",
  ).get(spaceId, edgeId) as SpaceEdgeRow | undefined;
  return row ? mapEdge(row) : null;
}

export function listSpaceEdges(db: Db, spaceId: string): SpaceEdge[] {
  const rows = db.prepare(
    "SELECT * FROM space_edges WHERE space_id = ? ORDER BY created_at ASC, id ASC",
  ).all(spaceId) as SpaceEdgeRow[];
  return rows.map(mapEdge);
}

export function createSpaceEdge(
  db: Db,
  spaceId: string,
  input: CreateEdgeInput,
  now = Date.now(),
): SpaceEdge {
  const id = newId();
  return mutateSpaceRecord(db, "space_edges", id, spaceId, () => {
    db.prepare(
      `INSERT INTO space_edges (id, space_id, source, target, label, style, metadata_json, created_at, updated_at)
       VALUES (@id, @space_id, @source, @target, @label, @style, @metadata_json, @created_at, @updated_at)`,
    ).run({
      id,
      space_id: spaceId,
      source: input.source,
      target: input.target,
      label: input.label ?? null,
      style: input.style ?? null,
      metadata_json: serializeMetadata(input.metadata),
      created_at: now,
      updated_at: now,
    });
    return getSpaceEdge(db, spaceId, id)!;
  });
}

export interface UpdateEdgeInput {
  source?: string;
  target?: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
}

export function updateSpaceEdge(
  db: Db,
  spaceId: string,
  edgeId: string,
  input: UpdateEdgeInput,
  now = Date.now(),
): SpaceEdge | null {
  return mutateSpaceRecord(db, "space_edges", edgeId, spaceId, () => {
    const existing = getSpaceEdge(db, spaceId, edgeId);
    if (!existing) return null;
    db.prepare(
      `UPDATE space_edges
          SET source = @source,
              target = @target,
              label = @label,
              style = @style,
              metadata_json = @metadata_json,
              updated_at = @updated_at
        WHERE space_id = @space_id AND id = @id`,
    ).run({
      space_id: spaceId,
      id: edgeId,
      source: input.source ?? existing.source,
      target: input.target ?? existing.target,
      label: input.label === undefined ? existing.label : input.label,
      style: input.style === undefined ? existing.style : input.style,
      metadata_json: serializeMetadata(input.metadata ?? existing.metadata),
      updated_at: now,
    });
    return getSpaceEdge(db, spaceId, edgeId);
  });
}

export function deleteSpaceEdge(db: Db, spaceId: string, edgeId: string): boolean {
  return mutateSpaceRecord(db, "space_edges", edgeId, spaceId, () => {
    const result = db.prepare(
      "DELETE FROM space_edges WHERE space_id = ? AND id = ?",
    ).run(spaceId, edgeId);
    return result.changes > 0;
  });
}

// --- seed-from-filter -------------------------------------------------------

interface IssueArtifactRow {
  issue_id: string;
  target_id: string;
}

function loadArtifactsForIssues(db: Db, issueIds: string[]): Map<string, string[]> {
  const byIssue = new Map<string, string[]>();
  if (issueIds.length === 0) return byIssue;
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT entity_id AS issue_id, target_id
       FROM artifact_links
      WHERE entity_type = 'issue' AND entity_id IN (${placeholders})
      ORDER BY target_id ASC`,
  ).all(...issueIds) as IssueArtifactRow[];
  for (const row of rows) {
    const list = byIssue.get(row.issue_id) ?? [];
    if (!list.includes(row.target_id)) list.push(row.target_id);
    byIssue.set(row.issue_id, list);
  }
  return byIssue;
}

export interface SeedSpaceInput {
  predicate: TimelineIssuePredicate;
  /** When true, also create a shelf occurrence (no x/y) per seeded item. */
  with_shelf_occurrences?: boolean;
  /** When true, include artifacts linked to matched issues as items. Default true. */
  include_artifacts?: boolean;
}

export interface SeedSpaceResult {
  matched_issue_ids: string[];
  items: SpaceItem[];
  items_created: number;
  items_existing: number;
  occurrences: SpaceOccurrence[];
  diagnostics: TimelineDiagnostic[];
}

/**
 * Seed a Space's membership from a shared issue-predicate (the same AST the
 * Timeline uses), evaluated backend-side via the C7a-extracted evaluator against
 * the Space's project issues and (optionally) their linked artifacts.
 *
 * Deterministic and idempotent: matched issues are ordered canonically and each
 * `space_items` write goes through {@link addSpaceItem}, so re-running the same
 * seed adds nothing new and reports the items as already present. The whole seed
 * runs in one transaction.
 */
export function seedSpaceFromPredicate(
  db: Db,
  space: Space,
  input: SeedSpaceInput,
  now = Date.now(),
): SeedSpaceResult {
  // A top-level Space (project_id IS NULL) owns no project issue set, so seeding
  // from a project predicate yields no matches.
  const issueSet = space.project_id === null ? EMPTY_PROJECT_ISSUE_SET : loadProjectIssueSet(db, space.project_id);
  const { issueById } = issueSet;
  const diagnostics: TimelineDiagnostic[] = [];

  const matchedSet = evaluatePredicate(
    input.predicate,
    {
      allIssues: issueSet.issues,
      issueById,
      references: issueSet.references,
      parentChildren: issueSet.parentChildren,
      residualCoveredIssueIds: new Set<string>(),
      labelHistory: issueSet.labelHistory,
      window: { from: null, to: null },
      // Seed is a point-in-time snapshot: force "now" membership for determinism.
      labelMembershipModeOverride: "now",
    },
    "space-seed",
    diagnostics,
  );

  const matchedIssueIds = Array.from(matchedSet)
    .filter((id) => {
      const issue = issueById.get(id);
      return !!issue && issue.deleted_at === null;
    })
    .sort();

  const includeArtifacts = input.include_artifacts !== false;
  const artifactsByIssue = includeArtifacts
    ? loadArtifactsForIssues(db, matchedIssueIds)
    : new Map<string, string[]>();

  const run = db.transaction((): SeedSpaceResult => {
    const items: SpaceItem[] = [];
    const occurrences: SpaceOccurrence[] = [];
    let created = 0;
    let existing = 0;

    const addItem = (add: AddSpaceItemInput) => {
      const result = addSpaceItem(db, space.id, add, now);
      items.push(result.item);
      if (result.created) created += 1;
      else existing += 1;
      if (input.with_shelf_occurrences) {
        occurrences.push(createSpaceOccurrence(db, space.id, {
          item_id: result.item.id,
          renderer: "collection",
        }, now));
      }
    };

    for (const issueId of matchedIssueIds) {
      const issue = issueById.get(issueId)!;
      addItem({ ref_type: "issue", ref_id: issueId, title: issue.title });
      for (const artifactId of artifactsByIssue.get(issueId) ?? []) {
        addItem({ ref_type: "artifact", ref_id: artifactId });
      }
    }

    return {
      matched_issue_ids: matchedIssueIds,
      items,
      items_created: created,
      items_existing: existing,
      occurrences,
      diagnostics,
    };
  });

  return run();
}
