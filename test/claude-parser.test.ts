import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeParser } from "../src/parsers/claude.js";

const tempRoots: string[] = [];

async function makeClaudeSession(): Promise<string> {
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
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README.md" }],
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
