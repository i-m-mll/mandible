import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Chunk, type Change } from '@codemirror/merge';
import { ChangeSet, EditorState, Facet, Prec, RangeSet, StateEffect, StateField, type ChangeDesc, type Range, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { compareMarkdownWords, compareRenderedMarkdown } from './comparison';
import { markdownPreview, markdownPreviewDecorations, markdownPreviewPolicy, previewRanges, type MarkdownPreviewPolicy } from './preview';
import { markdownSyntax } from './syntax';
import { exactMarkdownSource, markdownEditorRange, markdownSelection, markdownSourceRange, type MarkdownSourceRange } from './source';

type Layer = 'agent' | 'operator';
type ComparisonInput = {
  agent?: string;
  operator?: string;
  operatorAnnotations?: readonly (MarkdownSourceRange & { id: string })[];
  collapse: boolean;
  source: boolean;
  policy?: MarkdownPreviewPolicy;
};
type Comparison = {
  original: EditorState;
  candidate: Text;
  chunks: readonly Chunk[];
  blockParts?: readonly Change[];
};

export const comparisonInput = Facet.define<ComparisonInput, ComparisonInput | undefined>({
  combine: ([input]) => input,
});

export const setChangePosition = StateEffect.define<number>();
export const expandUnchanged = StateEffect.define<number>();
const wordDiff = { override: compareMarkdownWords };


function compare(
  state: EditorState, previous: Comparison | undefined, before: string | undefined,
  previousInput: ComparisonInput | undefined, beforeKey: Layer, candidate = state.doc, changes?: ChangeDesc,
): Comparison | undefined {
  if (before === undefined) return;
  const input = state.facet(comparisonInput);
  const rendered = beforeKey === 'agent' && !input?.source;
  const reuseOriginal = previous && before === previousInput?.[beforeKey]
    && input?.source === previousInput?.source && input?.policy === previousInput?.policy;
  if (reuseOriginal && candidate.eq(previous.candidate)) return previous;
  const original = reuseOriginal ? previous.original : EditorState.create({
    doc: before,
    extensions: [
      exactMarkdownSource(before), EditorState.readOnly.of(true),
      ...(input?.source ? [] : [markdown({ extensions: markdownSyntax, completeHTMLTags: false }), markdownPreview]),
      ...(input?.policy ? [markdownPreviewPolicy.of(input.policy)] : []),
    ],
  });
  if (rendered) {
    const blockParts = compareRenderedMarkdown(original.doc.toString(), candidate.toString());
    // CodeMirror smooths adjacent changes into a navigation chunk. Keep the
    // authored block boundaries when placing the deleted text in that chunk.
    return { original, candidate, blockParts,
      chunks: Chunk.build(original.doc, candidate, { override: () => [...blockParts] }) };
  }
  const chunks = reuseOriginal && changes
    ? Chunk.updateB(previous.chunks, original.doc, candidate, changes, wordDiff)
    : Chunk.build(original.doc, candidate, wordDiff);
  return { original, candidate, chunks };
}

class DeletedText extends WidgetType {
  constructor(
    readonly original: EditorState, readonly from: number, readonly to: number, readonly layer: Layer,
    readonly block: boolean, readonly paired: boolean, readonly annotationId: string | undefined,
  ) { super(); }

  eq(other: DeletedText) {
    return this.original === other.original && this.from === other.from
      && this.to === other.to && this.layer === other.layer && this.block === other.block
      && this.paired === other.paired && this.annotationId === other.annotationId;
  }

  toDOM(view: EditorView) {
    const owner = view.dom.ownerDocument;
    const deletion = owner.createElement(this.block ? 'div' : 'span');
    deletion.className = `markdown-change markdown-change--${this.layer} markdown-change--deletion`;
    if (this.paired) deletion.classList.add('markdown-change--paired');
    if (this.annotationId) deletion.dataset.markdownRangeId = this.annotationId;
    const fragment = previewRanges(this.original, view, this.from, this.to, this.block);
    deletion.append(fragment);
    return deletion;
  }
}

class UnchangedBlocks extends WidgetType {
  constructor(readonly count: number, readonly from: number) { super(); }

  eq(other: UnchangedBlocks) { return this.from === other.from && this.count === other.count; }

  toDOM(view: EditorView) {
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'markdown-change__unchanged contextual-action';
    button.textContent = `${this.count} unchanged ${this.count === 1 ? 'block' : 'blocks'}`;
    button.onclick = () => view.dispatch({ effects: expandUnchanged.of(this.from) });
    return button;
  }
}

export function renderedMarkdownSelection(state: EditorState) {
  const preview = markdownPreviewDecorations(state);
  const selection = state.selection.main;
  if (!state.readOnly || !preview || selection.empty) return markdownSelection(state);
  const changes = state.field(renderedChanges).decorations;
  let { from, to } = selection;
  const visibleText = (start: number, end: number) => {
    let position = start;
    for (const span = RangeSet.iter([preview, changes], start); span.value && span.from < end; span.next()) {
      const { widget, markdownPreviewReplacement } = span.value.spec;
      if (!(widget instanceof UnchangedBlocks) && (!markdownPreviewReplacement || widget)) continue;
      if (span.from > position && state.sliceDoc(position, span.from).trim()) return true;
      position = Math.max(position, span.to);
    }
    return position < end && Boolean(state.sliceDoc(position, end).trim());
  };
  // A mouse endpoint at the next block's opening markup selects no visible
  // text in that block. Keep its line separator and syntax out of the edit.
  while (state.doc.lineAt(from).number < state.doc.lineAt(to).number) {
    const line = state.doc.lineAt(to);
    if (visibleText(line.from, to)) break;
    to = state.doc.line(line.number - 1).to;
  }
  while (state.doc.lineAt(from).number < state.doc.lineAt(to).number) {
    const line = state.doc.lineAt(from);
    if (visibleText(from, line.to)) break;
    from = state.doc.line(line.number + 1).from;
  }
  for (const span = changes.iter(from); span.value && span.from < to; span.next()) {
    if (span.to > from && span.value.spec.widget instanceof UnchangedBlocks) {
      return markdownSourceRange(state, { from, to: from });
    }
  }
  return markdownSourceRange(state, { from, to });
}

type Span = { from: number; to: number };
type ChangeState = {
  agent?: Comparison;
  operator?: Comparison;
  positions: readonly number[];
  selected: number;
  expanded: readonly number[];
  toWorking: ChangeSet | null;
};

function unchangedBlocks(
  state: EditorState, chunks: readonly Chunk[], expanded: readonly number[], marks: Range<Decoration>[],
) {
  const blocks: Span[] = [];
  for (let block = syntaxTree(state).topNode.firstChild; block; block = block.nextSibling) {
    if (block.name === 'CommentBlock') continue;
    blocks.push({ from: state.doc.lineAt(block.from).from, to: state.doc.lineAt(block.to).to });
  }
  let index = 0;
  let run = 0;
  const flush = (until: number) => {
    if (until <= run) return;
    const from = blocks[run].from;
    const to = blocks[until - 1].to;
    if (from < to && !expanded.some(position => from <= position && position <= to)) {
      marks.push(Decoration.replace({
        widget: new UnchangedBlocks(until - run, from), block: true, inclusive: false,
      }).range(from, to));
    }
  };
  for (const chunk of chunks) {
    while (blocks[index] && blocks[index].to < chunk.fromB) index++;
    flush(index);
    while (blocks[index] && blocks[index].from < chunk.toB) index++;
    run = index;
  }
  flush(blocks.length);
}

function addChanges(
  doc: Text, comparison: Comparison, layer: Layer, marks: Range<Decoration>[], toWorking: ChangeSet | null,
  annotations: readonly (Span & { id: string })[],
) {
  const lines = new Set<number>();
  const changes = comparison.blockParts ?? comparison.chunks.flatMap(chunk =>
    chunk.changes.map(change => ({
      fromA: chunk.fromA + change.fromA, toA: chunk.fromA + change.toA,
      fromB: chunk.fromB + change.fromB, toB: chunk.fromB + change.toB,
    })));
  for (const change of changes) {
    const { fromA, toA, fromB: start, toB: end } = change;
    const from = toWorking?.mapPos(start, 1) ?? start;
    const to = toWorking?.mapPos(end, -1) ?? end;
    const mark = (from: number, to: number) => {
      if (from < to) marks.push(Decoration.mark({
        class: `markdown-change markdown-change--${layer} markdown-change--insertion`,
      }).range(from, to));
    };
    if (toWorking && start < end) {
      toWorking.iterGaps((before, after, length) => {
        const first = Math.max(before, start), last = Math.min(before + length, end);
        if (first < last) mark(after + first - before, after + last - before);
      });
    } else mark(from, to);
    if (fromA < toA) {
      const line = comparison.original.doc.lineAt(fromA);
      const block = fromA === line.from && (toA > line.to || from === doc.lineAt(from).from && from === to);
      const annotationId = annotations.find(annotation => annotation.from <= Math.max(from, to) && from <= annotation.to)?.id;
      marks.push(Decoration.widget({
        widget: new DeletedText(comparison.original, fromA, toA, layer, block, from < to, annotationId),
        side: block ? -1 : 1, block,
      }).range(from));
    }
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(Math.max(from, to - 1)).number; number++) {
      lines.add(doc.line(number).from);
    }
  }
  for (const position of lines) marks.push(Decoration.line({ class: `markdown-change__line markdown-change__line--${layer}` }).range(position));
}

