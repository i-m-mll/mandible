import { syntaxTree } from '@codemirror/language';
import { getChunks } from '@codemirror/merge';
import { Facet, StateEffect, StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import katex from 'katex';
import { maskAuthoredReferenceColons } from '../../../../src/ledger/authored-references.js';
import { leadingMarkdownFrontmatter, type MarkdownFrontmatter } from '../../../../src/markdown-frontmatter';
import { mathToken } from '../../lib/markdownMath';
import { markdownParts, type MarkdownNode } from '../../../../src/presentation/remark-directives.js';
import { isResourceRef, resourceRefHref } from '../../resource-refs';
import { externalSourceUpdate, markdownEditorRange, markdownSourceRange, markdownValue, type MarkdownSelection } from './source';
import { markdownTables } from './tables';
import { markdownCodeHighlighting } from './code-highlighting';
import { footnoteLabel } from './syntax';
import { SPACE_FRAME_NAMES } from '../../../../src/spaces/directives.js';

export type MarkdownDirective = MarkdownSelection & {
  name: string;
  kind: 'container' | 'leaf' | 'inline';
  attributes: Readonly<Record<string, string | null | undefined>>;
  body?: MarkdownSelection;
};

type MarkdownDirectiveMount = HTMLElement | { element: HTMLElement; destroy: () => void };
export type MarkdownDirectiveRenderer = {
  (directive: MarkdownDirective, document: Document): MarkdownDirectiveMount;
  accepts?: (directive: MarkdownDirective) => boolean;
};
export type MarkdownDirectives = ReadonlyMap<string, MarkdownDirectiveRenderer | 'transparent'>;
export const markdownDirectives = Facet.define<MarkdownDirectives, MarkdownDirectives | undefined>({
  combine: ([directives]) => directives,
});

export type MarkdownPreviewPolicy = {
  images?: 'omit';
  directivePreview?: 'on-changed-text';
  protectSpaceFrames?: boolean;
};
export const markdownPreviewPolicy = Facet.define<MarkdownPreviewPolicy, MarkdownPreviewPolicy | undefined>({
  combine: ([policy]) => policy,
});

type Span = { from: number; to: number };

function selected(state: EditorState, focused: boolean, range: Span): boolean {
  return state.selection.ranges.some(({ from, to, empty }) =>
    (focused || !empty) && from <= range.to && to >= range.from);
}

function changed(state: EditorState, range: Span): boolean {
  const chunks = getChunks(state)?.chunks;
  if (!chunks?.length) return false;
  let left = 0;
  let right = chunks.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (chunks[middle].toB <= range.from) left = middle + 1;
    else right = middle;
  }
  return left < chunks.length && chunks[left].fromB < range.to;
}

function safeUrl(source: string, image: boolean): string | undefined {
  if (!source || /[\u0000-\u0020\u007F]/.test(source)) return;
  if (!image && isResourceRef(source)) return resourceRefHref(source);
  if (/^[\\/]{2}/.test(source) || source.includes('\\')) return;
  const protocol = /^[a-z][a-z\d+.-]*:/i.exec(source)?.[0].toLowerCase();
  if (protocol && protocol !== 'https:' && protocol !== 'http:' && (image || protocol !== 'mailto:')) return;
  return source;
}

type PreviewContent =
  | { kind: 'task'; checked: boolean }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'math'; formula: string; display: boolean }
  | { kind: 'frontmatter'; entries: MarkdownFrontmatter['entries'] };

class PreviewWidget extends WidgetType {
  constructor(readonly content: PreviewContent) { super(); }

