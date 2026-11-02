import { readingDisclosureState } from '../presentation/reading-disclosures.js';
import { buildReadingManifest, planConversationReading, type ConversationReadingManifest } from '../presentation/reading-manifest.js';
import { projectReadingRows, type ReadingRow } from '../presentation/reading.js';
import type { ReadingPlan, ReadingRowDescriptor } from '../presentation/reading-plan.js';
import { getConversationStructureCache } from './structure-cache.js';
import { displayEventsFromBlocks } from './display-context.js';
import { readDisplayContext } from './display-context-read.js';
import { projectDisplayBlock } from './display-block.js';
import type { ConversationSourceReader } from './source-reader.js';
import type { ConversationSourceEpochs } from './source-types.js';
import type { Db } from '../db.js';

export type ReadingPublication = ConversationSourceEpochs & {
  current_version_id: string; position_space_id: string; publication_revision: number;
};
export function captureReadingPublication(db: Db, conversationId: string): ReadingPublication | null {
  return db.prepare(`SELECT current_version_id, position_space_id, publication_revision,
    parser_format AS parserFormat, parser_version AS parserVersion, normalization_version AS normalizationVersion, redaction_epoch AS redactionEpoch
    FROM conversation_sources WHERE conversation_id = ? AND current_version_id IS NOT NULL AND position_space_id IS NOT NULL
    ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`).get(conversationId) as ReadingPublication | null;
}
type PresentationCache = { publicationKey: string; manifest: ConversationReadingManifest; membersByKey: ReadonlyMap<string, ConversationReadingManifest['members'][number]>; plans: Map<string, { plan: ReadingPlan; byKey: Map<string, ReadingRowDescriptor> }> };
const presentationCache = new WeakMap<Db, PresentationCache>();

export function readConversationReadingManifest(db: Db, conversationId: string, source: ReadingPublication): ConversationReadingManifest | null {
  const publicationKey = JSON.stringify([conversationId, source]);
  const retained = presentationCache.get(db);
  if (retained?.publicationKey === publicationKey) return retained.manifest;
  const cache = getConversationStructureCache(db);
  const index = cache.readPresentationIndex(conversationId, source.current_version_id, source);
  const count = cache.blockCount(conversationId, source.current_version_id, source);
  if (!index || count === null || index.positions.length !== count) return null;
  const context = cache.readReadingContext(conversationId, source.current_version_id, 0, count - 1, source);
  if (!context || context.length !== count) return null;
  const manifest = buildReadingManifest({ ...index, conversationId, positionSpaceId: source.position_space_id,
    sourceVersionId: source.current_version_id, publicationRevision: source.publication_revision, blockCount: count, readingContext: context });
  presentationCache.set(db, { publicationKey, manifest, membersByKey: new Map(manifest.members.map(member => [member.key, member])), plans: new Map() });
  return manifest;
}
export type ReadingRowRequest = { key: string; revision: string };
export type ReadingRowBatchRequest = {
  positionSpaceId: string;
  rows: readonly ReadingRowRequest[];
  expanded: Readonly<Record<string, boolean>>;
  streaming?: boolean;
};
export type ReadingRowBatchResult =
  | { status: 'source'; sourceVersionId: string; publicationRevision: number; positionSpaceId: string; rows: Array<ReadingRow & { revision: string }> }
  | { status: 'position-space-changed'; positionSpaceId: string | null }
  | { status: 'changed'; reason: string }
  | { status: 'unavailable' | 'resource-limit'; reason: string };

