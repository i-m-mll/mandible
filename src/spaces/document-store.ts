import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { mutateLedgerRecord } from '../ledger/mutation-history.js';
import { BlockValidationError, parseSpaceSource, type SpaceSourceBlock, type SpaceBlockRecord } from './document-source.js';
import { generateSortKey, normalizeSortKeys } from './sort-keys.js';

export type SpaceDocument = { source: string; generation: number };
type SaveResult =
  | { ok: true; document: SpaceDocument; changed: boolean }
  | { ok: false; document: SpaceDocument };
export type SavedSpaceSource = { id: string; space_id: string; generation: number; content: string };

export function getSpaceDocument(db: Db, spaceId: string): SpaceDocument {
  return db.prepare('SELECT source,generation FROM space_documents WHERE id=?').get(spaceId) as
    SpaceDocument | undefined ?? { source: '', generation: 0 };
}

function addExportKeys(siblings: SpaceSourceBlock[]): void {
  let nextHint = 0;
  let previous: SpaceBlockRecord | undefined;
  for (const [index, { block }] of siblings.entries()) {
    if (!block.sort_key) {
      nextHint = Math.max(index + 1, nextHint);
      while (nextHint < siblings.length && !siblings[nextHint].block.sort_key) nextHint++;
      const after = siblings[nextHint]?.block.sort_key ?? null;
      const before = previous?.sort_key ?? null;
      if (after !== null && (after === '' || (before !== null && before >= after))) break;
      block.sort_key = generateSortKey(before, after);
      if ((before !== null && block.sort_key <= before) || (after !== null && block.sort_key >= after)) break;
    }
    if (previous && (previous.sort_key > block.sort_key ||
      (previous.sort_key === block.sort_key && previous.id > block.id))) break;
    previous = block;
  }
  if (previous === siblings.at(-1)?.block) return;
  const keys = normalizeSortKeys(siblings.length);
  siblings.forEach(({ block }, index) => { block.sort_key = keys[index]; });
}

export function orderSpaceSource(spans: SpaceSourceBlock[]): SpaceSourceBlock[] {
  const address = new Map<string, SpaceSourceBlock>();
  const byParent = new Map<string | null, SpaceSourceBlock[]>();
  for (const span of spans) {
    const { id, parent_id } = span.block;
    if (span.addressed) {
      if (address.has(id)) throw new BlockValidationError(`duplicate block address: ${id}`);
      address.set(id, span);
    }
    const siblings = byParent.get(parent_id);
    if (siblings) siblings.push(span);
    else byParent.set(parent_id, [span]);
  }
  for (const [parent, siblings] of byParent) {
    if (parent !== null && !address.has(parent)) throw new BlockValidationError(`parent block not found: ${parent}`);
    addExportKeys(siblings);
  }
  const ordered: SpaceSourceBlock[] = [];
  const pending = [...(byParent.get(null) ?? [])].reverse();
  while (pending.length) {
    const span = pending.pop()!;
    ordered.push(span);
    const children = byParent.get(span.block.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  if (ordered.length !== spans.length) {
    const reached = new Set(ordered);
    throw new BlockValidationError(`cyclic parent at block ${spans.find(span => !reached.has(span))!.block.id}`);
  }
  return ordered;
}

export function readSpaceBlocks(db: Db, spaceId: string, document = getSpaceDocument(db, spaceId)): SpaceSourceBlock[] {
  return orderSpaceSource(parseSpaceSource(spaceId, document.source, document.generation));
}

export function writeSpaceDocument(db: Db, spaceId: string, document: SpaceDocument, spans: readonly SpaceSourceBlock[]): void {
  db.prepare(`INSERT INTO space_documents (id,source,generation) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source,generation=excluded.generation`)
    .run(spaceId, document.source, document.generation);
  const previous = db.prepare('SELECT id,item_id FROM space_document_addresses WHERE space_id=?').all(spaceId) as
    Array<{ id: string; item_id: string | null }>;
  const pending = new Map(spans.filter(span => span.addressed).map(({ block }) => [block.id, block.item_id]));
  const remove = db.prepare('DELETE FROM space_document_addresses WHERE space_id=? AND id=?');
  const change = db.prepare('UPDATE space_document_addresses SET item_id=? WHERE space_id=? AND id=?');
  const insert = db.prepare('INSERT INTO space_document_addresses (id,space_id,item_id) VALUES (?,?,?)');
  const item = db.prepare('SELECT 1 FROM space_items WHERE space_id=? AND id=?');
  const owner = db.prepare('SELECT space_id FROM space_document_addresses WHERE id=?');
  for (const [id, itemId] of pending) {
    if (itemId !== null && !item.get(spaceId, itemId)) {
      throw new BlockValidationError(`item for block ${id} does not belong to this Space: ${itemId}`);
    }
    const other = owner.get(id) as { space_id: string } | undefined;
    if (other && other.space_id !== spaceId) throw new BlockValidationError(`block address already in use: ${id}`);
  }
  for (const row of previous) {
    const itemId = pending.get(row.id);
    if (itemId === undefined) remove.run(spaceId, row.id);
    else if (itemId !== row.item_id) change.run(itemId, spaceId, row.id);
    pending.delete(row.id);
  }
  for (const [id, itemId] of pending) insert.run(id, spaceId, itemId);
}

export function saveSpaceDocument(db: Db, spaceId: string, expectedGeneration: number, source: string): SaveResult {
  return db.transaction((): SaveResult => {
    const previous = getSpaceDocument(db, spaceId);
    if (previous.generation !== expectedGeneration) return { ok: false, document: previous };
    if (previous.source === source) return { ok: true, document: previous, changed: false };
    if (Buffer.from(source, 'utf8').toString('utf8') !== source) throw new BlockValidationError('document must contain valid Unicode');
    const document = { source, generation: expectedGeneration + 1 };
    const spans = readSpaceBlocks(db, spaceId, document);
    const space = db.prepare('SELECT project_id FROM spaces WHERE id=?').get(spaceId) as { project_id: string | null } | undefined;
    if (!space) throw new BlockValidationError(`Space not found: ${spaceId}`);
    mutateLedgerRecord(db, {
      entity_type: 'space_document', entity_id: spaceId, project_id: space.project_id,
      payload: { space_id: spaceId }, snapshot: () => getSpaceDocument(db, spaceId),
    }, () => writeSpaceDocument(db, spaceId, document, spans));
    return { ok: true, document, changed: true };
  })();
}

export function captureSavedSpaceSource(db: Db, spaceId: string, generation: number):
  { ok: true; capture: SavedSpaceSource } | { ok: false; document: SpaceDocument } {
  return db.transaction(() => {
    const document = getSpaceDocument(db, spaceId);
    if (document.generation !== generation) return { ok: false as const, document };
    db.prepare(`INSERT INTO space_document_history
      (id,space_id,kind,content,provenance_json,created_at,generation)
      VALUES (?,?,'saved-source',?,'{}',?,?) ON CONFLICT DO NOTHING`)
      .run(crypto.randomUUID(), spaceId, document.source, Date.now(), generation);
    const capture = db.prepare(`SELECT id,space_id,generation,content FROM space_document_history
      WHERE space_id=? AND generation=?`).get(spaceId, generation) as SavedSpaceSource;
    return { ok: true as const, capture };
  })();
}
