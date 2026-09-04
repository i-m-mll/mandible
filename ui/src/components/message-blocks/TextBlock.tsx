// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Unified markdown text renderer

import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';
import { linkifyResourceRefs } from '../../resource-refs';
import { ProviderDirectiveBlock, splitProviderDirectives } from './ProviderDirectiveBlock';

export type TextBlockProps = {
  content: string;
};

export function TextBlock({ content }: TextBlockProps): JSX.Element {
  const segments = useMemo(() => splitProviderDirectives(content), [content]);

  return (
    <div className="msg-text-block rendered-markdown">
      {segments.map((segment, index) => segment.kind === 'directive' ? (
        <ProviderDirectiveBlock key={`directive-${index}`} directive={segment.directive} />
      ) : (
        <div
          key={`text-${index}`}
          className="provider-directive__prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(segment.content)) }}
        />
      ))}
    </div>
  );
}
