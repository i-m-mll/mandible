import { normalizeOrderedPinIds } from '../components/shared/orderedPins';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import type { CanonicalProject, CanonicalProjectCheckout } from '../api';

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

function checkoutPreference(project: CanonicalProject, checkout: CanonicalProjectCheckout): number {
  let score = 0;
  if (checkout.work_repo_id === project.project_key) score += 8;
  if (checkout.default_branch) score += 4;
  if (!/(?:^|\/)worktrees\//.test(checkout.root) && !checkout.root.startsWith('/sessions/')) score += 2;
  if (checkout.name === project.project_key || checkout.name === project.display_name) score += 1;
  return score;
}

/** Preserve project visibility when only the selected checkout has churned. */
export function reconcileShownProjects(
  shownProjects: readonly ShownChatProject[],
  projects: readonly CanonicalProject[],
): ShownChatProject[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return shownProjects.flatMap((shown) => {
    const project = projectsById.get(shown.projectId);
    if (!project || project.checkouts.length === 0) return [];
    const exact = project.checkouts.find((checkout) => checkout.id === shown.checkoutId);
    if (exact) return [shown];
    const fallback = [...project.checkouts].sort((left, right) => (
      checkoutPreference(project, right) - checkoutPreference(project, left)
      || left.root.localeCompare(right.root)
      || left.id.localeCompare(right.id)
    ))[0];
    return fallback ? [{ projectId: project.id, checkoutId: fallback.id }] : [];
  });
}

export function useChatViewState() {
  return usePersistedViewState(
    CHAT_VIEW_STATE_KEY,
    normalizeChatViewState,
    DEFAULT_CHAT_VIEW_STATE,
  );
}
