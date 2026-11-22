import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView,
} from '@codemirror/merge';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import type { Ref } from 'preact';
import { useImperativeHandle, useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './icons/Icon';
import { appTip } from './shared/AppHoverTips';
import {
  exactMarkdownSource, externalSourceUpdate, markdownEditorRange, markdownSelection,
  markdownValue, replaceMarkdownSource, textReplacement, type MarkdownSelection, type MarkdownSourceRange,
} from './markdown/source';
import { markdownPreview, markdownDirectives, markdownPreviewPolicy, type MarkdownDirectives, type MarkdownPreviewPolicy } from './markdown/preview';
import { markdownSyntax } from './markdown/syntax';
import './MarkdownDocument.css';

export type { MarkdownDirective, MarkdownDirectiveRenderer, MarkdownDirectives } from './markdown/preview';
export type { MarkdownSelection, MarkdownSourceRange } from './markdown/source';
export type MarkdownRangeDecoration = MarkdownSourceRange & { id: string; className: string };
export type MarkdownDocumentHandle = {
  select: (range: MarkdownSourceRange) => void;
};

type MarkdownDocumentProps = {
  value: string;
  readOnly: boolean;
  ariaLabel: string;
  comparison?: string;
  comparisonLayout?: 'full-document';
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  decorations?: readonly MarkdownRangeDecoration[];
  onDecorationClick?: (id: string) => void;
  documentRef?: Ref<MarkdownDocumentHandle>;
  directives?: MarkdownDirectives;
  previewPolicy?: MarkdownPreviewPolicy;
};

const editLimit = 128 * 1024;

export function isLargeMarkdownDocument(value: string): boolean {
  return value.length > editLimit;
}

function documentMode(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

const setRangeDecorations = StateEffect.define<DecorationSet>();
const rangeDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (current, transaction) => transaction.effects.find(
    (effect) => effect.is(setRangeDecorations),
  )?.value ?? current.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
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

function compareWith(original: string | undefined, layout: MarkdownDocumentProps['comparisonLayout']) {
  return original === undefined ? [] : unifiedMergeView({
    original: EditorState.create({ doc: original }).doc,
    ...(layout === 'full-document' ? {} : { collapseUnchanged: { margin: 3, minSize: 4 } }),
    mergeControls: false,
    allowInlineDiffs: true,
    syntaxHighlightDeletions: false,
  });
}

const editorTheme = EditorView.theme({
  '&': { fontFamily: 'inherit', color: 'inherit', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { fontFamily: 'inherit', padding: '0' },
  '.cm-line': { padding: '0' },
  '.cm-deletedChunk .cm-line': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
});

export function MarkdownDocument(props: MarkdownDocumentProps) {
  return <DocumentSurface {...props} syntax="markdown" />;
}

export function PlainTextEditor(props: Pick<MarkdownDocumentProps, 'value' | 'onChange' | 'ariaLabel'>) {
  return <DocumentSurface {...props} syntax="plain" readOnly={false} />;
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
    directives: new Compartment(),
    previewPolicy: new Compartment(),
  }).current;
  const activeComparison = useRef(props.comparison);
  const readOnly = props.readOnly || (props.syntax === 'markdown' && isLargeMarkdownDocument(props.value));

  useImperativeHandle(props.documentRef ?? null, () => ({
    select(range) {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = markdownEditorRange(editor.state, range);
      editor.focus();
      editor.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
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
          history(), rangeDecorations,
          compartments.directives.of(initial.directives ? markdownDirectives.of(initial.directives) : []),
          compartments.previewPolicy.of(initial.previewPolicy ? markdownPreviewPolicy.of(initial.previewPolicy) : []),
          initial.syntax === 'markdown' ? [
            markdown({ extensions: markdownSyntax, completeHTMLTags: false }), markdownPreview,
          ] : [],
          editorTheme, EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap]),
          compartments.mode.of(documentMode(readOnly)),
          compartments.label.of(EditorView.contentAttributes.of({ 'aria-label': initial.ariaLabel, 'aria-readonly': String(readOnly) })),
          compartments.comparison.of(compareWith(initial.comparison, initial.comparisonLayout)),
          EditorView.updateListener.of((update) => {
            const external = update.transactions.some((transaction) => transaction.annotation(externalSourceUpdate));
            if (update.docChanged && !external) {
              latest.current.onChange?.(markdownValue(update.state));
            }
            if (update.selectionSet || update.docChanged || external) {
              latest.current.onSelectionChange?.(markdownSelection(update.state));
            }
          }),
          EditorView.clipboardOutputFilter.of((text, state) =>
            state.selection.main.empty ? text : markdownSelection(state).quote),
          EditorView.domEventHandlers({
            click(event, editor) {
              const target = event.target;
              const id = target instanceof Element
                ? target.closest<HTMLElement>('[data-markdown-range-id]')?.dataset.markdownRangeId
                : undefined;
              if (id) latest.current.onDecorationClick?.(id);
              const link = target instanceof Element && target.closest('a[data-markdown-link]');
              return Boolean(link && !editor.state.readOnly && !event.metaKey && !event.ctrlKey);
            },
          }),
        ],
      }),
    });
    view.current = editor;
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
      compartments.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, 'aria-readonly': String(readOnly) })),
    ] });
  }, [readOnly, props.ariaLabel]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [
        compartments.directives.reconfigure(props.directives ? markdownDirectives.of(props.directives) : []),
        compartments.previewPolicy.reconfigure(props.previewPolicy ? markdownPreviewPolicy.of(props.previewPolicy) : []),
      ],
    });
  }, [props.directives, props.previewPolicy]);

  useLayoutEffect(() => {
    const editor = view.current;
    const original = props.comparison;
    const previous = activeComparison.current;
    if (!editor || original === previous) return;
    activeComparison.current = original;
    if (original === undefined || previous === undefined) {
      editor.dispatch({ effects: compartments.comparison.reconfigure(compareWith(original, props.comparisonLayout)) });
    } else {
      const previousDoc = getOriginalDoc(editor.state);
      const replacement = EditorState.create({ doc: original }).doc.toString();
      editor.dispatch({
        effects: originalDocChangeEffect(editor.state,
          EditorState.create({ doc: previousDoc }).changes(textReplacement(previousDoc, replacement))),
      });
    }
  }, [props.comparison, props.comparisonLayout]);

  function moveChange(command: typeof goToNextChunk) {
    const editor = view.current;
    if (editor && command(editor)) editor.focus();
  }

  return (
    <div className="markdown-document">
      {props.comparison !== undefined && (
        <div className="markdown-document__navigation">
          <button type="button" className="btn btn--ghost btn--sm" aria-label="Previous change" {...appTip('Previous change')}
            onClick={() => moveChange(goToPreviousChunk)}><Icon name="disclosureLess" /></button>
          <button type="button" className="btn btn--ghost btn--sm" aria-label="Next change" {...appTip('Next change')}
            onClick={() => moveChange(goToNextChunk)}><Icon name="disclosureMore" /></button>
        </div>
      )}
      <div ref={mount} />
    </div>
  );
}
