import { INTERFACE_NOTES_EMBED, type EmbedIdentity, type InterfaceNoteChangedPayload } from '../../../src/interface-notes/contract';
import { BRIDGE_MESSAGE, isBridgeMessage, type BridgeOperation, type BridgeToEmbed, type EmbedToBridge } from './bridgeProtocol';
import { InterfaceNotesApiError, type InterfaceNotesTransport } from './notesTransport';

const HANDSHAKE_TIMEOUT_MS = 10_000;

export type EmbedConnection =
  | { kind: 'granted'; identity: EmbedIdentity; transport: InterfaceNotesTransport }
  /** The operator has not allowed this origin yet. */
  | { kind: 'pending' };

/**
 * Opens the bridge on the daemon's origin and asks it which app this page is.
 * Resolves null when the origin serves no registered project or the bridge does not
 * answer, and pending when the operator has not allowed the origin; in both cases
 * the frame is removed.
 */
export function connectToBridge(daemonOrigin: string): Promise<EmbedConnection | null> {
  const frame = document.createElement('iframe');
  frame.src = new URL(INTERFACE_NOTES_EMBED.bridge, daemonOrigin).href;
  frame.title = 'Mandible interface notes';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const changeHandlers = new Set<{ changed(payload: InterfaceNoteChangedPayload): void; reconnected(): void }>();
  let nextId = 0;

  const post = (message: EmbedToBridge) => frame.contentWindow?.postMessage(message, daemonOrigin);
  const call = <T>(operation: BridgeOperation, ...args: unknown[]): Promise<T> => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    post({ kind: BRIDGE_MESSAGE, type: 'call', id, operation, args });
  });

  const transport: InterfaceNotesTransport = {
    listUnfiled: () => call('listUnfiled'),
    listIssueNotes: () => Promise.reject(new Error('An embedded page loads no issue’s pins.')),
    create: (input) => call('create', input),
    updateText: (id, text) => call('updateText', id, text),
    deleteUnfiled: (id) => call('deleteUnfiled', id),
    file: (request) => call('file', request),
    destinations: () => call('destinations'),
    subscribe(handlers) {
      changeHandlers.add(handlers);
      return () => changeHandlers.delete(handlers);
    },
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (connection: EmbedConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (connection?.kind !== 'granted') {
        window.removeEventListener('message', onMessage);
        frame.remove();
      }
      resolve(connection);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== daemonOrigin || !isBridgeMessage(event.data)) return;
      const message = event.data as BridgeToEmbed;
      if (message.type === 'identity') {
        finish(message.identity ? { kind: 'granted', identity: message.identity, transport } : message.pending ? { kind: 'pending' } : null);
      }
      else if (message.type === 'result') {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (!waiting) return;
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new InterfaceNotesApiError(message.error.message, message.error.status, message.error.code));
      } else if (message.type === 'changed') changeHandlers.forEach((handlers) => handlers.changed(message.payload));
      else if (message.type === 'reconnected') changeHandlers.forEach((handlers) => handlers.reconnected());
    };
    const timer = setTimeout(() => {
      console.error('The Mandible interface-notes bridge did not answer; the toolbar is not shown.');
      finish(null);
    }, HANDSHAKE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => post({ kind: BRIDGE_MESSAGE, type: 'hello' }), { once: true });
    frame.addEventListener('error', () => finish(null), { once: true });
    document.body.appendChild(frame);
  });
}
