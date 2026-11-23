import { Change } from '@codemirror/merge';
import { diffArrays } from 'diff';
import { markdownParser } from './syntax';

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

type MarkdownBlock = {
  kind: string;
  text: string;
  from: number;
  to: number;
  terms: Map<string, number>;
  count: number;
};

function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let from = 0;
  let node = markdownParser.parse(source).topNode.firstChild;
  while (from < source.length) {
    const next = node?.nextSibling;
    const to = next?.from ?? source.length;
    const text = source.slice(from, to);
    const terms = new Map<string, number>();
    let count = 0;
    for (const token of words.segment(text)) {
      if (!token.isWordLike) continue;
      const term = token.segment.toLowerCase();
      terms.set(term, (terms.get(term) ?? 0) + 1);
      count++;
    }
    blocks.push({ kind: node?.name ?? 'Whitespace', text, from, to, terms, count });
    from = to;
    node = next ?? null;
  }
  return blocks;
}

function comparableBlocks(before: MarkdownBlock, after: MarkdownBlock) {
  if (before.text === after.text) return true;
  if (before.kind !== after.kind || before.count === 0 || after.count === 0) return false;
  const needed = Math.ceil(Math.max(before.count, after.count) / 2);
  if (Math.min(before.count, after.count) < needed) return false;
  let shared = 0;
  for (const [term, count] of before.terms) {
    shared += Math.min(count, after.terms.get(term) ?? 0);
    if (shared >= needed) return true;
  }
  return false;
}

export function compareRenderedMarkdown(before: string, after: string): readonly Change[] {
  if (before === after) return [];
  const oldBlocks = markdownBlocks(before);
  const newBlocks = markdownBlocks(after);
  const changes: Change[] = [];
  let oldIndex = 0, newIndex = 0;
  let oldStart = 0, newStart = 0;

  const flushReplacedBlocks = () => {
    while (oldStart < oldIndex || newStart < newIndex) {
      const oldBlock = oldBlocks[oldStart];
      const newBlock = newBlocks[newStart];
      const fromA = oldBlock?.from ?? before.length;
      const fromB = newBlock?.from ?? after.length;
      const toA = oldStart < oldIndex ? oldBlock.to : fromA;
      const toB = newStart < newIndex ? newBlock.to : fromB;
      changes.push(new Change(fromA, toA, fromB, toB));
      if (oldStart < oldIndex) oldStart++;
      if (newStart < newIndex) newStart++;
    }
  };

  for (const run of diffArrays(oldBlocks, newBlocks, { comparator: comparableBlocks })) {
    if (run.removed) oldIndex += run.value.length;
    else if (run.added) newIndex += run.value.length;
    else {
      flushReplacedBlocks();
      for (let count = 0; count < run.value.length; count++) {
        const oldBlock = oldBlocks[oldIndex++];
        const newBlock = newBlocks[newIndex++];
        for (const change of compareMarkdownWords(oldBlock.text, newBlock.text)) {
          changes.push(new Change(change.fromA + oldBlock.from, change.toA + oldBlock.from,
            change.fromB + newBlock.from, change.toB + newBlock.from));
        }
      }
      oldStart = oldIndex;
      newStart = newIndex;
    }
  }
  flushReplacedBlocks();
  return changes;
}
