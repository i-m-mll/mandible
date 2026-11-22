import type { EmbedIdentity, InterfaceNoteChangedPayload } from '../../../src/interface-notes/contract';
import type { InterfaceNotesTransport } from './notesTransport';

/**
 * Messages between the interface-notes embed in another app's page and the bridge,
 * a hidden iframe on Mandible's origin. The embed says hello once; the bridge takes
 * the sender's origin from that message, answers with the daemon's identity for it
 * (null: the origin serves no registered project, or the operator has not allowed it)
 * and from then on answers only
 * that window and origin.
 */

export const BRIDGE_MESSAGE = 'mandible-interface-notes';

/** The transport operations the bridge performs; a loaded issue is Mandible's own. */
export type BridgeOperation = Exclude<keyof InterfaceNotesTransport, 'subscribe' | 'listIssueNotes'>;
export const BRIDGE_OPERATIONS: readonly BridgeOperation[] = ['listUnfiled', 'create', 'updateText', 'deleteUnfiled', 'file', 'destinations'];

export type BridgeFailure = { message: string; status: number; code: string | null };

export type EmbedToBridge =
  | { kind: typeof BRIDGE_MESSAGE; type: 'hello' }
  | { kind: typeof BRIDGE_MESSAGE; type: 'call'; id: number; operation: BridgeOperation; args: unknown[] };

export type BridgeToEmbed =
  /** `identity` null with `pending`: the operator has not yet allowed this origin; the embed offers the grant view. */
  | { kind: typeof BRIDGE_MESSAGE; type: 'identity'; identity: EmbedIdentity | null; pending: boolean }
  | { kind: typeof BRIDGE_MESSAGE; type: 'result'; id: number; ok: true; value: unknown }
  | { kind: typeof BRIDGE_MESSAGE; type: 'result'; id: number; ok: false; error: BridgeFailure }
  | { kind: typeof BRIDGE_MESSAGE; type: 'changed'; payload: InterfaceNoteChangedPayload }
  | { kind: typeof BRIDGE_MESSAGE; type: 'reconnected' };

export function isBridgeMessage(value: unknown): value is { kind: typeof BRIDGE_MESSAGE; type: string } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === BRIDGE_MESSAGE
    && typeof (value as { type?: unknown }).type === 'string';
}
