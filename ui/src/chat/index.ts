export { ChatSurface } from './ChatSurface';
export type { ChatSurfaceProps } from './ChatSurface';
export { ChatOverlay } from './ChatOverlay';
export { ChatActivity, ChatSessionOverview, ChatPreview } from './ChatRightSidebar';
export type { ChatActivityItem, ChatActivityItemStatus } from './ChatRightSidebar';
export { ChatEntityLinkBoundary } from './ChatEntityLinkBoundary';
export type { ChatPreviewTarget } from './ChatEntityLinkBoundary';
export type { ChatOverlayProps } from './ChatOverlay';
export {
  ChatFailureNotice,
  chatControlFailureNotice,
  chatSubmissionFailureNotice,
  chatSpawnFailureNotice,
} from './ChatFailureNotice';
export type { ChatFailureNoticeModel } from './ChatFailureNotice';
export { NewChatProviderPicker } from './NewChatProviderPicker';
export { reduceNewChatDraft } from './newChatDraft';
export type { NewChatDraft, NewChatPlacement, NewChatProvider } from './newChatDraft';
export { ContextUsageRing } from './ContextUsageRing';
export { UsageModal } from './UsageModal';
export { useStatuslineTelemetry } from './useStatuslineTelemetry';
export {
  deriveChatUsageSummary,
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
  groupActivityItemsForDisplay,
  groupMessagesForDisplay,
  isRoutineActivityStatus,
  chatItemStableKey,
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
