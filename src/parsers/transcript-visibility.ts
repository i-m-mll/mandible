import type { BlockType } from "./types.js";

export type TranscriptBlockClassification = "bookkeeping" | "semantic";

const DEFAULT_HIDDEN_BOOKKEEPING_KINDS: Readonly<Record<"system" | "event", ReadonlySet<string>>> = {
  system: new Set([
    "developer",
    "system",
    "user_meta",
  ]),
  event: new Set([
    "token_count",
  ]),
};

/**
 * Classify persisted provider system/event blocks at the transcript boundary.
 *
 * Bookkeeping is intentionally an exact allowlist: a provider parser must mark
 * the block default_hidden and identify a known bookkeeping kind. Unknown kinds
 * remain semantic so parser drift cannot silently remove transcript content.
 */
export function classifyTranscriptBlock(
  blockType: BlockType,
  metadata: Record<string, unknown>,
): TranscriptBlockClassification {
  if (blockType !== "system" && blockType !== "event") {
    return "semantic";
  }
  if (metadata.visibility !== "default_hidden") {
    return "semantic";
  }
  const sourceEventType = typeof metadata.source_event_type === "string"
    ? metadata.source_event_type.trim()
    : "";
  if (!sourceEventType) {
    return "semantic";
  }
  return DEFAULT_HIDDEN_BOOKKEEPING_KINDS[blockType].has(sourceEventType)
    ? "bookkeeping"
    : "semantic";
}
