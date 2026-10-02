// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — User message bubble

import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';
import { linkifyResourceRefs } from '../../resource-refs';

export type UserBubbleProps = {
  text: string;
  provider?: string;
};

type QuestionReply = { question: string; answer: string };

function codexQuestionReplies(text: string): QuestionReply[] | null {
  const match = text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!Array.isArray(value) || !value.length || !value.every((item) => item && typeof item === 'object'
      && !Array.isArray(item) && typeof item.question === 'string' && item.question.trim()
      && typeof item.answer === 'string' && item.answer.trim())) return null;
    return value as QuestionReply[];
  } catch {
    return null;
  }
}

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

export function UserBubble({ text, provider }: UserBubbleProps): JSX.Element {
  const instruction = getInstructionMessageMeta(text);
  const replies = useMemo(() => provider === 'codex' ? codexQuestionReplies(text) : null, [provider, text]);
  const html = useMemo(() => {
    return linkifyResourceRefs(renderMarkdown(text));
  }, [text]);

  if (replies) {
    return <div className="user-bubble user-bubble--question-replies">
      {replies.map(({ question, answer }, index) => <div className="user-bubble__question-reply" key={index}>
        <div className="user-bubble__question rendered-markdown"
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(question)) }} />
        <div className="user-bubble__text rendered-markdown"
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(answer)) }} />
      </div>)}
    </div>;
  }

  if (instruction) {
    return (
      <details className="instruction-message-block">
        <summary className="instruction-message-block__summary">
          <span className="instruction-message-block__label">{instruction.scope} {instruction.filename}</span>
          <span className="instruction-message-block__path">{instruction.path}</span>
        </summary>
        <div className="instruction-message-block__body user-bubble__text rendered-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      </details>
    );
  }

  return (
    <div className="user-bubble">
      <div
        className="user-bubble__text rendered-markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
