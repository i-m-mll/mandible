import {
  parseSpaceSource, writeSpaceBlock, type SpaceSourceBlock,
} from '../../../../src/spaces/document-source';
import type { SpaceItem } from '../../api';
import type { MarkdownSelection, MarkdownSourceEdit } from '../../components/markdown/source';

export function spaceBlocks(spaceId: string, source: string): SpaceSourceBlock[] {
  return parseSpaceSource(spaceId, source, 0);
}

export function blockAt(blocks: readonly SpaceSourceBlock[], { start, end }: Pick<MarkdownSelection, 'start' | 'end'>) {
  return blocks.find(block => start >= block.from && end <= block.to);
}

export function addressIn(blocks: readonly SpaceSourceBlock[], id: string) {
  const matches = blocks.filter(span => span.addressed && span.block.id.startsWith(id));
  return matches.find(span => span.block.id === id) ?? (matches.length === 1 ? matches[0] : undefined);
}

export function separator(source: string): string { return /\r\n|\r|\n/.exec(source)?.[0] ?? '\n'; }

export function insertBlock(source: string, at: number, value: string): MarkdownSourceEdit {
  const eol = separator(source);
  return {
    start: at, end: at,
    text: (at > 0 ? eol + eol : '') + value + (at < source.length ? eol + eol : ''),
  };
}

export function itemFrame(spaceId: string, item: SpaceItem): string {
  const now = Date.now();
  const block_type = item.ref_type === 'artifact' ? 'artifact_embed' : item.ref_type === 'comment' ? 'comment_embed'
    : item.ref_type === 'issue' ? 'issue_embed' : 'reference';
  return writeSpaceBlock({
    id: crypto.randomUUID(), space_id: spaceId, parent_id: null, item_id: item.id,
    block_type, markdown: '', sort_key: '', metadata: {}, created_at: now, updated_at: now,
    item_snapshot: { item_id: item.id, ref_type: item.ref_type, ref_id: item.ref_id,
      ref_uri: item.ref_uri, title: item.title, metadata: item.metadata },
  });
}

export function todoFrame(spaceId: string, checked = false): string {
  const now = Date.now();
  return writeSpaceBlock({
    id: crypto.randomUUID(), space_id: spaceId, parent_id: null, item_id: null, block_type: 'todo',
    markdown: '- [' + (checked ? 'x' : ' ') + '] ', sort_key: '', metadata: {},
    item_snapshot: null, created_at: now, updated_at: now,
  });
}

export function moveSection(source: string, blocks: readonly SpaceSourceBlock[], from: SpaceSourceBlock, to: SpaceSourceBlock, after: boolean) {
  if (from === to || from.block.parent_id !== to.block.parent_id) return [];
  const subtree = (root: SpaceSourceBlock) => {
    const children = new Map<string, SpaceSourceBlock[]>();
    for (const span of blocks) {
      if (!span.block.parent_id) continue;
      const list = children.get(span.block.parent_id) ?? [];
      list.push(span);
      children.set(span.block.parent_id, list);
    }
    const included = new Set([root]);
    const pending = [root];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const child of children.get(parent.block.id) ?? []) {
        if (included.has(child)) continue;
        included.add(child);
        pending.push(child);
      }
    }
    if (!root.addressed && root.block.block_type === 'heading') {
      const level = headingLevel(root.block.markdown);
      for (const span of blocks.slice(blocks.indexOf(root) + 1)) {
        if (span.block.parent_id || (span.block.block_type === 'heading' && headingLevel(span.block.markdown) <= level)) break;
        included.add(span);
      }
    }
    return blocks.filter(span => included.has(span));
  };
  const spans = subtree(from);
  const groups: MarkdownSourceEdit[] = [];
  for (const span of spans) {
    const previous = groups.at(-1);
    if (previous && /^\s*$/.test(source.slice(previous.end, span.from))) previous.end = span.to;
    else groups.push({ start: span.from, end: span.to, text: '' });
  }
  const at = after ? subtree(to).at(-1)!.to : to.from;
  if (groups.some(group => group.start <= at && at <= group.end)) return [];
  if (groups.length === 1) {
    const { start, end } = groups[0];
    const moving = source.slice(start, end);
    if (at < start) {
      const previous = blocks[blocks.indexOf(spans[0]) - 1];
      if (!previous) return [];
      return [{ start: at, end, text: moving + source.slice(previous.to, start) + source.slice(at, previous.to) }];
    }
    const next = blocks[blocks.indexOf(spans.at(-1)!) + 1];
    if (!next) return [];
    return [{ start, end: at, text: source.slice(next.from, at) + source.slice(end, next.from) + moving }];
  }
  const eol = separator(source);
  const moved = groups.map(group => source.slice(group.start, group.end)).join(eol + eol);
  return [...groups, insertBlock(source, at, moved)];
}

function headingLevel(source: string): number {
  return /^\s*(#{1,6})(?:\s|$)/.exec(source)?.[1].length ?? (/^=+\s*$/m.test(source) ? 1 : 2);
}
