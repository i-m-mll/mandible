import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

import {
  displayResourceRef,
  parseResourceRef,
  resourceRefHref,
} from '../../resource-refs';

export type MarkdownSourceSelection = {
  start: number;
  end: number;
  top: number;
  left: number;
};

export type MarkdownSourceItemCommand = {
  start: number;
  end: number;
  top: number;
  left: number;
};

type CaretRange = { start: number; end: number };
export type MarkdownSourceBoundaryDirection = 'up' | 'down';

export type MarkdownSourceDecoration = {
  id: string;
  start: number;
  end: number;
  className: string;
};

export type MarkdownSourceEditorProps = {
  blockId: string;
  value: string;
  ariaLabel: string;
  onView?: (blockId: string, view: EditorView | null) => void;
  onChange: (value: string, selection: CaretRange) => void;
  onBlur: (value: string) => void;
  onCaretChange: (selection: CaretRange) => void;
  onSelectionChange: (selection: MarkdownSourceSelection | null) => void;
  onItemCommand: (command: MarkdownSourceItemCommand) => void;
  onOpenReference: (ref: string) => void;
  onBoundaryArrow?: (blockId: string, direction: MarkdownSourceBoundaryDirection) => boolean;
  readOnly?: boolean;
  decorations?: ReadonlyArray<MarkdownSourceDecoration>;
  onDecorationClick?: (id: string) => void;
};

type CallbackSet = Pick<
  MarkdownSourceEditorProps,
  | 'onChange'
  | 'onBlur'
  | 'onCaretChange'
  | 'onSelectionChange'
  | 'onItemCommand'
  | 'onOpenReference'
  | 'onBoundaryArrow'
>;

const externalUpdate = Annotation.define<boolean>();
const setExternalDecorations = StateEffect.define<ReadonlyArray<MarkdownSourceDecoration>>();
const NO_EXTERNAL_DECORATIONS: ReadonlyArray<MarkdownSourceDecoration> = [];
const BRACKET_REF_PATTERN = /\[((?:artifact|repo|mandible|issue|comment):[^\]\s]+)\]/gi;
const EMPHASIS_DELIMITERS = ['**', '__', '*', '_'] as const;

export function normalizeMarkdownSourceDecorations(
  docLength: number,
  decorations: ReadonlyArray<MarkdownSourceDecoration>,
): MarkdownSourceDecoration[] {
  return decorations
    .flatMap((decoration) => {
      if (!Number.isSafeInteger(decoration.start) || !Number.isSafeInteger(decoration.end)) {
        return [];
      }
      const start = Math.max(0, Math.min(docLength, decoration.start));
      const end = Math.max(0, Math.min(docLength, decoration.end));
      return start < end ? [{ ...decoration, start, end }] : [];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function buildExternalDecorations(
  docLength: number,
  decorations: ReadonlyArray<MarkdownSourceDecoration>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const decoration of normalizeMarkdownSourceDecorations(docLength, decorations)) {
    builder.add(
      decoration.start,
      decoration.end,
      Decoration.mark({
        class: decoration.className,
        attributes: { 'data-annotation-id': decoration.id },
      }),
    );
  }
  return builder.finish();
}

export function markdownSourceDecorationIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId ?? null;
}

const externalDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setExternalDecorations)) {
        next = buildExternalDecorations(transaction.state.doc.length, effect.value);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

type InlineDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

type EmphasisMatch = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  text: string;
  strong: boolean;
};

function findItemCommandRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { start: number; end: number } | null {
  const commandEnd = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const beforeSelection = value.slice(0, commandEnd);
  const match = /(?:^|\s)(\/item)$/.exec(beforeSelection);
  if (!match) return null;
  const start = commandEnd - match[1].length;
  return { start, end: commandEnd };
}

function headingMatch(line: string): { level: number; prefixLength: number; text: string } | null {
  const match = /^(\s{0,3})(#{1,6})(\s+)(.*)$/.exec(line);
  if (!match) return null;
  return {
    level: match[2].length,
    prefixLength: match[1].length + match[2].length + match[3].length,
    text: match[4],
  };
}

function selectionIntersects(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false;
  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true;
      continue;
    }
    if (range.from < to && range.to > from) return true;
  }
  return false;
}

function textOffsetFromNode(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return total + Math.max(0, Math.min(offset, current.textContent?.length ?? 0));
    }
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return null;
}

