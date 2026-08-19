import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupFooter } from '../ui/src/components/message-blocks/GroupFooter';
import { TurnGroup } from '../ui/src/components/message-blocks/TurnGroup';
import { UserBubble } from '../ui/src/components/message-blocks/UserBubble';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const messageBlocksCss = readFileSync(path.join(repoRoot, 'ui/src/styles/message-blocks.css'), 'utf8');
const consoleCss = readFileSync(path.join(repoRoot, 'ui/src/styles/console.css'), 'utf8');

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

  it('scopes fine-pointer reveal to owners and keeps keyboard focus visible', () => {
    expect(consoleCss).not.toContain('*:hover > .message-actions');
    expect(consoleCss).toContain('.message-block-wrapper:is(:hover, :focus-within) > .message-actions');
    expect(consoleCss).toContain('.transcript-item:is(:hover, :focus-within) > .message-actions');
    expect(consoleCss).toContain('.turn-group:is(:hover, :focus-within) .group-footer');
    expect(consoleCss).toMatch(/\.group-footer\s*{[^}]*height: 0;[^}]*opacity: 0;[^}]*pointer-events: none;/s);
  });

  it('provides explicit hoverless and coarse-pointer access', () => {
    expect(consoleCss).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*{[^}]*\.message-actions,[^}]*\.group-footer\s*{[^}]*opacity: 1;[^}]*pointer-events: auto;/s);
    expect(consoleCss).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.group-footer\s*{[^}]*height: auto;/);
  });
});
