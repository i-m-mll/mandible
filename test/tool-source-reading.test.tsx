import { normalizedPositionIdentity } from '../src/conversations/position-space';
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { cleanup, fireEvent, render } from './helpers/dom';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratedMemoryDb } from './helpers/ledger-fixtures';
import { setDb } from '../src/db';
import { ConversationSourceStore } from '../src/conversations/source-store';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { CodexParser } from '../src/parsers/codex';
import { Router } from '../src/server';
import { registerConversationRoutes } from '../src/routes/conversations';
import { inlineLedgerReader } from '../src/ledger-reads';
import { planConversationReading, type ConversationReadingManifest } from '../src/presentation/reading-manifest';
import type { ReadingRow } from '../src/presentation/reading';
import { ToolUseBlock } from '../ui/src/components/message-blocks/ToolUseBlock';

it('hydrates the annotated native indexed batch through the public reading routes with paired framing intact', async () => {
  const fixture=JSON.parse(readFileSync(join(process.cwd(),'test/fixtures/codex-indexed-command-batch.json'),'utf8'));
  const directory=mkdtempSync(join(tmpdir(),'mandible-native-batch-'));
  const db=migratedMemoryDb();setDb(db);
  try {
    const file=join(directory,'.codex/sessions/native-batch.jsonl');mkdirSync(join(directory,'.codex/sessions'),{recursive:true});
    writeFileSync(file,[{type:'session_meta',payload:{id:'native-batch',cwd:'/tmp'}},...fixture.records].map(record=>JSON.stringify(record)).join('\n')+'\n');
    const parsed=(await new CodexParser().parse(file))!;
    const isolatedInput={filePath:file,raw:JSON.stringify(fixture.records[1])+'\n',nativeSessionId:'native-batch',baseBlockCount:1,baseRecordCount:2,sourceHash:'fixture',sourceMtime:0};
    const unpaired=(await new CodexParser().parseIncremental(isolatedInput))!.blocks[0];
    const identity={id:fixture.call_id,name:'exec',kind:'custom_tool_call'};
    const admitted=(await new CodexParser().parseIncremental({...isolatedInput,displayToolCalls:[identity]}))!.blocks[0];
    expect(admitted.metadata.display_tool_frame).toEqual(parsed.blocks[1].metadata.display_tool_frame);
    expect(admitted.content).toBe(unpaired.content);
    expect(admitted.metadata.chat_item).toEqual(unpaired.metadata.chat_item);
    expect(normalizedPositionIdentity(admitted)).toBe(normalizedPositionIdentity(unpaired));
    for(const wrong of [{...identity,id:'different-call'},{...identity,kind:'function_call'}]) expect((await new CodexParser().parseIncremental({...isolatedInput,displayToolCalls:[wrong]}))!.blocks[0].metadata.display_tool_frame).toBeUndefined();
    db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,block_count,created_at,updated_at)
      VALUES('native-batch','codex',?,?,?,'Native batch','2026-11-02','native-batch',?,'2026-11-02','2026-11-02')`)
      .run(file,parsed.conversation.source_hash,parsed.conversation.source_mtime,parsed.blocks.length);
    await new ConversationSourceStore(db).recordConversation({conversationId:'native-batch',provider:'codex',nativeSessionId:'native-batch',filePath:file,
      blocks:parsed.blocks,sourceSnapshot:parsed.sourceSnapshot,...CURRENT_CONVERSATION_SOURCE_EPOCHS});
    const snapshot=parsed.sourceSnapshot!;
    db.prepare(`INSERT INTO conversation_ingest_state(file_path,byte_offset,line_count,tail_hash,partial_line,updated_at) VALUES(?,?,?,?,'',?)`)
      .run(file,snapshot.byteLength,snapshot.completeLineCount,snapshot.tailHash,Date.now());
    const router=new Router();registerConversationRoutes(router,inlineLedgerReader());
    const response=await router.invoke({method:'GET',url:'/api/conversations/native-batch/reading-manifest'});
    expect(response.status).toBe(200);
    const manifest=(response.body as {manifest:ConversationReadingManifest}).manifest;
    expect(JSON.stringify(manifest)).not.toContain('diff --git');
    const expanded=Object.fromEntries(manifest.members.flatMap(member=>member.disclosures?.keys ?? []).map(key=>[key,true]));
    const plan=planConversationReading(manifest,expanded);
    const rows=await router.invoke({method:'POST',url:'/api/conversations/native-batch/reading-rows',body:{positionSpaceId:manifest.positionSpaceId,expanded,
      rows:plan.rows.map(({key,revision})=>({key,revision}))}});
    expect(rows.status,JSON.stringify(rows.body)).toBe(200);
    const native=(rows.body as {rows:ReadingRow[]}).rows.flatMap(row=>row.nodes).find(node=>node.kind==='activity' && node.item.type==='tool-call-activity');
    if(!native || native.kind!=='activity' || native.item.type!=='tool-call-activity') throw new Error('Native batch missing');
    const tool=native.item;
    expect(tool.result?.content).toBe(parsed.blocks[1].content);
    expect(tool.result?.source?.toolFrame).toMatchObject({kind:'codex-script',payloadStart:48,payloadEnd:10810});
    const view=render(<ToolUseBlock toolName={tool.name} toolKind={tool.toolKind} input={tool.input} result={tool.result} expanded />);
    const outputs=[...view.container.querySelectorAll('.tool-card__terminal-output')];
    const nativeOutputs=fixture.records[1].payload.output.slice(1).map((block:{text:string})=>JSON.parse(block.text));
    expect(outputs.map(node=>node.textContent)).toEqual(nativeOutputs.map((output:{output:string})=>output.output));
    expect([...view.container.querySelectorAll('.tool-card__result small')].map(node=>node.textContent)).toEqual(nativeOutputs.map((output:{wall_time_seconds:number})=>`${output.wall_time_seconds} s`));
    expect(view.container.textContent).not.toContain('Script completed');
    view.unmount();
    const command=render(<ToolUseBlock toolName="exec" toolKind="custom_tool_call" input={fixture.command_preview.input} />);
    const summary=command.container.querySelector('.compact-activity__summary')!;
    expect(summary.textContent).toBe(`Ran ${fixture.command_preview.command}`);
    expect(summary.getAttribute('title')).toBe(`Ran ${fixture.command_preview.command}`);
    fireEvent.click(command.container.querySelector('button.compact-activity__row')!);
    expect(summary.textContent).toBe('Ran command');
    expect(command.container.querySelector('.tool-card__terminal code')?.textContent).toBe(fixture.command_preview.command);
  } finally {cleanup();db.close();rmSync(directory,{recursive:true,force:true});}
});
