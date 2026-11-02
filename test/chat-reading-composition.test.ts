import {chatItemIdentityKey} from '../src/conversation-control/provider-live';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { CodexParser } from '../src/parsers/codex';
import { ConversationSourceStore } from '../src/conversations/source-store';
import { ConversationSourceReader } from '../src/conversations/source-reader';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { captureReadingPublication, readConversationReadingManifest, readReadingRowBatch } from '../src/conversations/reading-materialization';
import { planConversationReading } from '../src/presentation/reading-manifest';
import { composeConversationReading, materializeConversationReading, readingCompositionRequests } from '../src/presentation/reading-composition';
import type { CanonicalChatItemEvent } from '../src/presentation/types';

async function fixture(includeResult: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-reading-composition-'));
  const db = migratedMemoryDb();
  const file = path.join(root, '.codex/sessions/composition.jsonl');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const records = [
    {type: 'session_meta', payload: {id: 'composition', cwd: '/tmp'}},
    {type: 'event_msg', payload: {type: 'task_started', turn_id: 'turn'}},
    {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'inspect'}]}},
    {type: 'response_item', payload: {type: 'function_call', call_id: 'call', name: 'read', arguments: '{"file_path":"/tmp/exact-owner"}'}},
    ...(includeResult ? [{type: 'response_item', payload: {type: 'function_call_output', call_id: 'call', output: 'EXACT RESULT BODY'}}] : []),
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const parsed = await new CodexParser().parse(file);
  if (!parsed) throw new Error('Native composition fixture did not parse.');
  db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,session_id,block_count,started_at)
    VALUES('composition','codex',?,?,?,'composition',?,'2026-11-01')`).run(file, parsed.conversation.source_hash, parsed.conversation.source_mtime, parsed.blocks.length);
  await new ConversationSourceStore(db).recordConversation({conversationId: 'composition', provider: 'codex', nativeSessionId: 'composition',
    filePath: file, blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS});
  const manifest = readConversationReadingManifest(db, 'composition', captureReadingPublication(db, 'composition')!)!;
  return {root, db, parsed, manifest, reader: new ConversationSourceReader(db), close: () => {db.close(); fs.rmSync(root, {recursive: true, force: true});}};
}

it('retains default status evidence and materializes exact disclosed call/result targets through the normal row source', async () => {
  const f = await fixture(true);
  try {
    const status = f.parsed.blocks.find(block => block.metadata.source_event_type === 'task_started')!;
    expect(planConversationReading(f.manifest, {}).membership.has(status.position)).toBe(true);
    const call = f.manifest.members.find(member => member.activity?.type === 'tool-call-activity')!;
    const closed = planConversationReading(f.manifest, {});
    const expanded = {[call.disclosures!.keys[0]]: true};
    const open = planConversationReading(f.manifest, expanded);
    const descriptor = open.rows.find(row => row.key === call.key)!;
    expect(descriptor.revision).not.toBe(closed.rows.find(row => row.key === call.key)!.revision);
    const result = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
      request: {positionSpaceId: f.manifest.positionSpaceId, rows: [descriptor], expanded}});
    expect(result.status).toBe('source');
    if (result.status !== 'source') throw new Error(result.status);
    const node = result.rows[0].nodes[0];
    expect(node).toMatchObject({kind: 'activity', source: {position: call.position, detailsLoaded: true},
      item: {input: expect.stringContaining('exact-owner'), result: {content: 'EXACT RESULT BODY', source: {detailsLoaded: true}}}});
    const positions = call.sourcePositions;
    expect(open.membership.get(positions[0])?.subtarget).not.toBe(open.membership.get(positions[1])?.subtarget);
    const resultKey = chatItemIdentityKey(f.parsed.blocks.find(block => block.type === 'tool_result')!.metadata.chat_item!)!;
    expect(open.viewMembership.get(resultKey)?.position).toBe(positions[1]);
    expect(JSON.stringify(f.manifest)).not.toContain('EXACT RESULT BODY');
  } finally {f.close();}
});

it('composes a live result and live suffix with the canonical owner through one plan and bounded canonical-only reads', async () => {
  const f = await fixture(false);
  try {
    const call = f.parsed.blocks.find(block => block.type === 'tool_use')!.metadata.chat_item!;
    const result: CanonicalChatItemEvent = {type: 'chat:item', item: {...call, phase: 'result', role: 'tool', output: 'LIVE RESULT', input: undefined,
      provenance: {...call.provenance, source: 'live-provider-event'}} as CanonicalChatItemEvent['item']};
    const suffix: CanonicalChatItemEvent = {type: 'chat:item', item: {...call, tool_id: 'second-call', tool_name: 'edit', input: '{"file_path":"/tmp/new"}',
      identity: {...call.identity, native_item_id: 'second-call', native_tool_id: 'second-call'}, provenance: {...call.provenance, source: 'live-provider-event'}} as CanonicalChatItemEvent['item']};
    const composed = composeConversationReading({manifest: f.manifest, events: [result, suffix], expanded: {}});
    const owner = f.manifest.members.find(member => member.activity?.type === 'tool-call-activity')!;
    const summary = composed.plan.rows.find(row => row.kind === 'activity-summary')!;
    expect(summary.memberKeys).toHaveLength(2);
    expect(composed.actionRuns.get(summary.actionGroup.key)?.events).toContain(result);
    expect(composed.plan.membership.get(owner.position!)?.rowKey).toBe(summary.key);
    const refs = readingCompositionRequests(composed, [summary]);
    const canonical = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
      request: {positionSpaceId: f.manifest.positionSpaceId, rows: refs, expanded: {}}});
    if (canonical.status !== 'source') throw new Error(canonical.status);
    const hydrated = materializeConversationReading(composed, [summary], canonical.rows);
    expect(hydrated.status).toBe('source');
    if (hydrated.status !== 'source') throw new Error(hydrated.reason);
    expect(hydrated.rows[0].activityGroup?.items.find(node => node.source?.position === owner.position)?.item).toMatchObject({result: {content: 'LIVE RESULT'}});
    expect(hydrated.rows[0].activityGroup?.items.find(node => !node.source)?.item).toMatchObject({name: 'edit'});
    expect(JSON.stringify(refs)).not.toContain('LIVE RESULT');
  } finally {f.close();}
});

it('accepts a captured row snapshot when publication freshness advances without changing its dependencies', async () => {
  const f = await fixture(true);
  try {
    const descriptor = planConversationReading(f.manifest, {}).rows[0];
    const original = f.reader.readPositions.bind(f.reader);
    const race = vi.spyOn(f.reader, 'readPositions').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.db.prepare("UPDATE conversation_sources SET publication_revision=publication_revision+1 WHERE conversation_id='composition'").run();
      return result;
    });
    try {
      const result = await readReadingRowBatch({db: f.db, reader: f.reader, conversationId: 'composition',
        request: {positionSpaceId: f.manifest.positionSpaceId, rows: [descriptor], expanded: {}}});
      expect(result).toMatchObject({status: 'source', publicationRevision: f.manifest.publicationRevision});
    } finally {race.mockRestore();}
  } finally {f.close();}
});
