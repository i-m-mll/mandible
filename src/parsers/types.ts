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
  source_event_type?: string;
  visibility?: "default_hidden" | "default_visible";
  truncated?: boolean;
  signature?: string;
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
  starred: boolean;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParseResult {
  conversation: Omit<Conversation, "id" | "created_at" | "updated_at" | "starred" | "label" | "notes">;
  blocks: Omit<ConversationBlock, "id" | "conversation_id">[];
}

export interface IncrementalParseInput {
  filePath: string;
  raw: string;
  baseBlockCount: number;
  sourceHash: string;
  sourceMtime: number;
}

export interface ConversationParser {
  source: ConversationSource;
  canParse(filePath: string): boolean;
  parse(filePath: string): Promise<ParseResult | null>;
  parseIncremental?(input: IncrementalParseInput): Promise<ParseResult | null>;
}
