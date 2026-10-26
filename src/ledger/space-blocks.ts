import { mutateSpaceRecord } from "../spaces/mutation-history.js";
import crypto from "node:crypto";
import type { Db } from "../db.js";
import {
  BLOCK_TYPES,
  EMBED_BLOCK_TYPES,
  type BlockType,
  type DocBlock,
} from "../spaces/serialize.js";
import { parseJsonObject } from "../row-coerce.js";

/**
 * `space_blocks` data + logic helpers (issue d2a8e77, umbrella de56ffa).
 *
 * This module owns the backend block contract: record shapes, sort-key
 * generation/normalization, parent-cycle validation, and the detach/degrade
 * operation for an item that is embedded in a block. The `/api/spaces/:id/blocks*`
 * routes (in `src/routes/spaces.ts`) are a thin HTTP shell over these helpers.
 *
 * Block identity is FROZEN by the C12 serialization (`src/spaces/serialize.ts`):
 * the round-tripped fields (`id`, `parent_id`, `block_type`, `item_id`,
 * `sort_key`, `markdown`) are exactly the C12 {@link DocBlock} fields, and the
 * {@link BLOCK_TYPES} / {@link EMBED_BLOCK_TYPES} sets are imported from there so
 * the schema CHECK and the serializer can never drift. {@link toDocBlock}
 * projects a stored row onto the C12 view for round-tripping.
 */

export { BLOCK_TYPES, EMBED_BLOCK_TYPES, type BlockType };

/**
 * A snapshot of the embedded item, captured at embed time. This is the
 * placeholder that survives a RESTRICTed item deletion: the `item_id` FK is
 * dropped on detach, but the snapshot preserves what the block pointed at.
 */
export interface BlockItemSnapshot {
  /** The `space_items.id` the block embedded (preserved after detach). */
  item_id?: string;
  ref_type?: string;
  ref_id?: string;
  ref_uri?: string | null;
  title?: string | null;
  [key: string]: unknown;
}

export interface SpaceBlockRecord {
  id: string;
  space_id: string;
  parent_id: string | null;
  block_type: BlockType;
  item_id: string | null;
  item_snapshot: BlockItemSnapshot | null;
  sort_key: string;
  markdown: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

interface SpaceBlockRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  block_type: BlockType;
  item_id: string | null;
  item_snapshot_json: string | null;
  sort_key: string;
  markdown: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}


function parseSnapshot(value: string | null | undefined): BlockItemSnapshot | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as BlockItemSnapshot)
      : null;
  } catch {
    return null;
  }
}

function serializeObject(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a JSON object");
  }
  return JSON.stringify(value);
}

function serializeSnapshot(value: BlockItemSnapshot | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("item_snapshot must be a JSON object");
  }
  return JSON.stringify(value);
}

function newId(): string {
  return crypto.randomUUID();
}

