import { vi } from 'vitest';
import type { ConversationPositionWindow } from '../../ui/src/api';
import { indexDisplayFragments } from '../../src/conversations/display-indexing';
import { displayEventsFromBlocks } from '../../src/conversations/display-context';
import { buildReadingManifest, planConversationReading } from '../../src/presentation/reading-manifest';
import { prepareReadingMembers, materializePreparedReadingRows } from '../../src/presentation/reading';
import { ConversationStructureCache } from '../../src/conversations/structure-cache';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../../src/conversations/source-types';

/** Fixtures supply complete source records; production planning and materialization serve the reader. */
export function installReadingPresentationFixture(sourceFor: (id: string) => ConversationPositionWindow | undefined): void {
  const transport = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    const route = url.pathname.match(/^\/api\/conversations\/([^/]+)\/reading-(manifest|rows)$/);
    if (!route) return transport(input, init);
    const id = decodeURIComponent(route[1]);
    const payload = sourceFor(id);
    if (!payload || payload.blocks.length !== payload.total || payload.blocks.some((block, position) => block.position !== position)) throw new Error(`Complete reading source fixture missing for ${id}`);
    const blocks = payload.blocks.map(block => ({ ...block, metadata: JSON.parse(block.metadata_json) }));
    const cache = new ConversationStructureCache(undefined, {cachePath:':memory:'});
    let index;
    try {
      const epochs = CURRENT_CONVERSATION_SOURCE_EPOCHS;
      cache.replaceRows({conversation_id:id,source_version_id:payload.source_version_id!,parser_format:epochs.parserFormat,parser_version:epochs.parserVersion,
        normalization_version:epochs.normalizationVersion,redaction_epoch:epochs.redactionEpoch,block_count:payload.total},
      blocks.map(block => ({position:block.position,type:block.type,role:block.role,parentPosition:null,recordOffset:0,recordLength:0,recordOrdinal:block.position,subBlockOrdinal:0})),
      new Map(),undefined,indexDisplayFragments(blocks,id,()=>null));
      index = cache.readPresentationIndex(id,payload.source_version_id!,epochs)!;
    } finally { cache.close(); }
    const contexts = payload.reading_context!.positions.map(position => ({ position: position.position,
      activity_owner: position.activity_owner_position,
      action_scope: payload.reading_context!.speaker_runs.find(run => run.start === position.speaker_run_start)! }));
    const manifest = buildReadingManifest({ conversationId: id, positionSpaceId: payload.position_space_id!, sourceVersionId: payload.source_version_id!,
      publicationRevision: payload.publication_revision, blockCount: payload.total, ...index, readingContext: contexts });
    if (route[2] === 'manifest') return new Response(JSON.stringify({ status: 'source', manifest }));
    const request = JSON.parse(String(init?.body));
    if (request.positionSpaceId !== payload.position_space_id) return new Response(JSON.stringify({ status: 'position-space-changed', positionSpaceId: payload.position_space_id }));
    const plan = planConversationReading(manifest, request.expanded, request.streaming);
    if (request.rows.some((row: { key: string; revision: string }) => !plan.rows.some(current => current.key === row.key && current.revision === row.revision))) {
      return new Response(JSON.stringify({ status: 'changed', reason: 'Fixture source dependencies changed.' }));
    }
    const events = displayEventsFromBlocks(blocks.map(block => ({ ...block, parentPosition: null })), id);
    const prepared = prepareReadingMembers({ events, conversationId: id, positionSpaceId: payload.position_space_id!,
      readingContext: new Map(contexts.map(context => [context.position, context])), expanded: request.expanded, streaming: request.streaming });
    const keys = new Set(request.rows.map((row: { key: string }) => row.key));
    return new Response(JSON.stringify({ status: 'source', rows: materializePreparedReadingRows(plan.rows.filter(row => keys.has(row.key)), prepared.members) }));
  }));
}
