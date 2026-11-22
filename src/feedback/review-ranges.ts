import { diffLines, diffWordsWithSpace } from "diff";
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
    const parts = diffWordsWithSpace(before.slice(a, oldOffset), after.slice(b, newOffset), { timeout });
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

function mappedRange(before: string, after: string, spans: readonly MatchingSpan[], start: number, end: number) {
  let first = -1;
  let last = -1;
  let retainedText = false;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (span.before >= end) break;
    if (span.before + span.length <= start) continue;
    if (first === -1) first = index;
    last = index;
    retainedText ||= /[\p{L}\p{N}\p{S}]/u.test(before.slice(Math.max(start, span.before), Math.min(end, span.before + span.length)));
  }
  if (first === -1) return null;
  const leading = spans[first];
  const trailing = spans[last];
  const leadingEdge = leading.before;
  const trailingEdge = trailing.before + trailing.length;
  if (start >= leadingEdge && end <= trailingEdge && first === last) {
    return { start: leading.after + start - leadingEdge, end: leading.after + end - leadingEdge };
  }
  // Whitespace and punctuation alone do not establish continuity across an edit.
  if (!retainedText) return null;
  const previous = spans[first - 1];
  const next = spans[last + 1];
  const previousEnd = previous ? previous.before + previous.length : 0;
  const mappedStart = start < leadingEdge && start === previousEnd
    ? (previous ? previous.after + previous.length : 0)
    : leading.after + Math.max(0, start - leadingEdge);
  const mappedEnd = end > trailingEdge && end === (next?.before ?? before.length)
    ? (next?.after ?? after.length)
    : trailing.after + trailing.length + Math.min(0, end - trailingEdge);
  return { start: mappedStart, end: mappedEnd };
}

function findUniqueReviewQuote(source: string, quote: string, kind: ReviewRangeKind): ReviewRange | null {
  if (!quote) return null;
  const start = source.indexOf(quote);
  if (start < 0 || source.indexOf(quote, start + 1) !== -1) return null;
  const range = reviewRangeFromSelection(source, start, start + quote.length, kind);
  return range?.quote === quote ? range : null;
}

export function carryReviewRanges(before: string, after: string): (anchor: ReviewRange) => CarriedReviewRange {
  return carryReviewRangeKind(before, after, "text");
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
  return carryReviewRangeKind(before, after, "lines");
}

/** Artifacts and briefings share offsets in decoded text with the UTF-8 BOM omitted. */
export const artifactReviewSource = (source: string): string => source.replace(/^\uFEFF/, "");

export function carryReviewRangeKind(before: string, after: string, kind: ReviewRangeKind) {
  const spans = before === after ? [] : matchingSpans(before, after);
  return (range: ReviewRange): CarriedReviewRange => {
    const original = reviewSelectionFromRange(before, range, kind);
    if (!original) return { status: "detached" };
    if (before === after) return { ...range, status: "preserved" };
    const mapped = mappedRange(before, after, spans, original.start, original.end);
    const current = mapped && reviewRangeFromSelection(after, mapped.start, mapped.end, kind);
    if (current) return { ...current, status: current.start_offset === range.start_offset ? "preserved" : "moved" };
    const relocated = findUniqueReviewQuote(after, range.quote, kind);
    return relocated ? { ...relocated, status: "moved" } : { status: "detached" };
  };
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
      const range = findUniqueReviewQuote(next, note.quote, note.range_kind);
      return { ...note, anchor: range ? { ...range, status: "moved" as const } : note.anchor };
    }
    let carry = maps.get(note.range_kind);
    if (!carry) {
      carry = carryReviewRangeKind(old, next, note.range_kind);
      maps.set(note.range_kind, carry);
    }
    return { ...note, anchor: carry(note.anchor) };
  });
}
