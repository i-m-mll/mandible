import * as z from 'zod';
import { ExportError } from './export.js';

const marker = '---\nmandible_format: spaces-doc.v2\n';
const close = '\n---\n';
const header = z.object({
  space_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

type DocumentMetadata = z.infer<typeof header>;

export function writeNativeDocument(metadata: DocumentMetadata, source: string): string {
  const data = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
  return `${marker}mandible_document: ${data}${close}${source}`;
}

export function readNativeDocument(file: string): { metadata: DocumentMetadata; source: string } | null {
  if (!file.startsWith(marker)) return null;
  const separator = file.indexOf(close, marker.length);
  const line = file.slice(marker.length, separator);
  const match = /^mandible_document: ([A-Za-z0-9_-]+)$/.exec(line);
  if (separator < 0 || !match) throw new ExportError('invalid_publication', 'Native document header is malformed');
  try {
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw new Error('invalid encoding');
    return { metadata: header.parse(JSON.parse(bytes.toString('utf8'))), source: file.slice(separator + close.length) };
  } catch {
    throw new ExportError('invalid_publication', 'Native document metadata is malformed');
  }
}
