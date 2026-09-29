// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Unified markdown text renderer

import { renderMarkdown } from '../../lib/markdown';
import { linkifyResourceRefs } from '../../resource-refs';

export type TextBlockProps = {
  content: string;
};

export function TextBlock({ content }: TextBlockProps): JSX.Element {
  return (
    <div className="msg-text-block rendered-markdown">
      {/* eslint-disable-next-line react/no-danger */}
      <div className="msg-text-block__prose" dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(content)) }} />
    </div>
  );
}
