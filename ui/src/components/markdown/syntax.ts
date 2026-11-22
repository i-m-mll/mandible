import { GFM, type MarkdownConfig } from '@lezer/markdown';
import { mathToken } from '../../lib/markdownMath';

const mathSyntax: MarkdownConfig = {
  defineNodes: ['InlineMath'],
  parseInline: [{
    name: 'InlineMath',
    before: 'Escape',
    parse(context, next, position) {
      if (next !== 36 && next !== 92) return -1;
      if (next === 92 && context.char(position + 1) !== 40 && context.char(position + 1) !== 91) return -1;
      const math = mathToken(context.slice(position, context.end), false);
      return math ? context.addElement(context.elt('InlineMath', position, position + math.raw.length)) : -1;
    },
  }],
};

export const footnoteLabel = /^\[\^([^\s\[\]]+)\]/;

const footnoteSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'FootnoteDefinition', block: true }, 'FootnoteLabel', 'FootnoteReference'],
  parseBlock: [{
    name: 'FootnoteDefinition',
    before: 'SetextHeading',
    parse(context, line) {
      const source = line.text.slice(line.pos);
      const label = footnoteLabel.exec(source)?.[0];
      if (!label || source[label.length] !== ':') return false;
      const from = context.lineStart + line.pos;
      const markerLength = label.length + 1;
      context.addElement(context.elt('FootnoteDefinition', from, context.lineStart + line.text.length, [
        context.elt('FootnoteLabel', from, from + markerLength),
        ...context.parser.parseInline(source.slice(markerLength), from + markerLength),
      ]));
      context.nextLine();
      return true;
    },
  }],
  parseInline: [{
    name: 'FootnoteReference',
    before: 'Link',
    parse(context, next, position) {
      if (next !== 91 || context.char(position + 1) !== 94) return -1;
      const label = footnoteLabel.exec(context.slice(position, context.end))?.[0];
      if (!label || context.char(position + label.length) === 40 || context.char(position + label.length) === 91) return -1;
      return context.addElement(context.elt('FootnoteReference', position, position + label.length));
    },
  }],
};

export const markdownSyntax = [GFM, mathSyntax, footnoteSyntax];
