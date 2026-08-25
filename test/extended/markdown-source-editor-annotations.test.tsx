// CodeMirror geometry is not meaningful in jsdom. These tests cover the pure
// range/click contracts and observable state/effect reconfiguration instead.

import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { EditorView } from '@codemirror/view';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MarkdownSourceEditor,
  markdownSourceDecorationIdFromTarget,
  normalizeMarkdownSourceDecorations,
  type MarkdownSourceDecoration,
} from '../../ui/src/views/spaces/MarkdownSourceEditor';

afterEach(() => {
  cleanup();
});

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('MarkdownSourceEditor external decorations', () => {
  it('clamps, sorts, and drops ranges that CodeMirror cannot decorate', () => {
    expect(
      normalizeMarkdownSourceDecorations(6, [
        { id: 'tail', start: 4, end: 99, className: 'tail' },
        { id: 'empty', start: 3, end: 3, className: 'empty' },
        { id: 'reversed', start: 5, end: 2, className: 'reversed' },
        { id: 'fractional', start: 1.5, end: 3, className: 'fractional' },
        { id: 'head', start: -4, end: 2, className: 'head' },
      ]),
    ).toEqual([
      { id: 'head', start: 0, end: 2, className: 'head' },
      { id: 'tail', start: 4, end: 6, className: 'tail' },
    ]);
  });

  it('resolves an annotation id from the clicked decoration or its child', () => {
    const decoration = document.createElement('span');
    decoration.dataset.annotationId = 'annotation-1';
    const child = document.createElement('strong');
    decoration.appendChild(child);

    expect(markdownSourceDecorationIdFromTarget(child)).toBe('annotation-1');
    expect(markdownSourceDecorationIdFromTarget(document.createTextNode('plain'))).toBeNull();
    expect(markdownSourceDecorationIdFromTarget(null)).toBeNull();
  });

  it('reconfigures read-only state, decorations, and the click callback after mount', async () => {
    let view: EditorView | null = null;
    const firstClick = vi.fn();
    const secondClick = vi.fn();
    const renderEditor = (
      readOnly: boolean,
      decorations: ReadonlyArray<MarkdownSourceDecoration>,
      onDecorationClick: (id: string) => void,
    ) => (
      <MarkdownSourceEditor
        blockId="document"
        value="alpha beta gamma"
        ariaLabel="Review Markdown"
        readOnly={readOnly}
        decorations={decorations}
        onDecorationClick={onDecorationClick}
        onView={(_blockId, nextView) => {
          view = nextView;
        }}
        onChange={() => undefined}
        onBlur={() => undefined}
        onCaretChange={() => undefined}
        onSelectionChange={() => undefined}
        onItemCommand={() => undefined}
        onOpenReference={() => undefined}
      />
    );

    const rendered = render(renderEditor(false, [], firstClick));
    await flushEffects();
    expect(view?.state.readOnly).toBe(false);
    expect(rendered.container.querySelector('[data-annotation-id]')).toBeNull();

    rendered.rerender(
      renderEditor(
        true,
        [{ id: 'annotation-2', start: 6, end: 10, className: 'ask-annotation' }],
        secondClick,
      ),
    );
    await flushEffects();

    expect(view?.state.readOnly).toBe(true);
    expect(view?.contentDOM.getAttribute('contenteditable')).toBe('false');
    const decoration = rendered.container.querySelector<HTMLElement>(
      '[data-annotation-id="annotation-2"]',
    );
    expect(decoration?.classList.contains('ask-annotation')).toBe(true);
    fireEvent.click(decoration!);
    expect(firstClick).not.toHaveBeenCalled();
    expect(secondClick).toHaveBeenCalledWith('annotation-2');

    rendered.rerender(renderEditor(true, [], secondClick));
    await flushEffects();
    expect(rendered.container.querySelector('[data-annotation-id]')).toBeNull();
  });
});
