import { EditorView } from '@codemirror/view';
import { vi } from 'vitest';

export function stubBriefingEditorBounds() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('CSS', { supports: () => false });
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockImplementation(position => ({
    left: position * 5, right: position * 5 + 5, top: 100, bottom: 120,
  }));
}

export function selectBriefingEditorText(element: HTMLElement, quote: string) {
  const editor = EditorView.findFromDOM(element.closest<HTMLElement>('.cm-editor')!);
  if (!editor) throw new Error('Briefing editor is unavailable');
  const from = editor.state.doc.toString().indexOf(quote);
  if (from < 0) throw new Error('Briefing text is unavailable');
  editor.dispatch({ selection: { anchor: from, head: from + quote.length } });
  return editor;
}
