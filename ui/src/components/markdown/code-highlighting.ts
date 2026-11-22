import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { highlightCode } from '../../lib/codeHighlight';

function codeHighlighting(state: EditorState) {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name !== 'FencedCode') return;
      const fence = ref.node;
      const info = fence.getChild('CodeInfo');
      const language = info && /^[\w+#-]+/.exec(state.sliceDoc(info.from, info.to))?.[0];
      if (!language) return false;
      const blocks = fence.getChildren('CodeText').map(node => ({
        from: node.from, text: state.sliceDoc(node.from, node.to),
      }));
      const html = highlightCode(blocks.map(block => block.text).join(''), language.toLowerCase());
      if (!html) return false;

      const open: { from: number; className: string }[] = [];
      let position = 0;
      const spans = [];
      for (const token of html.matchAll(/<span class="([^"]+)">|<\/span>|&(?:amp|lt|gt|quot|#x27);|[^<&]+/g)) {
        if (token[1]) open.push({ from: position, className: token[1] });
        else if (token[0] === '</span>') {
          const span = open.pop();
          if (span && span.from < position) spans.push({ ...span, to: position });
        } else position += token[0][0] === '&' ? 1 : token[0].length;
      }

      let offset = 0;
      for (const block of blocks) {
        for (const span of spans) {
          const from = Math.max(offset, span.from);
          const to = Math.min(offset + block.text.length, span.to);
          if (from < to) decorations.push(Decoration.mark({ class: span.className })
            .range(block.from + from - offset, block.from + to - offset));
        }
        offset += block.text.length;
      }
      return false;
    },
  });
  return Decoration.set(decorations, true);
}

export const markdownCodeHighlighting = StateField.define({
  create: codeHighlighting,
  update: (current, { docChanged, startState, state }) =>
    docChanged || syntaxTree(startState) !== syntaxTree(state) ? codeHighlighting(state) : current,
  provide: field => EditorView.decorations.from(field),
});
