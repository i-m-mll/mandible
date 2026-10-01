// Bug: aa35aeb — Console tab renderer: stream-json event parsing and rich HTML rendering

import type { ActivityItem, ChatItem } from '../../../../src/parsers/types';
import type { ProviderDirective } from '../message-blocks/providerDirectives';

export type ProviderDirectiveActivity = {
  type: 'provider-directive';
  directive: ProviderDirective;
  turnId?: string;
  sessionId: string;
  provider?: string;
  blockId: string | null;
  sequence: number;
};

export type ToolCallActivity = {
  type: 'tool-call-activity';
  id: string;
  name: string;
  toolKind?: string;
  input: Record<string, unknown> | string;
  result: ToolResultContentBlock | null;
  turnId?: string;
  sessionId: string;
  sourceIdentity?: {
    provider: string;
    sessionId: string;
    turnId?: string;
  };
};

export type ThinkingBlockActivity = {
  type: 'thinking-block-activity';
  content: string;
  turnId?: string;
  sessionId: string;
};

export type DisplayActivityItem = ActivityItem | ProviderDirectiveActivity | ToolCallActivity | ThinkingBlockActivity;

// ---- Raw event types (as emitted by Claude Code --output-format stream-json) ----

export type PersistedBlockSource = {
  blockId: string;
  position?: number;
  /** False when a display projection omitted expandable block payload. */
  detailsLoaded?: boolean;
  /** Whether a compact thinking summary has body lines beyond its title. */
  hasBody?: boolean;
  /** Exact persisted parent link; a present value proves a result is not orphaned. */
  parentBlockId?: string;
  timestamp?: string;
  dagUuid?: string;
};

export type TextContentBlock = {
  type: 'text';
  text: string;
  sourceIdentity?: {
    provider: string;
    sessionId: string;
    turnId?: string;
  };
  source?: PersistedBlockSource;
};

export type ThinkingContentBlock = {
  type: 'thinking';
  thinking: string;
  source?: PersistedBlockSource;
};

export type PlanContentBlock = {
  type: 'plan';
  text: string;
  source?: PersistedBlockSource;
};

export type ToolUseContentBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  toolKind?: string;
  input: Record<string, unknown> | string;
  sourceIdentity?: {
    provider: string;
    sessionId: string;
    turnId?: string;
  };
  source?: PersistedBlockSource;
};

export type ContentBlock = TextContentBlock | ThinkingContentBlock | PlanContentBlock | ToolUseContentBlock;

export type ToolResultContent =
  | string
  | Array<{ type: 'text'; text: string }>
  | Array<{ type: 'image'; source: { type: string; media_type: string; data: string } }>;

export type ToolResultContentBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
  truncated?: boolean;
  fullText?: string;
  omittedCharacters?: number;
  source?: PersistedBlockSource;
};

export type TranscriptSemanticEvent = {
  type: 'transcript:semantic';
  uuid: string;
  session_id: string;
  semantic_kind: 'system' | 'event';
  content: string;
  label?: string;
  is_error?: boolean;
  source: PersistedBlockSource;
};

/** Provider-neutral item emitted by durable normalization and live adapters. */
export type CanonicalChatItemEvent = {
  type: 'chat:item';
  item: ChatItem;
  source?: PersistedBlockSource;
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
    usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
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
  | TranscriptSemanticEvent
  | CanonicalChatItemEvent
  | { type: string; [key: string]: unknown };

// ---- Render model (derived from raw events) ----

export type RenderedTurn = {
  /** Derived from uuid or index — stable key for Preact reconciliation. */
  id: string;
  assistantEvent: AssistantEvent;
  /** Tool results keyed by tool_use_id for O(1) lookup. */
  toolResults: Map<string, ToolResultContentBlock>;
  /** Monotonic timestamp when this turn was first built — P3 uses for per-turn elapsed. */
  receivedAt?: number;
};

// ---- RenderNode types (Bug: d744dde — chronological message ordering) ----

export type GroupEntity = 'user' | 'assistant' | 'system';

export type RenderNodeAssistantTurn = {
  kind: 'assistant_turn';
  key: string;
  entity: 'assistant';
  turn: RenderedTurn;
};

export type RenderNodeUserMessage = {
  kind: 'user_message';
  key: string;
  entity: 'user';
  text: string;
  source: 'stream' | 'synthetic';
  persisted?: PersistedBlockSource;
};

export type RenderNodeSemanticEvent = {
  kind: 'semantic_event';
  key: string;
  entity: 'system';
  event: TranscriptSemanticEvent;
};

export type RenderNodeUnmatchedToolResult = {
  kind: 'unmatched_tool_result';
  key: string;
  entity: 'system';
  result: ToolResultContentBlock;
};

export type RenderNodeActivity = {
  kind: 'activity';
  key: string;
  entity: 'assistant' | 'system';
  item: DisplayActivityItem;
  source?: PersistedBlockSource;
};

export type RenderNode = RenderNodeAssistantTurn | RenderNodeUserMessage | RenderNodeSemanticEvent | RenderNodeUnmatchedToolResult | RenderNodeActivity;

export type DisplayGroupMeta = {
  totalTokens?: number;
  model?: string;
  durationMs?: number;
};

export type DisplayGroup = {
  id: string;
  speaker: GroupEntity;
  nodes: RenderNode[];
  meta: DisplayGroupMeta;
};

// ---- Component props ----
// NOTE (Bug: bce7370): TextBlockProps, ThinkingBlockProps, ToolUseBlockProps,
// FileEditBlockProps have moved to ../message-blocks/. These types remain here
// only for backward compatibility with imports from this module.

export interface MessageGroupProps {
  turn: RenderedTurn;
  /** True if this is the last turn and the stream is still open. */
  isStreaming: boolean;
  /** True if this turn contains a thinking block and is still streaming — shows "thinking…" indicator. */
  isThinking?: boolean;
  getBlockExpanded?: (block: ContentBlock, index: number, defaultExpanded: boolean) => boolean;
  onBlockExpandedChange?: (block: ContentBlock, index: number, expanded: boolean, relatedSources?: PersistedBlockSource[]) => void;
  getDisclosureExpanded?: (id: string, defaultExpanded: boolean) => boolean;
  onDisclosureExpandedChange?: (id: string, expanded: boolean) => void;
  selectedBlockIds?: ReadonlySet<string>;
  selectMode?: boolean;
  onToggleBlockSelect?: (blockId: string, shiftKey: boolean) => void;
  onFork?: (dagUuid: string) => void;
  onResume?: (dagUuid: string) => void;
}

// TOMBSTONE (Bug: fbca9d5): StatusBarProps deleted — StatusBar removed in P1.

export interface StreamRendererProps {
  /** Accumulated events from the parent-owned SSE/WebSocket client. */
  events: StreamEvent[];
  /** True while the transport is open and data may still arrive. */
  streaming: boolean;
  elapsedSeconds?: number;
  emptyLabel?: string;
  /** Session metadata — slimmed in P1 (Bug: fbca9d5). P3 adds conversationId, onFork. */
  sessionInfo?: {
    sessionId: string;
    backend?: string;
    model?: string;
  };
  /** Bug: 02d701a — P3: callback when user clicks Info on a specific turn. */
  onSelectMessageInfo?: (turnId: string) => void;
  /** Bug: 02d701a — P3: currently selected message ID for highlight. */
  selectedMessageId?: string | null;
}
