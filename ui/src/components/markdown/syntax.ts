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

export const markdownSyntax = [GFM, mathSyntax];
