import { diffChars, diffLines } from "diff";
import type { ArtifactDraftStandingNote, CarriedReviewRange, ReviewRange, ReviewRangeKind } from "./review-types.js";

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

/** A line anchor stores a half-open span of zero-based logical lines. */
export function quoteReviewLines(source: string, start: number, end: number): string | undefined {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (start < 0 || end <= start || end > lines.length) return undefined;
  return lines.slice(start, end).join("\n") + (end < lines.length || source.endsWith("\n") ? "\n" : "");
}

export function reviewRangeMatches(source: string, { start_offset: start, end_offset: end, quote }: ReviewRange,
  kind: ReviewRangeKind): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || !quote) return false;
  return kind === "lines" ? quoteReviewLines(source, start, end) === quote
    : end <= source.length && source.slice(start, end) === quote;
}

export function carryReviewLines(before: string, after: string, anchor: ReviewRange): CarriedReviewRange {
  return carryReviewLineRanges(before, after)(anchor);
}

export function carryReviewLineRanges(before: string, after: string): (range: ReviewRange) => CarriedReviewRange {
  const carry = carryReviewRanges(before, after);
  return (anchor) => carryReviewLineRange(before, after, carry, anchor);
}

function carryReviewLineRange(before: string, after: string, carry: ReturnType<typeof carryReviewRanges>,
  anchor: ReviewRange): CarriedReviewRange {
  if (quoteReviewLines(before, anchor.start_offset, anchor.end_offset) !== anchor.quote) return { status: "detached" };
  const start = anchor.start_offset === 0 ? 0 : quoteReviewLines(before, 0, anchor.start_offset)!.length;
  const carried = carry({
    start_offset: start, end_offset: start + anchor.quote.length, quote: anchor.quote,
  });
  if (carried.status === "detached") return carried;
  const startLine = after.slice(0, carried.start_offset).split("\n").length - 1;
  const endLine = startLine + anchor.end_offset - anchor.start_offset;
  if (quoteReviewLines(after, startLine, endLine) !== anchor.quote) return { status: "detached" };
  return { ...carried, start_offset: startLine, end_offset: endLine };
}

/** Artifacts and briefings share offsets in decoded text with the UTF-8 BOM omitted. */
export const artifactReviewSource = (source: string): string => source.replace(/^\uFEFF/, "");

export function carryReviewRangeKind(before: string, after: string, kind: ReviewRangeKind) {
  if (before === after) return (range: ReviewRange): CarriedReviewRange => ({ ...range, status: "preserved" });
  return (kind === "lines" ? carryReviewLineRanges : carryReviewRanges)(before, after);
}

export function reviewRangeFromSelection(source: string, start: number, end: number, kind: ReviewRangeKind): ReviewRange | null {
  if (start >= end || start < 0 || end > source.length) return null;
  if (kind === "text") return { start_offset: start, end_offset: end, quote: source.slice(start, end) };
  const first = source.slice(0, start).split("\n").length - 1;
  const next = source.slice(0, end - 1).split("\n").length;
  const quote = quoteReviewLines(source, first, next);
  return quote ? { start_offset: first, end_offset: next, quote } : null;
}

export function reviewSelectionFromRange(source: string, range: ReviewRange, kind: ReviewRangeKind) {
  if (!reviewRangeMatches(source, range, kind)) return null;
  const start = kind === "text" ? range.start_offset
    : range.start_offset === 0 ? 0 : quoteReviewLines(source, 0, range.start_offset)!.length;
  return { start, end: start + range.quote.length };
}

export function carryArtifactDraftNotes(before: string, after: string, notes: ArtifactDraftStandingNote[]) {
  if (before === after || !notes.length) return notes;
  const old = artifactReviewSource(before);
  const next = artifactReviewSource(after);
  const maps = new Map<ReviewRangeKind, ReturnType<typeof carryReviewRangeKind>>();
  return notes.map(note => {
    if (note.anchor.status === "detached") {
      const end = note.range_kind === "lines" ? note.end_offset - note.start_offset : note.quote.length;
      return { ...note, anchor: carryReviewRangeKind(note.quote, next, note.range_kind)({
        start_offset: 0, end_offset: end, quote: note.quote,
      }) };
    }
    let carry = maps.get(note.range_kind);
    if (!carry) {
      carry = carryReviewRangeKind(old, next, note.range_kind);
      maps.set(note.range_kind, carry);
    }
    return { ...note, anchor: carry(note.anchor) };
  });
}