function collectDecorations(state: EditorState, changes: ChangeState) {
  const marks: Range<Decoration>[] = [];
  const { agent, operator, expanded } = changes;
  if (agent) addChanges(state.doc, agent, 'agent', marks, changes.toWorking, []);
  if (operator) {
    const annotations = (state.facet(comparisonInput)?.operatorAnnotations ?? []).map(item =>
      ({ ...markdownEditorRange(state, item), id: item.id }));
    addChanges(state.doc, operator, 'operator', marks, null, annotations);
  }
  if (state.facet(comparisonInput)?.collapse && agent?.chunks.length && !operator) {
    unchangedBlocks(state, agent.chunks, expanded, marks);
  }
  return Decoration.set(marks, true);
}

function changeState(state: EditorState, previous?: ChangeState, transaction?: Transaction): ChangeState {
  const input = state.facet(comparisonInput);
  const previousInput = transaction?.startState.facet(comparisonInput);
  const operator = compare(state, previous?.operator, input?.operator, previousInput, 'operator', state.doc, transaction?.changes);
  const agent = compare(state, previous?.agent, input?.agent, previousInput, 'agent', operator?.original.doc,
    operator || previous?.operator ? undefined : transaction?.changes);
  const toWorking = operator === previous?.operator ? previous?.toWorking ?? null : operator
    ? ChangeSet.of(operator.chunks.flatMap(chunk => chunk.changes.map(part => ({
      from: chunk.fromA + part.fromA,
      to: chunk.fromA + part.toA,
      insert: state.doc.slice(chunk.fromB + part.fromB, chunk.fromB + part.toB),
    }))), operator.original.doc.length) : null;
  const chunks = agent?.chunks ?? operator?.chunks;
  const positions = chunks === (previous?.agent?.chunks ?? previous?.operator?.chunks) && toWorking === previous?.toWorking
    ? previous?.positions ?? []
    : chunks?.map(chunk => agent && toWorking ? toWorking.mapPos(Math.min(chunk.fromB, toWorking.length))
      : Math.min(chunk.fromB, state.doc.length)) ?? [];
  const requested = transaction?.effects.find(effect => effect.is(setChangePosition))?.value;
  const selected = requested ?? (positions === previous?.positions ? previous?.selected ?? 0 : 0);
  const expand = transaction?.effects.find(effect => effect.is(expandUnchanged))?.value;
  const expanded = input?.agent === previousInput?.agent ? previous?.expanded ?? [] : [];
  const nextExpanded = expand === undefined ? expanded : [...expanded, expand];
  if (previous && agent === previous.agent && operator === previous.operator && selected === previous.selected
      && nextExpanded === previous.expanded) return previous;
  return { agent, operator, positions, selected, expanded: nextExpanded, toWorking };
}

export const renderedChanges = StateField.define({
  create(state) {
    const changes = changeState(state);
    return { changes, decorations: collectDecorations(state, changes) };
  },
  update(previous, transaction) {
    const changes = changeState(transaction.state, previous.changes, transaction);
    return changes === previous.changes && syntaxTree(transaction.startState) === syntaxTree(transaction.state)
      && transaction.startState.facet(comparisonInput)?.collapse === transaction.state.facet(comparisonInput)?.collapse
      && transaction.startState.facet(comparisonInput)?.operatorAnnotations === transaction.state.facet(comparisonInput)?.operatorAnnotations ? previous
      : { changes, decorations: collectDecorations(transaction.state, changes) };
  },
  provide: field => Prec.low(EditorView.decorations.from(field, value => value.decorations)),
});
