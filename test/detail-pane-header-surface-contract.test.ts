import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

type DirectDetailConsumer = {
  name: string;
  path: string;
  variant: 'standard' | 'compact' | 'versioned';
  headerClasses: string[];
  primaryClasses: string[];
  ancestorClass?: string;
};

const DIRECT_DETAIL_CONSUMERS: DirectDetailConsumer[] = [
  {
    name: 'Artifact',
    path: 'ui/src/views/artifacts.tsx',
    variant: 'versioned',
    headerClasses: ['artifact-detail__header'],
    primaryClasses: [],
  },
  {
    name: 'Auth',
    path: 'ui/src/views/auth.tsx',
    variant: 'standard',
    headerClasses: ['auth-detail__header'],
    primaryClasses: ['auth-detail__header-primary'],
  },
  {
    name: 'Briefing',
    path: 'ui/src/views/feedback/BriefingDocumentRenderer.tsx',
    variant: 'versioned',
    headerClasses: ['briefing-detail__header'],
    primaryClasses: [],
  },
  {
    name: 'Chat',
    path: 'ui/src/views/conversations.tsx',
    variant: 'compact',
    headerClasses: ['conv-detail__shell-header'],
    primaryClasses: [],
  },
  {
    name: 'Graph',
    path: 'ui/src/views/graph.tsx',
    variant: 'standard',
    headerClasses: [],
    primaryClasses: [],
  },
  {
    name: 'Issue',
    path: 'ui/src/components/ledger/IssueDetail.tsx',
    variant: 'standard',
    headerClasses: ['ledger-issue-detail__header'],
    primaryClasses: ['ledger-issue-detail__header-primary'],
    ancestorClass: 'issues-detail',
  },
  {
    name: 'Projects',
    path: 'ui/src/views/work.tsx',
    variant: 'compact',
    headerClasses: [],
    primaryClasses: [],
  },
  {
    name: 'Tasks',
    path: 'ui/src/views/tasks.tsx',
    variant: 'standard',
    headerClasses: [],
    primaryClasses: [],
  },
];

const INHERITED_DETAIL_CONSUMERS = [
  {
    name: 'Spaces',
    path: 'ui/src/views/spaces/SpaceReferenceDetailPanel.tsx',
    inheritedPaths: [
      'ui/src/components/ledger/IssueDetail.tsx',
      'ui/src/views/artifacts.tsx',
    ],
  },
] as const;

const canonicalSurfaceClasses = [
  'detail-pane-shell',
  'detail-pane-shell__header',
  'detail-pane-shell__header-primary',
  'detail-pane-shell__subheader',
  'detail-pane-shell__body',
  'detail-pane-shell__footer',
  'detail-pane-header',
];

const auditedSurfaceClasses = [
  ...canonicalSurfaceClasses,
  ...DIRECT_DETAIL_CONSUMERS.flatMap(({ headerClasses, primaryClasses }) => [
    ...headerClasses,
    ...primaryClasses,
  ]),
];

const stylesheet = readResolvedStylesheet();
const tokensStylesheet = readFileSync('ui/src/styles/tokens.css', 'utf8');

function cssRuleEntries(css: string): Array<{ selector: string; body: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const entries: Array<{ selector: string; body: string }> = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1]!.split(',')) {
      entries.push({ selector: selector.trim(), body: match[2]! });
    }
  }
  return entries;
}

function finalTargetCompound(selector: string): string {
  let start = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (bracketDepth > 0) continue;
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (parenthesisDepth === 0 && (/\s/.test(character) || character === '>' || character === '+' || character === '~')) {
      start = index + 1;
    }
  }

  return selector.slice(start).trim();
}

function withoutAttributeSelectors(compound: string): string {
  let bracketDepth = 0;
  return Array.from(compound, (character) => {
    if (character === '[') {
      bracketDepth += 1;
      return ' ';
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      return ' ';
    }
    return bracketDepth > 0 ? ' ' : character;
  }).join('');
}

