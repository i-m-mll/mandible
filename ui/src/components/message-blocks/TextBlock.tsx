// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Unified markdown text renderer

import { useMemo } from 'preact/hooks';
import { marked } from 'marked';
import { sanitizeHtml } from '../../sanitize';

// Configure marked to be synchronous
marked.setOptions({ async: false });

export type TextBlockProps = {
  content: string;
};

export function TextBlock({ content }: TextBlockProps): JSX.Element {
  const html = useMemo(() => {
    try {
      const result = marked.parse(content);
      if (typeof result === 'string') {
        return sanitizeHtml(result);
      }
      return content;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className="msg-text-block"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
