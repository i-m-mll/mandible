import { expect, it } from "vitest";
import { carryReviewRangeKind } from "../src/feedback/review-ranges.js";
import type { CarriedReviewRange, ReviewRange, ReviewRangeKind } from "../src/feedback/review-types.js";

const range = (quote: string, start_offset: number, end_offset = start_offset + quote.length): ReviewRange =>
  ({ quote, start_offset, end_offset });
const placed = (status: "preserved" | "moved", quote: string, start: number, end?: number): CarriedReviewRange =>
  ({ status, ...range(quote, start, end) });
const detached = { status: "detached" } as const;

it.each<{
  name: string; before: string; after: string; range: ReviewRange; want: CarriedReviewRange; kind?: ReviewRangeKind;
}>([
  { name: "retains the second duplicate after an unrelated edit", before: "same\n\nsame\n\nend\n",
    after: "same\n\nsame\n\nnew ending\n", range: range("same", 6), want: placed("preserved", "same", 6) },
  { name: "moves a UTF-16 range after prefixed text", before: "A😀\r\n\r\nSecond block",
    after: "Moved A😀\r\n\r\nSecond block", range: range("😀\r\n\r\nSecond", 1),
    want: placed("moved", "😀\r\n\r\nSecond", 7) },
  { name: "includes a longer replacement inside the quote", before: "Keep the red marker.",
    after: "Keep the blue marker.", range: range("the red marker", 5), want: placed("preserved", "the blue marker", 5) },
  { name: "includes a replacement at a quoted edge", before: "Use the red marker.",
    after: "Use the blue marker.", range: range("red marker", 8), want: placed("preserved", "blue marker", 8) },
  { name: "detaches deleted words despite surviving formatting", before: "Keep\nRemove this.\nStay\n",
    after: "Keep\nStay\n", range: range("Remove this.", 5), want: detached },
  { name: "relocates a unique quote after its original extent is deleted", before: "First\nSecond\nMove this.\nThird\n",
    after: "Move this.\nFirst\nSecond\nThird\n", range: range("Move this.", 13), want: placed("moved", "Move this.", 0) },
  { name: "detaches an ambiguous quote after its original extent is deleted", before: "First\nSecond\nMove this.\nThird\nFourth\n",
    after: "Move this.\nMove this.\nFirst\nSecond\nThird\nFourth\n", range: range("Move this.", 13), want: detached },
  { name: "carries an edited CRLF logical line", before: "Header\r\nKeep the red marker.\r\nFooter",
    after: "Header\r\nKeep the blue marker.\r\nFooter", kind: "lines",
    range: range("Keep the red marker.\r\n", 1, 2), want: placed("preserved", "Keep the blue marker.\r\n", 1, 2) },
])("$name", ({ before, after, range, want, kind = "text" }) => {
  expect(carryReviewRangeKind(before, after, kind)(range)).toEqual(want);
});
