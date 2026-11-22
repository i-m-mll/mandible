import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { mutateLedgerRecord } from './mutation-history.js';
import { BLOCK_TYPES, EMBED_BLOCK_TYPES, type BlockType } from '../spaces/serialize.js';
import {
  BlockValidationError, editSpaceSource, writeSpaceBlock, type BlockItemSnapshot, type SpaceBlockRecord,
  type SpaceSourceBlock,
} from '../spaces/document-source.js';
import { getSpaceDocument, readSpaceBlocks, saveSpaceDocument, type SpaceDocument } from '../spaces/document-store.js';
import { generateSortKey, isValidSortKey } from '../spaces/sort-keys.js';

export { BLOCK_TYPES, EMBED_BLOCK_TYPES, BlockValidationError, type BlockType, type BlockItemSnapshot, type SpaceBlockRecord };
export { generateSortKey, isValidSortKey, normalizeSortKeys } from '../spaces/sort-keys.js';

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value);
}

export function isEmbedBlockType(type: BlockType): boolean {
  return EMBED_BLOCK_TYPES.has(type);
}

export function listSpaceBlocks(db: Db, spaceId: string): SpaceBlockRecord[] {
  return readSpaceBlocks(db, spaceId).map(span => span.block);
}

export function getSpaceBlock(db: Db, spaceId: string, id: string): SpaceBlockRecord | null {
  return listSpaceBlocks(db, spaceId).find(block => block.id === id) ?? null;
}

function recordBlockMutation<T>(db: Db, spaceId: string, id: string, before: SpaceBlockRecord | null,
  action: () => { result: T; after: SpaceBlockRecord | null },
): T {
  const space = db.prepare('SELECT project_id FROM spaces WHERE id=?').get(spaceId) as { project_id: string | null };
  let snapshot = before;
  return mutateLedgerRecord(db, {
    entity_type: 'space_block', entity_id: id, project_id: space.project_id,
    payload: { space_id: spaceId }, snapshot: () => {
      if (snapshot === null) return null;
      const { created_at: _created, updated_at: _updated, ...authored } = snapshot;
      return authored;
    },
  }, () => {
    const { result, after } = action();
    snapshot = after;
    return result;
  });
}

function nextKey(spans: SpaceSourceBlock[], parent: string | null) {
  return generateSortKey(spans.filter(span => span.block.parent_id === parent).at(-1)?.block.sort_key ?? null, null);
}

export function nextSiblingSortKey(db: Db, spaceId: string, parent: string | null): string {
  return nextKey(readSpaceBlocks(db, spaceId), parent);
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

export interface CreateBlockInput extends UpdateBlockInput {
  id?: string;
  block_type: BlockType;
}

function validateBlock(block: SpaceBlockRecord) {
  if (!isBlockType(block.block_type)) throw new BlockValidationError(`invalid block_type: ${block.block_type}`);
  if (block.item_id !== null && block.item_snapshot === null) throw new BlockValidationError('assigning item_id requires item_snapshot');
}

function saveBlockEdit(db: Db, spaceId: string, document: SpaceDocument, source: string) {
  const result = saveSpaceDocument(db, spaceId, document.generation, source);
  if (!result.ok) throw new Error('document changed within its writer transaction');
  return result.document;
}

function tree(spans: SpaceSourceBlock[], id: string): SpaceSourceBlock[] {
  const ids = new Set([id]);
  return spans.filter(({ block }) => {
    if (block.id !== id && !ids.has(block.parent_id ?? '')) return false;
    ids.add(block.id);
    return true;
  });
}

function insertionOffset(spans: SpaceSourceBlock[], block: SpaceBlockRecord, end: number): number {
  const siblings = spans.filter(span => span.block.parent_id === block.parent_id);
  const next = siblings.find(({ block: sibling }) => sibling.sort_key > block.sort_key ||
    (sibling.sort_key === block.sort_key && sibling.id > block.id));
  if (next) return next.from;
  const last = siblings.at(-1);
  if (last) return tree(spans, last.block.id).reduce((end, span) => Math.max(end, span.to), 0);
  if (block.parent_id === null) return end;
  const parent = spans.find(span => span.addressed && span.block.id === block.parent_id);
  if (!parent) throw new BlockValidationError(`parent block not found in space: ${block.parent_id}`);
  return parent.to;
}

function insertBlock(source: string, at: number, text: string) {
  return { from: at, to: at, text: (at > 0 ? '\n\n' : '') + text + (at < source.length ? '\n\n' : '') };
}

export function createSpaceBlock(db: Db, spaceId: string, input: CreateBlockInput, now = Date.now()): SpaceBlockRecord {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    const spans = readSpaceBlocks(db, spaceId, document);
    const parent_id = input.parent_id ?? null;
    const block: SpaceBlockRecord = {
      id: input.id ?? crypto.randomUUID(), space_id: spaceId, parent_id, block_type: input.block_type,
      item_id: input.item_id ?? null, item_snapshot: input.item_snapshot ?? null,
      sort_key: isValidSortKey(input.sort_key) ? input.sort_key : nextKey(spans, parent_id),
      markdown: input.markdown ?? '', metadata: input.metadata ?? {}, created_at: now, updated_at: now,
    };
    validateBlock(block);
    const at = insertionOffset(spans, block, document.source.length);
    const source = editSpaceSource(document.source, [insertBlock(document.source, at, writeSpaceBlock(block))]);
    return recordBlockMutation(db, spaceId, block.id, null, () => {
      const saved = saveBlockEdit(db, spaceId, document, source);
      const created = readSpaceBlocks(db, spaceId, saved).find(span => span.block.id === block.id);
      if (!created) throw new BlockValidationError('block insertion is inside an open Markdown construct');
      return { result: created.block, after: created.block };
    });
  })();
}

