import { normalizeOrderedPinIds } from '../components/shared/orderedPins';
import { usePersistedViewState } from '../hooks/usePersistedViewState';

export const CHAT_VIEW_STATE_KEY = 'mandible.chat.viewState:v1';

export type ShownChatProject = {
  projectId: string;
  checkoutId: string;
};

export type ChatViewState = {
  pinnedConversationIds: string[];
  previewPinOverrides: Record<string, boolean>;
  shownProjects: ShownChatProject[];
};

export const DEFAULT_CHAT_VIEW_STATE: ChatViewState = {
  pinnedConversationIds: [],
  previewPinOverrides: {},
  shownProjects: [],
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
    shownProjects: Array.isArray(row.shownProjects)
      ? [...new Map(row.shownProjects.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const projectId = typeof candidate.projectId === 'string' ? candidate.projectId.trim() : '';
        const checkoutId = typeof candidate.checkoutId === 'string' ? candidate.checkoutId.trim() : '';
        if (!projectId || !checkoutId) return [];
        return [[projectId, { projectId, checkoutId }] as const];
      })).values()].slice(0, 500)
      : [],
  };
}

export function useChatViewState() {
  return usePersistedViewState(
    CHAT_VIEW_STATE_KEY,
    normalizeChatViewState,
    DEFAULT_CHAT_VIEW_STATE,
  );
}
