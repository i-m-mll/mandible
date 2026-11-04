import { NativeDisclosureIcon } from '../icons/NativeDisclosureIcon';
// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — User message bubble

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DisclosureFooter } from '../shared/DisclosureFooter';
import { registerReadingLayoutReadiness } from '../shared/readingLayoutReadiness';
import { flushSync } from 'preact/compat';
import { renderMarkdown } from '../../lib/markdown';
import { linkifyResourceRefs } from '../../resource-refs';
import { codexUserMessageParts } from './codexUserMessage';

export type UserBubbleProps = {
  text: string;
  provider?: string;
  getDisclosureExpanded?: (key: string) => boolean | undefined;
  onDisclosureExpandedChange?: (key: string, expanded: boolean, trigger?: HTMLElement) => void;
};

const previewRem = 18;

function BoundedUserBubble({ children, className = '', getDisclosureExpanded, onDisclosureExpandedChange }: Omit<UserBubbleProps, 'text' | 'provider'> & { children: ComponentChildren; className?: string }): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const expanded = getDisclosureExpanded?.('message') ?? localExpanded;
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflow(element.getBoundingClientRect().height > previewRem * parseFloat(getComputedStyle(document.documentElement).fontSize) + 0.5);
    measure();
    const dispose = registerReadingLayoutReadiness(element, () => flushSync(measure));
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => { observer.disconnect(); dispose(); };
  }, [children]);
  return <div className={`user-bubble user-bubble--bounded${className ? ` ${className}` : ''}`} data-reading-disclosure>
    <div className={`user-bubble__viewport${overflow && !expanded ? ' user-bubble__viewport--folded' : ''}`} style={{ maxHeight: expanded ? undefined : `${previewRem}rem`, overflow: expanded ? undefined : 'hidden' }}>
      <div ref={content} className="user-bubble__content">{children}</div>
    </div>
    {overflow && <DisclosureFooter expanded={expanded} onExpandedChange={(next,trigger) => {
      if (!getDisclosureExpanded) setLocalExpanded(next);
      onDisclosureExpandedChange?.('message', next, trigger);
    }}/>}
  </div>;
}

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

export function userMessageVisibleText(text: string, provider?: string): string {
  const instruction = getInstructionMessageMeta(text);
  if (instruction) return `${instruction.scope} ${instruction.filename} ${instruction.path}`;
  const replies = provider === 'codex' ? codexQuestionReplies(text) : null;
  if (replies) return replies.map(({ question, answer }) => `${question}\n${answer}`).join('\n');
  const parts = provider === 'codex' ? codexUserMessageParts(text) : null;
  return parts ? parts.map((part) => part.kind === 'text' ? part.text
    : ['Browser comments', ...part.comments.map(({ number, comment }) => `User Comment ${number}\n${comment}\nBrowser evidence`)].join('\n')).join('\n') : text;
}

export function UserBubble({ text, provider, getDisclosureExpanded, onDisclosureExpandedChange }: UserBubbleProps): JSX.Element {
  const [localInstructionsExpanded, setLocalInstructionsExpanded] = useState(false);
  const requestDisclosure = (key: string, event: MouseEvent) => {
    if (!getDisclosureExpanded && key !== 'instructions') return;
    event.preventDefault();
    const trigger = event.currentTarget as HTMLElement;
    const next = !(trigger.parentElement as HTMLDetailsElement).open;
    if (!getDisclosureExpanded && key === 'instructions') setLocalInstructionsExpanded(next);
    onDisclosureExpandedChange?.(key, next, trigger);
  };
  const instruction = getInstructionMessageMeta(text);
  const instructionsExpanded = getDisclosureExpanded?.('instructions') ?? localInstructionsExpanded;
  const replies = useMemo(() => provider === 'codex' ? codexQuestionReplies(text) : null, [provider, text]);
  const parts = useMemo(() => provider === 'codex' && !replies ? codexUserMessageParts(text) : null, [provider, replies, text]);
  const html = useMemo(() => {
    return instruction && !instructionsExpanded ? '' : linkifyResourceRefs(renderMarkdown(text));
  }, [text, Boolean(instruction), instructionsExpanded]);
  const bounded = (children: ComponentChildren, className = '') => <BoundedUserBubble className={className} getDisclosureExpanded={getDisclosureExpanded} onDisclosureExpandedChange={onDisclosureExpandedChange}>{children}</BoundedUserBubble>;

  if (replies) {
    return bounded(<>
      {replies.map(({ question, answer }, index) => <div className="user-bubble__question-reply" key={index}>
        <div className="user-bubble__question rendered-markdown"
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(question)) }} />
        <div className="user-bubble__text rendered-markdown"
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(answer)) }} />
      </div>)}
    </>, 'user-bubble--question-replies');
  }

  if (parts) {
    return bounded(<>
      {parts.map((part, index) => part.kind === 'text' ? (
        <div key={index} className="user-bubble__text rendered-markdown"
          dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(part.text)) }} />
      ) : (
        <div key={index} className="user-bubble__text user-bubble__comments" aria-label="Browser comments">
          <div className="user-bubble__comments-label">Browser comments</div>
          {part.comments.map(({ number, comment, evidence }) => <section className="user-bubble__comment" key={number}>
            <div className="user-bubble__comment-label">User Comment {number}</div>
            <div className="user-bubble__comment-text rendered-markdown"
              dangerouslySetInnerHTML={{ __html: linkifyResourceRefs(renderMarkdown(comment)) }} />
            <details className="user-bubble__comment-evidence" open={getDisclosureExpanded?.(`evidence:${number}`)} onToggle={event => { if (!getDisclosureExpanded) onDisclosureExpandedChange?.(`evidence:${number}`, event.currentTarget.open); }}>
              <summary onClick={event => requestDisclosure(`evidence:${number}`, event)}>Browser evidence</summary>
              <pre>{evidence}</pre>
            </details>
          </section>)}
        </div>
      ))}
    </>, 'user-bubble--browser-comments');
  }

  if (instruction) {
    return (
      <details className="instruction-message-block" open={instructionsExpanded}>
        <summary className="instruction-message-block__summary" onClick={event => requestDisclosure('instructions', event)}>
          <NativeDisclosureIcon />
          <span className="instruction-message-block__label">{instruction.scope} {instruction.filename}</span>
          <span className="instruction-message-block__path">{instruction.path}</span>
        </summary>
        {instructionsExpanded && <div className="instruction-message-block__body user-bubble__text rendered-markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      </details>
    );
  }

  return bounded(
      <div
        className="user-bubble__text rendered-markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
  );
}
