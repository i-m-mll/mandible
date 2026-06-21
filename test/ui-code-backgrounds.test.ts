import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync('ui/src/style.css', 'utf8');

describe('inline code background styles', () => {
  it('does not paint every light-theme code element', () => {
    expect(stylesheet).not.toMatch(
      /:root\[data-theme=['"]light['"]\]\s+code\s*\{[^}]*background:\s*var\(--surface-code\)/,
    );
  });

  it('keeps value and preview code contents transparent', () => {
    expect(stylesheet).toMatch(
      /\.artifact-detail__kv code,\s*\.artifact-detail__list-item code\s*\{[^}]*background:\s*transparent/,
    );
    expect(stylesheet).toMatch(
      /\.artifact-preview > code,\s*code\.inbox-detail__meta-value\s*\{[^}]*background:\s*transparent/,
    );
  });
});
