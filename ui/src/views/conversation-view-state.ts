import { normalizeOrderedPinIds } from '../components/shared/orderedPins';
import { usePersistedViewState } from '../hooks/usePersistedViewState';

export const CHAT_VIEW_STATE_KEY = 'mandible.chat.viewState:v1';

export type ChatViewState = {
  pinnedConversationIds: string[];
  previewPinOverrides: Record<string, boolean>;
};

export const DEFAULT_CHAT_VIEW_STATE: ChatViewState = {
  pinnedConversationIds: [],
  previewPinOverrides: {},
};

export function normalizeChatViewState(value: unknown): ChatViewState {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawOverrides = row.previewPinOverrides
    && typeof row.previewPinOverrides === 'object'
    && !Array.isArray(row.previewPinOverrides)
    ? row.previewPinOverrides as Record<string, unknown>
    : {};
  return {
    pinnedConversationIds: normalizeOrderedPinIds(row.pinnedConversationIds),
    previewPinOverrides: Object.fromEntries(
      Object.entries(rawOverrides)
        .filter((entry): entry is [string, boolean] => Boolean(entry[0].trim()) && typeof entry[1] === 'boolean')
        .slice(0, 1000),
    ),
  };
}

export function useChatViewState() {
  return usePersistedViewState(
    CHAT_VIEW_STATE_KEY,
    normalizeChatViewState,
    DEFAULT_CHAT_VIEW_STATE,
  );
}
