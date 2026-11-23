import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Chunk } from '@codemirror/merge';
import { EditorState, Facet, Prec, StateEffect, StateField, type ChangeDesc, type Range, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { compareMarkdownWords } from './comparison';
import { markdownPreview, markdownPreviewPolicy, previewRanges, type MarkdownPreviewPolicy } from './preview';
import { markdownSyntax } from './syntax';
import { exactMarkdownSource } from './source';

type Layer = 'agent' | 'operator';
type ComparisonInput = {
  agent?: string;
  operator?: string;
  collapse: boolean;
  source: boolean;
  policy?: MarkdownPreviewPolicy;
};
type Comparison = { original: EditorState; chunks: readonly Chunk[] };

export const comparisonInput = Facet.define<ComparisonInput, ComparisonInput | undefined>({
  combine: ([input]) => input,
});

export const setChangePosition = StateEffect.define<number>();
export const expandUnchanged = StateEffect.define<number>();
const diffConfig = { override: compareMarkdownWords };

function compare(
  state: EditorState, previous: Comparison | undefined, before: string | undefined,
  previousInput: ComparisonInput | undefined, beforeKey: Layer, changes?: ChangeDesc,
): Comparison | undefined {
  if (before === undefined) return;
  if (previous && before === previousInput?.[beforeKey]
      && state.facet(comparisonInput)?.source === previousInput?.source
      && state.facet(comparisonInput)?.policy === previousInput?.policy) {
    return !changes || changes.empty ? previous : {
      original: previous.original,
      chunks: Chunk.updateB(previous.chunks, previous.original.doc, state.doc, changes, diffConfig),
    };
  }
  const input = state.facet(comparisonInput);
  const original = EditorState.create({
    doc: before,
    extensions: [
      exactMarkdownSource(before), EditorState.readOnly.of(true),
      ...(input?.source ? [] : [markdown({ extensions: markdownSyntax, completeHTMLTags: false }), markdownPreview]),
      ...(input?.policy ? [markdownPreviewPolicy.of(input.policy)] : []),
    ],
  });
  if (!input?.source) ensureSyntaxTree(original, original.doc.length);
  return { original, chunks: Chunk.build(original.doc, state.doc, diffConfig) };
}

class DeletedText extends WidgetType {
  constructor(
    readonly original: EditorState, readonly from: number, readonly to: number, readonly layer: Layer,
    readonly block: boolean,
  ) { super(); }

  eq(other: DeletedText) {
    return this.original === other.original && this.from === other.from
      && this.to === other.to && this.layer === other.layer && this.block === other.block;
  }

  toDOM(view: EditorView) {
    const owner = view.dom.ownerDocument;
    const deletion = owner.createElement(this.block ? 'div' : 'span');
    deletion.className = `markdown-change markdown-change--${this.layer} markdown-change--deletion`;
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

type Span = { from: number; to: number };
type ChangeState = {
  agent?: Comparison;
  operator?: Comparison;
  positions: readonly number[];
  selected: number;
  expanded: readonly number[];
};

function unchangedBlocks(
  state: EditorState, chunks: readonly Chunk[], expanded: readonly number[], marks: Range<Decoration>[],
) {
  const blocks: Span[] = [];
  for (let block = syntaxTree(state).topNode.firstChild; block; block = block.nextSibling) {
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
  doc: Text, comparison: Comparison, layer: Layer, marks: Range<Decoration>[], suppressed: readonly Chunk[] = [],
) {
  for (const chunk of comparison.chunks) {
    const lines = new Set<number>();
    for (const change of chunk.changes) {
      const from = chunk.fromB + change.fromB;
      const to = chunk.fromB + change.toB;
      if (suppressed.some(operator => operator.fromB <= to && from < operator.toB
          && operator.changes.some(part => operator.fromB + part.fromB <= to && operator.fromB + part.toB >= from))) continue;
      const fromA = chunk.fromA + change.fromA;
      const toA = chunk.fromA + change.toA;
      if (from < to) marks.push(Decoration.mark({
        class: `markdown-change markdown-change--${layer} markdown-change--insertion`,
      }).range(from, to));
      if (fromA < toA) {
        const line = comparison.original.doc.lineAt(fromA);
        const block = fromA === line.from && (toA > line.to || from === doc.lineAt(from).from && from === to);
        marks.push(Decoration.widget({
          widget: new DeletedText(comparison.original, fromA, toA, layer, block),
          side: -1, block,
        }).range(from));
      }
      for (let number = doc.lineAt(from).number; number <= doc.lineAt(Math.max(from, to - 1)).number; number++) {
        lines.add(doc.line(number).from);
      }
    }
    for (const position of lines) marks.push(Decoration.line({ class: `markdown-change__line markdown-change__line--${layer}` }).range(position));
  }
}

function collectDecorations(state: EditorState, changes: ChangeState) {
  const marks: Range<Decoration>[] = [];
  const { agent, operator, expanded } = changes;
  if (agent) addChanges(state.doc, agent, 'agent', marks, operator?.chunks);
  if (operator) addChanges(state.doc, operator, 'operator', marks);
  if (state.facet(comparisonInput)?.collapse && agent?.chunks.length && !operator) {
    unchangedBlocks(state, agent.chunks, expanded, marks);
  }
  return Decoration.set(marks, true);
}

function changeState(state: EditorState, previous?: ChangeState, transaction?: Transaction): ChangeState {
  const input = state.facet(comparisonInput);
  const previousInput = transaction?.startState.facet(comparisonInput);
  const agent = compare(state, previous?.agent, input?.agent, previousInput, 'agent', transaction?.changes);
  const operator = compare(state, previous?.operator, input?.operator, previousInput, 'operator', transaction?.changes);
  const chunks = agent?.chunks ?? operator?.chunks;
  const positions = chunks === (previous?.agent?.chunks ?? previous?.operator?.chunks) ? previous?.positions ?? []
    : chunks?.map(chunk => Math.min(chunk.fromB, state.doc.length)) ?? [];
  const requested = transaction?.effects.find(effect => effect.is(setChangePosition))?.value;
  const selected = requested ?? (positions === previous?.positions ? previous?.selected ?? 0 : 0);
  const expand = transaction?.effects.find(effect => effect.is(expandUnchanged))?.value;
  const expanded = input?.agent === previousInput?.agent ? previous?.expanded ?? [] : [];
  const nextExpanded = expand === undefined ? expanded : [...expanded, expand];
  if (previous && agent === previous.agent && operator === previous.operator && selected === previous.selected
      && nextExpanded === previous.expanded) return previous;
  return { agent, operator, positions, selected, expanded: nextExpanded };
}

export const renderedChanges = StateField.define({
  create(state) {
    const changes = changeState(state);
    return { changes, decorations: collectDecorations(state, changes) };
  },
  update(previous, transaction) {
    const changes = changeState(transaction.state, previous.changes, transaction);
    return changes === previous.changes && syntaxTree(transaction.startState) === syntaxTree(transaction.state)
      && transaction.startState.facet(comparisonInput)?.collapse === transaction.state.facet(comparisonInput)?.collapse ? previous
      : { changes, decorations: collectDecorations(transaction.state, changes) };
  },
  provide: field => Prec.low(EditorView.decorations.from(field, value => value.decorations)),
});