  eq(other: PreviewWidget) {
    return JSON.stringify(this.content) === JSON.stringify(other.content);
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const content = this.content;
    switch (content.kind) {
      case 'task': {
        const mark = document.createElement('span');
        mark.setAttribute('role', 'checkbox');
        mark.setAttribute('aria-checked', String(content.checked));
        mark.setAttribute('aria-label', 'Task');
        mark.textContent = content.checked ? '☑' : '☐';
        return mark;
      }
      case 'image': {
        const image = document.createElement('img');
        image.className = 'markdown-document__image';
        image.src = content.url;
        image.alt = content.alt;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        return image;
      }
      case 'math': {
        const math = document.createElement('span');
        katex.render(content.formula, math, {
          displayMode: content.display, throwOnError: false, trust: false, strict: 'ignore',
          maxExpand: 1000, maxSize: 100,
        });
        return math;
      }
      case 'frontmatter': {
        const list = document.createElement('dl');
        list.className = 'markdown-document__frontmatter';
        list.setAttribute('aria-label', 'Document frontmatter');
        for (const { key, value } of content.entries) {
          const term = document.createElement('dt');
          term.textContent = key;
          const description = document.createElement('dd');
          description.textContent = value;
          list.append(term, description);
        }
        return list;
      }
    }
  }

  ignoreEvent() { return false; }
}

const directiveDisposers = new WeakMap<HTMLElement, () => void>();

class DirectiveWidget extends WidgetType {

  constructor(readonly directive: MarkdownDirective, readonly renderer: MarkdownDirectiveRenderer) { super(); }

  eq(other: DirectiveWidget) {
    return this.renderer === other.renderer && this.directive.start === other.directive.start
      && this.directive.quote === other.directive.quote;
  }

  toDOM(view: EditorView) {
    const mount = this.renderer(this.directive, view.dom.ownerDocument);
    if ('element' in mount) {
      directiveDisposers.set(mount.element, mount.destroy);
      return mount.element;
    }
    return mount;
  }

  destroy(dom: HTMLElement) {
    directiveDisposers.get(dom)?.();
    directiveDisposers.delete(dom);
  }
}

type DirectiveSpan = Span & Pick<MarkdownDirective, 'kind' | 'attributes' | 'name' | 'body'>;

type DirectiveNode = MarkdownNode;

function readDirectives(node: DirectiveNode, offset: number, output: DirectiveSpan[]) {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if ((node.type === 'containerDirective' || node.type === 'leafDirective' || node.type === 'textDirective')
    && from !== undefined && to !== undefined) {
    output.push({
      name: node.name, attributes: node.attributes ?? {}, from: from + offset, to: to + offset,
      kind: node.type === 'containerDirective' ? 'container' : node.type === 'leafDirective' ? 'leaf' : 'inline',
    });
    return;
  }
  if ('children' in node) for (const child of node.children) readDirectives(child, offset, output);
}

