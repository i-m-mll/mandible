import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import type { Ref } from 'preact';
import { useImperativeHandle, useLayoutEffect, useRef } from 'preact/hooks';
import {
  editMarkdownSource, exactMarkdownSource, externalSourceUpdate, markdownEditorRange, markdownSelection, markdownSourceRange,
  markdownValue, replaceMarkdownSource, type MarkdownSelection, type MarkdownSourceEdit, type MarkdownSourceRange,
} from './markdown/source';
import { comparisonInput, expandUnchanged, renderedChanges, setChangePosition } from './markdown/rendered-changes';
import { markdownPreview, markdownDirectives, markdownPreviewPolicy, type MarkdownDirectives, type MarkdownPreviewPolicy } from './markdown/preview';
import { markdownSyntax } from './markdown/syntax';
import './MarkdownDocument.css';

export type { MarkdownDirective, MarkdownDirectiveRenderer, MarkdownDirectives } from './markdown/preview';
export type { MarkdownSelection, MarkdownSourceRange } from './markdown/source';
export type MarkdownRangeDecoration = MarkdownSourceRange & { id: string; className: string };
export type MarkdownDocumentHandle = {
  select: (range: MarkdownSourceRange, focus?: boolean) => void;
  edit: (edits: readonly MarkdownSourceEdit[], selection?: MarkdownSourceRange) => void;
  moveChange: (direction: -1 | 1) => void;
  positionAt: (x: number, y: number) => number | null;
  bounds: (range: MarkdownSourceRange) => DOMRect | null;
  reveal: (range: MarkdownSourceRange, focus?: boolean) => void;
  previewComment?: (range: MarkdownSourceRange | null) => void;
};

type MarkdownDocumentProps = {
  editingExtension?: import('@codemirror/state').Extension;
  value: string;
  readOnly: boolean;
  ariaLabel: string;
  comparison?: string;
  operatorComparison?: string;
  operatorAnnotations?: readonly (MarkdownSourceRange & { id: string })[];
  showSource?: boolean;
  onChangePosition?: (position: MarkdownChangePosition) => void;
  comparisonLayout?: 'full-document';
  onChange?: (value: string, edits: readonly MarkdownSourceEdit[]) => void;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  decorations?: readonly MarkdownRangeDecoration[];
  onDecorationClick?: (id: string) => void;
  onLink?: (href: string, event: MouseEvent) => boolean;
  onKeyDown?: (event: KeyboardEvent, selection: MarkdownSelection) => boolean;
  documentRef?: Ref<MarkdownDocumentHandle>;
  directives?: MarkdownDirectives;
  previewPolicy?: MarkdownPreviewPolicy;
};

export type MarkdownChangePosition = { index: number; total: number };

const editLimit = 128 * 1024;

export function isLargeMarkdownDocument(value: string): boolean {
  return value.length > editLimit;
}

function documentMode(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function documentAccessibility(label: string, readOnly: boolean) {
  return EditorView.contentAttributes.of({
    'aria-label': label,
    'aria-readonly': String(readOnly),
    ...(readOnly ? { tabindex: '0' } : {}),
  });
}

const setRangeDecorations = StateEffect.define<DecorationSet>();
const rangeDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (current, transaction) => transaction.effects.find(
    (effect) => effect.is(setRangeDecorations),
  )?.value ?? current.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
});

const setCommentPreview = StateEffect.define<DecorationSet>();
const commentPreview = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (current, transaction) => transaction.effects.find(
    effect => effect.is(setCommentPreview),
  )?.value ?? current.map(transaction.changes),
  provide: field => EditorView.decorations.from(field),
});

function commentRanges(state: EditorState, decorations: readonly MarkdownRangeDecoration[] = []) {
  return Decoration.set(decorations.flatMap((item) => {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) return [];
    const { from, to } = markdownEditorRange(state, item);
    return from < to ? [Decoration.mark({
      class: item.className,
      attributes: { 'data-markdown-range-id': item.id },
    }).range(from, to)] : [];
  }), true);
}

