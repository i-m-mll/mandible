import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const stylesheet = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/conversations.css',
].map((file) => readFileSync(file, 'utf8')).join('\n')
  .replaceAll('::placeholder', '.test-placeholder');

function renderComposer(theme: 'dark' | 'light'): HTMLTextAreaElement {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = '<textarea class="conv-compose__input test-placeholder" placeholder="Message..."></textarea>';
  return document.querySelector('.conv-compose__input')!;
}

function hexChannel(value: string): number {
  expect(value).toMatch(/^#[0-9A-F]{6}$/);
  return Number.parseInt(value.slice(1, 3), 16);
}

beforeEach(() => {
  const style = document.createElement('style');
  style.dataset.testComposerPlaceholderStyles = '';
  style.textContent = stylesheet;
  document.head.append(style);
});

afterEach(() => {
  document.head.querySelector('[data-test-composer-placeholder-styles]')?.remove();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe('Chat composer placeholder hierarchy', () => {
  it.each([
    ['dark', '#747474', '#626262', 'darker'],
    ['light', '#A8A9A9', '#BABBBB', 'lighter'],
  ] as const)('uses the theme-owned extra-faint neutral in the %s theme', (theme, muted, faint, direction) => {
    const composer = renderComposer(theme);
    const rootStyle = getComputedStyle(document.documentElement);

    expect(rootStyle.getPropertyValue('--text-chrome-muted').trim()).toBe(muted);
    expect(rootStyle.getPropertyValue('--text-chrome-faint').trim()).toBe(faint);
    expect(getComputedStyle(composer).color).toBe('var(--text-chrome-faint)');
    expect(getComputedStyle(composer).opacity).toBe('1');

    const mutedChannel = hexChannel(muted);
    const faintChannel = hexChannel(faint);
    expect(direction === 'darker' ? faintChannel < mutedChannel : faintChannel > mutedChannel).toBe(true);
  });

  it('leaves the existing disabled treatment and composer geometry intact', () => {
    const composer = renderComposer('dark');
    composer.disabled = true;

    expect(getComputedStyle(composer).opacity).toBe('0.55');
    expect(getComputedStyle(composer).minHeight).toBe('58px');
    expect(getComputedStyle(composer).padding).toBe('4px 2px');
  });
});
