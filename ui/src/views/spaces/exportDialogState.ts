export type ExportDialogViewState = {
  /** Last per-export path the user confirmed/overrode (empty → use resolved default). */
  path: string;
  /** Last commit message the user typed (empty → deterministic default). */
  message: string;
  issue: string; ref: string; title: string; gitPath: string; gitCommit: string; selectedId: string; checkoutId:string;
};

export const EMPTY_EXPORT_DIALOG_STATE: ExportDialogViewState = {
  path: '',
  message: '',
  issue:'',ref:'',title:'Imported document',gitPath:'',gitCommit:'',selectedId:'',checkoutId:'',
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
    issue:typeof raw.issue==='string'?raw.issue:'', ref:typeof raw.ref==='string'?raw.ref:'',
    title:typeof raw.title==='string'?raw.title:'Imported document',gitPath:typeof raw.gitPath==='string'?raw.gitPath:'',
    gitCommit:typeof raw.gitCommit==='string'?raw.gitCommit:'',selectedId:typeof raw.selectedId==='string'?raw.selectedId:'',checkoutId:typeof raw.checkoutId==='string'?raw.checkoutId:'',
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
