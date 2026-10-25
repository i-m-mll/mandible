import { normalizeOrderedPinIds } from '../components/shared/orderedPins';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Dispatch, StateUpdater } from 'preact/hooks';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import type { CanonicalProject, CanonicalProjectCheckout, ChatShownProjectsPreference } from '../api';
import {
  ApiError,
  getChatShownProjectsPreference,
  isApiErrorStatus,
  updateChatShownProjectsPreference,
} from '../api';
import {
  subscribeClientAccessState,
} from '../client-auth-token';

export const CHAT_VIEW_STATE_KEY = 'mandible.chat.viewState:v1';

export type ShownChatProject = {
  projectId: string;
  checkoutId: string;
};

export type ChatViewState = {
  conversationLifecycle: 'active' | 'archived';
  pinnedConversationIds: string[];
  previewPinOverrides: Record<string, boolean>;
  lastSelection: { type: 'conversation' | 'session'; id: string } | null;
};

export const DEFAULT_CHAT_VIEW_STATE: ChatViewState = {
  conversationLifecycle: 'active',
  pinnedConversationIds: [],
  previewPinOverrides: {},
  lastSelection: null,
};

export type LegacyChatViewState = ChatViewState & { shownProjects: ShownChatProject[] };

export function normalizeChatViewState(value: unknown): LegacyChatViewState {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawOverrides = row.previewPinOverrides
    && typeof row.previewPinOverrides === 'object'
    && !Array.isArray(row.previewPinOverrides)
    ? row.previewPinOverrides as Record<string, unknown>
    : {};
  const rawSelection = row.lastSelection
    && typeof row.lastSelection === 'object'
    && !Array.isArray(row.lastSelection)
    ? row.lastSelection as Record<string, unknown>
    : null;
  const lastSelection: ChatViewState['lastSelection'] = rawSelection
    && (rawSelection.type === 'conversation' || rawSelection.type === 'session')
    && typeof rawSelection.id === 'string'
    && rawSelection.id.trim()
    ? { type: rawSelection.type, id: rawSelection.id.trim() }
    : null;
  return {
    conversationLifecycle: row.conversationLifecycle === 'archived' ? 'archived' : 'active',
    pinnedConversationIds: normalizeOrderedPinIds(row.pinnedConversationIds),
    previewPinOverrides: Object.fromEntries(
      Object.entries(rawOverrides)
        .filter((entry): entry is [string, boolean] => Boolean(entry[0].trim()) && typeof entry[1] === 'boolean')
        .slice(0, 1000),
    ),
    lastSelection,
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

/**
 * A canonical project is one sidebar choice. Its checkout is launch context,
 * not project identity, so choose one stable checkout without exposing every
 * worktree as a separate project option.
 */
export function preferredProjectCheckout(
  project: CanonicalProject,
): CanonicalProjectCheckout | null {
  return [...project.checkouts].sort((left, right) => (
    checkoutPreference(project, right) - checkoutPreference(project, left)
    || left.root.localeCompare(right.root)
    || left.id.localeCompare(right.id)
  ))[0] ?? null;
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
    const fallback = preferredProjectCheckout(project);
    return fallback ? [{ projectId: project.id, checkoutId: fallback.id }] : [];
  });
}

export function useChatViewState() {
  return usePersistedViewState(
    CHAT_VIEW_STATE_KEY,
    (value) => {
      const normalized = normalizeChatViewState(value);
      return {
        conversationLifecycle: normalized.conversationLifecycle,
        pinnedConversationIds: normalized.pinnedConversationIds,
        previewPinOverrides: normalized.previewPinOverrides,
        lastSelection: normalized.lastSelection,
      };
    },
    DEFAULT_CHAT_VIEW_STATE,
  );
}

export type ChatProjectSelectionState = {
  ready: boolean;
  notice: string | null;
};

function readLegacyShownProjects(): ShownChatProject[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(CHAT_VIEW_STATE_KEY);
    return raw === null ? [] : normalizeChatViewState(JSON.parse(raw)).shownProjects;
  } catch {
    return [];
  }
}

function removeLegacyShownProjects(): void {
  try {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(CHAT_VIEW_STATE_KEY);
    if (raw === null) return;
    const normalized = normalizeChatViewState(JSON.parse(raw));
    window.localStorage.setItem(CHAT_VIEW_STATE_KEY, JSON.stringify({
      conversationLifecycle: normalized.conversationLifecycle,
      pinnedConversationIds: normalized.pinnedConversationIds,
      previewPinOverrides: normalized.previewPinOverrides,
      lastSelection: normalized.lastSelection,
    }));
  } catch {
    // Host persistence is authoritative; unavailable browser storage does not
    // prevent using it.
  }
}

