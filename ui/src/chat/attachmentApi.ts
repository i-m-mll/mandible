import { MAX_ATTACHMENT_BYTES, type StoredAttachmentFile } from '../../../src/conversation-control/attachments';
import { browserSessionFetch } from '../client-auth-token';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/x-python', 'text/javascript', 'text/typescript',
  'text/css', 'text/html', 'text/csv', 'application/json', 'application/xml', 'application/javascript',
]);
const CODE_EXTENSION = /\.(?:txt|md|markdown|js|jsx|ts|tsx|json|yaml|yml|toml|xml|html|css|scss|py|rs|go|sh|bash|zsh|sql|csv|log|diff|patch|c|cc|cpp|h|hpp|java|rb|php|swift|kt)$/i;

function supportedType(file: File): boolean {
  return IMAGE_TYPES.has(file.type) || TEXT_TYPES.has(file.type)
    || (CODE_EXTENSION.test(file.name) && (!file.type || file.type === 'application/octet-stream' || file.type.startsWith('text/')));
}

export async function importAttachment(file: File): Promise<StoredAttachmentFile> {
  if (!supportedType(file)) throw new Error(`${file.name}: choose a text/code file or PNG, JPEG, WebP, or GIF image.`);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: files must be 5 MiB or smaller.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const response = await browserSessionFetch('/api/chat-attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, media_type: TEXT_TYPES.has(file.type) || IMAGE_TYPES.has(file.type) ? file.type : 'application/octet-stream', data_base64: btoa(binary) }),
  });
  const result = await response.json() as StoredAttachmentFile | { error?: string; message?: string };
  if (!response.ok) throw new Error('message' in result && result.message ? result.message : `Attachment upload failed (${response.status}).`);
  return result as StoredAttachmentFile;
}

export function attachmentContentUrl(file: StoredAttachmentFile): string {
  return `/api/chat-attachments/${encodeURIComponent(file.id)}/content`;
}