function readSpecialSyntax(state: EditorState) {
  const source = markdownValue(state);
  const frontmatter = leadingMarkdownFrontmatter(state.doc.toString());
  const directives: DirectiveSpan[] = [];
  const start = frontmatter ? markdownSourceRange(state, { from: 0, to: frontmatter.end }).end : 0;
  const body = source.slice(start);
  const hasDirective = /:{2,}[a-z][a-z0-9-]*(?=[\s\[{]|$)|:[a-z][a-z0-9-]*(?=[\[{])/im.test(body);
  if (hasDirective) {
    for (const part of markdownParts(maskAuthoredReferenceColons(body), SPACE_FRAME_NAMES)) {
      if (part.kind === 'frame') {
        const bodyStart = part.node.body.from + start, bodyEnd = part.node.body.to + start;
        directives.push({ name: part.node.name, kind: 'container', attributes: part.node.attributes ?? {},
          from: part.from + start, to: part.to + start,
          body: { start: bodyStart, end: bodyEnd, quote: source.slice(bodyStart, bodyEnd) } });
      } else {
        for (const node of part.nodes) readDirectives(node, start + part.offset, directives);
      }
    }
  }
  return { frontmatter, directives: directives.map(({ from, to, ...directive }) => ({
    ...directive, ...markdownEditorRange(state, { start: from, end: to }),
  })) };
}

type SpecialSyntax = ReturnType<typeof readSpecialSyntax>;

function mapProseEdit(previous: SpecialSyntax, { changes, startState, state }: Transaction): SpecialSyntax | null {
  const surroundingProse = /^\p{L}[^:`\[\]<>]*$/u;
  const plainText = /^[\p{L}\p{M}\p{N} ]*$/u;
  let reusable = true;
  changes.iterChangedRanges((from, to, fromB, toB) => {
    const line = startState.doc.lineAt(from);
    const nextLine = state.doc.lineAt(fromB);
    if (from === line.from || to > line.to || toB > nextLine.to || from < (previous.frontmatter?.end ?? 0)
      || !surroundingProse.test(line.text) || !surroundingProse.test(nextLine.text)
      || !plainText.test(startState.sliceDoc(from, to)) || !plainText.test(state.sliceDoc(fromB, toB))
      || previous.directives.some(directive => directive.from <= to && from <= directive.to)) reusable = false;
  });
  if (!reusable) return null;
  const map = ({ from, to }: Span) => ({ from: changes.mapPos(from), to: changes.mapPos(to) });
  return {
    frontmatter: previous.frontmatter,
    directives: previous.directives.map(directive => ({
      ...directive, ...map(directive),
      ...(directive.body && { body: markdownSourceRange(state, map(markdownEditorRange(startState, directive.body))) }),
    })),
  };
}

const specials = StateField.define({
  create: readSpecialSyntax,
  update(previous, transaction) {
    const { docChanged, startState, state } = transaction;
    if (markdownValue(state) === markdownValue(startState)) return previous;
    return (docChanged && !transaction.annotation(externalSourceUpdate) && mapProseEdit(previous, transaction)) || readSpecialSyntax(state);
  },
});

export function spaceFrameRanges(state: EditorState): Array<Span & { body: Span }> {
  return state.field(specials, false)?.directives.flatMap(directive => directive.body
    ? [{ from: directive.from, to: directive.to, body: markdownEditorRange(state, directive.body) }] : []) ?? [];
}

export const spaceFrameNavigation = EditorView.atomicRanges.of(view => {
  const ranges = spaceFrameRanges(view.state).flatMap(({ from, to, body }) => [
    Decoration.mark({}).range(from, body.from),
    Decoration.mark({}).range(body.to, to),
  ]);
  return Decoration.set(ranges, true);
});

function previewDecorations(state: EditorState, focused: boolean): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const { directives, frontmatter } = state.field(specials);
  let directiveIndex = 0;
  const text = ({ from, to }: Span) => state.sliceDoc(from, to);
  const hidden = (range: Span) => !selected(state, focused, range) && !changed(state, range);
  const replace = (range: Span, content: PreviewContent, block = false) => {
    marks.push(Decoration.replace({ widget: new PreviewWidget(content), block }).range(range.from, range.to));
  };
  const hide = ({ from, to }: Span) => {
    if (from < to) marks.push(Decoration.replace({}).range(from, to));
  };
  const mark = ({ from, to }: Span, className: string) => {
    if (from < to) marks.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lineMark = (position: number, className: string, attributes?: Record<string, string>) => {
    marks.push(Decoration.line({ class: className, attributes }).range(state.doc.lineAt(position).from));
  };
  const link = (range: Span, href: string) => {
    if (range.from < range.to) marks.push(Decoration.mark({
      tagName: 'a', class: 'markdown-document__link',
      attributes: { href, rel: 'noreferrer', 'data-markdown-link': 'true' },
    }).range(range.from, range.to));
  };

  if (frontmatter) {
    const range = { from: 0, to: frontmatter.end - Number(frontmatter.raw.endsWith('\n')) };
    if (hidden(range) && frontmatter.entries.length > 0) replace(range, { kind: 'frontmatter', entries: frontmatter.entries }, true);
  }
  const allowlist = state.facet(markdownDirectives);
  const policy = state.facet(markdownPreviewPolicy);
  for (const directive of directives) {
    const render = allowlist?.get(directive.name);
    if (!render) continue;
    const protectedFrame = Boolean(policy?.protectSpaceFrames && directive.body);
    const showFrameBody = protectedFrame && (render === 'transparent' || selected(state, focused, directive));
    if (!protectedFrame && (selected(state, focused, directive)
        || (policy?.directivePreview !== 'on-changed-text' && changed(state, directive)))) continue;
    if (render === 'transparent' || showFrameBody) {
      if (!directive.body) continue;
      const body = markdownEditorRange(state, directive.body);
      if (body.from === body.to && !protectedFrame) {
        marks.push(Decoration.replace({ block: true }).range(directive.from, directive.to));
      } else {
        marks.push(Decoration.replace({ block: true }).range(directive.from, body.from));
        marks.push(Decoration.replace({ block: true }).range(body.to, directive.to));
      }
      continue;
    }
    const block = directive.kind !== 'inline';
    const source = { ...markdownSourceRange(state, directive),
      name: directive.name, kind: directive.kind, attributes: directive.attributes, body: directive.body };
    if (render.accepts && !render.accepts(source)) continue;
    const widget = new DirectiveWidget(source, render);
    marks.push(Decoration.replace({ widget, block }).range(directive.from, directive.to));
  }

  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === 'Document') return;
      if (frontmatter && ref.to <= frontmatter.end) return false;
      while (directives[directiveIndex]?.to <= ref.from) directiveIndex++;
      const candidate = directives[directiveIndex];
      const transparent = candidate && allowlist?.get(candidate.name) === 'transparent';
      const directive = !transparent ? candidate : undefined;
      if (directive && directive.from <= ref.from && ref.to <= directive.to) return false;
      const node = ref.node;
      const inDirective = (range: Span) => directive && directive.from < range.to && directive.to > range.from;
      const name = node.name;
      const inReadOnlyCell = () => {
        if (!state.readOnly) return false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.name === 'TableCell') return true;
        }
        return false;
      };
      const inlineSourceVisible = () => (!inReadOnlyCell() && !hidden(node)) || inDirective(node);
      const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) {
        const showSource = !hidden(node);
        lineMark(node.from, `markdown-document__heading--${heading[2]}`, state.readOnly
          ? { role: 'heading', 'aria-level': heading[2]! } : undefined);
        if (!showSource) {
          for (const marker of node.getChildren('HeaderMark')) {
            const suffix = /^\s*/.exec(state.sliceDoc(marker.to, state.doc.lineAt(marker.to).to))?.[0].length ?? 0;
            hide({ from: marker.from, to: marker.to + suffix });
          }
        }
        return;
      }
      switch (name) {
        case 'HorizontalRule': {
          const line = state.doc.lineAt(node.from);
          if (hidden(node)) {
            lineMark(node.from, 'markdown-document__rule', state.readOnly ? { role: 'separator' } : undefined);
            hide({ from: node.from, to: line.to });
          }
          return false;
        }
        case 'FootnoteDefinition': {
          const label = node.getChild('FootnoteLabel');
          if (label) {
            lineMark(node.from, 'markdown-document__footnote');
            if (hidden(label)) {
              hide({ from: label.from, to: label.from + 2 });
              hide({ from: label.to - 2, to: label.to - 1 });
              mark({ from: label.from + 2, to: label.to }, 'markdown-document__footnote-label');
            }
          }
          return;
        }
        case 'FootnoteReference':
          if (footnoteLabel.test(text(node)) && !inlineSourceVisible()) {
            hide({ from: node.from, to: node.from + 2 });
            hide({ from: node.to - 1, to: node.to });
            mark({ from: node.from + 2, to: node.to - 1 }, 'markdown-document__footnote-reference');
          }
          return false;
        case 'FencedCode':
        case 'CodeBlock': {
          const last = state.doc.lineAt(node.to).number;
          for (let number = state.doc.lineAt(node.from).number; number <= last; number++) {
            lineMark(state.doc.line(number).from, 'markdown-document__code hljs');
          }
          if (name === 'FencedCode' && hidden(node)) {
            const fences = node.getChildren('CodeMark');
            const opening = fences[0];
            if (opening) hide({ from: opening.from, to: state.doc.lineAt(opening.to).to });
            if (fences.length > 1) hide(fences[fences.length - 1]);
          }
          return false;
        }
        case 'HTMLBlock':
        case 'HTMLTag':
          return false;
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'InlineCode': {
          const markers = node.getChildren(name === 'InlineCode' ? 'CodeMark'
            : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark');
          const showSource = inlineSourceVisible();
          if (markers.length >= 2 && !showSource) {
            mark({ from: markers[0].to, to: markers[markers.length - 1].from }, `markdown-document__${name}`);
            markers.forEach(hide);
          }
          return;
        }
        case 'QuoteMark':
          lineMark(node.from, 'markdown-document__quote');
          if (hidden(state.doc.lineAt(node.from))) hide(node);
          return;
        case 'ListMark': {
          const line = state.doc.lineAt(node.from);
          const bullet = /^[*+\-]$/.test(text(node));
          let depth = 0;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.name === 'ListItem') depth++;
          }
          lineMark(node.from, 'markdown-document__list', {
            style: `--markdown-list-indent: ${node.to - line.from + 1}ch`,
          });
          if (hidden(line) && bullet) {
            marks.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(node.from, node.to));
          } else if (!bullet) mark(node, 'markdown-document__ordered-marker');
          return;
        }
        case 'TaskMarker':
          if (hidden(node)) replace(node, { kind: 'task', checked: /x/i.test(text(node)) });
          return;
        case 'Link':
        case 'Autolink':
        case 'Image': {
          if (inlineSourceVisible()) return;
          const url = node.getChild('URL');
          const delimiters = node.getChildren('LinkMark');
          const range = delimiters.length >= 2 ? { from: delimiters[0].to, to: delimiters[1].from } : node;
          const target = url ? text(url) : delimiters.length === 2 && isResourceRef(text(range)) ? text(range) : '';
          const href = safeUrl(target, name === 'Image');
          if (!href) return;
          if (name === 'Image' && policy?.images === 'omit') hide(node);
          else if (name === 'Image') replace(node, { kind: 'image', url: href, alt: text(range) });
          else if (range !== node) {
            link(range, href);
            hide({ from: node.from, to: range.from });
            hide({ from: range.to, to: node.to });
          } else link(node, href);
          return name === 'Image' ? false : undefined;
        }
        case 'InlineMath': {
          const math = mathToken(text(node), false);
          if (math && !inlineSourceVisible()) {
            const block = math.display && node.from === state.doc.lineAt(node.from).from
              && node.to === state.doc.lineAt(node.to).to;
            replace(node, { kind: 'math', formula: math.text, display: block }, block);
          }
          return false;
        }
      }
    },
  });

  return Decoration.set(marks, true);
}

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) { super(); }

  eq(other: BulletWidget) { return other.depth === this.depth; }

  toDOM(view: EditorView) {
    const bullet = view.dom.ownerDocument.createElement('span');
    bullet.textContent = ['•', '◦', '▪'][(this.depth - 1) % 3] ?? '•';
    return bullet;
  }

  ignoreEvent() { return false; }
}

const setFocus = StateEffect.define<boolean>();
const liveMarkdown = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create: (state) => ({ focused: false, decorations: previewDecorations(state, false) }),
  update(previous, transaction) {
    const { startState, state } = transaction;
    const focused = transaction.effects.find((effect) => effect.is(setFocus))?.value ?? previous.focused;
    return transaction.docChanged || state.field(specials) !== startState.field(specials) || !state.selection.eq(startState.selection)
      || syntaxTree(state) !== syntaxTree(startState) || focused !== previous.focused
      || getChunks(state)?.chunks !== getChunks(startState)?.chunks
      || state.facet(markdownDirectives) !== startState.facet(markdownDirectives)
      || state.facet(markdownPreviewPolicy) !== startState.facet(markdownPreviewPolicy)
      ? { focused, decorations: previewDecorations(state, focused) } : previous;
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
});

export const markdownPreview = [
  specials, markdownTables, markdownCodeHighlighting, liveMarkdown, EditorView.focusChangeEffect.of((_state, focused) => setFocus.of(focused)),
];
