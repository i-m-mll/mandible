// Document-renderer browser-local view state (umbrella de56ffa, C14b).
//
// The read-only document renderer's ONLY user-visible view state is which
// heading sub-trees are collapsed. Per the project Dataful-UX rule this is
// BROWSER-LOCAL state (never ledger/canonical): it is persisted per-Space to
// localStorage and survives tab switches, refetches, SSE `space:*`
// reconciliation, and remounts. It is never promoted to a contract request and
// is only ever changed by an explicit user toggle.
//
// This mirrors the C8 collection-view-state pattern
// (./collectionViewState.ts), scoped to the single collapse concern the
// read-only renderer owns.

export type DocumentViewState = {
  /** Collapsed heading-block ids, keyed for stable per-block persistence. */
  collapsed: Record<string, boolean>;
};

export const EMPTY_DOCUMENT_VIEW_STATE: DocumentViewState = {
  collapsed: {},
};

const STORAGE_PREFIX = 'mandible.spaces.document';

/** Per-space storage key so each Space keeps its own collapse state. */
export function documentStorageKey(projectId: string, spaceId: string): string {
  return `${STORAGE_PREFIX}:${projectId || '_'}:${spaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored JSON into a safe, fully-populated view state. */
export function normalizeDocumentViewState(raw: unknown): DocumentViewState {
  if (!isPlainRecord(raw)) return { ...EMPTY_DOCUMENT_VIEW_STATE, collapsed: {} };
  const collapsed: Record<string, boolean> = {};
  if (isPlainRecord(raw.collapsed)) {
    for (const [key, value] of Object.entries(raw.collapsed)) {
      if (typeof value === 'boolean') collapsed[key] = value;
    }
  }
  return { collapsed };
}

/** Read persisted document view state for a Space; tolerant of malformed JSON. */
export function readDocumentViewState(projectId: string, spaceId: string): DocumentViewState {
  if (typeof window === 'undefined' || !spaceId) return { collapsed: {} };
  try {
    const raw = window.localStorage.getItem(documentStorageKey(projectId, spaceId));
    if (!raw) return { collapsed: {} };
    return normalizeDocumentViewState(JSON.parse(raw));
  } catch {
    return { collapsed: {} };
  }
}

/** Persist document view state for a Space. No-op outside the browser. */
export function writeDocumentViewState(
  projectId: string,
  spaceId: string,
  state: DocumentViewState,
): void {
  if (typeof window === 'undefined' || !spaceId) return;
  try {
    window.localStorage.setItem(documentStorageKey(projectId, spaceId), JSON.stringify(state));
  } catch {
    // Storage may be unavailable (private mode, quota); view state is best-effort.
  }
}

/**
 * Reconcile collapse state against the live block-id set after a refetch. Stale
 * collapse keys (blocks that no longer exist) are dropped, but EXISTING user
 * collapse intent is preserved — a refetch/SSE reconcile never resets collapse
 * state for blocks that are still present (Dataful-UX contract).
 */
export function reconcileDocumentViewState(
  prior: DocumentViewState,
  liveIds: readonly string[],
): DocumentViewState {
  const live = new Set(liveIds);
  const collapsed: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(prior.collapsed)) {
    if (live.has(id)) collapsed[id] = value;
  }
  return { collapsed };
}
