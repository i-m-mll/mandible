import {
  INTERFACE_NOTE_ROUTES,
  INTERFACE_NOTES_EMBED,
  type FileInterfaceNotesRequest,
  type InterfaceNote,
  type InterfaceNoteDestinations,
} from '../../../src/interface-notes/contract';
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

/**
 * The API as a transport for one app's notes. The daemon resolves the app's receiving
 * project. The bridge gives the embedding page's origin, which each new note records;
 * each of the bridge's writes names it, so the daemon checks the page's grant again
 * for every one.
 */
export function apiTransport(options: {
  app: string;
  embed?: { origin: string };
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
      return json(await write('POST', scoped(INTERFACE_NOTE_ROUTES.file), request), 'Filing the notes');
    },
    async destinations() {
      return json<InterfaceNoteDestinations>(await browserSessionFetch(INTERFACE_NOTE_ROUTES.destinations(app)), 'Listing where notes can be filed');
    },
    subscribe: options.subscribe,
  };
}
