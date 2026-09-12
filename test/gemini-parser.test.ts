import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GeminiParser } from "../src/parsers/gemini.js";

const tempRoots: string[] = [];

async function makeGeminiSession(options: {
  tmpName: string;
  projectRoot?: string;
  projectsJson?: Record<string, string>;
  projectHash?: string;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-gemini-parser-"));
  tempRoots.push(root);

  const geminiRoot = path.join(root, ".gemini");
  const projectDir = path.join(geminiRoot, "tmp", options.tmpName);
  const chatDir = path.join(projectDir, "chats");
  await fs.mkdir(chatDir, { recursive: true });

  if (options.projectRoot) {
    await fs.writeFile(path.join(projectDir, ".project_root"), options.projectRoot, "utf8");
  }
  if (options.projectsJson) {
    await fs.writeFile(
      path.join(geminiRoot, "projects.json"),
      JSON.stringify({ projects: options.projectsJson }, null, 2),
      "utf8",
    );
  }

  const sessionPath = path.join(chatDir, "session-2026-05-16T00-00-abcdef12.json");
  await fs.writeFile(
    sessionPath,
    JSON.stringify({
      sessionId: "abcdef12-0000-4000-8000-000000000000",
      projectHash: options.projectHash,
      startTime: "2026-05-16T00:00:00.000Z",
      lastUpdated: "2026-05-16T00:00:01.000Z",
      messages: [
        {
          id: "u1",
          type: "user",
          timestamp: "2026-05-16T00:00:00.000Z",
          content: "Review this Gemini project",
        },
        {
          id: "g1",
          type: "gemini",
          timestamp: "2026-05-16T00:00:01.000Z",
          model: "gemini-2.5-pro",
          content: "Done.",
        },
      ],
    }),
    "utf8",
  );
  return sessionPath;
}

async function makeGeminiJsonlSession(options: {
  tmpName: string;
  projectRoot?: string;
  projectHash?: string;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-gemini-parser-"));
  tempRoots.push(root);

  const geminiRoot = path.join(root, ".gemini");
  const projectDir = path.join(geminiRoot, "tmp", options.tmpName);
  const chatDir = path.join(projectDir, "chats");
  await fs.mkdir(chatDir, { recursive: true });

  if (options.projectRoot) {
    await fs.writeFile(path.join(projectDir, ".project_root"), options.projectRoot, "utf8");
  }

  const sessionPath = path.join(chatDir, "session-2026-05-16T00-00-jsonl12.jsonl");
  const lines = [
    {
      sessionId: "jsonl12-0000-4000-8000-000000000000",
      projectHash: options.projectHash,
      startTime: "2026-05-16T00:00:00.000Z",
      lastUpdated: "2026-05-16T00:00:00.000Z",
      kind: "main",
    },
    {
      id: "u1",
      type: "user",
      timestamp: "2026-05-16T00:00:00.000Z",
      content: [{ text: "Review this Gemini JSONL project" }],
    },
    {
      id: "g1",
      type: "gemini",
      timestamp: "2026-05-16T00:00:01.000Z",
      model: "gemini-3.1-pro-preview",
      plan: "Check the file before answering.",
      content: [{ text: "Done from JSONL." }],
      toolCalls: [
        {
          id: "tool-1",
          name: "read_file",
          args: { path: "README.md" },
          result: "contents",
        },
      ],
      tokens: { input: 4, output: 5, cached: 0 },
    },
    {
      $set: { lastUpdated: "2026-05-16T00:00:02.000Z" },
    },
  ];
  await fs.writeFile(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  return sessionPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("GeminiParser", () => {
  it("uses Gemini .project_root sidecars instead of project hashes", async () => {
    const parser = new GeminiParser();
    const sessionPath = await makeGeminiSession({
      tmpName: "feature-part2-5-experiment",
      projectRoot: "/workspace/rlrmp/worktrees/feature__part2.5-experiment",
      projectHash: crypto.createHash("sha256").update("/workspace/rlrmp/worktrees/feature__part2.5-experiment").digest("hex"),
    });

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.project_path).toBe("/workspace/rlrmp/worktrees/feature__part2.5-experiment");
    expect(result?.conversation.cwd).toBe("/workspace/rlrmp/worktrees/feature__part2.5-experiment");
  });

  it("maps old hash directories back through Gemini projects.json", async () => {
    const parser = new GeminiParser();
    const projectRoot = "/workspace/HumbleB";
    const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex");
    const sessionPath = await makeGeminiSession({
      tmpName: projectHash,
      projectHash,
      projectsJson: { [projectRoot]: "humbleb" },
    });

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.project_path).toBe(projectRoot);
    expect(result?.conversation.cwd).toBe(projectRoot);
  });

  it("parses newer Gemini JSONL session streams", async () => {
    const parser = new GeminiParser();
    const sessionPath = await makeGeminiJsonlSession({
      tmpName: "mandible",
      projectRoot: "/workspace/mandible",
      projectHash: crypto.createHash("sha256").update("/workspace/mandible").digest("hex"),
    });

    expect(parser.canParse(sessionPath)).toBe(true);

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.session_id).toBe("jsonl12-0000-4000-8000-000000000000");
    expect(result?.conversation.title).toBe("Review this Gemini JSONL project");
    expect(result?.conversation.project_path).toBe("/workspace/mandible");
    expect(result?.conversation.model).toBe("gemini-3.1-pro-preview");
    expect(result?.conversation.ended_at).toBe("2026-05-16T00:00:02.000Z");
    expect(result?.blocks.map((block) => block.type)).toEqual(["user_message", "plan", "tool_use", "tool_result", "assistant_message"]);
    expect(result?.blocks.find((block) => block.type === "plan")).toMatchObject({
      role: "assistant",
      content: "Check the file before answering.",
      metadata: {
        model: "gemini-3.1-pro-preview",
        source_event_type: "gemini_plan",
      },
    });
    expect(result?.blocks.find((block) => block.type === "tool_use")?.metadata).toMatchObject({
      tool_name: "read_file",
      tool_kind: "gemini_tool_call",
      tool_input: { path: "README.md" },
    });
    expect(result?.blocks.map((block) => block.metadata.chat_item?.type)).toEqual([
      "message", "plan", "tool-call", "tool-call", "message",
    ]);
    expect(result?.blocks.map((block) => block.metadata.chat_item?.identity.native_content_index)).toEqual([
      0, 0, 1, 2, 3,
    ]);
    expect(result?.blocks.every((block) => block.metadata.chat_item?.provenance.provider === "gemini")).toBe(true);
  });

  it("parses appended JSONL messages at the requested base position", async () => {
    const parser = new GeminiParser();
    const sessionPath = await makeGeminiJsonlSession({
      tmpName: "mandible-incremental",
      projectRoot: "/workspace/mandible",
    });

    const result = await parser.parseIncremental?.({
      filePath: sessionPath,
      raw: `${JSON.stringify({
        id: "g2",
        type: "gemini",
        timestamp: "2026-05-16T00:00:03.000Z",
        model: "gemini-3.1-pro-preview",
        content: "Incremental Gemini answer.",
      })}\n`,
      baseBlockCount: 5,
      baseRecordCount: 3,
      sourceHash: "append:hash",
      sourceMtime: 42,
    });

    expect(result?.conversation.block_count).toBe(6);
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]).toMatchObject({
      type: "assistant_message",
      position: 5,
      content: "Incremental Gemini answer.",
      metadata: {
        chat_item: {
          identity: { source_record_ordinal: 3, source_sub_block_ordinal: 0, native_item_id: "g2" },
          provenance: { source: "verified-provider-transcript", provider: "gemini" },
          type: "message",
        },
      },
    });
  });
});
