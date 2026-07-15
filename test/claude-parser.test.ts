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

  it("computes approximate context from Claude effective input tokens", async () => {
    const parser = new ClaudeParser();
    const sessionPath = await makeClaudeSession();

    const result = await parser.parse(sessionPath);
    const assistant = result?.blocks.find((block) => block.type === "assistant_message");

    expect(assistant?.metadata.context_usage).toMatchObject({
      source: "mirror_approx",
      used_tokens: 2000,
      total_tokens: 2100,
      window_tokens: 200_000,
      percent: 1,
      approximate: true,
      model: "claude-opus",
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
