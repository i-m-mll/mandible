import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { expect, it } from 'vitest';
import { DocumentDraftControl, type DocumentRevision, type DocumentSave } from '../ui/src/components/markdown/draft';
import {
  editMarkdownSource, exactMarkdownSource, markdownEditorRange, markdownSelection, markdownValue,
} from '../ui/src/components/markdown/source';
import { moveSection, spaceBlocks } from '../ui/src/views/spaces/document-model';
import { writeSpaceBlock } from '../src/spaces/document-source';

it('moves a complete addressed subtree in one undoable change and quotes across former block boundaries', () => {
  const frame = (id: string, markdown: string, parent_id: string | null, block_type: 'heading' | 'paragraph') =>
    writeSpaceBlock({ id, space_id: 'space', parent_id, block_type, markdown, sort_key: '', item_id: null,
      item_snapshot: null, metadata: { opaque: 'é' }, created_at: 1, updated_at: 1 });
  const a = frame('a', '# Header 😀', null, 'heading');
  const child = frame('child', 'child\rfirst\r\nsecond', 'a', 'paragraph');
  const b = frame('b', '# Destination', null, 'heading');
  const source = a + '\r\n\r\n' + child + '\n\n' + b;
  const [aBlock, childBlock, bBlock] = spaceBlocks('space', source);
  const range = { start: aBlock.body.end - 2, end: childBlock.body.end };
  let state = EditorState.create({ doc: source, extensions: [exactMarkdownSource(source), history()] });
  const selection = markdownEditorRange(state, range);
  state = state.update({ selection: EditorSelection.range(selection.from, selection.to) }).state;
  expect(markdownSelection(state).quote).toBe(source.slice(range.start, range.end));
  state = editMarkdownSource(state, moveSection(source, [aBlock, childBlock, bBlock], aBlock, bBlock, true)).state;
  expect(new TextEncoder().encode(markdownValue(state))).toEqual(new TextEncoder().encode(b + '\n\n' + a + '\r\n\r\n' + child));
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  expect(markdownValue(state)).toBe(source);
});

it('retains later typing across an early refetch, delayed acknowledgement and a competing saved generation', async () => {
  const original = { source: 'saved', generation: 1 };
  const control = new DocumentDraftControl(original);
  control.source = 'first keystroke';
  const reply = Promise.withResolvers<DocumentSave>();
  const write = control.save(() => reply.promise);
  control.source = 'second keystroke';
  const committed = { source: 'first keystroke', generation: 2 };
  control.observe(committed);
  control.observe(original);
  reply.resolve({ kind: 'saved', document: committed });
  expect(await write).toEqual(committed);

  const competing = { source: 'another tab', generation: 3 };
  const stale = await control.save(draft => {
    expect(draft).toEqual({ base: committed, source: 'second keystroke' });
    return Promise.resolve({ kind: 'conflict', document: competing });
  });
  expect(stale).toBeNull();
  const reopened = new DocumentDraftControl(competing, { base: control.base, source: control.source });
  expect(reopened.conflict).toBe(true);
  expect(reopened.source).toBe('second keystroke');
  let attempted: DocumentRevision | undefined;
  expect(await reopened.save(draft => { attempted = draft.base; throw new Error('unexpected write'); })).toBeNull();
  expect(attempted).toBeUndefined();
});
