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
import { interfaceNotesJson, InterfaceNotesApiError, type InterfaceNoteDraft, type InterfaceNotesTransport } from './notesTransport';

/**
 * The interface-notes bridge: a hidden iframe on Mandible's origin, framed only by
 * loopback pages (`frame-ancestors`). It answers the one parent window that said
 * hello, for the app and project the operator allowed for that window's origin, and
 * performs only note operations, on that app's notes and that project's issues.
 */

export type BridgeAccess = { kind: 'granted'; identity: EmbedIdentity } | { kind: 'pending' } | { kind: 'none' };

/** What the bridge reaches outside itself; the frame wires the real window and API, tests substitute them. */
export interface BridgeDeps {
  parent: { postMessage(message: BridgeToEmbed, targetOrigin: string): void };
  access(origin: string): Promise<BridgeAccess>;
  transport(identity: EmbedIdentity, origin: string): InterfaceNotesTransport;
  /** Follows this app's change events; `reconnected` after the stream reopens. */
  follow(app: string, handlers: { changed(payload: InterfaceNoteChangedPayload): void; reconnected(): void }): void;
}

export type BridgeEvent = { source: unknown; origin: string; data: unknown };

function refused(code: string, message: string): InterfaceNotesApiError {
  return new InterfaceNotesApiError(message, 404, code);
}

function sameOrigin(url: unknown, origin: string): boolean {
  if (typeof url !== 'string' || !URL.canParse(url)) return false;
  return new URL(url).origin === origin;
}

/** The bridge's message handler. */
export function createBridge(deps: BridgeDeps): (event: BridgeEvent) => void {
  let parentOrigin: string | null = null;
  let notes: InterfaceNotesTransport | null = null;
  /** Notes of this app the bridge has seen; edits, deletes and filing name only these. */
  const known = new Set<string>();
  /** Issue refs this bridge listed for its project; filing names only these, or a new issue. */
  const fileable = new Set<string>();
  const reply = (message: BridgeToEmbed) => deps.parent.postMessage(message, parentOrigin!);

  const learn = (list: InterfaceNote[]): InterfaceNote[] => {
    for (const note of list) known.add(note.id);
    return list;
  };

  const isKnown = async (id: unknown): Promise<boolean> => {
    if (typeof id !== 'string') return false;
    if (known.has(id)) return true;
    // A write replayed from an earlier page names a note this bridge has not listed yet.
    learn(await notes!.listUnfiled());
    return known.has(id);
  };

  async function perform(operation: BridgeOperation, args: unknown[]): Promise<unknown> {
    const transport = notes!;
    switch (operation) {
      case 'listUnfiled':
        return learn(await transport.listUnfiled());
      case 'create': {
        const input = args[0] as InterfaceNoteDraft;
        if (!sameOrigin(input?.target?.url, parentOrigin!)) throw refused('invalid_note', 'A note’s page URL must be on the page’s own origin.');
        const note = await transport.create(input);
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
        const destination = request?.destination;
        if (destination && 'issue' in destination && !fileable.has(destination.issue)) {
          throw refused('issue_not_found', 'That issue is not one of this project’s issues with notes.');
        }
        const ids = Array.isArray(request?.note_ids) ? request.note_ids.filter((id) => known.has(id)) : [];
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

  return (event) => {
    if (event.source !== deps.parent || !isBridgeMessage(event.data)) return;
    const message = event.data as EmbedToBridge;
    if (message.type === 'hello') {
      if (parentOrigin !== null) return;
      const origin = event.origin;
      parentOrigin = origin;
      void deps.access(origin).then((access) => {
        if (access.kind === 'granted') {
          notes = deps.transport(access.identity, origin);
          deps.follow(access.identity.app, {
            changed: (payload) => reply({ kind: BRIDGE_MESSAGE, type: 'changed', payload }),
            reconnected: () => reply({ kind: BRIDGE_MESSAGE, type: 'reconnected' }),
          });
        }
        reply({ kind: BRIDGE_MESSAGE, type: 'identity', identity: access.kind === 'granted' ? access.identity : null, pending: access.kind === 'pending' });
      }, (error: unknown) => {
        console.error('Identifying the embedding page failed.', error);
        reply({ kind: BRIDGE_MESSAGE, type: 'identity', identity: null, pending: false });
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
  };
}

async function access(origin: string): Promise<BridgeAccess> {
  const response = await browserSessionFetch(INTERFACE_NOTES_EMBED.identity, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }),
  });
  if (response.status === 403) return { kind: 'pending' };
  if (response.status === 404 || response.status === 400) return { kind: 'none' };
  return { kind: 'granted', identity: await interfaceNotesJson<EmbedIdentity>(response, 'Identifying the page') };
}

function follow(app: string, handlers: { changed(payload: InterfaceNoteChangedPayload): void; reconnected(): void }): void {
  const events = new SSEClient({ url: `/api/events/subscribe?topic=${encodeURIComponent(INTERFACE_NOTE_CHANGED_EVENT)}` });
  events.on(INTERFACE_NOTE_CHANGED_EVENT, (event) => {
    const payload = event.data as InterfaceNoteChangedPayload;
    if (payload.app === app || payload.app == null) handlers.changed({ ...payload, app: payload.app ?? null });
  });
  events.onState((state, meta) => {
    if (state === 'open' && meta.reconnected) handlers.reconnected();
  });
  events.connect();
}

if (typeof window !== 'undefined' && window.parent !== window) {
  const handle = createBridge({
    parent: window.parent as unknown as BridgeDeps['parent'],
    access,
    transport: (identity, origin) => apiTransport({ app: identity.app, embed: { origin, projectId: identity.project.id }, subscribe: () => () => undefined }),
    follow,
  });
  window.addEventListener('message', (event) => handle(event));
}
