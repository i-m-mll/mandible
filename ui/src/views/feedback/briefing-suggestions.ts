import type { BriefingAnnotation, BriefingAnnotationOperation } from '../../api';
import { compareMarkdownWords } from '../../components/markdown/comparison';
import type { MarkdownSourceRange } from '../../components/MarkdownDocument';

type Replacement = Extract<BriefingAnnotationOperation, { annotation_kind: 'suggest_replacement' }>;
type Segment = Pick<Replacement, 'start_offset' | 'end_offset' | 'quote' | 'replacement_text'>;

export function briefingSuggestionText(source: string, annotations: readonly BriefingAnnotation[]) {
  let cursor = 0;
  const parts: string[] = [];
  for (const annotation of [...annotations].sort((a, b) => a.start_offset - b.start_offset)) {
    const { start_offset: start, end_offset: end, quote, replacement_text: replacement } = annotation;
    if (annotation.annotation_kind !== 'suggest_replacement' || replacement === null
        || start < cursor || source.slice(start, end) !== quote) continue;
    parts.push(source.slice(cursor, start), replacement);
    cursor = end;
  }
  return parts.join('') + source.slice(cursor);
}

const graphemes = new Intl.Segmenter();

export function briefingSuggestionSegments(source: string, working: string): Segment[] {
  const anchors = graphemes.segment(source);
  const segments: { start: number; end: number; newStart: number; newEnd: number }[] = [];
  for (const change of compareMarkdownWords(source, working)) {
    let { fromA: start, toA: end, fromB: newStart, toB: newEnd } = change;
    while (start < end && newStart < newEnd && source[start] === working[newStart]) {
      start++;
      newStart++;
    }
    while (end > start && newEnd > newStart && source[end - 1] === working[newEnd - 1]) {
      end--;
      newEnd--;
    }
    const startGrapheme = anchors.containing(start);
    if (startGrapheme && startGrapheme.index < start) {
      newStart -= start - startGrapheme.index;
      start = startGrapheme.index;
    }
    const endGrapheme = anchors.containing(end);
    if (endGrapheme && endGrapheme.index < end) {
      const length = endGrapheme.index + endGrapheme.segment.length - end;
      end += length;
      newEnd += length;
    }
    if (start === end) {
      // Replacement events require a nonempty anchor. A retained grapheme encodes a pure insertion.
      if (startGrapheme) {
        end += startGrapheme.segment.length;
        newEnd += startGrapheme.segment.length;
      } else {
        const last = anchors.containing(start - 1);
        if (!last) continue;
        start = last.index;
        newStart -= last.segment.length;
      }
    }
    const previous = segments.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.newEnd = Math.max(previous.newEnd, newEnd);
    } else {
      segments.push({ start, end, newStart, newEnd });
    }
  }
  return segments.map(({ start, end, newStart, newEnd }) => ({
    start_offset: start, end_offset: end, quote: source.slice(start, end), replacement_text: working.slice(newStart, newEnd),
  }));
}

export function briefingSuggestionOperations(
  source: string, working: string, existing: readonly BriefingAnnotation[],
): BriefingAnnotationOperation[] {
  if (briefingSuggestionText(source, existing) === working) return [];
  const segments = briefingSuggestionSegments(source, working);
  const matching = new Set<string>();
  const replacements: Replacement[] = [];
  for (const segment of segments) {
    const saved = existing.find(annotation => annotation.start_offset === segment.start_offset
      && annotation.end_offset === segment.end_offset && annotation.replacement_text === segment.replacement_text);
    if (saved) matching.add(saved.annotation_event_id);
    else replacements.push({ operation: 'set', annotation_kind: 'suggest_replacement', ...segment });
  }
  return [...existing.filter(annotation => !matching.has(annotation.annotation_event_id))
    .map(annotation => ({ operation: 'retract' as const, annotation_event_id: annotation.annotation_event_id })), ...replacements];
}

export function suggestionRangeMap(before: string, after: string) {
  const changes = compareMarkdownWords(before, after);
  return (range: MarkdownSourceRange): MarkdownSourceRange | null => {
    let delta = 0;
    for (const change of changes) {
      if (range.end <= change.fromA) break;
      if (range.start < change.toA) return null;
      delta = change.toB - change.toA;
    }
    return { start: range.start + delta, end: range.end + delta };
  };
}
