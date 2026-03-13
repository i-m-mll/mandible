// Bug: aa35aeb — Console tab renderer: stream-json event parsing and rich HTML rendering

// ---- Raw event types (as emitted by Claude Code --output-format stream-json) ----

export type TextContentBlock = {
  type: 'text';
  text: string;
};

export type ThinkingContentBlock = {
  type: 'thinking';
  thinking: string;
};

export type ToolUseContentBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ContentBlock = TextContentBlock | ThinkingContentBlock | ToolUseContentBlock;

export type ToolResultContent =
  | string
  | Array<{ type: 'text'; text: string }>
  | Array<{ type: 'image'; source: { type: string; media_type: string; data: string } }>;

export type ToolResultContentBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
};

export type SystemInitEvent = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  [key: string]: unknown;
};

export type AssistantEvent = {
  type: 'assistant';
  uuid?: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    id?: string;
    role: 'assistant';
    content: ContentBlock[];
    model?: string;
    stop_reason?: string | null;
    usage?: { input_tokens: number; output_tokens: number };
  };
};

export type UserEvent = {
  type: 'user';
  uuid?: string;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: 'user';
    /** Content blocks — may be tool results (mid-turn) or text blocks (initial prompt). */
    content: Array<ToolResultContentBlock | TextContentBlock | { type: string; [key: string]: unknown }>;
  };
  isSynthetic?: boolean;
};

export type ResultEventSuccess = {
  type: 'result';
  subtype: 'success';
  session_id: string;
  duration_ms: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
  is_error: false;
};

export type ResultEventError = {
  type: 'result';
  subtype:
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  session_id: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  is_error: true;
  errors: string[];
};

export type ResultEvent = ResultEventSuccess | ResultEventError;

/** Synthetic event appended locally after the user submits a prompt via the
 *  rich-view input bar.  Never emitted by the server — used only for optimistic
 *  display so the user sees their message immediately (Bug: db5e986). */
export type SyntheticPromptEvent = {
  type: 'synthetic_prompt';
  text: string;
  /** Monotonic local key so React/Preact can reconcile without a server id. */
  localId: string;
};

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | SyntheticPromptEvent
  | { type: string; [key: string]: unknown };

// ---- Render model (derived from raw events) ----

export type RenderedTurn = {
  /** Derived from uuid or index — stable key for Preact reconciliation. */
  id: string;
  assistantEvent: AssistantEvent;
  /** Tool results keyed by tool_use_id for O(1) lookup. */
  toolResults: Map<string, ToolResultContentBlock>;
};

// ---- Component props ----

export interface TextBlockProps {
  text: string;
}

export interface ThinkingBlockProps {
  thinking: string;
  defaultExpanded?: boolean;
}

export interface ToolUseBlockProps {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  result?: ToolResultContentBlock | null;
  defaultExpanded?: boolean;
}

export interface FileEditBlockProps {
  filePath: string;
  oldString: string;
  newString: string;
}

export interface MessageGroupProps {
  turn: RenderedTurn;
  /** True if this is the last turn and the stream is still open. */
  isStreaming: boolean;
  /** True if this turn contains a thinking block and is still streaming — shows "thinking…" indicator. */
  isThinking?: boolean;
}

export interface StatusBarProps {
  streaming: boolean;
  model?: string;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  error?: string;
  /** Elapsed seconds since streaming started — shown live while streaming=true. */
  elapsedSeconds?: number;
  liveLabel?: string;
}

export interface StreamRendererProps {
  /** Accumulated events from the parent-owned SSE/WebSocket client. */
  events: StreamEvent[];
  /** True while the transport is open and data may still arrive. */
  streaming: boolean;
  /** Optional session metadata for the status bar. */
  sessionInfo?: {
    sessionId: string;
    model?: string;
  };
}
