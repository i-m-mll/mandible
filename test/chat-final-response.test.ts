import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { testRuntimeRoot } from './helpers/runtime-isolation';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { CodexParser } from '../src/parsers/codex';
import { ClaudeParser } from '../src/parsers/claude';
import { ConversationSourceStore } from '../src/conversations/source-store';
import { ConversationSourceReader } from '../src/conversations/source-reader';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { captureReadingPublication, readConversationReadingManifest, readReadingRowBatch } from '../src/conversations/reading-materialization';
import { planConversationReading } from '../src/presentation/reading-manifest';
import { projectReadingRows } from '../src/presentation/reading';
import { displayEventsFromBlocks } from '../src/conversations/display-context';
import { preparePositionSpace } from '../src/conversations/position-space';

it('requires native final intent, independently of complete content, tool settlement, and tail position', async () => {
  const input = { filePath: '/private/.claude/projects/session.jsonl', nativeSessionId: 'session', baseBlockCount: 0, sourceHash: 'test', sourceMtime: 0 };
  const reasons = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', null];
  const parsed = await new ClaudeParser().parseIncremental({ ...input, raw: reasons.map((reason, index) => JSON.stringify({
    type: 'assistant', sessionId: 'session', timestamp: '2026-11-02', uuid: `record-${index}`,
    message: { id: `message-${index}`, stop_reason: reason, content: [{ type: 'text', text: `reply-${index}` }] },
  })).join('\n') });
  const codex = await new CodexParser().parseIncremental({ ...input, filePath: '/private/.codex/sessions/session.jsonl', raw:
    [null, 'commentary', 'final', 'final'].map((channel, index) => JSON.stringify({ type: 'response_item', payload: {
      type: 'message', id: index >= 2 ? "duplicate-final" : `codex-${index}`, role: 'assistant', channel, content: [{type: 'output_text', text: 'body'}],
    } })).concat(JSON.stringify({type: 'event_msg', payload: {type: 'task_complete'}})).join('\n') });
  const codexRows = projectReadingRows({ events: displayEventsFromBlocks(codex!.blocks.map(block => ({...block, parentPosition: null})), 'codex'),
    conversationId: 'codex', positionSpaceId: 'space', readingContext: new Map(), expanded: {} }).rows;
  expect(codexRows.filter(row => row.isFinalResponse).map(row => row.sources[0]?.position)).toEqual([2, 3]);
  expect(parsed).not.toBeNull();
  const events = displayEventsFromBlocks(parsed!.blocks.map(block => ({ ...block, parentPosition: null })), 'conversation');
  const project = (value: typeof events) => projectReadingRows({ events: value, conversationId: 'conversation', positionSpaceId: 'space', readingContext: new Map(), expanded: {} });
  expect(project(events).rows.filter(row => row.isFinalResponse).map(row => row.sources[0]?.position)).toEqual([0]);
  const streaming = events.map(event => ({ ...event, item: { ...event.item, content_completion: 'streaming' as const } }));
  expect(project(streaming).rows.some(row => row.isFinalResponse)).toBe(false);
  const unknown = events.map(event => ({ ...event, item: { ...event.item, assistant_response: undefined } }));
  expect(project(unknown).rows.some(row => row.isFinalResponse)).toBe(false);
});

