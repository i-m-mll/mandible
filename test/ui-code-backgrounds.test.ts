import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync('ui/src/style.css', 'utf8');
const rules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()),
  body: match[2],
}));

const grayBackgroundPattern =
  /background(?:-color)?:\s*(?:var\(--surface-code\)|var\(--neutral-alpha|rgba\((?:0\s*,\s*0\s*,\s*0|15\s*,\s*23\s*,\s*42))/;

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

  it('does not paint light-theme artifact previews with a gray code surface', () => {
    const lightArtifactPreviewGrayRules = rules.filter(
      (rule) =>
        rule.selectors.some(
          (selector) =>
            selector.includes(":root[data-theme='light']") &&
            selector.includes('.artifact-preview'),
        ) && grayBackgroundPattern.test(rule.body),
    );

    expect(lightArtifactPreviewGrayRules).toEqual([]);
    expect(stylesheet).toMatch(
      /:root\[data-theme='light'\]\s+\.artifact-preview\s*\{[^}]*background:\s*var\(--bg-card\)/,
    );
  });
});
