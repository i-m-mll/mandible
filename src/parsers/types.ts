// Chat log ingestion: normalized types for conversations from all sources.

import type { NormalizedUsageTelemetry } from "./context-usage.js";
import type { ConversationParent } from "../conversation-lineage.js";
import { readOpeningLine, type OpeningLine } from "../lineage-marker.js";

export type BlockType =
  | "user_message"
  | "assistant_message"
  | "thinking"
  | "plan"
  | "tool_use"
  | "tool_result"
  | "system"
  | "event";

export type Role = "user" | "assistant" | "system" | "tool";

export type ConversationSource = "claude_code" | "codex" | "gemini";

export type ActivityKind =
  | "reasoning-summary"
  | "thinking"
  | "tool-progress"
  | "tool-summary"
  | "status"
  | "information"
  | "diagnostic";

export type ChatContentCompletion = "streaming" | "complete";
export type ChatExecutionOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

export interface ChatContentPart {
  type: "text";
  text: string;
  /** Provider-native content/summary part index, when the provider supplies one. */
  native_index?: number;
}

export interface ChatItemIdentity {
  provider: ConversationSource;
  session_id: string;
  /** Provider-native item/message identity. Absence is meaningful. */
  native_item_id?: string;
  native_turn_id?: string;
  native_tool_id?: string;
  native_content_index?: number;
  /** Verified transcript coordinates used only when reusable native identity is absent. */
  source_record_ordinal: number;
  source_sub_block_ordinal: number;
}

export interface ChatItemProvenance {
  source: "verified-provider-transcript" | "live-provider-event";
  provider: ConversationSource;
  source_event_type: string;
}

export interface ChatItemBase {
  identity: ChatItemIdentity;
  provenance: ChatItemProvenance;
  parts: ChatContentPart[];
  content_completion: ChatContentCompletion;
  /** Content completion never implies an execution outcome. */
  execution_outcome?: ChatExecutionOutcome;
}

export interface MessageItem extends ChatItemBase {
  type: "message";
  role: "user" | "assistant" | "system";
}

export interface PlanItem extends ChatItemBase {
  type: "plan";
  role: "assistant";
}

export interface ToolCallItem extends ChatItemBase {
  type: "tool-call";
  role: "assistant" | "tool";
  phase: "call" | "result";
  tool_name?: string;
  tool_kind?: string;
  tool_id?: string;
  input?: unknown;
  output?: unknown;
}

export interface ActivityItem extends ChatItemBase {
  type: "activity";
  role: "assistant" | "system";
  activity_kind: ActivityKind;
  severity?: "info" | "warning" | "error";
  status?: string;
  elapsed_ms?: number;
  tool_name?: string;
  tool_id?: string;
  related_tool_ids?: string[];
}

export type ChatItem = MessageItem | PlanItem | ToolCallItem | ActivityItem;

export interface BlockMetadata {
  execution_state?: "active" | "settled" | "unknown";
  tool_name?: string;
  tool_kind?: string;
  tool_id?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  model?: string;
  token_usage?: { input: number; output: number; cache_read?: number };
  usage_telemetry?: NormalizedUsageTelemetry;
  source_event_type?: string;
  visibility?: "default_hidden" | "default_visible";
  truncated?: boolean;
  signature?: string;
  /** Exact provider item/message identity used to reconcile provisional live output. */
  provider_message_id?: string;
  /** Provider-native turn identity shared by the prompt and its terminal receipt. */
  provider_turn_id?: string;
  /** Caller-supplied user-message identity echoed by the provider; also binds the normalized user Chat item. */
  client_intent_id?: string;
  /** Zero-based native record ordinal used by the verified source reader. */
  source_record_ordinal?: number;
  /** Stable order when one native record normalizes into several blocks. */
  source_sub_block_ordinal?: number;
  /** Native content-block index within one provider message/record. */
  provider_content_index?: number;
  /** Provider-neutral Chat item emitted by transcript normalization. */
  chat_item?: ChatItem;
}

export interface ConversationBlock {
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: string;
  position: number;
  timestamp: string;
  parent_id: string | null;
  metadata: BlockMetadata;
  dag_uuid?: string | null;
  dag_parent_uuid?: string | null;
}

