import { displayChatItem } from '../src/presentation/model.js';
import { projectNativeToolResult } from '../src/presentation/tool-transport.js';
import { projectDisplayBlock } from '../src/conversations/display-block.js';
import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeParser } from "../src/parsers/claude.js";

async function parseNativeRows(rows: Record<string, unknown>[]) {
  const file = await makeClaudeSession();
  await fs.writeFile(file, rows.map((row) => JSON.stringify({sessionId:'11111111-1111-4111-8111-111111111111',timestamp:'2026-05-16T00:00:00.000Z', ...row})).join('\n') + '\n');
  return (await new ClaudeParser().parse(file))!.blocks;
}

const tempRoots: string[] = [];

describe('Claude native display evidence', () => {
  it('projects both command envelope generations without changing transcript identity or losing output', async () => {
    const invocation = '<command-name>/memory</command-name>\n <command-message>memory</command-message>\n <command-args>project</command-args>';
    const body = 'Updated memory\n\nFile: project.md\nKept all entries';
    for (const modern of [false, true]) {
      const envelope = (uuid:string, content:string, parentUuid?:string) => modern
        ? {uuid,parentUuid,type:'system',subtype:'local_command',content}
        : {uuid,parentUuid,type:'user',message:{role:'user',content}};
      const blocks = await parseNativeRows([
        envelope('invoke',invocation),
        envelope('out',`<local-command-stdout>${body}</local-command-stdout>`,'invoke'),
        envelope('err','<local-command-stderr>Permission denied</local-command-stderr>','invoke'),
        {uuid:'ordinary',type:'user',message:{role:'user',content:`Explain this example: ${invocation}`}},
      ]);
      expect(blocks).toHaveLength(4);
      const raw = blocks.map(block => JSON.stringify(block));
      const displayed = blocks.map(block => displayChatItem(block.metadata.chat_item!,block.metadata));
      expect(displayed.map(item => item.role)).toEqual(['user','system','system','user']);
      expect(displayed[0].parts.map(part => part.text)).toEqual(['/memory project']);
      expect(displayed[1].parts.map(part => part.text).join('\n\n')).toBe(body);
      expect(displayed[2].type === 'activity' && displayed[2].local_command?.stream).toBe('stderr');
      expect(displayed.map(item => item.identity)).toEqual(blocks.map(block => block.metadata.chat_item!.identity));
      expect(blocks.map(block => JSON.stringify(block))).toEqual(raw);
      expect(blocks[0].content).toBe(invocation);
      expect(blocks[1].metadata.display_local_command).toMatchObject({kind:'output',invocationUuid:'invoke',commandName:'/memory',hasBody:true});
      expect(blocks[3].metadata.display_local_command).toBeUndefined();
      expect(displayed[3]).toBe(blocks[3].metadata.chat_item);
      const block = blocks[1];
      const compact = projectDisplayBlock({...block,id:'cblk:chat:1',conversation_id:'chat',timestamp:block.timestamp ?? null,parent_id:block.parent_id ?? null,dag_uuid:block.dag_uuid ?? null,dag_parent_uuid:block.dag_parent_uuid ?? null,locator:null,metadata_json:JSON.stringify(block.metadata)});
      const metadata = JSON.parse(compact.metadata_json);
      expect(metadata.display_has_body).toBe(true);
      expect(compact.content).toBe('');
      expect(JSON.stringify(metadata)).not.toContain('Kept all entries');
      expect(displayChatItem(metadata.chat_item,metadata).parts).toEqual([displayed[1].parts[0]]);
    }
  });

  it('carries scoped native agent targets and distinguishes continuation without guessing named IDs', async () => {
    const blocks = await parseNativeRows([
      {uuid:'calls',type:'assistant',message:{role:'assistant',content:[
        {type:'tool_use',id:'create',name:'Agent',input:{description:'Inspect settings',prompt:'Inspect'}},
        {type:'tool_use',id:'resume',name:'Task',input:{description:'Continue inspection',resume:'agent-existing'}},
        {type:'tool_use',id:'named',name:'Agent',input:{description:'Message colleague',to:'reviewer'}},
      ]}},
      {uuid:'result',type:'user',parentUuid:'calls',toolUseResult:{agentId:'agent-new',description:'Inspect settings',status:'async_launched'},message:{role:'user',content:[{type:'tool_result',tool_use_id:'create',content:'Background agent launched'}]}},
    ]);
    expect(blocks.map(block => block.metadata.display_tool_operation_kind)).toEqual(['subagent-create','subagent-resume','subagent-resume','subagent-create']);
    expect(blocks[0].metadata.display_tool_targets).toEqual(blocks[3].metadata.display_tool_targets);
    expect(blocks[0].metadata.display_tool_targets).toEqual([{kind:'subagent',provider:'claude_code',parentSessionId:'11111111-1111-4111-8111-111111111111',agentId:'agent-new',labelHint:'Inspect settings'}]);
    expect(blocks[1].metadata.display_tool_targets?.[0]).toMatchObject({agentId:'agent-existing',labelHint:'Continue inspection'});
    expect(blocks[2].metadata.display_tool_targets).toBeUndefined();
    const resultOnly = await parseNativeRows([{uuid:'result',type:'user',toolUseResult:{agentId:'agent-new',description:'Inspect settings'},message:{role:'user',content:[{type:'tool_result',tool_use_id:'create',content:'Background agent launched'}]}}]);
    expect(resultOnly[0].metadata.display_tool_targets).toEqual(blocks[3].metadata.display_tool_targets);
    expect(resultOnly[0].metadata.display_tool_operation_kind).toBeUndefined();
  });
});

