import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const tokensStylesheet = readFileSync('ui/src/styles/tokens.css', 'utf8');
const sidebarGroupStylesheet = readFileSync('ui/src/styles/sidebar-group-node.css', 'utf8');
const resolvedStylesheet = readResolvedStylesheet();

const sidebarConsumers = [
  ['Chat', 'ui/src/views/conversations.tsx'],
  ['Briefing', 'ui/src/views/feedback/CollectionsSidebar.tsx'],
  ['Spaces', 'ui/src/views/spaces/SpacesSidebar.tsx'],
  ['Projects', 'ui/src/views/work.tsx'],
  ['Tasks', 'ui/src/views/tasks.tsx'],
] as const;

function ruleEntries(css: string): Array<{ selectors: string[]; body: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(',').map((selector) => selector.trim()),
    body: match[2]!,
  }));
}

function ruleBody(css: string, selector: string): string {
  return ruleEntries(css).find((entry) => entry.selectors.includes(selector))?.body ?? '';
}

function tokenBlock(selector: ':root' | "[data-theme='light']"): string {
  return tokensStylesheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

function declaredToken(block: string, token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`(?:^|\\n)\\s*${escapedToken}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? '';
}

function tokenValue(theme: 'dark' | 'light', token = '--text-chrome-muted', seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`Circular token reference: ${token}`);
  const nextSeen = new Set(seen).add(token);
  const value = theme === 'light'
    ? declaredToken(tokenBlock("[data-theme='light']"), token) || declaredToken(tokenBlock(':root'), token)
    : declaredToken(tokenBlock(':root'), token);
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return reference ? tokenValue(theme, reference, nextSeen) : value;
}

function expectedRgb(hex: string): string {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new Error(`Expected a six-digit solid color, received ${hex}`);
  return `rgb(${Number.parseInt(match[1]!, 16)}, ${Number.parseInt(match[2]!, 16)}, ${Number.parseInt(match[3]!, 16)})`;
}

function renderedConsumerFixture(theme: 'dark' | 'light'): Document {
  const color = tokenValue(theme);
  const primaryColor = tokenValue(theme, '--text-primary');
  const cascade = ruleEntries(resolvedStylesheet)
    .filter(({ selectors }) => selectors.some((selector) => (
      selector.includes('.sidebar-group-node__heading')
      || selector.includes('.sidebar-group-node__show-more')
    )))
    .map(({ selectors, body }) => `${selectors.join(', ')} {${body}}`)
    .join('\n')
    .replaceAll('var(--text-chrome-muted)', color)
    .replaceAll('var(--text-primary)', primaryColor);
  const dom = new JSDOM(`<!doctype html>
    <html data-theme="${theme}">
      <head></head>
      <body>
        <aside class="chat-history-list" data-consumer="Chat">
          <section class="sidebar-group-node sidebar-group-node--category sidebar-group-node--without-count">
            <div class="sidebar-group-node__header">
              <button class="sidebar-group-node__heading"><strong>Chats</strong></button>
            </div>
            <div class="sidebar-disclosure-region">
              <button class="sidebar-group-node__show-more">Show more</button>
            </div>
          </section>
        </aside>
        <aside class="spaces-tree" data-consumer="Spaces">
          <section class="sidebar-group-node sidebar-group-node--folder sidebar-group-node--with-icon">
            <div class="sidebar-group-node__header">
              <button class="sidebar-group-node__heading"><strong>Mandible</strong></button>
            </div>
          </section>
        </aside>
      </body>
    </html>`, { pretendToBeVisual: true });
  const style = dom.window.document.createElement('style');
  style.textContent = cascade;
  dom.window.document.head.append(style);
  return dom.window.document;
}

describe('shared sidebar muted text contract', () => {
  it.each([
    ['dark', '#747474'],
    ['light', '#A8A9A9'],
  ] as const)('resolves shared Chat category and continuation rest text in %s', (theme, expected) => {
    expect(tokenValue(theme)).toBe(expected);
    const document = renderedConsumerFixture(theme);
    const category = document.querySelector('[data-consumer="Chat"] .sidebar-group-node__heading');
    const continuation = document.querySelector('[data-consumer="Chat"] .sidebar-group-node__show-more');
    const spacesFolder = document.querySelector('[data-consumer="Spaces"] .sidebar-group-node__heading');

    expect(document.defaultView!.getComputedStyle(category!).color).toBe(expectedRgb(expected));
    expect(document.defaultView!.getComputedStyle(continuation!).color).toBe(expectedRgb(expected));
    expect(document.defaultView!.getComputedStyle(spacesFolder!).color)
      .toBe(expectedRgb(tokenValue(theme, '--text-primary')));
  });

  it('keeps folder headings primary and interaction states authoritative', () => {
    expect(ruleBody(
      sidebarGroupStylesheet,
      '.sidebar-group-node--folder > .sidebar-group-node__header > .sidebar-group-node__heading',
    )).toContain('color: var(--text-primary)');
    expect(ruleBody(sidebarGroupStylesheet, '.sidebar-group-node__show-more:hover'))
      .toContain('color: var(--text-primary)');
    expect(ruleBody(sidebarGroupStylesheet, '.sidebar-group-node__show-more:focus-visible'))
      .toContain('outline: 2px solid var(--accent-blue)');
    expect(ruleBody(sidebarGroupStylesheet, '.sidebar-group-node__show-more:disabled'))
      .toContain('opacity: 0.65');
  });

  it('keeps consumer styles free of category and continuation rest-color copies', () => {
    const sharedColorSelectors = ruleEntries(resolvedStylesheet).flatMap(({ selectors, body }) => (
      /(?:^|;)\s*color\s*:/.test(body)
        ? selectors.filter((selector) => (
          /\.sidebar-group-node__heading(?::[\w()-]+)*$/.test(selector)
          || /\.sidebar-group-node__show-more(?::[\w()-]+)*$/.test(selector)
        ))
        : []
    ));
    expect(sharedColorSelectors).toEqual([
      '.sidebar-group-node__heading',
      '.sidebar-group-node--category > .sidebar-group-node__header > .sidebar-group-node__heading',
      '.sidebar-group-node--folder > .sidebar-group-node__header > .sidebar-group-node__heading',
      '.sidebar-group-node__show-more',
      '.sidebar-group-node__show-more:hover',
    ]);

    for (const [name, path] of sidebarConsumers) {
      const source = readFileSync(path, 'utf8');
      expect(source, name).not.toMatch(/sidebar-group-node__(?:heading|show-more)[^'"\n]*color/);
    }

    expect(readFileSync('ui/src/views/conversations.tsx', 'utf8')).toContain('presentation="category"');
    expect(readFileSync('ui/src/views/conversations.tsx', 'utf8')).toContain('canShowMore=');
    expect(readFileSync('ui/src/views/spaces/SpacesSidebar.tsx', 'utf8')).toContain('presentation="folder"');
    for (const path of [
      'ui/src/views/feedback/CollectionsSidebar.tsx',
      'ui/src/views/work.tsx',
      'ui/src/views/tasks.tsx',
    ]) {
      expect(readFileSync(path, 'utf8'), path).toContain('SidebarItemRow');
    }
  });
});