export function updateSpaceBlock(db: Db, spaceId: string, id: string, input: UpdateBlockInput, now = Date.now()): SpaceBlockRecord | null {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    const spans = readSpaceBlocks(db, spaceId, document);
    const target = spans.find(span => span.block.id === id);
    if (!target) return null;
    const previous = target.block;
    const parent_id = input.parent_id === undefined ? previous.parent_id : input.parent_id;
    const block: SpaceBlockRecord = {
      ...previous,
      id: target.addressed ? previous.id : crypto.randomUUID(), parent_id,
      block_type: input.block_type ?? previous.block_type,
      item_id: input.item_id === undefined ? previous.item_id : input.item_id,
      item_snapshot: input.item_snapshot === undefined ? previous.item_snapshot : input.item_snapshot,
      sort_key: input.sort_key === undefined ? previous.sort_key
        : isValidSortKey(input.sort_key) ? input.sort_key : nextKey(spans, parent_id),
      markdown: input.markdown === undefined ? previous.markdown : input.markdown ?? '',
      metadata: input.metadata ?? previous.metadata,
    };
    validateBlock(block);
    if (JSON.stringify(previous) === JSON.stringify(block)) return previous;
    block.updated_at = now;
    if (!target.addressed) block.created_at = now;
    let source: string;
    if (block.parent_id !== previous.parent_id || block.sort_key !== previous.sort_key) {
      const moved = tree(spans, id);
      if (moved.some(span => span.block.id === block.parent_id)) {
        throw new BlockValidationError('parent assignment would create a block cycle');
      }
      const other = spans.filter(span => !moved.includes(span));
      const at = insertionOffset(other, block, document.source.length);
      const text = [writeSpaceBlock(block), ...moved.slice(1).map(span => document.source.slice(span.from, span.to))].join('\n\n');
      source = editSpaceSource(document.source, [
        ...moved.map(span => ({ from: span.from, to: span.to, text: '' })),
        insertBlock(document.source, at, text),
      ]);
    } else {
      source = editSpaceSource(document.source, [{ from: target.from, to: target.to, text: writeSpaceBlock(block) }]);
    }
    return recordBlockMutation(db, spaceId, block.id, target.addressed ? previous : null, () => {
      const saved = saveBlockEdit(db, spaceId, document, source);
      const updated = readSpaceBlocks(db, spaceId, saved).find(span => span.block.id === block.id);
      if (!updated) throw new BlockValidationError('block update is inside an open Markdown construct');
      return { result: updated.block, after: updated.block };
    });
  })();
}

export function deleteSpaceBlock(db: Db, spaceId: string, id: string): boolean {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    const spans = tree(readSpaceBlocks(db, spaceId, document), id);
    if (spans.length === 0) return false;
    return recordBlockMutation(db, spaceId, id, spans[0].block, () => {
      saveBlockEdit(db, spaceId, document, editSpaceSource(document.source, spans.map(span => ({
        from: span.from, to: span.to, text: '',
      }))));
      return { result: true, after: null };
    });
  })();
}

export interface DetachItemResult {
  detached: SpaceBlockRecord[];
}

export function detachItemFromBlocks(db: Db, spaceId: string, itemId: string, now = Date.now()): DetachItemResult {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    const spans = readSpaceBlocks(db, spaceId, document).filter(span => span.block.item_id === itemId);
    const detached = spans.map(({ block }) => ({ ...block, item_id: null, updated_at: now }));
    const patches = spans.map((span, index) => ({
      from: span.from, to: span.to, text: writeSpaceBlock(detached[index]),
    }));
    if (patches.length) {
      saveBlockEdit(db, spaceId, document, editSpaceSource(document.source, patches));
      spans.forEach(({ block }, index) => recordBlockMutation(db, spaceId, block.id, block,
        () => ({ result: undefined, after: detached[index] })));
    }
    return { detached };
  })();
}

export function countBlocksEmbeddingItem(db: Db, spaceId: string, itemId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM space_document_addresses WHERE space_id=? AND item_id=?')
    .get(spaceId, itemId) as { n: number }).n;
}

export function addressSpaceBlock(db: Db, spaceId: string, expectedGeneration: number, range: { start: number; end: number }) {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    if (document.generation !== expectedGeneration) return { ok: false as const, document };
    const target = readSpaceBlocks(db, spaceId, document)
      .find(span => span.from === range.start && span.to === range.end);
    if (!target) throw new BlockValidationError('selected range does not identify a document block');
    if (target.addressed) return { ok: true as const, document, id: target.block.id };
    const now = Date.now();
    const block = { ...target.block, id: crypto.randomUUID(), created_at: now, updated_at: now };
    const source = editSpaceSource(document.source, [{
      from: target.from, to: target.to, text: writeSpaceBlock(block),
    }]);
    const saved = saveBlockEdit(db, spaceId, document, source);
    if (!getSpaceBlock(db, spaceId, block.id)) throw new BlockValidationError('selected block cannot be addressed at this source range');
    return { ok: true as const, document: saved, id: block.id };
  })();
}
