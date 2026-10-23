import type { BlockType, ConversationSource, Role } from "./types.js";

export interface ParserCapability {
  source: ConversationSource;
  display_name: string;
  source_globs: string[];
  block_types: BlockType[];
  roles: Role[];
  tool_metadata: {
    tool_name: boolean;
    tool_kind: boolean;
    tool_id: boolean;
    tool_input: boolean;
    tool_output: boolean;
  };
  notes: string[];
}

export const PARSER_CAPABILITIES: ParserCapability[] = [
  {
    source: "codex",
    display_name: "Codex",
    source_globs: [
      "~/.codex/sessions/**/*.jsonl",
      "~/.codex/archived_sessions/**/*.jsonl",
    ],
    block_types: ["user_message", "assistant_message", "thinking", "plan", "tool_use", "tool_result", "system", "event"],
    roles: ["user", "assistant", "tool", "system"],
    tool_metadata: {
      tool_name: true,
      tool_kind: true,
      tool_id: true,
      tool_input: true,
      tool_output: true,
    },
    notes: [
      "Tool uses come from function_call/custom_tool_call response items.",
      "Echoed user_message client_id binds the preceding native user Chat item to its exact submission intent.",
      "Subagent threads are sidechain conversations whose parent is the thread named in the rollout header's session_meta.source.subagent spawn record.",
      "Line 1 of the first user message is read for the lineage marker; a message delivered in a create_thread <codex_delegation> envelope is read from its <input>, and its <source_thread_id> is the thread's creator. thread_source = agent_created_thread marks a thread another agent created.",
      "Messages, plans, tools, and semantic activity expose metadata.chat_item using the shared provider-neutral contract.",
      "Reasoning summary arrays preserve ordered provider-authored parts; readable reasoning content is separate and encrypted content is never normalized.",
      "Tool names are stored in metadata.tool_name.",
      "Function call outputs without call identity are provider transport records and remain only in the source rollout; identified but unpaired outputs remain transcript diagnostics.",
      "Incremental ingestion parses complete appended JSONL records and falls back on cross-chunk tool links.",
      "Hidden token_count event blocks preserve Codex task-total/latest accounting and model capacity; current context remains explicitly unavailable because the provider exposes no resident occupancy field.",
      "Unknown system/event kinds remain transcript-visible even if marked default_hidden, so provider drift fails visibly.",
      "Archived rollouts under archived_sessions are watched and parsed; `codex archive`/`codex unarchive` is tracked as a source move, not a deletion.",
    ],
  },
  {
    source: "claude_code",
    display_name: "Claude Code",
    source_globs: ["~/.claude/projects/**/*.jsonl"],
    block_types: ["user_message", "assistant_message", "thinking", "plan", "tool_use", "tool_result", "system", "event"],
    roles: ["user", "assistant", "tool", "system"],
    tool_metadata: {
      tool_name: true,
      tool_kind: true,
      tool_id: true,
      tool_input: true,
      tool_output: true,
    },
    notes: [
      "Tool uses come from assistant content blocks with type tool_use.",
      "Tool results come from user content blocks with type tool_result.",
      "Messages, tools, thinking, progress, summaries, and informational records expose metadata.chat_item using the shared provider-neutral contract.",
      "Native content-block indexes preserve ordered siblings that share one Claude message identity.",
      "Task subagent transcripts under <parent>/subagents/agent-*.jsonl, and legacy sibling agent-*.jsonl sidechain transcripts, are sidechain conversations whose parent is the session they name.",
      "Line 1 of the first user message is read for the lineage marker.",
      "Incremental ingestion parses complete appended JSONL records and falls back on cross-chunk tool links.",
      "Assistant usage blocks preserve message accounting but do not infer current context; authoritative occupancy comes only from Claude statusline telemetry.",
      "Known user_meta and system records are hidden provider bookkeeping; unknown system/event kinds remain transcript-visible.",
    ],
  },
  {
    source: "gemini",
    display_name: "Gemini",
    source_globs: [
      "~/.gemini/tmp/**/chats/session-*.json",
      "~/.gemini/tmp/**/chats/session-*.jsonl",
    ],
    block_types: ["user_message", "assistant_message", "thinking", "plan", "tool_use", "tool_result"],
    roles: ["user", "assistant", "tool"],
    tool_metadata: {
      tool_name: true,
      tool_kind: true,
      tool_id: true,
      tool_input: true,
      tool_output: true,
    },
    notes: [
      "Line 1 of the first user message is read for the lineage marker.",
      "Messages, plans, tools, and thinking expose metadata.chat_item using the shared provider-neutral contract.",
      "Tool-use support depends on Gemini logs containing toolCalls.",
      "Some Gemini logs only contain user and assistant messages.",
      "Gemini currently normalizes no system/event records; plans and thoughts remain typed assistant blocks.",
      "Incremental ingestion is supported for JSONL session streams; whole JSON session files use full parse.",
    ],
  },
];

export function getParserCapability(source: ConversationSource): ParserCapability | null {
  return PARSER_CAPABILITIES.find((capability) => capability.source === source) ?? null;
}
