import { syntaxTree } from '@codemirror/language';
import { Prec, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export function tableDecorations(state: EditorState, tree = syntaxTree(state)) {
  const decorations: Range<Decoration>[] = [];
  const selection = state.selection.main;
  const caret = !state.readOnly && selection.empty ? selection.head : -1;
  const hide = (from: number, to: number) => {
    if (from < to) decorations.push(Decoration.replace({ markdownPreviewReplacement: true,}).range(from, to));
  };
  tree.iterate({
    enter(ref) {
      if (ref.name !== 'Table') return;
      const table = ref.node;
      const delimiter = table.getChild('TableDelimiter');
      if (!delimiter) return false;
      const alignments = state.sliceDoc(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, '')
        .split('|').map(marker => {
          const syntax = marker.trim();
          return syntax.endsWith(':') ? (syntax.startsWith(':') ? 'center' : 'end') : 'start';
        });
      const columns = alignments.length;
      const delimiterLine = state.doc.lineAt(delimiter.from);
      if (caret < delimiter.from || caret > delimiter.to) {
        decorations.push(Decoration.line({ class: 'markdown-document__table-divider' }).range(delimiterLine.from));
        hide(delimiterLine.from, delimiter.to);
      }
      for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const line = state.doc.lineAt(row.from);
        const pipes = row.getChildren('TableDelimiter');
        const cells = row.getChildren('TableCell');
        if (line.from < caret && caret <= row.to && !cells.some(cell => cell.from <= caret && caret <= cell.to)) continue;
        decorations.push(Decoration.line({
          class: `markdown-document__table-row${row.name === 'TableHeader' ? ' markdown-document__table-header' : ''}`,
          attributes: { style: `--markdown-table-columns: ${columns}` },
        }).range(line.from));
        const firstPipe = pipes[0];
        const leading = firstPipe && !state.sliceDoc(row.from, firstPipe.from).trim() ? 1 : 0;
        let position = line.from;
        let pipe = 0;
        for (const cell of cells) {
          while (pipes[pipe] && pipes[pipe].from < cell.from) pipe++;
          const column = pipe - leading;
          hide(position, cell.from);
          if (column < columns) {
            decorations.push(Decoration.mark({
              inclusive: true,
              class: column > 0 ? 'markdown-document__table-cell markdown-document__table-cell--divided'
                : 'markdown-document__table-cell',
              attributes: { style: `grid-column: ${column + 1}; text-align: ${alignments[column]}` },
            }).range(cell.from, cell.to));
          } else hide(cell.from, cell.to);
          position = cell.to;
        }
        hide(position, row.to);
      }
      return false;
    },
  });
  return Decoration.set(decorations, true);
}

export const markdownTables = StateField.define({
  create: tableDecorations,
  update: (current, { docChanged, startState, state }) =>
    docChanged || syntaxTree(startState) !== syntaxTree(state) || state.readOnly !== startState.readOnly
      || (!state.readOnly && !state.selection.eq(startState.selection)) ? tableDecorations(state) : current,
  provide: field => Prec.lowest(EditorView.decorations.from(field)),
});
