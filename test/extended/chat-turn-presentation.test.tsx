import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupFooter } from '../../ui/src/components/message-blocks/GroupFooter';
import { TurnGroup } from '../../ui/src/components/message-blocks/TurnGroup';
import { UserBubble } from '../../ui/src/components/message-blocks/UserBubble';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const messageBlocksCss = readFileSync(path.join(repoRoot, 'ui/src/styles/message-blocks.css'), 'utf8');
const consoleCss = readFileSync(path.join(repoRoot, 'ui/src/styles/console.css'), 'utf8');
const contextualActionCss = readFileSync(path.join(repoRoot, 'ui/src/styles/contextual-action.css'), 'utf8');

afterEach(cleanup);

describe('chat turn presentation', () => {
  it('renders turns without speaker badges or footer separators', () => {
    const { container } = render(
      <TurnGroup
        speaker="user"
        footer={<GroupFooter onCopyAll={vi.fn()} onOpenMarkdown={vi.fn()} onSelect={vi.fn()} />}
      >
        <UserBubble text="Hello" />
      </TurnGroup>,
    );

    expect(container.querySelector('.turn-group__speaker')).toBeNull();
    expect(container.querySelector('.turn-group__badge')).toBeNull();
    expect(container.querySelector('.group-footer__separator')).toBeNull();
    expect(container.querySelector('hr')).toBeNull();

    const copyAll = container.querySelector<HTMLButtonElement>('[aria-label="Copy all messages"]');
    copyAll?.focus();
    expect(document.activeElement).toBe(copyAll);
  });

  it('declares the exact user surfaces and shared turn alignment', () => {
    expect(messageBlocksCss).toMatch(/\.turn-group--user \.turn-group__body\s*{[^}]*align-items: flex-end;[^}]*width: 66\.6667%;/s);
    expect(messageBlocksCss).toMatch(/\.user-bubble__text\s*{[^}]*background: #222222;[^}]*border: none;/s);
    expect(messageBlocksCss).toMatch(/:root\[data-theme='light'\] \.user-bubble__text\s*{[^}]*background: #F3F3F4;/s);
  });

  it('gives tool and reasoning siblings one symmetric compact parent-owned gap', () => {
    expect(messageBlocksCss).toMatch(/\.turn-group__body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--space-2\);/s);
    expect(messageBlocksCss).toMatch(/:is\(\.turn-group__body, \.message-group__content\)[\s\S]*?> \.chat-boundary--ends-activity[\s\S]*?\+ \.chat-boundary--starts-activity\s*\{[^}]*margin-block-start:\s*calc\(var\(--space-2\) \* -0\.333333\);/s);
    const turnNodeRule = consoleCss.match(/\.stream-turn-node\s*\{[^}]*\}/s)?.[0];
    expect(turnNodeRule).toBeTruthy();
    expect(turnNodeRule).not.toMatch(/margin(?:-bottom)?:/);
    expect(consoleCss).not.toMatch(/\.stream-turn-node:last-child/);
  });

  it('scopes pointer reveal to owner hover without retaining pointer focus', () => {
    expect(consoleCss).not.toContain('*:hover > .message-actions');
    expect(contextualActionCss).toContain('.contextual-action-owner:hover > .contextual-action-group');
    expect(contextualActionCss).toContain('.contextual-action-owner:hover > .contextual-action-scope > .contextual-action-group');
    expect(contextualActionCss).not.toContain('.contextual-action-owner:is(:hover, :focus-within)');
    expect(contextualActionCss).not.toContain('.contextual-action-group:focus-within');
    expect(contextualActionCss).toContain('.contextual-action-group:has(.contextual-action:focus-visible)');
    expect(consoleCss).not.toContain('.message-block-wrapper:is(:hover, :focus-within)');
    expect(consoleCss).toContain('.message-block-wrapper:hover > .message-actions');
    expect(consoleCss).toContain('.message-block-wrapper:has(.message-actions .contextual-action:focus-visible) > .message-actions');
    expect(consoleCss).toMatch(/\.group-footer\s*{[^}]*height: 24px;/s);
  });

  it('removes the final segmented prose margin before a tool row', () => {
    expect(messageBlocksCss).toMatch(/\.provider-directive__prose > :last-child\s*\{[^}]*margin-block-end: 0;/s);
  });

  it('provides explicit hoverless and coarse-pointer access', () => {
    expect(contextualActionCss).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*{[^}]*\.contextual-action-group\s*{[^}]*opacity: 1;[^}]*pointer-events: auto;/s);
    expect(consoleCss).toMatch(/\.group-footer\s*{[^}]*height: 24px;/s);
  });
});