function mapBlock(row: SpaceBlockRow): SpaceBlockRecord {
  return {
    id: row.id,
    space_id: row.space_id,
    parent_id: row.parent_id,
    block_type: row.block_type,
    item_id: row.item_id,
    item_snapshot: parseSnapshot(row.item_snapshot_json),
    sort_key: row.sort_key,
    markdown: row.markdown,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Project a stored block onto the C12 {@link DocBlock} round-trip view. */
export function toDocBlock(block: SpaceBlockRecord): DocBlock {
  return {
    id: block.id,
    parent_id: block.parent_id,
    block_type: block.block_type,
    item_id: block.item_id,
    sort_key: block.sort_key,
    markdown: block.markdown,
  };
}

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

export function isEmbedBlockType(value: BlockType): boolean {
  return EMBED_BLOCK_TYPES.has(value);
}

// --- sort-key generation / normalization ------------------------------------

/**
 * Sort keys are lexicographic strings over a fixed base-36 alphabet (`0-9a-z`).
 * They order siblings within a parent. {@link generateSortKey} produces a key
 * strictly between two existing keys (or at the start/end of a sibling list);
 * {@link normalizeSortKeys} re-spaces a whole sibling list onto evenly padded
 * keys so insertions never run out of headroom. Both are deterministic.
 */
const SORT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SORT_BASE = SORT_ALPHABET.length;
const MIN_DIGIT = SORT_ALPHABET[0];

function digitValue(ch: string): number {
  const idx = SORT_ALPHABET.indexOf(ch);
  return idx < 0 ? 0 : idx;
}

/**
 * A key strictly between `before` and `after` in lexicographic order. Pass null
 * for an open end (start or end of the list). Deterministic for a given pair.
 *
 * Digit-by-digit midpoint: walk shared positions; when the low/high digits
 * differ by more than one there is an integer digit strictly between them, so
 * emit it and stop. When they are equal or adjacent, copy the low digit (or the
 * minimum digit when the low side is exhausted) and continue deeper — the high
 * bound stops constraining positions past its own length. The loop always
 * terminates because each step either returns or extends the prefix toward the
 * (strictly larger) high bound.
 */
export function generateSortKey(before: string | null, after: string | null): string {
  const lo = before ?? "";
  const hi = after ?? "";
  if (lo && hi && lo >= hi) {
    throw new Error(`sort-key bounds out of order: ${JSON.stringify({ before, after })}`);
  }

  let prefix = "";
  let i = 0;
  for (;;) {
    const loDigit = i < lo.length ? digitValue(lo[i]) : 0;
    const hiBounded = i < hi.length;
    const hiDigit = hiBounded ? digitValue(hi[i]) : SORT_BASE;

    if (hiDigit - loDigit > 1) {
      // An integer digit sits strictly between the two at this position.
      const mid = Math.floor((loDigit + hiDigit) / 2);
      return prefix + SORT_ALPHABET[mid];
    }

    if (!hiBounded) {
      // The high bound is exhausted but the low side is still tracking it (no gap
      // found). Anything appended after copying lo's digit is < the open high
      // end, so emit lo's digit then a mid digit and stop.
      prefix += SORT_ALPHABET[loDigit];
      return prefix + SORT_ALPHABET[Math.floor(SORT_BASE / 2)];
    }

    if (loDigit === hiDigit) {
      // Shared digit: copy it and keep BOTH bounds active one level deeper.
      prefix += SORT_ALPHABET[loDigit];
      i += 1;
      continue;
    }

    // Adjacent digits (hiDigit === loDigit + 1): descend on the LOW side. Copy
    // lo's digit; from here the high bound no longer constrains (any tail keeps
    // us below hi's larger digit), so continue against an open top end.
    prefix += SORT_ALPHABET[loDigit];
    return prefix + generateSortKey(lo.slice(i + 1), null);
  }
}

/**
 * Re-space a sibling list onto evenly distributed, fixed-width keys. Input order
 * is preserved (callers sort first); output keys are strictly increasing and
 * deterministic for a given length. Use when {@link generateSortKey} headroom is
 * exhausted or to canonicalize externally-supplied keys.
 */
export function normalizeSortKeys(count: number): string[] {
  if (count <= 0) return [];
  // Width grows with count so keys stay evenly spaced and strictly increasing.
  const width = Math.max(2, Math.ceil(Math.log(count + 1) / Math.log(SORT_BASE)) + 1);
  const span = SORT_BASE ** width;
  const step = Math.max(1, Math.floor(span / (count + 1)));
  const keys: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    keys.push(encodeBase36(step * n, width));
  }
  return keys;
}

function encodeBase36(value: number, width: number): string {
  let v = Math.max(0, Math.floor(value));
  let out = "";
  while (v > 0) {
    out = SORT_ALPHABET[v % SORT_BASE] + out;
    v = Math.floor(v / SORT_BASE);
  }
  return out.padStart(width, MIN_DIGIT).slice(-width);
}

/** Validate that a candidate sort key is a non-empty base-36 string. */
export function isValidSortKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].every((ch) => SORT_ALPHABET.includes(ch))
  );
}

/**
 * Next sort key appended after the current last sibling under `parentId`
 * (or the first key if there are no siblings). Deterministic given DB state.
 */
export function nextSiblingSortKey(db: Db, spaceId: string, parentId: string | null): string {
  const row = db
    .prepare(
      `SELECT sort_key FROM space_blocks
        WHERE space_id = ? AND parent_id IS ?
        ORDER BY sort_key DESC, id DESC
        LIMIT 1`,
    )
    .get(spaceId, parentId) as { sort_key: string } | undefined;
  return generateSortKey(row?.sort_key ?? null, null);
}

// --- reads ------------------------------------------------------------------

export function getSpaceBlock(db: Db, spaceId: string, blockId: string): SpaceBlockRecord | null {
  const row = db
    .prepare("SELECT * FROM space_blocks WHERE space_id = ? AND id = ?")
    .get(spaceId, blockId) as SpaceBlockRow | undefined;
  return row ? mapBlock(row) : null;
}

/**
 * List a Space's blocks in canonical document order: depth-first by tree,
 * siblings ordered by `sort_key` then `id`. Matches the C12 serializer's
 * {@link orderBlocks} contract so list output round-trips through export/import.
 */
