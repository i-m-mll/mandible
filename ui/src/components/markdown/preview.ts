import { syntaxTree } from '@codemirror/language';
import { getChunks } from '@codemirror/merge';
import { Facet, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import katex from 'katex';
import { leadingMarkdownFrontmatter, type MarkdownFrontmatter } from '../../../../src/markdown-frontmatter';
import { mathToken } from '../../lib/markdownMath';
import { remarkDirectives } from '../../lib/remarkDirectives';
import { isResourceRef, resourceRefHref } from '../../resource-refs';
import { markdownSourceRange, type MarkdownSelection } from './source';

export type MarkdownDirective = MarkdownSelection & {
  name: string;
  kind: 'container' | 'leaf' | 'inline';
  attributes: Readonly<Record<string, string | null | undefined>>;
};

type MarkdownDirectiveMount = HTMLElement | { element: HTMLElement; destroy: () => void };
export type MarkdownDirectiveRenderer = (directive: MarkdownDirective, document: Document) => MarkdownDirectiveMount;
export type MarkdownDirectives = ReadonlyMap<string, MarkdownDirectiveRenderer>;
export const markdownDirectives = Facet.define<MarkdownDirectives, MarkdownDirectives | undefined>({
  combine: ([directives]) => directives,
});

export type MarkdownPreviewPolicy = {
  images?: 'omit';
  directivePreview?: 'on-changed-text';
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
  | { kind: 'table'; rows: string[][] }
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
      case 'table': {
        const table = document.createElement('table');
        const [header, ...rows] = content.rows;
        for (const [row, isHeader] of [[header, true], ...rows.map((row) => [row, false])] as [string[], boolean][]) {
          const target = (isHeader ? table.createTHead() : table.tBodies[0] ?? table.createTBody()).insertRow();
          for (const value of row) {
            const cell = document.createElement(isHeader ? 'th' : 'td');
            cell.textContent = value;
            target.append(cell);
          }
        }
        return table;
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

type DirectiveSpan = Span & Pick<MarkdownDirective, 'kind' | 'attributes' | 'name'>;

type DirectiveNode = ReturnType<typeof remarkDirectives.parse>['children'][number];

function readDirectives(node: DirectiveNode, output: DirectiveSpan[]) {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if ((node.type === 'containerDirective' || node.type === 'leafDirective' || node.type === 'textDirective')
    && from !== undefined && to !== undefined) {
    output.push({
      name: node.name, attributes: node.attributes ?? {}, from, to,
      kind: node.type === 'containerDirective' ? 'container' : node.type === 'leafDirective' ? 'leaf' : 'inline',
    });
    return;
  }
  if ('children' in node) for (const child of node.children) readDirectives(child, output);
}

function readSpecialSyntax(state: EditorState) {
  const source = state.doc.toString();
  const frontmatter = leadingMarkdownFrontmatter(source);
  const directives: DirectiveSpan[] = [];
  const start = frontmatter?.end ?? 0;
  const body = source.slice(start);
  if (/:+[a-z]/i.test(body)) {
    for (const node of remarkDirectives.parse(body).children) readDirectives(node, directives);
    for (const directive of directives) {
      directive.from += start;
      directive.to += start;
    }
  }
  return { frontmatter, directives };
}

const specials = StateField.define({
  create: readSpecialSyntax,
  update: (previous, transaction) => transaction.docChanged ? readSpecialSyntax(transaction.state) : previous,
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
    if (!render || selected(state, focused, directive)
        || (policy?.directivePreview !== 'on-changed-text' && changed(state, directive))) continue;
    const block = directive.kind !== 'inline';
    const widget = new DirectiveWidget({
      ...markdownSourceRange(state, directive),
      name: directive.name, kind: directive.kind, attributes: directive.attributes,
    }, render);
    marks.push(Decoration.replace({ widget, block }).range(directive.from, directive.to));
  }

  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === 'Document') return;
      if (frontmatter && ref.to <= frontmatter.end) return false;
      while (directives[directiveIndex]?.to <= ref.from) directiveIndex++;
      const directive = directives[directiveIndex];
      if (directive && directive.from <= ref.from && ref.to <= directive.to) return false;
      const node = ref.node;
      const inDirective = (range: Span) => directive && directive.from < range.to && directive.to > range.from;
      const name = node.name;
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
        case 'Table': {
          if (hidden(node)) {
            const rows: string[][] = [];
            for (let row = node.firstChild; row; row = row.nextSibling) {
              if (row.name === 'TableHeader' || row.name === 'TableRow') rows.push(row.getChildren('TableCell').map(text));
            }
            if (rows.length) replace(node, { kind: 'table', rows }, true);
          }
          return false;
        }
        case 'FencedCode':
        case 'CodeBlock': {
          const last = state.doc.lineAt(node.to).number;
          for (let number = state.doc.lineAt(node.from).number; number <= last; number++) {
            lineMark(state.doc.line(number).from, 'markdown-document__code');
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
          const showSource = !hidden(node) || inDirective(node);
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
        case 'ListMark':
          if (hidden(state.doc.lineAt(node.from)) && /^[*+\-]$/.test(text(node))) {
            marks.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
          return;
        case 'TaskMarker':
          if (hidden(node)) replace(node, { kind: 'task', checked: /x/i.test(text(node)) });
          return;
        case 'Link':
        case 'Autolink':
        case 'Image': {
          if (!hidden(node) || inDirective(node)) return;
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
          if (math && hidden(node) && !inDirective(node)) {
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
  toDOM(view: EditorView) {
    const bullet = view.dom.ownerDocument.createElement('span');
    bullet.textContent = '•';
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
    return transaction.docChanged || !state.selection.eq(startState.selection)
      || syntaxTree(state) !== syntaxTree(startState) || focused !== previous.focused
      || getChunks(state)?.chunks !== getChunks(startState)?.chunks
      || state.facet(markdownDirectives) !== startState.facet(markdownDirectives)
      || state.facet(markdownPreviewPolicy) !== startState.facet(markdownPreviewPolicy)
      ? { focused, decorations: previewDecorations(state, focused) } : previous;
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
});

export const markdownPreview = [
  specials, liveMarkdown, EditorView.focusChangeEffect.of((_state, focused) => setFocus.of(focused)),
];
