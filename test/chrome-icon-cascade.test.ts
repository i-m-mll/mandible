import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const interactiveStylesheet = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/timeline.css',
  'ui/src/styles/contextual-action.css',
  'ui/src/styles/sidebar-search-filter.css',
  'ui/src/styles/sidebar-item-row.css',
  'ui/src/styles/sidebar-group-node.css',
  'ui/src/styles/work.css',
  'ui/src/styles/settings.css',
  'ui/src/styles/chat-history.css',
  'ui/src/styles/console.css',
  'ui/src/styles/ledger.css',
  'ui/src/views/spaces/SpacesSidebar.css',
  'ui/src/views/spaces/SpaceCanvas.css',
  'ui/src/views/spaces/SpaceItemPicker.css',
].map((file) => readFileSync(file, 'utf8')).join('\n')
  .replaceAll(':focus-visible', '.test-focus-visible')
  .replaceAll(':focus-within', '.test-focus-within')
  .replaceAll(':hover', '.test-hover');

function renderFixture(markup: string, theme: 'dark' | 'light' = 'dark'): HTMLElement {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = markup;
  return document.body.firstElementChild as HTMLElement;
}

function color(selector: string): string {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).toBeTruthy();
  return getComputedStyle(element!).color;
}

function property(selector: string, name: string): string {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).toBeTruthy();
  return getComputedStyle(element!).getPropertyValue(name).trim();
}

beforeEach(() => {
  const style = document.createElement('style');
  style.dataset.testChromeIconStyles = '';
  style.textContent = interactiveStylesheet;
  document.head.append(style);
});

afterEach(() => {
  document.head.querySelector('[data-test-chrome-icon-styles]')?.remove();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe('shared chrome icon cascade', () => {
  it.each([
    ['dark', '#8A8A8A', '#DFDFDF'],
    ['light', '#868788', '#1A1C1F'],
  ] as const)('lets direct interaction beat owner reveal in the %s theme', (theme, indirect, direct) => {
    const owner = renderFixture(`
      <div class="contextual-action-owner test-hover">
        <span class="contextual-action-group">
          <button class="contextual-action">More</button>
        </span>
      </div>
    `, theme);
    const action = owner.querySelector('.contextual-action')!;

    expect(property(':root', '--chrome-icon-hover-indirect')).toBe(indirect);
    expect(property(':root', '--chrome-icon-hover-direct')).toBe(direct);
    expect(color('.contextual-action')).toBe('var(--chrome-icon-hover-indirect)');
    action.classList.add('test-hover');
    expect(color('.contextual-action')).toBe('var(--chrome-icon-hover-direct)');
    action.classList.remove('test-hover');
    action.classList.add('test-focus-visible');
    expect(color('.contextual-action')).toBe('var(--chrome-icon-hover-direct)');
  });

  it('applies the same cascade to representative shared row and group actions', () => {
    renderFixture(`
      <div>
        <div class="sidebar-item-row contextual-action-owner test-hover">
          <span class="sidebar-item-row__trailing contextual-action-scope">
            <span class="sidebar-item-row__actions contextual-action-group test-focus-within">
              <button class="sidebar-item-row__action contextual-action">Pin</button>
            </span>
          </span>
        </div>
        <div class="sidebar-group-node__header contextual-action-owner test-hover">
          <span class="sidebar-group-node__action-slot contextual-action-group">
            <button class="sidebar-group-node__action contextual-action test-hover">Add</button>
          </span>
        </div>
      </div>
    `);

    expect(color('.sidebar-item-row__action')).toBe('var(--chrome-icon-hover-indirect)');
    expect(color('.sidebar-group-node__action')).toBe('var(--chrome-icon-hover-direct)');
  });

  it('converges direct rail, filter, toolbar, header, and overflow controls without erasing active state', () => {
    renderFixture(`
      <div>
        <button class="app-rail__item test-focus-visible"><span class="app-rail__icon">R</span></button>
        <button class="sidebar-search-filter__clear test-hover">C</button>
        <button class="sidebar-search-filter__trigger sidebar-search-filter__trigger--active test-hover">F</button>
        <div class="timeline-corner-toolbar"><button class="timeline-icon-button test-hover">T</button></div>
        <button class="ledger-copy-ref-button test-focus-visible">H</button>
        <button class="ledger-issue-actions-menu__trigger ledger-issue-actions-menu__trigger--active test-hover">L</button>
        <button class="tab-overflow__btn tab-overflow__btn--active test-focus-visible">O</button>
        <button class="daemon-toast__dismiss test-hover">D</button>
        <button class="terminal-pane__sidebar-toggle test-hover">P</button>
        <button class="terminal-pane__sidebar-close test-focus-visible">X</button>
        <button class="usage-modal__close test-hover">U</button>
        <button class="repo-card__gear repo-card__gear--active test-hover">G</button>
        <button class="work-settings-modal__close test-focus-visible">W</button>
        <button class="space-canvas__icon-btn test-focus-visible">V</button>
        <button class="space-item-picker__close test-hover">I</button>
      </div>
    `, 'light');

    for (const selector of [
      '.app-rail__icon',
      '.sidebar-search-filter__clear',
      '.sidebar-search-filter__trigger',
      '.timeline-icon-button',
      '.ledger-copy-ref-button',
      '.ledger-issue-actions-menu__trigger',
      '.tab-overflow__btn',
      '.daemon-toast__dismiss',
      '.terminal-pane__sidebar-toggle',
      '.terminal-pane__sidebar-close',
      '.usage-modal__close',
      '.repo-card__gear',
      '.work-settings-modal__close',
      '.space-canvas__icon-btn',
      '.space-item-picker__close',
    ]) {
      expect(color(selector), selector).toBe('var(--chrome-icon-hover-direct)');
    }

    expect(document.querySelector('.sidebar-search-filter__trigger')?.classList)
      .toContain('sidebar-search-filter__trigger--active');
    expect(document.querySelector('.ledger-issue-actions-menu__trigger')?.classList)
      .toContain('ledger-issue-actions-menu__trigger--active');
  });
});