function renderedClickTextOffset(root: HTMLElement, event: MouseEvent): number {
  const doc = root.ownerDocument;
  const caretPositionFromPoint = (
    doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint;
  const position = caretPositionFromPoint?.call(doc, event.clientX, event.clientY);
  if (position) {
    const offset = textOffsetFromNode(root, position.offsetNode, position.offset);
    if (offset !== null) return offset;
  }

  const caretRangeFromPoint = (
    doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint;
  const range = caretRangeFromPoint?.call(doc, event.clientX, event.clientY);
  if (range) {
    const offset = textOffsetFromNode(root, range.startContainer, range.startOffset);
    if (offset !== null) return offset;
  }

  const rect = root.getBoundingClientRect();
  const textLength = root.textContent?.length ?? 0;
  if (rect.width <= 0 || textLength <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return Math.round(ratio * textLength);
}

class HeadingWidget extends WidgetType {
  constructor(
    readonly level: number,
    readonly text: string,
    readonly lineStart: number,
    readonly prefixLength: number,
    readonly onClick: (sourceOffset: number) => void,
  ) {
    super();
  }

  eq(other: HeadingWidget): boolean {
    return (
      this.level === other.level &&
      this.text === other.text &&
      this.lineStart === other.lineStart &&
      this.prefixLength === other.prefixLength
    );
  }

  toDOM(): HTMLElement {
    const node = document.createElement('span');
    node.className = `spaces-markdown-source__heading spaces-markdown-source__heading--h${this.level}`;
    node.setAttribute('role', 'heading');
    node.setAttribute('aria-level', String(this.level));
    node.setAttribute('data-heading-hit-area', 'true');
    node.textContent = this.text || ' ';
    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const renderedOffset = renderedClickTextOffset(node, event);
      this.onClick(this.lineStart + this.prefixLength + renderedOffset);
    });
    return node;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class RefWidget extends WidgetType {
  constructor(
    readonly ref: string,
    readonly label: string,
    readonly href: string,
    readonly onOpen: (ref: string) => void,
  ) {
    super();
  }

  eq(other: RefWidget): boolean {
    return this.ref === other.ref && this.label === other.label && this.href === other.href;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'resource-ref resource-ref--unresolved spaces-markdown-source__ref';
    wrapper.setAttribute('data-resource-ref', this.ref);
    wrapper.setAttribute('data-ref-state', 'unresolved');

    const anchor = document.createElement('a');
    anchor.className = 'artifact-xref resource-ref__link spaces-markdown-source__ref-link';
    anchor.href = this.href;
    anchor.textContent = this.label;
    anchor.title = `Resource reference ${this.ref}`;
    anchor.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      this.onOpen(this.ref);
    });
    wrapper.appendChild(anchor);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class EmphasisWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly strong: boolean,
    readonly sourceContentStart: number,
    readonly sourceContentEnd: number,
    readonly onClick: (sourceOffset: number) => void,
  ) {
    super();
  }

  eq(other: EmphasisWidget): boolean {
    return (
      this.text === other.text &&
      this.strong === other.strong &&
      this.sourceContentStart === other.sourceContentStart &&
      this.sourceContentEnd === other.sourceContentEnd
    );
  }

  toDOM(): HTMLElement {
    const node = document.createElement(this.strong ? 'strong' : 'em');
    node.className = this.strong
      ? 'spaces-markdown-source__emphasis spaces-markdown-source__emphasis--strong'
      : 'spaces-markdown-source__emphasis spaces-markdown-source__emphasis--em';
    node.textContent = this.text || ' ';
    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const renderedOffset = renderedClickTextOffset(node, event);
      this.onClick(this.sourceContentStart + renderedOffset);
    });
    return node;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function overlapsAny(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function findEmphasisMatches(line: string, lineStart: number): EmphasisMatch[] {
  const matches: EmphasisMatch[] = [];
  let index = 0;
  while (index < line.length) {
    const delimiter = EMPHASIS_DELIMITERS.find((candidate) => line.startsWith(candidate, index));
    if (!delimiter) {
      index += 1;
      continue;
    }

    const contentStart = index + delimiter.length;
    const close = line.indexOf(delimiter, contentStart);
    if (close === -1) {
      index += delimiter.length;
      continue;
    }

    const text = line.slice(contentStart, close);
    if (text.trim().length === 0) {
      index += delimiter.length;
      continue;
    }

    matches.push({
      from: lineStart + index,
      to: lineStart + close + delimiter.length,
      contentFrom: lineStart + contentStart,
      contentTo: lineStart + close,
      text,
      strong: delimiter.length === 2,
    });
    index = close + delimiter.length;
  }
  return matches;
}

function buildDecorations(
  view: EditorView,
  callbacksRef: { current: CallbackSet },
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    const heading = headingMatch(line.text);
    const headingActive = heading ? selectionIntersects(view, line.from, line.to) : false;
    if (heading && !headingActive) {
      builder.add(
        line.from,
        line.to,
        Decoration.replace({
          widget: new HeadingWidget(
            heading.level,
            heading.text,
            line.from,
            heading.prefixLength,
            (sourceOffset) => {
              const pos = Math.max(line.from, Math.min(line.to, sourceOffset));
              view.focus();
              view.dispatch({
                selection: EditorSelection.cursor(pos),
                scrollIntoView: true,
              });
            },
          ),
        }),
      );
      continue;
    }

    if (headingActive) continue;

    const lineDecorations: InlineDecoration[] = [];
    const protectedRanges: Array<{ from: number; to: number }> = [];

    BRACKET_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BRACKET_REF_PATTERN.exec(line.text))) {
      const ref = match[1];
      const parsed = parseResourceRef(ref);
      if (!parsed) continue;
      const from = line.from + match.index;
      const to = from + match[0].length;
      if (selectionIntersects(view, from, to)) continue;
      protectedRanges.push({ from, to });
      lineDecorations.push({
        from,
        to,
        decoration: Decoration.replace({
          widget: new RefWidget(
            parsed.canonical,
            displayResourceRef(parsed.canonical),
            resourceRefHref(parsed.canonical),
            (canonical) => callbacksRef.current.onOpenReference(canonical),
          ),
        }),
      });
    }

    for (const emphasis of findEmphasisMatches(line.text, line.from)) {
      if (selectionIntersects(view, emphasis.from, emphasis.to)) continue;
      if (overlapsAny(emphasis.from, emphasis.to, protectedRanges)) continue;
      lineDecorations.push({
        from: emphasis.from,
        to: emphasis.to,
        decoration: Decoration.replace({
          widget: new EmphasisWidget(
            emphasis.text,
            emphasis.strong,
            emphasis.contentFrom,
            emphasis.contentTo,
            (sourceOffset) => {
              const pos = Math.max(emphasis.contentFrom, Math.min(emphasis.contentTo, sourceOffset));
              view.focus();
              view.dispatch({
                selection: EditorSelection.cursor(pos),
                scrollIntoView: true,
              });
            },
          ),
        }),
      });
    }

    lineDecorations
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .forEach(({ from, to, decoration }) => builder.add(from, to, decoration));
  }
  return builder.finish();
}

