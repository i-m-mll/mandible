import type {
  FileInterfaceNotesRequest,
  FileInterfaceNotesResult,
  InterfaceNote,
  InterfaceNoteChangedPayload,
  InterfaceNoteDestinations,
  InterfaceNoteErrorCode,
  InterfaceNoteInput,
} from '../../../src/interface-notes/contract';

/**
 * How the toolbar host reaches the daemon. Mandible's own interface calls the API
 * directly (`interfaceNotesApi.ts`); the embed in another app's page sends each
 * operation to the bridge on Mandible's origin (`embedClient.ts`), which calls the
 * same API with the app and project the daemon resolved for that page.
 */
export interface InterfaceNotesTransport {
  listUnfiled(): Promise<InterfaceNote[]>;
  listIssueNotes(issueRef: string): Promise<InterfaceNote[]>;
  create(input: InterfaceNoteDraft): Promise<InterfaceNote>;
  updateText(id: string, text: string): Promise<InterfaceNote>;
  /** Refused with `note_filed` when the note has been filed, which leaves its comment untouched. */
  deleteUnfiled(id: string): Promise<void>;
  file(request: FileInterfaceNotesRequest): Promise<FileInterfaceNotesResult>;
  /** The app's receiving project and its open issues that carry notes. */
  destinations(): Promise<InterfaceNoteDestinations>;
  /** Follows the daemon's `interface_note:changed` events; returns the stop function. */
  subscribe(handlers: { changed(payload: InterfaceNoteChangedPayload): void; reconnected(): void }): () => void;
}

/** A note as the host makes it; the transport supplies its app and, through the embed, its origin. */
export type InterfaceNoteDraft = Omit<InterfaceNoteInput, 'app' | 'origin'>;

/** A refusal from the daemon. `code` is an `InterfaceNoteErrorCode` for the routes' own refusals, another daemon code otherwise, or null. */
export class InterfaceNotesApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: InterfaceNoteErrorCode | (string & {}) | null) {
    super(message);
    this.name = 'InterfaceNotesApiError';
  }
}

/** True when a replayed write needs no further attempt: the daemon holds, or has moved past, the state it asked for. */
export function interfaceNoteWriteSettled(error: unknown): boolean {
  return error instanceof InterfaceNotesApiError
    && (error.code === 'note_exists' || error.code === 'note_not_found' || error.code === 'note_filed');
}

/** Reads a daemon response, throwing `InterfaceNotesApiError` for a refusal. */
export async function interfaceNotesJson<T>(response: Response, action: string): Promise<T> {
  if (response.ok) return response.status === 204 ? (undefined as T) : (await response.json()) as T;
  let message = `${action} failed (${response.status}).`;
  let code: string | null = null;
  try {
    const body = await response.json() as { message?: string; error?: string };
    code = body.error ?? null;
    message = body.message ?? body.error ?? message;
  } catch { /* keep the status message */ }
  throw new InterfaceNotesApiError(message, response.status, code);
}
