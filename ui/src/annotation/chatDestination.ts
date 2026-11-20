import { interfaceNoteAttachment, type InterfaceNote } from '../../../src/interface-notes/contract';
import type { ChatAttachment } from '../../../src/conversation-control/attachments';
import {
  addDraftAttachments,
  getConversationDraft,
  getSelectedWritableChatTarget,
  getWritableChatTarget,
  highlightDraftAttachments,
  type AttachmentDraftResult,
} from '../chat/attachmentDrafts';
import { navigateTo, viewHref } from '../routing';
import type { InterfaceNotesMenuPorts } from './InterfaceNotesMenu';

type ChatAnnotation = Extract<ChatAttachment, { kind: 'annotation' }>;

/** Appends annotations to the selected writable Chat's draft, skipping ones it already holds. */
export function stageAnnotationAttachments(annotations: readonly ChatAnnotation[]): AttachmentDraftResult<{ target: string; addedIds: string[] }> {
  if (!annotations.length) return { ok: false, error: 'There are no notes to send.' };
  const target = getSelectedWritableChatTarget();
  if (!target) return { ok: false, error: 'Select a writable Chat before sending notes.' };
  const existing = new Set(getConversationDraft(target).attachments.flatMap((attachment) => (attachment.kind === 'annotation' ? [attachment.id] : [])));
  const added = annotations.filter((annotation) => !existing.has(annotation.id));
  const result = addDraftAttachments(target, added);
  return result.ok ? { ok: true, value: { target, addedIds: added.map((annotation) => annotation.id) } } : result;
}

/** The Send menu's Chat destination in Mandible: stages the notes and opens the Chat. */
export const chatDestination: NonNullable<InterfaceNotesMenuPorts['chat']> = {
  target: getSelectedWritableChatTarget,
  stage(notes: readonly InterfaceNote[]): string | null {
    const staged = stageAnnotationAttachments(notes.map((note, index) => interfaceNoteAttachment(note, index + 1)));
    if (!staged.ok) return staged.error;
    highlightDraftAttachments(staged.value.target, staged.value.addedIds);
    // Opening a conversation reloads it, so a Chat that is already showing is left as it is.
    if (getWritableChatTarget() !== staged.value.target) navigateTo(viewHref('console', { conversation: staged.value.target }));
    return null;
  },
};
