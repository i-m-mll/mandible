import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { ClaudeParser } from "../src/parsers/claude.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ParseResult } from "../src/parsers/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-source-reader-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function rolloutPath(name = "rollout-2026-08-17T00-00-00-session-a.jsonl"): string {
  const dir = path.join(tempDir, ".codex", "sessions", "2026", "08", "17");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function records(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return [
    { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id: "duplicate-session", cwd: "/tmp/project" } },
    { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: '{"cmd":"hello"}' } },
    { type: "response_item", timestamp: "2026-08-17T00:00:02Z", payload: { type: "function_call_output", call_id: "call-1", output: "hello result" } },
    { type: "response_item", timestamp: "2026-08-17T00:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ...extra,
  ];
}

function writeRecords(filePath: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function parse(filePath: string): Promise<ParseResult> {
  const result = await new CodexParser().parse(filePath);
  if (!result) throw new Error("fixture did not parse");
  return result;
}

function insertConversation(db: SqliteDatabase, id: string, filePath: string, result: ParseResult): void {
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, model, tags, created_at, updated_at
    ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
  `).run(
    id, filePath, result.conversation.source_hash, result.conversation.source_mtime,
    result.conversation.title, result.conversation.started_at, result.blocks.length,
    result.conversation.session_id, result.conversation.model,
  );
  replaceBlocks(db, id, result);
}

function replaceBlocks(db: SqliteDatabase, conversationId: string, result: ParseResult): void {
  db.prepare("UPDATE conversations SET block_count = ?, source_hash = ?, source_mtime = ? WHERE id = ?")
    .run(result.blocks.length, result.conversation.source_hash, result.conversation.source_mtime, conversationId);
}

async function record(db: SqliteDatabase, id: string, filePath: string): Promise<string> {
  return new ConversationSourceStore(db).recordConversation({
    conversationId: id,
    provider: "codex",
    nativeSessionId: "duplicate-session",
    filePath,
    blocks: (await parse(filePath)).blocks,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
}

describe("versioned conversation source reader", () => {
  it('keeps reused cell continuations bound to their exact exec origin across sparse windows and terminal reconciliation', async () => {
    const db=migratedMemoryDb();
    const file=rolloutPath();
    const response=(payload:Record<string,unknown>)=>({type:'response_item',payload});
    const exec=(id:string,script:string)=>response({type:'custom_tool_call',call_id:id,name:'exec',input:script});
    const wait=(id:string)=>response({type:'function_call',call_id:id,name:'wait',arguments:'{"cell_id":"106"}'});
    const result=(id:string,type:string,output:unknown)=>response({type,call_id:id,output});
    const running='Script running with cell ID 106\nWall time 31.0 seconds\nOutput:\n';
    const completed=[{type:'input_text',text:'Script completed\nWall time 12.3 seconds\nOutput:\n'},{type:'input_text',text:'{"report":"child finished"}'}];
    try {
      writeRecords(file,[records()[0],exec('old','text(await tools.old());'),result('old','custom_tool_call_output',running),
        wait('old-wait'),result('old-wait','function_call_output',completed),
        exec('new','text(await tools.codex_app__wait_threads({targets:[]}));'),result('new','custom_tool_call_output',running),
        wait('new-wait'),result('new-wait','function_call_output',running),
        wait('terminal'),result('terminal','function_call_output',completed),wait('retired')]);
      const parsed=await parse(file);
      insertConversation(db,'cells',file,parsed);
      await record(db,'cells',file);
      const origin=parsed.blocks[6].metadata.display_tool_origin;
      expect(origin?.native_tool_id).toBe('new');
      expect(parsed.blocks[10].metadata.display_tool_origin).toBeUndefined();
      expect(parsed.blocks[5].metadata.display_tool_execution?.state).toBe('completed');
      const reader=new ConversationSourceReader(db);
      for(const positions of [[6],[7],[9],[5,6,7,8,9]]) {
        const read=await reader.readPositions('cells',positions,{maxBatchBytes:1});
        expect(read.status).toBe('source');
        if(read.status!=='source') throw Error(read.reason);
        for(const block of read.value) {
          const metadata=JSON.parse(block.metadata_json);
          expect(metadata.display_tool_origin).toEqual(parsed.blocks[block.position].metadata.display_tool_origin);
          expect(metadata.display_tool_execution).toEqual(parsed.blocks[block.position].metadata.display_tool_execution);
          if(metadata.display_tool_origin) expect(metadata.display_tool_operation?.input).toBe('text(await tools.codex_app__wait_threads({targets:[]}));');
        }
      }
      const bounded=await new CodexParser().parseIncremental({filePath:file,raw:JSON.stringify(wait('late'))+'\n',baseBlockCount:11,baseRecordCount:12,sourceHash:'test',sourceMtime:0});
      expect(bounded).toBeNull();
    } finally {db.close();}
  });

  it('retains a historical yielded observation without inventing current execution from omitted output or results', async () => {
    const file=rolloutPath();
    writeRecords(file,[records()[0],
      {type:'response_item',payload:{type:'custom_tool_call',call_id:'yielded',name:'exec',input:'text(await tools.work());'}},
      {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'yielded',output:'Script running with cell ID 7\nWall time 0.0 seconds\nOutput:\n'}},
      {type:'response_item',payload:{type:'function_call',call_id:'historical-unpaired',name:'other',arguments:'{}'}}]);
    const parsed=await parse(file);
    expect(parsed.blocks[1].metadata.display_tool_frame).toMatchObject({state:'running',wallTimeSeconds:0});
    expect(parsed.blocks[1].metadata.display_tool_execution?.state).toBe('unknown');
    expect(parsed.blocks[2].metadata.display_tool_execution?.state).not.toBe('ongoing');
  });

  it('hydrates overlapping subitems and unrequested tool parents once, returning only ordered unique requested positions', async () => {
    const db = migratedMemoryDb();
    const nativeSessionId = '11111111-1111-4111-8111-111111111111';
    const filePath = path.join(tempDir, '.claude/projects/vector', `${nativeSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const native = [
      {type: 'assistant', uuid: 'calls', sessionId: nativeSessionId, timestamp: '2026-11-02T00:00:00Z',
        message: {id: 'calls', model: 'claude', role: 'assistant', content: [
          {type: 'text', text: 'prepare'}, {type: 'tool_use', id: 'a', name: 'Read', input: {file_path: '/a'}},
          {type: 'tool_use', id: 'b', name: 'Edit', input: {file_path: '/b'}},
        ]}},
      {type: 'user', uuid: 'results', parentUuid: 'calls', sessionId: nativeSessionId, timestamp: '2026-11-02T00:00:01Z',
        message: {role: 'user', content: [
          {type: 'tool_result', tool_use_id: 'a', content: 'read result'}, {type: 'tool_result', tool_use_id: 'b', content: 'edit result'},
        ]}},
    ];
    fs.writeFileSync(filePath, native.map(record => JSON.stringify(record)).join('\n') + '\n');
    try {
      const parsed = await new ClaudeParser().parse(filePath);
      if (!parsed) throw new Error('Native multi-item fixture did not parse.');
      insertConversation(db, 'vector', filePath, parsed);
      db.prepare("UPDATE conversations SET source='claude_code' WHERE id='vector'").run();
      await new ConversationSourceStore(db).recordConversation({conversationId: 'vector', provider: 'claude_code', nativeSessionId,
        filePath, blocks: parsed.blocks, sourceSnapshot: parsed.sourceSnapshot, ...CURRENT_CONVERSATION_SOURCE_EPOCHS});
      const reads: Array<{position: number; length: number}> = [];
      const result = await new ConversationSourceReader(db, {instrumentation: read => reads.push(read)})
        .readPositions('vector', [4, 1, 3, 4], {maxBatchBytes: 1});
      expect(result.status).toBe('source');
      if (result.status !== 'source') throw new Error(result.reason);
      expect(result.value.map(block => [block.position, block.type, block.content])).toEqual([
        [1, 'tool_use', parsed.blocks[1].content], [3, 'tool_result', 'read result'], [4, 'tool_result', 'edit result'],
      ]);
      expect(result.value.slice(1).map(block => JSON.parse(block.metadata_json).chat_item.tool_name)).toEqual(['Read', 'Edit']);
      expect(reads).toHaveLength(2);
    } finally {db.close();}
  });

  it("persists position continuity through identical rebuild and prefix extension, and rotates on invalidation", async () => {
    const db = migratedMemoryDb();
    try {
      const file = rolloutPath();
      writeRecords(file, records());
      insertConversation(db, 'continuity', file, await parse(file));
      const store = new ConversationSourceStore(db);
      await record(db, 'continuity', file);
      const initial = store.resolveConversation('continuity')!;
      await record(db, 'continuity', file);
      expect(new ConversationSourceStore(db).resolveConversation('continuity')).toMatchObject({
        positionSpaceId: initial.positionSpaceId, publicationRevision: initial.publicationRevision + 1,
      });
      const tail = { type: 'response_item', timestamp: '2026-08-17T00:00:04Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'extension' }] } };
      writeRecords(file, records([tail]));
      await record(db, 'continuity', file);
      expect(store.resolveConversation('continuity')?.positionSpaceId).toBe(initial.positionSpaceId);
      expect(store.resolveConversation('continuity')?.currentVersionId).not.toBe(initial.currentVersionId);
      writeRecords(file, records().slice(0, 2));
      await record(db, 'continuity', file);
      const truncated = store.resolveConversation('continuity')!;
      expect(truncated.positionSpaceId).not.toBe(initial.positionSpaceId);
      await store.recordConversation({ conversationId: 'continuity', provider: 'codex', nativeSessionId: 'duplicate-session',
        filePath: file, blocks: (await parse(file)).blocks, ...CURRENT_CONVERSATION_SOURCE_EPOCHS, redactionEpoch: 1 });
      expect(store.resolveConversation('continuity')?.positionSpaceId).not.toBe(truncated.positionSpaceId);
    } finally { db.close(); }
  });

  it('retains an echoed intent identity when a bounded read parses only the earlier prompt record', async () => {
    const db = migratedMemoryDb();
    try {
      const file = rolloutPath();
      writeRecords(file, [records()[0],
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt' }] } }]);
      insertConversation(db, 'intent', file, await parse(file));
      await record(db, 'intent', file);
      const beforeEcho = new ConversationSourceStore(db).resolveConversation('intent')!.positionSpaceId;
      fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'prompt', client_id: 'intent-exact' } })}\n`);
      await record(db, 'intent', file);
      expect(new ConversationSourceStore(db).resolveConversation('intent')!.positionSpaceId).toBe(beforeEcho);
      const page = await new ConversationSourceReader(db).readPage('intent', { offset: 0, limit: 1 });
      expect(page.status).toBe('source');
      if (page.status !== 'source') throw new Error('fixture source unavailable');
      expect(JSON.parse(page.value.blocks[0].metadata_json)).toMatchObject({ client_intent_id: 'intent-exact',
        chat_item: { identity: { native_item_id: 'intent-exact' } } });
    } finally { db.close(); }
  });
  it("preserves source versions, locators and block identities across raw/zstd transitions", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    try {
      const parsed = await parse(filePath);
      insertConversation(db, "compressed", filePath, parsed);
      const version = await record(db, "compressed", filePath);
      const reader = new ConversationSourceReader(db);
      const original = await reader.readAll("compressed");
      expect(original.status).toBe("source");
      const raw = fs.readFileSync(filePath);
      fs.writeFileSync(`${filePath}.zst`, zstdCompressSync(raw));
      fs.unlinkSync(filePath);
      expect((await parse(filePath)).sourceSnapshot?.contentHash).toBe(parsed.sourceSnapshot?.contentHash);
      expect(await reader.readAll("compressed")).toEqual(original);
      expect(await record(db, "compressed", filePath)).toBe(version);
      expect(await reader.readAll("compressed")).toEqual(original);
      fs.writeFileSync(filePath, raw);
      expect(await record(db, "compressed", filePath)).toBe(version);
      expect(await reader.readAll("compressed")).toEqual(original);
      fs.unlinkSync(filePath);
      fs.writeFileSync(`${filePath}.zst`, zstdCompressSync(Buffer.from(raw.toString().replace("duplicate-session", "different-session"))));
      expect((await reader.readAll("compressed")).status).not.toBe("source");
      fs.unlinkSync(`${filePath}.zst`);
      expect((await reader.readAll("compressed")).status).not.toBe("source");
    } finally { db.close(); }
  });

  it("rebuilds identical source block identities from the same transcript", async () => {
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    const snapshots: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const db = migratedMemoryDb();
      try {
        insertConversation(db, "identity-fixture", filePath, parsed);
        await record(db, "identity-fixture", filePath);
        const result = await new ConversationSourceReader(db).readAll("identity-fixture");
        expect(result.status).toBe("source");
        if (result.status !== "source") throw new Error("expected source read");
        snapshots.push(result.value.map((block) => block.id));
      } finally {
        db.close();
      }
    }
    expect(snapshots[0].length).toBeGreaterThan(0);
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("seals the parser extent when the writer appends before source indexing", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    const sourceSnapshot = parsed.sourceSnapshot;
    if (!sourceSnapshot || sourceSnapshot.kind !== "full") {
      throw new Error("full parse did not return its source snapshot");
    }
    insertConversation(db, "conversation-a", filePath, parsed);

    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-17T00:00:04Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "writer tail" }] },
    })}\n`);

    const versionId = await new ConversationSourceStore(db).recordConversation({
      conversationId: "conversation-a",
      provider: "codex",
      nativeSessionId: "duplicate-session",
      filePath,
      expectedContentHash: parsed.conversation.source_hash,
      sourceSnapshot,
      blocks: parsed.blocks.map((block) => ({
        ...block,
        legacyId: `legacy-conversation-a-${block.position}`,
      })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });

    expect(db.prepare(`
      SELECT content_sha256, byte_length FROM conversation_source_versions WHERE id = ?
    `).get(versionId)).toEqual({
      content_sha256: sourceSnapshot.contentHash,
      byte_length: sourceSnapshot.byteLength,
    });
    expect(fs.statSync(filePath).size).toBeGreaterThan(sourceSnapshot.byteLength);

    const read = await new ConversationSourceReader(db).readAll("conversation-a");
    expect(read.status).toBe("source");
    if (read.status !== "source") throw new Error("expected parser-sealed source read");
    expect(read.value.map((block) => block.content)).toEqual(parsed.blocks.map((block) => block.content));
    db.close();
  });

  it("serves the sealed sparse prefix during append growth and rejects an in-place rewrite", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    const versionId = await record(db, "conversation-a", filePath);


    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-17T00:00:04Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new tail" }] },
    })}\n`);
    const reader = new ConversationSourceReader(db);
    const appended = await reader.readPage("conversation-a", { offset: 0, limit: 3 });
    expect(appended.status).toBe("source");
    if (appended.status !== "source") throw new Error("expected verified sparse prefix read");
    expect(appended.sourceVersionId).toBe(versionId);
    expect(appended.value.total).toBe(parsed.blocks.length);
    expect(appended.value.blocks.map((block) => block.content)).toEqual(parsed.blocks.map((block) => block.content));

    const grownBytes = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, grownBytes.replace("hello result", "jello result"));
    const rewritten = await reader.readPage("conversation-a", { offset: 1, limit: 1 });
    expect(rewritten.status).toBe("stale");
    db.close();
  });

  it("rejects truncation, prepend, CRLF conversion, and replacement as stale locators", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const original = fs.readFileSync(filePath);
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    await record(db, "conversation-a", filePath);
    const reader = new ConversationSourceReader(db);

    const mutations: Array<[string, Buffer]> = [
      ["truncation", original.subarray(0, original.length - 5)],
      ["prepend", Buffer.concat([Buffer.from("{}\n"), original])],
      ["crlf", Buffer.from(original.toString("utf8").replaceAll("\n", "\r\n"))],
      ["replacement", Buffer.from(original.toString("utf8").replace("hello result", "jello result"))],
    ];
    for (const [name, bytes] of mutations) {
      fs.writeFileSync(filePath, bytes);
      const result = await reader.readPage("conversation-a", { limit: 20 });
      expect(result.status, name).toBe("stale");
      fs.writeFileSync(filePath, original);
      expect((await reader.readPage("conversation-a", { limit: 20 })).status, `${name} restore`).toBe("source");
    }
    db.close();
  });

  it("does not treat a duplicate provider session id as conversation identity", async () => {
    const db = migratedMemoryDb();
    const first = rolloutPath("rollout-2026-08-17T00-00-00-first.jsonl");
    const second = rolloutPath("rollout-2026-08-17T00-00-00-second.jsonl");
    writeRecords(first, records());
    writeRecords(second, records());
    insertConversation(db, "conversation-a", first, await parse(first));
    insertConversation(db, "conversation-b", second, await parse(second));
    await record(db, "conversation-a", first);
    await record(db, "conversation-b", second);
    expect(db.prepare(`
      SELECT conversation_id FROM conversation_sources
       WHERE provider = 'codex' AND native_session_id = 'duplicate-session'
       ORDER BY conversation_id
    `).all()).toEqual([
      { conversation_id: "conversation-a" },
      { conversation_id: "conversation-b" },
    ]);
    db.close();
  });

  it("uses a full immutable digest rather than the append generation marker", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    db.prepare("UPDATE conversations SET source_hash = ? WHERE id = ?")
      .run("append:123:tail", "conversation-a");
    await record(db, "conversation-a", filePath);
    const version = db.prepare(`
      SELECT content_sha256, generation FROM conversation_source_versions
       WHERE id = (SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?)
    `).get("conversation-a") as { content_sha256: string; generation: string };
    expect(version).toEqual({
      content_sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      generation: "sealed_sha256",
    });
    db.close();
  });
});
