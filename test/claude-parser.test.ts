import { afterEach, describe, expect, it } from "vitest";
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
});
