import { diffChars, diffLines } from "diff";
import type { CarriedReviewRange, ReviewRange } from "./review-types.js";

type MatchingSpan = { before: number; after: number; length: number };

/** Align intact lines before comparing changed lines, so punctuation cannot pull a line into a nearby edit. */
function matchingSpans(before: string, after: string): MatchingSpan[] {
  const spans: MatchingSpan[] = [];
  const deadline = performance.now() + 100;
  const lines = diffLines(before, after, { timeout: 100 });
  if (!lines) return spans;
  let oldOffset = 0;
  let newOffset = 0;
  let changed: { before: number; after: number } | null = null;
  const match = (before: number, after: number, length: number) => {
    const previous = spans.at(-1);
    if (previous && previous.before + previous.length === before && previous.after + previous.length === after) {
      previous.length += length;
    } else if (length > 0) spans.push({ before, after, length });
  };
  const refineChange = () => {
    if (!changed) return;
    let { before: a, after: b } = changed;
    changed = null;
    const timeout = deadline - performance.now();
    if (a === oldOffset || b === newOffset || timeout <= 0) return;
    const parts = diffChars(before.slice(a, oldOffset), after.slice(b, newOffset), { timeout });
    for (const part of parts ?? []) {
      const length = part.value.length;
      if (!part.added && !part.removed) match(a, b, length);
      if (!part.added) a += length;
      if (!part.removed) b += length;
    }
  };
  for (const part of lines) {
    const length = part.value.length;
    if (!part.added && !part.removed) {
      refineChange();
      match(oldOffset, newOffset, length);
    } else changed ??= { before: oldOffset, after: newOffset };
    if (!part.added) oldOffset += length;
    if (!part.removed) newOffset += length;
  }
  refineChange();
  return spans;
}

/** Build one map per pair of texts. Only a unique, exact quote can reattach an anchor. */
export function carryReviewRanges(before: string, after: string): (anchor: ReviewRange) => CarriedReviewRange {
  const spans = matchingSpans(before, after);
  return ({ start_offset, end_offset, quote }) => {
    if (before.slice(start_offset, end_offset) !== quote) return { status: "detached" };
    const start = after.indexOf(quote);
    if (start === -1 || after.indexOf(quote, start + 1) !== -1) return { status: "detached" };
    const preserved = spans.some((span) => start_offset >= span.before && end_offset <= span.before + span.length
      && start_offset - span.before === start - span.after);
    return { status: preserved ? "preserved" : "moved", start_offset: start, end_offset: start + quote.length, quote };
  };
}
