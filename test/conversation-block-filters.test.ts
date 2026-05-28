import { describe, expect, it } from "vitest";
import {
  filterBlocks,
  makeEnvelope,
  parseBound,
  type InspectableBlock,
} from "../src/conversation-block-filters.js";

const blocks: InspectableBlock[] = [
  {
    type: "user_message",
    role: "user",
    content: "Please inspect auth logs",
    position: 0,
    timestamp: "2026-05-20T10:00:00.000Z",
    metadata: {},
  },
  {
    type: "tool_use",
    role: "assistant",
    content: "exec_command({})",
    position: 1,
    timestamp: "2026-05-20T10:01:00.000Z",
    metadata: { tool_name: "exec_command", tool_kind: "function_call" },
  },
  {
    type: "assistant_message",
    role: "assistant",
    content: "Done",
    position: 2,
    timestamp: null,
    metadata_json: "{\"model\":\"gpt\"}",
  },
];

describe("conversation block filters", () => {
  it("composes role, type, tool, and content filters", () => {
    expect(filterBlocks(blocks, {
      roles: ["assistant"],
      types: ["tool_use"],
      tool: "exec_command",
      content: "EXEC",
      limit: 10,
    }).map((block) => block.position)).toEqual([1]);
  });

  it("excludes untimestamped blocks when time bounds are present", () => {
    expect(filterBlocks(blocks, {
      since: "2026-05-20T10:00:30.000Z",
      until: "2026-05-20T10:02:00.000Z",
      limit: 10,
    }).map((block) => block.position)).toEqual([1]);
  });

  it("limits after filtering and preserves metadata in envelopes", () => {
    const filtered = filterBlocks(blocks, { roles: ["assistant"], limit: 1 });
    const envelope = makeEnvelope("log", "codex", { session_id: "s1" }, { roles: ["assistant"], limit: 1 }, filtered);

    expect(envelope.total).toBe(1);
    expect(envelope.blocks[0].metadata).toMatchObject({ tool_name: "exec_command" });
  });

  it("parses relative day and date bounds", () => {
    expect(parseBound("2026-05-20")).toBe("2026-05-20T00:00:00.000Z");
    expect(parseBound("2d", Date.parse("2026-05-22T00:00:00.000Z"))).toBe("2026-05-20T00:00:00.000Z");
  });
});
