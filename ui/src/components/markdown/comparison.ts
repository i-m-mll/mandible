import { Change } from '@codemirror/merge';
import { diffArrays } from 'diff';

const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const maxWordDiffLength = 64 * 1024;

export function compareMarkdownWords(before: string, after: string): readonly Change[] {
  if (before === after) return [];

  const commonLength = Math.min(before.length, after.length);
  let start = 0;
  for (let index = 0; index < commonLength && before[index] === after[index]; index++) {
    if (/\s/.test(before[index]!)) start = index + 1;
  }
  let tail = 0;
  for (let offset = 1; offset <= commonLength - start; offset++) {
    const char = before[before.length - offset]!;
    if (char !== after[after.length - offset]) break;
    if (/\s/.test(char)) tail = offset;
  }
  const endA = before.length - tail;
  const endB = after.length - tail;
  const coarseChange = [new Change(start, endA, start, endB)];
  if (Math.max(endA, endB) - start > maxWordDiffLength) return coarseChange;

  const runs = diffArrays(
    Array.from(words.segment(before.slice(start, endA)), token => token.segment),
    Array.from(words.segment(after.slice(start, endB)), token => token.segment),
    { timeout: 25, maxEditLength: 2048 },
  );
  if (!runs) return coarseChange;

  const changes: Change[] = [];
  let fromA = start;
  let fromB = start;
  let toA = start;
  let toB = start;
  const flush = () => {
    if (toA !== fromA || toB !== fromB) changes.push(new Change(fromA, toA, fromB, toB));
  };
  for (const run of runs) {
    const width = run.value.reduce((total, word) => total + word.length, 0);
    if (run.added) {
      toB += width;
    } else if (run.removed) {
      toA += width;
    } else {
      flush();
      toA += width;
      toB += width;
      fromA = toA;
      fromB = toB;
    }
  }
  flush();
  return changes;
}
