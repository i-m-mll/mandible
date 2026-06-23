// Export-dialog browser-local view state (umbrella de56ffa, C13f / issue f7be021).
//
// The export dialog's user-confirmable inputs (the per-export path the user
// last confirmed, the optional per-repo-override toggle, and the last commit
// message) are BROWSER-LOCAL view state, not ledger state: the canonical
// export-path defaults live server-side (`space_exports` settings, custody-doc
// §5.1), and the only ledger mutations are the explicit export / settings POSTs.
//
// Per the project Dataful-UX rule we persist this per-Space to localStorage so a
// re-open of the dialog (after a tab switch, refetch, or app restart) restores
// the user's last-confirmed intent instead of silently resetting it. It is never
// promoted to canonical state and is only ever changed by an explicit user edit.

export type ExportDialogViewState = {
  /** Last per-export path the user confirmed/overrode (empty → use resolved default). */
  path: string;
  /** Last commit message the user typed (empty → deterministic default). */
  message: string;
  /** Whether the user's last action also saved a per-repo path override. */
  saveAsRepoDefault: boolean;
};

export const EMPTY_EXPORT_DIALOG_STATE: ExportDialogViewState = {
  path: '',
  message: '',
  saveAsRepoDefault: false,
};

const STORAGE_PREFIX = 'mandible.spaces.export-dialog';

/** Per-(project, space) storage key so each Space keeps its own dialog intent. */
export function exportDialogStorageKey(projectId: string, spaceId: string): string {
  return `${STORAGE_PREFIX}:${projectId || '_'}:${spaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored JSON into a safe, fully-populated dialog state. */
export function normalizeExportDialogState(raw: unknown): ExportDialogViewState {
  if (!isPlainRecord(raw)) return { ...EMPTY_EXPORT_DIALOG_STATE };
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    saveAsRepoDefault: raw.saveAsRepoDefault === true,
  };
}

/** Read persisted export-dialog view state for a Space; tolerant of bad JSON. */
export function readExportDialogState(projectId: string, spaceId: string): ExportDialogViewState {
  if (typeof window === 'undefined' || !spaceId) return { ...EMPTY_EXPORT_DIALOG_STATE };
  try {
    const raw = window.localStorage.getItem(exportDialogStorageKey(projectId, spaceId));
    if (!raw) return { ...EMPTY_EXPORT_DIALOG_STATE };
    return normalizeExportDialogState(JSON.parse(raw));
  } catch {
    return { ...EMPTY_EXPORT_DIALOG_STATE };
  }
}

/** Persist export-dialog view state for a Space. No-op outside the browser. */
export function writeExportDialogState(
  projectId: string,
  spaceId: string,
  state: ExportDialogViewState,
): void {
  if (typeof window === 'undefined' || !spaceId) return;
  try {
    window.localStorage.setItem(
      exportDialogStorageKey(projectId, spaceId),
      JSON.stringify(state),
    );
  } catch {
    // Storage may be unavailable (private mode, quota); view state is best-effort.
  }
}
