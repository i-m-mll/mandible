// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — User message bubble

import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';

export type UserBubbleProps = {
  text: string;
};

export type InstructionMessageMeta = {
  filename: 'AGENTS.md' | 'CLAUDE.md';
  scope: 'Project' | 'Global';
  path: string;
};

export function getInstructionMessageMeta(content: string): InstructionMessageMeta | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const match = firstLine.match(/^#?\s*(AGENTS\.md|CLAUDE\.md) instructions for (.+)$/i);
  if (!match) return null;
  const filename = match[1].toUpperCase().startsWith('AGENTS') ? 'AGENTS.md' : 'CLAUDE.md';
  const path = match[2].trim();
  const scope = /\/(\.claude|\.dotfiles)(\/|$)|^~\/\.claude\//.test(path) ? 'Global' : 'Project';
  return { filename, scope, path };
}

export function UserBubble({ text }: UserBubbleProps): JSX.Element {
  const instruction = getInstructionMessageMeta(text);
  const html = useMemo(() => {
    return renderMarkdown(text);
  }, [text]);

  if (instruction) {
    return (
      <details className="instruction-message-block">
        <summary className="instruction-message-block__summary">
          <span className="instruction-message-block__label">{instruction.scope} {instruction.filename}</span>
          <span className="instruction-message-block__path">{instruction.path}</span>
        </summary>
        <div className="instruction-message-block__body user-bubble__text" dangerouslySetInnerHTML={{ __html: html }} />
      </details>
    );
  }

  return (
    <div className="user-bubble">
      <div
        className="user-bubble__text"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
