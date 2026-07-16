// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — User message bubble

import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';

export type UserBubbleProps = {
  text: string;
};

export function UserBubble({ text }: UserBubbleProps): JSX.Element {
  const html = useMemo(() => {
    return renderMarkdown(text);
  }, [text]);

  return (
    <div className="user-bubble">
      <div
        className="user-bubble__text"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
