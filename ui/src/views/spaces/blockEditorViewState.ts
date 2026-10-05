// Block-editor browser-local view state (umbrella de56ffa, C14c / issue cef3eac).
//
// The editor's transient UI state — which block is open for editing and any
// in-progress draft text — is BROWSER-LOCAL (project Dataful-UX rule): it is
// never promoted to the ledger and is only ever changed by explicit user
// action. It is persisted per-Space in browser storage so an accidental refetch,
// SSE reconciliation, tab switch, or remount does not silently drop a draft the
// user is mid-edit on.
//

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