/**
 * Revision-safe host/user project selection shared by main and preview ports.
 * The old localStorage field is only an import source and is removed after the
 * host authority has either supplied or accepted the value.
 */
export function useChatProjectSelection(): [
  ShownChatProject[],
  Dispatch<StateUpdater<ShownChatProject[]>>,
  ChatProjectSelectionState,
] {
  const legacyRef = useRef<ShownChatProject[] | null>(null);
  if (legacyRef.current === null) legacyRef.current = readLegacyShownProjects();
  const [shownProjects, setShownProjects] = useState<ShownChatProject[]>(legacyRef.current);
  const [state, setState] = useState<ChatProjectSelectionState>({ ready: false, notice: null });
  const desiredRef = useRef(legacyRef.current);
  const revisionRef = useRef(0);
  const writeQueueRef = useRef(Promise.resolve());
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    let loading = false;
    let firstLoad = true;
    const showCached = (snapshot: ChatShownProjectsPreference) => {
      if (!activeRef.current || (snapshot.revision === 0 && legacyRef.current!.length > 0)) return;
      desiredRef.current = snapshot.value;
      revisionRef.current = snapshot.revision;
      setShownProjects(snapshot.value);
      setState({ ready: true, notice: null });
    };
    const load = async () => {
      if (loading) return;
      loading = true;
      const warm = firstLoad;
      firstLoad = false;
      try {
        const snapshot = await getChatShownProjectsPreference({ warm, onCached: warm ? showCached : undefined });
        let resolved = snapshot;
        let importedLegacy = false;
        if (snapshot.revision === 0 && legacyRef.current!.length > 0) {
          try {
            resolved = await updateChatShownProjectsPreference(legacyRef.current!, 0);
            importedLegacy = true;
          } catch (error) {
            if (!isApiErrorStatus(error, 409)) throw error;
            resolved = await getChatShownProjectsPreference();
          }
        }
        if (!activeRef.current) return;
        desiredRef.current = resolved.value;
        revisionRef.current = resolved.revision;
        setShownProjects(resolved.value);
        removeLegacyShownProjects();
        setState({
          ready: true,
          notice: importedLegacy
            ? 'Imported this browser’s saved project selection to the shared host preference.'
            : null,
        });
      } catch (error) {
        if (!activeRef.current) return;
        const authRequired = isApiErrorStatus(error, 401)
          || isApiErrorStatus(error, 403);
        setState({
          ready: false,
          notice: error instanceof ApiError && error.code === 'local_access_unavailable'
            ? null : authRequired
            ? 'Project selection is unavailable until local access recovers.'
            : 'Project selection is unavailable. It will retry when Mandible reconnects.',
        });
      } finally {
        loading = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const unsubscribeAuth = subscribeClientAccessState((authState) => {
      if (authState.phase === 'ready') void load();
    });
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    void load();
    return () => {
      activeRef.current = false;
      unsubscribeAuth();
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  const update = useCallback<Dispatch<StateUpdater<ShownChatProject[]>>>((next) => {
    if (!state.ready) return;
    const previous = desiredRef.current;
    const value = typeof next === 'function'
      ? (next as (current: ShownChatProject[]) => ShownChatProject[])(previous)
      : next;
    desiredRef.current = value;
    setShownProjects(value);
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      const expectedRevision = revisionRef.current;
      const intendedValue = desiredRef.current;
      try {
        const saved = await updateChatShownProjectsPreference(intendedValue, expectedRevision);
        if (!activeRef.current) return;
        revisionRef.current = saved.revision;
        if (desiredRef.current === intendedValue) setShownProjects(saved.value);
        setState({ ready: true, notice: null });
      } catch (error) {
        if (!activeRef.current) return;
        if (isApiErrorStatus(error, 409)) {
          try {
            const current = await getChatShownProjectsPreference();
            if (!activeRef.current) return;
            desiredRef.current = current.value;
            revisionRef.current = current.revision;
            setShownProjects(current.value);
            setState({
              ready: true,
              notice: 'Project selection changed in another Mandible window. Loaded the newer saved selection.',
            });
            return;
          } catch {
            // Fall through to the fail-closed unavailable state.
          }
        }
        setState({
          ready: false,
          notice: 'Project selection could not be saved; it will retry when Mandible reconnects.',
        });
      }
    });
  }, [state.ready]);

  return [shownProjects, update, state];
}
