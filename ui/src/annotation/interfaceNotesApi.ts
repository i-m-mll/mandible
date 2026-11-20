import {
  INTERFACE_NOTE_ROUTES,
  INTERFACE_NOTES_EMBED,
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

async function listIssuesWithNotes(filter: string): Promise<IssueRepoSummary[]> {
  return json<IssueRepoSummary[]>(
    await browserSessionFetch(`/api/issues?${filter}&status=open&${INTERFACE_NOTE_ROUTES.issuesWithNotesQuery}`),
    'Listing issues with notes');
}

/**
 * The API as a transport for one app's notes. Mandible's own interface gives no
 * `embed`; filing then uses `interface_notes_project` and lists the issues of the
 * project ref the menu passes. The bridge gives the embedding page's origin, which
 * each new note records, and the project id, which receives new issues and is the
 * only project whose issues are listed. Each of the bridge's writes names the
 * origin, so the daemon checks the page's grant again for every one.
 */
export function apiTransport(options: {
  app: string;
  embed?: { origin: string; projectId: string };
  subscribe: InterfaceNotesTransport['subscribe'];
}): InterfaceNotesTransport {
  const { app, embed } = options;
  const scoped = (path: string): string => embed
    ? `${path}${path.includes('?') ? '&' : '?'}${INTERFACE_NOTES_EMBED.originParam}=${encodeURIComponent(embed.origin)}`
    : path;
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
      return json<InterfaceNote>(await write('POST', scoped(INTERFACE_NOTE_ROUTES.collection), { ...input, app, ...(embed ? { origin: embed.origin } : {}) }), 'Saving the note');
    },
    async updateText(id, text) {
      return json<InterfaceNote>(await write('PATCH', scoped(INTERFACE_NOTE_ROUTES.note(id)), { text }), 'Saving the note');
    },
    async deleteUnfiled(id) {
      await json<void>(await write('DELETE', scoped(INTERFACE_NOTE_ROUTES.note(id))), 'Deleting the note');
    },
    async file(request: FileInterfaceNotesRequest) {
      const destination = 'new_issue' in request.destination && embed
        ? { new_issue: { ...request.destination.new_issue, project: embed.projectId } }
        : request.destination;
      return json(await write('POST', scoped(INTERFACE_NOTE_ROUTES.file), { ...request, destination }), 'Filing the notes');
    },
    listIssuesWithNotes: (projectRef) => listIssuesWithNotes(embed
      ? `project=${encodeURIComponent(embed.projectId)}`
      : `repo=${encodeURIComponent(projectRef)}`),
    subscribe: options.subscribe,
  };
}