export function listSpaceBlocks(db: Db, spaceId: string): SpaceBlockRecord[] {
  const rows = db
    .prepare("SELECT * FROM space_blocks WHERE space_id = ? ORDER BY sort_key ASC, id ASC")
    .all(spaceId) as SpaceBlockRow[];
  const blocks = rows.map(mapBlock);
  return orderBlocksDepthFirst(blocks);
}

function orderBlocksDepthFirst(blocks: SpaceBlockRecord[]): SpaceBlockRecord[] {
  const byParent = new Map<string | null, SpaceBlockRecord[]>();
  for (const block of blocks) {
    const arr = byParent.get(block.parent_id) ?? [];
    arr.push(block);
    byParent.set(block.parent_id, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) =>
      a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
  const ordered: SpaceBlockRecord[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null): void => {
    for (const block of byParent.get(parentId) ?? []) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      ordered.push(block);
      visit(block.id);
    }
  };
  visit(null);
  // Defensive: any block not reached (orphan parent) is emitted at the end.
  for (const block of blocks) {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      ordered.push(block);
    }
  }
  return ordered;
}

// --- parent-cycle validation ------------------------------------------------

export class BlockValidationError extends Error {}

/**
 * Reject a `parent_id` assignment that would create a cycle (a block becoming
 * its own ancestor) or point at a missing/cross-space parent. Walks up the
 * existing parent chain from `parentId`; if it reaches `blockId` (or itself on a
 * self-parent) the assignment is rejected.
 */
export function assertNoParentCycle(
  db: Db,
  spaceId: string,
  blockId: string,
  parentId: string | null,
): void {
  if (parentId === null) return;
  if (parentId === blockId) {
    throw new BlockValidationError("a block cannot be its own parent");
  }
  const stmt = db.prepare(
    "SELECT parent_id FROM space_blocks WHERE space_id = ? AND id = ?",
  );
  let cursor: string | null = parentId;
  const visited = new Set<string>();
  while (cursor !== null) {
    if (cursor === blockId) {
      throw new BlockValidationError("parent assignment would create a block cycle");
    }
    if (visited.has(cursor)) {
      // Pre-existing cycle in stored data; stop walking rather than loop forever.
      throw new BlockValidationError("parent assignment would create a block cycle");
    }
    visited.add(cursor);
    const row = stmt.get(spaceId, cursor) as { parent_id: string | null } | undefined;
    if (!row) {
      throw new BlockValidationError(`parent block not found in space: ${cursor}`);
    }
    cursor = row.parent_id;
  }
}

// --- writes -----------------------------------------------------------------

