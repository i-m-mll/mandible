import { afterEach, describe, expect, it } from "vitest";
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
    expect(result?.conversation.block_count).toBe(2);
  });

  it("falls back to the first user_message event when session_index has no title", async () => {
    const parser = new CodexParser();
    const sessionPath = await makeCodexSession("session-2");

    const result = await parser.parse(sessionPath);

    expect(result?.conversation.title).toBe("Fallback prompt title");
  });
});
