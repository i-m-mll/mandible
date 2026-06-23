// Block-editor browser-local view state (umbrella de56ffa, C14c / issue cef3eac).
//
// The editor's transient UI state — which block is open for editing and any
// in-progress draft text — is BROWSER-LOCAL (project Dataful-UX rule): it is
// never promoted to the ledger and is only ever changed by explicit user
// action. It is persisted per-Space to localStorage so an accidental refetch,
// SSE reconciliation, tab switch, or remount does not silently drop a draft the
// user is mid-edit on.
//
// This mirrors the C14b `./documentViewState` collapse-state pattern, scoped to
// the editor's own edit-session concern. Drafts are reconciled against live
// block ids on refetch: a draft for a block that no longer exists is dropped,
// but a draft for a still-present block is preserved (never reset by a reconcile).

export type BlockEditorViewState = {
  /** The block id currently open in the inline editor, or null when none. */
  editingId: string | null;
  /** Per-block in-progress draft markdown, keyed by block id. */
  drafts: Record<string, string>;
};

export const EMPTY_BLOCK_EDITOR_VIEW_STATE: BlockEditorViewState = {
  editingId: null,
  drafts: {},
};

const STORAGE_PREFIX = 'mandible.spaces.blockEditor';

/** Per-space storage key so each Space keeps its own edit-session state. */
export function blockEditorStorageKey(projectId: string, spaceId: string): string {
  return `${STORAGE_PREFIX}:${projectId || '_'}:${spaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored JSON into a safe, fully-populated view state. */
export function normalizeBlockEditorViewState(raw: unknown): BlockEditorViewState {
  if (!isPlainRecord(raw)) return { editingId: null, drafts: {} };
  const drafts: Record<string, string> = {};
  if (isPlainRecord(raw.drafts)) {
    for (const [key, value] of Object.entries(raw.drafts)) {
      if (typeof value === 'string') drafts[key] = value;
    }
  }
  const editingId = typeof raw.editingId === 'string' ? raw.editingId : null;
  return { editingId, drafts };
}

/** Read persisted editor view state for a Space; tolerant of malformed JSON. */
export function readBlockEditorViewState(
  projectId: string,
  spaceId: string,
): BlockEditorViewState {
  if (typeof window === 'undefined' || !spaceId) return { editingId: null, drafts: {} };
  try {
    const raw = window.localStorage.getItem(blockEditorStorageKey(projectId, spaceId));
    if (!raw) return { editingId: null, drafts: {} };
    return normalizeBlockEditorViewState(JSON.parse(raw));
  } catch {
    return { editingId: null, drafts: {} };
  }
}

/** Persist editor view state for a Space. No-op outside the browser. */
export function writeBlockEditorViewState(
  projectId: string,
  spaceId: string,
  state: BlockEditorViewState,
): void {
  if (typeof window === 'undefined' || !spaceId) return;
  try {
    window.localStorage.setItem(
      blockEditorStorageKey(projectId, spaceId),
      JSON.stringify(state),
    );
  } catch {
    // Storage may be unavailable (private mode, quota); view state is best-effort.
  }
}

/**
 * Reconcile editor view state against the live block-id set after a refetch.
 * Drafts (and an active edit) for blocks that no longer exist are dropped, but
 * drafts for still-present blocks are PRESERVED — a refetch/SSE reconcile never
 * discards a draft the user is still mid-edit on (Dataful-UX contract).
 */
export function reconcileBlockEditorViewState(
  prior: BlockEditorViewState,
  liveIds: readonly string[],
): BlockEditorViewState {
  const live = new Set(liveIds);
  const drafts: Record<string, string> = {};
  for (const [id, value] of Object.entries(prior.drafts)) {
    if (live.has(id)) drafts[id] = value;
  }
  const editingId = prior.editingId && live.has(prior.editingId) ? prior.editingId : null;
  return { editingId, drafts };
}
