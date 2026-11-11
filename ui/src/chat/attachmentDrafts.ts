import { MAX_MESSAGE_ATTACHMENTS, type ChatAttachment } from '../../../src/conversation-control/attachments';
import type { ConversationRuntimeOptions } from '../api';

type Draft = { text: string; attachments: ChatAttachment[] };
export type DraftSubmitIntent = {
  id: string; message: string; draftText: string; attachments: ChatAttachment[];
  messageAnchor?: string; runtimeOptions: ConversationRuntimeOptions;
  state: 'waiting' | 'submitting' | 'failed' | 'uncertain';
};
export type AttachmentDraftResult<T> = { ok: true; value: T } | { ok: false; error: string };
type State = { drafts: Record<string, Draft>; pending: Record<string, DraftSubmitIntent> };

const STORAGE_KEY = 'mandible.chat.attachment-drafts.v1';
const emptyState = (): State => ({ drafts: {}, pending: {} });
let state: State | null = null;
const listeners = new Set<() => void>();
let writableTarget: { conversationId: string; visible: boolean } | null = null;
const highlightedAttachments = new Map<string, Map<string, number | null>>();
const highlightListeners = new Set<() => void>();

function current(): State {
  if (state) return state;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<State>;
      if (parsed.drafts && typeof parsed.drafts === 'object') {
        state = { drafts: parsed.drafts, pending: parsed.pending ?? {} };
        return state;
      }
    }
  } catch { /* Storage may be unavailable; writes will fail visibly. */ }
  state = emptyState();
  return state;
}

function update<T>(next: State, value: T): AttachmentDraftResult<T> {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  state = next;
  listeners.forEach((listener) => listener());
  return { ok: true, value };
}

export function getAttachmentDraftSnapshot(): State { return current(); }
export function subscribeAttachmentDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getConversationDraft(conversationId: string): Draft {
  return current().drafts[conversationId] ?? { text: '', attachments: [] };
}
export function getPendingSubmitIntent(conversationId: string): DraftSubmitIntent | null {
  const intent = current().pending[conversationId];
  return intent ? { ...intent, state: intent.state === 'failed' ? 'failed' : 'uncertain' } : null;
}
export function savePendingSubmitIntent(conversationId: string, intent: DraftSubmitIntent): AttachmentDraftResult<void> {
  const old = current();
  return update({ ...old, pending: { ...old.pending, [conversationId]: intent } }, undefined);
}
export function setDraftText(conversationId: string, text: string): AttachmentDraftResult<void> {
  const old = current();
  return update({ ...old, drafts: { ...old.drafts, [conversationId]: { ...getConversationDraft(conversationId), text } } }, undefined);
}
export function adoptLegacyConsoleDraft(sessionId: string, conversationId: string): AttachmentDraftResult<void> {
  const old = current();
  if (old.pending[conversationId] || old.drafts[conversationId]?.text) return { ok: true, value: undefined };
  try {
    const text = localStorage.getItem(`mandible:console:composer-draft:v1:${sessionId}`);
    return text ? setDraftText(conversationId, text) : { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export function addDraftAttachments(conversationId: string, attachments: ChatAttachment[]): AttachmentDraftResult<void> {
  if (!attachments.length) return { ok: true, value: undefined };
  const old = current();
  const draft = getConversationDraft(conversationId);
  if (draft.attachments.length + attachments.length > MAX_MESSAGE_ATTACHMENTS) return { ok: false, error: `A message can have at most ${MAX_MESSAGE_ATTACHMENTS} attachments.` };
  return update({ ...old, drafts: { ...old.drafts, [conversationId]: {
    ...draft, attachments: [...draft.attachments, ...attachments],
  } } }, undefined);
}
export function removeDraftAttachment(conversationId: string, index: number): AttachmentDraftResult<void> {
  const old = current();
  const draft = getConversationDraft(conversationId);
  if (index < 0 || index >= draft.attachments.length) return { ok: true, value: undefined };
  return update({ ...old, drafts: { ...old.drafts, [conversationId]: {
    ...draft, attachments: draft.attachments.filter((_, position) => position !== index),
  } } }, undefined);
}
export function clearAcceptedDraft(conversationId: string, submitted: Draft): AttachmentDraftResult<void> {
  const old = current();
  const draft = getConversationDraft(conversationId);
  const pending = { ...old.pending };
  delete pending[conversationId];
  // Edits made while the request was in flight remain in the draft.
  if (draft.text !== submitted.text || JSON.stringify(draft.attachments) !== JSON.stringify(submitted.attachments)) return update({ ...old, pending }, undefined);
  return update({ ...old, pending, drafts: { ...old.drafts, [conversationId]: { text: '', attachments: [] } } }, undefined);
}

export function registerWritableChatTarget(conversationId: string, visible = true): () => void {
  const registration = { conversationId, visible };
  writableTarget = registration;
  listeners.forEach((listener) => listener());
  return () => {
    if (writableTarget === registration) writableTarget = null;
    listeners.forEach((listener) => listener());
  };
}
export function getWritableChatTarget(): string | null {
  return writableTarget?.visible ? writableTarget.conversationId : null;
}
export function getSelectedWritableChatTarget(): string | null {
  return writableTarget?.conversationId ?? null;
}

export function subscribeDraftAttachmentHighlights(listener: () => void): () => void {
  highlightListeners.add(listener);
  return () => highlightListeners.delete(listener);
}
export function getDraftAttachmentHighlights(conversationId: string): ReadonlySet<string> {
  const now = Date.now();
  return new Set([...(highlightedAttachments.get(conversationId)?.entries() ?? [])]
    .filter((entry): entry is [string, number] => entry[1] !== null && entry[1] > now)
    .map(([id]) => id));
}
export function highlightDraftAttachments(conversationId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const highlights = highlightedAttachments.get(conversationId) ?? new Map<string, number | null>();
  for (const id of ids) highlights.set(id, null);
  highlightedAttachments.set(conversationId, highlights);
  if (getWritableChatTarget() === conversationId) activateDraftAttachmentHighlights(conversationId);
}
export function activateDraftAttachmentHighlights(conversationId: string): void {
  const highlights = highlightedAttachments.get(conversationId);
  if (!highlights) return;
  const expiresAt = Date.now() + 1000;
  let activated = false;
  for (const [id, expiry] of highlights) {
    if (expiry === null) {
      highlights.set(id, expiresAt);
      activated = true;
    }
  }
  if (!activated) return;
  highlightListeners.forEach((listener) => listener());
  window.setTimeout(() => {
    const now = Date.now();
    for (const [id, expiry] of highlights) if (expiry !== null && expiry <= now) highlights.delete(id);
    if (!highlights.size) highlightedAttachments.delete(conversationId);
    highlightListeners.forEach((listener) => listener());
  }, 1000);
}
