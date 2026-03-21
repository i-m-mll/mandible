// Bug: aa35aeb — Console tab renderer: stream-json event parsing and rich HTML rendering

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
  MessageGroupProps,
  TextBlockProps,
  ThinkingBlockProps,
  ToolUseBlockProps,
  FileEditBlockProps,
} from './types';
