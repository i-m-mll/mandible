import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  artifactLinkBadgeLabel,
  formatAbsoluteTime,
  formatRelativeTime,
  truncate,
} from '../ui/src/lib/format';
import { renderInlineMarkdown, renderMarkdown } from '../ui/src/lib/markdown';

afterEach(() => vi.useRealTimers());

describe('shared UI formatting', () => {
  it('preserves compact, recent, and verbose relative-time styles', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));

    expect(formatRelativeTime('2026-07-16T11:58:00Z')).toBe('2m ago');
    expect(formatRelativeTime('2026-07-15T11:00:00Z')).toBe('yesterday');
    expect(formatRelativeTime('2026-07-16T11:59:57Z', { style: 'recent' })).toBe('just now');
    expect(formatRelativeTime('2026-07-16T10:00:00Z', { style: 'verbose' })).toBe('2 hours ago');
  });

  it('preserves caller-specific empty, invalid, absolute, and truncation output', () => {
    expect(formatRelativeTime(null, { empty: '—' })).toBe('—');
    expect(formatRelativeTime('', { empty: '—' })).toBe('—');
    expect(formatRelativeTime('not-a-date', { invalid: '—' })).toBe('—');
    expect(formatAbsoluteTime('not-a-date', { invalid: '' })).toBe('');
    expect(truncate('abcdef', 4)).toBe('abcd…');
    expect(truncate('abcd', 4)).toBe('abcd');
  });

  it('formats living and pinned artifact link badges', () => {
    expect(artifactLinkBadgeLabel({ link_kind: 'living', resolved_version_no: 3 }))
      .toBe('latest → v3');
    expect(artifactLinkBadgeLabel({ link_kind: 'pinned', resolved_version_no: 2 }))
      .toBe('v2 pinned');
  });
});

describe('shared UI Markdown rendering', () => {
  it('renders block and inline Markdown', () => {
    expect(renderMarkdown('**strong**')).toContain('<strong>strong</strong>');
    expect(renderInlineMarkdown('**strong**')).toBe('<strong>strong</strong>');
  });

  it('uses DOMPurify for dangerous tags, attributes, and URL schemes', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(1)</script>[x](javascript:alert(1))');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});
