import { pushAppHistory, replaceAppHistory } from '../app-history';
import { useRef } from 'preact/hooks';
import type { DiffFileIdentity } from '../components/diff-file-identity';
import { routeHashWithParams, shortRouteId } from '../routing';
import { DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE, normalizeAuthChangeBreakdownViewState, type AuthChangeBreakdownViewState } from './auth-change-breakdown-state';

export type AuthReviewView = 'info' | 'diff' | 'console';
export type AuthActionViewState = { expanded: boolean; actionIds: string[] };
export type AuthInfoSnapshot = {
  requestId: string;
  breakdown: AuthChangeBreakdownViewState;
  description: { descriptionExpanded: boolean; referencesExpanded: boolean };
  actions: AuthActionViewState;
  showSpec: boolean;
  showDirtyNote: boolean;
  outerOffset: number;
  itemOffsets: Record<string, number>;
};

type ReviewHistory = { version: 1; entryId: string; info?: AuthInfoSnapshot };
const HISTORY_KEY = 'mandibleAuthReview';
export const AUTH_REVIEW_SELECTORS = ['view', 'diff_old', 'diff_new'] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function offset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function reviewHistory(): ReviewHistory | null {
  const stored = record(record(window.history.state)[HISTORY_KEY]);
  if (stored.version !== 1 || typeof stored.entryId !== 'string') return null;
  const info = record(stored.info);
  const description = record(info.description);
  const actions = record(info.actions);
  return {
    version: 1, entryId: stored.entryId,
    ...(typeof info.requestId === 'string' ? { info: {
      requestId: info.requestId,
      breakdown: normalizeAuthChangeBreakdownViewState(info.breakdown, DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE),
      description: { descriptionExpanded: description.descriptionExpanded !== false, referencesExpanded: description.referencesExpanded !== false },
      actions: { expanded: actions.expanded !== false, actionIds: Array.isArray(actions.actionIds) ? actions.actionIds.filter((id): id is string => typeof id === 'string') : [] },
      showSpec: info.showSpec === true, showDirtyNote: info.showDirtyNote !== false,
      outerOffset: offset(info.outerOffset),
      itemOffsets: Object.fromEntries(Object.entries(record(info.itemOffsets))
        .filter(([key]) => key.startsWith(`auth-breakdown-scroll:${info.requestId}:`))
        .map(([key, value]) => [key, offset(value)])),
    } } : {}),
  };
}

function historyState(review: ReviewHistory): Record<string, unknown> {
  return { ...record(window.history.state), [HISTORY_KEY]: review };
}

export function authReviewHash(hash: string, requestId: string, view: AuthReviewView, file?: DiffFileIdentity): string {
  return routeHashWithParams(hash, 'auth', {
    request: shortRouteId(requestId), view,
    diff_old: file?.oldPath ?? null, diff_new: file?.newPath ?? null,
  }, AUTH_REVIEW_SELECTORS);
}

export function navigateAuthFile(requestId: string, file: DiffFileIdentity, info: AuthInfoSnapshot): void {
  const origin = reviewHistory();
  replaceAppHistory(authReviewHash(window.location.hash, requestId, 'info'), historyState({ version: 1, entryId: origin?.entryId ?? crypto.randomUUID(), info }));
  pushAppHistory(authReviewHash(window.location.hash, requestId, 'diff', file), historyState({ version: 1, entryId: crypto.randomUUID() }));
}

export function navigateAuthReviewView(requestId: string, view: AuthReviewView): void {
  pushAppHistory(authReviewHash(window.location.hash, requestId, view), historyState({ version: 1, entryId: crypto.randomUUID() }));
}

export type AuthReviewNavigation = {
  view?: AuthReviewView;
  file?: DiffFileIdentity;
  token: string;
  info?: AuthInfoSnapshot;
};

/** The app router supplies activations; refetches and context-only URL patches do not reapply them. */
export function useAuthReviewNavigation(params: Record<string, string>, active: boolean): AuthReviewNavigation {
  const stored = !active || typeof window === 'undefined' ? null : reviewHistory();
  const view = params.view === 'info' || params.view === 'diff' || params.view === 'console' ? params.view : undefined;
  const file = view === 'diff' && (params.diff_old || params.diff_new)
    ? { oldPath: params.diff_old || null, newPath: params.diff_new || null } : undefined;
  const key = JSON.stringify([stored?.entryId, view, file?.oldPath, file?.newPath]);
  const activation = useRef({ key, active, generation: 0, info: stored?.info });
  const result = useRef<AuthReviewNavigation>({ view, file, token: `${key}:0`, info: view === 'info' ? stored?.info : undefined });
  if (!active) {
    activation.current.active = false;
    return result.current;
  }
  if (active && (!activation.current.active || activation.current.key !== key)) {
    activation.current.generation += 1;
    activation.current.info = stored?.info;
  }
  activation.current.key = key;
  activation.current.active = active;
  result.current = { view, file, token: `${key}:${activation.current.generation}`, info: view === 'info' ? activation.current.info : undefined };
  return result.current;
}
