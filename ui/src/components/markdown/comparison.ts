import { Change } from '@codemirror/merge';
import { diffArrays } from 'diff';

const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const tokenizeWords = (text: string) => Array.from(words.segment(text), token => token.segment);

function tokenChanges(before: string[], after: string[], fromA = 0, fromB = 0): Change[] {
  const width = (tokens: string[]) => tokens.reduce((total, token) => total + token.length, 0);
  const matches = new Set(before);
  if (!after.some(token => matches.has(token))) {
    const toA = fromA + width(before);
    const toB = fromB + width(after);
    return toA === fromA && toB === fromB ? [] : [new Change(fromA, toA, fromB, toB)];
  }

  const changes: Change[] = [];
  let toA = fromA;
  let toB = fromB;
  const flush = () => {
    if (toA !== fromA || toB !== fromB) changes.push(new Change(fromA, toA, fromB, toB));
  };
  for (const run of diffArrays(before, after)) {
    const length = width(run.value);
    if (run.added) {
      toB += length;
    } else if (run.removed) {
      toA += length;
    } else {
      flush();
      toA += length;
      toB += length;
      fromA = toA;
      fromB = toB;
    }
  }
  flush();
  return changes;
}

export function compareMarkdownWords(before: string, after: string): readonly Change[] {
  if (before === after) return [];
  return tokenChanges(lines(before), lines(after)).flatMap(change => {
    const { fromA, toA, fromB, toB } = change;
    if (fromA === toA || fromB === toB) return [change];
    return tokenChanges(tokenizeWords(before.slice(fromA, toA)), tokenizeWords(after.slice(fromB, toB)), fromA, fromB);
  });
}
