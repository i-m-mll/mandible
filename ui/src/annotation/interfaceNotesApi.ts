import {
  INTERFACE_NOTE_ROUTES,
  type FileInterfaceNotesRequest,
  type FileInterfaceNotesResult,
  type InterfaceNote,
  type InterfaceNoteErrorCode,
  type InterfaceNoteInput,
} from '../../../src/interface-notes/contract';
import type { IssueRepoSummary } from '../../../src/types';
import { browserSessionFetch } from '../client-auth-token';

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

async function json<T>(response: Response, action: string): Promise<T> {
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

const write = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response> =>
  browserSessionFetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function listUnfiledInterfaceNotes(): Promise<InterfaceNote[]> {
  const result = await json<{ notes: InterfaceNote[] }>(await browserSessionFetch(INTERFACE_NOTE_ROUTES.collection), 'Loading notes');
  return result.notes;
}

export async function listIssueInterfaceNotes(issueRef: string): Promise<InterfaceNote[]> {
  const result = await json<{ notes: InterfaceNote[] }>(
    await browserSessionFetch(`${INTERFACE_NOTE_ROUTES.collection}?issue=${encodeURIComponent(issueRef)}`), 'Loading the issue’s notes');
  return result.notes;
}

export async function createInterfaceNote(input: InterfaceNoteInput): Promise<InterfaceNote> {
  return json<InterfaceNote>(await write('POST', INTERFACE_NOTE_ROUTES.collection, input), 'Saving the note');
}

export async function updateInterfaceNoteText(id: string, text: string): Promise<InterfaceNote> {
  return json<InterfaceNote>(await write('PATCH', INTERFACE_NOTE_ROUTES.note(id), { text }), 'Saving the note');
}

/** The toolbar's delete: refused with `note_filed` when the note has been filed, which leaves its comment untouched. */
export async function deleteUnfiledInterfaceNote(id: string): Promise<void> {
  await json<void>(await write('DELETE', INTERFACE_NOTE_ROUTES.note(id)), 'Deleting the note');
}

/** The issue view's remove control. */
export async function removeInterfaceNoteFromComment(id: string, commentId: string): Promise<void> {
  await json<void>(await write('DELETE', INTERFACE_NOTE_ROUTES.noteOnComment(id, commentId)), 'Removing the note');
}

export async function fileInterfaceNotes(request: FileInterfaceNotesRequest): Promise<FileInterfaceNotesResult> {
  return json<FileInterfaceNotesResult>(await write('POST', INTERFACE_NOTE_ROUTES.file, request), 'Filing the notes');
}

/** Open issues of one project that carry notes, most recently annotated first. */
export async function listIssuesWithInterfaceNotes(projectRef: string): Promise<IssueRepoSummary[]> {
  return json<IssueRepoSummary[]>(
    await browserSessionFetch(`/api/issues?repo=${encodeURIComponent(projectRef)}&status=open&${INTERFACE_NOTE_ROUTES.issuesWithNotesQuery}`),
    'Listing issues with notes');
}
