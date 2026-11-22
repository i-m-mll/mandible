import { EditorSelection, EditorState, Transaction, type ChangeSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { parseSpaceSource, pasteSpaceFrames, writeSpaceBlock } from '../../../../src/spaces/document-source';
import { spaceFrameNavigation, spaceFrameRanges, type MarkdownPreviewPolicy } from '../../components/markdown/preview';
import {
  editMarkdownSource, markdownSourceRange, markdownValue, type MarkdownSourceEdit,
} from '../../components/markdown/source';
import { separator } from './document-model';

export const spaceFramePreview: MarkdownPreviewPolicy = { protectSpaceFrames: true };

function protectShells(transaction: Transaction) {
  if (!transaction.docChanged || (!transaction.isUserEvent('input') && !transaction.isUserEvent('delete'))) return transaction;
  const state = transaction.startState;
  const frames = spaceFrameRanges(state);
  const changes: ChangeSpec[] = [];
  const redirected = new Map<number, number>();
  let corrected = false;
  let removedFrame = false;
  transaction.changes.iterChanges((from, to, _fromB, toB, insert) => {
    let at = from;
    let cursor = from;
    for (const frame of frames) {
      if (frame.to + 1 < from || frame.from - 1 > to) continue;
      if (from !== to && from <= frame.from && to >= frame.to) {
        removedFrame = true;
        continue;
      }
      if (from >= frame.from && from < frame.body.from) at = frame.body.from;
      else if (from > frame.body.to && from <= frame.to) at = frame.body.to;
      const before = state.sliceDoc(Math.max(0, frame.from - 1), frame.from) === '\n' ? frame.from - 1 : frame.from;
      const after = state.sliceDoc(frame.to, Math.min(state.doc.length, frame.to + 1)) === '\n' ? frame.to + 1 : frame.to;
      for (const shell of [{ from: before, to: frame.body.from }, { from: frame.body.to, to: after }]) {
        if (shell.to <= cursor || shell.from >= to) continue;
        if (cursor < shell.from) changes.push({ from: cursor, to: shell.from });
        cursor = shell.to;
        corrected = true;
      }
    }
    if (at !== from) {
      corrected = true;
      if (insert.length) redirected.set(toB, at);
    }
    if (cursor < to) changes.push({ from: cursor, to });
    if (insert.length) changes.push({ from: at, insert });
  });
  const applied = corrected ? state.changes(changes) : transaction.changes;
  const mapped = corrected ? transaction.changes.invertedDesc.composeDesc(applied) : undefined;
  const edited = mapped ? state.update({
    changes: applied,
    selection: EditorSelection.create(transaction.newSelection.ranges.map(range => {
      const at = range.empty ? redirected.get(range.head) : undefined;
      return at === undefined ? range.map(mapped) : EditorSelection.cursor(applied.mapPos(at, 1));
    }), transaction.newSelection.mainIndex),
    annotations: Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? 'input'),
    scrollIntoView: transaction.scrollIntoView,
    filter: false,
  }) : transaction;
  const next = edited.state;
  const patches: MarkdownSourceEdit[] = [];
  for (const { from, to, body } of frames) {
    let removed = false;
    applied.iterChangedRanges((start, end) => { removed ||= start <= from && end >= to; });
    if (removed) continue;
    // A colon line typed into the body can only close the frame at its current fence width.
    const width = /^:+/.exec(state.sliceDoc(from, body.from))?.[0].length;
    if (!width) continue;
    const start = applied.mapPos(body.from, -1), end = applied.mapPos(body.to, 1);
    const text = next.sliceDoc(start, end);
    if (!new RegExp(`^:{${width}}$`, 'm').test(text)) continue;
    let wider = width + 1;
    for (const match of text.matchAll(/:+/g)) wider = Math.max(wider, match[0].length + 1);
    const opening = applied.mapPos(from, -1), closing = applied.mapPos(to, 1);
    patches.push({ ...markdownSourceRange(next, { from: opening, to: opening + width }), text: ':'.repeat(wider) },
      { ...markdownSourceRange(next, { from: closing - width, to: closing }), text: ':'.repeat(wider) });
  }
  const widened = patches.length ? editMarkdownSource(next, patches) : null;
  const prior = widened?.state ?? next;
  const orphans = removedFrame ? orphanEdits(markdownValue(prior)) : [];
  if (!widened && !orphans.length) return edited;
  return [edited, ...(widened ? [sequential(widened)] : []),
    ...(orphans.length ? [sequential(editMarkdownSource(prior, orphans))] : [])];
}

function sequential(transaction: Transaction) {
  return { changes: transaction.changes, effects: transaction.effects, sequential: true as const };
}

function orphanEdits(source: string): MarkdownSourceEdit[] {
  const blocks = parseSpaceSource('', source, 0);
  const ids = new Set(blocks.filter(span => span.addressed).map(span => span.block.id));
  return blocks.flatMap(({ block, addressed, from, to }) => addressed && block.parent_id && !ids.has(block.parent_id)
    ? [{ start: from, end: to, text: writeSpaceBlock({ ...block, parent_id: null }) }] : []);
}

export function spaceFrameEditing(spaceId: string, liveItems: ReadonlySet<string>) {
  return [
    spaceFrameNavigation,
    EditorState.transactionFilter.of(protectShells),
    EditorView.domEventHandlers({
      paste(event, view) {
        if (view.state.readOnly) return false;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        const copy = pasteSpaceFrames(spaceId, text, liveItems);
        if (copy === null) return false;
        const state = view.state;
        const { from, to } = state.selection.main;
        const crossed = spaceFrameRanges(state).filter(frame => frame.from <= to && from <= frame.to);
        const last = crossed.at(-1);
        const fullySelected = crossed.every(frame => from <= frame.from && to >= frame.to);
        const range = last && !fullySelected ? { from: last.to, to: last.to } : { from, to };
        const { start, end } = markdownSourceRange(state, range);
        const source = markdownValue(state);
        const eol = separator(source);
        const leading = start ? eol + eol : '';
        const trailing = end < source.length ? eol + eol : '';
        const insertion = leading + copy + trailing;
        const orphans = orphanEdits(source.slice(0, start) + insertion + source.slice(end));
        const edit = editMarkdownSource(state, [{ start, end, text: insertion }],
          { start: start + leading.length + copy.length, end: start + leading.length + copy.length });
        if (orphans.length) view.dispatch(state.update(edit, sequential(editMarkdownSource(edit.state, orphans)), { filter: false }));
        else view.dispatch(edit);
        event.preventDefault();
        return true;
      },
    }),
  ];
}
