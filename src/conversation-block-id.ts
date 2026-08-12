// Deterministic `conversation_blocks.id` derivation.
//
// A block id is a content hash, not a surrogate key: re-ingesting the same
// transcript must reproduce the same ids so deep links and stable-offset
// pagination survive (bug 7b47c6c added `position` to the hash after empty
// tool_result blocks collided).
//
// It lives in its own module because two paths must agree byte for byte:
// ingestion, which computes it on insert, and retroactive credential redaction
// (issue b3e4a09), which rewrites block content after the fact and has to land
// on exactly the id the next ingest of the redacted source would produce. A
// second inline copy of this expression is a silent way for those to drift.

import { createHash } from "node:crypto";

export interface BlockIdInput {
  conversation_id: string;
  type: string;
  timestamp?: string | null;
  content?: string | null;
  position: number;
}

export function conversationBlockId(input: BlockIdInput): string {
  return createHash("sha256")
    .update(
      input.conversation_id
        + input.type
        + (input.timestamp || "")
        + (input.content || "").slice(0, 100)
        + String(input.position),
    )
    .digest("hex")
    .slice(0, 16);
}
