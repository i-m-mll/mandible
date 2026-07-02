import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const stylesheet = readResolvedStylesheet();

function cssRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('timeline stylesheet', () => {
  it('keeps diagnostics panel on theme-aware sidebar surfaces', () => {
    const body = cssRuleBody('.timeline-diagnostics-panel');

    expect(body).toContain('background: var(--bg-inset)');
    expect(body).toContain('border-top: 1px solid var(--neutral-alpha-10)');
    expect(body).toContain('color: var(--text-muted)');
    expect(body).not.toMatch(/background:\s*rgba\(\s*12\s*,\s*17\s*,\s*24/);
  });

  it('keeps diagnostics labels readable across themes', () => {
    const body = cssRuleBody('.timeline-diagnostics-panel strong');

    expect(body).toContain('color: var(--text-primary)');
  });
});
