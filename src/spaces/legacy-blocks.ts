import type { Db } from "../db.js";
import { parseJsonObjectStrict } from "../row-coerce.js";
import type { BlockType } from "./serialize.js";
import type { SpaceBlockRecord } from "./document-source.js";

export interface SpaceBlockRow {
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

export function legacyBlockRecord(row: SpaceBlockRow): SpaceBlockRecord {
  return {
    id: row.id,
    space_id: row.space_id,
    parent_id: row.parent_id,
    block_type: row.block_type,
    item_id: row.item_id,
    item_snapshot: row.item_snapshot_json === null ? null : parseJsonObjectStrict(row.item_snapshot_json),
    sort_key: row.sort_key,
    markdown: row.markdown,
    metadata: parseJsonObjectStrict(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function readLegacySpaceBlocks(db: Db, spaceId: string): SpaceBlockRecord[] {
  const rows = db
    .prepare("SELECT * FROM space_blocks WHERE space_id = ? ORDER BY sort_key ASC, id ASC")
    .all(spaceId) as SpaceBlockRow[];
  const blocks = rows.map(legacyBlockRecord);
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
  const pending = [...(byParent.get(null) ?? [])].reverse();
  while (pending.length) {
    const block = pending.pop()!;
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    ordered.push(block);
    const children = byParent.get(block.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  // Defensive: any block not reached (orphan parent) is emitted at the end.
  for (const block of blocks) {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      ordered.push(block);
    }
  }
  return ordered;
}
