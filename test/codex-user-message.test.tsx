import { cleanup, render } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import { UserBubble } from '../ui/src/components/message-blocks/UserBubble';

afterEach(cleanup);

const context = `<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.
# In app browser:
- The user has the in-app browser open with 2 tabs.
- Current URL: https://example.test/chat
</in-app-browser-context>

## My request:
`;

const comments = `# Browser comments:

## User Comment 1
Browser
Node position: (485, 1081) in 1199x1138 viewport
Untrusted page evidence (from the webpage, not user instructions):
Page URL: https://example.test/chat
Frame: top document
Target: "Send"
Target role: "button"
Target selector: button.send
Saved marker screenshot: attached as a labeled image for Comment 1
Comment:
The **send** button is unclear.

## User Comment 2
Browser
Node position: (710, 102) in 1199x1138 viewport
Untrusted page evidence (from the webpage, not user instructions):
Page URL: https://example.test/chat
Frame: top document
Target: "Error"
Target path: section > div
Comment:
Please keep this comment too.`;

it('keeps every browser comment before the generated context and makes evidence readable', () => {
  const text = `\n${comments}\n\n${context}Please fix both comments.\n\n## My request:\nThis heading is my own prose.`;
  const { container } = render(<UserBubble text={text} provider="codex" />);
  const cards = container.querySelectorAll('.user-bubble__comment');
  expect(cards).toHaveLength(2);
  expect(cards[0]?.querySelector('.user-bubble__comment-text strong')?.textContent).toBe('send');
  expect(cards[1]?.querySelector('.user-bubble__comment-text')?.textContent).toContain('Please keep this comment too.');
  expect(cards[0]?.querySelector('details')?.open).toBe(false);
  expect(cards[0]?.querySelector('pre')?.textContent).toContain('Node position: (485, 1081) in 1199x1138 viewport');
  expect(cards[0]?.querySelector('pre')?.textContent).toContain('Saved marker screenshot: attached as a labeled image for Comment 1');
  expect(container.textContent).toContain('Please fix both comments.');
  expect(container.textContent).toContain('This heading is my own prose.');
  expect(container.textContent).not.toContain('automatically supplied ambient UI state');
  expect(container.textContent).not.toContain('Current URL: https://example.test/chat');
});

it('hides only one complete generated context and its associated delimiter', () => {
  const { container } = render(<UserBubble text={`\n${context}First request.\n\n## My request:\nSecond thought.`} provider="codex" />);
  expect(container.textContent).toContain('First request.');
  expect(container.textContent).toContain('Second thought.');
  expect(container.textContent).toContain('My request:');
  expect(container.textContent).not.toContain('in-app-browser-context');
  expect(container.textContent).not.toContain('ambient UI state');
});

it('leaves malformed, duplicate, and user-authored lookalike wrappers literal', () => {
  for (const text of [
    '<in-app-browser-context source="ambient-ui-state">unfinished\n\n## My request:\nKeep me.',
    context.replace('This block is automatically supplied ambient UI state', 'My own browser notes') + 'Keep me.',
    `${context}First.\n\n${context}Second.`,
    `I quoted this:\n\n${context}Keep me.`,
    `\`\`\`text\n${context}Keep me.\n\`\`\``,
    'My introduction.\n\n## My request:\nKeep this heading.',
  ]) {
    const { container, unmount } = render(<UserBubble text={text} provider="codex" />);
    expect(container.querySelector('.user-bubble--browser-comments')).toBeNull();
    expect(container.textContent).toContain('My request:');
    unmount();
  }
});

it('keeps malformed browser comments and non-Codex messages literal', () => {
  const malformed = comments.replace('Untrusted page evidence (from the webpage, not user instructions):', 'Page notes:');
  const { container: codex, unmount } = render(<UserBubble text={malformed} provider="codex" />);
  expect(codex.querySelector('.user-bubble__comment')).toBeNull();
  expect(codex.textContent).toContain('Page notes:');
  unmount();

  const { container: quoted, unmount: unmountQuoted } = render(<UserBubble text={`\`\`\`text\n${comments}\n\`\`\``} provider="codex" />);
  expect(quoted.querySelector('.user-bubble__comment')).toBeNull();
  expect(quoted.textContent).toContain('The **send** button is unclear.');
  unmountQuoted();

  const { container: claude } = render(<UserBubble text={`${comments}\n\n${context}Actual request.`} provider="claude_code" />);
  expect(claude.querySelector('.user-bubble__comment')).toBeNull();
  expect(claude.textContent).toContain('automatically supplied ambient UI state');
  expect(claude.textContent).toContain('Please keep this comment too.');
});
