import { useState } from 'preact/hooks';
import { DisclosureChevronIcon } from '../shared/DisclosureChevronIcon';

export type ProviderDirective = {
  kind: 'memory-citation';
  label: string;
  citations: Array<{ ref: string; note: string | null }>;
  rolloutIds: string[];
};

export type ProviderTextSegment =
  | { kind: 'text'; content: string }
  | { kind: 'directive'; directive: ProviderDirective };

type DirectiveMatch = { start: number; end: number; directive: ProviderDirective };

function parseMemoryCitation(source: string): DirectiveMatch[] {
  const pattern = /<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>/gi;
  const matches: DirectiveMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const citations = match[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = /^(.*?)\|note=\[(.*)]$/.exec(line);
      return { ref: parts?.[1]?.trim() || line, note: parts?.[2]?.trim() || null };
    });
    const rolloutIds = match[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    matches.push({
      start: match.index,
      end: pattern.lastIndex,
      directive: { kind: 'memory-citation', label: 'Used memory', citations, rolloutIds },
    });
  }
  return matches;
}

const PROVIDER_DIRECTIVE_PARSERS = [parseMemoryCitation];

export function splitProviderDirectives(source: string): ProviderTextSegment[] {
  const matches = PROVIDER_DIRECTIVE_PARSERS
    .flatMap((parse) => parse(source))
    .sort((left, right) => left.start - right.start);
  if (matches.length === 0) return [{ kind: 'text', content: source }];

  const segments: ProviderTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    const prose = source.slice(cursor, match.start).trimEnd();
    if (prose) segments.push({ kind: 'text', content: prose });
    segments.push({ kind: 'directive', directive: match.directive });
    cursor = match.end;
  }
  const tail = source.slice(cursor).trimStart();
  if (tail) segments.push({ kind: 'text', content: tail });
  return segments;
}

function BrainIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.2 3.1A2.2 2.2 0 0 0 2.7 4.9c0 .4.1.8.3 1.1a2.3 2.3 0 0 0 .7 4.4 2.2 2.2 0 0 0 2.5 2.4M9.8 3.1a2.2 2.2 0 0 1 3.5 1.8c0 .4-.1.8-.3 1.1a2.3 2.3 0 0 1-.7 4.4 2.2 2.2 0 0 1-2.5 2.4M8 2.4v11.2M5.2 6.1c.8.1 1.4.5 1.7 1.2M10.8 6.1c-.8.1-1.4.5-1.7 1.2M5.1 10.1c.8 0 1.4-.3 1.8-.9M10.9 10.1c-.8 0-1.4-.3-1.8-.9" />
    </svg>
  );
}

export function ProviderDirectiveBlock({ directive }: { directive: ProviderDirective }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`provider-directive${expanded ? ' provider-directive--expanded' : ''}`}>
      <button type="button" className="provider-directive__summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="provider-directive__icon"><BrainIcon /></span>
        <span>{directive.label}</span>
        <span className="provider-directive__chevron"><DisclosureChevronIcon expanded={expanded} /></span>
      </button>
      {expanded ? (
        <div className="provider-directive__body">
          {directive.citations.length > 0 ? (
            <ul>
              {directive.citations.map((citation) => (
                <li key={`${citation.ref}:${citation.note}`}><code>{citation.ref}</code>{citation.note ? ` — ${citation.note}` : ''}</li>
              ))}
            </ul>
          ) : null}
          {directive.rolloutIds.length > 0 ? (
            <div className="provider-directive__task-refs">Tasks: {directive.rolloutIds.map((id) => <code key={id}>{id}</code>)}</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
