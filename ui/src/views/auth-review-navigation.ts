import { useRef } from 'preact/hooks';
import type { DiffFileIdentity } from '../components/diff-file-identity';
import { navigateTo, replaceRoute, routeWithParams, shortRouteId } from '../routing';
import { rememberEntityRoute } from '../query/entityRoute';
import { DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE, normalizeAuthChangeBreakdownViewState, type AuthChangeBreakdownViewState } from './auth-change-breakdown-state';

const AUTH_REVIEW_VIEWS = ['info', 'console', 'breakdown', 'diff'] as const;
export type AuthReviewView = typeof AUTH_REVIEW_VIEWS[number];
export type AuthBreakdownSnapshot = {
  requestId: string;
  breakdown: AuthChangeBreakdownViewState;
  outerOffset: number;
  itemOffsets: Record<string, number>;
};

type ReviewHistory = { version: 2; entryId: string; breakdown?: AuthBreakdownSnapshot };
const HISTORY_KEY = 'mandibleAuthReview';
export const AUTH_REVIEW_SELECTORS = ['view', 'diff_old', 'diff_new'] as const;

/** Replace the current Approvals route with the request the view selected, or with the bare view. */
export function replaceAuthRequestRoute(id: string | null): void {
  if (id) rememberEntityRoute('auth', shortRouteId(id), { id });
  replaceRoute(routeWithParams(
    id ? { kind: 'entity', entity: 'auth', ref: shortRouteId(id) } : { kind: 'view', tab: 'auth' },
    {},
    AUTH_REVIEW_SELECTORS,
  ));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function offset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function reviewHistory(): (ReviewHistory & { legacyBreakdown: boolean }) | null {
  const stored = record(record(window.history.state)[HISTORY_KEY]);
  if ((stored.version !== 1 && stored.version !== 2) || typeof stored.entryId !== 'string') return null;
  const snapshot = record(stored.version === 1 ? stored.info : stored.breakdown);
  return {
    version: 2, entryId: stored.entryId, legacyBreakdown: stored.version === 1 && typeof snapshot.requestId === 'string',
    ...(typeof snapshot.requestId === 'string' ? { breakdown: {
      requestId: snapshot.requestId,
      breakdown: normalizeAuthChangeBreakdownViewState(snapshot.breakdown, DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE),
      outerOffset: offset(snapshot.outerOffset),
      itemOffsets: Object.fromEntries(Object.entries(record(snapshot.itemOffsets))
        .filter(([key]) => key.startsWith(`auth-breakdown-scroll:${snapshot.requestId}:`))
        .map(([key, value]) => [key, offset(value)])),
    } } : {}),
  };
}

function historyState(review: ReviewHistory): Record<string, unknown> {
  return { ...record(window.history.state), [HISTORY_KEY]: review };
}

export function authReviewHref(requestId: string, view: AuthReviewView, file?: DiffFileIdentity): string {
  return routeWithParams({ kind: 'entity', entity: 'auth', ref: shortRouteId(requestId) }, {
    view, diff_old: file?.oldPath ?? null, diff_new: file?.newPath ?? null,
  }, AUTH_REVIEW_SELECTORS);
}

export function navigateAuthFile(requestId: string, file: DiffFileIdentity, breakdown: AuthBreakdownSnapshot): void {
  rememberEntityRoute('auth', shortRouteId(requestId), { id: requestId });
  const origin = reviewHistory();
  replaceRoute(authReviewHref(requestId, 'breakdown'), historyState({ version: 2, entryId: origin?.entryId ?? crypto.randomUUID(), breakdown }));
  navigateTo(authReviewHref(requestId, 'diff', file), historyState({ version: 2, entryId: crypto.randomUUID() }));
}

export function navigateAuthReviewView(requestId: string, view: AuthReviewView, file?: DiffFileIdentity): void {
  rememberEntityRoute('auth', shortRouteId(requestId), { id: requestId });
  navigateTo(authReviewHref(requestId, view, file), historyState({ version: 2, entryId: crypto.randomUUID() }));
}

export type AuthReviewNavigation = {
  view?: AuthReviewView;
  file?: DiffFileIdentity;
  token: string;
  breakdown?: AuthBreakdownSnapshot;
};

/** The app router supplies activations; refetches and context-only URL patches do not reapply them. */
export function useAuthReviewNavigation(params: Record<string, string>, active: boolean): AuthReviewNavigation {
  const stored = !active || typeof window === 'undefined' ? null : reviewHistory();
  const canonicalView = AUTH_REVIEW_VIEWS.find(view => view === params.view);
  const view = canonicalView === 'info' && stored?.legacyBreakdown ? 'breakdown' : canonicalView;
  const file = view === 'diff' && (params.diff_old || params.diff_new)
    ? { oldPath: params.diff_old || null, newPath: params.diff_new || null } : undefined;
  const key = JSON.stringify([stored?.entryId, view, file?.oldPath, file?.newPath]);
  const activation = useRef({ key, active, generation: 0, breakdown: stored?.breakdown });
  const result = useRef<AuthReviewNavigation>({ view, file, token: `${key}:0`, breakdown: view === 'breakdown' ? stored?.breakdown : undefined });
  if (!active) {
    activation.current.active = false;
    return result.current;
  }
  if (active && (!activation.current.active || activation.current.key !== key)) {
    activation.current.generation += 1;
    activation.current.breakdown = stored?.breakdown;
  }
  activation.current.key = key;
  activation.current.active = active;
  result.current = { view, file, token: `${key}:${activation.current.generation}`, breakdown: view === 'breakdown' ? activation.current.breakdown : undefined };
  return result.current;
}