function selectorTargetsClass(selector: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${escaped}(?![A-Za-z0-9_-])`).test(
    withoutAttributeSelectors(finalTargetCompound(selector)),
  );
}

function surfaceDeclarationsFor(css: string): Array<{ selector: string; body: string }> {
  return cssRuleEntries(css).filter(({ selector, body }) => (
    auditedSurfaceClasses.some((className) => selectorTargetsClass(selector, className))
    && /(?:^|;)\s*(?:background(?:-color)?|opacity)\s*:/m.test(body)
  ));
}

function expectOnlyCanonicalSurfaceDeclarations(css: string): void {
  expect(surfaceDeclarationsFor(css)).toEqual(canonicalSurfaceClasses.map((className) => ({
    selector: `.${className}`,
    body: expect.stringMatching(/background:\s*inherit;/),
  })));
}

function tokenBlock(theme: 'dark' | 'light'): string {
  const selector = theme === 'dark' ? ':root' : "[data-theme='light']";
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tokensStylesheet.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

function tokenValue(block: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? '';
}

function resolvedSurfaceMain(theme: 'dark' | 'light'): string {
  const block = tokenBlock(theme);
  return tokenValue(block, '--surface-main');
}

function expectedRgb(hex: string): string {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new Error(`Expected a six-digit solid color, received ${hex}`);
  return `rgb(${Number.parseInt(match[1]!, 16)}, ${Number.parseInt(match[2]!, 16)}, ${Number.parseInt(match[3]!, 16)})`;
}

function renderConsumerFixtures(theme: 'dark' | 'light'): Document {
  const surface = resolvedSurfaceMain(theme);
  const surfaceCascade = surfaceDeclarationsFor(stylesheet)
    .map(({ selector, body }) => `${selector} {${body}}`)
    .join('\n');
  const fixtures = DIRECT_DETAIL_CONSUMERS.map((consumer) => `
    <div class="${consumer.ancestorClass ?? ''}" data-app-surface="main">
      <article class="detail-pane-shell" data-app-surface="main" data-consumer="${consumer.name}">
        <header class="detail-pane-shell__header ${consumer.headerClasses.join(' ')}">
          <div class="detail-pane-shell__header-primary ${consumer.primaryClasses.join(' ')}">
            <div class="detail-pane-header detail-pane-header--${consumer.variant}"></div>
          </div>
        </header>
        <div class="detail-pane-shell__body"></div>
        <footer class="detail-pane-shell__footer"></footer>
      </article>
    </div>
  `).join('');
  const dom = new JSDOM(`<!doctype html><html data-theme="${theme}"><head></head><body>${fixtures}</body></html>`, {
    pretendToBeVisual: true,
  });
  const style = dom.window.document.createElement('style');
  // jsdom does not resolve inherited backgrounds into computed colors, so
  // materialize the browser cascade after separately asserting `inherit`.
  style.textContent = `[data-app-surface='main'] { background: ${surface}; }\n${surfaceCascade.replaceAll('background: inherit', `background: ${surface}`)}`;
  dom.window.document.head.append(style);
  return dom.window.document;
}

describe('canonical detail header surface contract', () => {
  it('keeps the eligible direct-consumer audit explicit and canonical', () => {
    const uiRoot = resolve('ui/src');
    const discoveredConsumers = readdirSync(uiRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => readFileSync(path, 'utf8').includes('<DetailPaneShell'))
      .map((path) => path.replace(`${process.cwd()}/`, ''))
      .sort();
    expect(discoveredConsumers).toEqual(DIRECT_DETAIL_CONSUMERS.map(({ path }) => path).sort());

    for (const consumer of DIRECT_DETAIL_CONSUMERS) {
      const source = readFileSync(consumer.path, 'utf8');
      expect(source, consumer.name).toContain('<DetailPaneShell');
      expect(source, consumer.name).toContain('<DetailPaneHeader');
      expect(source, consumer.name).toContain(`variant="${consumer.variant}"`);
      for (const className of [...consumer.headerClasses, ...consumer.primaryClasses]) {
        expect(source, `${consumer.name}:${className}`).toContain(`"${className}"`);
      }
    }

    for (const consumer of INHERITED_DETAIL_CONSUMERS) {
      const source = readFileSync(consumer.path, 'utf8');
      expect(source, consumer.name).not.toContain('DetailPaneHeader');
      for (const inheritedPath of consumer.inheritedPaths) {
        const componentName = inheritedPath.endsWith('IssueDetail.tsx') ? 'LedgerIssueDetail' : 'ArtifactDetail';
        expect(source, `${consumer.name}:${componentName}`).toContain(`<${componentName}`);
      }
    }
  });

  it('rejects compound-class overrides without treating descendant controls as the header target', () => {
    const compoundOverride = `
      .issues-detail .ledger-issue-detail__header.is-loading {
        background: transparent;
      }
    `;
    const descendantControl = `
      .ledger-issue-detail__header .nested-control {
        background: transparent;
      }
    `;

    expect(surfaceDeclarationsFor(compoundOverride)).toEqual([{
      selector: '.issues-detail .ledger-issue-detail__header.is-loading',
      body: expect.stringMatching(/background:\s*transparent;/),
    }]);
    expect(() => expectOnlyCanonicalSurfaceDeclarations(`${stylesheet}\n${compoundOverride}`)).toThrow();
    expect(() => expectOnlyCanonicalSurfaceDeclarations(`${stylesheet}\n${descendantControl}`)).not.toThrow();
  });

  it('forbids consumer background, transparency, or opacity overrides on the shared seam', () => {
    expectOnlyCanonicalSurfaceDeclarations(stylesheet);
  });

  it.each(['dark', 'light'] as const)(
    'resolves Artifact, Issue/Auth, Chat, Briefing, and inherited Spaces headers to the solid app surface in %s',
    (theme) => {
      const surface = resolvedSurfaceMain(theme);
      expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
      const document = renderConsumerFixtures(theme);
      const expected = expectedRgb(surface);

      for (const consumer of DIRECT_DETAIL_CONSUMERS) {
        const shell = document.querySelector(`[data-consumer="${consumer.name}"]`);
        expect(shell, consumer.name).toBeTruthy();
        for (const selector of [
          '.detail-pane-shell__header',
          '.detail-pane-shell__header-primary',
          `.detail-pane-header--${consumer.variant}`,
          '.detail-pane-shell__body',
          '.detail-pane-shell__footer',
        ]) {
          const element = shell!.querySelector(selector);
          expect(element, `${consumer.name}:${selector}`).toBeTruthy();
          expect(document.defaultView!.getComputedStyle(element!).backgroundColor).toBe(expected);
        }
      }

      // Spaces renders the same audited Issue and Artifact components rather than a bespoke seam.
      expect(INHERITED_DETAIL_CONSUMERS[0].inheritedPaths).toEqual([
        'ui/src/components/ledger/IssueDetail.tsx',
        'ui/src/views/artifacts.tsx',
      ]);
    },
  );
});
