import type { ChatAttachment } from '../../../src/conversation-control/attachments';
import type { ConversationRuntimeOptions } from '../api';

type Annotation = Extract<ChatAttachment, { kind: 'annotation' }>;
type Draft = { text: string; attachments: ChatAttachment[] };
export type DraftSubmitIntent = {
  id: string; message: string; draftText: string; attachments: ChatAttachment[];
  messageAnchor?: string; runtimeOptions: ConversationRuntimeOptions;
  state: 'waiting' | 'submitting' | 'failed' | 'uncertain';
};
export type AttachmentDraftResult<T> = { ok: true; value: T } | { ok: false; error: string };
type State = { annotations: Annotation[]; lastCleared: Annotation[] | null; drafts: Record<string, Draft>; pending: Record<string, DraftSubmitIntent> };

const STORAGE_KEY = 'mandible.chat.attachment-drafts.v1';
const emptyState = (): State => ({ annotations: [], lastCleared: null, drafts: {}, pending: {} });
let state: State | null = null;
const listeners = new Set<() => void>();
let writableTarget: string | null = null;

function current(): State {
  if (state) return state;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as State;
      if (Array.isArray(parsed.annotations) && parsed.drafts && typeof parsed.drafts === 'object') {
        state = { ...parsed, pending: parsed.pending ?? {} };
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
export function addDraftAttachments(conversationId: string, attachments: ChatAttachment[]): AttachmentDraftResult<void> {
  if (!attachments.length) return { ok: true, value: undefined };
  const old = current();
  const draft = getConversationDraft(conversationId);
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

export function saveAnnotation(annotation: Annotation): AttachmentDraftResult<void> {
  const old = current();
  const index = old.annotations.findIndex((entry) => entry.id === annotation.id);
  const annotations = [...old.annotations];
  if (index < 0) annotations.push(annotation); else annotations[index] = annotation;
  return update({ ...old, annotations }, undefined);
}
export function removeAnnotation(id: string): AttachmentDraftResult<void> {
  const old = current();
  if (!old.annotations.some((entry) => entry.id === id)) return { ok: true, value: undefined };
  return update({ ...old, annotations: old.annotations.filter((entry) => entry.id !== id) }, undefined);
}
export function clearAnnotations(): AttachmentDraftResult<boolean> {
  const old = current();
  if (!old.annotations.length) return { ok: true, value: false };
  return update({ ...old, annotations: [], lastCleared: old.annotations }, true);
}
export function undoClearAnnotations(): AttachmentDraftResult<boolean> {
  const old = current();
  if (!old.lastCleared?.length) return { ok: true, value: false };
  const existing = new Set(old.annotations.map((entry) => entry.id));
  return update({ ...old, annotations: [...old.lastCleared.filter((entry) => !existing.has(entry.id)), ...old.annotations], lastCleared: null }, true);
}

export function registerWritableChatTarget(conversationId: string): () => void {
  writableTarget = conversationId;
  listeners.forEach((listener) => listener());
  return () => {
    if (writableTarget === conversationId) writableTarget = null;
    listeners.forEach((listener) => listener());
  };
}
export function getWritableChatTarget(): string | null { return writableTarget; }
export function pasteAnnotationsToVisibleChat(): AttachmentDraftResult<boolean> {
  const target = writableTarget;
  const old = current();
  if (!target || !old.annotations.length) return { ok: true, value: false };
  const draft = getConversationDraft(target);
  return update({ ...old, annotations: [], lastCleared: old.annotations, drafts: {
    ...old.drafts,
    [target]: { ...draft, attachments: [...draft.attachments, ...old.annotations.map((entry) => structuredClone(entry))] },
  } }, true);
}
