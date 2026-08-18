import { normalizeOrderedPinIds } from '../components/shared/orderedPins';
import { usePersistedViewState } from '../hooks/usePersistedViewState';

export const CHAT_VIEW_STATE_KEY = 'mandible.chat.viewState:v1';

export type ChatViewState = {
  pinnedConversationIds: string[];
};

export const DEFAULT_CHAT_VIEW_STATE: ChatViewState = {
  pinnedConversationIds: [],
};

export function normalizeChatViewState(value: unknown): ChatViewState {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    pinnedConversationIds: normalizeOrderedPinIds(row.pinnedConversationIds),
  };
}

export function useChatViewState() {
  return usePersistedViewState(
    CHAT_VIEW_STATE_KEY,
    normalizeChatViewState,
    DEFAULT_CHAT_VIEW_STATE,
  );
}
