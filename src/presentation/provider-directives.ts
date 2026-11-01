import { marked } from 'marked';

export type ProviderDirective =
  | {
      kind: 'memory-citation';
      citations: Array<{ ref: string; note: string | null }>;
      rolloutIds: string[];
    }
  | {
      kind: 'created-thread';
      identity: 'threadId' | 'clientThreadId';
      providerSessionId: string;
    };

export type ProviderTextSegment =
  | { kind: 'text'; content: string }
  | { kind: 'activity'; directive: ProviderDirective };

type DirectiveMatch = { start: number; end: number; directive: ProviderDirective };
type SourceRange = { start: number; end: number };

function markdownProtectedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let offset = 0;
  for (const token of marked.lexer(source)) {
    const end = offset + token.raw.length;
    if (token.type === 'code' || token.type === 'blockquote' || token.type === 'list') {
      ranges.push({ start: offset, end });
    }
    offset = end;
  }
  return ranges;
}

function isMarkdownProtected(rangeStart: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => range.start <= rangeStart && rangeStart < range.end);
}

function parseMemoryCitation(source: string, codeRanges: readonly SourceRange[]): DirectiveMatch[] {
  const pattern = /^[\t ]*<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>[\t ]*\r?$/gim;
  const matches: DirectiveMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (isMarkdownProtected(match.index, codeRanges)) continue;
    const citations = match[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = /^(.*?)\|note=\[(.*)]$/.exec(line);
      return { ref: parts?.[1]?.trim() || line, note: parts?.[2]?.trim() || null };
    });
    const rolloutIds = match[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    matches.push({
      start: match.index,
      end: pattern.lastIndex,
      directive: { kind: 'memory-citation', citations, rolloutIds },
    });
  }
  return matches;
}

function parseCreatedThread(source: string, codeRanges: readonly SourceRange[]): DirectiveMatch[] {
  const pattern = /^[\t ]*::created-thread\{([^}\r\n]*)\}[\t ]*\r?$/gm;
  const matches: DirectiveMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (isMarkdownProtected(match.index, codeRanges)) continue;
    const attributes = Array.from(match[1].matchAll(/(?:^|\s)(threadId|clientThreadId)=(?:"([^"\s]+)"|'([^'\s]+)'|([^\s}]+))/g));
    if (attributes.length !== 1) continue;
    const attribute = attributes[0];
    const providerSessionId = attribute[2] ?? attribute[3] ?? attribute[4];
    if (!providerSessionId) continue;
    matches.push({
      start: match.index,
      end: pattern.lastIndex,
      directive: {
        kind: 'created-thread',
        identity: attribute[1] as 'threadId' | 'clientThreadId',
        providerSessionId,
      },
    });
  }
  return matches;
}

/** Split display directives from prose without changing the prose bytes or directive identities. */
export function splitProviderDirectives(source: string): ProviderTextSegment[] {
  if (!/<oai-mem-citation>|::created-thread\{/i.test(source)) return [{ kind: 'text', content: source }];
  const protectedRanges = markdownProtectedRanges(source);
  const matches = [parseMemoryCitation(source, protectedRanges), parseCreatedThread(source, protectedRanges)]
    .flat()
    .sort((left, right) => left.start - right.start);
  if (matches.length === 0) return [{ kind: 'text', content: source }];

  const segments: ProviderTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) segments.push({ kind: 'text', content: source.slice(cursor, match.start) });
    segments.push({ kind: 'activity', directive: match.directive });
    cursor = match.end;
  }
  if (cursor < source.length) segments.push({ kind: 'text', content: source.slice(cursor) });
  return segments;
}