function markdownDecorations(callbacksRef: { current: CallbackSet }): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, callbacksRef);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
          this.decorations = buildDecorations(update.view, callbacksRef);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function selectionCoordinates(view: EditorView, from: number): { top: number; left: number } {
  let coords: ReturnType<EditorView['coordsAtPos']> = null;
  try {
    coords = view.coordsAtPos(from);
  } catch {
    coords = null;
  }
  if (coords) {
    return {
      top: Math.max(8, coords.top - 44),
      left: Math.max(8, Math.min(coords.left, window.innerWidth - 180)),
    };
  }
  const rect = view.dom.getBoundingClientRect();
  return {
    top: Math.max(8, rect.top - 44),
    left: Math.max(8, Math.min(rect.left + 24, window.innerWidth - 180)),
  };
}

function emitSelection(view: EditorView, callbacks: CallbackSet): void {
  const range = view.state.selection.main;
  callbacks.onCaretChange({ start: range.from, end: range.to });
  if (range.empty) {
    callbacks.onSelectionChange(null);
    return;
  }
  const coords = selectionCoordinates(view, range.from);
  callbacks.onSelectionChange({
    start: range.from,
    end: range.to,
    top: coords.top,
    left: coords.left,
  });
}

function openItemCommand(
  view: EditorView,
  callbacksRef: { current: CallbackSet },
): boolean {
  const range = view.state.selection.main;
  const command = findItemCommandRange(view.state.doc.toString(), range.from, range.to);
  if (!command) return false;
  const coords = selectionCoordinates(view, range.to);
  callbacksRef.current.onItemCommand({
    start: command.start,
    end: command.end,
    top: Math.max(8, coords.top + 52),
    left: coords.left,
  });
  return true;
}

