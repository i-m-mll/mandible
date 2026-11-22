import { invertedEffects } from '@codemirror/commands';
import {
  Annotation, EditorSelection, MapMode, StateEffect, StateField, Transaction, type ChangeSet, type EditorState, type Text,
} from '@codemirror/state';

const lineEndings = /\r\n|\r|\n/g;

export type MarkdownSourceRange = { start: number; end: number };
export type MarkdownSourceEdit = MarkdownSourceRange & { text: string };
export type MarkdownSelection = MarkdownSourceRange & { quote: string };

class SourceText {
  readonly normalized: string;
  readonly #extra: number[];
  readonly #separator: string;

  constructor(readonly value: string) {
    const extra: number[] = [];
    let separator: string | undefined;
    this.normalized = value.replace(lineEndings, (ending: string, offset: number) => {
      separator ??= ending;
      if (ending.length === 2) extra.push(offset - extra.length + 1);
      return '\n';
    });
    this.#extra = extra;
    this.#separator = separator ?? '\n';
  }

  #offset(position: number, original: boolean): number {
    let low = 0;
    let high = this.#extra.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const boundary = this.#extra[middle] + (original ? middle : 0);
      if (boundary <= position) low = middle + 1;
      else high = middle;
    }
    return original ? position - low : position + low;
  }

  sourcePosition(position: number): number {
    return this.#offset(position, false);
  }

  editorPosition(position: number): number {
    return this.#offset(position, true);
  }

  apply(changes: ChangeSet, endings: ReadonlyMap<number, string>): SourceText {
    const parts: string[] = [];
    let previous = 0;
    changes.iterChanges((from, to, fromB, _toB, inserted) => {
      const start = this.sourcePosition(from);
      parts.push(this.value.slice(previous, start));
      parts.push(inserted.toString().replace(/\n/g, (_newline, offset: number) => endings.get(fromB + offset) ?? this.#separator));
      previous = this.sourcePosition(to);
    });
    return new SourceText(parts.join('') + this.value.slice(previous));
  }
}

const setSource = StateEffect.define<SourceText>();
type LineEnding = { position: number; text: string };

const restoreEndings = StateEffect.define<readonly LineEnding[]>({
  map: (endings, changes) => endings.flatMap(({ position, text }) => {
    const mapped = changes.mapPos(position, 1, MapMode.TrackAfter);
    return mapped === null ? [] : [{ position: mapped, text }];
  }),
});
export const externalSourceUpdate = Annotation.define<boolean>();

const sourceField = StateField.define<SourceText>({
  create: (state) => new SourceText(state.doc.toString()),
  update(source, transaction) {
    const incoming = transaction.effects.find((effect) => effect.is(setSource));
    if (incoming) return incoming.value;
    if (!transaction.docChanged) return source;
    const endings = new Map<number, string>();
    for (const effect of transaction.effects) {
      if (effect.is(restoreEndings)) for (const { position, text } of effect.value) endings.set(position, text);
    }
    return source.apply(transaction.changes, endings);
  },
});

export function exactMarkdownSource(value: string) {
  return [
    sourceField.init(() => new SourceText(value)),
    invertedEffects.of((transaction) => {
      if (!transaction.docChanged) return [];
      const source = transaction.startState.field(sourceField);
      const endings: LineEnding[] = [];
      transaction.changes.iterChanges((from, to) => {
        const start = source.sourcePosition(from);
        const removed = source.value.slice(start, source.sourcePosition(to));
        for (const match of removed.matchAll(lineEndings)) {
          endings.push({ position: source.editorPosition(start + match.index), text: match[0] });
        }
      });
      return endings.length ? [restoreEndings.of(endings)] : [];
    }),
  ];
}

export function markdownValue(state: EditorState): string {
  return state.field(sourceField).value;
}

export function markdownSelection(state: EditorState): MarkdownSelection {
  return markdownSourceRange(state, state.selection.main);
}

export function markdownSourceRange(state: EditorState, { from, to }: { from: number; to: number }): MarkdownSelection {
  const source = state.field(sourceField);
  const start = source.sourcePosition(from);
  const end = source.sourcePosition(to);
  return { start, end, quote: source.value.slice(start, end) };
}

export function markdownEditorRange(state: EditorState, range: MarkdownSourceRange) {
  const source = state.field(sourceField);
  const clamp = (position: number) => Math.min(Math.max(0, position), source.value.length);
  return {
    from: source.editorPosition(clamp(range.start)),
    to: source.editorPosition(clamp(range.end)),
  };
}

export function editMarkdownSource(state: EditorState, edits: readonly MarkdownSourceEdit[], selection?: MarkdownSourceRange) {
  const endings: LineEnding[] = [];
  let shift = 0;
  const changes = [...edits].sort((left, right) => left.start - right.start).map(edit => {
    const { from, to } = markdownEditorRange(state, edit);
    const insert = edit.text.replace(lineEndings, (text, position: number) => {
      endings.push({ text, position: from + shift + position });
      shift -= text.length - 1;
      return '\n';
    });
    // Replacement offsets are measured in the new normalized buffer.
    shift += edit.text.length - (to - from);
    return { from, to, insert };
  });
  const changeSet = state.changes(changes);
  const source = state.field(sourceField).apply(changeSet, new Map(endings.map(({ position, text }) => [position, text])));
  return state.update({
    changes: changeSet,
    effects: setSource.of(source),
    ...(selection && { selection: EditorSelection.range(source.editorPosition(selection.start), source.editorPosition(selection.end)),
      scrollIntoView: true }),
    annotations: Transaction.userEvent.of('input'),
  });
}

export function replaceMarkdownSource(state: EditorState, value: string) {
  const source = new SourceText(value);
  return {
    changes: textReplacement(state.doc, source.normalized),
    effects: setSource.of(source),
    annotations: [externalSourceUpdate.of(true), Transaction.addToHistory.of(false)],
  };
}

export function textReplacement(document: Text, replacement: string) {
  const previous = document.toString();
  let from = 0;
  const prefixLimit = Math.min(previous.length, replacement.length);
  while (from < prefixLimit && previous[from] === replacement[from]) from++;
  let to = previous.length;
  let end = replacement.length;
  while (to > from && end > from && previous[to - 1] === replacement[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: replacement.slice(from, end) };
}
