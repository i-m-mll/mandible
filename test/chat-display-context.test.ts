import { expect, it, vi } from 'vitest';
import { projectDisplayFragments } from '../src/presentation/fragments';
import { activityRunFacts, mergeActivityRunFacts, presentActivityRunFacts } from '../src/presentation/activity-presentation';
import type { CanonicalChatItemEvent, DisplayActivityItem } from '../src/presentation/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { setDb } from '../src/db';
import { ConversationSourceStore } from '../src/conversations/source-store';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { CodexParser } from '../src/parsers/codex';
import { Router } from '../src/server';
import { registerConversationRoutes } from '../src/routes/conversations';
import { inlineLedgerReader } from '../src/ledger-reads';
import type { ConversationPositionWindow } from '../src/contracts';
import { getConversationStructureCache } from '../src/conversations/structure-cache';
import { mergeDisplayContext, emptyDisplayContext } from '../ui/src/query/conversationDisplayContext';
import { ConversationSourceReader } from '../src/conversations/source-reader';

function message(id: string, text: string, position?: number): CanonicalChatItemEvent {
  return { type: 'chat:item', item: { type: 'message', role: 'assistant', content_completion: 'complete', parts: [{ type: 'text', text }],
    identity: { provider: 'codex', session_id: 'session', native_item_id: id, native_turn_id: 'turn', source_record_ordinal: 0, source_sub_block_ordinal: 0 },
    provenance: { provider: 'codex', source: position === undefined ? 'live-provider-event' : 'verified-provider-transcript', source_event_type: 'message' } },
    ...(position === undefined ? {} : { source: { blockId: `cblk:conversation:${position}`, position } }) };
}

it('splits source directives and prose once, with member-relative parts stable across live prepend and persistence', () => {
  const text = 'Before\n::created-thread{threadId="child"}\nAfter';
  const live = projectDisplayFragments([message('second', text)]);
  const prepended = projectDisplayFragments([message('first', 'Earlier'), message('second', text)]);
  const persisted = projectDisplayFragments([message('second', text, 8)]);
  expect(live.map(fragment => [fragment.part, fragment.node.kind])).toEqual([
    ['content:0', 'assistant_turn'], ['directive:0', 'activity'], ['content:1', 'assistant_turn'],
  ]);
  expect(prepended.filter(fragment => fragment.memberKey === live[0].memberKey).map(fragment => fragment.part)).toEqual(live.map(fragment => fragment.part));
  expect(persisted.map(fragment => fragment.part)).toEqual(live.map(fragment => fragment.part));
  expect(projectDisplayFragments([message('quoted', '```\n::created-thread{threadId="example"}\n```')])).toHaveLength(1);
});

it('folds canonical and live activity facts with the existing tool/thought wording', () => {
  const tool = (id: string): DisplayActivityItem => ({ type: 'tool-call-activity', id, name: 'read', input: 'unretained input', result: null, sessionId: 'session' });
  const thought: DisplayActivityItem = { type: 'thinking-block-activity', content: 'unretained thought body', sessionId: 'session' };
  const canonical = activityRunFacts([tool('a'), thought]);
  const combined = mergeActivityRunFacts(canonical, activityRunFacts([tool('b')]));
  expect(presentActivityRunFacts(combined)).toMatchObject({ summary: 'Read some files; thought', hasDisclosure: true, defaultExpanded: false });
  expect(JSON.stringify(canonical)).not.toContain('unretained');
});

