import { MAX_MESSAGE_ATTACHMENTS, type ChatAttachment, type StoredAttachmentFile } from '../../../src/conversation-control/attachments';
import { addDraftAttachments, getConversationDraft } from './attachmentDrafts';
import { importAttachment } from './attachmentApi';

export async function importAttachmentBatch(
  conversationId: string,
  files: readonly File[],
  upload: (file: File) => Promise<StoredAttachmentFile> = importAttachment,
): Promise<void> {
  if (getConversationDraft(conversationId).attachments.length + files.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A message can have at most ${MAX_MESSAGE_ATTACHMENTS} attachments.`);
  }
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    const stored = await upload(file);
    attachments.push({ kind: stored.media_type.startsWith('image/') ? 'image' : 'file', file: stored });
  }
  const result = addDraftAttachments(conversationId, attachments);
  if (!result.ok) throw new Error(result.error);
}
