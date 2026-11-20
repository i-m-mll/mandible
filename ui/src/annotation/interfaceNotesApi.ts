import {
  INTERFACE_NOTE_ROUTES,
  type FileInterfaceNotesRequest,
  type InterfaceNote,
} from '../../../src/interface-notes/contract';
import type { IssueRepoSummary } from '../../../src/types';
import { browserSessionFetch } from '../client-auth-token';
import { interfaceNotesJson as json, type InterfaceNotesTransport } from './notesTransport';

/** The interface-notes API on this page's own Mandible origin: Mandible's interface and the embed bridge. */

const write = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response> =>
  browserSessionFetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The issue view's remove control. */
export async function removeInterfaceNoteFromComment(id: string, commentId: string): Promise<void> {
  await json<void>(await write('DELETE', INTERFACE_NOTE_ROUTES.noteOnComment(id, commentId)), 'Removing the note');
}

async function listIssuesWithNotes(projectRef: string): Promise<IssueRepoSummary[]> {
  return json<IssueRepoSummary[]>(
    await browserSessionFetch(`/api/issues?repo=${encodeURIComponent(projectRef)}&status=open&${INTERFACE_NOTE_ROUTES.issuesWithNotesQuery}`),
    'Listing issues with notes');
}

/**
 * The API as a transport for one app's notes. `project`, when given, receives the
 * new issues filing creates; without it the daemon uses `interface_notes_project`.
 */
export function apiTransport(options: {
  app: string;
  project?: string;
  subscribe: InterfaceNotesTransport['subscribe'];
}): InterfaceNotesTransport {
  const { app, project } = options;
  return {
    async listUnfiled() {
      return (await json<{ notes: InterfaceNote[] }>(await browserSessionFetch(INTERFACE_NOTE_ROUTES.unfiled(app)), 'Loading notes')).notes;
    },
    async listIssueNotes(issueRef) {
      const result = await json<{ notes: InterfaceNote[] }>(
        await browserSessionFetch(`${INTERFACE_NOTE_ROUTES.collection}?issue=${encodeURIComponent(issueRef)}`), 'Loading the issue’s notes');
      return result.notes;
    },
    async create(input) {
      return json<InterfaceNote>(await write('POST', INTERFACE_NOTE_ROUTES.collection, { ...input, app }), 'Saving the note');
    },
    async updateText(id, text) {
      return json<InterfaceNote>(await write('PATCH', INTERFACE_NOTE_ROUTES.note(id), { text }), 'Saving the note');
    },
    async deleteUnfiled(id) {
      await json<void>(await write('DELETE', INTERFACE_NOTE_ROUTES.note(id)), 'Deleting the note');
    },
    async file(request: FileInterfaceNotesRequest) {
      const destination = 'new_issue' in request.destination && project
        ? { new_issue: { ...request.destination.new_issue, project } }
        : request.destination;
      return json(await write('POST', INTERFACE_NOTE_ROUTES.file, { ...request, destination }), 'Filing the notes');
    },
    listIssuesWithNotes: (projectRef) => listIssuesWithNotes(project ?? projectRef),
    subscribe: options.subscribe,
  };
}
