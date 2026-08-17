// Chat log ingestion: normalized types for conversations from all sources.

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

export interface BlockMetadata {
  tool_name?: string;
  tool_kind?: string;
  tool_id?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  model?: string;
  token_usage?: { input: number; output: number; cache_read?: number };
  context_usage?: {
    source: "statusline" | "mirror_exact" | "mirror_approx";
    used_tokens?: number;
    total_tokens?: number;
    window_tokens?: number;
    percent?: number;
    approximate?: boolean;
    model?: string;
  };
  source_event_type?: string;
  visibility?: "default_hidden" | "default_visible";
  truncated?: boolean;
  signature?: string;
  /** Zero-based native record ordinal used by the verified source reader. */
  source_record_ordinal?: number;
  /** Stable order when one native record normalizes into several blocks. */
  source_sub_block_ordinal?: number;
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

export interface ParseResult {
  conversation: Omit<Conversation, "id" | "created_at" | "updated_at" | "starred" | "tags" | "notes">;
  blocks: Omit<ConversationBlock, "id" | "conversation_id">[];
  /** Provider-authored title metadata present in this parse batch. */
  providerTitle?: string;
}

export interface IncrementalParseInput {
  filePath: string;
  raw: string;
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
