import { describe, expect, it } from "vitest";

import {
  applyConversationAppendPayload,
  mergeConversationSummaryIntoList,
} from "../../ui/src/query/conversationData";
import type { Conversation, ConversationBlock, ConversationChild } from "../../ui/src/api";

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
    tags: [],
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

describe("sidebar conversation summary merge", () => {
  function listRow(id: string, blockCount: number, title = "Session"): Conversation {
    return { ...conversation([]), id, block_count: blockCount, title };
  }

  it("merges a newer summary in place with monotonic block_count", () => {
    const list = [listRow("conv-1", 3, "Old"), listRow("conv-2", 5)];
    const result = mergeConversationSummaryIntoList(list, {
      id: "conv-1",
      title: "New",
      block_count: 4,
    });

    expect(result.applied).toBe(true);
    expect(result.refetch).toBe(false);
    expect(result.conversations).not.toBe(list); // new array
    expect(result.conversations[0].block_count).toBe(4);
    expect(result.conversations[0].title).toBe("New");
    expect(result.conversations[1]).toBe(list[1]); // untouched
  });

  it("rejects a stale (regressed block_count) summary without refetching", () => {
    const list = [listRow("conv-1", 5)];
    const result = mergeConversationSummaryIntoList(list, {
      id: "conv-1",
      block_count: 3,
    });

    expect(result.applied).toBe(false);
    expect(result.refetch).toBe(false);
    expect(result.conversations).toBe(list); // unchanged reference
  });

  it("signals refetch for an unknown conversation id", () => {
    const list = [listRow("conv-1", 5)];
    const result = mergeConversationSummaryIntoList(list, {
      id: "conv-99",
      block_count: 2,
    });

    expect(result.applied).toBe(false);
    expect(result.refetch).toBe(true);
  });

  it("signals refetch when the summary carries no block_count anchor", () => {
    const list = [listRow("conv-1", 5)];
    const result = mergeConversationSummaryIntoList(list, {
      id: "conv-1",
      title: "Renamed",
    });

    expect(result.applied).toBe(false);
    expect(result.refetch).toBe(true);
  });
});
