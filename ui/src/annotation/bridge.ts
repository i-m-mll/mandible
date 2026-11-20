import {
  INTERFACE_NOTE_CHANGED_EVENT,
  INTERFACE_NOTES_EMBED,
  type EmbedIdentity,
  type FileInterfaceNotesRequest,
  type InterfaceNote,
  type InterfaceNoteChangedPayload,
} from '../../../src/interface-notes/contract';
import type { IssueRepoSummary } from '../../../src/types';
import { browserSessionFetch } from '../client-auth-token';
import { SSEClient } from '../sse-client';
import { BRIDGE_MESSAGE, BRIDGE_OPERATIONS, isBridgeMessage, type BridgeOperation, type BridgeToEmbed, type EmbedToBridge } from './bridgeProtocol';
import { apiTransport } from './interfaceNotesApi';
import { interfaceNotesJson, InterfaceNotesApiError, type InterfaceNotesTransport } from './notesTransport';

/**
 * The interface-notes bridge: a hidden iframe on Mandible's origin, framed only by
 * loopback pages (`frame-ancestors`). It answers the one parent window that said
 * hello, for the app and project the daemon resolves for that window's origin, and
 * performs only note operations, on that app's notes and that project's issues.
 */

let parentOrigin: string | null = null;
let notes: InterfaceNotesTransport | null = null;
/** Notes of this app the bridge has seen; edits and deletes name only these. */
const known = new Set<string>();
/** Issue refs this bridge listed for its project; filing names only these, or a new issue. */
const fileable = new Set<string>();

const reply = (message: BridgeToEmbed) => window.parent.postMessage(message, parentOrigin!);

function refused(code: string, message: string): InterfaceNotesApiError {
  return new InterfaceNotesApiError(message, 404, code);
}

function learn(list: InterfaceNote[]): InterfaceNote[] {
  for (const note of list) known.add(note.id);
  return list;
}

async function isKnown(id: string): Promise<boolean> {
  if (known.has(id)) return true;
  // A write replayed from an earlier page names a note this bridge has not listed yet.
  learn(await notes!.listUnfiled());
  return known.has(id);
}

async function perform(operation: BridgeOperation, args: unknown[]): Promise<unknown> {
  const transport = notes!;
  switch (operation) {
    case 'listUnfiled':
      return learn(await transport.listUnfiled());
    case 'create': {
      const note = await transport.create(args[0] as Parameters<InterfaceNotesTransport['create']>[0]);
      known.add(note.id);
      return note;
    }
    case 'updateText': {
      const [id, text] = args as [string, string];
      if (!await isKnown(id)) throw refused('note_not_found', 'No such note of this app.');
      return transport.updateText(id, text);
    }
    case 'deleteUnfiled': {
      const [id] = args as [string];
      if (!await isKnown(id)) throw refused('note_not_found', 'No such note of this app.');
      return transport.deleteUnfiled(id);
    }
    case 'file': {
      const request = args[0] as FileInterfaceNotesRequest;
      if ('issue' in request.destination && !fileable.has(request.destination.issue)) {
        throw refused('issue_not_found', 'That issue is not one of this project’s issues with notes.');
      }
      const ids = request.note_ids.filter((id) => known.has(id));
      return transport.file({ ...request, note_ids: ids });
    }
    case 'listIssuesWithNotes': {
      const repos = await transport.listIssuesWithNotes('') as IssueRepoSummary[];
      for (const repo of repos) for (const issue of repo.issues) {
        fileable.add(issue.id);
        if (repo.project_key) fileable.add(`${repo.project_key}/${issue.id}`);
      }
      return repos;
    }
  }
}

function subscribe(app: string): void {
  const events = new SSEClient({ url: `/api/events/subscribe?topic=${encodeURIComponent(INTERFACE_NOTE_CHANGED_EVENT)}` });
  events.on(INTERFACE_NOTE_CHANGED_EVENT, (event) => {
    const payload = event.data as InterfaceNoteChangedPayload;
    if (payload.app === app || payload.app == null) reply({ kind: BRIDGE_MESSAGE, type: 'changed', payload: { ...payload, app: payload.app ?? null } });
  });
  events.onState((state, meta) => {
    if (state === 'open' && meta.reconnected) reply({ kind: BRIDGE_MESSAGE, type: 'reconnected' });
  });
  events.connect();
}

async function identify(origin: string): Promise<EmbedIdentity | null> {
  const response = await browserSessionFetch(`${INTERFACE_NOTES_EMBED.identity}?origin=${encodeURIComponent(origin)}`);
  if (response.status === 404 || response.status === 400) return null;
  return interfaceNotesJson<EmbedIdentity>(response, 'Identifying the page');
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !isBridgeMessage(event.data)) return;
  const message = event.data as EmbedToBridge;
  if (message.type === 'hello') {
    if (parentOrigin !== null) return;
    parentOrigin = event.origin;
    void identify(event.origin).then((identity) => {
      if (identity) {
        notes = apiTransport({ app: identity.app, project: identity.project.key, subscribe: () => () => undefined });
        subscribe(identity.app);
      }
      reply({ kind: BRIDGE_MESSAGE, type: 'identity', identity });
    }, (error: unknown) => {
      console.error('Identifying the embedding page failed.', error);
      reply({ kind: BRIDGE_MESSAGE, type: 'identity', identity: null });
    });
    return;
  }
  if (message.type !== 'call' || event.origin !== parentOrigin || !notes || !BRIDGE_OPERATIONS.includes(message.operation)) return;
  perform(message.operation, Array.isArray(message.args) ? message.args : []).then(
    (value) => reply({ kind: BRIDGE_MESSAGE, type: 'result', id: message.id, ok: true, value }),
    (error: unknown) => reply({
      kind: BRIDGE_MESSAGE, type: 'result', id: message.id, ok: false,
      error: error instanceof InterfaceNotesApiError
        ? { message: error.message, status: error.status, code: error.code }
        : { message: error instanceof Error ? error.message : String(error), status: 0, code: null },
    }),
  );
});