export interface Conversation {
  id: string;
  source: ConversationSource;
  source_path: string;
  source_hash: string;
  source_mtime: number;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  session_id: string;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  is_sidechain: boolean;
  agent_id: string | null;
  starred: boolean;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Logical JSONL extent; filesystem identity describes the selected physical representation. */
interface ParserSourceSnapshotBase {
  byteLength: number;
  completeLineCount: number;
  tailHash: string;
  filesystemDevice: string;
  filesystemInode: string;
}

/** Exact bytes parsed by a full JSONL read, through its last complete record. */
export interface FullParserSourceSnapshot extends ParserSourceSnapshotBase {
  kind: "full";
  contentHash: string;
}

/** Exact appended bytes consumed by an incremental JSONL parse. */
export interface AppendParserSourceSnapshot extends ParserSourceSnapshotBase {
  kind: "append";
  appendRanges: Array<{
    byteStart: number;
    byteEnd: number;
    contentHash: string;
  }>;
}

export type ParserSourceSnapshot = FullParserSourceSnapshot | AppendParserSourceSnapshot;

export interface ParseResult {
  conversation: Omit<Conversation, "id" | "created_at" | "updated_at" | "starred" | "tags" | "notes">;
  /**
   * The session that created this conversation as its subagent or child
   * thread, as the provider's own transcript records it (a subagent header, or
   * the Codex `create_thread` delegation that created the thread unless its
   * marker declares a successor). Null when this parse batch carries no such
   * record: a top-level session, or an append batch without it.
   */
  parent: ConversationParent | null;
  /**
   * The first user message in this parse batch, read for the lineage marker.
   * Null when the batch carries no user message.
   */
  opening: TranscriptOpening | null;
  /**
   * The provider records this thread as created by another agent's tool call
   * rather than by a person (Codex `thread_source = agent_created_thread`).
   */
  createdByAgent: boolean;
  blocks: Omit<ConversationBlock, "id" | "conversation_id">[];
  /** Parser-captured JSONL boundary used to keep source indexing aligned. */
  sourceSnapshot?: ParserSourceSnapshot;
  /** Provider-authored title metadata present in this parse batch. */
  providerTitle?: string;
  /** Provider record that supplied providerTitle, when precedence matters across batches. */
  providerTitleSource?: "custom-title" | "ai-title";
}

export interface TranscriptOpening {
  /** Line 1 of the message, classified by the lineage marker grammar. */
  line: OpeningLine;
  /**
   * The session the provider records as having delivered this message when it
   * created the thread (the Codex `create_thread` delegation envelope).
   */
  creator: ConversationParent | null;
  /**
   * The batch was parsed from the start of the transcript, so this is the
   * conversation's first user message rather than the first one appended.
   */
  atStart: boolean;
}

/** The opening of a batch whose first user message is its own content. */
export function firstUserMessageOpening(
  blocks: readonly Pick<ConversationBlock, "type" | "content">[],
  atStart: boolean,
): TranscriptOpening | null {
  const first = blocks.find((block) => block.type === "user_message");
  return first ? { line: readOpeningLine(first.content), creator: null, atStart } : null;
}

export interface IncrementalParseInput {
  filePath: string;
  raw: string;
  /** Verified native session identity when parsing an isolated durable record. */
  nativeSessionId?: string;
  baseBlockCount: number;
  baseRecordCount?: number;
  sourceHash: string;
  sourceMtime: number;
}

export interface ConversationParser {
  source: ConversationSource;
  canParse(filePath: string): boolean;
  parse(filePath: string): Promise<ParseResult | null>;
  parseIncremental?(input: IncrementalParseInput): Promise<ParseResult | null>;
}

export interface TranscriptChatItemInput {
  provider: ConversationSource;
  sessionId: string;
  sourceEventType: string;
  sourceRecordOrdinal: number;
  sourceSubBlockOrdinal: number;
  parts?: ChatContentPart[];
  activityKind?: ActivityKind;
  severity?: ActivityItem["severity"];
  status?: string;
  elapsedMs?: number;
  relatedToolIds?: string[];
  executionOutcome?: ChatExecutionOutcome;
}

/** Attach the canonical durable Chat item without inventing provider identity or prose. */
export function attachTranscriptChatItem(
  block: Omit<ConversationBlock, "id" | "conversation_id">,
  input: TranscriptChatItemInput,
): void {
  const parts = input.parts ?? (block.content
    ? [{ type: "text" as const, text: block.content }]
    : []);
  const identity: ChatItemIdentity = {
    provider: input.provider,
    session_id: input.sessionId,
    source_record_ordinal: input.sourceRecordOrdinal,
    source_sub_block_ordinal: input.sourceSubBlockOrdinal,
    ...(block.metadata.provider_message_id
      ? { native_item_id: block.metadata.provider_message_id }
      : block.dag_uuid ? { native_item_id: block.dag_uuid } : {}),
    ...(block.metadata.provider_turn_id ? { native_turn_id: block.metadata.provider_turn_id } : {}),
    ...(block.metadata.tool_id ? { native_tool_id: block.metadata.tool_id } : {}),
    ...(block.metadata.provider_content_index !== undefined
      ? { native_content_index: block.metadata.provider_content_index }
      : {}),
  };
  const base: ChatItemBase = {
    identity,
    provenance: {
      source: "verified-provider-transcript",
      provider: input.provider,
      source_event_type: input.sourceEventType,
    },
    parts,
    content_completion: "complete",
    ...(input.executionOutcome ? { execution_outcome: input.executionOutcome } : {}),
  };

  let item: ChatItem | null = null;
  if (block.type === "user_message" || block.type === "assistant_message") {
    item = { ...base, type: "message", role: block.role as "user" | "assistant" };
  } else if (block.type === "plan") {
    item = { ...base, type: "plan", role: "assistant" };
  } else if (block.type === "tool_use" || block.type === "tool_result") {
    item = {
      ...base,
      type: "tool-call",
      role: block.role as "assistant" | "tool",
      phase: block.type === "tool_use" ? "call" : "result",
      ...(block.metadata.tool_name ? { tool_name: block.metadata.tool_name } : {}),
      ...(block.metadata.tool_kind ? { tool_kind: block.metadata.tool_kind } : {}),
      ...(block.metadata.tool_id ? { tool_id: block.metadata.tool_id } : {}),
      ...(block.metadata.tool_input !== undefined ? { input: block.metadata.tool_input } : {}),
      ...(block.metadata.tool_output !== undefined ? { output: block.metadata.tool_output } : {}),
    };
  } else if (input.activityKind) {
    item = {
      ...base,
      type: "activity",
      role: block.role === "assistant" ? "assistant" : "system",
      activity_kind: input.activityKind,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.elapsedMs !== undefined ? { elapsed_ms: input.elapsedMs } : {}),
      ...(block.metadata.tool_name ? { tool_name: block.metadata.tool_name } : {}),
      ...(block.metadata.tool_id ? { tool_id: block.metadata.tool_id } : {}),
      ...(input.relatedToolIds?.length ? { related_tool_ids: input.relatedToolIds } : {}),
    };
  }
  if (item) block.metadata.chat_item = item;
}