export interface CreateBlockInput {
  id?: string;
  parent_id?: string | null;
  block_type: BlockType;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Create a block. Enforces (in the helper layer, on top of the DB CHECKs):
 *   - a valid C12 `block_type`,
 *   - the snapshot invariant: an `item_id` REQUIRES an `item_snapshot`,
 *   - no parent cycle / missing parent,
 *   - a deterministic sort key when none is supplied.
 */
export function createSpaceBlock(
  db: Db,
  spaceId: string,
  input: CreateBlockInput,
  now = Date.now(),
): SpaceBlockRecord {
  if (!isBlockType(input.block_type)) {
    throw new BlockValidationError(`invalid block_type: ${String(input.block_type)}`);
  }
  const id = input.id ?? newId();
  return mutateSpaceRecord(db, "space_blocks", id, spaceId, () => {
    const parentId = input.parent_id ?? null;
    if (parentId !== null) {
      assertNoParentCycle(db, spaceId, id, parentId);
    }
    const itemId = input.item_id ?? null;
    const snapshot = input.item_snapshot ?? null;
    if (itemId !== null && snapshot === null) {
      throw new BlockValidationError("assigning item_id requires item_snapshot");
    }
    const sortKey =
      input.sort_key && isValidSortKey(input.sort_key)
        ? input.sort_key
        : nextSiblingSortKey(db, spaceId, parentId);

    db.prepare(
      `INSERT INTO space_blocks (
         id, space_id, parent_id, block_type, item_id, item_snapshot_json,
         sort_key, markdown, metadata_json, created_at, updated_at
       ) VALUES (
         @id, @space_id, @parent_id, @block_type, @item_id, @item_snapshot_json,
         @sort_key, @markdown, @metadata_json, @created_at, @updated_at
       )`,
    ).run({
      id,
      space_id: spaceId,
      parent_id: parentId,
      block_type: input.block_type,
      item_id: itemId,
      item_snapshot_json: serializeSnapshot(snapshot),
      sort_key: sortKey,
      markdown: input.markdown ?? "",
      metadata_json: serializeObject(input.metadata),
      created_at: now,
      updated_at: now,
    });
    return getSpaceBlock(db, spaceId, id)!;
  });
}

export interface UpdateBlockInput {
  parent_id?: string | null;
  block_type?: BlockType;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
}

export function updateSpaceBlock(
  db: Db,
  spaceId: string,
  blockId: string,
  input: UpdateBlockInput,
  now = Date.now(),
): SpaceBlockRecord | null {
  return mutateSpaceRecord(db, "space_blocks", blockId, spaceId, () => {
    const existing = getSpaceBlock(db, spaceId, blockId);
    if (!existing) return null;

    if (input.block_type !== undefined && !isBlockType(input.block_type)) {
      throw new BlockValidationError(`invalid block_type: ${String(input.block_type)}`);
    }
    const parentId = input.parent_id === undefined ? existing.parent_id : input.parent_id;
    if (parentId !== null) {
      assertNoParentCycle(db, spaceId, blockId, parentId);
    }

    const itemId = input.item_id === undefined ? existing.item_id : input.item_id;
    // Resolve the snapshot after the item_id, then enforce the invariant.
    let snapshot: BlockItemSnapshot | null;
    if (input.item_snapshot !== undefined) {
      snapshot = input.item_snapshot;
    } else if (input.item_id === undefined) {
      snapshot = existing.item_snapshot;
    } else if (input.item_id === null) {
      // Detaching the item: keep the existing snapshot as a placeholder.
      snapshot = existing.item_snapshot;
    } else {
      snapshot = existing.item_snapshot;
    }
    if (itemId !== null && snapshot === null) {
      throw new BlockValidationError("assigning item_id requires item_snapshot");
    }

    const sortKey =
      input.sort_key === undefined
        ? existing.sort_key
        : input.sort_key && isValidSortKey(input.sort_key)
          ? input.sort_key
          : nextSiblingSortKey(db, spaceId, parentId);

    db.prepare(
      `UPDATE space_blocks
          SET parent_id = @parent_id,
              block_type = @block_type,
              item_id = @item_id,
              item_snapshot_json = @item_snapshot_json,
              sort_key = @sort_key,
              markdown = @markdown,
              metadata_json = @metadata_json,
              updated_at = @updated_at
        WHERE space_id = @space_id AND id = @id`,
    ).run({
      space_id: spaceId,
      id: blockId,
      parent_id: parentId,
      block_type: input.block_type ?? existing.block_type,
      item_id: itemId,
      item_snapshot_json: serializeSnapshot(snapshot),
      sort_key: sortKey,
      markdown: input.markdown === undefined ? existing.markdown : input.markdown ?? "",
      metadata_json: serializeObject(input.metadata ?? existing.metadata),
      updated_at: now,
    });
    return getSpaceBlock(db, spaceId, blockId);
  });
}

export function deleteSpaceBlock(db: Db, spaceId: string, blockId: string): boolean {
  return mutateSpaceRecord(db, "space_blocks", blockId, spaceId, () => {
    const result = db
      .prepare("DELETE FROM space_blocks WHERE space_id = ? AND id = ?")
      .run(spaceId, blockId);
    return result.changes > 0;
  });
}

// --- detach / degrade -------------------------------------------------------

export interface DetachItemResult {
  detached: SpaceBlockRecord[];
}

/**
 * Detach/degrade every block in a Space that embeds `itemId`: drop the `item_id`
 * FK (so a subsequent `space_items` delete is no longer RESTRICTed) while
 * PRESERVING `item_snapshot_json` as a placeholder. This is the only sanctioned
 * way to remove an item that blocks embed — deleting the item directly is
 * RESTRICTed by the FK. Runs in one transaction.
 */
export function detachItemFromBlocks(
  db: Db,
  spaceId: string,
  itemId: string,
  now = Date.now(),
): DetachItemResult {
  const run = db.transaction((): DetachItemResult => {
    const rows = db
      .prepare("SELECT * FROM space_blocks WHERE space_id = ? AND item_id = ?")
      .all(spaceId, itemId) as SpaceBlockRow[];
    const detached: SpaceBlockRecord[] = [];
    for (const row of rows) {
      updateSpaceBlock(db, spaceId, row.id, { item_id: null }, now);
      const updated = getSpaceBlock(db, spaceId, row.id);
      if (updated) detached.push(updated);
    }
    return { detached };
  });
  return run();
}

/** Count blocks in a Space that currently embed `itemId` (RESTRICT probe). */
export function countBlocksEmbeddingItem(db: Db, spaceId: string, itemId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM space_blocks WHERE space_id = ? AND item_id = ?")
    .get(spaceId, itemId) as { n: number };
  return row.n;
}
