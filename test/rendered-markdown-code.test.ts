import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const stylesheet = readResolvedStylesheet();
const rules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()),
  body: match[2],
}));

function installMatchingCascade(document: Document): void {
  const elements = [document.documentElement, ...Array.from(document.querySelectorAll('*'))];
  const matchingRules = rules.flatMap((rule) => {
    const selectors = rule.selectors.filter((selector) => {
      try {
        return elements.some((element) => element.matches(selector));
      } catch {
        return false;
      }
    });
    return selectors.length > 0 ? [`${selectors.join(', ')} {${rule.body}}`] : [];
  });
  const style = document.createElement('style');
  style.textContent = matchingRules.join('\n');
  document.head.append(style);
}

describe('shared rendered Markdown code styles', () => {
  it('applies the final fenced-code cascade to Briefing prose and keeps inline code transparent', () => {
    const dom = new JSDOM(`<!doctype html><html data-theme="light"><head></head><body>
      <div class="briefing-document__prose rendered-markdown">
        <pre><code>const answer = 42;</code></pre>
        <p>Inline <code id="inline-code">answer</code></p>
      </div>
    </body></html>`, { pretendToBeVisual: true });
    installMatchingCascade(dom.window.document);

    const pre = dom.window.document.querySelector('pre') as HTMLElement;
    const inlineCode = dom.window.document.querySelector('#inline-code') as HTMLElement;
    const preStyle = dom.window.getComputedStyle(pre);
    const inlineStyle = dom.window.getComputedStyle(inlineCode);
    const sharedPreRule = rules.find((rule) => rule.selectors.includes('.rendered-markdown pre'));

    expect(preStyle.boxSizing).toBe('border-box');
    expect(preStyle.overflowX).toBe('auto');
    expect(sharedPreRule?.body).toMatch(/inline-size:\s*fit-content/);
    expect(sharedPreRule?.body).toMatch(/max-inline-size:\s*100%/);
    expect(sharedPreRule?.body).toMatch(/padding:\s*var\(--space-3\) var\(--space-4\)/);
    expect(sharedPreRule?.body).toMatch(/border:\s*1px solid var\(--border-muted\)/);
    expect(sharedPreRule?.body).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(sharedPreRule?.body).toMatch(/background:\s*var\(--surface-code\)/);
    expect(inlineStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(inlineStyle.padding).toBe('');
  });

  it('loads the shared contract after specialized Markdown styles', () => {
    expect(stylesheet.lastIndexOf('.rendered-markdown pre {')).toBeGreaterThan(
      stylesheet.lastIndexOf('.spec-panel pre {'),
    );
    expect(stylesheet.lastIndexOf('.rendered-markdown pre {')).toBeGreaterThan(
      stylesheet.lastIndexOf('.msg-text-block pre {'),
    );
    expect(stylesheet.lastIndexOf('.rendered-markdown pre {')).toBeGreaterThan(
      stylesheet.lastIndexOf('.timeline-event-body pre {'),
    );
  });

  it.each([
    ['Briefing', 'ui/src/views/feedback/BriefingDocumentPanel.tsx'],
    ['Issue and Timeline', 'ui/src/components/ledger/LedgerRenderedBody.tsx'],
    ['Artifact', 'ui/src/views/artifacts.tsx'],
    ['Chat text', 'ui/src/components/message-blocks/TextBlock.tsx'],
    ['Chat user text', 'ui/src/components/message-blocks/UserBubble.tsx'],
    ['Auth', 'ui/src/views/auth.tsx'],
    ['Spaces', 'ui/src/views/spaces/DocumentRenderer.tsx'],
  ])('%s rendered Markdown opts into the shared contract', (_surface, path) => {
    expect(readFileSync(path, 'utf8')).toContain('rendered-markdown');
  });
});
