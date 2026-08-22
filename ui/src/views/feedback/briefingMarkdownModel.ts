import { marked } from 'marked';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

import type { BriefingDirectiveItem } from '../../api';

export type BriefingMarkdownEntityKind = 'heading' | 'paragraph' | 'list-item' | 'table' | 'block-quote' | 'fenced-code';

export type BriefingMarkdownEntity = {
  kind: BriefingMarkdownEntityKind;
  start: number;
  end: number;
  quote: string;
  label: string;
  displayStart: number;
  displayEnd: number;
  headingAncestry: string[];
  sectionEnd?: number;
};

export type BriefingDirectiveDisplayRange = {
  itemId: string;
  responseType: BriefingDirectiveItem['revision']['response_type'];
  start: number;
  end: number;
  quote: string;
  containerStart: number;
  containerEnd: number;
  displayStart: number;
  displayEnd: number;
};

export type BriefingMarkdownModel = {
  markdown: string;
  entities: BriefingMarkdownEntity[];
  directives: BriefingDirectiveDisplayRange[];
  blocks: Array<{ kind: BriefingMarkdownEntityKind; displayStart: number; displayEnd: number }>;
};

type PositionedNode = {
  type?: string;
  depth?: number;
  value?: string;
  children?: PositionedNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

type DisplayBuilder = {
  value: string;
  originalOffsets: number[];
};

function appendOriginal(builder: DisplayBuilder, source: string, start: number, end: number): void {
  builder.value += source.slice(start, end);
  for (let offset = start; offset < end; offset += 1) builder.originalOffsets.push(offset);
}

function appendSynthetic(builder: DisplayBuilder, value: string): void {
  builder.value += value;
  for (let index = 0; index < value.length; index += 1) builder.originalOffsets.push(-1);
}

function firstLine(value: string): string {
  return value.replace(/^\r?\n+/, '').split(/\r?\n/, 1)[0] ?? '';
}

function lastLine(value: string): string {
  return value.replace(/\r?\n+$/, '').split(/\r?\n/).at(-1) ?? '';
}

function isListItemLine(value: string): boolean {
  return /^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(value);
}

function needsBlockBoundary(left: string, right: string): boolean {
  if (!left.trim() || !right.trim() || /\r?\n\r?\n$/.test(left) || /^\r?\n\r?\n/.test(right)) return false;
  return !(isListItemLine(lastLine(left)) && isListItemLine(firstLine(right)));
}

function trimDisplayRange(markdown: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/.test(markdown[start])) start += 1;
  while (end > start && /\s/.test(markdown[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

function originalRange(builder: DisplayBuilder, source: string, displayStart: number, displayEnd: number): { start: number; end: number; quote: string } | null {
  const trimmed = trimDisplayRange(builder.value, displayStart, displayEnd);
  if (!trimmed) return null;
  let first = trimmed.start;
  while (first < trimmed.end && builder.originalOffsets[first] < 0) first += 1;
  let last = trimmed.end - 1;
  while (last >= first && builder.originalOffsets[last] < 0) last -= 1;
  if (first > last) return null;
  const start = builder.originalOffsets[first];
  const end = builder.originalOffsets[last] + 1;
  return { start, end, quote: source.slice(start, end) };
}

function nodeOffsets(node: PositionedNode): { start: number; end: number } | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' && end > start ? { start, end } : null;
}

function semanticLabel(source: string, node: PositionedNode, kind: BriefingMarkdownEntityKind): string {
  const nodeText = (current: PositionedNode): string => current.value ?? current.children?.map(nodeText).join('') ?? '';
  if (kind === 'heading') return nodeText(node).trim() || 'heading';
  const compact = source.replace(/\s+/g, ' ').trim();
  return compact.length > 64 ? `${compact.slice(0, 63)}…` : compact || kind;
}

export function normalizeBriefingEntityContent(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function tableRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const token of marked.lexer(markdown)) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    if (token.type === 'table') ranges.push({ start: cursor, end: cursor + raw.length });
    cursor += raw.length;
  }
  return ranges;
}

/**
 * Builds the one visible Markdown document and maps every supported semantic
 * block back to exact offsets in the immutable source. Lists expose list-item
 * targets only: their list and paragraph wrappers never become competing
 * targets. Block quotes similarly own their nested paragraph target.
 */
export function buildBriefingMarkdownModel(
  source: string,
  directiveItems: BriefingDirectiveItem[],
  selectedVariantKeys: Record<string, string | null>,
  hiddenLeadingLength = 0,
): BriefingMarkdownModel {
  const builder: DisplayBuilder = { value: '', originalOffsets: [] };
  const directives: BriefingDirectiveDisplayRange[] = [];
  let cursor = hiddenLeadingLength;
  const ordered = directiveItems
    .filter((item) => item.directive && item.directive.end_offset > hiddenLeadingLength)
    .sort((left, right) => left.directive!.start_offset - right.directive!.start_offset);

  for (const item of ordered) {
    const directive = item.directive!;
    const prefixStart = cursor;
    const prefixEnd = Math.max(cursor, directive.start_offset);
    appendOriginal(builder, source, prefixStart, prefixEnd);
    const variants = item.revision.variants ?? [];
    const selectedKey = selectedVariantKeys[item.id];
    const selected = variants.find((variant) => variant.key === selectedKey) ?? variants[0];
    const bodyStart = item.revision.response_type === 'text_variant' && selected ? selected.body_start_offset : directive.body_start_offset;
    const bodyEnd = item.revision.response_type === 'text_variant' && selected ? selected.body_end_offset : directive.body_end_offset;
    const left = source.slice(prefixStart, prefixEnd);
    const body = source.slice(bodyStart, bodyEnd);
    if (needsBlockBoundary(left, body)) appendSynthetic(builder, '\n');
    const displayStart = builder.value.length;
    appendOriginal(builder, source, bodyStart, bodyEnd);
    const displayEnd = builder.value.length;
    const suffix = source.slice(directive.end_offset);
    if (needsBlockBoundary(body, suffix)) appendSynthetic(builder, '\n');
    directives.push({
      itemId: item.id,
      responseType: item.revision.response_type,
      start: bodyStart,
      end: bodyEnd,
      quote: body,
      containerStart: directive.start_offset,
      containerEnd: directive.end_offset,
      displayStart,
      displayEnd,
    });
    cursor = directive.end_offset;
  }
  appendOriginal(builder, source, cursor, source.length);

  const tree = unified().use(remarkParse).parse(builder.value) as unknown as PositionedNode;
  const tables = tableRanges(builder.value);
  const candidates: Array<{ kind: BriefingMarkdownEntityKind; node: PositionedNode; start: number; end: number }> = [];
  const walk = (node: PositionedNode, ancestors: PositionedNode[]): void => {
    const range = nodeOffsets(node);
    const inListItem = ancestors.some((ancestor) => ancestor.type === 'listItem');
    const inQuote = ancestors.some((ancestor) => ancestor.type === 'blockquote');
    const nestedQuote = node.type === 'blockquote' && inQuote;
    const table = range && tables.find((candidate) => candidate.start === range.start && candidate.end >= range.end);
    if (range) {
      if (node.type === 'heading') candidates.push({ kind: 'heading', node, ...range });
      else if (node.type === 'listItem') candidates.push({ kind: 'list-item', node, ...range });
      else if (node.type === 'blockquote' && !nestedQuote) candidates.push({ kind: 'block-quote', node, ...range });
      else if (node.type === 'code' && !inListItem && !inQuote) candidates.push({ kind: 'fenced-code', node, ...range });
      else if (node.type === 'paragraph' && !inListItem && !inQuote) {
        if (table) candidates.push({ kind: 'table', node, start: table.start, end: table.end });
        else candidates.push({ kind: 'paragraph', node, ...range });
      }
    }
    for (const child of node.children ?? []) walk(child, [...ancestors, node]);
  };
  walk(tree, []);

  const headings = candidates.filter((candidate) => candidate.kind === 'heading');
  const entities = candidates
    .filter((candidate) => !directives.some((directive) => candidate.start < directive.displayEnd && candidate.end > directive.displayStart))
    .map((candidate) => {
      const range = originalRange(builder, source, candidate.start, candidate.end);
      if (!range) return null;
      const entity: BriefingMarkdownEntity = {
        kind: candidate.kind,
        start: range.start,
        end: range.end,
        quote: range.quote,
        label: semanticLabel(range.quote, candidate.node, candidate.kind),
        displayStart: candidate.start,
        displayEnd: candidate.end,
        headingAncestry: [],
      };
      if (candidate.kind === 'heading') {
        const depth = candidate.node.depth ?? 6;
        const next = headings.find((heading) => heading.start > candidate.start && (heading.node.depth ?? 6) <= depth);
        const sectionRange = originalRange(builder, source, candidate.start, next?.start ?? builder.value.length);
        if (sectionRange) entity.sectionEnd = sectionRange.end;
      }
      return entity;
    })
    .filter((entity): entity is BriefingMarkdownEntity => entity !== null);

  const headingStack: string[] = [];
  for (const entity of entities) {
    const candidate = candidates.find((entry) => entry.start === entity.displayStart && entry.end === entity.displayEnd
      && entry.kind === entity.kind);
    const depth = candidate?.node.depth ?? 1;
    entity.headingAncestry = entity.kind === 'heading'
      ? headingStack.slice(0, Math.max(0, depth - 1))
      : [...headingStack];
    if (entity.kind === 'heading') {
      headingStack.length = Math.max(0, depth - 1);
      headingStack[depth - 1] = normalizeBriefingEntityContent(entity.label);
    }
  }

  return {
    markdown: builder.value,
    entities,
    directives,
    blocks: candidates.map((candidate) => ({ kind: candidate.kind, displayStart: candidate.start, displayEnd: candidate.end })),
  };
}

export type BriefingProposedEntityChange = {
  proposedIndex: number;
  classification: 'modified' | 'added';
};

export function compareBriefingEntities(
  proposed: BriefingMarkdownModel,
  base: BriefingMarkdownModel,
): BriefingProposedEntityChange[] {
  const key = (entity: BriefingMarkdownEntity) => [
    entity.kind,
    entity.headingAncestry.join('\u001f'),
    normalizeBriefingEntityContent(entity.quote),
  ].join('\u001e');
  const counts = (entities: BriefingMarkdownEntity[]) => {
    const result = new Map<string, number>();
    for (const entity of entities) result.set(key(entity), (result.get(key(entity)) ?? 0) + 1);
    return result;
  };
  const proposedCounts = counts(proposed.entities);
  const baseCounts = counts(base.entities);
  const sectionKey = (entity: BriefingMarkdownEntity) => [entity.kind, ...entity.headingAncestry].join('\u001e');
  const baseSections = new Map<string, BriefingMarkdownEntity[]>();
  for (const entity of base.entities) {
    const section = sectionKey(entity);
    baseSections.set(section, [...(baseSections.get(section) ?? []), entity]);
  }
  const proposedOrdinals = new Map<string, number>();
  const changes: BriefingProposedEntityChange[] = [];
  proposed.entities.forEach((entity, proposedIndex) => {
    const section = sectionKey(entity);
    const ordinal = proposedOrdinals.get(section) ?? 0;
    proposedOrdinals.set(section, ordinal + 1);
    if (proposedCounts.get(key(entity)) === 1 && baseCounts.get(key(entity)) === 1) return;
    changes.push({
      proposedIndex,
      classification: baseSections.get(section)?.[ordinal] ? 'modified' : 'added',
    });
  });
  return changes;
}

export function changedBriefingEntityIndexes(
  proposed: BriefingMarkdownModel,
  base: BriefingMarkdownModel,
): number[] {
  return compareBriefingEntities(proposed, base).map((change) => change.proposedIndex);
}
