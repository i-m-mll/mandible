import { cleanup, render } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import { UserBubble } from '../ui/src/components/message-blocks/UserBubble';

afterEach(cleanup);

const envelope = `<send_user_message_question_reply>\n${JSON.stringify([
  { questionItemId: '["request_user_input_async","call_example",0]', question: 'Which option?', answer: 'This one' },
  { questionItemId: 'internal-2', question: 'And then?', answer: 'The **second** answer' },
])}\n</send_user_message_question_reply>`;

it('renders complete Codex question replies in order without internal IDs', () => {
  const { container } = render(<UserBubble text={envelope} provider="codex" />);
  const pairs = container.querySelectorAll('.user-bubble__question-reply');
  expect(pairs).toHaveLength(2);
  expect(pairs[0]?.querySelector('.user-bubble__question')?.textContent?.trim()).toBe('Which option?');
  expect(pairs[0]?.querySelector('.user-bubble__text')?.textContent?.trim()).toBe('This one');
  expect(pairs[1]?.querySelector('.user-bubble__question')?.textContent?.trim()).toBe('And then?');
  expect(pairs[1]?.querySelector('.user-bubble__text strong')?.textContent).toBe('second');
  expect(container.textContent).not.toContain('questionItemId');
  expect(container.textContent).not.toContain('internal-2');
});

it('leaves unrelated, malformed, and non-Codex messages visible as ordinary user text', () => {
  for (const [text, provider] of [
    [envelope, 'claude'],
    ['<send_user_message_question_reply>broken</send_user_message_question_reply>', 'codex'],
    ['A note before ' + envelope, 'codex'],
  ]) {
    const { container, unmount } = render(<UserBubble text={text} provider={provider} />);
    expect(container.querySelector('.user-bubble__question-reply')).toBeNull();
    expect(container.textContent).toContain(provider === 'claude' ? 'questionItemId' : provider === 'codex' && text.includes('broken') ? 'broken' : 'A note before');
    unmount();
  }
});
