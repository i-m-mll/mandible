import { ReadingContent } from '../ui/src/chat/ReadingContent';
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

it('hydrates the annotated native indexed batch through the public reading routes with paired framing intact', async () => {
  const fixture=JSON.parse(readFileSync(join(process.cwd(),'test/fixtures/codex-indexed-command-batch.json'),'utf8'));
  const directory=mkdtempSync(join(tmpdir(),'mandible-native-batch-'));
  const db=migratedMemoryDb();setDb(db);
  try {
    const file=join(directory,'.codex/sessions/native-batch.jsonl');mkdirSync(join(directory,'.codex/sessions'),{recursive:true});
    writeFileSync(file,[{type:'session_meta',payload:{id:'native-batch',cwd:'/tmp'}},...fixture.records,{type:'response_item',payload:{type:'reasoning',id:'neighbor',summary:[{type:'summary_text',text:'Neighboring thought'}]}}].map(record=>JSON.stringify(record)).join('\n')+'\n');
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
    expect(JSON.stringify(manifest)).not.toContain('GIT_OPTIONAL_LOCKS');
    const groupExpanded=Object.fromEntries(Object.keys(manifest.runs).map(key=>[`group:${key}`,true]));
    let expanded:Record<string,boolean>={...groupExpanded};
    const materialize=async () => {
      const plan=planConversationReading(manifest,expanded);
      const descriptor=plan.rows.find(row=>row.kind==='content' && row.sourcePositions.includes(0))!;
      const response=await router.invoke({method:'POST',url:'/api/conversations/native-batch/reading-rows',body:{positionSpaceId:manifest.positionSpaceId,expanded,rows:[{key:descriptor.key,revision:descriptor.revision}]}});
      expect(response.status,JSON.stringify(response.body)).toBe(200);
      return (response.body as {rows:ReadingRow[]}).rows[0];
    };
    let row=await materialize();
    const native=row.nodes.find(node=>node.kind==='activity' && node.item.type==='tool-call-activity');
    if(!native || native.kind!=='activity' || native.item.type!=='tool-call-activity') throw new Error('Native batch missing');
    const nativeKey=manifest.members[0].disclosures.keys[0];
    const body=(preparing=false)=><ReadingContent events={[]} streaming={false} row={row} expandedBlocks={expanded} preparing={preparing} primaryActions={[]}
      setBlockExpanded={(key,next)=>{expanded={...expanded,[key]:next};}} onActivityGroupExpandedChange={()=>{}} />;
    const view=render(body());
    const leaves=()=>view.getAllByRole('button').filter(button=>button.hasAttribute('aria-expanded'));
    const coldRevision=row.revision;
    fireEvent.click(leaves()[0]);row=await materialize();view.rerender(body());
    expect(row.revision).not.toBe(coldRevision);
    expect(leaves().map(button=>button.getAttribute('aria-expanded'))).toEqual(['true','false']);
    fireEvent.click(leaves()[1]);row=await materialize();view.rerender(body());
    const tool=row.nodes.find(node=>node.kind==='activity' && node.item.type==='tool-call-activity');
    if(!tool || tool.kind!=='activity' || tool.item.type!=='tool-call-activity') throw new Error('Hydrated batch missing');
    expect(tool.item.result?.content).toBe(parsed.blocks[1].content);
    const nativeOutputs=fixture.records[1].payload.output.slice(1).map((block:{text:string})=>JSON.parse(block.text));
    expect([...view.container.querySelectorAll('.tool-card__terminal-output')].map(node=>node.textContent)).toEqual(nativeOutputs.map((output:{output:string})=>output.output));
    expect(view.container.querySelector('[data-block-id="cblk:native-batch:0"]')).not.toBeNull();
    expect(view.container.querySelector('[data-block-id="cblk:native-batch:1"]')).not.toBeNull();
    fireEvent.click(leaves()[1]);row=await materialize();view.rerender(body());
    expect(leaves().map(button=>button.getAttribute('aria-expanded'))).toEqual(['true','false']);
    expanded={...groupExpanded,[nativeKey]:true};row=await materialize();view.rerender(body(true));
    expect(leaves().map(button=>button.getAttribute('aria-expanded'))).toEqual(['true','true']);
    fireEvent.click(leaves()[1]);row=await materialize();view.rerender(body(true));
    expect(leaves().map(button=>button.getAttribute('aria-expanded'))).toEqual(['true','false']);
    view.unmount();
    const restored=render(body());
    expect(restored.getAllByRole('button').filter(button=>button.hasAttribute('aria-expanded')).map(button=>button.getAttribute('aria-expanded'))).toEqual(['true','false']);
    restored.unmount();
  } finally {cleanup();db.close();rmSync(directory,{recursive:true,force:true});}
});