it('returns exact clipped run/directive context and a source-backed lazy owner without extending the requested span', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-display-context-'));
  const db = migratedMemoryDb();
  setDb(db);
  try {
    const file = path.join(root, '.codex/sessions/display.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [
      { type: 'session_meta', payload: { id: 'display', cwd: '/tmp' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'a', name: 'read', arguments: '{"file_path":"/tmp/a","other":"PRIVATE INPUT"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a', output: 'PRIVATE RESULT A' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'b', name: 'edit', arguments: '{"file_path":"/tmp/b","other":"PRIVATE INPUT"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'b', output: 'PRIVATE RESULT B' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before\n::created-thread{threadId="child"}\nAfter' }] } },
      { type: 'event_msg', payload: { type: 'warning', message: 'PRIVATE SUMMARY FIRST' } },
      { type: 'event_msg', payload: { type: 'warning', message: 'PRIVATE SUMMARY SECOND' } },
    ];
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const parsed = await new CodexParser().parse(file);
    if (!parsed) throw new Error('display fixture did not parse');
    db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,block_count,created_at,updated_at)
      VALUES('display','codex',?,?,?,'Display','2026-11-01','display',?,'2026-11-01','2026-11-01')`)
      .run(file, parsed.conversation.source_hash, parsed.conversation.source_mtime, parsed.blocks.length);
    await new ConversationSourceStore(db).recordConversation({ conversationId: 'display', provider: 'codex', nativeSessionId: 'display', filePath: file,
      blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
    const snapshot = parsed.sourceSnapshot!;
    db.prepare(`INSERT INTO conversation_ingest_state(file_path,byte_offset,line_count,tail_hash,partial_line,updated_at)
      VALUES(?,?,?,?,'',?)`).run(file, snapshot.byteLength, snapshot.completeLineCount, snapshot.tailHash, Date.now());
    const router = new Router(); registerConversationRoutes(router, inlineLedgerReader());
    const read = async (position: number) => {
      const response = await router.invoke({ method: 'GET', url: `/api/conversations/display?position=${position}&limit=1&view=display` });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as ConversationPositionWindow;
    };
    const clipped = await read(2);
    expect(clipped.display_context.activity_runs).toMatchObject([{ id: '0:tool:0', first: { position: 0 }, last: { position: 2 },
      member_count: 2, presentation: { summary: 'Read a file; edited a file', hasDisclosure: true } }]);
    expect(JSON.stringify(clipped.display_context)).not.toContain('PRIVATE');
    const result = await read(3);
    expect(result.window).toMatchObject({ start_position: 3, end_position: 3 });
    expect(result.display_context.aliases).toEqual([{ position: 3, fragment_id: '2:tool:0' }]);
    expect(result.display_context.owners).toMatchObject([{ coordinate: { position: 2 }, header: { target: '/tmp/b' }, source: { detailsLoaded: false } }]);
    expect(result.display_context.fragments).toMatchObject([{ coordinate: { position: 2 }, paired_source_positions: [3] }]);
    const context = mergeDisplayContext(emptyDisplayContext(), result, result.blocks, true);
    const full = await router.invoke({ method: 'GET', url: `/api/conversations/display?position=2&limit=1&expected_position_space_id=${result.position_space_id}` });
    expect(full.status).toBe(200);
    const hydrated = mergeDisplayContext(context, full.body as ConversationPositionWindow, result.blocks, true);
    expect(hydrated.owners[0].details?.input).toContain('PRIVATE INPUT');
    expect(mergeDisplayContext(hydrated, { ...result, blocks: [] }, [], true).owners).toEqual([]);
    const prose = await read(4);
    expect(prose.display_context.fragments.map(fragment => fragment.coordinate.part)).toEqual(['content:0', 'directive:0', 'content:1']);
    expect(prose.display_context.activity_runs).toMatchObject([{ id: '4:directive:0', member_count: 1, presentation: { summary: 'Created task' } }]);
    const plan = getConversationStructureCache(db).readDisplayContext('display', clipped.source_version_id!, [2]);
    expect(JSON.stringify(plan?.runs.get('0:tool:0'))).not.toContain('PRIVATE');
    const generic = await read(6);
    expect(generic.display_context.activity_runs[0].presentation.summary).toContain('PRIVATE SUMMARY FIRST');
    expect(generic.display_context.activity_runs[0].presentation.summary).not.toContain('PRIVATE SUMMARY SECOND');
    const genericPlan = getConversationStructureCache(db).readDisplayContext('display', clipped.source_version_id!, [6])!;
    expect(genericPlan.sourcePositions).toEqual([5]);
    expect(JSON.stringify(genericPlan.runs.get('5:activity:0'))).not.toContain('PRIVATE SUMMARY');
    const appended = JSON.stringify({ type: 'event_msg', payload: { type: 'warning', message: 'PRIVATE SUMMARY THIRD' } }) + '\n';
    fs.appendFileSync(file, appended);
    const bytes = fs.readFileSync(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const delta = await new CodexParser().parseIncremental({ filePath: file, raw: appended, nativeSessionId: 'display',
      baseBlockCount: parsed.blocks.length, baseRecordCount: rows.length, sourceHash: hash, sourceMtime: fs.statSync(file).mtimeMs });
    if (!delta) throw new Error('display append fixture did not parse');
    const appendSnapshot = { ...snapshot, kind: 'append' as const, byteLength: bytes.length, completeLineCount: rows.length + 1,
      tailHash: createHash('sha256').update(bytes.subarray(Math.max(0, bytes.length - 4096))).digest('hex'),
      appendRanges: [{ byteStart: snapshot.byteLength, byteEnd: bytes.length, contentHash: createHash('sha256').update(appended).digest('hex') }] };
    db.prepare("UPDATE conversations SET block_count = ?, source_hash = ?, source_mtime = ? WHERE id = 'display'")
      .run(parsed.blocks.length + delta.blocks.length, hash, fs.statSync(file).mtimeMs);
    await new ConversationSourceStore(db).recordConversation({ conversationId: 'display', provider: 'codex', nativeSessionId: 'display', filePath: file,
      structuralMode: 'append', blocks: delta.blocks, sourceSnapshot: appendSnapshot, blockCount: parsed.blocks.length + delta.blocks.length, ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
    db.prepare('UPDATE conversation_ingest_state SET byte_offset = ?,line_count = ?,tail_hash = ? WHERE file_path = ?')
      .run(appendSnapshot.byteLength, appendSnapshot.completeLineCount, appendSnapshot.tailHash, file);
    const extended = await read(6);
    expect(extended.position_space_id).toBe(generic.position_space_id);
    expect(extended.display_context.activity_runs).toMatchObject([{ id: '5:activity:0', member_count: 3 }]);
    const changed = await router.invoke({ method: 'GET', url: '/api/conversations/display?position=2&expected_position_space_id=obsolete' });
    expect(changed).toMatchObject({ status: 409, body: { code: 'position_space_changed' } });
    const originalRead = ConversationSourceReader.prototype.readPositions;
    const race = vi.spyOn(ConversationSourceReader.prototype, 'readPositions').mockImplementationOnce(async function (...args) {
      const result = await originalRead.apply(this, args);
      db.prepare("UPDATE conversation_sources SET publication_revision = publication_revision + 1 WHERE conversation_id = 'display'").run();
      return result;
    });
    try {
      const raced = await router.invoke({ method: 'GET', url: '/api/conversations/display?position=2&limit=1&view=display' });
      expect(raced).toMatchObject({ status: 409, body: { code: 'freshness_pending' } });
    } finally { race.mockRestore(); }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
