export { ChatSurface } from './ChatSurface';
export type { ChatSurfaceProps } from './ChatSurface';
export { Shelf } from './Shelf';
export type { ShelfItem, ShelfItemStatus, ShelfProps } from './Shelf';
export { ChatOverlay } from './ChatOverlay';
export { ChatBottomShelf } from './ChatBottomShelf';
export { ChatEntityLinkBoundary } from './ChatEntityLinkBoundary';
export type { ChatPreviewTarget } from './ChatEntityLinkBoundary';
export { useChatBottomShelfPreference } from './useChatBottomShelfPreference';
export type { ChatOverlayProps } from './ChatOverlay';
export { ContextUsageRing } from './ContextUsageRing';
export { UsageModal } from './UsageModal';
export { useStatuslineTelemetry } from './useStatuslineTelemetry';
export {
  deriveChatUsageSummary,
  effectiveClaudeInputTokens,
  getContextSeverity,
  selectContextUsage,
} from './contextUsage';
export type {
  ChatUsageSummary,
  ContextUsage,
  ContextUsageSeverity,
  StatuslineTelemetry,
} from './contextUsage';
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
  reconcileProviderProjection,
} from './conversationEvents';