/** A newer publication may satisfy older descriptors, but only after proving every requested dependency unchanged. */
export async function readReadingRowBatch(input: {
  db: Db; conversationId: string; reader: ConversationSourceReader; request: ReadingRowBatchRequest;
}): Promise<ReadingRowBatchResult> {
  const { db, conversationId, reader, request } = input;
  const source = captureReadingPublication(db, conversationId);
  if (!source || source.position_space_id !== request.positionSpaceId) return { status: 'position-space-changed', positionSpaceId: source?.position_space_id ?? null };
  const manifest = readConversationReadingManifest(db, conversationId, source);
  if (!manifest) return { status: 'unavailable', reason: 'Complete presentation index is not available.' };
  if (request.rows.length > 128) return { status: 'resource-limit', reason: 'Split this presentation request into smaller batches.' };
  const retained = presentationCache.get(db)!;
  const disclosureKey = JSON.stringify([Boolean(request.streaming), Object.entries(request.expanded)
    .sort(([left], [right]) => left.localeCompare(right))]);
  let planned = retained.plans.get(disclosureKey);
  if (!planned) {
    const plan = planConversationReading(manifest, request.expanded, request.streaming);
    planned = { plan, byKey: new Map(plan.rows.map(row => [row.key, row])) };
    if (retained.plans.size >= 2) retained.plans.delete(retained.plans.keys().next().value!);
    retained.plans.set(disclosureKey, planned);
  }
  const { byKey } = planned;
  const requested: ReadingRowDescriptor[] = [];
  for (const row of request.rows) {
    const descriptor = byKey.get(row.key);
    if (!descriptor || descriptor.revision !== row.revision) return { status: 'changed', reason: 'Requested presentation dependencies changed.' };
    requested.push(descriptor);
  }
  const positions = [...new Set(requested.flatMap(row => [...row.sourcePositions]))];
  if (positions.length > 512) return { status: 'resource-limit', reason: 'Split this presentation request into smaller batches.' };
  const cache = getConversationStructureCache(db);
  const displayPlan = cache.readDisplayContext(conversationId, source.current_version_id, positions, source);
  if (!displayPlan) return {status: 'changed', reason: 'Presentation publication changed before the source read.'};
  const allPositions = [...new Set([...positions, ...displayPlan.sourcePositions])];
  if (allPositions.length > 512) return { status: 'resource-limit', reason: 'This row has too many source contributors for one bounded materialization.' };
  const context = cache.readReadingContextPositions(conversationId, source.current_version_id, allPositions, source);
  if (!context) return {status: 'changed', reason: 'Presentation publication changed before the source read.'};
  const blocks = await reader.readPositions(conversationId, allPositions,
    { expectedSourceVersionId: source.current_version_id, expectedBlockCount: manifest.blockCount });
  if (blocks.status !== 'source') return { status: blocks.status === 'stale' ? 'changed' : 'unavailable', reason: blocks.reason };
  const byPosition = new Map(context.map(entry => [entry.position, entry]));
  const display = await readDisplayContext({ plan: displayPlan, conversationId, sourceVersionId: source.current_version_id,
    blockCount: manifest.blockCount, reader, sourceBlocks: blocks.value, actionScope: position => {
      const scope = byPosition.get(position)?.action_scope;
      if (!scope) throw new Error('Display owner omitted its source action scope.');
      return scope;
    } });
  if (display.status !== 'source') return { status: display.status === 'stale' ? 'changed' : 'unavailable', reason: display.reason };
  const current = captureReadingPublication(db, conversationId);
  if (current?.position_space_id !== source.position_space_id) return { status: 'position-space-changed', positionSpaceId: current?.position_space_id ?? null };
  if (current.current_version_id !== source.current_version_id || current.publication_revision !== source.publication_revision) {
    const latest = readConversationReadingManifest(db, conversationId, current);
    if (!latest) return {status: 'changed', reason: 'Source publication changed during row materialization.'};
    const latestRows = new Map(planConversationReading(latest, request.expanded, request.streaming).rows.map(row => [row.key, row]));
    if (request.rows.some(row => latestRows.get(row.key)?.revision !== row.revision)) {
      return {status: 'changed', reason: 'Requested presentation dependencies changed during materialization.'};
    }
  }
  const details = new Set(requested.filter(row => row.kind === 'content').flatMap(row => row.memberKeys.flatMap(key => {
    const member = retained.membersByKey.get(key);
    return member && readingDisclosureState(member.disclosures, request.expanded, { streaming: request.streaming, lastAssistantTurnId: manifest.lastAssistantTurnId }).some(([, expanded]) => expanded) ? [...member.sourcePositions] : [];
  })));
  const events = displayEventsFromBlocks(blocks.value.map(block => {
    const projected = details.has(block.position) ? { ...block, details_loaded: true as const } : projectDisplayBlock(block);
    return { ...projected, metadata: JSON.parse(projected.metadata_json),
      parentPosition: block.parent_id ? Number(block.parent_id.slice(block.parent_id.lastIndexOf(':') + 1)) : null };
  }), conversationId);
  const hydrated = projectReadingRows({ events, conversationId, positionSpaceId: source.position_space_id,
    readingContext: byPosition, displayContext: display.value,
    expanded: request.expanded, streaming: request.streaming });
  const hydratedByKey = new Map(hydrated.rows.map(row => [row.key, row]));
  const rows: Array<ReadingRow & { revision: string }> = [];
  for (const descriptor of requested) {
    const row = hydratedByKey.get(descriptor.key);
    if (!row) return { status: 'unavailable', reason: 'Requested source fragment could not be materialized.' };
    rows.push({ ...row, memberKeys: descriptor.memberKeys, revision: descriptor.revision, actionGroup: descriptor.actionGroup, turnStart: descriptor.turnStart, turnEnd: descriptor.turnEnd,
      activityEnd: descriptor.activityEnd, totalTokens: descriptor.totalTokens });
  }
  if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) return { status: 'resource-limit', reason: 'This row batch exceeds the bounded presentation payload.' };
  return { status: 'source', sourceVersionId: source.current_version_id, publicationRevision: source.publication_revision,
    positionSpaceId: source.position_space_id, rows };
}
