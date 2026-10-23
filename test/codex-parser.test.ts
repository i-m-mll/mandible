import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodexParser, loadCodexNativeSessionId } from "../src/parsers/codex.js";

const tempRoots: string[] = [];

async function makeCodexSession(
  sessionId: string,
  options: { threadName?: string } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-codex-parser-"));
  tempRoots.push(root);

  const codexRoot = path.join(root, ".codex");
  const sessionDir = path.join(codexRoot, "sessions", "2026", "05", "16");
  await fs.mkdir(sessionDir, { recursive: true });

  if (options.threadName) {
    await fs.writeFile(
      path.join(codexRoot, "session_index.jsonl"),
      `${JSON.stringify({ id: sessionId, thread_name: options.threadName })}\n`,
      "utf8",
    );
  }

  const sessionPath = path.join(sessionDir, `rollout-2026-05-16T00-00-00-${sessionId}.jsonl`);
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-05-16T00:00:00.000Z",
      payload: {
        id: sessionId,
        cwd: "/tmp/project",
        model_provider: "openai",
        git: { branch: "main" },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-16T00:00:01.000Z",
      payload: { type: "user_message", message: "Fallback prompt title" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-16T00:00:02.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fallback response title" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-16T00:00:03.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Assistant response." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-16T00:00:03.500Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 300,
            output_tokens: 500,
          },
          model_context_window: 10_000,
        },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-16T00:00:04.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: "{\"cmd\":\"date\"}",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-16T00:00:05.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "today",
      },
    },
  ];
  await fs.writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return sessionPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("CodexParser", () => {
  it("bounds native identity probes to the source prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-codex-identity-"));
    tempRoots.push(root);
    const sessionPath = path.join(root, "legacy.jsonl");
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message" } })}\n${"x".repeat(300_000)}\n${JSON.stringify({ type: "session_meta", payload: { id: "too-late" } })}\n`,
      "utf8",
    );

    expect(await loadCodexNativeSessionId(sessionPath)).toBeNull();
  });

  it("uses Codex session_index thread_name as the display title", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-1", {
      threadName: "Find Apple Music to Spotify tool",
    });

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.title).toBe("Find Apple Music to Spotify tool");
    expect(result?.conversation.block_count).toBe(5);
  });

  it("keeps the first session_meta identity when a fork embeds parent history", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("fork-owner");
    await fs.appendFile(sessionPath, `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-05-15T23:59:00.000Z",
      payload: { id: "embedded-parent", cwd: "/tmp/parent", model_provider: "openai" },
    })}\n`, "utf8");

    expect(await loadCodexNativeSessionId(sessionPath)).toBe("fork-owner");
    expect((await parser.parse(sessionPath))?.conversation).toMatchObject({
      session_id: "fork-owner",
    });
  });

  it("falls back to the first user_message event when session_index has no title", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-2");

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.title).toBe("Fallback prompt title");
  });

  it("normalizes tool names and kinds on tool calls and results", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-tools");

    const result = await parser.parse(sessionPath);
    const toolUse = result?.blocks.find((block) => block.type === "tool_use");
    const toolResult = result?.blocks.find((block) => block.type === "tool_result");

    expect(toolUse?.metadata).toMatchObject({
      tool_name: "exec_command",
      tool_kind: "function_call",
      tool_input: { cmd: "date" },
    });
    expect(toolResult?.metadata).toMatchObject({
      tool_name: "exec_command",
      tool_kind: "function_call_output",
      tool_output: "today",
    });
  });

  it("keeps provider transport output out of the transcript while preserving genuine orphans", async () => {
    const parser = new CodexParser();
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/provider-output.jsonl",
      raw: [
        {
          type: "response_item",
          timestamp: "2026-05-16T00:00:06.000Z",
          payload: {
            type: "function_call_output",
            call_id: null,
            output: "provider delegation receipt",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-16T00:00:07.000Z",
          payload: {
            type: "function_call_output",
            call_id: "orphan-call",
            output: "orphan tool output",
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      baseBlockCount: 0,
      baseRecordCount: 40,
      sourceHash: "append:provider-output",
      sourceMtime: 42,
    });

    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]).toMatchObject({
      type: "tool_result",
      content: "orphan tool output",
      parent_id: null,
      metadata: {
        tool_id: "orphan-call",
        tool_kind: "function_call_output",
        source_record_ordinal: 41,
        source_sub_block_ordinal: 0,
      },
    });
  });

  it("projects the strict create_thread delegation input as the visible launch prompt", async () => {
    const parser = new CodexParser();
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/delegated-task.jsonl",
      raw: [
        {
          type: "response_item",
          timestamp: "2026-09-13T00:00:00.000Z",
          payload: {
            type: "function_call_output",
            name: "create_thread",
            call_id: null,
            output: [
              "<codex_delegation>",
              "  <source_thread_id>parent-task</source_thread_id>",
              "  <input>Repair the stream &amp; preserve &lt;exact&gt; content.</input>",
              "</codex_delegation>",
            ].join("\n"),
          },
        },
        {
          type: "response_item",
          timestamp: "2026-09-13T00:00:00.001Z",
          payload: {
            type: "function_call_output",
            name: "create_thread",
            call_id: null,
            output: "unstructured provider receipt",
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      baseBlockCount: 0,
      baseRecordCount: 8,
      sourceHash: "append:delegated-task",
      sourceMtime: 42,
    });

    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]).toMatchObject({
      type: "user_message",
      role: "user",
      content: "Repair the stream & preserve <exact> content.",
      position: 0,
      metadata: {
        source_event_type: "codex_delegation",
        source_record_ordinal: 8,
        source_sub_block_ordinal: 0,
        chat_item: {
          type: "message",
          role: "user",
          parts: [{ type: "text", text: "Repair the stream & preserve <exact> content." }],
        },
      },
    });
  });

  it("preserves opaque custom tool input byte-for-byte", async () => {
    const parser = new CodexParser();
    const rawInput = '{"path":"a\\nb","literal":"  x  ","shell":"$(never-run)"}';
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/custom-tool.jsonl",
      raw: `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-16T00:00:06.000Z",
        payload: { type: "custom_tool_call", name: "apply_patch", call_id: "custom-1", input: rawInput },
      })}\n`,
      baseBlockCount: 0,
      sourceHash: "append:custom",
      sourceMtime: 42,
    });

    expect(result?.blocks[0]?.metadata).toMatchObject({
      tool_kind: "custom_tool_call",
      tool_input: rawInput,
    });
  });

  it("normalizes structured custom tool output and preserves same-batch pairing", async () => {
    const parser = new CodexParser();
    const rows = [
      {
        type: "response_item",
        timestamp: "2026-05-16T00:00:06.000Z",
        payload: { type: "custom_tool_call", name: "exec", call_id: "custom-structured", input: "opaque" },
      },
      {
        type: "response_item",
        timestamp: "2026-05-16T00:00:07.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "custom-structured",
          output: [
            { type: "input_text", text: "first line" },
            { type: "input_text", text: "second line" },
          ],
        },
      },
    ];
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/custom-tool-output.jsonl",
      raw: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      nativeSessionId: "structured-output-session",
      baseBlockCount: 10,
      baseRecordCount: 30,
      sourceHash: "append:custom-output",
      sourceMtime: 42,
    });

    expect(result?.blocks).toHaveLength(2);
    expect(result?.blocks[1]).toMatchObject({
      type: "tool_result",
      content: "first line\nsecond line",
      parent_id: "10",
      metadata: {
        tool_id: "custom-structured",
        tool_name: "exec",
        tool_kind: "custom_tool_call_output",
        tool_output: "first line\nsecond line",
        source_record_ordinal: 31,
      },
    });
    expect(result?.blocks[1].metadata.chat_item).toMatchObject({
      type: "tool-call",
      phase: "result",
      tool_id: "custom-structured",
      output: "first line\nsecond line",
      parts: [{ type: "text", text: "first line\nsecond line" }],
    });
  });

  it("parses appended records at the requested base position", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-incremental");

    const result = await parser.parseIncremental?.({
      filePath: sessionPath,
      raw: `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-16T00:00:06.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Incremental answer." }],
        },
      })}\n`,
      baseBlockCount: 4,
      sourceHash: "append:hash",
      sourceMtime: 42,
    });

    expect(result?.conversation.block_count).toBe(5);
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]).toMatchObject({
      type: "assistant_message",
      position: 4,
      content: "Incremental answer.",
    });
  });

  it("preserves exact provider message identity for live reconciliation", async () => {
    const parser = new CodexParser();
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/provider-message.jsonl",
      raw: `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-16T00:00:06.000Z",
        payload: {
          type: "message",
          id: "provider-message-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Reconciled answer." }],
        },
      })}\n`,
      baseBlockCount: 0,
      sourceHash: "append:provider-message",
      sourceMtime: 42,
    });

    expect(result?.blocks[0]).toMatchObject({
      dag_uuid: "provider-message-1",
      metadata: { provider_message_id: "provider-message-1" },
    });
  });

  it("keeps injected startup context hidden and binds the visible prompt to its client intent", async () => {
    const parser = new CodexParser();
    const providerTurnId = "provider-turn-1";
    const clientIntentId = "client-intent-1";
    const result = await parser.parseIncremental?.({
      filePath: "/tmp/provider-user-message.jsonl",
      raw: [
        {
          type: "response_item",
          timestamp: "2026-09-11T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<recommended_plugins>plugins</recommended_plugins>" },
              { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>policy</INSTRUCTIONS>" },
              { type: "input_text", text: "<environment_context>workspace</environment_context>" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
          },
        },
        {
          type: "response_item",
          timestamp: "2026-09-11T00:00:00.001Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Visible prompt" }],
            internal_chat_message_metadata_passthrough: { turn_id: providerTurnId },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-09-11T00:00:00.002Z",
          payload: { type: "user_message", client_id: clientIntentId, message: "Visible prompt" },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      baseBlockCount: 0,
      sourceHash: "append:provider-user-message",
      sourceMtime: 42,
    });

    expect(result?.blocks).toEqual([
      expect.objectContaining({
        type: "system",
        role: "system",
        metadata: expect.objectContaining({
          source_event_type: "user_meta",
          visibility: "default_hidden",
          provider_turn_id: providerTurnId,
        }),
      }),
      expect.objectContaining({
        type: "user_message",
        role: "user",
        content: "Visible prompt",
        dag_uuid: clientIntentId,
        metadata: expect.objectContaining({
          source_event_type: "user",
          provider_turn_id: providerTurnId,
          client_intent_id: clientIntentId,
          chat_item: expect.objectContaining({ identity: expect.objectContaining({ native_item_id: clientIntentId }) }),
        }),
      }),
    ]);
  });

  it("preserves Codex accounting and capacity without inferring current context", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-context");

    const result = await parser.parse(sessionPath);
    const tokenCount = result?.blocks.find((block) => block.metadata.source_event_type === "token_count");

    expect(tokenCount).toMatchObject({
      type: "event",
      role: "system",
      content: "token_count",
      metadata: {
        source_event_type: "token_count",
        visibility: "default_hidden",
      },
    });
    expect(tokenCount?.metadata.usage_telemetry).toMatchObject({
      provider: "codex",
      provenance: "codex_token_count",
      currentContext: { availability: "unavailable" },
      modelWindowTokens: 10_000,
      accounting: [{
        scope: "task_total",
        inputTokens: 1200,
        cachedInputTokens: 300,
        outputTokens: 500,
        totalTokens: 1700,
      }],
    });
  });

  it("normalizes ordered reasoning summaries and execution status as canonical Chat items", async () => {
    const result = await new CodexParser().parseIncremental?.({
      filePath: "/tmp/canonical-codex-items.jsonl",
      raw: [
        {
          type: "session_meta",
          payload: { id: "codex-canonical" },
        },
        {
          type: "response_item",
          timestamp: "2026-09-11T00:00:00.000Z",
          payload: {
            type: "reasoning",
            id: "reasoning-1",
            summary: [
              { type: "summary_text", text: "First summary part" },
              { type: "summary_text", text: "Second summary part" },
            ],
            content: [{ type: "reasoning_text", text: "Readable reasoning" }],
            encrypted_content: "must-not-be-exposed",
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-09-11T00:00:01.000Z",
          payload: { type: "turn_aborted", turn_id: "turn-1", reason: "Interrupted" },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
      baseBlockCount: 0,
      baseRecordCount: 20,
      sourceHash: "codex-canonical",
      sourceMtime: 1,
    });

    expect(result?.blocks).toHaveLength(3);
    expect(result?.blocks[0].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "reasoning-summary",
      identity: {
        provider: "codex",
        session_id: "codex-canonical",
        native_item_id: "reasoning-1",
        source_record_ordinal: 21,
        source_sub_block_ordinal: 0,
      },
      parts: [
        { type: "text", text: "First summary part", native_index: 0 },
        { type: "text", text: "Second summary part", native_index: 1 },
      ],
      content_completion: "complete",
    });
    expect(result?.blocks[1].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "thinking",
      parts: [{ text: "Readable reasoning" }],
    });
    expect(JSON.stringify(result?.blocks)).not.toContain("must-not-be-exposed");
    expect(result?.blocks[2].metadata.chat_item).toMatchObject({
      type: "activity",
      activity_kind: "diagnostic",
      status: "aborted",
      execution_outcome: "cancelled",
      identity: { native_turn_id: "turn-1" },
    });
  });

  it("streams large transcripts and tolerates a truncated final row", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-codex-large-parser-"));
    tempRoots.push(root);
    const sessionDir = path.join(root, ".codex", "sessions", "2026", "05", "16");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "rollout-large-session.jsonl");
    const rows = [{
      type: "session_meta",
      timestamp: "2026-05-16T00:00:00.000Z",
      payload: { id: "large-codex", cwd: "/tmp/project" },
    }, {
      type: "event_msg",
      timestamp: "2026-05-16T00:00:00.500Z",
      payload: { type: "user_message", message: "Large Codex prompt" },
    }, ...Array.from({ length: 5_000 }, (_, index) => ({
      type: "response_item",
      timestamp: `2026-05-16T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer-${index}` }],
      },
    }))];
    const raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"type":"truncated"`;
    await fs.writeFile(sessionPath, raw, "utf8");

    const result = await new CodexParser().parse(sessionPath);

    expect(result?.blocks).toHaveLength(5_000);
    expect(result?.conversation.title).toBe("Large Codex prompt");
    expect(result?.conversation.source_hash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
  });
});