it('gives one final displayed fragment ownership through body-free manifests and bounded saved/live materialization', async () => {
  const db = migratedMemoryDb();
  const file = path.join(testRuntimeRoot, 'final-response', '.claude/projects/session.jsonl');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const records = [
    {type: 'assistant', sessionId: 'session', message: {id: 'commentary', stop_reason: 'tool_use', content: [{type: 'text', text: 'interim'}]}},
    {type: 'assistant', sessionId: 'session', message: {id: 'final', stop_reason: 'end_turn', content: [{type: 'text', text: 'FINAL FIRST BODY'}, {type: 'text', text: 'FINAL LAST BODY'}]}},
    {type: 'assistant', sessionId: 'session', message: {id: 'unknown', content: [{type: 'text', text: 'unknown tail'}]}},
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  try {
    const parsed = (await new ClaudeParser().parse(file))!;
    db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,session_id,block_count,started_at)
      VALUES('conversation','claude_code',?,?,?,'session',?,'2026-11-02')`).run(file, parsed.conversation.source_hash, parsed.conversation.source_mtime, parsed.blocks.length);
    const store = new ConversationSourceStore(db);
    const legacy = parsed.blocks.map(block => ({ ...block, metadata: {...block.metadata, chat_item: block.metadata.chat_item
      ? {...block.metadata.chat_item, assistant_response: undefined} : undefined} }));
    await store.recordConversation({conversationId: 'conversation', provider: 'claude_code', nativeSessionId: 'session',
      filePath: file, blocks: legacy, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS});
    const oldPublication = captureReadingPublication(db, 'conversation')!;
    expect(planConversationReading(readConversationReadingManifest(db, 'conversation', oldPublication)!, {}).rows.some(row => row.isFinalResponse)).toBe(false);
    await store.recordConversation({ conversationId: 'conversation', provider: 'claude_code', nativeSessionId: 'session',
      filePath: file, blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
    const refreshed = captureReadingPublication(db, 'conversation')!;
    expect(refreshed.current_version_id).toBe(oldPublication.current_version_id);
    expect(refreshed.position_space_id).toBe(oldPublication.position_space_id);
    const manifest = readConversationReadingManifest(db, 'conversation', captureReadingPublication(db, 'conversation')!)!;
    expect(JSON.stringify(manifest)).not.toContain('FINAL LAST BODY');
    const plan = planConversationReading(manifest, {});
    const finals = plan.rows.filter(row => row.isFinalResponse);
    expect(finals).toHaveLength(1);
    expect(finals[0].key).not.toBe(plan.rows.at(-1)?.key);
    const result = await readReadingRowBatch({db, reader: new ConversationSourceReader(db), conversationId: 'conversation',
      request: {positionSpaceId: manifest.positionSpaceId, rows: finals, expanded: {}}});
    expect(result.status).toBe('source');
    if (result.status !== 'source') throw new Error(result.status);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].isFinalResponse).toBe(true);
    expect(result.rows[0].nodes).toHaveLength(1);
    expect(result.rows[0].nodes[0]).toMatchObject({kind: 'assistant_turn', turn: {assistantEvent: {message: {content: [{type: 'text'}]}}}});
    if (result.rows[0].nodes[0].kind !== 'assistant_turn') throw new Error('Final response must be a message fragment.');
    expect(result.rows[0].nodes[0].turn.assistantEvent.message.content).toHaveLength(1);
    expect(JSON.stringify(result.rows[0].nodes)).toContain('FINAL LAST BODY');
    expect(JSON.stringify(result.rows[0].nodes)).not.toContain('FINAL FIRST BODY');
    const saved = displayEventsFromBlocks(parsed.blocks.map(block => ({ ...block, parentPosition: null })), 'conversation');
    const live = saved.map(({source, ...event}) => ({ ...event, item: { ...event.item, provenance: { ...event.item.provenance, source: 'live-provider-event' as const } } }));
    const project = (events: typeof live) => projectReadingRows({ events, conversationId: 'conversation', positionSpaceId: manifest.positionSpaceId, readingContext: new Map(), expanded: {} });
    expect(project(live).rows.filter(row => row.isFinalResponse)).toHaveLength(1);
    const before = project(live);
    const unclassified = live.map(event => ({ ...event, item: {...event.item, assistant_response: undefined} }));
    const after = project(unclassified);
    expect(before.rows.filter(row => row.isFinalResponse).every(row => after.rows.find(other => other.key === row.key)?.revision !== row.revision)).toBe(true);
    const priorSpace = preparePositionSpace(parsed.blocks, null, false);
    const enriched = parsed.blocks.map(block => ({ ...block, metadata: { ...block.metadata, chat_item: block.metadata.chat_item
      ? { ...block.metadata.chat_item, assistant_response: undefined } : undefined } }));
    expect(preparePositionSpace(enriched, priorSpace, false).position_space_id).toBe(priorSpace.position_space_id);
    const anonymous = parsed.blocks.map(block => ({ ...block, dag_uuid: null, metadata: {...block.metadata, provider_message_id: undefined,
      chat_item: block.metadata.chat_item ? {...block.metadata.chat_item, identity: {...block.metadata.chat_item.identity, native_item_id: undefined}} : undefined} }));
    const anonymousSpace = preparePositionSpace(anonymous, null, false);
    const classified = anonymous.map(block => ({...block, metadata: {...block.metadata, chat_item: block.metadata.chat_item
      ? {...block.metadata.chat_item, assistant_response: undefined} : undefined}}));
    expect(preparePositionSpace(classified, anonymousSpace, false).position_space_id).toBe(anonymousSpace.position_space_id);
  } finally { db.close(); }
});
