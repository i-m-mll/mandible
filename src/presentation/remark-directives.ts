import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';

export const remarkDirectives = unified().use(remarkParse).use(remarkDirective);

export type MarkdownNode = ReturnType<typeof remarkDirectives.parse>['children'][number];
export type MarkdownFrame = Extract<MarkdownNode, { type: 'containerDirective' }> & {
  body: { from: number; to: number };
};
export type MarkdownPart =
  | { kind: 'prose'; offset: number; nodes: MarkdownNode[] }
  | { kind: 'frame'; from: number; to: number; node: MarkdownFrame };

// The marker identifies an exact-source frame. Ordinary remark containers retain their usual grammar.
export function markdownParts(source: string, frameNames: ReadonlySet<string>): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const openers = /^(:{3,})([a-z][a-z0-9-]*)\{[^\r\n]*\bspace-frame="1"[^\r\n]*\}(?=\r\n|\r|\n)/gmi;
  let offset = 0;
  for (const match of source.matchAll(openers)) {
    const from = match.index;
    if (from < offset || !frameNames.has(match[2])) continue;
    const openingEnd = from + match[0].length;
    const prefix = remarkDirectives.parse(source.slice(offset, openingEnd)).children;
    const node = prefix.at(-1);
    if (node?.type !== 'containerDirective' || node.name !== match[2]
      || node.attributes?.['space-frame'] !== '1' || node.position?.start.offset !== from - offset) continue;
    const closing = new RegExp(`(?:\\r\\n|\\r|\\n)${match[1]}(?=\\r\\n|\\r|\\n|$)`, 'g');
    const bodyFrom = openingEnd + (source.startsWith('\r\n', openingEnd) ? 2 : 1);
    closing.lastIndex = bodyFrom;
    const close = closing.exec(source);
    if (!close) continue;
    // The writer inserts LF before the closer; a literal body-ending CR stays in the body.
    const bodyTo = close.index + close[0].length - match[1].length - 1;
    const to = close.index + close[0].length;
    prefix.pop();
    if (prefix.length) parts.push({ kind: 'prose', offset, nodes: prefix });
    parts.push({ kind: 'frame', from, to, node: { ...node, body: { from: bodyFrom, to: bodyTo } } });
    offset = to;
  }
  const nodes = remarkDirectives.parse(source.slice(offset)).children;
  if (nodes.length) parts.push({ kind: 'prose', offset, nodes });
  return parts;
}

export function frameMarkdown(name: string, attributes: Record<string, string>, source: string): string {
  let width = 3;
  for (const match of source.matchAll(/:+/g)) width = Math.max(width, match[0].length + 1);
  const fence = ':'.repeat(width);
  const attrs = Object.entries({ 'space-frame': '1', ...attributes })
    .map(([key, value]) => `${key}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;')}"`).join(' ');
  return `${fence}${name}{${attrs}}\n${source}\n${fence}`;
}
