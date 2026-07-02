import { describe, expect, it } from "vitest";

import { applyConversationAppendPayload } from "../ui/src/chat/conversationAppend";
import type { Conversation, ConversationBlock, ConversationChild } from "../ui/src/api";

function conversation(blocks: ConversationBlock[]): Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
} {
  return {
    id: "conv-1",
    source: "codex",
    source_path: "/tmp/session.jsonl",
    title: "Session",
    summary: null,
    started_at: "2026-07-02T00:00:00.000Z",
    ended_at: null,
    block_count: blocks.length,
    session_id: "session-1",
    project_path: null,
    cwd: null,
    branch: null,
    model: null,
    cli_version: null,
    starred: false,
    label: null,
    notes: null,
    parent_conversation_id: null,
    children_count: 0,
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    blocks,
    children: [],
  };
}

function block(id: string, position: number, content: string): ConversationBlock {
  return {
    id,
    conversation_id: "conv-1",
    type: "assistant_message",
    role: "assistant",
    content,
    position,
    timestamp: "2026-07-02T00:00:00.000Z",
    parent_id: null,
    metadata_json: "{}",
    dag_uuid: null,
    dag_parent_uuid: null,
  };
}

describe("conversation append SSE merge", () => {
  it("appends exact tail blocks and updates metadata", () => {
    const current = conversation([block("b0", 0, "old")]);
    const next = applyConversationAppendPayload(current, {
      id: "conv-1",
      block_count: 2,
      append: { from_position: 1, blocks: [block("b1", 1, "new")] },
    });

    expect(next?.blocks.map((item) => item.id)).toEqual(["b0", "b1"]);
    expect(next?.block_count).toBe(2);
  });

  it("keeps duplicate append events idempotent", () => {
    const current = conversation([block("b0", 0, "old"), block("b1", 1, "new")]);
    const next = applyConversationAppendPayload(current, {
      id: "conv-1",
      block_count: 2,
      append: { from_position: 1, blocks: [block("b1", 1, "new")] },
    });

    expect(next?.blocks.map((item) => item.id)).toEqual(["b0", "b1"]);
  });

  it("signals refetch when the append is not the current tail", () => {
    const current = conversation([block("b0", 0, "old")]);
    const next = applyConversationAppendPayload(current, {
      id: "conv-1",
      block_count: 3,
      append: { from_position: 2, blocks: [block("b2", 2, "gap")] },
    });

    expect(next).toBeNull();
  });
});