const editorTheme = EditorView.theme({
  '&': { fontFamily: 'inherit', color: 'inherit', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { fontFamily: 'inherit', padding: '0' },
  '.cm-line': { padding: '0' },
});

export function MarkdownDocument(props: MarkdownDocumentProps) {
  return <DocumentSurface {...props} syntax="markdown" />;
}

export function PlainTextDocument(props: MarkdownDocumentProps) {
  return <DocumentSurface {...props} syntax="plain" />;
}

export function PlainTextEditor(props: Pick<MarkdownDocumentProps, 'value' | 'onChange' | 'ariaLabel'>) {
  return <PlainTextDocument {...props} readOnly={false} />;
}

function DocumentSurface(props: MarkdownDocumentProps & { syntax: 'markdown' | 'plain' }) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const compartments = useRef({
    mode: new Compartment(),
    label: new Compartment(),
    comparison: new Compartment(),
    rendered: new Compartment(),
    directives: new Compartment(),
    previewPolicy: new Compartment(),
    editing: new Compartment(),
  }).current;
  const readOnly = props.readOnly || (props.syntax === 'markdown' && isLargeMarkdownDocument(props.value));

  const comparison = (props: MarkdownDocumentProps) => comparisonInput.of({
    agent: props.comparison,
    operator: props.operatorComparison,
    operatorAnnotations: props.operatorAnnotations,
    collapse: props.readOnly && props.comparisonLayout !== 'full-document' && !props.showSource,
    source: Boolean(props.showSource),
    policy: props.previewPolicy,
  });
  const preview = (props: MarkdownDocumentProps & { syntax: 'markdown' | 'plain' }) => props.syntax === 'markdown' && !props.showSource ? markdownPreview : [];
  const notePosition = (state: EditorState) => {
    const { selected, positions } = state.field(renderedChanges).changes;
    latest.current.onChangePosition?.({ index: positions.length ? selected + 1 : 0, total: positions.length });
  };

  useImperativeHandle(props.documentRef ?? null, () => ({
    select(range, focus = true) {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = markdownEditorRange(editor.state, range);
      if (focus) editor.focus();
      editor.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true, effects: expandUnchanged.of(from) });
    },
    bounds(range) {
      const editor = view.current;
      if (!editor) return null;
      const { from, to } = markdownEditorRange(editor.state, range);
      const start = editor.coordsAtPos(from, 1);
      if (!start) return null;
      const end = editor.coordsAtPos(to, -1);
      const right = end && Math.abs(start.top - end.top) < start.bottom - start.top ? end.right : start.right;
      return DOMRect.fromRect({ x: Math.min(start.left, right), y: start.top,
        width: Math.abs(right - start.left), height: start.bottom - start.top });
    },
    previewComment(range) {
      const editor = view.current;
      if (!editor) return;
      const marks = range ? commentRanges(editor.state, [{ ...range, id: 'comment-preview', className: 'review-range' }]) : Decoration.none;
      editor.dispatch({ effects: setCommentPreview.of(marks) });
    },
    reveal(range, focus = false) {
      const editor = view.current;
      if (!editor) return;
      if (focus) editor.focus();
      const { from } = markdownEditorRange(editor.state, range);
      editor.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'nearest' }) });
    },
    edit(edits, selection) {
      const editor = view.current;
      if (!editor || editor.state.readOnly || !edits.length) return;
      editor.dispatch(editMarkdownSource(editor.state, edits, selection));
    },
    moveChange(direction) {
      const editor = view.current;
      if (!editor) return;
      const { selected, positions } = editor.state.field(renderedChanges).changes;
      if (positions.length === 0) return;
      const index = (selected + direction + positions.length) % positions.length;
      editor.dispatch({ effects: [
        setChangePosition.of(index),
        EditorView.scrollIntoView(positions[index], { y: 'center' }),
      ] });
    },
    positionAt(x, y) {
      const editor = view.current;
      const pos = editor?.posAtCoords({ x, y }, false);
      return editor && pos != null ? markdownSourceRange(editor.state, { from: pos, to: pos }).start : null;
    },
  }), []);

  useLayoutEffect(() => {
    if (!mount.current) return;
    const initial = latest.current;
    const editor = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          exactMarkdownSource(initial.value),
          history(), rangeDecorations, commentPreview, compartments.editing.of(initial.editingExtension ?? []),
          compartments.directives.of(initial.directives ? markdownDirectives.of(initial.directives) : []),
          compartments.previewPolicy.of(initial.previewPolicy ? markdownPreviewPolicy.of(initial.previewPolicy) : []),
          initial.syntax === 'markdown' ? [
            markdown({ extensions: markdownSyntax, completeHTMLTags: false }),
          ] : [],
          compartments.rendered.of(preview(initial)),
          editorTheme, EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap]),
          compartments.mode.of(documentMode(readOnly)),
          compartments.label.of(documentAccessibility(initial.ariaLabel, readOnly)),
          compartments.comparison.of(comparison(initial)),
          renderedChanges,
          EditorView.updateListener.of((update) => {
            const before = update.startState.field(renderedChanges).changes;
            const after = update.state.field(renderedChanges).changes;
            if (before.selected !== after.selected || before.positions.length !== after.positions.length) notePosition(update.state);
            const external = update.transactions.some((transaction) => transaction.annotation(externalSourceUpdate));
            if (update.docChanged && !external) {
              const value = markdownValue(update.state);
              const edits: MarkdownSourceEdit[] = [];
              update.changes.iterChangedRanges((from, to, fromB, toB) => {
                const range = markdownSourceRange(update.startState, { from, to });
                const inserted = markdownSourceRange(update.state, { from: fromB, to: toB });
                edits.push({ ...range, text: value.slice(inserted.start, inserted.end) });
              });
              latest.current.onChange?.(value, edits);
            }
            if (update.selectionSet || update.docChanged || external) {
              latest.current.onSelectionChange?.(markdownSelection(update.state));
            }
          }),
          EditorView.clipboardOutputFilter.of((text, state) =>
            state.selection.main.empty ? text : markdownSelection(state).quote),
          EditorView.domEventHandlers({
            keydown(event, editor) {
              return latest.current.onKeyDown?.(event, markdownSelection(editor.state)) ?? false;
            },
            click(event, editor) {
              const target = event.target;
              const id = target instanceof Element
                ? target.closest<HTMLElement>('[data-markdown-range-id]')?.dataset.markdownRangeId
                : undefined;
              if (id) latest.current.onDecorationClick?.(id);
              const link = target instanceof Element && target.closest('a[data-markdown-link]');
              if (!link) return false;
              const href = link.getAttribute('href');
              if (href && latest.current.onLink?.(href, event)) {
                event.preventDefault();
                return true;
              }
              return !editor.state.readOnly && !event.metaKey && !event.ctrlKey;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    notePosition(editor.state);
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (markdownValue(editor.state) !== props.value) {
      editor.dispatch(replaceMarkdownSource(editor.state, props.value));
    }
    if (props.decorations?.length || editor.state.field(rangeDecorations).size > 0) {
      editor.dispatch({ effects: setRangeDecorations.of(commentRanges(editor.state, props.decorations)) });
    }
  }, [props.value, props.decorations]);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: [
      compartments.mode.reconfigure(documentMode(readOnly)),
      compartments.label.reconfigure(documentAccessibility(props.ariaLabel, readOnly)),
    ] });
  }, [readOnly, props.ariaLabel]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [
        compartments.directives.reconfigure(props.directives ? markdownDirectives.of(props.directives) : []),
        compartments.previewPolicy.reconfigure(props.previewPolicy ? markdownPreviewPolicy.of(props.previewPolicy) : []),
        compartments.editing.reconfigure(props.editingExtension ?? []),
      ],
    });
  }, [props.directives, props.previewPolicy, props.editingExtension]);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: [
      compartments.rendered.reconfigure(preview(props)),
      compartments.comparison.reconfigure(comparison(props)),
    ] });
  }, [props.comparison, props.operatorComparison, props.operatorAnnotations, props.comparisonLayout, props.showSource, props.previewPolicy, props.readOnly]);

  return (
    <div className={`markdown-document${props.showSource ? ' markdown-document--source' : ''}`}>
      <div ref={mount} />
    </div>
  );
}
