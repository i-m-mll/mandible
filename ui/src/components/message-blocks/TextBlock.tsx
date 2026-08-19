// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Unified markdown text renderer

import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';

export type TextBlockProps = {
  content: string;
};

export function TextBlock({ content }: TextBlockProps): JSX.Element {
  const html = useMemo(() => {
    return renderMarkdown(content);
  }, [content]);

  return (
    <div
      className="msg-text-block rendered-markdown"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
