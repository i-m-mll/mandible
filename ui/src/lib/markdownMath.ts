export type MathToken = { type: string; raw: string; text: string; display: boolean };
const delimiters = [
  { open: '\\[', close: '\\]', display: true },
  { open: '$$', close: '$$', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

export function escaped(source: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && source[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

export function mathToken(source: string, block: boolean): MathToken | undefined {
  for (const { open, close, display } of delimiters) {
    if ((block && !display) || !source.startsWith(open)) continue;
    if (open === '$' && (source[1] === '$' || /\s/.test(source[1] ?? '') || /^\$\d[\d,.]*[.,;:!?](?=\s|$)/.test(source))) continue;
    let end = open.length;
    while ((end = source.indexOf(close, end)) !== -1) {
      if (escaped(source, end)) { end += close.length; continue; }
      const text = source.slice(open.length, end);
      if (open === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? '') || text.includes('\n'))) return;
      if (!text.trim()) return;
      return { type: block ? 'blockMath' : 'inlineMath', raw: source.slice(0, end + close.length), text, display };
    }
  }
}