async function makeClaudeSession(richResult = false): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-claude-parser-"));
  tempRoots.push(root);
  const dir = path.join(root, ".claude", "projects", "-tmp-project");
  await fs.mkdir(dir, { recursive: true });
  const sessionPath = path.join(dir, "11111111-1111-4111-8111-111111111111.jsonl");
  const rows = [
    {
      uuid: "u1",
      type: "user",
      timestamp: "2026-05-16T00:00:00.000Z",
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "/tmp/project",
      message: { role: "user", content: "Please list files" },
    },
    {
      uuid: "a1",
      parentUuid: "u1",
      type: "assistant",
      timestamp: "2026-05-16T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus",
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 250,
          cache_creation_input_tokens: 750,
          output_tokens: 100,
        },
        content: [
          { type: "text", text: "I will inspect." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      uuid: "u2",
      parentUuid: "a1",
      type: "user",
      timestamp: "2026-05-16T00:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: richResult ? [{type:'text',text:'README.md'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}] : 'README.md', ...(richResult ? {is_error:true} : {}) }],
      },
    },
  ];
  await fs.writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return sessionPath;
}

async function makeClaudeSubagentSession(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-claude-subagent-parser-"));
  tempRoots.push(root);
  const dir = path.join(
    root,
    ".claude",
    "projects",
    "-tmp-project",
    "22222222-2222-4222-8222-222222222222",
    "subagents",
  );
  await fs.mkdir(dir, { recursive: true });
  const sessionPath = path.join(dir, "agent-alpha.jsonl");
  const rows = [
    {
      uuid: "s1",
      type: "user",
      timestamp: "2026-05-16T00:00:00.000Z",
      sessionId: "child-session",
      cwd: "/tmp/project",
      isSidechain: true,
      message: { role: "user", content: "You are a subagent." },
    },
    {
      uuid: "s2",
      type: "assistant",
      timestamp: "2026-05-16T00:00:01.000Z",
      isSidechain: true,
      message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "Done." }] },
    },
  ];
  await fs.writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return sessionPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ClaudeParser", () => {
  it("normalizes tool names and kinds on tool calls and results", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();

    const result = await parser.parse(sessionPath);
    const toolUse = result?.blocks.find((block) => block.type === "tool_use");
    const toolResult = result?.blocks.find((block) => block.type === "tool_result");

    expect(toolUse?.metadata).toMatchObject({
      tool_name: "Bash",
      tool_kind: "claude_tool_use",
      tool_input: { command: "ls" },
    });
    expect(toolResult?.metadata).toMatchObject({
      tool_name: "Bash",
      tool_kind: "claude_tool_result",
      tool_output: "README.md",
    });
  });

  it('retains native result media and errors only in hydrated display evidence', async () => {
    const parsed=await new ClaudeParser().parse(await makeClaudeSession(true));
    const block=parsed!.blocks.find(block=>block.type==='tool_result')!;
    expect(block.content).toBe('README.md\n');
    expect(block.metadata.chat_item?.parts.map(part=>part.text).join('\n')).toBe('README.md\n');
    const display=displayChatItem(block.metadata.chat_item!,block.metadata);
    expect(display.type).toBe('tool-call');
    if(display.type!=='tool-call') throw new Error('Missing native tool result');
    const result=projectNativeToolResult(display.output,block.content,display.tool_kind,display.tool_name,display.tool_id);
    expect(display.execution_outcome).toBe('failed');
    expect(result.content).toEqual([{type:'text',text:'README.md'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}]);
    const lean=projectDisplayBlock({...block,id:'cblk:chat:4',conversation_id:'chat',timestamp:block.timestamp ?? null,parent_id:block.parent_id ?? null,dag_uuid:null,dag_parent_uuid:null,locator:null,metadata_json:JSON.stringify(block.metadata)});
    expect(lean.metadata_json).not.toContain('aW1hZ2U=');
  });

  it("marks Claude Code subagent paths as sidechain conversations", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSubagentSession();

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.is_sidechain).toBe(true);
    expect(result?.conversation.agent_id).toBe("alpha");
    expect(result?.conversation.project_path).toBe("-tmp-project");
  });

  it("parses appended records at the requested base position", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();

    const result = await parser.parseIncremental?.({
      filePath: sessionPath,
      raw: `${JSON.stringify({
        uuid: "a2",
        parentUuid: "u2",
        type: "assistant",
        timestamp: "2026-05-16T00:00:03.000Z",
        sessionId: "11111111-1111-4111-8111-111111111111",
        message: {
          role: "assistant",
          model: "claude-opus",
          content: [{ type: "text", text: "Incremental Claude answer." }],
        },
      })}\n`,
      baseBlockCount: 3,
      sourceHash: "append:hash",
      sourceMtime: 42,
    });

    expect(result?.conversation.block_count).toBe(4);
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]).toMatchObject({
      type: "assistant_message",
      position: 3,
      content: "Incremental Claude answer.",
    });
  });

  it("prefers the latest valid provider custom title over generated index titles", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();
    await fs.writeFile(
      path.join(path.dirname(sessionPath), "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{
          sessionId: "11111111-1111-4111-8111-111111111111",
          fullPath: sessionPath,
          summary: "Generated summary",
          firstPrompt: "Generated first prompt",
        }],
      }),
      "utf8",
    );
    await fs.appendFile(sessionPath, [
      JSON.stringify({ type: "custom-title", customTitle: "First provider title" }),
      JSON.stringify({ type: "custom-title", customTitle: "   " }),
      JSON.stringify({ type: "custom-title", customTitle: "Latest provider title" }),
      "",
    ].join("\n"), "utf8");

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.title).toBe("Latest provider title");
    expect(result?.conversation.summary).toBe("Generated summary");
    expect(result?.providerTitle).toBe("Latest provider title");
    expect(result?.providerTitleSource).toBe("custom-title");
  });

  it("uses Claude's ai-title instead of a continued-session preamble while preserving custom-title precedence", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();
    const continuedPreamble = "This session is being continued from a previous conversation that ran out of context.";
    await fs.writeFile(sessionPath, [
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Review and take over QA successor briefing task",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
      JSON.stringify({
        uuid: "continued-user",
        type: "user",
        timestamp: "2026-05-16T00:00:00.000Z",
        sessionId: "11111111-1111-4111-8111-111111111111",
        message: { role: "user", content: continuedPreamble },
      }),
      JSON.stringify({
        uuid: "continued-assistant",
        parentUuid: "continued-user",
        type: "assistant",
        timestamp: "2026-05-16T00:00:01.000Z",
        sessionId: "11111111-1111-4111-8111-111111111111",
        message: { role: "assistant", content: "Resuming." },
      }),
      "",
    ].join("\n"), "utf8");

    const generated = await parser.parse(sessionPath);

    expect(generated?.conversation.title).toBe("Review and take over QA successor briefing task");
    expect(generated?.conversation.title).not.toContain("This session is being continued");
    expect(generated?.providerTitle).toBe("Review and take over QA successor briefing task");
    expect(generated?.providerTitleSource).toBe("ai-title");

    await fs.appendFile(sessionPath, [
      JSON.stringify({ type: "custom-title", customTitle: "Explicit operator title" }),
      JSON.stringify({ type: "ai-title", aiTitle: "Later generated title" }),
      "",
    ].join("\n"), "utf8");
    const renamed = await parser.parse(sessionPath);

    expect(renamed?.conversation.title).toBe("Explicit operator title");
    expect(renamed?.providerTitle).toBe("Explicit operator title");
    expect(renamed?.providerTitleSource).toBe("custom-title");
  });

  it("preserves Claude message accounting without inferring current context", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();

    const result = await parser.parse(sessionPath);
    const assistant = result?.blocks.find((block) => block.type === "assistant_message");

    expect(assistant?.metadata.usage_telemetry).toMatchObject({
      provider: "claude",
      provenance: "claude_transcript",
      currentContext: { availability: "unavailable" },
      model: "claude-opus",
      accounting: [{
        scope: "message",
        inputTokens: 1000,
        cacheReadInputTokens: 250,
        cacheCreationInputTokens: 750,
        outputTokens: 100,
        totalTokens: 2100,
      }],
    });
  });

  it("preserves sibling identities and top-level activity in canonical Chat items", async () => {
    const result = await new ClaudeParser().parseIncremental?.({
      filePath: "/tmp/canonical-claude-items.jsonl",
      raw: [
        {
          uuid: "assistant-record",
          type: "assistant",
          sessionId: "claude-canonical",
          timestamp: "2026-09-11T00:00:00.000Z",
          message: {
            id: "message-1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Consider the evidence", signature: "private-signature" },
              { type: "text", text: "Visible answer" },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file: "a.ts" } },
            ],
          },
        },
        {
          uuid: "progress-record",
          type: "tool_progress",
          session_id: "claude-canonical",
          timestamp: "2026-09-11T00:00:01.000Z",
          tool_use_id: "tool-1",
          tool_name: "Read",
          elapsed_time_seconds: 1.5,
        },
        {
          uuid: "summary-record",
          type: "tool_use_summary",
          session_id: "claude-canonical",
          timestamp: "2026-09-11T00:00:02.000Z",
          summary: "Read the requested file",
          preceding_tool_use_ids: ["tool-1"],
        },
        {
          uuid: "information-record",
          type: "system",
          subtype: "informational",
          sessionId: "claude-canonical",
          timestamp: "2026-09-11T00:00:03.000Z",
          content: "Provider notice",
          level: "notice",
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      baseBlockCount: 0,
      baseRecordCount: 10,
      sourceHash: "claude-canonical",
      sourceMtime: 1,
    });

    expect(result?.blocks).toHaveLength(6);
    expect(result?.blocks.slice(0, 3).map((block) => block.metadata.chat_item?.identity)).toEqual([
      expect.objectContaining({ native_item_id: "message-1", native_content_index: 0, source_sub_block_ordinal: 0 }),
      expect.objectContaining({ native_item_id: "message-1", native_content_index: 1, source_sub_block_ordinal: 1 }),
      expect.objectContaining({ native_item_id: "message-1", native_content_index: 2, native_tool_id: "tool-1", source_sub_block_ordinal: 2 }),
    ]);
    expect(result?.blocks[3].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "tool-progress",
      parts: [],
      elapsed_ms: 1500,
      tool_name: "Read",
      tool_id: "tool-1",
    });
    expect(result?.blocks[4].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "tool-summary",
      parts: [{ text: "Read the requested file" }],
      related_tool_ids: ["tool-1"],
    });
    expect(result?.blocks[5].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "information",
      parts: [{ text: "Provider notice" }],
    });
  });

  it("streams large transcripts and tolerates a truncated final row", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-claude-large-parser-"));
    tempRoots.push(root);
    const dir = path.join(root, ".claude", "projects", "-tmp-project");
    await fs.mkdir(dir, { recursive: true });
    const sessionPath = path.join(dir, "large-session.jsonl");
    const rows = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
      uuid: `row-${index}`,
      type: index === 0 ? "user" : "assistant",
      timestamp: `2026-05-16T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      sessionId: "large-session",
      message: index === 0
        ? { role: "user", content: "Large Claude prompt" }
        : { role: "assistant", content: `answer-${index}` },
    }));
    const raw = `${rows.join("\n")}\n{"uuid":"truncated"`;
    await fs.writeFile(sessionPath, raw, "utf8");

    const result = await new ClaudeParser().parse(sessionPath);

    expect(result?.blocks).toHaveLength(5_000);
    expect(result?.conversation.title).toBe("Large Claude prompt");
    expect(result?.conversation.source_hash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
  });
});