function handleBoundaryArrow(
  view: EditorView,
  blockId: string,
  direction: MarkdownSourceBoundaryDirection,
  callbacksRef: { current: CallbackSet },
): boolean {
  const callback = callbacksRef.current.onBoundaryArrow;
  if (!callback) return false;
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.from);
  if (direction === 'up' && (line.number !== 1 || range.from !== line.from)) return false;
  if (
    direction === 'down' &&
    (line.number !== view.state.doc.lines || range.from !== line.to)
  ) {
    return false;
  }
  return callback(blockId, direction);
}

const editorTheme = EditorView.theme({
  '&': {
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    lineHeight: 'inherit',
  },
  '&.cm-focused': {
    outline: '0',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflow: 'visible',
  },
  '.cm-content': {
    caretColor: 'currentColor',
    minHeight: '1.55em',
    padding: '0',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'transparent',
  },
});

export function MarkdownSourceEditor({
  blockId,
  value,
  ariaLabel,
  onView,
  onChange,
  onBlur,
  onCaretChange,
  onSelectionChange,
  onItemCommand,
  onOpenReference,
  onBoundaryArrow,
  readOnly = false,
  decorations = NO_EXTERNAL_DECORATIONS,
  onDecorationClick,
}: MarkdownSourceEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const pendingLocalValueRef = useRef<string | null>(null);
  const onDecorationClickRef = useRef(onDecorationClick);
  onDecorationClickRef.current = onDecorationClick;
  const callbacksRef = useRef<CallbackSet>({
    onChange,
    onBlur,
    onCaretChange,
    onSelectionChange,
    onItemCommand,
    onOpenReference,
    onBoundaryArrow,
  });
  callbacksRef.current = {
    onChange,
    onBlur,
    onCaretChange,
    onSelectionChange,
    onItemCommand,
    onOpenReference,
    onBoundaryArrow,
  };

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        EditorView.lineWrapping,
        editorTheme,
        markdownDecorations(callbacksRef),
        readOnlyCompartmentRef.current.of(readOnlyExtension(readOnly)),
        externalDecorationsField.init(() => buildExternalDecorations(value.length, decorations)),
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          spellcheck: 'true',
        }),
        keymap.of([
          {
            key: 'ArrowUp',
            run: (view) => handleBoundaryArrow(view, blockId, 'up', callbacksRef),
          },
          {
            key: 'ArrowDown',
            run: (view) => handleBoundaryArrow(view, blockId, 'down', callbacksRef),
          },
          {
            key: 'Enter',
            run: (view) => openItemCommand(view, callbacksRef),
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.domEventHandlers({
          blur: (_event, view) => {
            callbacksRef.current.onBlur(view.state.doc.toString());
          },
          click: (event) => {
            const id = markdownSourceDecorationIdFromTarget(event.target);
            if (!id) return false;
            onDecorationClickRef.current?.(id);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(externalUpdate))) {
            const nextValue = update.state.doc.toString();
            pendingLocalValueRef.current = nextValue;
            const range = update.state.selection.main;
            callbacksRef.current.onChange(nextValue, {
              start: range.from,
              end: range.to,
            });
          }
          if (update.docChanged || update.selectionSet || update.focusChanged) {
            emitSelection(update.view, callbacksRef.current);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    (parent as HTMLDivElement & { __spacesEditorView?: EditorView }).__spacesEditorView = view;
    onView?.(blockId, view);
    emitSelection(view, callbacksRef.current);
    return () => {
      onView?.(blockId, null);
      delete (parent as HTMLDivElement & { __spacesEditorView?: EditorView }).__spacesEditorView;
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, blockId, onView]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) {
      pendingLocalValueRef.current = null;
      return;
    }

    // CodeMirror applies user edits synchronously, while parent state updates can
    // briefly re-render this component with the previous value. Do not let that
    // stale prop replace the live editor document and move the caret backward.
    if (pendingLocalValueRef.current === current) return;

    const range = view.state.selection.main;
    const anchor = Math.max(0, Math.min(value.length, range.anchor));
    const head = Math.max(0, Math.min(value.length, range.head));
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: EditorSelection.range(anchor, head),
      annotations: externalUpdate.of(true),
    });
    pendingLocalValueRef.current = null;
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setExternalDecorations.of(decorations) });
  }, [decorations, value]);

  return (
    <div
      ref={hostRef}
      className="spaces-markdown-source"
      data-testid="spaces-block-editor-source"
      data-block-id={blockId}
    />
  );
}

export default MarkdownSourceEditor;
