export { ChatSurface } from './ChatSurface';
export type { ChatSurfaceProps } from './ChatSurface';
export { Shelf } from './Shelf';
export type { ShelfItem, ShelfItemStatus, ShelfProps } from './Shelf';
export {
  buildStreamState,
  boundToolResultBlock,
  computeTotalTokens,
  deriveLiveLabel,
  deriveTokenCount,
  extractTurns,
  formatElapsed,
  groupMessagesForDisplay,
  serializeConversationToMarkdown,
  serializeDisplayGroupToMarkdown,
  useStreamState,
} from './renderModel';
export type { StreamState } from './renderModel';
export {
  computeLiveTail,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
} from './conversationEvents';
