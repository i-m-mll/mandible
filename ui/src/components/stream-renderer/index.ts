// Bug: aa35aeb — Console tab renderer: stream-json event parsing and rich HTML rendering
// Bug: bce7370 — Component types moved to ../message-blocks/

export { StreamRenderer } from './StreamRenderer';
export type {
  StreamRendererProps,
  StreamEvent,
  AssistantEvent,
  UserEvent,
  SystemInitEvent,
  ResultEvent,
  ResultEventSuccess,
  ResultEventError,
  ContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ToolResultContent,
  RenderedTurn,
  RenderNode,
  GroupEntity,
  RenderNodeAssistantTurn,
  RenderNodeUserMessage,
  RenderNodeViolation,
  MessageGroupProps,
} from './types';
