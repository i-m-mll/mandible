import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodexParser } from "../src/parsers/codex.js";

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
  it("uses Codex session_index thread_name as the display title", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-1", {
      threadName: "Find Apple Music to Spotify tool",
    });

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.title).toBe("Find Apple Music to Spotify tool");
    expect(result?.conversation.block_count).toBe(5);
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

  it("surfaces exact context metadata from token_count events", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-context");

    const result = await parser.parse(sessionPath);
    const tokenCount = result?.blocks.find((block) => block.metadata.source_event_type === "token_count");

    expect(tokenCount?.metadata.context_usage).toMatchObject({
      source: "mirror_exact",
      used_tokens: 2000,
      total_tokens: 2000,
      window_tokens: 10_000,
      percent: 20,
      approximate: false,
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
