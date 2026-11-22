import { SPACE_DIRECTIVE_NAMES, SPACE_DIRECTIVE_TYPES, SPACE_FRAME_NAMES } from "./directives.js";
import { remarkDirectives, markdownParts, frameMarkdown } from '../presentation/remark-directives.js';
import type { DocBlock } from './serialize.js';

export interface BlockItemSnapshot {
  item_id?: string;
  ref_type?: string;
  ref_id?: string;
  ref_uri?: string | null;
  title?: string | null;
  [key: string]: unknown;
}

export interface SpaceBlockRecord extends DocBlock {
  space_id: string;
  item_snapshot: BlockItemSnapshot | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export type SpaceSourceBlock = {
  from: number;
  to: number;
  addressed: boolean;
  block: SpaceBlockRecord;
};

export class BlockValidationError extends Error {}

const localId = (generation: number, ordinal: number) => `~${generation}-${ordinal}`;
export const isLocalBlockId = (value: string) => /^~\d+-\d+$/.test(value);

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
function decode(value: string): unknown {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('noncanonical JSON encoding');
  return JSON.parse(bytes.toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFrame(state: string | null | undefined, id: string) {
  try {
    const value = decode(state ?? '');
    if (!isRecord(value)) throw new Error('expected an object');
    const { sort_key, item_snapshot = null, metadata = {}, created_at = 0, updated_at = 0 } = value;
    if (!(sort_key === undefined || typeof sort_key === 'string') ||
        !(item_snapshot === null || isRecord(item_snapshot)) || !isRecord(metadata) ||
        typeof created_at !== 'number' || typeof updated_at !== 'number' ||
        !Number.isSafeInteger(created_at) || !Number.isSafeInteger(updated_at)) {
      throw new Error('invalid block fields');
    }
    return { sort_key: sort_key ?? '', item_snapshot, metadata, created_at, updated_at };
  } catch {
    throw new BlockValidationError(`invalid block state: ${id}`);
  }
}

function readId(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (!value || isLocalBlockId(value)) throw new BlockValidationError(`invalid ${field}: ${value}`);
  return value;
}

export function writeSpaceBlock(block: SpaceBlockRecord): string {
  const { id, parent_id, block_type, item_id, sort_key, item_snapshot, metadata, created_at, updated_at } = block;
  return frameMarkdown(SPACE_DIRECTIVE_NAMES[block_type], {
    id,
    ...(parent_id === null ? {} : { parent: parent_id }),
    ...(item_id === null ? {} : { item: item_id }),
    state: encode({ sort_key, item_snapshot, metadata, created_at, updated_at }),
  }, block.markdown);
}

export function parseSpaceSource(space_id: string, source: string, generation: number): SpaceSourceBlock[] {
  const spans: SpaceSourceBlock[] = [];
  for (const part of markdownParts(source, SPACE_FRAME_NAMES)) {
    if (part.kind === 'frame') {
      const attrs = part.node.attributes;
      const id = readId(attrs?.id, 'block id');
      const parent_id = readId(attrs?.parent, 'parent id');
      const item_id = readId(attrs?.item, 'item id');
      const state = readFrame(attrs?.state, id ?? String(part.from));
      if (item_id !== null && (id === null || state.item_snapshot === null)) {
        throw new BlockValidationError(`live embed requires an address and snapshot: ${id ?? part.from}`);
      }
      spans.push({
        from: part.from, to: part.to, addressed: id !== null,
        block: {
          ...state, id: id ?? localId(generation, spans.length), space_id, parent_id, item_id,
          block_type: SPACE_DIRECTIVE_TYPES.get(part.node.name)!,
          markdown: source.slice(part.node.body.from, part.node.body.to),
        },
      });
    } else {
      for (const node of part.nodes) {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        let from = start + part.offset;
        let to = end + part.offset;
        while (source[from - 1] === ' ' || source[from - 1] === '\t') from--;
        while (source[to] === ' ' || source[to] === '\t') to++;
        spans.push({
          from, to, addressed: false,
          block: {
            id: localId(generation, spans.length), space_id, parent_id: null,
            block_type: node.type === 'heading' ? 'heading' : 'paragraph',
            item_id: null, sort_key: '', item_snapshot: null, metadata: {}, created_at: 0, updated_at: 0,
            markdown: source.slice(from, to),
          },
        });
      }
    }
  }
  return spans;
}

type Patch = { from: number; to: number; text: string };

export function editSpaceSource(source: string, patches: Patch[]): string {
  const sorted = [...patches].sort((a, b) => a.from - b.from || a.to - b.to);
  const result: string[] = [];
  let end = 0;
  for (const patch of sorted) {
    if (patch.from < end || patch.to < patch.from || patch.to > source.length) throw new Error('overlapping document edits');
    result.push(source.slice(end, patch.from), patch.text);
    end = patch.to;
  }
  return result.join('') + source.slice(end);
}

export function documentFromBlocks(blocks: readonly SpaceBlockRecord[]): string {
  return blocks.map(writeSpaceBlock).join('\n\n');
}

function remapLocalLinks(markdown: string, ids: ReadonlyMap<string, string>): string {
  const patches: Patch[] = [];
  function visit(node: import('../presentation/remark-directives.js').MarkdownNode) {
    const from = node.position?.start.offset, to = node.position?.end.offset;
    if ((node.type === 'link' || node.type === 'definition') && from !== undefined && to !== undefined &&
      node.url.startsWith('#') && ids.has(node.url.slice(1))) {
      const text = markdown.slice(from, to);
      const destination = node.type === 'definition' ? /\]:[ \t\r\n]*<?/ : /\]\([ \t\r\n]*<?/;
      const match = destination.exec(text);
      if (match) {
        const at = from + match.index + match[0].length;
        if (markdown.slice(at, at + node.url.length) === node.url) {
          patches.push({ from: at, to: at + node.url.length, text: `#${ids.get(node.url.slice(1))}` });
        }
      }
    }
    if ('children' in node) for (const child of node.children) visit(child);
  }
  for (const node of remarkDirectives.parse(markdown).children) visit(node);
  return editSpaceSource(markdown, patches);
}

export function copyDocumentSource(spaceId: string, source: string, newId: () => string): string {
  const spans = parseSpaceSource(spaceId, source, 0);
  const ids = new Map(spans.filter(span => span.addressed).map(span => [span.block.id, newId()]));
  if (ids.size === 0) return source;
  return editSpaceSource(source, spans.flatMap(span => {
    const block = span.block;
    const markdown = remapLocalLinks(block.markdown, ids);
    if (!span.addressed && markdown === block.markdown) return [];
    if (!span.addressed) return [{ from: span.from, to: span.to, text: markdown }];
    const parent_id = block.parent_id === null ? null : ids.get(block.parent_id);
    if (parent_id === undefined) throw new BlockValidationError(`parent block not found: ${block.parent_id}`);
    return [{ from: span.from, to: span.to, text: writeSpaceBlock({
      ...block, id: ids.get(block.id)!, parent_id, item_id: null, markdown,
      metadata: { ...block.metadata, imported_block_id: block.id, imported_item_id: block.item_id },
    }) }];
  }));
}
